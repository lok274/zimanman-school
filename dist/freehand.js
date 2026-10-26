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
  const api = { render, replay };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.BishunFreehand = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
