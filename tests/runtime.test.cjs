'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const S = require('../dist/session.js');
const assigned = text => S.parseEntries(text).map(entry => ({ ...entry, selectedIndexes: entry.characters.map((_, index) => index) }));
const source = file => fs.readFileSync(path.join(__dirname, '../dist', file), 'utf8');

class Node {
  constructor(name, value = '') {
    this.nodeName = name; this.nodeType = name === '#text' ? 3 : 1; this.nodeValue = value;
    this.childNodes = []; this.attributes = {}; this.listeners = {}; this.style = { removeProperty(name) { delete this[name]; } };
    this.animations = []; this.textWrites = 0;
    this.classList = { toggle: (name, value) => { const names = new Set(this.className.split(' ').filter(Boolean)); if (value) names.add(name); else names.delete(name); this.className = [...names].join(' '); } };
  }
  get parentElement() { return this.parentNode; }
  get className() { return this.attributes.class || ''; }
  set className(value) { this.attributes.class = value; }
  get textContent() { return this.nodeType === 3 ? this.nodeValue : this.childNodes.map(node => node.textContent).join(''); }
  set textContent(value) { this.textWrites++; if (this.nodeType === 3) this.nodeValue = value; else this.replaceChildren(new Node('#text', String(value))); }
  set innerHTML(value) { assert.equal(value, ''); this.replaceChildren(); }
  append(...nodes) { nodes.forEach(node => this.appendChild(typeof node === 'string' ? new Node('#text', node) : node)); }
  appendChild(node) { node.remove(); node.parentNode = this; this.childNodes.push(node); return node; }
  removeChild(node) { this.childNodes.splice(this.childNodes.indexOf(node), 1); node.parentNode = null; return node; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  replaceWith(node) { const parent = this.parentNode; if (!parent) return; const index = parent.childNodes.indexOf(this); node.remove(); parent.childNodes[index] = node; node.parentNode = parent; this.parentNode = null; }
  replaceChildren(...nodes) { this.childNodes.forEach(node => { node.parentNode = null; }); this.childNodes = []; this.append(...nodes); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  setAttributeNS(_ns, name, value) { this.setAttribute(name, value); }
  removeAttribute(name) { delete this.attributes[name]; }
  closest(selector) { const tags = selector.split(',').map(s => s.trim().toUpperCase()); let node = this; while (node) { if (tags.includes(node.nodeName.toUpperCase())) return node; node = node.parentNode; } return null; }
  addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); }
  emit(name, event = {}) { (this.listeners[name] || []).forEach(fn => fn({ preventDefault() {}, ...event })); }
  click() { if (!this.disabled) this.emit('click'); }
  showModal() { this.open = true; }
  close() { this.open = false; }
  animate(keyframes, options) { const animation = { keyframes, options, cancelled: false, cancel() { this.cancelled = true; } }; this.animations.push(animation); return animation; }
  getBoundingClientRect() { return { width: 360, height: 360, left: 0, top: 0 }; }
}
function walk(node) { return [node, ...node.childNodes.flatMap(walk)]; }
function environment(html = '<html><body><div id="writer"></div></body></html>') {
  const document = new Node('#document'); let current = document;
  for (const token of html.match(/<[^>]+>|[^<]+/g)) {
    if (/^<!/.test(token)) continue;
    if (/^<\//.test(token)) { current = current.parentNode; continue; }
    if (token.startsWith('<')) {
      const tag = token.match(/^<([^\s/>]+)/)[1], node = new Node(tag);
      for (const attr of token.slice(tag.length + 1, -1).matchAll(/([^\s=/>]+)(?:="([^"]*)")?/g)) { node.setAttribute(attr[1], attr[2] || ''); if (attr[1] === 'hidden') node.hidden = true; }
      current.append(node);
      if (!/^(meta|link|input|br)$/i.test(tag) && !token.endsWith('/>')) current = node;
    } else current.append(new Node('#text', token));
  }
  document.documentElement = document.childNodes.find(node => node.nodeName === 'html');
  document.body = walk(document).find(node => node.nodeName === 'body');
  document.createElement = tag => new Node(tag);
  document.createElementNS = (namespaceURI, tag) => Object.assign(new Node(tag), { namespaceURI });
  document.createTextNode = text => new Node('#text', text);
  document.getElementById = id => walk(document).find(node => node.attributes.id === id);
  document.querySelectorAll = selector => walk(document).filter(node => selector === '[data-stage]' ? 'data-stage' in node.attributes : selector.startsWith('.') && node.className.split(' ').includes(selector.slice(1)));
  document.querySelector = selector => document.querySelectorAll(selector)[0];
  document.createTreeWalker = node => { const nodes = walk(node).filter(item => item.nodeType === 3); let index = 0; return { nextNode: () => nodes[index++] || null }; };
  const store = new Map(), voices = { current: [], changed: null, spoken: [], cancels: 0 };
  const storage = { get length() { return store.size; }, key: i => [...store.keys()][i], getItem: key => store.get(key) || null, setItem: (key, value) => store.set(key, value) };
  const observers = new Set(), windowListeners = {}, motion = { reduced: false }; let nextId = 0;
  document.hidden = false;
  const context = vm.createContext({ document, console, setTimeout, clearTimeout, performance, AbortController, NodeFilter: { SHOW_TEXT: 4 },
    localStorage: storage, sessionStorage: storage, crypto: { randomUUID: () => 'runtime-test-' + ++nextId },
    ResizeObserver: class { observe() { observers.add(this); } disconnect() { observers.delete(this); } },
    speechSynthesis: { getVoices: () => voices.current, cancel() { voices.cancels++; }, speak(utterance) { if (voices.fail) throw new Error("speech blocked"); voices.spoken.push(utterance); }, addEventListener(_name, fn) { voices.changed = fn; } },
    SpeechSynthesisUtterance: class { constructor(text) { this.text = text; } }, matchMedia: () => ({ matches: motion.reduced }), addEventListener(name, fn) { (windowListeners[name] ||= []).push(fn); }
  });
  context.window = context; context.location = { href: 'http://localhost/' };
  return { context, document, voices, store, observers, motion, emitWindow: name => (windowListeners[name] || []).forEach(fn => fn()), $: document.getElementById };
}
function recallSnapshot(character) {
  let state = S.createSession({ id: 'recall-test', entries: assigned(character), startedAt: 1 });
  for (const event of [{ type: 'CHOOSE_WORD', wordId: 'w0' }, { type: 'DATA_READY', strokeCount: 1 }, { type: 'START_GUIDED' }, { type: 'STROKE_ACCEPTED', strokeIndex: 0 }, { type: 'WRITING_COMPLETE' }, { type: 'START_RECALL' }]) state = S.transition(state, { at: 2, token: state.active.token, newToken: event.type, ...event });
  assert.equal(state.active.phase, 'recall'); return state;
}
function visibleText(document) {
  return walk(document.documentElement).filter(node => {
    if (node.nodeType !== 3 || node.parentElement.closest('script, style, svg, textarea')) return false;
    for (let parent = node.parentNode; parent; parent = parent.parentNode) if (parent.hidden || (parent.nodeName === 'dialog' && !parent.open)) return false;
    return true;
  }).map(node => node.nodeValue).join('');
}

test('the six word cues use photos with empty alt text and retain SVG fallback', () => {
  const words = ['粗', '濃', '鬍鬚', '密', '剪草機', '推來推去'];
  const e = environment(source('index.html'));
  e.context.BishunSession = { ...S, createSession: options => S.createSession({ ...options, entries: assigned(words.join('\n')) }) };
  e.context.BishunWriting = {};
  vm.runInContext(source('content.js'), e.context); vm.runInContext(source('app.js'), e.context);
  const photos = walk(e.$('word-cards')).filter(node => node.nodeName === 'img');
  assert.equal(photos.length, 6);
  assert.equal(new Set(photos.map(image => image.attributes.src)).size, 6);
  assert(photos.every(image => image.attributes.alt === ''));
  photos[0].emit('error');
  const firstCard = e.$('word-cards').childNodes[0];
  assert(walk(firstCard).some(node => node.nodeName === 'svg'), 'failed photo falls back to its word cue');
  assert(!walk(firstCard).some(node => node.nodeName === 'img'));
  for (const word of [...words, '朋友']) {
    const practice = environment(source('index.html'));
    let initial = S.createSession({ id: 'photo-practice', entries: assigned(word), startedAt: 1 });
    for (const event of [{ type: 'CHOOSE_WORD', wordId: 'w0' }, { type: 'DATA_READY', strokeCount: 1 }]) initial = S.transition(initial, { at: 2, token: initial.active.token, newToken: 'watch', ...event });
    practice.context.BishunSession = { ...S, createSession: () => structuredClone(initial) }; practice.context.BishunWriting = {};
    vm.runInContext(source('content.js'), practice.context); vm.runInContext(source('app.js'), practice.context);
    const cue = practice.$('semantic-cue').childNodes[0];
    assert.equal(cue.nodeName, words.includes(word) ? 'img' : 'svg');
    if (cue.nodeName === 'img') { assert.equal(cue.attributes.alt, ''); cue.emit('error'); assert.equal(practice.$('semantic-cue').childNodes[0].nodeName, 'svg'); }
  }
});
test('recall conceals generic targets in live labels and late voice messages, then restores labels', () => {
  for (const character of ['一', '字', '我', '機']) {
    const e = environment(source('index.html')), initial = recallSnapshot(character);
    e.context.BishunSession = { ...S, createSession: () => structuredClone(initial) };
    e.context.BishunWriting = {};
    e.context.BishunContent = { words: [character], cue: () => ['例子', 'M1 1L2 2'] };
    vm.runInContext(source('app.js'), e.context);
    assert(!visibleText(e.document).includes(character), character + ' concealed at recall render');
    e.$('speak').click();
    assert(!visibleText(e.document).includes(character), character + ' concealed after missing-voice fallback');
    e.voices.current = [{ lang: 'yue-HK', name: character + '聲音' }]; e.voices.changed();
    assert(!visibleText(e.document).includes(character), character + ' concealed after late voiceschanged');
    e.$('teacher-end').click();
    assert(e.document.querySelector('.brand').textContent.includes('字慢慢'));
    const saved = [...e.store.values()].map(value => { try { return JSON.parse(value); } catch { return null; } }).find(value => value && value.id === initial.id);
    assert.equal(saved.attempts.at(-1).help.length, 0, 'masking itself never records assistance');
  }
});
test('skipped word card shows pending practice instead of a completion stamp', () => {
  const e = environment(source('index.html'));
  let initial = recallSnapshot('一');
  initial = S.transition(initial, { type: 'TEACHER_SKIP', token: initial.active.token, at: 3 });
  initial = { ...initial, active: { phase: 'choose-word' } };
  e.context.BishunSession = { ...S, createSession: () => structuredClone(initial) };
  e.context.BishunWriting = {};
  e.context.BishunContent = { words: ['一'], cue: () => ['例子', 'M1 1L2 2'] };
  vm.runInContext(source('app.js'), e.context);
  assert(e.$('word-cards').textContent.includes('有字待練'));
  assert(!e.$('word-cards').textContent.includes('完成今次練習'));
});
test('history counts each character once while retaining assisted and independent attempts', () => {
  const e = environment(source('index.html'));
  let snapshot = recallSnapshot('機');
  for (const event of [{ type: 'REQUEST_HELP', kind: 'outline' }, { type: 'STROKE_ACCEPTED', strokeIndex: 0 }, { type: 'WRITING_COMPLETE' }, { type: 'RETRY' }, { type: 'STROKE_ACCEPTED', strokeIndex: 0 }, { type: 'WRITING_COMPLETE' }, { type: 'END_SESSION' }]) snapshot = S.transition(snapshot, { at: 3, token: snapshot.active.token, newToken: 'unassisted-retry', ...event });
  e.store.set('bishun-school:v1:' + snapshot.id, JSON.stringify(snapshot));
  e.context.BishunSession = S; e.context.BishunWriting = {};
  e.context.BishunContent = { words: ['一'], cue: () => ['例子', 'M1 1L2 2'] };
  vm.runInContext(source('app.js'), e.context);
  e.$('teacher-open').click();
  const history = e.$('local-history').textContent;
  assert(history.includes('自己完成 1 · 有提示完成 0 · 跳過 0 · 待練 0'));
  assert(history.includes('自己試 完成，提示 1 次'));
  assert(history.includes('自己試 完成，提示 0 次'));
});
test('recent history remains discoverable after more than 500 existing storage keys', () => {
  const e = environment(source('index.html'));
  for (let index = 0; index < 500; index++) e.store.set('other-app-' + index, 'unrelated');
  const latest = S.createSession({ id: 'newest-at-last', entries: assigned('機'), startedAt: Date.now() + 1000 });
  e.store.set('bishun-school:v1:' + latest.id, JSON.stringify(latest));
  e.context.BishunSession = S; e.context.BishunWriting = {};
  e.context.BishunContent = { words: ['一'], cue: () => ['例子', 'M1 1L2 2'] };
  vm.runInContext(source('app.js'), e.context);
  e.$('teacher-open').click();
  assert(e.$('local-history').textContent.includes('機'));
});
async function waitFor(predicate) { const end = Date.now() + 2000; while (!predicate()) { assert(Date.now() < end, 'runtime initialization completed'); await new Promise(resolve => setTimeout(resolve, 10)); } }
async function feedbackApp(character = '粗', strokeCount = 2) {
  const e = environment(source('index.html')); e.mounts = [];
  e.context.BishunSession = S;
  e.context.BishunContent = { words: [character], cue: () => ['例子', 'M1 1L2 2'] };
  e.context.HanziWriter = {};
  e.context.BishunWriting = {
    loadCharacter: () => Promise.resolve({ strokes: Array(strokeCount).fill('M1 1L2 2') }),
    mount(_element, _character, _data, options) { e.mounts.push(options); return { dispose() {}, pause() {}, suspend() {}, showHelp() {} }; }
  };
  vm.runInContext(source('app.js'), e.context);
  e.snapshot = () => [...e.store.values()].map(value => { try { return JSON.parse(value); } catch { return null; } }).find(value => value && value.active);
  e.send = (type, extra = {}, mount = e.mounts.at(-1)) => mount.onEvent({ type, token: mount.token, ...extra });
  e.complete = () => { for (let index = e.snapshot().active.currentStroke; index < strokeCount; index++) e.send('STROKE_ACCEPTED', { strokeIndex: index }); e.send('WRITING_COMPLETE'); };
  e.$('word-cards').childNodes[0].click(); await waitFor(() => e.mounts.length === 1);
  e.$('main-next').click(); assert.equal(e.snapshot().active.phase, 'guided');
  return e;
}
function audioMock(e, { pending = false, fail = false } = {}) {
  const contexts = [], resumes = [], oscillators = [];
  e.context.AudioContext = class {
    constructor() { this.state = 'suspended'; this.currentTime = 0; this.destination = {}; this.closed = false; contexts.push(this); }
    resume() {
      if (pending) return new Promise((resolve, reject) => resumes.push({ resolve: () => { this.state = 'running'; resolve(); }, reject }));
      if (fail) return Promise.reject(new Error('blocked'));
      this.state = 'running'; return Promise.resolve();
    }
    createOscillator() { const oscillator = { frequency: { setValueAtTime() {} }, connect() {}, disconnect() { this.disconnected = true; }, start() { this.started = true; }, stop(at) { if (at === undefined) this.cancelled = true; } }; oscillators.push(oscillator); return oscillator; }
    createGain() { return { gain: { setValueAtTime() {}, linearRampToValueAtTime() {} }, connect() {}, disconnect() {} }; }
    close() { this.closed = true; this.state = 'closed'; return Promise.resolve(); }
  };
  return { contexts, resumes, oscillators };
}
test('feedback follows accepted strokes, changes progress and recognizes only observed recovery', async () => {
  const e = await feedbackApp('粗', 3), icon = e.$('feedback-icon');
  assert.equal(e.$('feedback-text').textContent, '由起點開始，慢慢寫。');
  assert.notEqual(icon.textContent, '✓');
  e.send('STROKE_ACCEPTED', { strokeIndex: 0 });
  assert.equal(e.$('feedback-text').textContent, '完成第 1 畫！'); assert.equal(icon.textContent, '✓');
  e.send('STROKE_MISSED', { strokeIndex: 1 });
  assert.equal(e.$('feedback').attributes['data-kind'], 'support'); assert.notEqual(icon.textContent, '✓');
  e.send('STROKE_ACCEPTED', { strokeIndex: 1 });
  assert.equal(e.$('feedback-text').textContent, '再試後，完成第 2 畫！');
  e.send('STROKE_ACCEPTED', { strokeIndex: 2 });
  assert.equal(e.$('feedback-text').textContent, '完成第 3 畫！'); assert.equal(icon.animations.length, 0);
  const acceptedText = e.$('feedback-text').textContent, saved = JSON.stringify(e.snapshot()), writes = e.$('feedback-text').textWrites;
  e.send('STROKE_ACCEPTED', { strokeIndex: 2 }); e.send('STROKE_MISSED', { strokeIndex: 0, token: 'stale' });
  assert.equal(e.$('feedback-text').textContent, acceptedText); assert.equal(e.$('feedback-text').textWrites, writes); assert.equal(JSON.stringify(e.snapshot()), saved);
});
test('three completion labels celebrate once, while premature callbacks and voice updates do not', async () => {
  const e = await feedbackApp(), icon = e.$('feedback-icon');
  e.send('WRITING_COMPLETE'); assert.equal(icon.animations.length, 0);
  e.complete(); assert.equal(e.$('feedback').attributes['data-kind'], 'complete-guided'); assert(e.$('feedback-text').textContent.includes('跟寫完成')); assert.equal(icon.animations.length, 1);
  e.send('WRITING_COMPLETE'); e.voices.changed(); assert.equal(icon.animations.length, 1);
  e.$('main-next').click(); e.$('hint-outline').click(); e.complete();
  assert.equal(e.$('feedback').attributes['data-kind'], 'complete-assisted'); assert(e.$('feedback-text').textContent.includes('有提示完成')); assert.equal(icon.animations.length, 2);
  e.$('retry-writing').click(); e.complete();
  assert.equal(e.$('feedback').attributes['data-kind'], 'complete-independent'); assert(e.$('feedback-text').textContent.includes('自己完成')); assert.equal(icon.animations.length, 3);
  e.send('WRITING_COMPLETE'); e.voices.changed(); assert.equal(icon.animations.length, 3);
  const row = S.summarize(e.snapshot())[0]; assert(row.assisted && row.independent); assert.equal(row.attempts.length, 3);
});
test('help, restart, rest, teacher skip and rejected callbacks never manufacture completion', async () => {
  const e = await feedbackApp(), icon = e.$('feedback-icon');
  e.send('STROKE_MISSED', { strokeIndex: 0 }); e.$('hint-stroke').click();
  assert.equal(icon.animations.length, 0); assert.equal(e.snapshot().attempts.at(-1).help.length, 1);
  const old = e.mounts.at(-1); e.$('retry-writing').click();
  assert.equal(e.snapshot().attempts[0].outcome, 'abandoned'); assert.equal(e.snapshot().attempts[0].mistakes, 1);
  e.send('STROKE_ACCEPTED', { strokeIndex: 0 }); assert.equal(e.$('feedback').attributes['data-kind'], 'step', 'new attempt does not invent a recovered miss');
  e.$('rest').click(); const saved = JSON.stringify(e.snapshot());
  e.send('STROKE_ACCEPTED', { strokeIndex: 1 }); e.send('WRITING_COMPLETE');
  assert.equal(JSON.stringify(e.snapshot()), saved); assert.equal(icon.animations.length, 0);
  e.$('resume').click(); e.send('WRITING_COMPLETE', {}, old); assert.equal(icon.animations.length, 0);
  assert(e.$('feedback-text').textContent.includes('休息完')); assert.equal(e.snapshot().attempts.at(-1).outcome, 'active');
  e.$('teacher-open').click(); e.$('teacher-skip').click();
  assert.equal(e.$('feedback').attributes['data-kind'], 'instruction'); assert.equal(icon.animations.length, 0); assert.equal(e.snapshot().attempts.at(-1).outcome, 'skipped');
});
test('recall chooses readable feedback and sound labels without leaking arbitrary target characters', async () => {
  for (const character of ['一', '字', '完', '音', '聲', '再', '寫', '返', '跟', '睇', '上', '步']) {
    const e = await feedbackApp(character, 3); e.complete(); e.$('main-next').click();
    e.send('STROKE_ACCEPTED', { strokeIndex: 0 });
    const initialText = e.$('feedback-text').textContent;
    assert(!initialText.includes(character)); assert(!initialText.includes('□')); assert(initialText.includes('1'));
    e.send('STROKE_MISSED', { strokeIndex: 1 }); assert(!e.$('feedback-text').textContent.includes('□'));
    e.send('STROKE_ACCEPTED', { strokeIndex: 1 }); assert(!e.$('feedback-text').textContent.includes('□')); assert(e.$('feedback-text').textContent.includes('2'));
    e.$('feedback-sound').click(); await new Promise(resolve => setImmediate(resolve));
    for (const id of ['feedback-text', 'feedback-sound', 'feedback-sound-note', 'previous-step']) {
      assert(!e.$(id).textContent.includes(character), character + ' hidden in ' + id);
      assert(!e.$(id).textContent.includes('□'), id + ' uses readable alternative text');
      assert(!Object.values(e.$(id).attributes).some(value => value.includes(character)), 'no new attribute answer');
    }
    assert(!visibleText(e.document).includes(character));
    assert.equal(e.snapshot().attempts.at(-1).help.length, 0, 'UI wording does not record help');
  }
});
test('previous button returns practice steps, retains results and stops completion effects without a reward', async () => {
  const e = await feedbackApp(), audio = audioMock(e), icon = e.$('feedback-icon');
  assert.equal(e.$('previous-step').hidden, false); assert.equal(e.$('previous-step').textContent, '← 返回睇筆順');
  e.send('STROKE_MISSED', { strokeIndex: 0 }); e.$('hint-stroke').click();
  const oldGuidance = e.mounts.at(-1); e.$('previous-step').click();
  assert.equal(e.snapshot().active.phase, 'watch'); assert.equal(e.snapshot().attempts[0].outcome, 'abandoned'); assert.equal(e.snapshot().attempts[0].help.length, 1);
  assert.equal(e.$('feedback').attributes['data-kind'], 'instruction'); assert.equal(e.$('previous-step').textContent, '← 返回詞語');
  const watched = JSON.stringify(e.snapshot()); e.send('WRITING_COMPLETE', {}, oldGuidance); assert.equal(JSON.stringify(e.snapshot()), watched);
  e.$('main-next').click(); e.complete(); e.$('main-next').click();
  assert.equal(e.$('previous-step').textContent, '← 返回跟寫');
  e.$('hint-outline').click(); e.$('previous-step').click();
  assert.equal(e.snapshot().active.phase, 'guided'); assert.equal(e.snapshot().attempts.at(-2).outcome, 'abandoned'); assert.equal(e.snapshot().attempts.at(-2).help.length, 1);
  assert.equal(e.$('main-next').hidden, true); assert.equal(S.summarize(e.snapshot())[0].independent, false);
  e.$('feedback-sound').click(); await new Promise(resolve => setImmediate(resolve));
  e.complete(); e.$('main-next').click(); e.complete();
  const savedResult = S.summarize(e.snapshot())[0], completed = e.mounts.at(-1), motions = icon.animations.length, tones = audio.oscillators.length;
  assert.equal(savedResult.independent, true); e.$('previous-step').click();
  assert.equal(e.snapshot().active.phase, 'guided'); assert.equal(S.summarize(e.snapshot())[0].independent, true); assert.equal(e.snapshot().finished.length, 1);
  assert.equal(icon.animations.length, motions); assert(icon.animations.at(-1).cancelled); assert.equal(audio.oscillators.length, tones); assert(audio.oscillators.at(-1).cancelled);
  assert.equal(e.$('feedback').attributes['data-kind'], 'instruction');
  const saved = JSON.stringify(e.snapshot()); e.send('WRITING_COMPLETE', {}, completed); assert.equal(JSON.stringify(e.snapshot()), saved);
  e.$('previous-step').click(); e.$('previous-step').click(); assert.equal(e.snapshot().active.phase, 'choose-word'); assert.equal(e.$('previous-step').hidden, true);
  e.$('choice-summary').click(); assert.equal(e.$('previous-step').hidden, true); assert.equal(e.snapshot().active.phase, 'summary');
});
test('returning during loading aborts the request and ignores its late result', async () => {
  const e = environment(source('index.html')); let resolveData, loadSignal;
  e.context.BishunSession = S; e.context.BishunContent = { words: ['粗'], cue: () => ['例子', 'M1 1L2 2'] };
  e.context.BishunWriting = { loadCharacter(_character, signal) { loadSignal = signal; return new Promise(resolve => { resolveData = resolve; }); } };
  vm.runInContext(source('app.js'), e.context);
  assert.equal(e.$('previous-step').hidden, true); e.$('word-cards').childNodes[0].click();
  assert.equal(e.$('previous-step').hidden, false); e.$('previous-step').click(); assert(loadSignal.aborted); assert.equal(e.$('previous-step').hidden, true);
  resolveData({ strokes: ['M1 1L2 2'] }); await new Promise(resolve => setImmediate(resolve));
  const snapshot = [...e.store.values()].map(value => { try { return JSON.parse(value); } catch { return null; } }).find(value => value && value.active);
  assert.equal(snapshot.active.phase, 'choose-word'); assert.equal(snapshot.attempts.length, 0); assert.equal(e.$('feedback-icon').animations.length, 0);
});
test('sound stays off until a gesture and only completion plays a cancellable short chime', async () => {
  const e = await feedbackApp(), audio = audioMock(e), icon = e.$('feedback-icon');
  assert.equal(e.$('feedback-sound').attributes['aria-pressed'], 'false'); assert.equal(audio.contexts.length, 0);
  e.send('STROKE_ACCEPTED', { strokeIndex: 0 }); assert.equal(audio.contexts.length, 0);
  e.$('feedback-sound').click(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(audio.contexts.length, 1); assert.equal(e.$('feedback-sound').attributes['aria-pressed'], 'true'); assert.equal(audio.oscillators.length, 0);
  e.send('STROKE_ACCEPTED', { strokeIndex: 1 }); assert.equal(audio.oscillators.length, 0);
  e.send('WRITING_COMPLETE'); assert.equal(audio.oscillators.length, 1); assert(audio.oscillators[0].started);
  e.voices.changed(); e.send('WRITING_COMPLETE'); assert.equal(audio.oscillators.length, 1);
  e.$('rest').click(); assert(audio.oscillators[0].cancelled); assert(icon.animations.at(-1).cancelled);
  e.$('resume').click(); e.$('main-next').click(); e.complete(); assert.equal(audio.oscillators.length, 2);
  e.document.hidden = true; e.document.emit('visibilitychange'); assert(audio.oscillators[1].cancelled);
  e.document.hidden = false; e.$('retry-writing').click(); e.complete(); e.$('teacher-open').click(); assert(audio.oscillators.at(-1).cancelled);
  e.$('teacher-close').click(); e.$('retry-writing').click(); e.motion.reduced = true; const motions = icon.animations.length; e.complete(); assert.equal(icon.animations.length, motions);
  e.$('feedback-sound').click(); assert.equal(e.$('feedback-sound').attributes['aria-pressed'], 'false'); assert(audio.oscillators.at(-1).cancelled);
  e.emitWindow('pagehide'); assert(audio.contexts[0].closed); assert.equal(e.$('feedback-sound').attributes['aria-pressed'], 'false');
  e.$('feedback-sound').click(); await new Promise(resolve => setImmediate(resolve)); assert.equal(audio.contexts.length, 2, 'returning page creates a fresh context only after another gesture');
  e.$('retry-writing').click(); e.complete(); const lastTone = audio.oscillators.at(-1); e.$('new-session').click(); assert(lastTone.cancelled);
});
test('pending or failed audio never queues a chime or overrides a newer sound choice', async () => {
  const e = await feedbackApp(), audio = audioMock(e, { pending: true });
  e.$('feedback-sound').click(); e.complete(); assert.equal(audio.oscillators.length, 0);
  e.$('feedback-sound').click(); audio.resumes[0].resolve(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(e.$('feedback-sound').attributes['aria-pressed'], 'false'); assert.equal(audio.oscillators.length, 0);
  e.$('feedback-sound').click(); e.$('feedback-sound').click(); e.$('feedback-sound').click();
  audio.resumes[1].reject(new Error('old request blocked')); await new Promise(resolve => setImmediate(resolve)); assert.equal(e.$('feedback-sound').attributes['aria-pressed'], 'true');
  audio.resumes[2].resolve(); await new Promise(resolve => setImmediate(resolve)); assert.equal(audio.oscillators.length, 0);
  e.$('main-next').click(); e.complete(); assert.equal(audio.oscillators.length, 1);
  const failed = await feedbackApp(); audioMock(failed, { fail: true }); failed.$('feedback-sound').click(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(failed.$('feedback-sound').attributes['aria-pressed'], 'false'); assert(failed.$('feedback-sound-note').textContent.includes('未能播放'));
  failed.complete(); assert.equal(failed.$('feedback').attributes['data-kind'], 'complete-guided');
});
test('automatic help remains recorded and audio playback failure keeps visual completion', async () => {
  const e = await feedbackApp(); e.complete(); e.$('main-next').click();
  e.send('STROKE_MISSED', { strokeIndex: 0 }); e.send('STROKE_MISSED', { strokeIndex: 0 });
  assert.equal(e.snapshot().attempts.at(-1).help.length, 1); assert.equal(e.$('feedback').attributes['data-kind'], 'support');
  const audio = audioMock(e); e.$('feedback-sound').click(); await new Promise(resolve => setImmediate(resolve));
  audio.contexts[0].createOscillator = () => { throw new Error('device interrupted'); };
  e.complete(); assert.equal(e.$('feedback').attributes['data-kind'], 'complete-assisted');
  assert.equal(e.$('feedback-sound').attributes['aria-pressed'], 'false'); assert(e.$('feedback-sound-note').textContent.includes('未能播放'));
  assert.equal(S.summarize(e.snapshot())[0].independent, false);
});
function chooseCharacters(e, values) {
  const selection = new Set(values);
  walk(e.$('teacher-word-options')).filter(node => node.nodeName === 'input').forEach(input => {
    input.checked = selection.has(input.value); input.emit('change');
  });
}
test('teacher selects a later word position without word-id drift and keeps the full word as context', async () => {
  const e = await feedbackApp(); e.$('teacher-open').click(); e.$('teacher-words').value = '粗\n濃\n鬍鬚\n密\n剪草機\n推來推去'; e.$('validate-words').click();
  chooseCharacters(e, ['w5:2']); assert.equal(e.$('teacher-selection-total').textContent, '已揀 1 個字 · 1 項詞語'); e.$('apply-words').click();
  const sessionId = e.store.get('bishun-school:v1:current'), snapshot = () => JSON.parse(e.store.get('bishun-school:v1:' + sessionId));
  assert.equal(snapshot().entries[0].text, '推來推去'); assert.equal(snapshot().occurrences.length, 1); assert.equal(snapshot().occurrences[0].id, 'w0:2');
  assert(e.$('word-cards').textContent.includes('今次只練 第 3 字「推」')); assert(e.$('session-count').textContent.includes('指定 1 個字'));
  e.$('word-cards').childNodes[0].click(); await waitFor(() => snapshot().active.phase === 'watch');
  assert.equal(e.$('word-title').textContent, '推來推去'); assert.equal(e.$('word-position').textContent, '原詞第 3 字'); assert(e.$('char-position').textContent.includes('已處理 0'));
  e.$('main-next').click();
  for (let round = 0; round < 2; round++) { for (let i = 0; i < 2; i++) e.send('STROKE_ACCEPTED', { strokeIndex: i }); e.send('WRITING_COMPLETE'); if (round === 0) e.$('main-next').click(); }
  assert.equal(snapshot().active.phase, 'character-complete'); assert.equal(e.$('main-next').textContent, '睇今次紀錄 →'); e.$('main-next').click();
  assert.equal(snapshot().active.phase, 'summary'); assert.equal(S.summarize(snapshot()).length, 1); assert(!e.$('summary-rows').textContent.includes('待練'));
});
test('zero selection or changed words cannot end the current valid lesson', async () => {
  const e = await feedbackApp(); e.send('STROKE_ACCEPTED', { strokeIndex: 0 }); e.$('teacher-open').click();
  const before = JSON.stringify(e.snapshot()); chooseCharacters(e, []); e.$('apply-words').click();
  assert.equal(JSON.stringify(e.snapshot()), before); assert(e.$('teacher-dialog').open); assert(e.$('teacher-error').textContent.includes('請揀'));
  e.$('teacher-words').value = '濃'; e.$('apply-words').click();
  assert.equal(JSON.stringify(e.snapshot()), before); assert(e.$('teacher-error').textContent.includes('詞語有改動'));
});
test('choosing a later assigned word first shows processed count rather than a false ordinal', async () => {
  const e = await feedbackApp(); e.$('teacher-open').click(); e.$('teacher-words').value = '粗\n濃'; e.$('validate-words').click(); chooseCharacters(e, ['w0:0', 'w1:0']); e.$('apply-words').click();
  e.$('word-cards').childNodes[1].click(); await waitFor(() => e.$('practice-title').textContent === '睇筆順');
  assert.equal(e.$('char-position').textContent, '今次 2 字 · 已處理 0 字');
});
test('simplified mode defaults on and toggles partial writing without replacing the writer or assessment', async () => {
  const e = await feedbackApp(); assert.equal(e.$('simplify').attributes['aria-pressed'], 'true'); assert(e.document.body.className.includes('simplified-practice'));
  e.send('STROKE_ACCEPTED', { strokeIndex: 0 }); const before = JSON.stringify(e.snapshot()), mount = e.mounts.at(-1), mounts = e.mounts.length;
  e.$('simplify').click(); assert.equal(e.$('simplify').attributes['aria-pressed'], 'false'); assert(!e.document.body.className.includes('simplified-practice')); assert.equal(e.mounts.length, mounts);
  e.$('simplify').click(); assert.equal(JSON.stringify(e.snapshot()), before); assert.equal(e.mounts.at(-1), mount); assert.equal(e.$('stroke-progress').textContent, '已寫 1 / 2 畫');
  e.send('STROKE_ACCEPTED', { strokeIndex: 1 }, mount); e.send('WRITING_COMPLETE', {}, mount); assert.equal(e.snapshot().active.writingDone, true);
  assert.equal(e.snapshot().attempts[0].help.length, 0);
});
test('one native tools disclosure preserves writing state and keeps phase-specific actions available', async () => {
  const e = await feedbackApp();
  const tools = e.$('practice-tools');
  assert.equal(e.$('extra-demo-controls').hidden, true);
  assert.equal(e.$('writing-controls').hidden, false);
  assert.equal(e.$('extra-writing-controls').hidden, false);
  assert.equal(e.$('next-row').hidden, true);
  e.$('previous-step').click();
  assert.equal(e.snapshot().active.phase, 'watch');
  assert.equal(e.$('demo-controls').hidden, false);
  assert.equal(e.$('extra-demo-controls').hidden, false);
  assert.equal(e.$('writing-controls').hidden, true);
  e.$('main-next').click();
  e.send('STROKE_ACCEPTED', { strokeIndex: 0 });
  const before = JSON.stringify(e.snapshot()), mounts = e.mounts.length, mount = e.mounts.at(-1);
  tools.open = true;
  e.$('simplify').click();
  assert(tools.open);
  assert.equal(JSON.stringify(e.snapshot()), before);
  assert.equal(e.mounts.length, mounts);
  assert.equal(e.mounts.at(-1), mount);
  assert.equal(e.snapshot().attempts.at(-1).help.length, 0);
  e.complete();
  assert.equal(e.$('writing-controls').hidden, true);
  assert.equal(e.$('extra-writing-controls').hidden, false, 'guided retry remains available after writing');
  assert.equal(e.$('next-row').hidden, false);
  e.$('main-next').click();
  assert.equal(e.$('writing-controls').hidden, false);
  e.complete();
  assert.equal(e.$('writing-controls').hidden, true);
  assert.equal(e.$('extra-writing-controls').hidden, false, 'completed recall can still retry');
  assert(tools.open);
  e.$('retry-writing').click();
  assert.equal(e.snapshot().active.phase, 'recall');
});
test('instruction speech speaks exactly the displayed sentence on a click and never records help', async () => {
  const e = await feedbackApp(); e.voices.current = [{ lang: 'yue-HK', name: 'Cantonese' }, { lang: 'zh-CN', name: 'Mandarin' }]; e.voices.changed();
  assert.equal(e.$('voice-note').textContent, '');
  assert.equal(e.voices.spoken.length, 0); const snapshot = JSON.stringify(e.snapshot()); e.$('hear-instruction').click();
  const utterance = e.voices.spoken.at(-1); assert.equal(utterance.text, e.$('practice-instruction').textContent); assert.equal(utterance.lang, 'yue-HK'); assert.equal(JSON.stringify(e.snapshot()), snapshot);
  const cancels = e.voices.cancels; e.send('STROKE_ACCEPTED', { strokeIndex: 0 }); assert.equal(e.voices.cancels, cancels, 'ordinary stroke render preserves current instruction speech');
  e.$('simplify').click(); assert.equal(e.voices.cancels, cancels); e.$('hear-instruction').click(); assert.equal(e.voices.spoken.length, 2); assert(e.voices.cancels > cancels);
  utterance.onerror(); assert(!e.$('instruction-voice-note').textContent.includes('未能朗讀'), 'stale error cannot replace a new request');
  e.voices.spoken.at(-1).onerror(); assert(e.$('instruction-voice-note').textContent.includes('未能朗讀'));
  assert.equal(e.snapshot().attempts.at(-1).help.length, 0);
});
test('instruction speech cancels on navigation, rest, teacher, hidden page and page exit with stale callbacks ignored', async () => {
  const e = await feedbackApp(); e.voices.current = [{ lang: 'zh-HK', name: 'Cantonese' }];
  const actions = [() => e.$('previous-step').click(), () => e.$('rest').click(), () => e.$('teacher-open').click(), () => { e.document.hidden = true; e.document.emit('visibilitychange'); }, () => e.emitWindow('pagehide')];
  for (const action of actions) {
    e.$('hear-instruction').click(); const u = e.voices.spoken.at(-1), before = e.voices.cancels; action(); assert(e.voices.cancels > before); u.onerror(); u.onend(); assert.equal(e.$('instruction-voice-note').textContent, '');
    if (e.$('rest-dialog').open) e.$('resume').click(); if (e.$('teacher-dialog').open) e.$('teacher-close').click(); e.document.hidden = false;
  }
});
test('instruction speech falls back honestly for missing APIs, absent Cantonese, synchronous failure and utterance errors', async () => {
  for (const mode of ['no-api', 'no-utterance', 'mandarin-only', 'throws', 'utterance-error']) {
    const e = await feedbackApp(); e.voices.current = [{ lang: 'yue-HK', name: 'Cantonese' }];
    if (mode === 'no-api') delete e.context.speechSynthesis;
    if (mode === 'no-utterance') delete e.context.SpeechSynthesisUtterance;
    if (mode === 'mandarin-only') e.voices.current = [{ lang: 'zh-CN', name: 'Mandarin' }];
    if (mode === 'throws') e.voices.fail = true;
    const saved = JSON.stringify(e.snapshot()); e.$('hear-instruction').click();
    if (mode === 'utterance-error') e.voices.spoken.at(-1).onerror();
    assert(/冇粵語|未能朗讀/.test(e.$('instruction-voice-note').textContent), mode); assert.equal(JSON.stringify(e.snapshot()), saved);
    assert(e.voices.spoken.every(u => u.lang !== 'zh-CN'));
  }
});
test('new instruction and presentation controls stay readable and target-safe in independent recall', async () => {
  for (const character of ['聽', '指', '令', '精', '簡', '語', '由', '想', '再', '聲', '畫', '示', '字', '一', '更', '多', '工', '具', '其', '他', '選', '項', '開', '啟', '功', '能', '默', '憑', '記', '憶', '自', '己', '試']) {
    const e = await feedbackApp(character); e.complete(); e.$('main-next').click(); assert(!e.$('speak').attributes['aria-label'].includes(character)); e.voices.current = [{ lang: 'yue-HK', name: 'Cantonese' }]; e.$('hear-instruction').click();
    assert.equal(e.voices.spoken.at(-1).text, e.$('practice-instruction').textContent);
    for (const id of ['practice-title', 'practice-instruction', 'hear-instruction', 'instruction-voice-note', 'speak-label', 'simplify', 'practice-tools-label', 'char-position']) {
      assert(!e.$(id).textContent.includes(character), character + ' absent from ' + id); assert(!e.$(id).textContent.includes('□'), id + ' is readable');
      assert(!Object.values(e.$(id).attributes).some(value => value.includes(character)), 'no answer in attributes');
    }
    assert(!e.$('speak').attributes['aria-label'].includes(character)); e.$('practice-tools').open = true; e.$('simplify').click(); assert(!e.$('simplify').textContent.includes(character)); assert(!e.$('practice-tools-label').textContent.includes(character)); assert(!visibleText(e.document).includes(character));
    assert.equal(e.snapshot().attempts.at(-1).help.length, 0);
  }
});
test('legacy history remains full scope and interrupted v1 work is closed without migration', () => {
  const e = environment(source('index.html')), legacy = require('./fixtures/session-v1.json');
  e.store.set('bishun-school:v1:' + legacy.id, JSON.stringify(legacy)); e.store.set('bishun-school:v1:current', legacy.id);
  e.context.BishunSession = S; e.context.BishunWriting = {}; e.context.BishunContent = { words: ['粗'], cue: () => ['例子', 'M1 1L2 2'] };
  vm.runInContext(source('app.js'), e.context); e.$('teacher-open').click();
  const closed = JSON.parse(e.store.get('bishun-school:v1:' + legacy.id)); assert.equal(closed.version, 1); assert.equal(closed.occurrences.length, 5); assert.equal(closed.attempts.at(-1).outcome, 'abandoned');
  assert(e.$('local-history').textContent.includes('自己完成 0 · 有提示完成 1 · 跳過 0 · 待練 4')); assert(e.$('local-history').textContent.includes('推來推去 第 3 字「推」待練'));
});

test('pinned vendor keeps one pointer-end listener pair across repeated mounts and disposals', async () => {
  const e = environment();
  vm.runInContext(source('vendor/hanzi-writer.min.js'), e.context);
  vm.runInContext(source('writing.js'), e.context);
  const element = e.$('writer'), events = [], W = e.context.BishunWriting;
  const data = { strokes: ['M 100 500 L 900 500 Z'], medians: [[[100, 500], [900, 500]]] };
  let handle;
  for (let index = 0; index < 20; index++) {
    handle = W.mount(element, '一', data, { phase: index % 2 ? 'guided' : 'recall', token: 'mount-' + index, onEvent: event => events.push(event) });
    await waitFor(() => element.style.visibility !== 'hidden' && element.childNodes.some(node => node.nodeName === 'svg' && node.childNodes.some(child => child.nodeName === 'defs') && node.childNodes.some(child => child.nodeName === 'g')));
    assert.equal(e.document.listeners.mouseup.length, 1);
    assert.equal(e.document.listeners.touchend.length, 1);
    if (index < 19) handle.dispose();
  }
  const svg = element.childNodes.find(node => node.nodeName === 'svg');
  const transform = e.context.HanziWriter.getScalingTransform(360, 360, 24);
  const point = x => ({ clientX: transform.x + x * transform.scale, clientY: 360 - transform.y - 500 * transform.scale });
  svg.emit('mousedown', point(100)); for (let x = 200; x <= 900; x += 100) svg.emit('mousemove', point(x)); e.document.emit('mouseup');
  await waitFor(() => events.some(event => event.type === 'WRITING_COMPLETE'));
  assert(events.every(event => event.token === 'mount-19'), 'only the current mount receives pointer callbacks');
  handle.dispose();
  assert.equal(e.observers.size, 0);
  assert.equal(element.style.visibility, 'hidden');
  assert.equal(e.document.listeners.mouseup.length + e.document.listeners.touchend.length, 2);
});
