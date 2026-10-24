(function (root) {
  'use strict';
  function create({ classroom, onClose, onPractice, store = root.BishunAssessmentStore.create() }) {
    const A = root.BishunAssessment, F = root.BishunFreehand, C = root.BishunContent;
    const node = (tag, text = '', className = '') => { const el = document.createElement(tag); el.textContent = text; if (className) el.className = className; return el; };
    const panel = node('section', '', 'assessment-panel'); panel.id = 'assessment-view'; panel.hidden = true;
    panel.setAttribute('aria-label', '自由書寫測驗'); document.body.append(panel);
    let record = null, official = null, member = null, scope = '', page = 'list', busy = false, error = '', pending = Promise.resolve(), checkpointing = 0, segmentStart = null, pad = null, stopReplay = null, stopReview = null, expiryTimer = null, generation = 0, visible = false;
    const siblings = [...document.body.children].filter(el => el !== panel && el.tagName !== 'SCRIPT');
    function conceal(value) { for (const el of siblings) { el.inert = value; if (value) el.setAttribute('aria-hidden', 'true'); else el.removeAttribute('aria-hidden'); } }
    function status(text) { const el = panel.querySelector('[data-status]'); if (el) el.textContent = text; }
    function checkExpiry() { if (record && record.expiresAt <= Date.now()) throw new Error('測驗已到期，請老師開新一班。'); }
    function armExpiry() {
      clearTimeout(expiryTimer); const ownGeneration = generation;
      expiryTimer = setTimeout(async () => {
        if (ownGeneration !== generation) return;
        dispose(); record = null; official = null; shell('測驗已到期'); panel.append(message('請老師開新一班。')); footer(close);
        try { await store.purge(); } catch { status('原稿已停止顯示。裝置未能清理，恢復儲存後會再試。'); }
      }, Math.max(0, record.expiresAt - Date.now()));
    }
    async function persist(value = record) { checkExpiry(); if (value) await store.put(value); error = ''; }
    function clock(resume) {
      if (segmentStart !== null && record?.run.phase === 'writing') record = { ...record, run: { ...record.run, elapsedMs: Math.min(A.limits.duration, record.run.elapsedMs + Math.max(0, Math.round(performance.now() - segmentStart))) } };
      segmentStart = resume && page === 'writing' && !document.hidden && record?.run.answers[record.run.cursor]?.status === 'draft' ? performance.now() : null;
    }
    function queueCheckpoint() {
      const snapshot = record; checkpointing++;
      pending = pending.catch(() => {}).then(() => persist(snapshot)).catch(problem => { error = problem.message || '原稿未能保存，請保持頁面開啟再試。'; status(error); }).finally(() => { checkpointing--; });
    }
    function dispose() { pad?.dispose(); pad = null; stopReplay?.(); stopReplay = null; stopReview?.(); stopReview = null; }
    async function action(fn) {
      if (busy) return;
      clock(false); busy = true; pad?.flush(); pad?.lock(true);
      try { await pending; if (record) await persist(); await fn(); }
      catch (problem) { error = problem.message || '未能保存原稿，請保持頁面開啟再試。'; status(error); }
      finally { busy = false; pad?.lock(false); clock(true); }
    }
    function button(text, fn, kind = 'secondary') { const el = node('button', text, 'button ' + kind); el.addEventListener('click', () => action(fn)); return el; }
    function message(text) { const el = node('p', text, 'assessment-status'); el.setAttribute('role', 'status'); el.setAttribute('data-status', ''); return el; }
    function shell(title) {
      dispose(); panel.replaceChildren();
      const heading = node('header', '', 'assessment-heading'); heading.append(node('h1', title));
      panel.append(heading); return panel;
    }
    function footer(fn, label = '← 返回') { const el = node('footer', '', 'assessment-footer'); el.append(button(label, fn)); panel.append(el); }
    function isChallenge() { return record?.kind === 'challenge'; }
    function titleFor(position, index) { return record.run.assignment.mode === 'listen' || isChallenge() ? '第 ' + (index + 1) + ' 題 · 詞語第 ' + (position.index + 1) + ' 字' : position.word + ' · 第 ' + (position.index + 1) + ' 字「' + position.character + '」'; }
    function speak(position, context = false) {
      const synth = root.speechSynthesis, voice = synth?.getVoices().find(item => /yue|zh[-_]HK/i.test(item.lang));
      if (!synth || !voice) { status('裝置未提供粵語聲音，請老師讀出題目。'); return; }
      const text = (context ? C.cue(position.word)[0] : position.word + '。' + C.cue(position.word)[0]) + '寫第 ' + (position.index + 1) + ' 個字。';
      synth.cancel(); const utterance = new SpeechSynthesisUtterance(text); utterance.voice = voice; utterance.lang = voice.lang; utterance.rate = 0.85;
      utterance.onerror = () => status('聲音未能播放，請老師讀出題目。'); synth.speak(utterance);
    }
    async function close() { visible = false; generation++; clearTimeout(expiryTimer); dispose(); root.speechSynthesis?.cancel(); panel.hidden = true; conceal(false); record = null; official = null; member = null; onClose(); }
    function drawList() {
      page = 'list'; shell(isChallenge() ? '情境小挑戰' : '測驗');
      const list = node('div', '', 'assessment-choices');
      A.positions(record.run.assignment).forEach((position, index) => {
        const answer = record.run.answers[index], label = answer.status === 'draft' ? '未提交' : answer.status === 'skipped' ? '已跳過' : '已提交';
        list.append(button(titleFor(position, index) + ' · ' + label, async () => {
          const next = { ...record, run: A.transition(record.run, { type: 'SELECT', index }) }; await persist(next); record = next; drawWriting();
        }));
      });
      panel.append(list, message(error));
      if (record.run.answers.every(answer => answer.status !== 'draft')) panel.append(button(isChallenge() ? '完成作品卡' : '交整份測驗', seal, 'primary large'));
      footer(isChallenge() ? async () => { record = official; drawSummary(); } : close, isChallenge() ? '← 返回原卷' : '← 返回課程');
    }
    function drawWriting() {
      page = 'writing'; const index = record.run.cursor, position = A.positions(record.run.assignment)[index], answer = record.run.answers[index];
      shell(titleFor(position, index));
      const area = node('div', '', 'assessment-writing'), paper = node('div', '', 'assessment-paper'), controls = node('div', '', 'assessment-controls');
      area.append(paper, controls); panel.append(area);
      if (isChallenge()) {
        const photo = node('img'); photo.src = C.photos[position.word]; photo.alt = '情境圖片'; photo.className = 'assessment-context'; controls.append(photo);
        controls.append(node('p', '替圖片寫標籤，向同學介紹。'));
      }
      controls.append(button('聽詞語及情境', () => speak(position, isChallenge())));
      if (answer.status === 'draft') {
        pad = F.capture(paper, answer.strokes, stroke => {
          clock(!busy);
          record = { ...record, run: A.transition(record.run, { type: 'STROKE', stroke }) };
          queueCheckpoint();
          try { A.checkInk(record.run); } catch (problem) { error = problem.message; status(error); }
        });
        const answerWith = async outcome => {
          const next = { ...record, run: A.transition(record.run, { type: 'ANSWER', status: outcome }) }; await persist(next); record = next;
          if (record.run.answers.every(item => item.status !== 'draft')) drawList(); else drawWriting();
        };
        controls.append(button('提交呢個字', () => answerWith('submitted'), 'primary large'), button('跳過，保留筆跡', () => answerWith('skipped')),
          button('撤回上一筆', async () => { const next = { ...record, run: A.transition(record.run, { type: 'UNDO' }) }; await persist(next); record = next; drawWriting(); }));
      } else {
        F.render(paper, answer.strokes); controls.append(node('p', answer.status === 'skipped' ? '已跳過，原筆跡保留。' : '已提交，等老師批改。'));
        controls.append(button('重播原筆跡', () => { stopReplay?.(); stopReplay = F.replay(paper, answer.strokes); }));
      }
      controls.append(message(error), button('保存原稿', async () => { await persist(); status('原稿已保存。'); }));
      footer(drawList, '← 返回選題');
      clock(true);
    }
    async function seal() {
      const run = A.transition(record.run, { type: 'SEAL', elapsedMs: record.run.elapsedMs });
      const next = { ...record, run, review: { marks: A.unmarked(run.assignment), revision: 0, score: null } };
      await persist(next); record = next;
      if (isChallenge()) { drawWorkCard(); return; }
      official = record; drawSummary(); if (member) await upload();
    }
    async function upload() {
      const selected = record, ownGeneration = generation;
      status('原稿已保存，交卷中…');
      try {
        const receipt = await classroom.submitReviewed(selected.run);
        if (ownGeneration !== generation) return;
        const next = { ...selected, receipt }; await persist(next); record = next; official = next; drawSummary();
      } catch (problem) {
        if (ownGeneration !== generation) return;
        error = '原稿仍保留，尚未交妥。' + problem.message; drawSummary();
      }
    }
    function drawSummary() {
      page = 'summary'; shell('原卷紀錄');
      const ready = !member || record.receipt, review = record.review;
      panel.append(node('p', !ready ? '原稿已封存，等候交卷。' : review?.score === null || !review ? '已交卷，等老師批改。' : '字形正確 ' + review.score + ' / ' + record.run.answers.length));
      const list = node('div', '', 'assessment-results');
      record.run.answers.forEach((answer, index) => {
        const item = node('div', '', 'assessment-result'), paper = node('div', '', 'review-paper'); F.render(paper, answer.strokes);
        item.append(node('p', titleFor(A.positions(record.run.assignment)[index], index)), paper);
        const mark = review?.marks[index];
        item.append(node('p', mark?.correct === true ? 'O 正確' : mark?.correct === false ? '再練習' : '待批改', mark?.correct === true ? 'teacher-correct' : ''));
        if (mark?.strokePractice) item.append(node('p', '筆順需要練習'));
        if (answer.status === 'skipped') item.append(node('p', '已跳過，保留原筆跡'));
        item.append(button('重播原筆跡', () => { stopReplay?.(); stopReplay = F.replay(paper, answer.strokes); })); list.append(item);
      });
      panel.append(list, message(error));
      const actions = node('div', '', 'assessment-summary-actions');
      if (member) {
        if (!record.receipt) actions.append(button('重試交卷', upload, 'primary'));
        actions.append(button('更新批改及班級榜', refresh));
      } else {
        actions.append(button('老師批改', drawReview, 'primary'), button('本機原卷', localOriginals));
        actions.append(button('下一位同學／開始新小測', async () => { await store.release(scope, record.key); await close(); }));
      }
      if (ready) {
        if (record.run.assignment.entries.some(entry => C.purposes[entry.text])) actions.append(button('情境小挑戰', challenge));
        actions.append(button('跟住練習', async () => { const assigned = record.run.assignment; await close(); onPractice(assigned); }));
      }
      panel.append(actions); footer(close, '← 返回課程');
    }
    async function refresh() {
      const ownGeneration = generation, data = await classroom.ownAnswer(); if (ownGeneration !== generation) return;
      if (data.answer) {
        const different = record.run.runId !== data.answer.run.runId || JSON.stringify(record.run.answers) !== JSON.stringify(data.answer.run.answers);
        const next = { ...record, ...(different ? { key: scope + ':' + data.answer.run.runId + ':received', run: data.answer.run } : {}), receipt: { runId: data.answer.run.runId, official: true }, review: { marks: data.answer.marks, score: data.answer.score, revision: data.answer.revision } };
        await persist(next);
        if (different) await store.putMany([{ key: scope, runKey: next.key, expiresAt: next.expiresAt }]);
        record = next; official = next;
      }
      const board = await classroom.reviewedBoard(); if (ownGeneration !== generation) return;
      drawSummary(); const section = node('section', '', 'assessment-board'); section.append(node('h2', '班級榜'));
      if (!board.published) section.append(node('p', '等老師公布。'));
      for (const row of board.rows) section.append(node('p', row.rank + ' · ' + row.alias + ' · ' + row.score + ' 字正確'));
      if (board.published && !board.rows.length) section.append(node('p', '未有完成批改的原卷。'));
      panel.querySelector('.assessment-footer').before(section);
    }
    function drawReview() {
      page = 'review'; shell('老師批改原卷'); const content = node('div'); panel.append(content);
      stopReview = root.BishunAssessmentReview.mount(content, { run: record.run, ...record.review }, async changes => {
        const result = A.review(record.run.assignment, changes.marks);
        const next = { ...record, review: { ...result, revision: record.review.revision + 1 } }; await persist(next); record = next; official = next; return next.review;
      }); footer(drawSummary, '← 返回原卷');
    }
    async function localOriginals() {
      const originals = await store.localOriginals(); page = 'history'; shell('本機原卷');
      const list = node('div', '', 'assessment-choices');
      originals.forEach((saved, index) => {
        const label = new Date(saved.run.startedAt).toLocaleString('zh-HK') + ' · ' + (saved.run.assignment.mode === 'copy' ? '看字寫' : '聽詞寫') + ' · ' + saved.run.answers.length + ' 字 · ' + (index + 1);
        list.append(button(label, async () => {
          const original = await store.get(saved.key); if (!original) throw new Error('原卷已到期。');
          record = original; official = original; scope = 'local:' + JSON.stringify(original.run.assignment); armExpiry(); drawReview();
        }));
      });
      panel.append(list, message('本機原卷保留 24 小時。')); footer(drawSummary, '← 返回原卷');
    }
    async function challenge() {
      official = record;
      const key = official.key + ':challenge', saved = await store.get(key);
      if (saved) record = saved;
      else {
        const entries = official.run.assignment.entries.filter(entry => C.purposes[entry.text]);
        const assignment = A.assignment(entries, 'listen');
        record = { key, kind: 'challenge', expiresAt: official.expiresAt, run: A.start(assignment, crypto.randomUUID()) };
        await persist();
      }
      if (record.run.phase === 'sealed') drawWorkCard(); else drawList();
    }
    function drawWorkCard() {
      page = 'card'; shell('我的情境作品卡'); const list = node('div', '', 'assessment-workcards'), positions = A.positions(record.run.assignment);
      record.run.assignment.entries.forEach(entry => {
        const card = node('section', '', 'assessment-workcard'), image = node('img'); image.src = C.photos[entry.text]; image.alt = '作品情境圖片';
        card.append(image, node('h2', C.purposes[entry.text].label), node('p', '給同學看的圖片介紹'));
        const ink = node('div', '', 'assessment-word-ink');
        positions.forEach((position, index) => { if (position.word === entry.text) { const paper = node('div', '', 'review-paper'); F.render(paper, record.run.answers[index].strokes); ink.append(paper); } });
        card.append(ink, node('p', C.purposes[entry.text].intro[0] + '＿＿' + C.purposes[entry.text].intro[1])); list.append(card);
      }); panel.append(list, message(error)); footer(() => { record = official; drawSummary(); }, '← 返回原卷');
    }
    async function open(assigned, joined = null) {
      if (visible) return;
      visible = true; const ownGeneration = ++generation; member = joined; error = ''; record = null; official = null; pending = Promise.resolve(); segmentStart = null;
      panel.hidden = false; conceal(true); shell('測驗'); panel.append(message('載入原稿…')); footer(close, '← 返回課程');
      try {
        await store.purge();
        if (joined && joined.expiresAt <= Date.now()) throw new Error('班級已到期。');
        const assignment = A.assignment(assigned.entries, assigned.mode);
        scope = joined ? 'class:' + joined.code + ':' + joined.memberId : 'local:' + JSON.stringify(assignment);
        const pointer = await store.get(scope); let saved = pointer ? await store.get(pointer.runKey) : null;
        if (!saved && joined) {
          const result = await classroom.ownAnswer();
          if (result.answer) {
            const answer = result.answer;
            saved = { key: scope + ':' + answer.run.runId, expiresAt: joined.expiresAt, kind: 'official', run: answer.run, receipt: { runId: answer.run.runId, official: true }, review: { marks: answer.marks, score: answer.score, revision: answer.revision } };
          }
        }
        if (!saved) {
          const run = A.start(assignment, crypto.randomUUID());
          saved = { key: scope + ':' + run.runId, expiresAt: joined?.expiresAt || Date.now() + 86400000, kind: 'official', run };
        }
        saved = await store.initialize(scope, saved);
        if (ownGeneration !== generation) return;
        record = saved; official = saved;
        armExpiry();
        if (saved.run.phase === 'sealed') drawSummary(); else drawList();
      } catch (problem) { if (ownGeneration === generation) { error = problem.message; status(error); } }
    }
    document.addEventListener('visibilitychange', () => {
      if (!visible) return;
      if (document.hidden) { clock(false); pad?.flush(); if (record?.run.phase === 'writing') queueCheckpoint(); }
      else clock(true);
    });
    root.addEventListener('beforeunload', event => { if (visible && (error || checkpointing || pad?.active())) { event.preventDefault(); event.returnValue = ''; } });
    return { open, active: () => visible, hasLocal: async () => !!await store.activeLocal(),
      async resumeLocal() { const saved = await store.activeLocal(); if (saved) await open(saved.run.assignment); return !!saved; } };
  }
  root.BishunAssessmentUI = { create };
})(typeof globalThis !== 'undefined' ? globalThis : this);
