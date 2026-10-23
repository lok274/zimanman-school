(function () {
  'use strict';
  const S = globalThis.BishunSession, W = globalThis.BishunWriting, C = globalThis.BishunContent;
  const $ = id => document.getElementById(id);
  const prefix = 'bishun-school:v1:';
  let entries = S.parseEntries(C.words.join('\n')), selected = new Set(['w0:0']);
  let draftEntries = entries, draftSelected = new Set(selected);
  let state = null, handle, mountedKey = '', loadingController, storageOkay = true, demoState = 'stopped';
  let feedback = null, feedbackAnimation = null, tone = null;
  let soundEnabled = false, audioContext = null, soundVersion = 0, audioStatus = 'off';
  let simplified = true, instructionText = '', instructionStatus = '', speechKey = '', speechGeneration = 0;
  let readyMount = null, mountGeneration = 0, segment = null, leaving = false;
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
  }
  function availabilityChanged() {
    checkpoint();
    if (!available()) {
      feedback = null; cancelFeedbackEffects(); stopSpeech();
      if (loadingController) { loadingController.abort(); loadingController = null; mountedKey = ''; mountGeneration++; }
      if (handle && state && state.active.phase !== 'character-complete') { handle.dispose(); handle = null; mountedKey = ''; readyMount = null; mountGeneration++; }
    }
    save(); render(); openSegment();
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
    if (!assigned.length || assigned.length > 6) throw new Error('今節請揀 1 至 6 項詞語入面嘅字。建議先練 1 至 2 個字。');
    return S.createSession({ id: id(), entries: assigned, startedAt: Date.now(), mode });
  }
  function startSession(candidate = sessionCandidate()) {
    stopEffects();
    feedback = null;
    state = candidate;
    try { sessionStorage.setItem(prefix + 'current', state.id); } catch (_) {}
    save(); render();
  }
  function stopSpeech() { speechGeneration++; instructionStatus = ''; $('instruction-voice-note').textContent = ''; try { if ('speechSynthesis' in window) speechSynthesis.cancel(); } catch (_) {} }
  function goHome() {
    if (state && state.active.phase !== 'summary') dispatch({ type: 'END_SESSION' });
    else save();
    stopEffects(); state = null; feedback = null;
    try { sessionStorage.removeItem(prefix + 'current'); } catch (_) {}
    render();
  }
  function stopEffects() { checkpoint(); readyMount = null; mountGeneration++; if (handle) handle.dispose(); handle = null; mountedKey = ''; if (loadingController) loadingController.abort(); loadingController = null; stopSpeech(); cancelFeedbackEffects(); }
  function dispatch(event) {
    checkpoint();
    const before = state;
    const next = S.transition(state, { at: Date.now(), ...event });
    if (next === state) { openSegment(); return false; }
    state = next; cancelFeedbackEffects(); feedback = feedbackFor(before, next, event); save(); render(); openSegment();
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
      if (event.type === 'STROKE_MISSED') return make('quiz-miss', '✕', ['呢一畫未啱，再試一次。']);
      if (event.type === 'WRITING_COMPLETE') return make('quiz-complete', '○', ['完成咗！準備好先行下一步。'], true);
      return null;
    }
    const n = next.active.currentStroke;
    switch (event.type) {
      case 'STROKE_ACCEPTED': return before.active.missesOnCurrentStroke
        ? make('recovered', '✓', ['再試後，完成第 ' + n + ' 畫！', '重試嗰筆已寫好，進度 ' + n + '。', '再做成功，已到 ' + n + '。'])
        : make('step', '✓', ['完成第 ' + n + ' 畫！', '呢筆已寫好，進度 ' + n + '。', '做到第 ' + n + ' 步。']);
      case 'STROKE_MISSED': return make('support', '↻', ['慢慢再試，需要提示都可以。', '由起點落筆，或者請老師幫手。', '停低諗吓，想求助就撳掣。']);
      case 'REQUEST_HELP': return make('support', '•', ['提示已開，可以繼續寫。', '睇住幫手，再試吓。', '有需要就求助，慢慢嚟。']);
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
      const content = textNode('span', target.character, 'word-name');
      button.append(content, visualCue(word.text));
      if (done) button.append(textNode('span', pending ? '有字待練' : '完成今次練習', 'stamp'));
      button.addEventListener('click', () => event('CHOOSE_WORD', { wordId: word.id })); container.append(button);
    });
    $('choice-summary').textContent = '返回首頁';
  }
  function render() {
    restoreRecallText();
    renderSound();
    renderWordVoiceLabel();
    $('home-view').hidden = !!state;
    document.body.classList.toggle('quiz-mode', !!state && state.mode === 'quiz');
    if (!state) {
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
    if (choose || summary) { if (handle || loadingController) stopEffects(); else stopSpeech(); speechKey = ''; if (choose) renderChoices(); else renderSummary(state); return; }
    const word = currentWord();
    const quiz = state.mode === 'quiz', recall = a.phase === 'recall', complete = a.phase === 'character-complete';
    $('word-title').textContent = recall ? '詞語收埋咗' : currentOccurrence().character; $('word-title').classList.toggle('concealed', recall);
    $('semantic-cue').replaceChildren(visualCue(word.text));
    document.querySelector('.step-rail').hidden = quiz;
    $('writer').setAttribute('aria-label', quiz ? '測驗書寫格，沒有筆畫提示' : recall ? '無字形提示嘅書寫格' : '書寫練習格');
    const stage = complete ? 'recall' : a.phase;
    const stageIndex = ['watch', 'guided', 'recall'].indexOf(stage);
    document.querySelectorAll('[data-stage]').forEach((element, index) => { element.classList.toggle('active', index === stageIndex); element.classList.toggle('done', index < stageIndex); if (index === stageIndex) element.setAttribute('aria-current', 'step'); else element.removeAttribute('aria-current'); });
    $('demo-controls').hidden = a.phase !== 'watch'; $('extra-demo-controls').hidden = a.phase !== 'watch';
    $('writing-controls').hidden = !['guided', 'recall'].includes(a.phase) || a.writingDone;
    $('extra-writing-controls').hidden = !['guided', 'recall', 'quiz'].includes(a.phase) && !(complete && ['recall', 'quiz'].includes(a.completedPhase));
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
    if (a.phase === 'guided') { title = a.writingDone ? '完成引導練習' : safeText(['跟住寫', '照樣做', '練習']); instruction = safeText(a.writingDone ? ['準備好，就自己試。', '可以收起字形再寫。', '下一步由你決定。'] : ['由橙點開始寫。', '手指跟住起筆提示。', '順住方向慢慢做。']); defaultFeedback = a.writingDone ? '跟寫完成。下一步由你決定。' : a.missesOnCurrentStroke ? '再慢慢試。需要幫手都可以。' : '由起點開始，慢慢寫。'; $('main-next').textContent = '收起字形，自己試 →'; }
    if (a.phase === 'quiz') { title = '測驗'; instruction = '照住題目，自己寫。'; defaultFeedback = '寫錯可以再試。'; }
    if (a.phase === 'recall') { title = safeText(['自己試', '試住記', '憑記憶']); instruction = safeText(['先想一想，再落筆。', '按記憶寫，需要就開提示。', '慢慢做，隨時可以求助。']); defaultFeedback = attempt.help.length ? '已記低用過提示，放心繼續寫。' : a.missesOnCurrentStroke ? '再試一次，或者開提示幫手。' : '用自己記住嘅筆順寫。'; }
    if (complete) {
      const label = a.completedPhase === 'skipped' ? '老師協助跳過' : attempt && attempt.help.length ? '有提示完成' : '自己完成';
      title = quiz && a.completedPhase === 'quiz' ? '測驗完成' : label; instruction = a.completedPhase === 'skipped' ? '今次先放低，之後再一齊試。' : '準備好，先行下一步。'; defaultFeedback = '每一次嘅嘗試都保留喺紀錄。';
      const remaining = state.occurrences.filter(item => !state.finished.includes(item.id));
      $('main-next').textContent = !remaining.length ? '睇今次紀錄 →' : remaining.some(item => item.wordId === word.id) ? '下一個字 →' : '揀下一個字 →';
    }
    $('practice-title').textContent = title; $('practice-instruction').textContent = instruction;
    instructionText = instruction;
    const nextSpeechKey = [state.id, a.token, a.phase, a.writingDone, state.resting, instruction].join(':');
    if (nextSpeechKey !== speechKey) { stopSpeech(); speechKey = nextSpeechKey; }
    renderInstructionVoice();
    const message = feedback ? feedback.text : defaultFeedback;
    if ($('feedback-text').textContent !== message) $('feedback-text').textContent = message;
    const icon = feedback ? feedback.icon : '';
    if ($('feedback-icon').textContent !== icon) $('feedback-icon').textContent = icon;
    if ($('feedback-icon').hidden !== !feedback) $('feedback-icon').hidden = !feedback;
    $('feedback').setAttribute('data-kind', feedback ? feedback.kind : 'instruction');
    $('quiz-mark').hidden = !quiz || !(feedback && feedback.kind === 'quiz-miss') && a.completedPhase !== 'quiz';
    $('quiz-mark').setAttribute('data-result', a.completedPhase === 'quiz' ? 'complete' : 'miss');
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
        if (state.mode === 'quiz') {
          const attempt = state.attempts.find(item => item.id === state.active.attemptId);
          if (attempt && attempt.elapsedMs === null) state = S.transition(state, { type: 'DURATION_SNAPSHOT', token: a.token, elapsedMs: 0 });
          save(); openSegment();
        }
      },
      onError: () => { if (state && generation === mountGeneration && state.active.token === a.token) dispatch({ type: 'MOUNT_FAILED', token: a.token }); },
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
    $('teacher-voice-note').textContent = cantoneseVoice ? '目前使用裝置嘅粵語聲音「' + cantoneseVoice.name + '」。語音由瀏覽器提供。' : '瀏覽器未提供可辨識嘅粵語聲音。程式唔會改用普通話。可由老師朗讀，或喺裝置設定加入粵語語音後重開。';
    renderWordVoiceLabel();
    maskRecallText();
  }
  function speakText(text, operation) {
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
    if (state && state.active.phase === 'recall') requestHelp('outline');
    draftEntries = entries; draftSelected = new Set(selected);
    $('teacher-words').value = draftEntries.map(entry => entry.text).join('\n'); $('teacher-error').textContent = ''; selectedOptions();
    const active = state && !['choose-word', 'summary'].includes(state.active.phase); $('teacher-active').hidden = !active;
    $('teacher-skip').disabled = !active || !['loading', 'unavailable', 'watch', 'guided', 'recall', 'quiz'].includes(state.active.phase) || state.active.writingDone;
    $('teacher-dialog').showModal(); availabilityChanged(); renderHistory();
  });
  $('teacher-close').addEventListener('click', () => $('teacher-dialog').close());
  $('teacher-dialog').addEventListener('close', availabilityChanged);
  $('validate-words').addEventListener('click', () => { try { draftEntries = S.parseEntries($('teacher-words').value); draftSelected = new Set(['w0:0']); selectedOptions(); $('teacher-error').textContent = '已更新可選詞語。揀好範圍，再撳「套用」。'; } catch (error) { $('teacher-error').textContent = error.message; } });
  $('apply-words').addEventListener('click', () => {
    try {
      const parsed = S.parseEntries($('teacher-words').value);
      if (parsed.map(e => e.text).join('\n') !== draftEntries.map(e => e.text).join('\n')) throw new Error('詞語有改動。先撳「更新可選詞語」，再選擇範圍。');
      sessionCandidate('practice', draftEntries, draftSelected);
      entries = draftEntries; selected = new Set(draftSelected);
      goHome(); $('teacher-dialog').close();
    } catch (error) { $('teacher-error').textContent = error.message; }
  });
  $('teacher-skip').addEventListener('click', () => { if (event('TEACHER_SKIP')) $('teacher-dialog').close(); });
  $('teacher-end').addEventListener('click', () => { dispatch({ type: 'END_SESSION' }); $('teacher-dialog').close(); });
  $('play').addEventListener('click', () => handle && handle.play(false)); $('pause').addEventListener('click', () => handle && handle.pause());
  $('replay').addEventListener('click', () => handle && handle.play(true)); $('one-stroke').addEventListener('click', () => handle && handle.nextStroke());
  $('main-next').addEventListener('click', () => { if (!state) return; const phase = state.active.phase; if (phase === 'watch') event('START_GUIDED'); else if (phase === 'guided') event('START_RECALL'); else if (phase === 'character-complete') event('NEXT'); });
  $('previous-step').addEventListener('click', () => { if (event('PREVIOUS_STEP')) stopSpeech(); });
  $('hint-stroke').addEventListener('click', () => requestHelp('stroke')); $('hint-outline').addEventListener('click', () => requestHelp('outline'));
  $('retry-writing').addEventListener('click', () => event('RETRY')); $('retry-data').addEventListener('click', () => event('RETRY_DATA')); $('different-word').addEventListener('click', () => event('RETURN_TO_WORDS'));
  $('choice-summary').addEventListener('click', goHome);
  $('new-session').addEventListener('click', goHome);
  for (const mode of ['practice', 'quiz']) $('start-' + mode).addEventListener('click', () => startSession(sessionCandidate(mode)));
  $('rest').addEventListener('click', () => { if (!state) return; dispatch({ type: 'REST' }); $('rest-dialog').showModal(); availabilityChanged(); });
  $('resume').addEventListener('click', () => { $('rest-dialog').close(); dispatch({ type: 'RESUME' }); availabilityChanged(); });
  $('rest-dialog').addEventListener('cancel', event => event.preventDefault());
  $('writer').addEventListener('pointerdown', () => { if (feedback && feedback.kind === 'quiz-miss') { feedback = null; $('quiz-mark').hidden = true; $('feedback-text').textContent = ''; $('feedback-icon').hidden = true; } });
  document.querySelector('.brand').addEventListener('click', click => { click.preventDefault(); goHome(); });
  document.addEventListener('visibilitychange', availabilityChanged);
  window.addEventListener('pageshow', () => { leaving = false; availabilityChanged(); });
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
