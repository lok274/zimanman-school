(function () {
  'use strict';
  const S = globalThis.BishunSession, W = globalThis.BishunWriting, C = globalThis.BishunContent;
  const $ = id => document.getElementById(id);
  const prefix = 'bishun-school:v1:';
  function allCharacterPositions(sourceEntries) { return new Set(sourceEntries.flatMap(entry => entry.characters.map((_, index) => entry.id + ':' + index))); }
  let entries = S.parseEntries(C.words.join('\n')), selected = allCharacterPositions(entries);
  let draftEntries = entries, draftSelected = new Set(selected);
  let curriculumLevel = 0;
  const curriculumPages = [
    { title: '揀年級', label: '二年級', back: '返回首頁' },
    { title: '二年級', label: '2上1', back: '返回年級' },
    { title: '2上1', label: '第一課《爸爸的鬍鬚》', back: '返回課本' },
    { title: '第一課《爸爸的鬍鬚》', back: '返回課文' }
  ];
  let state = null, localMode = null, handle, mountedKey = '', loadingController, storageOkay = true, demoState = 'stopped';
  let feedback = null, feedbackAnimation = null, tone = null;
  let soundEnabled = false, audioContext = null, soundVersion = 0, audioStatus = 'off';
  let simplified = true, instructionText = '', instructionStatus = '', speechKey = '', speechGeneration = 0;
  let readyMount = null, mountGeneration = 0, segment = null, leaving = false, pendingDemoToken = null;
  let clockTick = null;
  let boardNavigationRun = null;
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  let dictation = { phase: Recognition ? 'idle' : 'unsupported', token: 0, recognition: null, timer: null, deadline: 0, message: '' };
  const Q = globalThis.BishunQuizResults;
  const classOrigin = document.body.getAttribute?.('data-classroom-origin') || 'https://zimanman-classroom-1023.lokyau65.chatgpt.site';
  const classroom = globalThis.BishunClassroom?.create({ origin: classOrigin, changed: renderClassroom });
  const dataCache = new Map();
  function available() { return state && !state.resting && !document.hidden && !$('teacher-dialog').open && !leaving; }
  function checkpoint() {
    if (!segment) return;
    const saved = segment; segment = null;
    if (!state || state.active.token !== saved.token || state.active.attemptId !== saved.attemptId) return;
    const elapsedMs = Math.min(Number.MAX_SAFE_INTEGER, saved.baseMs + Math.max(0, performance.now() - saved.openedMono));
    state = S.transition(state, { type: 'DURATION_SNAPSHOT', token: saved.token, elapsedMs });
  }
  function openSegment() {
    if (segment || !available() || state.mode !== 'quiz' || state.active.phase !== 'quiz' || !readyMount || readyMount.generation !== mountGeneration || readyMount.token !== state.active.token) return;
    const attempt = state.attempts.find(item => item.id === state.active.attemptId);
    if (!attempt || attempt.outcome !== 'active' || !Number.isFinite(attempt.elapsedMs)) return;
    segment = { attemptId: attempt.id, token: state.active.token, baseMs: attempt.elapsedMs, openedMono: performance.now() };
    renderClock();
  }
  function renderClock() {
    if (clockTick !== null) clearTimeout(clockTick); clockTick = null;
    const visible = state?.mode === 'quiz' && !['choose-word', 'summary'].includes(state.active.phase);
    $('quiz-clock').hidden = !visible;
    if (!visible) return;
    const measured = state.attempts.filter(item => Number.isFinite(item.elapsedMs));
    let elapsed = measured.reduce((total, item) => total + item.elapsedMs, 0);
    if (segment && segment.token === state.active.token && segment.attemptId === state.active.attemptId) elapsed = Math.min(Number.MAX_SAFE_INTEGER, elapsed + Math.max(0, performance.now() - segment.openedMono));
    const unknown = state.attempts.some(item => item.elapsedMs === null && item.outcome !== 'active');
    const label = measured.length ? (elapsed / 1000).toFixed(1) + ' 秒' + (unknown ? '（部分時間未記錄）' : '') : unknown ? '未有計時資料' : '未開始';
    if ($('quiz-clock-value').textContent !== label) $('quiz-clock-value').textContent = label;
    if (segment && available()) {
      const sessionId = state.id, token = state.active.token, attemptId = state.active.attemptId;
      clockTick = setTimeout(() => { clockTick = null; if (state?.id === sessionId && state.active.token === token && state.active.attemptId === attemptId) renderClock(); }, 100);
    }
  }
  function availabilityChanged() {
    if (document.hidden || leaving || !$('teacher-dialog').open) cancelDictation();
    checkpoint();
    if (!available()) {
      pendingDemoToken = null;
      feedback = null; cancelFeedbackEffects(); stopSpeech();
      if (loadingController) { loadingController.abort(); loadingController = null; mountedKey = ''; mountGeneration++; }
      if (handle && state && state.active.phase !== 'character-complete') { handle.dispose(); handle = null; mountedKey = ''; readyMount = null; mountGeneration++; }
    }
    save(); render(); openSegment();
    if (!state) renderClassroom();
  }
  const concealedText = new Map();
  function restoreRecallText() { concealedText.forEach((text, node) => { node.nodeValue = text; }); concealedText.clear(); }
  function maskRecallText() {
    if (!state || state.active.phase !== 'recall') return;
    if (state.attempts.find(attempt => attempt.id === state.active.attemptId).help.length) return;
    const character = currentOccurrence().character;
    const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (!node.parentElement.closest('script, style, svg, textarea') && node.nodeValue.includes(character)) {
        concealedText.set(node, node.nodeValue); node.nodeValue = node.nodeValue.replaceAll(character, '□');
      }
    }
  }
  function id() { return globalThis.crypto && crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + '-' + Math.random().toString(36).slice(2); }
  function storageError() { storageOkay = false; $('storage-notice').hidden = false; $('storage-notice').textContent = '今次紀錄暫時只留喺畫面，關閉後可能遺失。你仍然可以繼續練習。'; }
  function save() {
    checkpoint();
    if (!state) return;
    try { const raw = JSON.stringify(state); if (raw.length > 1000000) throw new Error('記錄過大'); localStorage.setItem(prefix + state.id, raw); }
    catch (_) { storageError(); }
  }
  function history() {
    const sessions = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key || !key.startsWith(prefix)) continue;
        try { const raw = localStorage.getItem(key); if (!raw || raw.length > 1000000) continue; const value = JSON.parse(raw); if (S.validateSnapshot(value)) sessions.push(value); } catch (_) {}
      }
    } catch (_) { storageError(); }
    return sessions.sort((a, b) => b.startedAt - a.startedAt).slice(0, 40);
  }
  function sessionCandidate(mode = 'practice', sourceEntries = entries, sourceSelected = selected) {
    const assigned = sourceEntries.map(entry => ({ text: entry.text, selectedIndexes: entry.characters.flatMap((_, index) => sourceSelected.has(entry.id + ':' + index) ? [index] : []) })).filter(entry => entry.selectedIndexes.length);
    if (!assigned.length || assigned.length > 6) throw new Error('今節請揀 1 至 6 項詞語入面嘅字。');
    return S.createSession({ id: id(), entries: assigned, startedAt: Date.now(), mode });
  }
  function localGroups() {
    const eligible = entries.filter(entry => entry.characters.some((_, index) => selected.has(entry.id + ':' + index)));
    const middle = Math.ceil(eligible.length / 2);
    return [eligible.slice(0, middle), eligible.slice(middle)];
  }
  function startSession(candidate = sessionCandidate()) {
    cancelDictation();
    stopEffects();
    boardNavigationRun = null;
    feedback = null;
    state = candidate;
    try { sessionStorage.setItem(prefix + 'current', state.id); } catch (_) {}
    save(); render();
  }
  function stopSpeech() { speechGeneration++; instructionStatus = ''; $('instruction-voice-note').textContent = ''; try { if ('speechSynthesis' in window) speechSynthesis.cancel(); } catch (_) {} }
  function goHome() {
    cancelDictation();
    if (state && state.active.phase !== 'summary') dispatch({ type: 'END_SESSION' });
    else save();
    stopEffects();
    if (state) { try { sessionStorage.removeItem(prefix + 'current'); } catch (_) {} }
    state = null; localMode = null; curriculumLevel = 0; feedback = null; boardNavigationRun = null;
    render();
  }
  function showGroups(mode, level = 0) { goHome(); localMode = mode; curriculumLevel = level; render(); }
  function stopEffects() { pendingDemoToken = null; checkpoint(); readyMount = null; mountGeneration++; if (handle) handle.dispose(); handle = null; mountedKey = ''; if (loadingController) loadingController.abort(); loadingController = null; stopSpeech(); cancelFeedbackEffects(); }
  function dispatch(event) {
    checkpoint();
    const before = state;
    const next = S.transition(state, { at: Date.now(), ...event });
    if (next === state) { openSegment(); return false; }
    state = next;
    if (pendingDemoToken !== state.active.token || !['loading', 'watch'].includes(state.active.phase)) pendingDemoToken = null;
    cancelFeedbackEffects(); feedback = feedbackFor(before, next, event); save(); render(); openSegment();
    if (feedback && feedback.celebrate) celebrateFeedback();
    return true;
  }
  function concealedCharacter(snapshot) {
    if (!snapshot || snapshot.active.phase !== 'recall') return '';
    const attempt = snapshot.attempts.find(item => item.id === snapshot.active.attemptId);
    return attempt.help.length ? '' : snapshot.occurrences.find(item => item.id === snapshot.active.occurrenceId).character;
  }
  function safeText(variants, snapshot = state) { const target = concealedCharacter(snapshot); return variants.find(text => !target || !text.includes(target)); }
  function feedbackFor(before, next, event) {
    const make = (kind, icon, variants, celebrate = false) => ({ kind, icon, text: safeText(variants, next), celebrate });
    if (next.mode === 'quiz') {
      if (event.type === 'STROKE_MISSED') return make('quiz-miss', '', ['再試呢一畫。']);
      if (event.type === 'WRITING_COMPLETE') return make('quiz-complete', '', ['測驗完成'], true);
      return null;
    }
    const n = next.active.currentStroke;
    switch (event.type) {
      case 'STROKE_ACCEPTED': return before.active.missesOnCurrentStroke
        ? make('recovered', '✓', ['你再試成功咗！', '再試後，完成第 ' + n + ' 畫！', '重試嗰筆已寫好，進度 ' + n + '。', '再做成功，已到 ' + n + '。'])
        : make('step', '✓', [...(n === 1 ? ['你開始咗，第一畫完成！'] : []), '完成第 ' + n + ' 畫！', '呢筆已寫好，進度 ' + n + '。', '做到第 ' + n + ' 步。']);
      case 'STROKE_MISSED': return make('support', '↻', ['再試呢一畫。', '慢慢再試，需要提示都可以。', '由起點落筆，或者請老師幫手。', '停低諗吓，想求助就撳掣。']);
      case 'REQUEST_HELP': return make('support', '•', [...(event.kind === 'stroke' && next.active.missesOnCurrentStroke ? ['睇完呢一畫，再試。'] : []), '提示已開，可以繼續寫。', '睇住幫手，再試吓。', '有需要就求助，慢慢嚟。']);
      case 'RETRY': return make('support', '↻', ['重新試，由起點開始。', '可以再寫，之前嘅紀錄會保留。', '今趟慢慢做，隨時求助。']);
      case 'RESUME': return make('support', '•', ['休息完，可以接住寫。', '返嚟喇，由而家呢筆繼續。', '準備好就再試，隨時求助。']);
      case 'WRITING_COMPLETE': {
        const attempt = next.attempts.find(item => item.id === next.active.attemptId);
        if (before.active.phase === 'guided') return make('complete-guided', '✓', ['跟寫完成。下一步由你決定。'], true);
        return attempt.help.length
          ? make('complete-assisted', '✓', ['有提示完成。你完成咗今次書寫。'], true)
          : make('complete-independent', '✓', ['自己完成。今次冇開提示。'], true);
      }
      default: return null;
    }
  }
  function cancelFeedbackEffects() {
    if (feedbackAnimation) feedbackAnimation.cancel(); feedbackAnimation = null;
    if (tone) { const activeTone = tone; tone = null; activeTone.oscillator.onended = null; try { activeTone.oscillator.stop(); } catch (_) {} activeTone.oscillator.disconnect(); activeTone.gain.disconnect(); }
  }
  function renderSound() {
    const labels = soundEnabled ? ['完成提示聲：開', '音效已啟用', '有聲慶祝'] : ['完成提示聲：關', '靜音', '不播放聲效'];
    const notes = audioStatus === 'blocked' ? ['裝置未能播放，畫面回饋照常。', '聲效暫時用唔到，仍可繼續寫。', '可以安靜練習，圖示會保留。']
      : audioStatus === 'preparing' ? ['聲效準備中，畫面回饋照常。', '等裝置開啟音效，仍可繼續寫。', '暫時安靜練習，圖示會保留。']
      : ['寫好一個字，先有短聲。', '做妥今次書寫才響起。', '達成後播放提示。'];
    const label = safeText(labels), note = safeText(notes);
    if ($('feedback-sound').textContent !== label) $('feedback-sound').textContent = label;
    $('feedback-sound').setAttribute('aria-pressed', String(soundEnabled));
    if ($('feedback-sound-note').textContent !== note) $('feedback-sound-note').textContent = note;
  }
  function updateSound() { restoreRecallText(); renderSound(); maskRecallText(); }
  function celebrateFeedback() {
    if (document.hidden || state.resting || $('teacher-dialog').open) return;
    const icon = $('feedback-icon');
    if (icon.animate && !(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)) feedbackAnimation = icon.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.18)' }, { transform: 'scale(1)' }], { duration: 450, iterations: 1 });
    if (!soundEnabled || audioStatus !== 'ready' || !audioContext || audioContext.state !== 'running') return;
    try {
      const oscillator = audioContext.createOscillator(), gain = audioContext.createGain(), now = audioContext.currentTime;
      tone = { oscillator, gain }; oscillator.type = 'sine'; oscillator.frequency.setValueAtTime(660, now);
      gain.gain.setValueAtTime(0, now); gain.gain.linearRampToValueAtTime(0.035, now + 0.025); gain.gain.linearRampToValueAtTime(0, now + 0.2);
      oscillator.connect(gain); gain.connect(audioContext.destination);
      oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); if (tone && tone.oscillator === oscillator) tone = null; };
      oscillator.start(now); oscillator.stop(now + 0.21);
    } catch (_) { cancelFeedbackEffects(); soundEnabled = false; audioStatus = 'blocked'; updateSound(); }
  }
  $('feedback-sound').addEventListener('click', () => {
    const version = ++soundVersion; soundEnabled = !soundEnabled; cancelFeedbackEffects();
    if (!soundEnabled) { audioStatus = 'off'; updateSound(); return; }
    audioStatus = 'preparing'; updateSound();
    try {
      const Audio = window.AudioContext || window.webkitAudioContext;
      if (!Audio) throw new Error('Audio unavailable');
      if (!audioContext) audioContext = new Audio();
      Promise.resolve(audioContext.resume()).then(() => {
        if (version !== soundVersion) return;
        audioStatus = audioContext.state === 'running' ? 'ready' : 'blocked'; soundEnabled = audioStatus === 'ready'; updateSound();
      }).catch(() => { if (version === soundVersion) { soundEnabled = false; audioStatus = 'blocked'; updateSound(); } });
    } catch (_) { soundEnabled = false; audioStatus = 'blocked'; updateSound(); }
  });
  function currentOccurrence() { return state && state.occurrences.find(item => item.id === state.active.occurrenceId); }
  function currentWord() { const o = currentOccurrence(); return o && state.entries.find(item => item.id === o.wordId); }
  function event(type, extra) { if (!state) return false; return dispatch({ type, token: state.active.token, newToken: id(), ...extra }); }
  function svgCue(text) { const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 64 64'); svg.setAttribute('aria-hidden', 'true'); const p = document.createElementNS(svg.namespaceURI, 'path'); p.setAttribute('d', C.cue(text)[1]); svg.append(p); return svg; }
  function visualCue(text) {
    if (!C.photos || !C.photos[text]) return svgCue(text);
    const image = document.createElement('img'); image.className = 'word-photo'; image.setAttribute('src', C.photos[text]); image.setAttribute('alt', '');
    image.addEventListener('error', () => image.replaceWith(svgCue(text)), { once: true });
    return image;
  }
  function textNode(tag, text, className) { const element = document.createElement(tag); element.textContent = text; if (className) element.className = className; return element; }
  function renderWordLabel(element, word, index) {
    const characters = Array.from(word.text);
    element.replaceChildren(); element.style.setProperty('--word-length', characters.length);
    characters.forEach((character, position) => {
      const span = textNode('span', character, 'word-character');
      if (position === index) { span.classList.toggle('current-character', true); span.setAttribute('aria-current', 'true'); span.setAttribute('aria-description', (index + 1) + ' / ' + characters.length); }
      element.append(span);
    });
  }
  function renderGroups() {
    const label = localMode === 'quiz' ? '測驗' : '練習';
    const page = curriculumPages[curriculumLevel];
    $('group-title').textContent = page ? page.title : label;
    $('group-home').textContent = page ? page.back : '返回首頁';
    $('group-cards').classList.toggle('curriculum-cards', !!page?.label);
    const container = $('group-cards'); container.replaceChildren();
    if (page?.label) {
      const button = document.createElement('button'); button.className = 'mode-card';
      button.append(textNode('strong', page.label));
      button.addEventListener('click', () => { curriculumLevel++; render(); });
      container.append(button); return;
    }
    localGroups().forEach((group, index) => {
      const button = document.createElement('button'); button.className = 'mode-card'; button.disabled = !group.length;
      button.append(textNode('strong', label + (index + 1)), textNode('span', group.map(word => word.text).join('、')));
      button.addEventListener('click', () => startSession(sessionCandidate(localMode, group, selected))); container.append(button);
    });
  }
  function renderChoices() {
    $('choose-title').textContent = state.mode === 'quiz' ? '測驗：想先寫邊個字？' : '練習：想先寫邊個字？';
    const container = $('word-cards'); container.replaceChildren();
    const rows = S.summarize(state);
    state.entries.forEach(word => {
      const assigned = state.occurrences.filter(o => o.wordId === word.id);
      const target = assigned.find(o => !state.finished.includes(o.id)) || assigned.at(-1);
      const done = assigned.every(o => state.finished.includes(o.id));
      const pending = done && rows.some(row => row.wordId === word.id && !row.independent && !row.assisted);
      const button = document.createElement('button'); button.className = 'word-card'; button.disabled = done;
      const content = textNode('span', '', 'word-name'); renderWordLabel(content, word, target.index);
      button.append(content, visualCue(word.text));
      if (done) button.append(textNode('span', pending ? '有字待練' : '完成今次練習', 'stamp'));
      button.addEventListener('click', () => event('CHOOSE_WORD', { wordId: word.id })); container.append(button);
    });
    $('choice-summary').textContent = localMode ? '返回揀組別' : '返回首頁';
  }
  function render() {
    document.body.classList.toggle('has-demo-navigation', false);
    $('demo-navigation').hidden = true;
    $('practice-stars').hidden = true;
    restoreRecallText();
    document.querySelector('.brand').setAttribute('aria-label', safeText(['寫字樂首頁', '返回主頁', '回到開始']));
    renderSound();
    renderWordVoiceLabel();
    renderClock();
    $('home-view').hidden = !!state || !!localMode;
    $('group-view').hidden = !!state || !localMode;
    document.body.classList.toggle('quiz-mode', !!state && state.mode === 'quiz');
    if (!state) {
      if (localMode) renderGroups();
      $('choose-view').hidden = true; $('practice-view').hidden = true; $('summary-view').hidden = true; $('previous-step').hidden = true;
      document.body.classList.toggle('has-recall', false); renderPresentation(); return;
    }
    const a = state.active, choose = a.phase === 'choose-word', summary = a.phase === 'summary';
    $('choose-view').hidden = !choose; $('practice-view').hidden = choose || summary; $('summary-view').hidden = !summary;
    $('previous-step').hidden = choose || summary;
    $('previous-step').textContent = state.mode === 'quiz' ? '← 返回選字' : safeText(a.phase === 'character-complete' && !a.strokeCount ? ['← 再載入'] : ['recall', 'character-complete'].includes(a.phase) ? ['← 返回跟寫', '← 睇提示', '← 上一步'] : a.phase === 'guided' ? ['← 返回睇筆順'] : ['← 返回選字']);
    document.body.classList.toggle('has-recall', a.phase === 'recall');
    renderPresentation();
    $('practice-tools-label').textContent = safeText(['更多工具', '其他選項', '開啟功能']);
    if (choose || summary) { if (handle || loadingController) stopEffects(); else stopSpeech(); speechKey = ''; if (choose) renderChoices(); else { renderSummary(state); renderQuizResults(); } return; }
    const word = currentWord();
    const stars = state.mode === 'practice' ? S.summarize(state).filter(row => row.guided || row.independent || row.assisted).length : 0;
    $('practice-stars').hidden = !stars;
    const starText = '★ ' + stars, starLabel = safeText(['完成星 ' + stars, '練習達成 ' + stars, '★ ' + stars]);
    if ($('practice-stars').textContent !== starText) $('practice-stars').textContent = starText;
    if ($('practice-stars').getAttribute('aria-label') !== starLabel) $('practice-stars').setAttribute('aria-label', starLabel);
    const quiz = state.mode === 'quiz', recall = a.phase === 'recall', complete = a.phase === 'character-complete';
    const quizComplete = quiz && complete && a.completedPhase === 'quiz';
    if (recall) $('word-title').textContent = '詞語收埋咗'; else renderWordLabel($('word-title'), word, currentOccurrence().index);
    $('word-title').classList.toggle('concealed', recall);
    $('semantic-cue').replaceChildren(visualCue(word.text));
    document.querySelector('.step-rail').hidden = quiz;
    $('writer').setAttribute('aria-label', quiz ? '測驗書寫格，沒有筆畫提示' : recall ? '無字形提示嘅書寫格' : '書寫練習格');
    const stage = complete ? 'recall' : a.phase;
    const stageIndex = ['watch', 'guided', 'recall'].indexOf(stage);
    document.querySelectorAll('[data-stage]').forEach((element, index) => { element.classList.toggle('active', index === stageIndex); element.classList.toggle('done', index < stageIndex); if (index === stageIndex) element.setAttribute('aria-current', 'step'); else element.removeAttribute('aria-current'); });
    $('demo-controls').hidden = a.phase !== 'watch'; $('extra-demo-controls').hidden = a.phase !== 'watch';
    const assigned = state.occurrences.filter(item => item.wordId === word.id);
    const position = assigned.findIndex(item => item.id === a.occurrenceId);
    const browse = !quiz && a.phase === 'watch' && !state.resting && assigned.length > 1;
    $('demo-navigation').hidden = !browse;
    document.body.classList.toggle('has-demo-navigation', browse);
    for (const [button, direction, label] of [['demo-previous', -1, '上一字：'], ['demo-next', 1, '下一字：']]) {
      const target = assigned[position + direction];
      $(button).hidden = !browse || !target;
      $(button).textContent = target ? label + target.character : '';
    }
    $('writing-controls').hidden = !['guided', 'recall'].includes(a.phase) || a.writingDone;
    $('extra-writing-controls').hidden = !['guided', 'recall', 'quiz'].includes(a.phase) && !(complete && ['recall', 'quiz'].includes(a.completedPhase));
    $('hint-stroke').textContent = safeText(a.missesOnCurrentStroke ? ['睇一畫再試', '看提示後重做', '求助'] : ['睇呢一畫', '看提示', '求助']);
    $('hint-stroke').hidden = quiz || a.writingDone || complete; $('hint-outline').hidden = quiz || a.writingDone || complete;
    $('data-controls').hidden = a.phase !== 'unavailable';
    $('main-next').hidden = ['loading', 'unavailable'].includes(a.phase) || (['guided', 'recall', 'quiz'].includes(a.phase) && !a.writingDone);
    $('next-row').hidden = $('main-next').hidden;
    $('stroke-progress').textContent = a.strokeCount && ['guided', 'recall'].includes(a.phase) ? '已寫 ' + a.currentStroke + ' / ' + a.strokeCount + ' 畫' : a.strokeCount && a.phase === 'watch' ? '共 ' + a.strokeCount + ' 畫' : '';
    const attempt = state.attempts.find(item => item.id === a.attemptId);
    let title = '', instruction = '', defaultFeedback = '';
    if (a.phase === 'loading') { title = '準備好書寫格'; instruction = safeText(['等一等，整理緊筆順。', '稍候，資料準備中。', '就嚟可以開始。']); }
    if (a.phase === 'unavailable') { title = '呢個字暫時未準備好'; instruction = safeText(['可以再載入，或者請老師幫手。', '資料未準備好，稍後再試。', '想求助就撳老師工具。']); }
    if (a.phase === 'watch') { title = safeText(['睇筆順', '看示範', '觀察']); instruction = safeText(['撳播放，睇筆順。', '眼睛跟住每一畫。', '先觀察示範。']); defaultFeedback = '可以暫停，亦可以一畫一畫睇。'; $('main-next').textContent = '到我跟住寫 →'; }
    if (a.phase === 'guided') { title = a.writingDone ? '完成引導練習' : safeText(['跟住寫', '照樣做', '練習']); instruction = safeText(a.writingDone ? ['準備好，就自己試。', '可以收起字形再寫。', '下一步由你決定。'] : ['先寫一畫。', '由橙點開始寫。', '手指跟住起筆提示。', '順住方向慢慢做。']); defaultFeedback = a.writingDone ? '跟寫完成。下一步由你決定。' : a.missesOnCurrentStroke ? '再慢慢試。需要幫手都可以。' : '由起點開始，慢慢寫。'; $('main-next').textContent = '收起字形，自己試 →'; }
    if (a.phase === 'quiz') { title = '測驗'; instruction = '照住題目，自己寫。'; defaultFeedback = '寫錯可以再試。'; }
    if (a.phase === 'recall') { title = safeText(['自己試', '試住記', '憑記憶']); instruction = safeText(['先想一想，再落筆。', '按記憶寫，需要就開提示。', '慢慢做，隨時可以求助。']); defaultFeedback = attempt.help.length ? '已記低用過提示，放心繼續寫。' : a.missesOnCurrentStroke ? '再試一次，或者開提示幫手。' : '用自己記住嘅筆順寫。'; }
    if (complete) {
      const label = a.completedPhase === 'skipped' ? '老師協助跳過' : attempt && attempt.help.length ? '有提示完成' : '自己完成';
      title = quizComplete ? '測驗完成' : label; instruction = quizComplete ? '' : a.completedPhase === 'skipped' ? '今次先放低，之後再一齊試。' : '準備好，先行下一步。'; defaultFeedback = '每一次嘅嘗試都保留喺紀錄。';
      const remaining = state.occurrences.filter(item => !state.finished.includes(item.id));
      $('main-next').textContent = !remaining.length ? '睇今次紀錄 →' : remaining.some(item => item.wordId === word.id) ? '下一個字 →' : '揀下一個字 →';
      if (!remaining.length && classroom?.view().boundRunId === state.id) $('main-next').textContent = '完成測驗 →';
    }
    $('practice-title').textContent = title; $('practice-instruction').textContent = instruction;
    const practiceCue = !quiz && ['guided', 'recall', 'character-complete'].includes(a.phase);
    const eventCue = practiceCue && !!feedback;
    $('practice-instruction').hidden = quizComplete || eventCue || ['watch', 'quiz'].includes(a.phase);
    $('feedback').hidden = practiceCue && !eventCue;
    $('feedback').classList.toggle('sr-only', quizComplete);
    $('hear-instruction').setAttribute('aria-describedby', quizComplete ? 'main-next' : eventCue ? 'feedback-text' : 'practice-instruction');
    const nextInstruction = quizComplete ? $('main-next').textContent.replace(/ →$/, '') : eventCue ? feedback.text : instruction;
    const nextSpeechKey = [state.id, a.token, a.phase, a.writingDone, state.resting, instruction].join(':');
    if (nextSpeechKey !== speechKey || instructionStatus && instructionText !== nextInstruction) { stopSpeech(); speechKey = nextSpeechKey; }
    instructionText = nextInstruction;
    renderInstructionVoice();
    const message = quizComplete ? '測驗完成' : feedback ? feedback.text : defaultFeedback;
    if ($('feedback-text').textContent !== message) $('feedback-text').textContent = message;
    const icon = !quizComplete && feedback ? feedback.icon : '';
    if ($('feedback-icon').textContent !== icon) $('feedback-icon').textContent = icon;
    if ($('feedback-icon').hidden !== !icon) $('feedback-icon').hidden = !icon;
    $('feedback').setAttribute('data-kind', quizComplete ? 'quiz-complete' : feedback ? feedback.kind : 'instruction');
    if (!quiz || a.completedPhase !== 'quiz') $('quiz-mark').setAttribute('hidden', '');
    else $('quiz-mark').removeAttribute('hidden');
    $('board-message').hidden = !['loading', 'unavailable'].includes(a.phase);
    $('board-message').textContent = a.phase === 'loading' ? '整理緊筆順…' : '未能載入字形\n請再試，或者請老師幫手。';
    $('play').textContent = demoState === 'paused' ? '▶ 繼續播放' : '▶ 播放';
    $('pause').disabled = demoState !== 'playing';
    if (available()) syncWriter();
    maskRecallText();
  }
  function syncWriter() {
    const a = state.active;
    const key = a.token + ':' + a.phase;
    if (mountedKey === key) return;
    if (a.phase === 'character-complete' && handle && mountedKey.startsWith(a.token + ':')) { mountedKey = key; return; }
    if (handle) handle.dispose(); handle = null; readyMount = null;
    const generation = ++mountGeneration;
    if (loadingController) loadingController.abort(); loadingController = null;
    mountedKey = key; demoState = 'stopped';
    if (a.phase === 'loading') {
      const occurrence = currentOccurrence(), token = a.token; loadingController = new AbortController(); const controller = loadingController;
      const timer = setTimeout(() => controller.abort(), 12000);
      Promise.resolve().then(() => dataCache.get(occurrence.character) || W.loadCharacter(occurrence.character, controller.signal)).then(data => {
        if (!state || generation !== mountGeneration || state.active.token !== token || state.active.phase !== 'loading') return;
        dataCache.set(occurrence.character, data); dispatch({ type: 'DATA_READY', token, newToken: id(), strokeCount: data.strokes.length });
      }).catch(() => { if (state && generation === mountGeneration && state.active.token === token && state.active.phase === 'loading') dispatch({ type: 'DATA_FAILED', token }); }).finally(() => clearTimeout(timer));
      return;
    }
    if (!['watch', 'guided', 'recall', 'quiz'].includes(a.phase) || a.writingDone) return;
    const occurrence = currentOccurrence(), data = dataCache.get(occurrence.character);
    if (!data || !globalThis.HanziWriter) { dispatch({ type: 'MOUNT_FAILED', token: a.token }); return; }
    try { handle = W.mount($('writer'), occurrence.character, data, { token: a.token, phase: a.phase, currentStroke: a.currentStroke || 0, help: (state.attempts.find(item => item.id === a.attemptId) || { help: [] }).help,
      onReady: () => {
        if (!state || generation !== mountGeneration || state.active.token !== a.token || !available()) return;
        readyMount = { generation, token: a.token };
        if (pendingDemoToken === a.token) Promise.resolve().then(() => {
          if (pendingDemoToken !== a.token || !available() || generation !== mountGeneration || state.active.token !== a.token || state.active.phase !== 'watch') return;
          pendingDemoToken = null; handle.play(false);
        });
        if (state.mode === 'quiz') {
          const attempt = state.attempts.find(item => item.id === state.active.attemptId);
          if (attempt && attempt.elapsedMs === null) state = S.transition(state, { type: 'DURATION_SNAPSHOT', token: a.token, elapsedMs: 0 });
          save(); openSegment();
        }
      },
      onError: () => { if (state && generation === mountGeneration && state.active.token === a.token) dispatch({ type: 'MOUNT_FAILED', token: a.token }); },
      onCharacterDemoComplete: () => {
        if (!available() || generation !== mountGeneration || state.active.token !== a.token || state.mode !== 'practice' || state.active.phase !== 'watch') return;
        const newToken = id();
        pendingDemoToken = newToken;
        if (!event('BROWSE_DEMO', { direction: 1, newToken })) pendingDemoToken = null;
      },
      onDemoState: value => { if (!state || generation !== mountGeneration || state.active.token !== a.token) return; demoState = value; $('pause').disabled = value !== 'playing'; $('play').textContent = value === 'paused' ? '▶ 繼續播放' : '▶ 播放'; },
      onEvent: incoming => {
        if (!available() || generation !== mountGeneration || !state || state.active.token !== a.token) return;
        if (!dispatch(incoming)) return;
        if (state.mode !== 'quiz' && incoming.type === 'STROKE_MISSED' && state.active.missesOnCurrentStroke >= 2) {
          const attempt = state.attempts.find(item => item.id === state.active.attemptId);
          if (!attempt.help.some(help => help.kind === 'stroke' && help.strokeIndex === state.active.currentStroke)) requestHelp('stroke');
        }
      }
    }); } catch (_) { dispatch({ type: 'MOUNT_FAILED', token: a.token }); }
  }
  function requestHelp(kind) {
    if (!state || state.mode === 'quiz') return false;
    const token = state.active.token;
    if (dispatch({ type: 'REQUEST_HELP', token, kind })) { if (handle) handle.showHelp(kind); return true; }
    return false;
  }
  function renderSummary(snapshot) {
    $('summary-title').textContent = snapshot.mode === 'quiz' ? '今次測驗完成紀錄' : '每一步，都記低咗。';
    const rows = S.summarize(snapshot), stats = $('summary-stats'); stats.replaceChildren();
    const groups = [['自己完成', rows.filter(r => r.independent).length], ['有提示完成', rows.filter(r => r.assisted && !r.independent).length], ['老師協助跳過', rows.filter(r => r.skipped && !r.independent && !r.assisted).length], ['待練字次', rows.filter(r => r.unfinished).length]];
    groups.forEach(([label, n]) => { const div = textNode('div', '', 'stat'); div.append(textNode('b', String(n)), textNode('span', label)); stats.append(div); });
    const list = $('summary-rows'); list.replaceChildren();
    snapshot.entries.forEach(word => {
      const div = textNode('div', '', 'summary-row'), detail = document.createElement('div'); div.append(textNode('div', word.text, 'summary-word'), detail);
      rows.filter(row => row.wordId === word.id).forEach(row => {
        const line = textNode('div', '', 'char-record'), text = document.createElement('span');
        const label = row.independent ? '自己完成' : row.assisted ? '有提示完成' : row.skipped ? '老師協助跳過' : row.guided ? '完成引導練習 · 自己試待練' : '待練';
        text.append(textNode('span', '第 ' + (row.index + 1) + ' 字 · ' + label, 'record-label'));
        const attempts = row.attempts.map((attempt, index) => {
          const phase = attempt.phase === 'quiz' ? '測驗' : attempt.phase === 'guided' ? '引導' : attempt.phase === 'recall' ? '自己試' : '老師';
          const outcome = attempt.outcome === 'complete' ? attempt.phase === 'recall' && !attempt.help.length ? '無提示完成' : '完成' : attempt.outcome === 'skipped' ? '協助跳過' : attempt.outcome === 'abandoned' ? '未完成／重新試' : '未完成';
          return (index + 1) + '. ' + phase + outcome + (attempt.help.length ? '，提示 ' + attempt.help.length + ' 次' : '');
        }).join('；');
        text.append(textNode('span', attempts || '今節尚未練習', 'attempt-detail')); line.append(textNode('strong', row.character), text); detail.append(line);
      }); list.append(div);
    });
    $('saved-message').textContent = storageOkay ? '紀錄只儲存喺呢個瀏覽器。無需帳戶。' : '紀錄未能儲存。離開前可請老師記低結果。';
  }
  function scoreLabel(score) { return '錯誤 ' + score.mistakes + ' 次 · ' + (score.elapsedMs / 1000).toFixed(1) + ' 秒'; }
  function renderClassroom() {
    if (!classroom) return;
    const view = classroom.view(), member = view.member;
    $('class-join-fields').hidden = !!member;
    $('class-join').disabled = view.busy;
    $('class-identity').textContent = member ? '班級 ' + member.code + ' · ' + member.alias : '';
    $('class-status').textContent = view.message;
    $('class-storage').hidden = view.storageOkay;
    $('class-continue').hidden = !view.needsContinue;
    $('class-start').hidden = !view.accepted || view.pending;
    $('class-start').disabled = view.busy;
    $('class-pending-retry').hidden = !view.accepted || !view.pending;
    $('class-pending-retry').disabled = view.busy;
    $('class-leave').hidden = !member;
    $('class-leave').textContent = view.pending ? '換下一位（未交紀錄會清除）' : '換下一位同學';
    $('class-switch-note').hidden = !member;
    $('class-dialog-board-link').hidden = !view.accepted || !view.receipt;
    const classSummary = state?.active.phase === 'summary' && view.boundRunId === state.id;
    $('class-result-status').textContent = classSummary ? view.message + (!view.storageOkay ? ' 此頁未能保存待交紀錄，請勿關閉。' : '') : '';
    $('class-retry').hidden = !classSummary || !view.pending;
    $('class-retry').disabled = view.busy;
    $('class-board-link').hidden = !classSummary || !view.receipt;
    $('class-again').hidden = !classSummary || !view.accepted || view.pending;
    $('class-again').disabled = view.busy;
    if (classSummary) { $('personal-best').textContent = member.alias + ' · 個人最佳及全班排名會喺排行榜頁顯示。'; $('saved-message').textContent = '本機紀錄留喺此瀏覽器；班級交卷成功後，暱稱和結果亦會儲存喺班級服務。'; }
    const homeRetry = !state && boardNavigationRun !== null && boardNavigationRun === view.boundRunId;
    if ((classSummary ? available() && !$('class-dialog').open : homeRetry && !document.hidden && !$('teacher-dialog').open && !leaving) && view.accepted && view.receipt?.runId === view.boundRunId && boardNavigationRun === view.receipt.runId) {
      boardNavigationRun = null;
      try {
        if (!view.storageOkay) throw new Error('身份未能保存。');
        sessionStorage.setItem('bishun:board-handoff', JSON.stringify({ memberId: member.memberId, runId: view.receipt.runId, at: Date.now() }));
        window.location.assign('leaderboard.html');
        if (homeRetry && $('class-dialog').open) $('class-dialog').close();
      } catch { $(homeRetry ? 'class-status' : 'class-result-status').textContent = '已交卷，但此頁未能保存參加身份，暫時無法轉去排行榜。'; }
    }
  }
  function renderQuizResults() {
    $('quiz-results').hidden = state.mode !== 'quiz';
    if (state.mode !== 'quiz' || !Q) return;
    const result = Q.fromSession(state);
    $('quiz-result-score').textContent = result?.ranked ? scoreLabel(result.score) : result?.terminal ? '今次有跳過或未有計時資料，不列入排名。' : '今次未完成全部題目，不列入排名。';
    const view = classroom?.view();
    if (view?.accepted && view.boundRunId === state.id) {
      if (!view.receipt) boardNavigationRun = state.id;
      classroom.finish(result); renderClassroom(); return;
    }
    const assigned = JSON.stringify(Q.assignment(Q.entriesFromSession(state)));
    const scores = history().flatMap(snapshot => {
      try {
        if (snapshot.mode !== 'quiz' || snapshot.active.phase !== 'summary' || JSON.stringify(Q.assignment(Q.entriesFromSession(snapshot))) !== assigned) return [];
        const result = Q.fromSession(snapshot); return result?.ranked ? [result.score] : [];
      } catch { return []; }
    }).sort(Q.compare);
    $('personal-best').textContent = scores.length ? '此瀏覽器最佳（最近 40 筆、相同題目）：' + scoreLabel(scores[0]) + '。共用平板未能分辨同學。' : '此瀏覽器未有相同題目嘅完整最佳紀錄。';
    renderClassroom();
  }
  function startClassQuiz() {
    try {
      const member = classroom.view().member;
      const candidate = S.createSession({ id: id(), entries: member.assignment.entries, startedAt: Date.now(), mode: 'quiz' });
      classroom.bindRun(candidate.id); localMode = null; $('class-dialog').close(); startSession(candidate);
    } catch (error) { $('class-status').textContent = error.message; }
  }
  $('class-open').addEventListener('click', () => { renderClassroom(); $('class-dialog').showModal(); });
  $('class-close').addEventListener('click', () => $('class-dialog').close());
  $('class-dialog').addEventListener('close', renderClassroom);
  $('class-join').addEventListener('click', () => classroom?.join($('class-code').value || '', $('class-alias').value || ''));
  $('class-continue').addEventListener('click', () => classroom?.continueMember());
  $('class-leave').addEventListener('click', () => { boardNavigationRun = null; classroom?.leave(); $('class-alias').value = ''; $('class-code').value = ''; });
  $('class-start').addEventListener('click', startClassQuiz); $('class-again').addEventListener('click', startClassQuiz);
  function retryClassResult() { boardNavigationRun = classroom?.view().boundRunId; classroom?.retry(); }
  $('class-retry').addEventListener('click', retryClassResult); $('class-pending-retry').addEventListener('click', retryClassResult);
  $('teacher-class').addEventListener('click', () => {
    cancelDictation();
    try {
      const parsed = S.parseEntries($('teacher-words').value);
      if (parsed.map(e => e.text).join('\n') !== draftEntries.map(e => e.text).join('\n')) throw new Error('詞語有改動，請先更新可選詞語。');
      const candidate = sessionCandidate('quiz', draftEntries, draftSelected);
      window.open(classOrigin + '/teacher#' + encodeURIComponent(JSON.stringify(Q.assignment(Q.entriesFromSession(candidate)))), '_blank', 'noopener,noreferrer');
    } catch (error) { $('teacher-error').textContent = error.message; }
  });
  function selectedOptions() {
    const div = $('teacher-word-options'); div.replaceChildren();
    draftEntries.forEach(entry => {
      const group = document.createElement('fieldset'); group.className = 'character-options'; group.append(textNode('legend', entry.text));
      entry.characters.forEach((character, index) => {
        const key = entry.id + ':' + index, label = textNode('label', '', 'word-option'), checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = draftSelected.has(key); checkbox.value = key;
        checkbox.addEventListener('change', () => { if (checkbox.checked) draftSelected.add(key); else draftSelected.delete(key); renderSelectionTotal(); });
        label.append(checkbox, document.createTextNode('第 ' + (index + 1) + ' 字「' + character + '」')); group.append(label);
      }); div.append(group);
    });
    renderSelectionTotal();
  }
  function renderSelectionTotal() { $('teacher-selection-total').textContent = '已揀 ' + draftSelected.size + ' 個字 · ' + draftEntries.filter(entry => entry.characters.some((_, index) => draftSelected.has(entry.id + ':' + index))).length + ' 項詞語'; }
  const dictationFallback = '可直接打字或用鍵盤語音輸入。';
  function renderDictation() {
    const active = ['starting', 'listening', 'finishing'].includes(dictation.phase);
    $('dictation-start').disabled = active || dictation.phase === 'review' || dictation.phase === 'unsupported';
    $('dictation-start').textContent = ({ starting: '準備收音…', listening: '聆聽中', finishing: '處理中…' })[dictation.phase] || '粵語輸入';
    $('dictation-stop').hidden = !active;
    $('dictation-stop').disabled = dictation.phase === 'finishing';
    $('dictation-review').hidden = dictation.phase !== 'review';
    $('dictation-status').textContent = dictation.phase === 'unsupported' ? '此瀏覽器未提供語音輸入。' + dictationFallback : dictation.message;
    $('dictation-status').hidden = !$('dictation-status').textContent;
  }
  function cancelDictation(phase = Recognition ? 'idle' : 'unsupported', message = '') {
    const previous = dictation;
    dictation = { phase, token: previous.token + 1, recognition: null, timer: null, deadline: 0, message };
    clearTimeout(previous.timer);
    $('dictation-pending').value = '';
    renderDictation();
    try { previous.recognition?.abort(); } catch (_) {}
  }
  function dictationFailed(error) {
    const messages = { 'not-allowed': '未獲准用咪。', 'service-not-allowed': '未獲准使用語音服務。', 'audio-capture': '未能使用咪。', network: '語音服務連線失敗。', 'language-not-supported': '語音服務未支援粵語。', 'no-speech': '未聽到詞語。', timeout: '收音已逾時並停止。' };
    cancelDictation('error', (messages[error] || '未能使用語音輸入。') + dictationFallback);
  }
  function startDictation() {
    if (!Recognition || !['idle', 'error'].includes(dictation.phase) || !$('teacher-dialog').open || document.hidden || leaving) return;
    stopSpeech();
    cancelDictation();
    try {
      const recognition = new Recognition(), token = dictation.token;
      dictation = { phase: 'starting', token, recognition, timer: null, deadline: performance.now() + 20000, message: '請講一項詞語，完成後先確認加入。' };
      const current = () => dictation.token === token && dictation.recognition === recognition;
      recognition.lang = 'yue-Hant-HK'; recognition.continuous = false; recognition.interimResults = false; recognition.maxAlternatives = 1;
      recognition.onstart = () => {
        if (!current()) { try { recognition.abort(); } catch (_) {} return; }
        if (dictation.phase === 'finishing') { try { recognition.stop(); } catch (_) { dictationFailed(); } return; }
        dictation.phase = 'listening'; renderDictation();
      };
      recognition.onresult = event => {
        if (!current()) return;
        for (let index = event.resultIndex || 0; index < event.results.length; index++) {
          if (!event.results[index].isFinal) continue;
          const phrase = event.results[index][0]?.transcript || '';
          if (!phrase.trim()) { dictationFailed('no-speech'); return; }
          cancelDictation('review', '請核對或修改詞語，再確認加入。');
          $('dictation-pending').value = phrase;
          return;
        }
      };
      recognition.onerror = event => { if (current()) dictationFailed(event.error); };
      recognition.onend = () => { if (current()) dictationFailed('no-speech'); };
      dictation.timer = setTimeout(() => { if (current()) dictationFailed('timeout'); }, 20000);
      renderDictation(); recognition.start();
    } catch (error) { dictationFailed(error.name === 'NotAllowedError' ? 'not-allowed' : undefined); }
  }
  $('dictation-start').addEventListener('click', startDictation);
  $('dictation-stop').addEventListener('click', () => {
    if (!['starting', 'listening'].includes(dictation.phase)) return;
    dictation.phase = 'finishing'; renderDictation();
    clearTimeout(dictation.timer);
    const token = dictation.token;
    dictation.timer = setTimeout(() => { if (dictation.token === token) dictationFailed('timeout'); }, Math.max(0, Math.min(3000, dictation.deadline - performance.now())));
    try { dictation.recognition.stop(); } catch (_) { dictationFailed(); }
  });
  $('dictation-cancel').addEventListener('click', () => cancelDictation());
  $('dictation-confirm').addEventListener('click', () => {
    if (dictation.phase !== 'review') return;
    try {
      const word = $('dictation-pending').value.normalize('NFC').replace(/^[\s\p{P}]+|[\s\p{P}]+$/gu, '');
      if (!/^\p{Script=Han}{1,8}$/u.test(word)) throw new Error('每次只可加入一項 1 至 8 個中文字嘅詞語，請修改後再確認。');
      const before = $('teacher-words').value;
      if (before.trim() && S.parseEntries(before).some(entry => entry.text === word)) throw new Error('已有相同詞語，未有重複加入。');
      const combined = before + (before && !/[\r\n]$/.test(before) ? '\n' : '') + word;
      S.parseEntries(combined);
      $('teacher-words').value = combined;
      cancelDictation('idle', '已加入文字框。撳「更新可選詞語」先選擇範圍。');
    } catch (error) { dictation.message = error.message; renderDictation(); }
  });
  function durationLabel(attempts, unstarted = false) {
    if (!attempts.length) return unstarted ? '未開始' : '未有計時資料';
    const measured = attempts.filter(attempt => Number.isFinite(attempt.elapsedMs));
    if (!measured.length) return '未有計時資料';
    const seconds = (measured.reduce((total, attempt) => total + attempt.elapsedMs, 0) / 1000).toFixed(1);
    return seconds + ' 秒' + (measured.length < attempts.length ? '（部分嘗試未有計時資料）' : '');
  }
  function renderHistory() {
    const list = $('local-history'); list.replaceChildren(); const all = history();
    if (!all.length) { list.textContent = '暫時未有已儲存紀錄。'; return; }
    all.slice(0, 15).forEach(snapshot => { const rows = S.summarize(snapshot), div = textNode('div', '', 'history-item');
      div.append(textNode('div', snapshot.mode === 'quiz' ? '測驗' : '練習'));
      if (snapshot.mode === 'quiz') {
        const completeTiming = rows.every(row => row.timingComplete);
        div.append(textNode('div', (completeTiming ? '書寫總時間：' : '已記錄書寫時間：') + durationLabel(snapshot.attempts)));
      }
      div.append(textNode('strong', new Date(snapshot.startedAt).toLocaleString('zh-HK')), textNode('div', snapshot.entries.map(word => word.text).join('、')),
        textNode('div', '自己完成 ' + rows.filter(r => r.independent).length + ' · 有提示完成 ' + rows.filter(r => r.assisted && !r.independent).length + ' · 跳過 ' + rows.filter(r => r.skipped && !r.independent && !r.assisted).length + ' · 待練 ' + rows.filter(r => r.unfinished).length));
      const details = document.createElement('details'); details.append(textNode('summary', '睇每次嘗試'));
      rows.forEach(row => details.append(textNode('p', row.word + ' 第 ' + (row.index + 1) + ' 字「' + row.character + '」' + (row.attempts.length ? row.attempts.map(a => (a.phase === 'quiz' ? '測驗' : a.phase === 'guided' ? '引導' : a.phase === 'recall' ? '自己試' : '老師') + ' ' + ({ complete: '完成', active: '未完成', abandoned: '未完成／重試', skipped: '協助跳過' }[a.outcome]) + (snapshot.mode === 'quiz' ? '，' + durationLabel([a]) : '，提示 ' + a.help.length + ' 次')).join('；') : '待練'))));
      if (snapshot.mode === 'quiz') rows.forEach(row => details.append(textNode('p', '第 ' + (row.index + 1) + ' 字「' + row.character + '」書寫時間：' + durationLabel(row.attempts, true))));
      div.append(details); list.append(div);
    });
  }
  let cantoneseVoice = null;
  function renderPresentation() {
    document.body.classList.toggle('simplified-practice', simplified);
    $('simplify').textContent = safeText(simplified ? ['精簡畫面：開', '只顯示重點', '少啲內容'] : ['精簡畫面：關', '顯示全部內容', '完整模式']);
    $('simplify').setAttribute('aria-pressed', String(simplified));
  }
  function renderInstructionVoice() {
    $('hear-instruction').textContent = safeText(['聽指令', '操作語音', '播放說明']);
    $('instruction-voice-note').textContent = instructionStatus ? safeText(instructionStatus) : '';
  }
  const speechUnavailable = ['暫時冇粵語聲音，請老師讀畫面指令。', '裝置未提供合適語音，可搵大人幫手。', '未能朗讀，文字仍然保留。'];
  const speechFailed = ['裝置未能朗讀，請老師讀畫面指令。', '語音暫時用唔到，可搵大人幫手。', '聲音有問題，文字仍然保留。'];
  function refreshSpeechNotice() { restoreRecallText(); renderInstructionVoice(); maskRecallText(); }
  function renderWordVoiceLabel() { $('speak').setAttribute('aria-label', safeText(cantoneseVoice ? ['聽粵語詞語', '播放讀音', '聲音示範'] : ['顯示粵語聲音未能使用嘅說明', '請老師幫手朗讀', '裝置未提供合適發音'])); $('speak-label').textContent = safeText(['聽詞語', '播放讀音', '請老師朗讀']); }
  function updateVoices() {
    restoreRecallText();
    try { cantoneseVoice = 'speechSynthesis' in window && typeof SpeechSynthesisUtterance === 'function' ? speechSynthesis.getVoices().find(voice => /^(yue(?:-|$)|zh[-_]HK$)/i.test(voice.lang)) || null : null; } catch (_) { cantoneseVoice = null; }
    $('voice-note').textContent = cantoneseVoice ? '' : '暫時冇粵語聲音。可以請老師讀一次。';
    renderWordVoiceLabel();
    maskRecallText();
  }
  function speakText(text, operation) {
    cancelDictation();
    stopSpeech(); const generation = speechGeneration;
    if (!cantoneseVoice) { if (operation) instructionStatus = speechUnavailable; else $('voice-note').textContent = '請老師讀一次，再試吓自己讀。暫時冇粵語聲音。'; refreshSpeechNotice(); return; }
    try {
      const u = new SpeechSynthesisUtterance(text); u.voice = cantoneseVoice; u.lang = cantoneseVoice.lang; u.rate = 0.72;
      u.onend = () => { if (generation === speechGeneration && operation) { instructionStatus = ''; refreshSpeechNotice(); } };
      u.onerror = () => { if (generation !== speechGeneration) return; if (operation) instructionStatus = speechFailed; else $('voice-note').textContent = '裝置未能朗讀，可以請老師讀一次。'; refreshSpeechNotice(); };
      if (operation) instructionStatus = ['正在播放指令。', '語音已送到裝置。', '聲音準備中。'];
      speechSynthesis.speak(u); refreshSpeechNotice();
    } catch (_) { if (operation) instructionStatus = speechFailed; else $('voice-note').textContent = '裝置未能朗讀，可以請老師讀一次。'; refreshSpeechNotice(); }
  }
  $('hear-instruction').addEventListener('click', () => { updateVoices(); speakText(instructionText, true); });
  $('simplify').addEventListener('click', () => { restoreRecallText(); simplified = !simplified; renderPresentation(); maskRecallText(); });
  $('speak').addEventListener('click', () => {
    updateVoices();
    const word = currentWord(), occurrence = currentOccurrence(); if (!word || !occurrence) return;
    speakText(state.mode === 'quiz' ? occurrence.character : word.text + '。第' + (occurrence.index + 1) + '個字，' + occurrence.character + '。', false);
  });
  if ('speechSynthesis' in window && speechSynthesis.addEventListener) speechSynthesis.addEventListener('voiceschanged', updateVoices);
  $('teacher-open').addEventListener('click', () => {
    cancelDictation();
    if (state && state.active.phase === 'recall') requestHelp('outline');
    draftEntries = entries; draftSelected = new Set(selected);
    $('teacher-words').value = draftEntries.map(entry => entry.text).join('\n'); $('teacher-error').textContent = ''; selectedOptions();
    const active = state && !['choose-word', 'summary'].includes(state.active.phase); $('teacher-active').hidden = !active;
    $('teacher-skip').disabled = !active || !['loading', 'unavailable', 'watch', 'guided', 'recall', 'quiz'].includes(state.active.phase) || state.active.writingDone;
    $('teacher-dialog').showModal(); availabilityChanged(); renderHistory();
  });
  $('teacher-close').addEventListener('click', () => { cancelDictation(); $('teacher-dialog').close(); });
  $('teacher-dialog').addEventListener('cancel', () => cancelDictation());
  $('teacher-dialog').addEventListener('close', () => { cancelDictation(); availabilityChanged(); });
  $('validate-words').addEventListener('click', () => { try { draftEntries = S.parseEntries($('teacher-words').value); draftSelected = allCharacterPositions(draftEntries); selectedOptions(); $('teacher-error').textContent = '已更新可選詞語。'; } catch (error) { $('teacher-error').textContent = error.message; } });
  $('apply-words').addEventListener('click', () => {
    cancelDictation();
    try {
      const parsed = S.parseEntries($('teacher-words').value);
      if (parsed.map(e => e.text).join('\n') !== draftEntries.map(e => e.text).join('\n')) throw new Error('詞語有改動。先撳「更新可選詞語」，再選擇範圍。');
      sessionCandidate('practice', draftEntries, draftSelected);
      entries = draftEntries; selected = new Set(draftSelected);
      goHome(); $('teacher-dialog').close();
    } catch (error) { $('teacher-error').textContent = error.message; }
  });
  $('teacher-skip').addEventListener('click', () => { cancelDictation(); if (event('TEACHER_SKIP')) $('teacher-dialog').close(); });
  $('teacher-end').addEventListener('click', () => { cancelDictation(); dispatch({ type: 'END_SESSION' }); $('teacher-dialog').close(); });
  $('play').addEventListener('click', () => handle && handle.play(false)); $('pause').addEventListener('click', () => handle && handle.pause());
  $('demo-previous').addEventListener('click', () => { pendingDemoToken = null; event('BROWSE_DEMO', { direction: -1 }); });
  $('demo-next').addEventListener('click', () => { pendingDemoToken = null; event('BROWSE_DEMO', { direction: 1 }); });
  $('replay').addEventListener('click', () => handle && handle.play(true)); $('one-stroke').addEventListener('click', () => handle && handle.nextStroke());
  $('main-next').addEventListener('click', () => { if (!state) return; const phase = state.active.phase; if (phase === 'watch') event('START_GUIDED'); else if (phase === 'guided') event('START_RECALL'); else if (phase === 'character-complete') event('NEXT'); });
  $('previous-step').addEventListener('click', () => { if (event('PREVIOUS_STEP')) stopSpeech(); });
  $('hint-stroke').addEventListener('click', () => requestHelp('stroke')); $('hint-outline').addEventListener('click', () => requestHelp('outline'));
  $('retry-writing').addEventListener('click', () => event('RETRY')); $('retry-data').addEventListener('click', () => event('RETRY_DATA')); $('different-word').addEventListener('click', () => event('RETURN_TO_WORDS'));
  $('choice-summary').addEventListener('click', () => localMode ? showGroups(localMode, curriculumPages.length - 1) : goHome());
  $('group-home').addEventListener('click', () => {
    if (curriculumLevel) { curriculumLevel--; render(); } else goHome();
  });
  $('new-session').addEventListener('click', goHome);
  for (const mode of ['practice', 'quiz']) $('start-' + mode).addEventListener('click', () => showGroups(mode));
  $('rest').addEventListener('click', () => { if (!state) return; dispatch({ type: 'REST' }); $('rest-dialog').showModal(); availabilityChanged(); });
  $('resume').addEventListener('click', () => { $('rest-dialog').close(); dispatch({ type: 'RESUME' }); availabilityChanged(); });
  $('rest-dialog').addEventListener('cancel', event => event.preventDefault());
  $('writer').addEventListener('pointerdown', () => { if (feedback && feedback.kind === 'quiz-miss') { feedback = null; $('feedback-text').textContent = ''; $('feedback-icon').hidden = true; } });
  document.querySelector('.brand').addEventListener('click', click => { click.preventDefault(); goHome(); });
  document.addEventListener('visibilitychange', availabilityChanged);
  window.addEventListener('pageshow', () => { leaving = false; availabilityChanged(); });
  for (const name of ['beforeunload', 'popstate', 'hashchange']) window.addEventListener(name, () => cancelDictation());
  window.addEventListener('pagehide', () => {
    leaving = true; availabilityChanged(); soundVersion++; soundEnabled = false; audioStatus = 'off';
    updateSound();
    if (audioContext) { audioContext.close().catch(() => {}); audioContext = null; }
  });
  try {
    const previousId = sessionStorage.getItem(prefix + 'current');
    if (previousId) { const raw = localStorage.getItem(prefix + previousId); if (raw && raw.length < 1000000) { const previous = JSON.parse(raw); if (S.validateSnapshot(previous) && previous.active.phase !== 'summary') { const ended = S.transition(previous, { type: 'END_SESSION', at: Date.now() }); localStorage.setItem(prefix + previousId, JSON.stringify(ended)); } } }
  } catch (_) { storageError(); }
  updateVoices(); render();
})();
