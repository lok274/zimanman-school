(function (root) {
  'use strict';
  function create({ classroom, onClose, onPractice, store = root.BishunAssessmentStore.create() }) {
    const A = root.BishunAssessment, F = root.BishunFreehand, C = root.BishunContent;
    const node = (tag, text = '', className = '') => { const el = document.createElement(tag); el.textContent = text; if (className) el.className = className; return el; };
    const panel = node('section', '', 'assessment-panel'); panel.id = 'assessment-view'; panel.hidden = true;
    panel.setAttribute('aria-label', '自由書寫小挑戰'); document.body.append(panel);
    let context = null, activeLocal = null, record = null, official = null, page = 'list', busy = false, error = '', pending = Promise.resolve(), checkpointing = 0, segmentStart = null, runningWord = null, timerFrame = null, pad = null, stopReplay = null, stopReview = null, stopDemo = null, demoActive = false, expiryTimer = null, visible = false;
    const siblings = [...document.body.children].filter(el => el !== panel && el.tagName !== 'SCRIPT');
    function conceal(value) { for (const el of siblings) { el.inert = value; if (value) el.setAttribute('aria-hidden', 'true'); else el.removeAttribute('aria-hidden'); } }
    function status(text) { const el = panel.querySelector('[data-status]'); if (el) el.textContent = text.replaceAll('測驗', '小挑戰'); }
    function current(owner, value) {
      if (!owner || owner !== context || !visible) throw Object.assign(new Error('此小挑戰已關閉。'), { stale: true });
      if (owner.expiresAt <= Date.now() || value?.expiresAt <= Date.now()) throw Object.assign(new Error('小挑戰已到期，請老師開新一班。'), { stale: true });
    }
    function armExpiry() {
      clearTimeout(expiryTimer); const owner = context;
      expiryTimer = setTimeout(async () => {
        if (owner !== context) return;
        clock(false); context = null; busy = false; dispose(); record = null; official = null; shell('小挑戰已到期'); panel.append(message('請老師開新一班。')); footer(close);
        try { await store.purge(Date.now()); } catch { if (!context && visible) status('原稿已停止顯示。裝置未能清理，恢復儲存後會再試。'); }
      }, Math.max(0, Math.min(owner.expiresAt, record?.expiresAt || owner.expiresAt) - Date.now()));
    }
    async function persist(value = record, owner = context) {
      current(owner, value);
      if (!value) return;
      const saved = await store.put({ ...value, revision: owner.revisions.get(value.key) ?? value.revision ?? 0 }, () => current(owner, value));
      current(owner, value); owner.revisions.set(value.key, saved.revision); error = '';
      return saved;
    }
    function clock(resume) {
      if (segmentStart !== null && record?.run.phase === 'writing') record = { ...record, run: A.transition(record.run, { type: 'TIME', elapsedMs: Math.max(0, Math.round(performance.now() - segmentStart)) }) };
      segmentStart = resume && writingAllowed() ? performance.now() : null;
    }
    function writingAllowed() { return !busy && !error && page === 'writing' && !document.hidden && record?.run.phase === 'writing' && record.run.version === 3 && record.run.wordProgress[A.wordAt(record.run).wordIndex].wordId === runningWord && record.run.answers[record.run.cursor].status !== 'submitted'; }
    function timerText() {
      const word = record.run.wordProgress[A.wordAt(record.run).wordIndex];
      const milliseconds = Math.min(A.limits.duration, word.elapsedMs + (segmentStart === null ? 0 : Math.max(0, performance.now() - segmentStart)));
      const seconds = Math.floor(milliseconds / 1000); return String(Math.floor(seconds / 60)).padStart(2, '0') + ':' + String(seconds % 60).padStart(2, '0');
    }
    function startTimer(output) {
      const owner = context;
      function tick() { if (owner !== context || page !== 'writing' || !visible) return; output.textContent = timerText(); timerFrame = requestAnimationFrame(tick); }
      tick();
    }
    function queueCheckpoint() {
      const snapshot = record, owner = context; checkpointing++;
      pending = pending.catch(() => {}).then(() => persist(snapshot, owner)).catch(problem => { if (owner === context && !problem.stale) { clock(false); error = problem.message || '原稿未能保存，請保持頁面開啟再試。'; pad?.lock(true); status(error); showSaveRetry(); } }).finally(() => { checkpointing--; });
    }
    function cancelDemo() { stopDemo?.(); stopDemo = null; demoActive = false; }
    function dispose() { cancelDemo(); cancelAnimationFrame(timerFrame); timerFrame = null; pad?.dispose(); pad = null; stopReplay?.(); stopReplay = null; stopReview?.(); stopReview = null; }
    async function action(fn, checkpoint = false) {
      if (busy) return;
      const owner = context;
      clock(false); busy = true; pad?.flush(); pad?.lock(true);
      try { if (owner) { await pending; current(owner, record); if (checkpoint && record?.run.phase === 'writing') await persist(record, owner); } await fn(owner); }
      catch (problem) { if (owner === context && !problem.stale) { error = problem.message || '未能保存原稿，請保持頁面開啟再試。'; status(error); showSaveRetry(); } }
      finally { if (owner === context) { busy = false; clock(true); pad?.lock(!writingAllowed() || demoActive); } }
    }
    function button(text, fn, kind = 'secondary', checkpoint = false) { const el = node('button', text, 'button ' + kind); el.addEventListener('click', () => action(fn, checkpoint)); return el; }
    function showSaveRetry() {
      const controls = panel.querySelector('.assessment-controls');
      if (error && record?.run.phase === 'writing' && controls && !controls.querySelector('[data-retry]')) {
        const retry = button('重試保存', async () => { await persist(); drawWriting(); }, 'primary'); retry.setAttribute('data-retry', ''); controls.append(retry);
        const submit = controls.querySelector('[data-submit]'); if (submit) submit.hidden = true;
      }
    }
    function message(text) { const el = node('p', text.replaceAll('測驗', '小挑戰'), 'assessment-status'); el.setAttribute('role', 'status'); el.setAttribute('data-status', ''); return el; }
    function shell(title) {
      dispose(); panel.replaceChildren();
      const heading = node('header', '', 'assessment-heading'); heading.append(node('h1', title));
      panel.append(heading); return panel;
    }
    function footer(fn, label = '← 返回') { const el = node('footer', '', 'assessment-footer'); el.append(button(label, fn, 'secondary', true)); panel.append(el); }
    function isChallenge() { return record?.kind === 'challenge'; }
    function titleFor(position, index) { return A.actualMode(record.run) === 'listen' ? '第 ' + (index + 1) + ' 題 · 詞語第 ' + (position.index + 1) + ' 字' : position.word + ' · 第 ' + (position.index + 1) + ' 字「' + position.character + '」'; }
    function positionGroups() {
      const positions = A.positions(record.run.assignment); let offset = 0;
      return record.run.assignment.entries.map((entry, wordIndex) => {
        const count = entry.selectedIndexes.length, group = { entry, wordIndex, start: offset, positions: positions.slice(offset, offset + count), answers: record.run.answers.slice(offset, offset + count) };
        offset += count; return group;
      });
    }
    function answerLabel(answer) { return ['draft', 'ready'].includes(answer.status) ? '未提交' : answer.status === 'skipped' ? '已跳過' : '已提交'; }
    function speak(position, contextual = false) {
      const owner = context;
      const synth = root.speechSynthesis, voice = synth?.getVoices().find(item => /yue|zh[-_]HK/i.test(item.lang));
      if (!synth || !voice) { status('裝置未提供粵語聲音，請老師讀出題目。'); return; }
      const text = (contextual ? C.cue(position.word)[0] : position.word + '。' + C.cue(position.word)[0]) + '寫第 ' + (position.index + 1) + ' 個字。';
      synth.cancel(); const utterance = new SpeechSynthesisUtterance(text); utterance.voice = voice; utterance.lang = voice.lang; utterance.rate = 0.85;
      utterance.onerror = () => { if (owner === context) status('聲音未能播放，請老師讀出題目。'); }; synth.speak(utterance);
    }
    async function close() { visible = false; context = null; busy = false; clearTimeout(expiryTimer); dispose(); root.speechSynthesis?.cancel(); panel.hidden = true; conceal(false); record = null; official = null; activeLocal = null; onClose(); }
    function drawList() {
      clock(false); runningWord = null; page = 'list'; shell(isChallenge() ? '情境小挑戰' : '小挑戰');
      const list = node('div', '', 'word-cards assessment-choices');
      const listen = A.actualMode(record.run) === 'listen' && !isChallenge();
      positionGroups().forEach(group => {
        const position = group.positions[0], index = group.start, title = group.positions.map((item, groupIndex) => titleFor(item, index + groupIndex) + ' · ' + answerLabel(group.answers[groupIndex])).join('；');
        const card = button('', () => {
          const next = group.answers.findIndex(answer => answer.status === 'draft');
          record = { ...record, run: A.transition(record.run, { type: 'SELECT', index: group.start + (next < 0 ? 0 : next) }) }; drawWriting();
        });
        card.className = 'word-card assessment-choice-card' + (listen ? ' assessment-choice-listen' : ''); card.setAttribute('aria-label', title);
        card.style.setProperty('--word-length', String(listen ? 2 : Array.from(group.entry.text).length));
        const word = node('span', listen ? '第 ' + (group.wordIndex + 1) + ' 題' : group.entry.text, 'word-name');
        card.append(word);
        if (!listen) { const photo = node('img'); photo.src = C.photos[group.entry.text]; photo.alt = group.entry.text + '圖片'; photo.className = 'word-photo'; card.append(photo); }
        if (group.answers.every(answer => answer.status === 'submitted')) { card.disabled = true; card.append(node('span', '已完成', 'assessment-completed')); }
        list.append(card);
      });
      panel.append(list, message(error));
      if (record.run.answers.every(answer => answer.status === 'submitted')) panel.append(button(isChallenge() ? '完成作品卡' : '交整份小挑戰', seal, 'primary large'));
      footer(isChallenge() ? async () => { record = official; drawSummary(); } : close, isChallenge() ? '← 返回原卷' : '← 返回課程');
    }
    function drawWriting() {
      page = 'writing'; const index = record.run.cursor, position = A.positions(record.run.assignment)[index], answer = record.run.answers[index];
      shell(position.word);
      const area = node('div', '', 'assessment-writing'), paper = node('div', '', 'assessment-paper'), controls = node('div', '', 'assessment-controls');
      area.append(paper, controls); panel.append(area);
      if (isChallenge()) {
        const photo = node('img'); photo.src = C.photos[position.word]; photo.alt = '情境圖片'; photo.className = 'assessment-context'; controls.append(photo);
      }
      controls.append(button('聽題目', () => speak(position, isChallenge())));
      if (['draft', 'ready'].includes(answer.status)) {
        const group = A.wordAt(record.run), word = record.run.wordProgress[group.wordIndex], started = runningWord === word.wordId;
        const timer = node('output', timerText(), 'assessment-timer'); timer.setAttribute('aria-label', '詞語用時'); controls.append(timer); startTimer(timer);
        pad = F.capture(paper, answer.strokes, stroke => {
          clock(!busy);
          record = { ...record, run: A.transition(record.run, { type: 'STROKE', stroke }) };
          const undo = controls.querySelector('[data-undo]'); if (undo) undo.disabled = false;
          queueCheckpoint();
          try { A.checkInk(record.run); } catch (problem) { error = problem.message; status(error); }
        }, position.character);
        pad.lock(!writingAllowed());
        const advance = async () => {
          const last = index + 1 === group.end;
          const next = { ...record, run: A.transition(record.run, { type: last ? 'SUBMIT_WORD' : 'NEXT_CHARACTER' }) }; await persist(next); record = next;
          if (last) drawList(); else drawWriting();
        };
        const primary = started ? button(index + 1 === group.end ? '交答案' : '下一個字', advance, 'primary large') : button('開始', async () => {
          const next = { ...record, run: A.transition(record.run, { type: 'START_WORD' }) }; await persist(next); record = next; runningWord = word.wordId; drawWriting();
        }, 'primary large');
        primary.setAttribute('data-submit', '');
        const hint = button('提示', async () => {
          cancelDemo();
          const next = { ...record, run: A.transition(record.run, { type: 'HINT' }) }; await persist(next); record = next;
          demoActive = true; pad.lock(true);
          stopDemo = F.demo(paper, position.character, record.run.answers[record.run.cursor].strokes.length, () => { stopDemo = null; demoActive = false; pad?.lock(!writingAllowed()); }, text => { stopDemo = null; demoActive = false; status(text); pad?.lock(!writingAllowed()); });
        });
        hint.disabled = !started;
        const undo = button('擦掉前一筆', async () => { record = { ...record, run: A.transition(record.run, { type: 'UNDO' }) }; drawWriting(); await persist(); }); undo.disabled = !started || !answer.strokes.length; undo.setAttribute('data-undo', '');
        controls.append(primary, hint, undo);
      } else {
        F.render(paper, answer.strokes); controls.append(node('p', answer.status === 'skipped' ? '已跳過，原筆跡保留。' : '已提交，等老師批改。'));
        controls.append(button('重播原筆跡', () => { stopReplay?.(); stopReplay = F.replay(paper, answer.strokes); }));
      }
      controls.append(message(error)); showSaveRetry();
      footer(drawList, '← 返回選題');
      clock(true);
    }
    async function seal() {
      const run = A.transition(record.run, { type: 'SEAL', elapsedMs: record.run.elapsedMs });
      const next = { ...record, run, review: { marks: A.unmarked(run.assignment), revision: 0, score: null } };
      await persist(next); record = next;
      if (isChallenge()) { drawWorkCard(); return; }
      official = record; drawSummary(); if (context.member) await upload();
    }
    async function upload() {
      const selected = record, owner = context;
      status('原稿已保存，交卷中…');
      try {
        const receipt = await classroom.submitReviewed(selected.run);
        current(owner, selected);
        const next = { ...selected, receipt }; await persist(next, owner); record = next; official = next; drawSummary();
      } catch (problem) {
        if (owner !== context || problem.stale) return;
        error = '原稿仍保留，尚未交妥。' + problem.message; drawSummary();
      }
    }
    function drawSummary() {
      page = 'summary'; shell('原卷紀錄');
      const ready = !context.member || record.receipt, review = record.review;
      panel.append(node('p', !ready ? '原稿已封存，等候交卷。' : review?.score === null || !review ? '已交卷，等老師批改。' : '字形正確 ' + review.score + ' / ' + record.run.answers.length));
      const actions = node('div', '', 'assessment-summary-actions');
      actions.append(button('查看原筆跡', () => drawOriginal(0)));
      if (context.member) {
        if (!record.receipt) actions.append(button('重試交卷', upload, 'primary'));
        actions.append(button('更新批改及班級榜', refresh));
      } else {
        actions.append(button('老師批改', drawReview, 'primary'), button('本機原卷', localOriginals));
        actions.append(button('下一位同學', async owner => { if (activeLocal) await store.release(activeLocal.scope, activeLocal.runKey); current(owner); await close(); }, 'secondary', true));
      }
      if (ready) {
        if (record.run.assignment.entries.some(entry => C.purposes[entry.text])) actions.append(button('情境小挑戰', challenge));
        actions.append(button('跟住練習', async () => { const assigned = record.run.assignment; await close(); onPractice(assigned); }, 'secondary', true));
      }
      panel.append(actions, message(error)); footer(close, '← 返回課程');
    }
    function pagination(index, count, draw) {
      const navigation = node('nav', '', 'assessment-pagination'); navigation.setAttribute('aria-label', '逐項查看');
      const previous = button('上一項', () => draw(index - 1)), next = button('下一項', () => draw(index + 1));
      previous.disabled = index === 0; next.disabled = index === count - 1;
      navigation.append(previous, node('span', (index + 1) + ' / ' + count), next); return navigation;
    }
    function drawOriginal(index) {
      page = 'original'; shell(titleFor(A.positions(record.run.assignment)[index], index));
      const answer = record.run.answers[index], mark = record.review?.marks[index];
      const area = node('div', '', 'assessment-writing'), paper = node('div', '', 'assessment-paper'), controls = node('div', '', 'assessment-controls');
      F.render(paper, answer.strokes);
      controls.append(node('p', mark?.correct === true ? 'O 正確' : mark?.correct === false ? '再練習' : '待批改', mark?.correct === true ? 'teacher-correct' : ''));
      if (mark?.strokePractice) controls.append(node('p', '筆順需要練習'));
      if (answer.status === 'skipped') controls.append(node('p', '已跳過，保留原筆跡'));
      controls.append(button('重播原筆跡', () => { stopReplay?.(); stopReplay = F.replay(paper, answer.strokes); }), pagination(index, record.run.answers.length, drawOriginal));
      controls.append(message(error)); area.append(paper, controls); panel.append(area); footer(drawSummary, '← 返回原卷');
    }
    async function refresh() {
      const owner = context, data = await classroom.ownAnswer(); current(owner, record);
      if (data.answer) {
        const different = record.run.runId !== data.answer.run.runId || JSON.stringify(record.run.answers) !== JSON.stringify(data.answer.run.answers);
        const next = { ...record, ...(different ? { key: owner.scope + ':' + data.answer.run.runId + ':received', revision: 0, run: data.answer.run } : {}), receipt: { runId: data.answer.run.runId, official: true }, review: { marks: data.answer.marks, score: data.answer.score, revision: data.answer.revision } };
        await persist(next, owner);
        if (different) { await store.putMany([{ key: owner.scope, runKey: next.key, expiresAt: next.expiresAt }], () => current(owner, next)); current(owner, next); }
        record = next; official = next;
      }
      const board = await classroom.reviewedBoard(); current(owner, record);
      drawSummary(); const section = node('section', '', 'assessment-board'); section.append(node('h2', '班級榜'));
      if (!board.published) section.append(node('p', '等老師公布。'));
      let mode;
      for (const row of board.rows) {
        if (row.mode && row.mode !== mode) { section.append(node('h3', row.mode === 'copy' ? '看字寫' : '聽詞寫')); mode = row.mode; }
        section.append(node('p', row.rank + ' · ' + row.alias + ' · ' + row.score + ' 字正確'));
      }
      if (board.published && !board.rows.length) section.append(node('p', '未有完成批改的原卷。'));
      panel.querySelector('.assessment-footer').before(section);
    }
    function drawReview() {
      page = 'review'; shell('老師批改原卷'); const content = node('div'), owner = context, selected = record; panel.append(content);
      stopReview = root.BishunAssessmentReview.mount(content, { run: record.run, ...record.review }, async changes => {
        current(owner, selected);
        if (record.key !== selected.key) throw Object.assign(new Error('已切換原卷。'), { stale: true });
        const result = A.review(selected.run.assignment, changes.marks);
        const next = { ...record, review: { ...result, revision: record.review.revision + 1 } }; await persist(next, owner); record = next; official = next; return next.review;
      }); footer(drawSummary, '← 返回原卷');
    }
    async function localOriginals() {
      const owner = context, originals = await store.localOriginals(); current(owner, record); page = 'history'; shell('本機原卷');
      const list = node('div', '', 'assessment-choices');
      originals.forEach((saved, index) => {
        const label = new Date(saved.run.startedAt).toLocaleString('zh-HK') + ' · ' + (A.actualMode(saved.run) === 'copy' ? '看字寫' : '聽詞寫') + ' · ' + saved.run.answers.length + ' 字 · ' + (index + 1);
        list.append(button(label, async () => {
          const original = await store.get(saved.key); current(owner, original); if (!original) throw new Error('原卷已到期。');
          owner.revisions.set(original.key, original.revision || 0); record = original; official = original; armExpiry(); drawReview();
        }));
      });
      panel.append(list, message('本機原卷保留 24 小時。')); footer(drawSummary, '← 返回原卷');
    }
    async function challenge() {
      const owner = context; official = record;
      const key = official.key + ':challenge', saved = await store.get(key);
      current(owner, saved || official);
      if (saved) { owner.revisions.set(saved.key, saved.revision || 0); record = saved; }
      else {
        const entries = official.run.assignment.entries.filter(entry => C.purposes[entry.text]).map(entry => ({ text: entry.text, selectedIndexes: Array.from(entry.text, (_, index) => index) }));
        const assignment = A.assignment(entries, 'listen');
        record = { key, kind: 'challenge', expiresAt: official.expiresAt, run: A.startWords(assignment, crypto.randomUUID()) };
        await persist();
      }
      if (record.run.version === 2 && record.run.phase === 'writing') { const next = { ...record, run: A.upgradeWords(record.run) }; await persist(next); record = next; }
      if (record.run.phase === 'sealed') drawWorkCard(); else drawList();
    }
    function drawWorkCard(index = 0) {
      page = 'card'; shell('我的情境作品卡'); const list = node('div', '', 'assessment-workcards'), positions = A.positions(record.run.assignment);
      const entries = record.run.assignment.entries, entry = entries[index];
      const card = node('section', '', 'assessment-workcard'), image = node('img'); image.src = C.photos[entry.text]; image.alt = '作品情境圖片';
      card.append(image, node('h2', C.purposes[entry.text].label, 'sr-only'));
      const ink = node('div', '', 'assessment-word-ink'), introduction = node('div', '', 'assessment-introduction');
      positions.forEach((position, answerIndex) => { if (position.word === entry.text) { const paper = node('div', '', 'review-paper'); F.render(paper, record.run.answers[answerIndex].strokes); ink.append(paper); } });
      introduction.append(node('span', C.purposes[entry.text].intro[0]), ink, node('span', C.purposes[entry.text].intro[1])); card.append(introduction); list.append(card);
      panel.append(list, pagination(index, entries.length, drawWorkCard), message(error)); footer(() => { record = official; drawSummary(); }, '← 返回原卷');
    }
    async function open(assigned, joined = null) {
      if (visible) return;
      const assignment = A.assignment(assigned.entries, assigned.mode), scope = joined ? 'class:' + joined.code + ':' + joined.memberId : 'local:' + JSON.stringify(assignment);
      const owner = Object.freeze({ scope, member: joined ? Object.freeze({ ...joined }) : null, expiresAt: joined?.expiresAt || Date.now() + 86400000, revisions: new Map() });
      visible = true; context = owner; activeLocal = null; busy = false; error = ''; record = null; official = null; pending = Promise.resolve(); segmentStart = null; runningWord = null;
      panel.hidden = false; conceal(true); shell('小挑戰'); panel.append(message('載入原稿…')); footer(close, '← 返回課程');
      armExpiry();
      try {
        await store.purge(); current(owner);
        const pointer = await store.get(scope); current(owner);
        let saved = pointer ? await store.get(pointer.runKey) : null; current(owner, saved);
        if (!saved && joined) {
          const result = await classroom.ownAnswer(); current(owner);
          if (result.answer) {
            const answer = result.answer;
            saved = { key: scope + ':' + answer.run.runId, expiresAt: joined.expiresAt, kind: 'official', run: answer.run, receipt: { runId: answer.run.runId, official: true }, review: { marks: answer.marks, score: answer.score, revision: answer.revision } };
          }
        }
        if (!saved) {
          const run = A.startWords(assignment, crypto.randomUUID());
          saved = { key: scope + ':' + run.runId, expiresAt: joined?.expiresAt || Date.now() + 86400000, kind: 'official', run };
        }
        saved = await store.initialize(scope, saved, () => current(owner, saved)); current(owner, saved);
        owner.revisions.set(saved.key, saved.revision || 0);
        if (saved.run.version === 2 && saved.run.phase === 'writing') { saved = { ...saved, run: A.upgradeWords(saved.run) }; saved = await persist(saved, owner); }
        if (!joined) activeLocal = Object.freeze({ scope, runKey: saved.key });
        record = saved; official = saved;
        armExpiry();
        if (saved.run.phase === 'sealed') drawSummary(); else drawList();
      } catch (problem) { if (owner === context && !problem.stale) { error = problem.message; status(error); } }
    }
    function pauseWriting() { if (visible) { clock(false); cancelDemo(); pad?.flush(); pad?.lock(true); if (record?.run.phase === 'writing') queueCheckpoint(); } }
    function resumeWriting() { if (visible && !document.hidden) { clock(true); pad?.lock(!writingAllowed()); } }
    document.addEventListener('visibilitychange', () => { if (document.hidden) pauseWriting(); else resumeWriting(); });
    root.addEventListener('pagehide', pauseWriting);
    root.addEventListener('pageshow', resumeWriting);
    root.addEventListener('beforeunload', event => { if (visible && (error || checkpointing || pad?.active())) { event.preventDefault(); event.returnValue = ''; } });
    return { open, active: () => visible, hasLocal: async () => !!await store.activeLocal(),
      async resumeLocal() { const saved = await store.activeLocal(); if (saved) await open(saved.run.assignment); return !!saved; } };
  }
  root.BishunAssessmentUI = { create };
})(typeof globalThis !== 'undefined' ? globalThis : this);
