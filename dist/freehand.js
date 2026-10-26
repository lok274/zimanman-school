(function (root) {
  'use strict';
  const ns = 'http://www.w3.org/2000/svg';
  function element(tag, attributes) {
    const node = document.createElementNS(ns, tag);
    for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
    return node;
  }
  function path(stroke) { return stroke.map((point, i) => (i ? 'L' : 'M') + point[0] + ' ' + point[1]).join(' ') + (stroke.length === 1 ? 'l1 0' : ''); }
  function frame(label) {
    const svg = element('svg', { viewBox: '0 0 10000 10000', role: 'img', 'aria-label': label, class: 'freehand-ink' });
    const grid = element('path', { d: 'M0 5000H10000M5000 0V10000M0 0L10000 10000M10000 0L0 10000', stroke: '#d4ddd6', 'stroke-width': 20, 'stroke-dasharray': '80 80', fill: 'none', 'aria-hidden': 'true' });
    svg.append(grid); return svg;
  }
  function line(stroke) { return element('path', { d: path(stroke), fill: 'none', stroke: '#20392e', 'stroke-width': 110, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }); }
  function render(container, strokes, label = '原筆跡', hint = null) {
    const svg = frame(label);
    if (hint) {
      const model = element('g', { 'aria-hidden': 'true', 'data-hint': '', fill: '#bbc5b9', stroke: 'none' }), glyph = root.BishunCharacters?.[hint];
      if (glyph) {
        model.setAttribute('transform', 'translate(1000 8031.25) scale(7.8125 -7.8125)');
        for (const d of glyph.strokes) model.append(element('path', { d, fill: '#bbc5b9', stroke: 'none', 'aria-hidden': 'true' }));
      } else {
        const text = element('text', { x: 5000, y: 5200, 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-size': 7600, 'font-family': '"Noto Serif TC","Songti TC","PMingLiU",serif', fill: '#bbc5b9', stroke: 'none' });
        text.textContent = hint; model.append(text);
      }
      svg.append(model);
    }
    for (const stroke of strokes) svg.append(line(stroke)); container.replaceChildren(svg); return svg;
  }
  function capture(container, strokes, onStroke, hint = null) {
    const svg = render(container, strokes, '自由書寫格', hint), active = { pointer: null, points: [], path: null, started: 0 };
    let locked = false;
    function point(event) {
      const rect = svg.getBoundingClientRect(), bound = n => Math.max(0, Math.min(10000, Math.round(n)));
      return [bound((event.clientX - rect.left) / rect.width * 10000), bound((event.clientY - rect.top) / rect.height * 10000), Math.min(86400000, Math.max(0, Math.round(performance.now() - active.started)))];
    }
    function add(event) {
      const samples = event.getCoalescedEvents?.();
      for (const sample of samples?.length ? samples : [event]) active.points.push(point(sample));
      active.path.setAttribute('d', path(active.points));
    }
    function end(event) {
      if (active.pointer !== event.pointerId) return;
      add(event); commit();
    }
    function commit() {
      if (active.pointer === null) return;
      const stroke = active.points; active.pointer = null; active.points = []; active.path = null; onStroke(stroke);
    }
    svg.addEventListener('pointerdown', event => {
      if (locked || active.pointer !== null || event.button !== 0) return;
      event.preventDefault(); active.pointer = event.pointerId; active.started = performance.now(); active.path = line([]); svg.append(active.path); add(event);
      svg.setPointerCapture(event.pointerId);
    });
    svg.addEventListener('pointermove', event => { if (event.pointerId === active.pointer) { event.preventDefault(); add(event); } });
    svg.addEventListener('pointerup', end);
    for (const name of ['pointercancel', 'lostpointercapture']) svg.addEventListener(name, event => { if (event.pointerId === active.pointer) commit(); });
    return { lock(value) { locked = value; }, active() { return active.pointer !== null; }, flush: commit, dispose() { locked = true; container.replaceChildren(); } };
  }
  function replay(container, strokes) {
    const svg = render(container, []); let stopped = false, frameId;
    const points = strokes.reduce((total, stroke) => total + stroke.length, 0), duration = Math.max(600, Math.min(6000, points * 8)), started = performance.now();
    function tick(now) {
      if (stopped) return;
      let remaining = Math.max(1, Math.floor((now - started) / duration * points));
      svg.replaceChildren(frame('原筆跡重播').firstChild);
      for (const stroke of strokes) { if (remaining <= 0) break; svg.append(line(stroke.slice(0, remaining))); remaining -= stroke.length; }
      if (now - started < duration) frameId = requestAnimationFrame(tick);
    }
    frameId = requestAnimationFrame(tick);
    return () => { stopped = true; cancelAnimationFrame(frameId); };
  }
  let demoEngine = null;
  function demo(container, character, strokeIndex, onDone, onError) {
    // Hanzi Writer retains document listeners, so all hints share one stable target.
    if (!demoEngine) { const layer = document.createElement('div'); layer.className = 'assessment-demo'; layer.setAttribute('aria-hidden', 'true'); demoEngine = { layer, writer: null, data: null, ready: Promise.resolve(), cancel: null }; }
    const engine = demoEngine, layer = engine.layer, controller = new AbortController();
    engine.cancel?.(); container.append(layer);
    let alive = true, observer = null;
    function cancel() { if (!alive) return; alive = false; controller.abort(); observer?.disconnect(); engine.writer?.pauseAnimation(); layer.remove(); engine.cancel = null; }
    engine.cancel = cancel;
    Promise.resolve().then(async () => {
      if (!root.BishunWriting || !root.HanziWriter) throw new Error('筆順未能播放。');
      const data = await root.BishunWriting.loadCharacter(character, controller.signal);
      if (!alive) return;
      const size = container.getBoundingClientRect().width;
      if (!engine.writer) engine.writer = new root.HanziWriter(layer, { width: size, height: size, padding: size * .1, showCharacter: false, showOutline: false, strokeColor: '#48735b', strokeAnimationSpeed: .45, delayBetweenStrokes: 520, charDataLoader: (value, loaded) => loaded(engine.data) });
      engine.ready = engine.ready.catch(() => {}).then(() => { if (!alive) return; engine.data = data; engine.writer.updateDimensions({ width: size, height: size, padding: size * .1 }); return engine.writer.setCharacter(character); });
      await engine.ready;
      if (!alive) return;
      if (root.ResizeObserver) { observer = new root.ResizeObserver(() => { const width = container.getBoundingClientRect().width; engine.writer.updateDimensions({ width, height: width, padding: width * .1 }); }); observer.observe(container); }
      await engine.writer.animateStroke(Math.min(Math.max(0, strokeIndex), data.strokes.length - 1));
      if (alive) { cancel(); onDone(); }
    }).catch(() => { if (alive) { cancel(); onError('筆順未能播放，請繼續書寫。'); } });
    return cancel;
  }
  const api = { render, capture, replay, demo };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.BishunFreehand = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
