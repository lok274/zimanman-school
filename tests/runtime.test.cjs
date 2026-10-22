'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const S = require('../dist/session.js');
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
  const store = new Map(), voices = { current: [], changed: null };
  const storage = { get length() { return store.size; }, key: i => [...store.keys()][i], getItem: key => store.get(key) || null, setItem: (key, value) => store.set(key, value) };
  const observers = new Set(), windowListeners = {}, motion = { reduced: false }; let nextId = 0;
  document.hidden = false;
  const context = vm.createContext({ document, console, setTimeout, clearTimeout, performance, AbortController, NodeFilter: { SHOW_TEXT: 4 },
    localStorage: storage, sessionStorage: storage, crypto: { randomUUID: () => 'runtime-test-' + ++nextId },
    ResizeObserver: class { observe() { observers.add(this); } disconnect() { observers.delete(this); } },
    speechSynthesis: { getVoices: () => voices.current, cancel() {}, speak() {}, addEventListener(_name, fn) { voices.changed = fn; } },
    SpeechSynthesisUtterance: class { constructor(text) { this.text = text; } }, matchMedia: () => ({ matches: motion.reduced }), addEventListener(name, fn) { (windowListeners[name] ||= []).push(fn); }
  });
  context.window = context; context.location = { href: 'http://localhost/' };
  return { context, document, voices, store, observers, motion, emitWindow: name => (windowListeners[name] || []).forEach(fn => fn()), $: document.getElementById };
}
function recallSnapshot(character) {
  let state = S.createSession({ id: 'recall-test', entries: S.parseEntries(character), startedAt: 1 });
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
  e.context.BishunSession = { ...S, createSession: options => S.createSession({ ...options, entries: S.parseEntries(words.join('\n')) }) };
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
    let initial = S.createSession({ id: 'photo-practice', entries: S.parseEntries(word), startedAt: 1 });
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
    assert(e.document.querySelector('.brand').textContent.includes('一筆一筆'));
    const saved = [...e.store.values()].map(value => { try { return JSON.parse(value); } catch { return null; } }).find(value => value && value.id === initial.id);
    assert.equal(saved.attempts.at(-1).help.length, 0, 'masking itself never records assistance');
  }
});
test('skipped word card shows pending practice instead of a completion stamp', () => {
  const e = environment(source('index.html'));
  let initial = recallSnapshot('一');
  initial = S.transition(initial, { type: 'TEACHER_SKIP', token: initial.active.token, at: 3 });
  initial = S.transition(initial, { type: 'NEXT', token: initial.active.token, newToken: 'next', at: 4 });
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
  const latest = S.createSession({ id: 'newest-at-last', entries: S.parseEntries('機'), startedAt: Date.now() + 1000 });
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
  for (const character of ['一', '字', '完', '音', '聲', '再', '寫']) {
    const e = await feedbackApp(character, 3); e.complete(); e.$('main-next').click();
    e.send('STROKE_ACCEPTED', { strokeIndex: 0 });
    const initialText = e.$('feedback-text').textContent;
    assert(!initialText.includes(character)); assert(!initialText.includes('□')); assert(initialText.includes('1'));
    e.send('STROKE_MISSED', { strokeIndex: 1 }); assert(!e.$('feedback-text').textContent.includes('□'));
    e.send('STROKE_ACCEPTED', { strokeIndex: 1 }); assert(!e.$('feedback-text').textContent.includes('□')); assert(e.$('feedback-text').textContent.includes('2'));
    e.$('feedback-sound').click(); await new Promise(resolve => setImmediate(resolve));
    for (const id of ['feedback-text', 'feedback-sound', 'feedback-sound-note']) {
      assert(!e.$(id).textContent.includes(character), character + ' hidden in ' + id);
      assert(!e.$(id).textContent.includes('□'), id + ' uses readable alternative text');
      assert(!Object.values(e.$(id).attributes).some(value => value.includes(character)), 'no new attribute answer');
    }
    assert(!visibleText(e.document).includes(character));
    assert.equal(e.snapshot().attempts.at(-1).help.length, 0, 'UI wording does not record help');
  }
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
