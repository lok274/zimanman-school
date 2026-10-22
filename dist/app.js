(function () {
  'use strict';
  const S = globalThis.BishunSession, W = globalThis.BishunWriting, C = globalThis.BishunContent;
  const $ = id => document.getElementById(id);
  const prefix = 'bishun-school:v1:';
  let entries = S.parseEntries(C.words.join('\n')), selected = new Set(['w0', 'w1']);
  let state, handle, mountedKey = '', loadingController, storageOkay = true, demoState = 'stopped';
  let feedback = null, feedbackAnimation = null, tone = null;
  let soundEnabled = false, audioContext = null, soundVersion = 0, audioStatus = 'off';
  const dataCache = new Map();
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
  function startSession() {
    stopEffects();
    feedback = null;
    state = S.createSession({ id: id(), entries: entries.filter(entry => selected.has(entry.id)), startedAt: Date.now() });
    try { sessionStorage.setItem(prefix + 'current', state.id); } catch (_) {}
    save(); render();
  }
  function stopSpeech() { if ('speechSynthesis' in window) speechSynthesis.cancel(); }
  function stopEffects() { if (handle) handle.dispose(); handle = null; mountedKey = ''; if (loadingController) loadingController.abort(); loadingController = null; stopSpeech(); cancelFeedbackEffects(); }
  function dispatch(event) {
    const before = state;
    const next = S.transition(state, { at: Date.now(), ...event });
    if (next === state) return false;
    state = next; cancelFeedbackEffects(); feedback = feedbackFor(before, next, event); save(); render();
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
  function currentOccurrence() { return state.occurrences.find(item => item.id === state.active.occurrenceId); }
  function currentWord() { const o = currentOccurrence(); return o && state.entries.find(item => item.id === o.wordId); }
  function event(type, extra) { return dispatch({ type, token: state.active.token, newToken: id(), ...extra }); }
  function svgCue(text) { const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 64 64'); svg.setAttribute('aria-hidden', 'true'); const p = document.createElementNS(svg.namespaceURI, 'path'); p.setAttribute('d', C.cue(text)[1]); svg.append(p); return svg; }
  function visualCue(text) {
    if (!C.photos || !C.photos[text]) return svgCue(text);
    const image = document.createElement('img'); image.className = 'word-photo'; image.setAttribute('src', C.photos[text]); image.setAttribute('alt', '');
    image.addEventListener('error', () => image.replaceWith(svgCue(text)), { once: true });
    return image;
  }
  function textNode(tag, text, className) { const element = document.createElement(tag); element.textContent = text; if (className) element.className = className; return element; }
  function renderChoices() {
    const container = $('word-cards'); container.replaceChildren();
    const rows = S.summarize(state);
    const completedWords = state.entries.filter(word => state.occurrences.filter(o => o.wordId === word.id).every(o => state.finished.includes(o.id))).length;
    $('session-count').textContent = '今節 ' + state.entries.length + ' 項詞語 · 已練 ' + completedWords + ' 項';
    state.entries.forEach((word, index) => {
      const done = state.occurrences.filter(o => o.wordId === word.id).every(o => state.finished.includes(o.id));
      const pending = done && rows.some(row => row.wordId === word.id && !row.independent && !row.assisted);
      const button = document.createElement('button'); button.className = 'word-card'; button.disabled = done;
      const content = document.createElement('span'); content.append(textNode('span', word.text, 'word-name'), textNode('span', C.cue(word.text)[0], 'card-example'), textNode('span', pending ? '今次先放低 · 紀錄入面再睇' : done ? '已練過 · 紀錄入面再睇' : '由呢個開始 →', 'card-action'));
      button.append(content, visualCue(word.text));
      if (done) button.append(textNode('span', pending ? '有字待練' : '完成今次練習', 'stamp'));
      button.addEventListener('click', () => event('CHOOSE_WORD', { wordId: word.id })); container.append(button);
    });
    $('choice-message').textContent = completedWords === state.entries.length ? '今節練習已經行完，睇吓自己嘅腳印。' : completedWords ? '下一個詞語，都由你揀。' : '由你揀第一步。';
    $('choice-summary').textContent = completedWords === state.entries.length ? '完成，睇今節紀錄 →' : '睇今節紀錄';
  }
  function render() {
    restoreRecallText();
    renderSound();
    const a = state.active, choose = a.phase === 'choose-word', summary = a.phase === 'summary';
    $('choose-view').hidden = !choose; $('practice-view').hidden = choose || summary; $('summary-view').hidden = !summary;
    document.body.classList.toggle('has-recall', a.phase === 'recall');
    if (choose || summary) { if (handle || loadingController) stopEffects(); if (choose) renderChoices(); else renderSummary(state); return; }
    const occurrence = currentOccurrence(), word = currentWord();
    const recall = a.phase === 'recall', complete = a.phase === 'character-complete';
    $('word-position').textContent = '今節第 ' + (state.entries.indexOf(word) + 1) + ' 項詞語';
    $('word-title').textContent = recall ? '詞語收埋咗' : word.text; $('word-title').classList.toggle('concealed', recall);
    $('word-example').textContent = recall ? '想聽，可以撳「聽一聽」。' : C.cue(word.text)[0];
    $('semantic-cue').replaceChildren(visualCue(word.text));
    $('char-position').textContent = '第 ' + (occurrence.index + 1) + ' / ' + word.characters.length + ' 字';
    $('writer').setAttribute('aria-label', recall ? '無字形提示嘅書寫格' : '書寫練習格');
    const stage = complete ? 'recall' : a.phase;
    const stageIndex = ['watch', 'guided', 'recall'].indexOf(stage);
    document.querySelectorAll('[data-stage]').forEach((element, index) => { element.classList.toggle('active', index === stageIndex); element.classList.toggle('done', index < stageIndex); if (index === stageIndex) element.setAttribute('aria-current', 'step'); else element.removeAttribute('aria-current'); });
    $('demo-controls').hidden = a.phase !== 'watch'; $('writing-controls').hidden = !['guided', 'recall'].includes(a.phase) && !(complete && a.completedPhase === 'recall');
    $('hint-stroke').hidden = a.writingDone || complete; $('hint-outline').hidden = a.writingDone || complete;
    $('data-controls').hidden = a.phase !== 'unavailable';
    $('main-next').hidden = ['loading', 'unavailable'].includes(a.phase) || (['guided', 'recall'].includes(a.phase) && !a.writingDone);
    $('stroke-progress').textContent = a.strokeCount && ['guided', 'recall'].includes(a.phase) ? '已寫 ' + a.currentStroke + ' / ' + a.strokeCount + ' 畫' : a.strokeCount && a.phase === 'watch' ? '共 ' + a.strokeCount + ' 畫' : '';
    const attempt = state.attempts.find(item => item.id === a.attemptId);
    let title = '', instruction = '', defaultFeedback = '';
    if (a.phase === 'loading') { title = '準備好書寫格'; instruction = '等一等，整理緊筆順。'; }
    if (a.phase === 'unavailable') { title = '呢個字暫時未準備好'; instruction = '唔係你寫錯。可以再試，或者請老師幫手。'; }
    if (a.phase === 'watch') { title = '睇一睇，點樣寫'; instruction = '撳播放，眼睛跟住每一畫。'; defaultFeedback = '可以暫停，亦可以一畫一畫睇。'; $('main-next').textContent = '到我跟住寫 →'; }
    if (a.phase === 'guided') { title = a.writingDone ? '完成引導練習' : '跟住起點，一畫一畫寫'; instruction = a.writingDone ? '而家試吓收起字形，用自己嘅方法記住。' : '由橙色起點開始。用手指或者觸控筆寫。'; defaultFeedback = a.writingDone ? '跟寫完成。下一步由你決定。' : a.missesOnCurrentStroke ? '再慢慢試。需要幫手都可以。' : '由起點開始，慢慢寫。'; $('main-next').textContent = '收起字形，自己試 →'; }
    if (a.phase === 'recall') { title = '收起字形，自己試'; instruction = '先想一想。想要提示，隨時可以開。'; defaultFeedback = attempt.help.length ? '已記低用過提示，放心繼續寫。' : a.missesOnCurrentStroke ? '再試一次，或者開提示幫手。' : '用自己記住嘅筆順寫。'; }
    if (complete) {
      const label = a.completedPhase === 'skipped' ? '老師協助跳過' : attempt && attempt.help.length ? '有提示完成' : '自己完成';
      title = label; instruction = a.completedPhase === 'skipped' ? '今次先放低，之後再一齊試。' : '你完成咗今次書寫。準備好先行下一步。'; defaultFeedback = '每一次嘅嘗試都保留喺紀錄。';
      $('main-next').textContent = occurrence.index + 1 < word.characters.length ? '下一個字 →' : '揀下一項詞語 →';
    }
    $('practice-title').textContent = title; $('practice-instruction').textContent = instruction;
    const message = feedback ? feedback.text : defaultFeedback;
    if ($('feedback-text').textContent !== message) $('feedback-text').textContent = message;
    const icon = feedback ? feedback.icon : '';
    if ($('feedback-icon').textContent !== icon) $('feedback-icon').textContent = icon;
    if ($('feedback-icon').hidden !== !feedback) $('feedback-icon').hidden = !feedback;
    $('feedback').setAttribute('data-kind', feedback ? feedback.kind : 'instruction');
    $('board-message').hidden = !['loading', 'unavailable'].includes(a.phase);
    $('board-message').textContent = a.phase === 'loading' ? '整理緊筆順…' : '未能載入字形\n請再試，或者請老師幫手。';
    $('play').textContent = demoState === 'paused' ? '▶ 繼續播放' : '▶ 播放';
    $('pause').disabled = demoState !== 'playing';
    syncWriter();
    maskRecallText();
  }
  function syncWriter() {
    const a = state.active;
    const key = a.token + ':' + a.phase;
    if (mountedKey === key) return;
    if (a.phase === 'character-complete' && handle && mountedKey.startsWith(a.token + ':')) { mountedKey = key; return; }
    if (handle) handle.dispose(); handle = null;
    if (loadingController) loadingController.abort(); loadingController = null;
    mountedKey = key; demoState = 'stopped';
    if (a.phase === 'loading') {
      const occurrence = currentOccurrence(), token = a.token; loadingController = new AbortController(); const controller = loadingController;
      const timer = setTimeout(() => controller.abort(), 12000);
      Promise.resolve(dataCache.get(occurrence.character) || W.loadCharacter(occurrence.character, controller.signal)).then(data => {
        if (state.active.token !== token || state.active.phase !== 'loading') return;
        dataCache.set(occurrence.character, data); dispatch({ type: 'DATA_READY', token, strokeCount: data.strokes.length });
      }).catch(() => { if (state.active.token === token && state.active.phase === 'loading') dispatch({ type: 'DATA_FAILED', token }); }).finally(() => clearTimeout(timer));
      return;
    }
    if (!['watch', 'guided', 'recall'].includes(a.phase) || a.writingDone) return;
    const occurrence = currentOccurrence(), data = dataCache.get(occurrence.character);
    if (!data || !globalThis.HanziWriter) { $('board-message').hidden = false; $('board-message').textContent = '書寫工具未能開啟。請結束今節，再重新開啟。'; return; }
    handle = W.mount($('writer'), occurrence.character, data, { token: a.token, phase: a.phase, currentStroke: a.currentStroke || 0,
      onDemoState: value => { if (state.active.token !== a.token) return; demoState = value; $('pause').disabled = value !== 'playing'; $('play').textContent = value === 'paused' ? '▶ 繼續播放' : '▶ 播放'; },
      onEvent: incoming => {
        if (!dispatch(incoming)) return;
        if (incoming.type === 'STROKE_MISSED' && state.active.missesOnCurrentStroke >= 2) {
          const attempt = state.attempts.find(item => item.id === state.active.attemptId);
          if (!attempt.help.some(help => help.kind === 'stroke' && help.strokeIndex === state.active.currentStroke)) requestHelp('stroke');
        }
      }
    });
  }
  function requestHelp(kind) {
    const token = state.active.token;
    if (dispatch({ type: 'REQUEST_HELP', token, kind })) { if (handle) handle.showHelp(kind); return true; }
    return false;
  }
  function renderSummary(snapshot) {
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
          const phase = attempt.phase === 'guided' ? '引導' : attempt.phase === 'recall' ? '自己試' : '老師';
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
    entries.forEach(entry => { const label = textNode('label', '', 'word-option'), checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = selected.has(entry.id); checkbox.value = entry.id;
      checkbox.addEventListener('change', () => { if (checkbox.checked) selected.add(entry.id); else selected.delete(entry.id); }); label.append(checkbox, document.createTextNode(entry.text)); div.append(label); });
  }
  function renderHistory() {
    const list = $('local-history'); list.replaceChildren(); const all = history();
    if (!all.length) { list.textContent = '暫時未有已儲存紀錄。'; return; }
    all.slice(0, 15).forEach(snapshot => { const rows = S.summarize(snapshot), div = textNode('div', '', 'history-item');
      div.append(textNode('strong', new Date(snapshot.startedAt).toLocaleString('zh-HK')), textNode('div', snapshot.entries.map(word => word.text).join('、')),
        textNode('div', '自己完成 ' + rows.filter(r => r.independent).length + ' · 有提示完成 ' + rows.filter(r => r.assisted && !r.independent).length + ' · 跳過 ' + rows.filter(r => r.skipped && !r.independent && !r.assisted).length + ' · 待練 ' + rows.filter(r => r.unfinished).length));
      const details = document.createElement('details'); details.append(textNode('summary', '睇每次嘗試'));
      rows.forEach(row => details.append(textNode('p', row.word + ' 第 ' + (row.index + 1) + ' 字「' + row.character + '」' + (row.attempts.length ? row.attempts.map(a => (a.phase === 'guided' ? '引導' : a.phase === 'recall' ? '自己試' : '老師') + ' ' + ({ complete: '完成', active: '未完成', abandoned: '未完成／重試', skipped: '協助跳過' }[a.outcome]) + '，提示 ' + a.help.length + ' 次').join('；') : '待練'))));
      div.append(details); list.append(div);
    });
  }
  let cantoneseVoice = null;
  function updateVoices() {
    restoreRecallText();
    cantoneseVoice = 'speechSynthesis' in window ? speechSynthesis.getVoices().find(voice => /^(yue(?:-|$)|zh[-_]HK$)/i.test(voice.lang)) || null : null;
    $('voice-note').textContent = cantoneseVoice ? '撳一下，聽粵語。' : '暫時冇粵語聲音。可以請老師讀一次。';
    $('teacher-voice-note').textContent = cantoneseVoice ? '目前使用裝置嘅粵語聲音「' + cantoneseVoice.name + '」。語音由瀏覽器提供。' : '瀏覽器未提供可辨識嘅粵語聲音。程式唔會改用普通話。可由老師朗讀，或喺裝置設定加入粵語語音後重開。';
    $('speak').setAttribute('aria-label', cantoneseVoice ? '聽粵語詞語' : '顯示粵語聲音未能使用嘅說明');
    maskRecallText();
  }
  $('speak').addEventListener('click', () => {
    updateVoices();
    if (!cantoneseVoice) { $('voice-note').textContent = '請老師讀一次，再試吓自己讀。暫時冇粵語聲音。'; maskRecallText(); return; }
    const word = currentWord(), occurrence = currentOccurrence(); if (!word || !occurrence) return;
    stopSpeech(); const u = new SpeechSynthesisUtterance(word.text + '。第' + (occurrence.index + 1) + '個字，' + occurrence.character + '。'); u.voice = cantoneseVoice; u.lang = cantoneseVoice.lang; u.rate = 0.72; speechSynthesis.speak(u);
  });
  if ('speechSynthesis' in window) speechSynthesis.addEventListener('voiceschanged', updateVoices);
  $('teacher-open').addEventListener('click', () => {
    if (state.active.phase === 'recall') requestHelp('outline');
    stopSpeech(); cancelFeedbackEffects(); if (handle) handle.pause();
    $('teacher-words').value = entries.map(entry => entry.text).join('\n'); $('teacher-error').textContent = ''; selectedOptions(); renderHistory();
    const active = !['choose-word', 'summary'].includes(state.active.phase); $('teacher-active').hidden = !active;
    $('teacher-skip').disabled = !['loading', 'unavailable', 'watch', 'guided', 'recall'].includes(state.active.phase) || state.active.writingDone;
    $('teacher-dialog').showModal();
  });
  $('teacher-close').addEventListener('click', () => $('teacher-dialog').close());
  $('validate-words').addEventListener('click', () => { try { entries = S.parseEntries($('teacher-words').value); selected = new Set(entries.slice(0, 2).map(entry => entry.id)); selectedOptions(); $('teacher-error').textContent = '已更新可選詞語。揀好範圍，再撳「套用並開始新一節」。'; } catch (error) { $('teacher-error').textContent = error.message; } });
  $('apply-words').addEventListener('click', () => {
    try {
      const parsed = S.parseEntries($('teacher-words').value);
      if (parsed.map(e => e.text).join('\n') !== entries.map(e => e.text).join('\n')) throw new Error('詞語有改動。先撳「更新可選詞語」，再選擇範圍。');
      if (selected.size < 1 || selected.size > 6) throw new Error('今節請揀 1 至 6 項詞語。');
      if (state.active.phase !== 'summary') dispatch({ type: 'END_SESSION' });
      $('teacher-dialog').close(); startSession();
    } catch (error) { $('teacher-error').textContent = error.message; }
  });
  $('teacher-skip').addEventListener('click', () => { if (event('TEACHER_SKIP')) $('teacher-dialog').close(); });
  $('teacher-end').addEventListener('click', () => { dispatch({ type: 'END_SESSION' }); $('teacher-dialog').close(); });
  $('play').addEventListener('click', () => handle && handle.play(false)); $('pause').addEventListener('click', () => handle && handle.pause());
  $('replay').addEventListener('click', () => handle && handle.play(true)); $('one-stroke').addEventListener('click', () => handle && handle.nextStroke());
  $('main-next').addEventListener('click', () => { const phase = state.active.phase; if (phase === 'watch') event('START_GUIDED'); else if (phase === 'guided') event('START_RECALL'); else if (phase === 'character-complete') event('NEXT'); });
  $('hint-stroke').addEventListener('click', () => requestHelp('stroke')); $('hint-outline').addEventListener('click', () => requestHelp('outline'));
  $('retry-writing').addEventListener('click', () => event('RETRY')); $('retry-data').addEventListener('click', () => event('RETRY_DATA')); $('different-word').addEventListener('click', () => event('RETURN_TO_WORDS'));
  $('choice-summary').addEventListener('click', () => dispatch({ type: 'END_SESSION' }));
  $('new-session').addEventListener('click', startSession);
  $('rest').addEventListener('click', () => { if (handle) handle.suspend(); stopSpeech(); dispatch({ type: 'REST' }); $('rest-dialog').showModal(); });
  $('resume').addEventListener('click', () => { $('rest-dialog').close(); mountedKey = ''; dispatch({ type: 'RESUME' }); });
  $('rest-dialog').addEventListener('cancel', event => event.preventDefault());
  document.querySelector('.brand').addEventListener('click', click => { click.preventDefault(); if (state.active.phase === 'choose-word' || state.active.phase === 'summary') return; $('teacher-open').click(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) { stopSpeech(); cancelFeedbackEffects(); } });
  window.addEventListener('pagehide', () => {
    stopSpeech(); cancelFeedbackEffects(); soundVersion++; soundEnabled = false; audioStatus = 'off';
    updateSound();
    if (audioContext) { audioContext.close().catch(() => {}); audioContext = null; }
  });
  try {
    const previousId = sessionStorage.getItem(prefix + 'current');
    if (previousId) { const raw = localStorage.getItem(prefix + previousId); if (raw && raw.length < 1000000) { const previous = JSON.parse(raw); if (S.validateSnapshot(previous) && previous.active.phase !== 'summary') { const ended = S.transition(previous, { type: 'END_SESSION', at: Date.now() }); localStorage.setItem(prefix + previousId, JSON.stringify(ended)); } } }
  } catch (_) { storageError(); }
  updateVoices(); startSession();
})();
