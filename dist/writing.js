(function (root) {
  'use strict';
  const parts = {
    粗: [[6, '米', '米'], [11, '且', '右邊部件']],
    濃: [[3, '氵', '左邊三點水'], [9, '曲', '右上部件'], [16, '辰', '右下部件']],
    鬍: [[10, '髟', '上面部件'], [15, '古', '左下部件'], [19, '月', '右下月字部件']],
    鬚: [[10, '髟', '上面部件'], [13, '彡', '左下三撇'], [22, '頁', '右下部件']],
    密: [[3, '宀', '寶蓋頭'], [8, '必', '中間部件'], [11, '山', '下面山字部件']],
    剪: [[9, '前', '上面前字部件'], [11, '刀', '下面刀字部件']],
    草: [[4, '艹', '草字頭'], [10, '早', '下面早字部件']],
    機: [[4, '木', '左邊木字部件'], [16, '幾', '右邊部件']],
    推: [[3, '扌', '左邊提手旁'], [11, '隹', '右邊部件']],
    來: [[8, '來', '成個來字']],
    去: [[3, '土', '上面土字部件'], [5, '厶', '下面部件']]
  };
  function activePart(character, data, stroke) {
    const ranges = parts[character];
    return ranges && data && data.strokes.length === ranges.at(-1)[0] && Number.isInteger(stroke) && stroke >= 0 ? ranges.find(part => stroke < part[0]) || null : null;
  }
  function initialCue(points) {
    const prefix = [points[0]];
    let length = 0, previous = null;
    for (let index = 1; index < points.length && length < 85; index++) {
      const from = prefix.at(-1), dx = points[index][0] - from[0], dy = points[index][1] - from[1], distance = Math.hypot(dx, dy);
      if (distance < 1) continue;
      const direction = [dx / distance, dy / distance];
      if (previous && previous[0] * direction[0] + previous[1] * direction[1] < 0.5) break;
      const step = Math.min(distance, 85 - length);
      prefix.push([from[0] + direction[0] * step, from[1] + direction[1] * step]);
      length += step; previous = direction;
    }
    if (length < 35) return null;
    const from = prefix[0], to = prefix[1], angle = Math.atan2(to[1] - from[1], to[0] - from[0]);
    const direction = ['右', '右上', '上', '左上', '左', '左下', '下', '右下'][(Math.round(angle / (Math.PI / 4)) + 8) % 8];
    return { points: prefix, direction };
  }
  function guide(character, data, stroke) {
    const part = activePart(character, data, stroke);
    if (!part) return null;
    const cue = initialCue(data.medians[stroke]);
    return { label: part[1], instruction: '寫' + part[2] + '。由橙點開始，' + (cue ? '向' + cue.direction + '起筆，慢慢寫。' : '跟住提示慢慢寫。') };
  }
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
  let practiceSession = null, partial = null;
  const originals = new Map();
  function resetPractice(sessionId) { practiceSession = sessionId; partial = null; originals.clear(); }
  function sameAttempt(left, right) { return left && right && left.sessionId === right.sessionId && left.occurrenceId === right.occurrenceId && left.attemptId === right.attemptId; }
  function boundedStroke(points) {
    if (points.length <= 256) return points.map(point => ({ x: point.x, y: point.y }));
    const distances = [0];
    for (let index = 1; index < points.length; index++) distances.push(distances[index - 1] + Math.hypot(points[index].x - points[index - 1].x, points[index].y - points[index - 1].y));
    const result = [{ ...points[0] }], length = distances.at(-1);
    let index = 1;
    for (let sample = 1; sample < 255; sample++) {
      const distance = length * sample / 255;
      while (index < points.length - 1 && distances[index] < distance) index++;
      const from = points[index - 1], to = points[index], span = distances[index] - distances[index - 1];
      const ratio = span ? (distance - distances[index - 1]) / span : 0;
      result.push({ x: from.x + (to.x - from.x) * ratio, y: from.y + (to.y - from.y) * ratio });
    }
    result.push({ ...points.at(-1) }); return result;
  }
  function drawOriginal(group, strokes) {
    group.replaceChildren();
    strokes.forEach(points => {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', points.map((point, index) => (index ? 'L' : 'M') + point.x + ' ' + point.y).join(' '));
      path.setAttribute('fill', 'none'); path.setAttribute('stroke', '#214b3b'); path.setAttribute('stroke-width', '8');
      path.setAttribute('vector-effect', 'non-scaling-stroke'); path.setAttribute('stroke-linecap', 'round'); path.setAttribute('stroke-linejoin', 'round'); group.append(path);
    });
  }
  function renderOriginal(element, identity) {
    const original = identity && originals.get(identity.occurrenceId);
    element.replaceChildren();
    if (practiceSession !== identity?.sessionId || !sameAttempt(original, identity)) return false;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'), group = document.createElementNS(svg.namespaceURI, 'g');
    svg.setAttribute('viewBox', '0 0 360 360'); svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('class', 'original-ink');
    group.setAttribute('transform', root.HanziWriter.getScalingTransform(360, 360, 24).transform);
    drawOriginal(group, original.strokes); svg.append(group); element.append(svg); element.style.visibility = ''; return true;
  }
  // Hanzi Writer keeps document listeners, so each stable target owns one engine.
  const engines = new WeakMap();
  function mount(element, character, data, options) {
    const quiz = options.phase === 'quiz', identity = options.identity;
    const practice = !!identity && ['guided', 'recall'].includes(options.phase);
    const componentGuided = options.phase === 'guided' && !!activePart(character, data, options.currentStroke || 0);
    const guidedComplete = options.complete || options.phase === 'guided' && options.currentStroke === data.strokes.length;
    let alive = true, suspended = false, currentStroke = options.currentStroke || 0, paused = false, playing = false, nextIndex = 0, demoRun = 0;
    const size = Math.round(element.getBoundingClientRect().width) || 360;
    let engine = engines.get(element);
    if (!engine) {
      engine = { data, ready: Promise.resolve() };
      engine.writer = new root.HanziWriter(element, {
        width: size, height: size, padding: 24, showCharacter: false, showOutline: false,
        strokeColor: '#214b3b', outlineColor: '#d7ddd4', drawingColor: '#214b3b', highlightColor: '#ba642d', drawingWidth: 8,
        strokeAnimationSpeed: 0.45, delayBetweenStrokes: 520, strokeFadeDuration: 140, strokeHighlightSpeed: 0.65,
        showHintAfterMisses: false, highlightOnComplete: false, markStrokeCorrectAfterMisses: false, acceptBackwardsStrokes: false, leniency: 1.65,
        charDataLoader: (_char, done) => done(engine.data)
      });
      engines.set(element, engine);
    }
    const writer = engine.writer, generation = (engine.generation || 0) + 1;
    engine.generation = generation;
    const current = () => alive && !suspended && generation === engine.generation && (!options.isCurrent || options.isCurrent()) && (!practice || practiceSession === identity.sessionId && sameAttempt(partial, identity));
    if (practice && !sameAttempt(partial, identity)) partial = { ...identity, strokes: [] };
    if (!quiz || engine.inkToken !== options.token) { engine.inkToken = quiz ? options.token : null; engine.ink = []; }
    const ink = practice ? partial.strokes : engine.ink;
    function fail(error) {
      if (!alive || suspended) return;
      suspended = true; writer.cancelQuiz(); element.style.visibility = 'hidden';
      if (options.onError) options.onError(error);
    }
    element.style.visibility = 'hidden';
    const ns = 'http://www.w3.org/2000/svg';
    const overlay = document.createElementNS(ns, 'svg'); overlay.setAttribute('class', 'start-overlay'); overlay.setAttribute('aria-hidden', 'true');
    const group = document.createElementNS(ns, 'g'); overlay.append(group);
    const focus = componentGuided ? document.createElementNS(ns, 'g') : null; if (focus) group.append(focus);
    const dot = document.createElementNS(ns, 'circle'); dot.setAttribute('r', '16'); dot.setAttribute('fill', '#bf6c36'); dot.setAttribute('stroke', '#fffaf0'); dot.setAttribute('stroke-width', '7'); group.append(dot); element.append(overlay);
    const inkGroup = document.createElementNS(ns, 'g'); group.append(inkGroup);
    function drawInk() { drawOriginal(inkGroup, ink); }
    drawInk();
    if (componentGuided) element.insertBefore(overlay, element.firstChild);
    const direction = componentGuided ? document.createElementNS(ns, 'path') : null;
    if (direction) { direction.setAttribute('class', 'stroke-direction'); direction.setAttribute('fill', 'none'); direction.setAttribute('stroke', '#bf6c36'); direction.setAttribute('stroke-width', '12'); direction.setAttribute('stroke-linecap', 'round'); direction.setAttribute('stroke-linejoin', 'round'); group.append(direction); }
    const help = quiz ? [] : options.help || [];
    let directionVisible = componentGuided && (options.missesOnCurrentStroke > 0 || help.some(item => item.kind === 'stroke' && item.strokeIndex === currentStroke));
    let startVisible = options.phase === 'guided' || help.length > 0;
    function drawFocus() {
      if (!componentGuided) return;
      focus.replaceChildren();
      const part = activePart(character, data, currentStroke);
      if (!part) return;
      for (let index = data.strokes.length - 1; index >= currentStroke; index--) {
        const path = document.createElementNS(ns, 'path'); path.setAttribute('d', data.strokes[index]);
        path.setAttribute('fill', index < part[0] ? '#9eafa0' : '#e6eae3'); focus.append(path);
      }
    }
    drawFocus();
    function placeStart() {
      const n = Math.round(element.getBoundingClientRect().width) || size;
      overlay.setAttribute('viewBox', '0 0 ' + n + ' ' + n);
      group.setAttribute('transform', root.HanziWriter.getScalingTransform(n, n, 24).transform);
      const p = data.medians[currentStroke] && data.medians[currentStroke][0];
      dot.style.display = startVisible && p ? '' : 'none';
      if (p) { dot.setAttribute('cx', p[0]); dot.setAttribute('cy', p[1]); }
      if (!componentGuided) return;
      direction.style.display = 'none';
      const cue = directionVisible && p && initialCue(data.medians[currentStroke]);
      if (cue) {
        const points = cue.points, tip = points.at(-1), before = points.at(-2), angle = Math.atan2(tip[1] - before[1], tip[0] - before[0]);
        const head = [-0.65, 0.65].map(turn => [tip[0] - 19 * Math.cos(angle + turn), tip[1] - 19 * Math.sin(angle + turn)]);
        direction.setAttribute('d', points.map((point, index) => (index ? 'L' : 'M') + point.join(' ')).join(' ') + ' M' + head[0].join(' ') + ' L' + tip.join(' ') + ' L' + head[1].join(' '));
        direction.style.display = '';
      }
    }
    placeStart();
    engine.ready = engine.ready.then(async () => {
      if (!alive) return;
      if ((quiz || practice) && (practice && practiceSession !== identity.sessionId || ink.length !== currentStroke)) throw new Error('原有筆跡未能還原，請重新試一次。');
      engine.data = data;
      await writer.setCharacter(character);
      if (!alive) return;
      await Promise.all(Object.entries({ strokeColor: '#214b3b', radicalColor: '#214b3b', outlineColor: '#d7ddd4', highlightColor: '#ba642d' }).map(([key, color]) => writer.updateColor(key, (quiz || practice && ['strokeColor', 'radicalColor'].includes(key)) ? 'rgba(33,75,59,0)' : color, { duration: 0 })));
      if (!alive) return;
      await Promise.all([writer.hideCharacter({ duration: 0 }), writer.hideOutline({ duration: 0 })]);
      if (!alive) return;
      if (!componentGuided && !guidedComplete && (options.phase === 'guided' || help.some(item => item.kind === 'outline'))) await writer.showOutline({ duration: 0 });
      if (guidedComplete && !practice) await writer.showCharacter({ duration: 0 });
      if (!alive) return;
      writer.updateDimensions({ width: size, height: size, padding: 24 }); placeStart();
      if (!suspended && !guidedComplete && ['guided', 'recall', 'quiz'].includes(options.phase)) await writer.quiz({ quizStartStrokeNum: currentStroke,
        onCorrectStroke: event => { if (!current()) return;
          if (quiz || practice) {
            const points = event.drawnPath && event.drawnPath.points;
            if (event.strokeNum !== currentStroke || !Array.isArray(points) || points.length < 2 || points.length > 16384 || points.some(point => !point || !Number.isFinite(point.x) || !Number.isFinite(point.y) || Math.abs(point.x) > 8192 || Math.abs(point.y) > 8192)) { fail(new Error('筆跡資料無效，請重新試一次。')); return; }
            ink.push(practice ? boundedStroke(points) : points.map(point => ({ x: point.x, y: point.y }))); drawInk();
          }
          currentStroke = event.strokeNum + 1; directionVisible = false; drawFocus(); placeStart(); options.onEvent({ type: 'STROKE_ACCEPTED', token: options.token, strokeIndex: event.strokeNum }); },
        onMistake: event => { if (current()) { if (componentGuided) { directionVisible = true; placeStart(); } options.onEvent({ type: 'STROKE_MISSED', token: options.token, strokeIndex: event.strokeNum }); } },
        onComplete: () => {
          if (!current()) return;
          if (practice) {
            if (currentStroke !== data.strokes.length || ink.length !== currentStroke) { fail(new Error('原有筆跡未能還原，請重新試一次。')); return; }
            originals.set(identity.occurrenceId, { ...identity, strokes: ink.slice() });
          }
          options.onEvent({ type: 'WRITING_COMPLETE', token: options.token, at: Date.now() });
        }
      });
      if (alive && !suspended) { element.style.visibility = ''; if (options.onReady) options.onReady(); }
    }).catch(fail);
    function ready(action) { engine.ready.then(() => { if (alive && !suspended) action(); }).catch(fail); }
    const observer = new ResizeObserver(() => {
      if (!alive) return;
      const n = Math.round(element.getBoundingClientRect().width);
      if (n > 0) { writer.updateDimensions({ width: n, height: n, padding: 24 }); placeStart(); }
    }); observer.observe(element);
    function demoDone(run, result, fullCharacter = false) {
      if (!alive || suspended || run !== demoRun) return;
      playing = false; paused = false; options.onDemoState && options.onDemoState('stopped');
      if (fullCharacter && result && result.canceled === false && options.onCharacterDemoComplete) options.onCharacterDemoComplete();
    }
    return {
      play(replay) {
        if (!alive || options.phase !== 'watch') return;
        if (paused && !replay) { ready(() => writer.resumeAnimation()); paused = false; playing = true; }
        else { const run = ++demoRun; nextIndex = 0; playing = true; paused = false; ready(() => writer.animateCharacter().then(result => demoDone(run, result, true))); }
        options.onDemoState && options.onDemoState('playing');
      },
      pause() { if (!alive) return; ready(() => writer.pauseAnimation()); if (playing) { paused = true; options.onDemoState && options.onDemoState('paused'); } },
      nextStroke() {
        if (!alive || options.phase !== 'watch') return;
        paused = false; playing = true;
        const run = ++demoRun;
        const index = nextIndex; nextIndex = (nextIndex + 1) % data.strokes.length;
        ready(() => { writer.resumeAnimation(); writer.animateStroke(index).then(() => demoDone(run)); });
        options.onDemoState && options.onDemoState('playing');
      },
      showHelp(kind) {
        if (quiz || guidedComplete || !alive) return;
        const expectedStroke = currentStroke;
        ready(() => {
          if (currentStroke !== expectedStroke) return;
          if (kind === 'outline' && !componentGuided) writer.showOutline({ duration: 0 });
          if (componentGuided && kind === 'stroke') directionVisible = true;
          startVisible = true; placeStart();
          if (kind === 'stroke' && currentStroke < data.strokes.length) writer.highlightStroke(currentStroke);
        });
      },
      suspend() { suspended = true; writer.cancelQuiz(); writer.pauseAnimation(); },
      dispose() { alive = false; observer.disconnect(); writer.cancelQuiz(); writer.pauseAnimation(); overlay.remove(); element.style.visibility = 'hidden'; }
    };
  }
  const api = { validateCharacter, loadCharacter, guide, mount, resetPractice, renderOriginal };
  root.BishunWriting = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
