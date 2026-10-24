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
  function render(container, strokes, label = '原筆跡') {
    const svg = frame(label); for (const stroke of strokes) svg.append(line(stroke)); container.replaceChildren(svg); return svg;
  }
  function capture(container, strokes, onStroke) {
    const svg = render(container, strokes, '自由書寫格'), active = { pointer: null, points: [], path: null, started: 0 };
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
  const api = { render, capture, replay };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.BishunFreehand = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
