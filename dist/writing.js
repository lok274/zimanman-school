(function (root) {
  'use strict';
  function validateCharacter(character, raw) {
    const data = raw && raw.data ? raw.data : raw;
    if (!/^\p{Script=Han}$/u.test(character) || !data || (data.character && data.character !== character) || !Array.isArray(data.strokes) || !data.strokes.length || data.strokes.length > 64 || !Array.isArray(data.medians) || data.medians.length !== data.strokes.length) throw new Error('字形資料不完整。');
    let size = 0;
    data.strokes.forEach(path => {
      if (typeof path !== 'string' || path.length > 150000 || !/^[Mm]/.test(path) || !/^[MmLlQqTtCcSsVvHhZzAa0-9+.,\s-]+$/.test(path)) throw new Error('筆畫資料無效。');
      const numbers = path.match(/[+-]?(?:\d*\.)?\d+/g) || [];
      if (!numbers.length || numbers.some(n => !Number.isFinite(Number(n)) || Math.abs(Number(n)) > 8192)) throw new Error('筆畫座標無效。');
      size += path.length;
    });
    if (size > 1200000 || data.medians.some(points => !Array.isArray(points) || points.length < 2 || points.length > 2000 || points.some(p => !Array.isArray(p) || p.length !== 2 || p.some(n => !Number.isFinite(n) || Math.abs(n) > 8192)))) throw new Error('筆畫座標無效。');
    return { strokes: data.strokes, medians: data.medians, radStrokes: Array.isArray(data.radStrokes) ? data.radStrokes.filter(n => Number.isInteger(n) && n >= 0 && n < data.strokes.length) : [] };
  }
  async function loadCharacter(character, signal) {
    if (!/^\p{Script=Han}$/u.test(character)) throw new Error('請使用單一中文字。');
    const registry = root.BishunCharacters || {};
    if (Object.prototype.hasOwnProperty.call(registry, character)) return validateCharacter(character, registry[character]);
    // shortcut: 草 requires the reviewed ten-stroke asset; never fall back to the nine-stroke upstream file.
    if (character === '草') throw new Error('呢個字嘅香港筆順資料尚未備妥。');
    const response = await fetch(root.BishunContent.dataUrl + encodeURIComponent(character) + '.json', { signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (!response.ok) throw new Error('暫時未能載入呢個字。');
    const declared = Number(response.headers.get('content-length'));
    if (declared > 2000000) throw new Error('字形資料過大。');
    const reader = response.body && response.body.getReader();
    let text = '';
    if (reader) {
      const decoder = new TextDecoder(); let bytes = 0;
      while (true) { const result = await reader.read(); if (result.done) break; bytes += result.value.byteLength; if (bytes > 2000000) { await reader.cancel(); throw new Error('字形資料過大。'); } text += decoder.decode(result.value, { stream: true }); }
      text += decoder.decode();
    } else { text = await response.text(); if (text.length > 2000000) throw new Error('字形資料過大。'); }
    return validateCharacter(character, JSON.parse(text));
  }
  function mount(element, character, data, options) {
    let alive = true, currentStroke = options.currentStroke || 0, paused = false, playing = false, nextIndex = 0, demoRun = 0;
    element.replaceChildren();
    const size = Math.round(element.getBoundingClientRect().width) || 360;
    const writer = root.HanziWriter.create(element, character, {
      width: size, height: size, padding: 24, showCharacter: false, showOutline: options.phase === 'guided',
      strokeColor: '#214b3b', outlineColor: '#d7ddd4', drawingColor: '#214b3b', highlightColor: '#ba642d', drawingWidth: 8,
      strokeAnimationSpeed: 0.65, delayBetweenStrokes: 520, strokeFadeDuration: 140, strokeHighlightSpeed: 0.65,
      showHintAfterMisses: false, highlightOnComplete: false, markStrokeCorrectAfterMisses: false, acceptBackwardsStrokes: false, leniency: 1.65,
      charDataLoader: (_char, done) => done(data)
    });
    const ns = 'http://www.w3.org/2000/svg';
    const overlay = document.createElementNS(ns, 'svg'); overlay.setAttribute('class', 'start-overlay'); overlay.setAttribute('aria-hidden', 'true');
    const group = document.createElementNS(ns, 'g'); overlay.append(group);
    const dot = document.createElementNS(ns, 'circle'); dot.setAttribute('r', '16'); dot.setAttribute('fill', '#bf6c36'); dot.setAttribute('stroke', '#fffaf0'); dot.setAttribute('stroke-width', '7'); group.append(dot); element.append(overlay);
    let startVisible = options.phase === 'guided';
    function placeStart() {
      const n = Math.round(element.getBoundingClientRect().width) || size;
      overlay.setAttribute('viewBox', '0 0 ' + n + ' ' + n);
      group.setAttribute('transform', root.HanziWriter.getScalingTransform(n, n, 24).transform);
      const p = data.medians[currentStroke] && data.medians[currentStroke][0];
      dot.style.display = startVisible && p ? '' : 'none';
      if (p) { dot.setAttribute('cx', p[0]); dot.setAttribute('cy', p[1]); }
    }
    placeStart();
    if (['guided', 'recall'].includes(options.phase)) {
      writer.quiz({ quizStartStrokeNum: currentStroke,
        onCorrectStroke: event => { if (!alive) return; currentStroke = event.strokeNum + 1; placeStart(); options.onEvent({ type: 'STROKE_ACCEPTED', token: options.token, strokeIndex: event.strokeNum }); },
        onMistake: event => { if (alive) options.onEvent({ type: 'STROKE_MISSED', token: options.token, strokeIndex: event.strokeNum }); },
        onComplete: () => { if (alive) options.onEvent({ type: 'WRITING_COMPLETE', token: options.token, at: Date.now() }); }
      });
    }
    const observer = new ResizeObserver(() => {
      if (!alive) return;
      const n = Math.round(element.getBoundingClientRect().width);
      if (n > 0) { writer.updateDimensions({ width: n, height: n, padding: 24 }); placeStart(); }
    }); observer.observe(element);
    function demoDone(run) { if (alive && run === demoRun) { playing = false; paused = false; options.onDemoState && options.onDemoState('stopped'); } }
    return {
      play(replay) {
        if (!alive || options.phase !== 'watch') return;
        if (paused && !replay) { writer.resumeAnimation(); paused = false; playing = true; }
        else { const run = ++demoRun; nextIndex = 0; playing = true; paused = false; writer.animateCharacter().then(() => demoDone(run)); }
        options.onDemoState && options.onDemoState('playing');
      },
      pause() { if (!alive) return; writer.pauseAnimation(); if (playing) { paused = true; options.onDemoState && options.onDemoState('paused'); } },
      nextStroke() {
        if (!alive || options.phase !== 'watch') return;
        writer.resumeAnimation(); paused = false; playing = true;
        const run = ++demoRun;
        writer.animateStroke(nextIndex).then(() => demoDone(run)); nextIndex = (nextIndex + 1) % data.strokes.length;
        options.onDemoState && options.onDemoState('playing');
      },
      showHelp(kind) {
        if (!alive) return;
        if (kind === 'outline') writer.showOutline({ duration: 0 });
        startVisible = true; placeStart();
        if (kind === 'stroke' && currentStroke < data.strokes.length) writer.highlightStroke(currentStroke);
      },
      suspend() { writer.cancelQuiz(); writer.pauseAnimation(); },
      dispose() { alive = false; observer.disconnect(); writer.cancelQuiz(); writer.pauseAnimation(); element.replaceChildren(); }
    };
  }
  const api = { validateCharacter, loadCharacter, mount };
  root.BishunWriting = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
