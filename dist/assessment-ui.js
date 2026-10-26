(function (root) {
  'use strict';
  function create({ classroom, onClose, store = root.BishunAssessmentStore.create() }) {
    const A = root.BishunAssessment, W = root.BishunWriting, C = root.BishunContent;
    const node = (tag, text = '', className = '') => { const el = document.createElement(tag); el.textContent = text; if (className) el.className = className; return el; };
    const panel = node('section', '', 'assessment-panel'); panel.id = 'assessment-view'; panel.hidden = true;
    panel.setAttribute('aria-label', '筆順小挑戰'); document.body.append(panel);
    const target = node('div', '', 'assessment-writer'); target.setAttribute('aria-label', '按筆順書寫');
    const siblings = [...document.body.children].filter(el => el !== panel && el.tagName !== 'SCRIPT');
    let context = null, record = null, page = 'list', busy = false, error = '', pending = Promise.resolve(), checkpointing = 0;
    let segmentStart = null, runningWord = null, timerFrame = null, pad = null, ready = false, data = null, loadController = null, generation = 0, hintActive = false, expiryTimer = null, poll = null, boardGeneration = 0, pollsLeft = 120, visible = false;
    function conceal(value) { for (const el of siblings) { el.inert = value; if (value) el.setAttribute('aria-hidden', 'true'); else el.removeAttribute('aria-hidden'); } }
    function status(text) { const el = panel.querySelector('[data-status]'); if (el) el.textContent = text.replaceAll('測驗', '小挑戰'); }
    function current(owner, value) {
      if (!owner || owner !== context || !visible) throw Object.assign(new Error('此小挑戰已關閉。'), { stale: true });
      if (owner.expiresAt <= Date.now() || value?.expiresAt <= Date.now()) throw Object.assign(new Error('小挑戰已到期，請老師開新一班。'), { stale: true });
    }
    function stopBoard() { clearTimeout(poll); poll = null; boardGeneration++; if (context?.member) classroom.cancelRequests(); }
    function armExpiry() {
      clearTimeout(expiryTimer); const owner = context;
      expiryTimer = setTimeout(async () => {
        if (owner !== context) return;
        clock(false); stopBoard(); context = null; busy = false; record = null; shell('小挑戰已到期'); panel.append(message('請老師開新一班。')); footer(close);
        try { await store.purge(Date.now()); } catch { if (!context && visible) status('原稿已停止顯示。恢復儲存後會再清理。'); }
      }, Math.max(0, Math.min(owner.expiresAt, record?.expiresAt || owner.expiresAt) - Date.now()));
    }
    async function persist(value = record, owner = context) {
      current(owner, value);
      const saved = await store.put({ ...value, revision: owner.revisions.get(value.key) ?? value.revision ?? 0 }, () => current(owner, value));
      current(owner, value); owner.revisions.set(value.key, saved.revision); error = ''; return saved;
    }
    function writingAllowed() {
      if (!record || record.run.phase !== 'writing' || page !== 'writing' || document.hidden || busy || error || !ready) return false;
      const group = A.wordAt(record.run);
      return runningWord === record.run.wordProgress[group.wordIndex].wordId && record.run.answers[record.run.cursor].status === 'draft';
    }
    function clock(resume) {
      if (segmentStart !== null && record?.run.phase === 'writing') record = { ...record, run: A.transition(record.run, { type: 'TIME', elapsedMs: Math.max(0, Math.round(performance.now() - segmentStart)) }) };
      segmentStart = resume && writingAllowed() ? performance.now() : null;
    }
    function timerText() {
      const word = record.run.wordProgress[A.wordAt(record.run).wordIndex];
      const seconds = Math.floor(Math.min(A.limits.duration, word.elapsedMs + (segmentStart === null ? 0 : Math.max(0, performance.now() - segmentStart))) / 1000);
      return String(Math.floor(seconds / 60)).padStart(2, '0') + ':' + String(seconds % 60).padStart(2, '0');
    }
    function startTimer(output) {
      const owner = context;
      function tick() { if (owner !== context || page !== 'writing' || !visible) return; output.textContent = timerText(); timerFrame = requestAnimationFrame(tick); }
      tick();
    }
    function saveFailure(problem) { clock(false); error = problem.message || '原稿未能保存，請保持頁面開啟再試。'; pad?.suspend(); status(error); updateControls(); showRetry(); }
    function queueCheckpoint() {
      const snapshot = record, owner = context; checkpointing++;
      pending = pending.catch(() => {}).then(() => persist(snapshot, owner)).catch(problem => { if (owner === context && !problem.stale) saveFailure(problem); }).finally(() => { checkpointing--; });
    }
    function disposePad() { generation++; loadController?.abort(); loadController = null; pad?.dispose(); pad = null; ready = false; hintActive = false; target.style.visibility = ''; }
    function dispose() { disposePad(); cancelAnimationFrame(timerFrame); timerFrame = null; }
    async function action(fn, checkpoint = false) {
      if (busy) return;
      const owner = context;
      clock(false); if (hintActive) { generation++; hintActive = false; } busy = true; pad?.suspend();
      try { if (owner) { await pending; current(owner, record); if (checkpoint && record?.run.phase === 'writing') await persist(record, owner); } await fn(owner); }
      catch (problem) { if (owner === context && !problem.stale) { if (page === 'writing') saveFailure(problem); else { error = problem.message; status(error); showRetry(); } } }
      finally { if (owner === context) { busy = false; if (page === 'writing' && data && !hintActive) mountPad(); clock(true); updateControls(); } }
    }
    function button(text, fn, kind = 'secondary', checkpoint = false) { const el = node('button', text, 'button ' + kind); el.addEventListener('click', () => action(fn, checkpoint)); return el; }
    function message(text) { const el = node('p', text.replaceAll('測驗', '小挑戰'), 'assessment-status'); el.setAttribute('role', 'status'); el.setAttribute('data-status', ''); return el; }
    function shell(title) { dispose(); panel.replaceChildren(); const heading = node('header', '', 'assessment-heading'); heading.append(node('h1', title)); panel.append(heading); }
    function footer(fn, label = '← 返回') { const el = node('footer', '', 'assessment-footer'); el.append(button(label, fn, 'secondary', true)); panel.append(el); }
    function showRetry() {
      const container = panel.querySelector('.assessment-controls') || panel.querySelector('.assessment-board');
      if (!error || !container || container.querySelector('[data-retry]')) return;
      const retry = button(page === 'writing' ? '重試保存及載入' : '重試', async () => {
        if (page === 'writing') { await persist(); drawWriting(); }
        else { error = ''; drawBoard(); loadBoard(); }
      }, 'primary'); retry.setAttribute('data-retry', ''); container.append(retry);
    }
    function updateControls() {
      if (page !== 'writing' || !record) return;
      const answer = record.run.answers[record.run.cursor], started = runningWord === record.run.wordProgress[A.wordAt(record.run).wordIndex].wordId;
      for (const key of ['submit', 'hint-button', 'undo', 'start']) {
        const control = panel.querySelector('[data-' + key + ']');
        if (control) control.disabled = busy || !!error || !ready || (key === 'submit' ? !started || !A.completeAnswer(answer) : key === 'hint-button' ? !started || A.completeAnswer(answer) : key === 'undo' ? !started || !answer.strokes.length : false);
      }
    }
    function speak(position) {
      const synth = root.speechSynthesis, voice = synth?.getVoices().find(item => /yue|zh[-_]HK/i.test(item.lang));
      if (!synth || !voice) { status('裝置未提供粵語聲音，請老師讀出題目。'); return; }
      synth.cancel(); const utterance = new SpeechSynthesisUtterance(position.character + '。寫第 ' + (position.index + 1) + ' 個字。'); utterance.voice = voice; utterance.lang = voice.lang; utterance.rate = 0.85;
      const owner = context; utterance.onerror = () => { if (owner === context) status('聲音未能播放，請老師讀出題目。'); }; synth.speak(utterance);
    }
    async function close() {
      if (context && !context.member && record?.run.phase === 'sealed') { const owner = context; await store.release(owner.scope, record.key); current(owner, record); }
      stopBoard(); visible = false; context = null; busy = false; clearTimeout(expiryTimer); dispose(); root.speechSynthesis?.cancel(); panel.hidden = true; conceal(false); record = null; onClose();
    }
    function drawList() {
      clock(false); runningWord = null; page = 'list'; data = null; shell('小挑戰');
      const list = node('div', '', 'word-cards assessment-choices'); let offset = 0;
      record.run.assignment.entries.forEach(entry => {
        const start = offset, answers = record.run.answers.slice(start, start + entry.selectedIndexes.length); offset += answers.length;
        const card = button('', () => { const next = answers.findIndex(answer => answer.status === 'draft'); record = { ...record, run: A.transition(record.run, { type: 'SELECT', index: start + Math.max(0, next) }) }; drawWriting(); });
        card.className = 'word-card assessment-choice-card'; card.style.setProperty('--word-length', String(Array.from(entry.text).length)); card.append(node('span', entry.text, 'word-name'));
        if (C.photos[entry.text]) { const photo = node('img'); photo.src = C.photos[entry.text]; photo.alt = entry.text + '圖片'; photo.className = 'word-photo'; card.append(photo); }
        if (answers.every(answer => answer.status === 'submitted')) { card.disabled = true; card.append(node('span', '已完成', 'assessment-completed')); }
        list.append(card);
      });
      panel.append(list, message(error)); footer(close, '← 返回課程');
    }
    function mountPad() {
      if (!data || page !== 'writing' || !record) return;
      clock(false); disposePad(); const token = generation, owner = context, index = record.run.cursor, answer = record.run.answers[index], position = A.positions(record.run.assignment)[index];
      const selectedData = data; ready = true; const locked = !writingAllowed() || answer.status === 'submitted' || A.completeAnswer(answer); ready = false;
      const valid = () => owner === context && page === 'writing' && generation === token && record?.run.cursor === index;
      pad = W.mount(target, position.character, selectedData, {
        phase: 'assessment', token, currentStroke: answer.strokes.length, acceptedInk: answer.strokes, locked,
        isCurrent: () => valid() && writingAllowed() && !hintActive,
        onReady() { if (!valid()) return; ready = true; clock(true); updateControls(); },
        onError(problem) { if (valid()) saveFailure(problem); },
        onEvent(event) {
          if (!valid() || !writingAllowed() || hintActive) return false;
          if (event.type === 'STROKE_MISSED') { status('↻ 請重新書寫此筆。'); return true; }
          try {
            clock(true); record = { ...record, run: A.transition(record.run, event) };
            if (event.type === 'STROKE_ACCEPTED') { queueCheckpoint(); status(''); updateControls(); }
            return true;
          } catch (problem) { saveFailure(problem); return false; }
        }
      });
    }
    async function loadPad() {
      const owner = context, token = generation, selected = record, position = A.positions(record.run.assignment)[record.run.cursor];
      loadController = new AbortController(); status('載入字形…');
      try {
        const loaded = await W.loadCharacter(position.character, loadController.signal);
        current(owner, selected); if (token !== generation || page !== 'writing') return;
        const next = { ...record, run: A.transition(record.run, { type: 'DATA_READY', count: loaded.strokes.length }) };
        if (record.run.answers[record.run.cursor].expectedStrokes === null) { await persist(next, owner); current(owner, next); if (token !== generation) return; record = next; }
        data = loaded; status(error); mountPad();
      } catch (problem) { if (owner === context && token === generation && !problem.stale) saveFailure(new Error('字形暫未能載入，原稿仍然保留。' + problem.message)); }
    }
    function drawWriting() {
      clock(false); page = 'writing'; data = null;
      const index = record.run.cursor, position = A.positions(record.run.assignment)[index], answer = record.run.answers[index];
      shell(position.word + ' · 第 ' + (position.index + 1) + ' 字');
      const area = node('div', '', 'assessment-writing'), paper = node('div', '', 'assessment-paper'), controls = node('div', '', 'assessment-controls');
      paper.append(target); area.append(paper, controls); panel.append(area);
      const timer = node('output', timerText(), 'assessment-timer'); timer.setAttribute('aria-label', '詞語用時'); controls.append(timer); startTimer(timer);
      controls.append(button('聽題目', () => speak(position)));
      if (answer.status === 'submitted') {
        controls.append(node('p', 'O', 'assessment-correct'));
        controls.append(button('下一個字', async () => {
          const group = A.wordAt(record.run);
          if (record.run.answers.every(item => item.status === 'submitted')) await seal();
          else if (index + 1 === group.end) drawList();
          else { const next = { ...record, run: A.transition(record.run, { type: 'NEXT_CHARACTER' }) }; await persist(next); record = next; drawWriting(); }
        }, 'primary large'));
      } else {
        const word = record.run.wordProgress[A.wordAt(record.run).wordIndex], started = runningWord === word.wordId;
        const primary = started ? button('交答案', async () => {
          const next = { ...record, run: A.transition(record.run, { type: 'SUBMIT_CHARACTER' }) }; await persist(next); record = next; drawWriting();
        }, 'primary large') : button('開始', async () => {
          const next = { ...record, run: A.transition(record.run, { type: 'START_WORD' }) }; await persist(next); record = next; runningWord = word.wordId;
          drawWriting();
        }, 'primary large'); primary.setAttribute(started ? 'data-submit' : 'data-start', '');
        const hint = button('提示', async () => {
          record = { ...record, run: A.transition(record.run, { type: 'HINT' }) }; await persist();
          const owner = context, token = generation; hintActive = true; busy = false; clock(true);
          pad.hint().then(() => { if (owner === context && token === generation && page === 'writing') { hintActive = false; mountPad(); } }).catch(problem => { if (owner === context && token === generation) { hintActive = false; saveFailure(problem); } });
        }); hint.setAttribute('data-hint-button', '');
        const undo = button('擦掉前一筆', async () => { record = { ...record, run: A.transition(record.run, { type: 'UNDO' }) }; await persist(); drawWriting(); }); undo.setAttribute('data-undo', '');
        controls.append(primary, hint, undo);
      }
      controls.append(message(error)); showRetry(); updateControls(); footer(drawList, '← 返回選題'); loadPad();
    }
    async function seal() {
      const next = { ...record, run: A.transition(record.run, { type: 'SEAL' }) }; await persist(next); record = next; drawBoard(); loadBoard();
    }
    function drawBoard() {
      clock(false); stopBoard(); page = 'board'; runningWord = null; data = null; shell(context.member ? '班級排行榜' : '本機排行榜');
      const section = node('section', '', 'assessment-board'); section.append(node('div', '', 'assessment-board-rows'), message(error)); panel.append(section); showRetry(); footer(close, '← 返回課程');
    }
    function renderBoard(rows) {
      const container = panel.querySelector('.assessment-board-rows'); if (!container) return;
      container.replaceChildren();
      if (!rows.length) { container.append(node('p', '尚未有完成紀錄。')); return; }
      const table = node('table'), heading = node('tr');
      for (const label of ['名次', context.member ? '暱稱' : '紀錄', '時間（秒）']) { const cell = node('th', label); cell.setAttribute('scope', 'col'); heading.append(cell); } table.append(heading);
      for (const row of rows) { const tr = node('tr', '', row.isMe ? 'is-me' : ''); for (const value of [row.rank, row.alias, (row.elapsedMs / 1000).toFixed(1)]) tr.append(node('td', String(value))); table.append(tr); }
      container.append(table);
    }
    async function adoptOfficial(answer, owner) {
      const run = A.validateAutomatic(record.run.assignment, answer.run), oldKey = record.key;
      const next = { key: owner.scope + ':' + run.runId + ':received', kind: 'official', expiresAt: owner.expiresAt, run, receipt: answer.receipt };
      const existing = await store.get(next.key); current(owner, existing || next);
      const saved = existing || await persist(next, owner);
      await store.replacePointer(owner.scope, oldKey, saved.key, saved.expiresAt, () => current(owner, saved)); current(owner, saved);
      record = saved;
    }
    async function loadBoard() {
      const owner = context, token = ++boardGeneration; clearTimeout(poll); poll = null;
      const valid = () => owner === context && token === boardGeneration && page === 'board' && !document.hidden && visible;
      if (!valid()) return;
      try {
        if (owner.member) {
          if (!record.receipt) {
            status('原稿已保存，交卷中…');
            try {
              const receipt = await classroom.submitAutomatic(record.run); current(owner, record); if (!valid()) return;
              record = await persist({ ...record, receipt }, owner);
            } catch (problem) {
              if (problem.code !== 'FIRST_SUBMISSION') throw problem;
              const result = await classroom.ownAutomaticAnswer(); current(owner, record); if (!valid()) return;
              if (!result.answer) throw new Error('原卷暫未能讀取。');
              await adoptOfficial(result.answer, owner);
            }
          }
          const board = await classroom.automaticBoard(); current(owner, record); if (!valid()) return;
          renderBoard(board.rows); error = ''; status(pollsLeft ? '' : '自動更新已暫停，重新開啟可更新。');
          if (pollsLeft > 0) poll = setTimeout(() => { poll = null; pollsLeft--; loadBoard(); }, 5000);
        } else {
          const originals = await store.localOriginals(); current(owner, record); if (!valid()) return;
          const same = originals.filter(saved => saved.run.version === 4 && saved.run.policy === A.policy && A.actualMode(saved.run) === A.actualMode(record.run) && JSON.stringify(saved.run.assignment) === JSON.stringify(record.run.assignment)).sort((a, b) => a.run.startedAt - b.run.startedAt || a.key.localeCompare(b.key));
          const rows = same.map((saved, index) => ({ alias: '紀錄 ' + (index + 1), elapsedMs: A.boardTime(A.validateAutomatic(record.run.assignment, saved.run).elapsedMs), isMe: saved.key === record.key }));
          renderBoard(A.timeRanks(rows)); error = ''; status('');
        }
        panel.querySelector('[data-retry]')?.remove();
      } catch (problem) { if (valid() && !problem.stale) { error = '原稿仍然保留。' + problem.message; status(error); showRetry(); } }
    }
    async function open(assigned, joined = null) {
      if (visible) return;
      const assignment = A.assignment(assigned.entries, assigned.mode), scope = joined ? 'class:v4:' + joined.code + ':' + joined.memberId : 'local:v4:' + JSON.stringify(assignment);
      const owner = Object.freeze({ scope, member: joined ? Object.freeze({ ...joined }) : null, expiresAt: joined?.expiresAt || Date.now() + 86400000, revisions: new Map() });
      visible = true; context = owner; busy = false; error = ''; record = null; pending = Promise.resolve(); segmentStart = null; runningWord = null; pollsLeft = 120;
      panel.hidden = false; conceal(true); shell('小挑戰'); panel.append(message('載入原稿…')); footer(close, '← 返回課程'); armExpiry();
      try {
        await store.purge(); current(owner); const pointer = await store.get(scope); current(owner);
        let saved = pointer ? await store.get(pointer.runKey) : null; current(owner, saved);
        if (!saved && joined) {
          const result = await classroom.ownAutomaticAnswer(); current(owner);
          if (result.answer) { const run = A.validateAutomatic(assignment, result.answer.run); saved = { key: scope + ':' + run.runId, expiresAt: joined.expiresAt, kind: 'official', run, receipt: result.answer.receipt }; }
        }
        if (!saved) { const run = A.startLocked(assignment, crypto.randomUUID()); saved = { key: scope + ':' + run.runId, expiresAt: joined?.expiresAt || Date.now() + 86400000, kind: 'official', run }; }
        saved = await store.initialize(scope, saved, () => current(owner, saved)); current(owner, saved); owner.revisions.set(saved.key, saved.revision || 0); record = saved; armExpiry();
        if (saved.run.phase === 'sealed') { drawBoard(); await loadBoard(); }
        else if (saved.run.answers.every(answer => answer.status === 'submitted')) await seal();
        else drawList();
      } catch (problem) { if (owner === context && !problem.stale) { error = problem.message; status(error); const retry = button('重試載入', async () => { await close(); await open(assigned, joined); }); panel.append(retry); } }
    }
    function pause() { if (!visible) return; clock(false); stopBoard(); disposePad(); if (record?.run.phase === 'writing') queueCheckpoint(); }
    function resume() { if (!visible || document.hidden) return; if (page === 'board') loadBoard(); else if (page === 'writing') { if (data) mountPad(); else drawWriting(); } }
    document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); else resume(); });
    root.addEventListener('pagehide', pause); root.addEventListener('pageshow', resume);
    root.addEventListener('beforeunload', event => { if (visible && (error || checkpointing)) { event.preventDefault(); event.returnValue = ''; } });
    return { open, active: () => visible, hasLocal: async () => !!await store.activeLocal(4), async resumeLocal() { const saved = await store.activeLocal(4); if (saved) await open(saved.run.assignment); return !!saved; } };
  }
  root.BishunAssessmentUI = { create };
})(typeof globalThis !== 'undefined' ? globalThis : this);
