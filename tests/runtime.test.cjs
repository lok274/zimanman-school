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
    this.childNodes = []; this.attributes = {}; this.listeners = {}; this.style = { setProperty(name, value) { this[name] = String(value); }, removeProperty(name) { delete this[name]; } };
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
  getAttribute(name) { return this.attributes[name] ?? null; }
  setAttributeNS(_ns, name, value) { this.setAttribute(name, value); }
  removeAttribute(name) { delete this.attributes[name]; }
  closest(selector) { const tags = selector.split(',').map(s => s.trim().toUpperCase()); let node = this; while (node) { if (tags.includes(node.nodeName.toUpperCase())) return node; node = node.parentNode; } return null; }
  addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); }
  emit(name, event = {}) { (this.listeners[name] || []).forEach(fn => fn({ preventDefault() {}, ...event })); }
  click() { if (!this.disabled) this.emit('click'); }
  showModal() { this.open = true; }
  close() { this.open = false; this.emit('close'); }
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
  const storage = { get length() { return store.size; }, key: i => [...store.keys()][i], getItem: key => store.get(key) || null, setItem: (key, value) => store.set(key, value), removeItem: key => store.delete(key) };
  const observers = new Set(), windowListeners = {}, motion = { reduced: false }; let nextId = 0;
  document.hidden = false;
  const context = vm.createContext({ document, console, setTimeout: (...args) => { const timer = setTimeout(...args); timer.unref(); return timer; }, clearTimeout, performance, AbortController, NodeFilter: { SHOW_TEXT: 4 },
    localStorage: storage, sessionStorage: storage, crypto: { randomUUID: () => 'runtime-test-' + ++nextId },
    ResizeObserver: class { constructor(callback) { this.callback = callback; } observe() { observers.add(this); } disconnect() { observers.delete(this); } },
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
    for (let parent = node.parentNode; parent; parent = parent.parentNode) if (parent.hidden || parent.className.split(' ').includes('sr-only') || (parent.nodeName === 'dialog' && !parent.open)) return false;
    return true;
  }).map(node => node.nodeValue).join('');
}
function openLocalGroups(e, mode = 'practice') {
  e.$('start-' + mode).click();
  if (mode === 'practice') for (let level = 0; level < 3; level++) e.$('group-cards').childNodes[0].click();
}
function startLocal(e, mode = 'practice', group = 0) { openLocalGroups(e, mode); e.$('group-cards').childNodes[group].click(); }
function markedPosition(element) { return element.childNodes.findIndex(node => node.getAttribute('aria-current') === 'true'); }

function dictationApp({ prefixed = false, unsupported = false } = {}) {
  const e = environment(source('index.html')), timers = new Map(), speech = { instances: [] };
  let now = 0, timerId = 0;
  e.context.performance = { now: () => now };
  e.context.setTimeout = (callback, delay) => { timers.set(++timerId, { callback, at: now + delay }); return timerId; };
  e.context.clearTimeout = id => timers.delete(id);
  e.advance = milliseconds => {
    const until = now + milliseconds;
    while (true) {
      const next = [...timers.entries()].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      now = next[1].at; timers.delete(next[0]); next[1].callback();
    }
    now = until;
  };
  class Recognition {
    constructor() { if (speech.constructorError) throw speech.constructorError; this.starts = 0; this.stops = 0; this.aborts = 0; this.active = false; speech.instances.push(this); }
    start() { this.starts++; if (speech.startError) throw speech.startError; }
    stop() { this.stops++; if (speech.stopError) throw speech.stopError; }
    abort() { this.aborts++; this.active = false; this.onerror?.({ error: 'aborted' }); this.onend?.(); }
    begin() { this.active = true; this.onstart?.(); }
    result(text, final = true) { const result = [{ transcript: text }]; result.isFinal = final; this.onresult?.({ resultIndex: 0, results: [result] }); }
    end() { this.active = false; this.onend?.(); }
    fail(error) { this.active = false; this.onerror?.({ error }); }
  }
  if (!unsupported) e.context[prefixed ? 'webkitSpeechRecognition' : 'SpeechRecognition'] = Recognition;
  e.context.BishunSession = S; e.context.BishunWriting = {};
  vm.runInContext(source('content.js'), e.context); vm.runInContext(source('app.js'), e.context);
  e.speech = speech;
  e.begin = () => { e.$('dictation-start').click(); const recognition = speech.instances.at(-1); recognition.begin(); return recognition; };
  e.review = text => { const recognition = e.begin(); recognition.result(text); return recognition; };
  return e;
}

test('Cantonese dictation starts only on tap, reviews an editable final phrase and appends to the current draft once', () => {
  const e = dictationApp();
  assert.equal(e.speech.instances.length, 0);
  e.$('teacher-open').click(); assert.equal(e.speech.instances.length, 0);
  const options = e.$('teacher-word-options').childNodes.slice(), cancelCount = e.voices.cancels;
  const recognition = e.begin();
  assert(e.voices.cancels > cancelCount, 'dictation stops playback');
  assert.equal(recognition.lang, 'yue-Hant-HK'); assert.equal(recognition.continuous, false); assert.equal(recognition.interimResults, false); assert.equal(recognition.maxAlternatives, 1);
  assert.equal(e.$('dictation-start').textContent, '聆聽中'); assert.equal(e.$('dictation-stop').hidden, false);
  e.$('dictation-start').emit('click'); assert.equal(e.speech.instances.length, 1, 'repeated taps cannot overlap attempts');
  recognition.result('未完成', false); assert.equal(e.$('dictation-review').hidden, true);
  recognition.result('朋友。'); assert.equal(e.$('dictation-review').hidden, false); assert.equal(e.$('dictation-pending').value, '朋友。'); assert.equal(recognition.active, false);
  e.$('dictation-pending').value = ' 「同學」  ';
  recognition.result('遲到'); recognition.end(); recognition.fail('network');
  assert.equal(e.$('dictation-pending').value, ' 「同學」  ', 'late events preserve the edited review');
  e.$('teacher-words').value = ' 朋友，\n朋友\n';
  e.$('dictation-confirm').click(); e.$('dictation-confirm').emit('click');
  assert.equal(e.$('teacher-words').value, ' 朋友，\n朋友\n同學'); assert.equal(e.$('dictation-review').hidden, true); assert.equal(e.$('dictation-pending').value, '');
  assert.deepEqual(e.$('teacher-word-options').childNodes, options, 'confirmation does not rebuild selections'); assert.equal(e.store.size, 0, 'confirmation does not create or apply a session');
  e.$('apply-words').click(); assert.equal(e.$('teacher-dialog').open, true); assert.match(e.$('teacher-error').textContent, /更新可選詞語/);
  e.$('validate-words').click(); assert(walk(e.$('teacher-word-options')).filter(node => node.nodeName === 'input').every(input => input.checked));
  e.$('apply-words').click(); startLocal(e);
  const snapshot = JSON.parse(e.store.get('bishun-school:v1:' + e.store.get('bishun-school:v1:current')));
  assert.deepEqual(snapshot.entries.map(entry => entry.text), ['朋友']); assert.equal(snapshot.occurrences.length, 2);
  e.$('choice-summary').click(); e.$('group-cards').childNodes[1].click();
  const second = JSON.parse(e.store.get('bishun-school:v1:' + e.store.get('bishun-school:v1:current')));
  assert.deepEqual(second.entries.map(entry => entry.text), ['同學']); assert.equal(second.occurrences.length, 2);
});

test('dictation validates one Han word without joining, splitting, replacing or losing rejected drafts', () => {
  for (const phrase of ['朋友 同學', '朋友，同學', 'abc', '朋友1', '一二三四五六七八九', '', '🙂朋友']) {
    const e = dictationApp(); e.$('teacher-open').click(); e.$('teacher-words').value = '粗'; e.review('朋友'); e.$('dictation-pending').value = phrase; e.$('dictation-confirm').click();
    assert.equal(e.$('teacher-words').value, '粗', phrase); assert.equal(e.$('dictation-pending').value, phrase); assert.equal(e.$('dictation-review').hidden, false); assert.match(e.$('dictation-status').textContent, /1 至 8/);
  }
  for (const before of ['', '   ', '粗', '粗\r\n']) {
    const e = dictationApp(); e.$('teacher-open').click(); e.$('teacher-words').value = before; e.review('「朋友。」'); e.$('dictation-confirm').click();
    assert.equal(e.$('teacher-words').value, before + (before && !/[\r\n]$/.test(before) ? '\n' : '') + '朋友');
  }
  const e = dictationApp(); e.$('teacher-open').click(); e.$('teacher-words').value = '粗'; e.review('朋友'); e.$('teacher-words').value = '朋友，朋友\n粗'; e.$('dictation-confirm').click();
  assert.equal(e.$('teacher-words').value, '朋友，朋友\n粗'); assert.equal(e.$('dictation-pending').value, '朋友'); assert.match(e.$('dictation-status').textContent, /相同詞語/);
  e.$('dictation-pending').value = '学习'; e.$('dictation-confirm').click(); assert.equal(e.$('teacher-words').value, '朋友，朋友\n粗\n学习', 'recognition text is not guessed into Traditional Chinese');
});

test('dictation respects the vocabulary parser limits and keeps the six-word session limit', () => {
  for (const before of ['一\n二\n三\n四\n五\n六\n七\n八\n九\n十\n百\n千', '粗' + ' '.repeat(397), 'invalid']) {
    const e = dictationApp(); e.$('teacher-open').click(); e.$('teacher-words').value = before; e.review('朋友'); e.$('dictation-confirm').click();
    assert.equal(e.$('teacher-words').value, before); assert.equal(e.$('dictation-pending').value, '朋友'); assert.equal(e.$('dictation-review').hidden, false);
  }
  const e = dictationApp(); e.$('teacher-open').click(); e.review('朋友'); e.$('dictation-confirm').click();
  assert.equal(e.$('teacher-word-options').childNodes.length, 6);
  e.$('validate-words').click(); assert.equal(e.$('teacher-word-options').childNodes.length, 7);
  e.$('apply-words').click(); assert.equal(e.$('teacher-dialog').open, true); assert.match(e.$('teacher-error').textContent, /1 至 6 項詞語/);
  const first = walk(e.$('teacher-word-options')).find(node => node.nodeName === 'input'); first.checked = false; first.emit('change');
  e.$('apply-words').click(); assert.equal(e.$('teacher-dialog').open, false);
  startLocal(e, 'practice', 1);
  const snapshot = JSON.parse(e.store.get('bishun-school:v1:' + e.store.get('bishun-school:v1:current')));
  assert.deepEqual(snapshot.entries.map(entry => entry.text), ['剪草機', '推來推去', '朋友']); assert.equal(snapshot.occurrences.length, 9);
  e.$('choice-summary').click(); e.$('group-cards').childNodes[0].click();
  const firstGroup = JSON.parse(e.store.get('bishun-school:v1:' + e.store.get('bishun-school:v1:current')));
  assert.deepEqual(firstGroup.entries.map(entry => entry.text), ['濃', '鬍鬚', '密']); assert.equal(firstGroup.occurrences.length, 4);
});

test('stop can deliver a final phrase and both starting and finishing have bounded deadlines', () => {
  const e = dictationApp(); e.$('teacher-open').click();
  let recognition = e.begin(); e.$('dictation-stop').click(); assert.equal(recognition.stops, 1); assert.equal(e.$('dictation-stop').disabled, true);
  recognition.result('朋友'); e.advance(20000); assert.equal(e.$('dictation-pending').value, '朋友');
  e.$('dictation-cancel').click(); assert.equal(e.$('dictation-pending').value, ''); assert.equal(e.$('dictation-review').hidden, true);
  e.$('dictation-start').click(); recognition = e.speech.instances.at(-1);
  e.advance(19999); assert.equal(recognition.aborts, 0); e.advance(1); assert.equal(recognition.aborts, 1); assert.match(e.$('dictation-status').textContent, /逾時/);
  recognition.begin(); recognition.result('遲到'); assert.equal(recognition.active, false); assert.equal(e.$('dictation-review').hidden, true);
  recognition = e.begin(); e.advance(19000); e.$('dictation-stop').click(); e.advance(1000); assert.equal(recognition.active, false); assert.match(e.$('dictation-status').textContent, /逾時/);
  recognition = e.begin(); e.$('dictation-stop').click(); e.advance(2999); assert.equal(recognition.active, true); e.advance(1); assert.equal(recognition.active, false);
  assert.equal(e.speech.instances.length, 4, 'timeouts never retry automatically');
});

test('closing, Escape, background and navigation discard dictation and ignore stale callbacks before or after start', () => {
  const exits = [e => e.$('teacher-close').click(), e => e.$('teacher-dialog').emit('cancel'), e => e.$('teacher-dialog').close(), e => { e.document.hidden = true; e.document.emit('visibilitychange'); }, e => e.emitWindow('pagehide'), e => e.emitWindow('beforeunload'), e => e.emitWindow('popstate'), e => e.emitWindow('hashchange'), e => e.document.querySelector('.brand').click(), e => e.$('teacher-class').click()];
  for (const exit of exits) for (const stage of ['starting', 'listening', 'review']) {
    const e = dictationApp(); e.$('teacher-open').click(); e.$('dictation-start').click(); const recognition = e.speech.instances.at(-1);
    if (stage !== 'starting') recognition.begin();
    if (stage === 'review') recognition.result('朋友');
    const before = e.$('teacher-words').value; exit(e);
    recognition.begin(); recognition.result('遲到'); recognition.end(); recognition.fail('network');
    assert.equal(recognition.active, false, stage); assert.equal(e.$('dictation-review').hidden, true); assert.equal(e.$('dictation-pending').value, ''); assert.equal(e.$('teacher-words').value, before);
    e.document.hidden = false; e.emitWindow('pageshow');
    if (e.$('teacher-dialog').open) e.$('teacher-dialog').close(); e.$('teacher-open').click(); assert.equal(e.speech.instances.length, 1, 'reopening never starts recognition');
  }
});

test('a cancelled old attempt cannot overwrite a new attempt or its reviewed text', () => {
  const e = dictationApp(); e.$('teacher-open').click(); const old = e.begin(); e.$('teacher-close').click(); e.$('teacher-open').click(); const current = e.begin();
  old.begin(); old.result('舊詞'); old.fail('network'); old.end(); assert.equal(old.active, false); assert.equal(current.active, true); assert.equal(e.$('dictation-start').textContent, '聆聽中');
  current.result('朋友'); e.$('dictation-pending').value = '同學'; old.result('舊詞'); old.begin(); current.result('重複'); current.end();
  assert.equal(e.$('dictation-pending').value, '同學'); e.$('dictation-confirm').click(); assert(e.$('teacher-words').value.endsWith('\n同學'));
});

test('recognition failures and unsupported browsers retain typing and keyboard dictation fallback', () => {
  for (const error of ['not-allowed', 'service-not-allowed', 'audio-capture', 'network', 'language-not-supported', 'no-speech', 'aborted']) {
    const e = dictationApp(); e.$('teacher-open').click(); const recognition = e.begin(), before = e.$('teacher-words').value;
    recognition.fail(error); recognition.result('遲到'); assert.equal(recognition.active, false); assert.equal(e.$('teacher-words').value, before); assert.equal(e.$('dictation-review').hidden, true); assert.match(e.$('dictation-status').textContent, /打字.*鍵盤語音/); e.advance(30000); assert.equal(e.speech.instances.length, 1);
  }
  for (const failure of ['constructorError', 'startError', 'stopError']) {
    const e = dictationApp(); e.$('teacher-open').click(); e.speech[failure] = Object.assign(new Error('blocked'), { name: 'NotAllowedError' }); e.$('dictation-start').click(); if (failure === 'stopError') e.$('dictation-stop').click();
    assert.equal(e.$('dictation-start').disabled, false); assert.match(e.$('dictation-status').textContent, /打字.*鍵盤語音/);
  }
  const noSpeech = dictationApp(); noSpeech.$('teacher-open').click(); noSpeech.begin().end(); assert.match(noSpeech.$('dictation-status').textContent, /未聽到/);
  const unsupported = dictationApp({ unsupported: true }); unsupported.$('teacher-open').click(); assert.equal(unsupported.$('dictation-start').disabled, true); assert.match(unsupported.$('dictation-status').textContent, /打字.*鍵盤語音/);
  unsupported.$('teacher-words').value = '朋友'; unsupported.$('validate-words').click(); unsupported.$('apply-words').click(); assert.equal(unsupported.$('teacher-dialog').open, false);
  const prefixed = dictationApp({ prefixed: true }); prefixed.$('teacher-open').click(); prefixed.review('朋友'); assert.equal(prefixed.$('dictation-pending').value, '朋友');
});

test('teacher actions and deliberate playback stop dictation without changing the active session', () => {
  for (const action of ['teacher-skip', 'teacher-end', 'hear-instruction', 'speak']) {
    const e = dictationApp(); startLocal(e); e.$('word-cards').childNodes[0].click(); e.$('teacher-open').click(); const recognition = e.begin();
    e.voices.current = [{ lang: 'yue-HK', name: 'Cantonese' }]; e.voices.changed(); e.$(action).click();
    assert.equal(recognition.active, false, action); recognition.result('遲到'); assert.equal(e.$('dictation-review').hidden, true);
  }
  const e = dictationApp(); startLocal(e); const current = e.store.get('bishun-school:v1:current'); e.$('teacher-open').click(); const before = e.store.get('bishun-school:v1:' + current);
  e.review('朋友'); e.$('dictation-confirm').click(); assert.equal(e.store.get('bishun-school:v1:' + current), before, 'confirmed draft does not alter the active session');
});

test('both modes open two groups whose sessions cover all twelve default positions with full-word photo cards', () => {
  const words = ['粗', '濃', '鬍鬚', '密', '剪草機', '推來推去'];
  for (const mode of ['practice', 'quiz']) {
    const e = environment(source('index.html'));
    e.context.BishunSession = S; e.context.BishunWriting = {};
    vm.runInContext(source('content.js'), e.context); vm.runInContext(source('app.js'), e.context); openLocalGroups(e, mode);
    assert.equal(e.store.size, 0, 'choosing a mode does not create a session');
    assert.equal(e.$('home-view').hidden, true); assert.equal(e.$('group-view').hidden, false);
    assert.deepEqual(e.$('group-cards').childNodes.map(card => card.textContent), [(mode === 'quiz' ? '測驗1' : '練習1') + '粗、濃、鬍鬚', (mode === 'quiz' ? '測驗2' : '練習2') + '密、剪草機、推來推去']);
    e.$('teacher-open').click();
    const inputs = walk(e.$('teacher-word-options')).filter(node => node.nodeName === 'input');
    assert.equal(inputs.length, 12); assert(inputs.every(input => input.checked)); e.$('teacher-close').click();
    const observedWords = [], observedPhotos = []; let positions = 0;
    for (const group of [0, 1]) {
      e.$('group-cards').childNodes[group].click();
      const snapshot = JSON.parse(e.store.get('bishun-school:v1:' + e.store.get('bishun-school:v1:current')));
      assert.equal(snapshot.mode, mode); assert.equal(snapshot.active.phase, 'choose-word');
      assert.deepEqual(snapshot.entries.map(entry => entry.text), words.slice(group * 3, group * 3 + 3));
      assert.equal(snapshot.occurrences.length, group ? 8 : 4); positions += snapshot.occurrences.length;
      if (group) assert.deepEqual(snapshot.occurrences.filter(item => item.character === '推').map(item => item.id), ['w2:0', 'w2:2']);
      const cards = e.$('word-cards').childNodes; assert.equal(cards.length, 3);
      assert.deepEqual(cards.map(card => card.childNodes[0].textContent), words.slice(group * 3, group * 3 + 3));
      assert(cards.every(card => markedPosition(card.childNodes[0]) === 0));
      const photos = walk(e.$('word-cards')).filter(node => node.nodeName === 'img'); assert.equal(photos.length, 3);
      assert(photos.every(image => image.attributes.alt === '')); observedPhotos.push(...photos.map(image => image.attributes.src));
      photos[0].emit('error');
      assert(walk(cards[0]).some(node => node.nodeName === 'svg'), 'failed photo falls back to its word cue');
      assert(!walk(cards[0]).some(node => node.nodeName === 'img')); observedWords.push(...snapshot.entries.map(entry => entry.text));
      e.$('choice-summary').click(); assert.equal(e.$('group-view').hidden, false); assert.equal(e.$('home-view').hidden, true);
      assert.equal(e.store.has('bishun-school:v1:current'), false);
      assert.equal(JSON.parse(e.store.get('bishun-school:v1:' + snapshot.id)).active.phase, 'summary');
    }
    assert.deepEqual(observedWords, words); assert.equal(positions, 12); assert.equal(new Set(observedPhotos).size, 6);
    for (let back = 0; back < (mode === 'practice' ? 4 : 1); back++) e.$('group-home').click(); assert.equal(e.$('home-view').hidden, false); assert.equal(e.$('group-view').hidden, true);
  }
  for (const word of [...words, '朋友']) {
    const practice = environment(source('index.html'));
    let initial = S.createSession({ id: 'photo-practice', entries: assigned(word), startedAt: 1 });
    for (const event of [{ type: 'CHOOSE_WORD', wordId: 'w0' }, { type: 'DATA_READY', strokeCount: 1 }]) initial = S.transition(initial, { at: 2, token: initial.active.token, newToken: 'watch', ...event });
    practice.context.BishunSession = { ...S, createSession: () => structuredClone(initial) }; practice.context.BishunWriting = {};
    vm.runInContext(source('content.js'), practice.context); vm.runInContext(source('app.js'), practice.context); startLocal(practice);
    const cue = practice.$('semantic-cue').childNodes[0];
    assert.equal(cue.nodeName, words.includes(word) ? 'img' : 'svg');
    if (cue.nodeName === 'img') { assert.equal(cue.attributes.alt, ''); cue.emit('error'); assert.equal(practice.$('semantic-cue').childNodes[0].nodeName, 'svg'); }
  }
});
test('recall conceals generic targets in live labels and late voice messages, then restores labels', async () => {
  for (const character of ['一', '寫', '字', '樂', '二', '年', '級', '上', '第', '課', '爸', '的', '鬍', '鬚', '我', '機']) {
    const e = await feedbackApp(character, 1); e.complete(); e.$('main-next').click();
    const initial = e.snapshot();
    assert(!visibleText(e.document).includes(character), character + ' concealed at recall render');
    assert(!e.document.querySelector('.brand').getAttribute('aria-label').includes(character), character + ' concealed in brand accessible name');
    e.$('speak').click();
    assert(!visibleText(e.document).includes(character), character + ' concealed after missing-voice fallback');
    e.voices.current = [{ lang: 'yue-HK', name: character + '聲音' }]; e.voices.changed();
    assert(!visibleText(e.document).includes(character), character + ' concealed after late voiceschanged');
    e.$('teacher-end').click();
    assert(e.document.querySelector('.brand').textContent.includes('寫字樂'));
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
  vm.runInContext(source('app.js'), e.context); startLocal(e);
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
  vm.runInContext(source('app.js'), e.context); startLocal(e);
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
  vm.runInContext(source('app.js'), e.context); startLocal(e);
  e.$('teacher-open').click();
  assert(e.$('local-history').textContent.includes('機'));
});
async function waitFor(predicate) { const end = Date.now() + 2000; while (!predicate()) { assert(Date.now() < end, 'runtime initialization completed'); await new Promise(resolve => setTimeout(resolve, 10)); } }
async function feedbackApp(character = '粗', strokeCount = 2, startGuided = true) {
  const e = environment(source('index.html')); e.mounts = [];
  e.context.BishunSession = S;
  e.context.BishunContent = { words: [character], cue: () => ['例子', 'M1 1L2 2'] };
  e.context.HanziWriter = {};
  e.context.BishunWriting = {
    loadCharacter: () => Promise.resolve({ strokes: Array(strokeCount).fill('M1 1L2 2') }),
    mount(_element, character, _data, options) { e.mounts.push({ ...options, character }); return { dispose() {}, pause() {}, suspend() {}, showHelp() {} }; }
  };
  vm.runInContext(source('app.js'), e.context); startLocal(e);
  e.snapshot = () => [...e.store.values()].map(value => { try { return JSON.parse(value); } catch { return null; } }).find(value => value && value.active);
  e.send = (type, extra = {}, mount = e.mounts.at(-1)) => mount.onEvent({ type, token: mount.token, ...extra });
  e.complete = () => { for (let index = e.snapshot().active.currentStroke; index < strokeCount; index++) e.send('STROKE_ACCEPTED', { strokeIndex: index }); e.send('WRITING_COMPLETE'); };
  e.$('word-cards').childNodes[0].click(); await waitFor(() => e.mounts.length === 1);
  if (startGuided) { e.$('main-next').click(); assert.equal(e.snapshot().active.phase, 'guided'); }
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
  assert.equal(e.$('feedback-text').textContent, '你開始咗，第一畫完成！'); assert.equal(icon.textContent, '✓');
  e.send('STROKE_MISSED', { strokeIndex: 1 });
  assert.equal(e.$('feedback').attributes['data-kind'], 'support'); assert.notEqual(icon.textContent, '✓');
  e.send('STROKE_ACCEPTED', { strokeIndex: 1 });
  assert.equal(e.$('feedback-text').textContent, '你再試成功咗！');
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
    assert(!initialText.includes(character)); assert(!initialText.includes('□')); assert(initialText.length > 0);
    e.send('STROKE_MISSED', { strokeIndex: 1 }); assert(!e.$('feedback-text').textContent.includes('□'));
    e.send('STROKE_ACCEPTED', { strokeIndex: 1 }); assert(!e.$('feedback-text').textContent.includes('□')); assert(e.$('feedback-text').textContent.length > 0);
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
  assert.equal(e.$('feedback').attributes['data-kind'], 'instruction'); assert.equal(e.$('previous-step').textContent, '← 返回選字');
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
  vm.runInContext(source('app.js'), e.context); startLocal(e);
  assert.equal(e.$('previous-step').hidden, true); e.$('word-cards').childNodes[0].click();
  assert.equal(e.$('previous-step').hidden, false); await waitFor(() => loadSignal); e.$('previous-step').click(); assert(loadSignal.aborted); assert.equal(e.$('previous-step').hidden, true);
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
test('updated vocabulary selects every position and still accepts a smaller teacher assignment', async () => {
  const e = await quizApp(); e.$('teacher-open').click(); e.$('teacher-words').value = '朋友\n推來推去'; e.$('validate-words').click();
  const inputs = walk(e.$('teacher-word-options')).filter(node => node.nodeName === 'input');
  assert.equal(inputs.length, 6); assert(inputs.every(input => input.checked));
  assert.equal(e.$('teacher-selection-total').textContent, '已揀 6 個字 · 2 項詞語');
  e.$('apply-words').click(); startLocal(e);
  assert.deepEqual(e.snapshot().occurrences.map(item => [item.id, item.character]), [['w0:0', '朋'], ['w0:1', '友']]);
  e.$('choice-summary').click(); e.$('group-cards').childNodes[1].click();
  assert.deepEqual(e.snapshot().occurrences.map(item => [item.id, item.character]), [['w0:0', '推'], ['w0:1', '來'], ['w0:2', '推'], ['w0:3', '去']]);
  e.$('teacher-open').click(); chooseCharacters(e, ['w1:2']); e.$('apply-words').click(); startLocal(e, 'quiz');
  assert.equal(e.snapshot().entries[0].text, '推來推去'); assert.equal(e.snapshot().occurrences.length, 1); assert.equal(e.snapshot().occurrences[0].index, 2);
});
test('local groups balance only eligible applied words and keep their original selected positions', async () => {
  const e = await quizApp(); e.$('teacher-open').click(); e.$('teacher-words').value = '一\n二\n三\n四\n五\n六\n推來推去'; e.$('validate-words').click();
  chooseCharacters(e, ['w0:0', 'w2:0', 'w4:0', 'w5:0', 'w6:2']); e.$('apply-words').click();
  assert.equal(e.$('home-view').hidden, false); assert.equal(e.store.size, 0);
  e.$('start-quiz').click();
  assert.deepEqual(e.$('group-cards').childNodes.map(card => card.textContent), ['測驗1一、三、五', '測驗2六、推來推去']);
  assert.equal(e.store.size, 0);
  e.$('group-cards').childNodes[1].click();
  assert.deepEqual(e.snapshot().entries.map(word => word.text), ['六', '推來推去']);
  assert.deepEqual(e.snapshot().occurrences.map(item => [item.id, item.character]), [['w0:0', '六'], ['w1:2', '推']]);
  e.$('choice-summary').click(); e.$('group-cards').childNodes[0].click();
  assert.deepEqual(e.snapshot().entries.map(word => word.text), ['一', '三', '五']);
  e.$('teacher-open').click(); chooseCharacters(e, ['w6:2']); e.$('apply-words').click();
  assert.equal(e.$('home-view').hidden, false); assert.equal(e.$('group-view').hidden, true);
  openLocalGroups(e);
  assert.deepEqual(e.$('group-cards').childNodes.map(card => [card.textContent, card.disabled]), [['練習1推來推去', false], ['練習2', true]]);
  const before = e.store.size; e.$('group-cards').childNodes[1].click(); assert.equal(e.store.size, before); assert.equal(e.$('group-view').hidden, false);
  e.document.querySelector('.brand').click(); assert.equal(e.$('home-view').hidden, false); assert.equal(e.$('group-view').hidden, true);
});
test('completed writing advances to the second character of the same full word and local Back keeps its history', async () => {
  const e = await feedbackApp('鬍鬚'), sessionId = e.snapshot().id;
  assert.equal(e.$('word-title').textContent, '鬍鬚'); assert.equal(markedPosition(e.$('word-title')), 0); assert.equal(e.mounts.at(-1).character, '鬍');
  e.complete(); e.$('main-next').click(); assert.equal(e.snapshot().active.phase, 'recall');
  assert(!visibleText(e.document).includes('鬍')); assert.equal(e.$('word-title').textContent, '詞語收埋咗');
  assert(walk(e.$('word-cards')).every(node => !Object.values(node.attributes).some(value => value.includes('鬍'))));
  e.complete(); assert.equal(e.snapshot().active.phase, 'character-complete');
  assert.equal(e.$('word-title').textContent, '鬍鬚'); assert.equal(markedPosition(e.$('word-title')), 0);
  e.$('main-next').click(); await waitFor(() => e.snapshot().active.phase === 'watch');
  assert.equal(e.snapshot().active.occurrenceId, 'w0:1'); assert.equal(e.$('word-title').textContent, '鬍鬚'); assert.equal(markedPosition(e.$('word-title')), 1); assert.equal(e.mounts.at(-1).character, '鬚');
  assert(e.mounts.every(mount => Array.from(mount.character).length === 1));
  e.$('main-next').click(); e.send('STROKE_ACCEPTED', { strokeIndex: 0 }); e.$('previous-step').click(); e.$('previous-step').click();
  assert.equal(e.snapshot().active.phase, 'choose-word'); assert.equal(markedPosition(e.$('word-cards').childNodes[0].childNodes[0]), 1);
  e.$('choice-summary').click();
  const ended = JSON.parse(e.store.get('bishun-school:v1:' + sessionId));
  assert.equal(ended.active.phase, 'summary'); assert.deepEqual(ended.finished, ['w0:0']); assert.equal(ended.attempts.at(-1).outcome, 'abandoned');
  assert.equal(e.$('group-view').hidden, false); assert.equal(e.$('home-view').hidden, true); assert.equal(e.store.has('bishun-school:v1:current'), false);
  e.$('group-cards').childNodes[0].click();
  const restarted = JSON.parse(e.store.get('bishun-school:v1:' + e.store.get('bishun-school:v1:current')));
  assert.notEqual(restarted.id, sessionId); assert.equal(restarted.attempts.length, 0); assert.equal(restarted.active.phase, 'choose-word');
  e.$('choice-summary').click(); for (let back = 0; back < 4; back++) e.$('group-home').click(); assert.equal(e.$('home-view').hidden, false);
});
test('a fourth-only assignment displays the full word and marks its position while mounting only that character', async () => {
  const e = await feedbackApp(); e.$('teacher-open').click(); e.$('teacher-words').value = '粗\n濃\n鬍鬚\n密\n剪草機\n推來推去'; e.$('validate-words').click();
  const content = {}; vm.runInNewContext(source('content.js'), content); e.context.BishunContent.photos = content.BishunContent.photos;
  chooseCharacters(e, ['w5:3']); assert.equal(e.$('teacher-selection-total').textContent, '已揀 1 個字 · 1 項詞語'); e.$('apply-words').click(); startLocal(e);
  const sessionId = e.store.get('bishun-school:v1:current'), snapshot = () => JSON.parse(e.store.get('bishun-school:v1:' + sessionId));
  assert.equal(snapshot().entries[0].text, '推來推去'); assert.equal(snapshot().occurrences.length, 1); assert.equal(snapshot().occurrences[0].id, 'w0:3');
  assert.equal(e.$('word-cards').textContent, '推來推去'); assert.equal(markedPosition(e.$('word-cards').childNodes[0].childNodes[0]), 3);
  assert.equal(walk(e.$('word-cards')).find(node => node.nodeName === 'img').attributes.src, content.BishunContent.photos['推來推去']);
  assert.equal(e.$('session-count'), undefined); assert.equal(e.$('word-position'), undefined);
  e.$('word-cards').childNodes[0].click(); await waitFor(() => snapshot().active.phase === 'watch');
  assert.equal(e.$('word-title').textContent, '推來推去'); assert.equal(markedPosition(e.$('word-title')), 3); assert.equal(snapshot().active.occurrenceId, 'w0:3');
  assert.equal(e.mounts.at(-1).character, '去');
  assert.equal(snapshot().occurrences[0].index, 3); assert.equal(snapshot().occurrences[0].character, '去');
  assert.equal(e.$('semantic-cue').childNodes[0].attributes.src, content.BishunContent.photos['推來推去']);
  assert.equal(e.$('word-example'), undefined);
  e.$('simplify').click(); assert(visibleText(e.document).includes('推來推去'));
  e.voices.current = [{ lang: 'yue-HK', name: 'Cantonese' }]; e.voices.changed(); e.$('speak').click();
  assert.equal(e.voices.spoken.at(-1).text, '推來推去。第4個字，去。');
  e.$('main-next').click();
  for (let round = 0; round < 2; round++) {
    for (let i = 0; i < 2; i++) e.send('STROKE_ACCEPTED', { strokeIndex: i }); e.send('WRITING_COMPLETE');
    if (round === 0) { e.$('main-next').click(); assert(!visibleText(e.document).includes('去')); assert.equal(snapshot().attempts.at(-1).help.length, 0); }
  }
  assert.equal(snapshot().active.phase, 'character-complete'); assert.equal(e.$('main-next').textContent, '睇今次紀錄 →'); e.$('main-next').click();
  assert.equal(snapshot().active.phase, 'summary'); assert.equal(S.summarize(snapshot()).length, 1); assert(!e.$('summary-rows').textContent.includes('待練'));
  assert(e.$('summary-rows').textContent.includes('推來推去')); assert(e.$('summary-rows').textContent.includes('第 4 字'));
  e.$('teacher-open').click(); assert(e.$('teacher-word-options').textContent.includes('第 4 字「去」'));
  assert(e.$('local-history').textContent.includes('推來推去 第 4 字「去」'));
});
test('nonconsecutive repeated positions stay distinct on full-word cards and same-word NEXT', async () => {
  const e = await feedbackApp(); e.$('teacher-open').click(); e.$('teacher-words').value = '推來推去\n粗\n濃'; e.$('validate-words').click();
  chooseCharacters(e, ['w0:0', 'w0:2', 'w0:3', 'w1:0', 'w2:0']); e.$('apply-words').click(); startLocal(e);
  const sessionId = e.store.get('bishun-school:v1:current'), snapshot = () => JSON.parse(e.store.get('bishun-school:v1:' + sessionId));
  assert.deepEqual(snapshot().occurrences.map(item => item.id), ['w0:0', 'w0:2', 'w0:3', 'w1:0']);
  const targetName = () => e.$('word-cards').childNodes[0].childNodes[0];
  for (const [index, character] of [[0, '推'], [2, '推'], [3, '去']]) {
    assert.equal(targetName().textContent, '推來推去'); assert.equal(markedPosition(targetName()), index);
    e.$('word-cards').childNodes[0].click(); await waitFor(() => snapshot().active.phase === 'watch');
    assert.equal(snapshot().active.occurrenceId, 'w0:' + index); assert.equal(e.$('word-title').textContent, '推來推去'); assert.equal(markedPosition(e.$('word-title')), index); assert.equal(e.mounts.at(-1).character, character);
    e.$('previous-step').click(); assert.equal(snapshot().active.phase, 'choose-word'); assert.equal(markedPosition(targetName()), index);
    e.$('word-cards').childNodes[0].click(); await waitFor(() => snapshot().active.phase === 'watch'); e.$('main-next').click();
    for (let round = 0; round < 2; round++) {
      for (let strokeIndex = 0; strokeIndex < 2; strokeIndex++) e.send('STROKE_ACCEPTED', { strokeIndex });
      e.send('WRITING_COMPLETE'); if (round === 0) { e.$('main-next').click(); assert(!visibleText(e.document).includes(character)); }
    }
    assert.equal(e.$('word-title').textContent, '推來推去'); assert.equal(markedPosition(e.$('word-title')), index); e.$('main-next').click();
    if (index !== 3) { await waitFor(() => snapshot().active.phase === 'watch'); assert.equal(snapshot().active.occurrenceId, 'w0:' + (index === 0 ? 2 : 3)); e.$('previous-step').click(); }
  }
  assert.equal(snapshot().active.phase, 'choose-word'); assert.equal(markedPosition(targetName()), 3);
  const completed = e.$('word-cards').childNodes[0]; assert(completed.disabled); assert(completed.textContent.includes('完成今次練習'));
  assert(completed.textContent.includes('推來推去')); assert.equal(e.$('word-cards').childNodes[1].textContent, '粗');
  const rows = S.summarize(snapshot()).filter(row => row.wordId === 'w0');
  assert.equal(rows.length, 3); assert(rows.every(row => row.independent && row.word === '推來推去'));
  assert.equal(new Set(rows.map(row => row.id)).size, 3);
});
test('zero selection or changed words cannot end the current valid lesson', async () => {
  const e = await feedbackApp(); e.send('STROKE_ACCEPTED', { strokeIndex: 0 }); e.$('teacher-open').click();
  const before = JSON.stringify(e.snapshot()); chooseCharacters(e, []); e.$('apply-words').click();
  assert.equal(JSON.stringify(e.snapshot()), before); assert(e.$('teacher-dialog').open); assert(e.$('teacher-error').textContent.includes('請揀'));
  e.$('teacher-words').value = '濃'; e.$('apply-words').click();
  assert.equal(JSON.stringify(e.snapshot()), before); assert(e.$('teacher-error').textContent.includes('詞語有改動'));
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
test('instruction speech keeps the current sentence when watch copy is hidden and never records help', async () => {
  const e = await feedbackApp(); e.voices.current = [{ lang: 'yue-HK', name: 'Cantonese' }, { lang: 'zh-CN', name: 'Mandarin' }]; e.voices.changed();
  assert.equal(e.$('practice-instruction').hidden, false);
  assert.equal(e.$('voice-note').textContent, '');
  assert.equal(e.voices.spoken.length, 0); const snapshot = JSON.stringify(e.snapshot()); e.$('hear-instruction').click();
  const utterance = e.voices.spoken.at(-1); assert.equal(utterance.text, e.$('practice-instruction').textContent); assert.equal(utterance.lang, 'yue-HK'); assert.equal(JSON.stringify(e.snapshot()), snapshot);
  const cancels = e.voices.cancels; e.send('STROKE_ACCEPTED', { strokeIndex: 0 }); assert(e.voices.cancels > cancels, 'changed visible cue cancels the old instruction');
  const changedCancels = e.voices.cancels; e.$('simplify').click(); assert.equal(e.voices.cancels, changedCancels); e.$('hear-instruction').click(); assert.equal(e.voices.spoken.length, 2); assert(e.voices.cancels > cancels);
  utterance.onerror(); assert(!e.$('instruction-voice-note').textContent.includes('未能朗讀'), 'stale error cannot replace a new request');
  e.voices.spoken.at(-1).onerror(); assert(e.$('instruction-voice-note').textContent.includes('未能朗讀'));
  assert.equal(e.snapshot().attempts.at(-1).help.length, 0);
  e.$('previous-step').click(); assert.equal(e.snapshot().active.phase, 'watch');
  assert.equal(e.$('practice-instruction').hidden, true); assert(!visibleText(e.document).includes('撳播放，睇筆順。'));
  e.$('hear-instruction').click(); assert.equal(e.voices.spoken.at(-1).text, '撳播放，睇筆順。');
  e.$('main-next').click(); assert.equal(e.$('practice-instruction').hidden, false);
  e.complete(); e.$('main-next').click(); assert.equal(e.$('practice-instruction').hidden, false);
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
    for (const id of ['practice-title', 'practice-instruction', 'hear-instruction', 'instruction-voice-note', 'speak-label', 'simplify', 'practice-tools-label']) {
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
  vm.runInContext(source('app.js'), e.context); startLocal(e); e.$('teacher-open').click();
  const closed = JSON.parse(e.store.get('bishun-school:v1:' + legacy.id)); assert.equal(closed.version, 1); assert.equal(closed.occurrences.length, 5); assert.equal(closed.attempts.at(-1).outcome, 'abandoned');
  assert(e.$('local-history').textContent.includes('自己完成 0 · 有提示完成 1 · 跳過 0 · 待練 4')); assert(e.$('local-history').textContent.includes('推來推去 第 3 字「推」待練'));
});

test('pinned vendor keeps one pointer-end listener pair across repeated mounts and disposals', async () => {
  const e = environment();
  vm.runInContext(source('vendor/hanzi-writer.min.js'), e.context);
  const settings = [], Vendor = e.context.HanziWriter;
  e.context.HanziWriter = new Proxy(Vendor, { construct(Target, args) { settings.push(args[1]); return Reflect.construct(Target, args); } });
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
  assert.equal(settings[0].strokeAnimationSpeed, 0.45); assert.equal(settings[0].delayBetweenStrokes, 520); assert.equal(settings[0].strokeHighlightSpeed, 0.65);
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
async function quizApp({ autoReady = true, failMount = false } = {}) {
  const e = environment(source('index.html')); e.mounts = []; e.clock = 100;
  e.context.performance = { now: () => e.clock };
  e.context.BishunSession = S; e.context.HanziWriter = {};
  e.context.BishunContent = { words: ['推來推去'], photos: { '推來推去': 'images/push-block.webp' }, cue: () => ['例子', 'M1 1L2 2'] };
  e.context.BishunWriting = {
    loadCharacter: () => Promise.resolve({ strokes: ['M1 1L2 2', 'M1 3L2 3'] }),
    mount(_element, character, _data, options) {
      e.mounts.push({ ...options, character });
      if (failMount) throw new Error('tool unavailable');
      if (autoReady) queueMicrotask(options.onReady);
      return { dispose() {}, pause() {}, suspend() {}, showHelp() { assert.fail('quiz cannot request hints'); } };
    }
  };
  vm.runInContext(source('app.js'), e.context);
  e.snapshot = () => JSON.parse(e.store.get('bishun-school:v1:' + e.store.get('bishun-school:v1:current')));
  e.send = (type, extra = {}, mount = e.mounts.at(-1)) => mount.onEvent({ type, token: mount.token, ...extra });
  e.enter = async () => { startLocal(e, 'quiz'); e.$('word-cards').childNodes[0].click(); await waitFor(() => e.mounts.length > 0); };
  return e;
}
test('boot creates no phantom history and both home modes share only the applied teacher selection', async () => {
  const e = await quizApp(); assert.equal(e.store.size, 0); assert.equal(e.$('home-view').hidden, false);
  e.$('teacher-open').click(); chooseCharacters(e, ['w0:2']); e.$('teacher-close').click();
  await e.enter(); assert.equal(e.snapshot().occurrences[0].index, 0, 'cancel discards draft');
  assert.equal(e.snapshot().mode, 'quiz'); e.document.querySelector('.brand').click(); assert.equal(e.$('home-view').hidden, false);
  e.$('teacher-open').click(); chooseCharacters(e, ['w0:2']); e.$('apply-words').click(); assert.equal(e.$('home-view').hidden, false);
  startLocal(e); const practice = e.snapshot(); assert.equal(practice.mode, 'practice'); assert.equal(practice.occurrences[0].index, 2);
  e.$('choice-summary').click(); e.$('group-home').click(); startLocal(e, 'quiz'); const quiz = e.snapshot(); assert.equal(quiz.mode, 'quiz'); assert.notEqual(quiz.id, practice.id); assert.deepEqual(quiz.occurrences, practice.occurrences);
  e.$('teacher-open').click(); assert(e.$('local-history').textContent.includes('測驗')); assert(e.$('local-history').textContent.includes('練習'));
});
test('quiz gives a neutral retry cue and completion circle without hints, ticks, outlines or an automatic next', async () => {
  const e = await quizApp(); e.$('teacher-open').click(); chooseCharacters(e, ['w0:0']); e.$('apply-words').click(); await e.enter();
  assert.equal(e.$('practice-instruction').hidden, true); assert(!visibleText(e.document).includes('照住題目，自己寫。'));
  e.voices.current = [{ lang: 'yue-HK', name: 'Cantonese' }]; e.$('hear-instruction').click(); assert.equal(e.voices.spoken.at(-1).text, '照住題目，自己寫。');
  assert.equal(e.snapshot().active.phase, 'quiz'); assert.equal(e.$('word-title').textContent, '推來推去'); assert.equal(markedPosition(e.$('word-title')), 0); assert.equal(e.mounts.at(-1).character, '推'); assert.equal(e.$('semantic-cue').childNodes[0].attributes.src, 'images/push-block.webp');
  assert(e.document.querySelector('.step-rail').hidden); assert(e.$('demo-controls').hidden); assert(e.$('hint-outline').hidden); assert(e.$('hint-stroke').hidden); assert(e.$('main-next').hidden);
  for (let i = 0; i < 3; i++) e.send('STROKE_MISSED', { strokeIndex: 0 });
  assert.equal('hidden' in e.$('quiz-mark').attributes, true); assert.equal(e.$('feedback-text').textContent, '再試呢一畫。'); assert.equal(e.$('feedback-icon').hidden, true); assert.equal(e.$('feedback-icon').textContent, ''); assert.equal(e.snapshot().attempts[0].mistakes, 3); assert.equal(e.snapshot().attempts[0].help.length, 0);
  e.$('hint-outline').click(); e.$('hint-stroke').click(); assert.equal(e.snapshot().attempts[0].help.length, 0);
  e.$('writer').emit('pointerdown'); assert.equal('hidden' in e.$('quiz-mark').attributes, true);
  e.send('STROKE_ACCEPTED', { strokeIndex: 0 }); assert.equal(e.$('feedback-icon').textContent, ''); assert.equal(e.$('stroke-progress').textContent, ''); assert.equal('hidden' in e.$('quiz-mark').attributes, true);
  e.send('STROKE_ACCEPTED', { strokeIndex: 1 }); e.send('WRITING_COMPLETE');
  assert.equal('hidden' in e.$('quiz-mark').attributes, false); assert.equal(e.snapshot().active.phase, 'character-complete');
  assert.equal(e.$('practice-instruction').hidden, true);
  assert.equal(e.$('quiz-clock-value').textContent, '0.0 秒'); const attempts = e.snapshot().attempts.length;
  e.$('retry-writing').click(); assert.equal(e.snapshot().attempts.length, attempts + 1); assert.equal(e.snapshot().finished.length, 1); assert.equal('hidden' in e.$('quiz-mark').attributes, true);
  e.$('teacher-open').click(); e.$('teacher-skip').click(); assert.equal('hidden' in e.$('quiz-mark').attributes, true); assert.equal(e.snapshot().active.completedPhase, 'skipped');
  e.$('main-next').click(); assert.equal(e.snapshot().active.phase, 'summary'); assert(!e.$('summary-view').textContent.includes('秒'));
});
test('quiz clock counts only ready foreground writing and checkpoints exact milliseconds across overlapping pauses', async () => {
  const e = await quizApp({ autoReady: false }); await e.enter();
  assert.equal(e.snapshot().attempts[0].elapsedMs, null); e.clock = 5000; e.mounts.at(-1).onReady(); assert.equal(e.snapshot().attempts[0].elapsedMs, 0);
  e.clock = 5123.5; e.$('rest').click(); assert.equal(e.snapshot().attempts[0].elapsedMs, 123.5);
  const stale = e.mounts[0]; e.clock = 6000; stale.onReady(); e.send('STROKE_ACCEPTED', { strokeIndex: 0 }, stale); assert.equal(e.snapshot().active.currentStroke, 0);
  e.document.hidden = true; e.document.emit('visibilitychange'); e.$('resume').click(); assert.equal(e.mounts.length, 1);
  e.clock = 10000; e.document.hidden = false; e.document.emit('visibilitychange'); assert.equal(e.mounts.length, 2);
  stale.onReady(); e.clock = 15000; e.mounts[1].onReady(); e.clock = 15200; e.$('teacher-open').click(); assert.equal(e.snapshot().attempts[0].elapsedMs, 323.5);
  e.clock = 19000; e.document.hidden = true; e.document.emit('visibilitychange'); e.$('teacher-close').click(); assert.equal(e.mounts.length, 2);
  e.clock = 20000; e.document.hidden = false; e.document.emit('visibilitychange'); e.mounts[2].onReady();
  e.clock = 20300; e.send('STROKE_ACCEPTED', { strokeIndex: 0 }); assert.equal(e.snapshot().attempts[0].elapsedMs, 623.5);
  e.clock = 20400; e.emitWindow('pagehide'); assert.equal(e.snapshot().attempts[0].elapsedMs, 723.5);
  e.clock = 30000; e.emitWindow('pagehide'); assert.equal(e.snapshot().attempts[0].elapsedMs, 723.5);
  e.emitWindow('pageshow'); e.mounts[3].onReady(); e.clock = 30500; e.send('STROKE_ACCEPTED', { strokeIndex: 1 }); e.send('WRITING_COMPLETE'); assert.equal(e.snapshot().attempts[0].elapsedMs, 1223.5);
  e.clock = 40000; e.$('teacher-open').click(); assert.equal(e.snapshot().attempts[0].elapsedMs, 1223.5); assert(e.$('local-history').textContent.includes('1.2 秒'));
  e.$('teacher-close').click(); assert.equal(e.$('quiz-clock-value').textContent, '1.2 秒'); e.document.querySelector('.brand').click();
  const closed = [...e.store.values()].map(value => { try { return JSON.parse(value); } catch { return null; } }).find(value => value && value.mode === 'quiz'); assert.equal(closed.attempts[0].elapsedMs, 1223.5); assert.equal(closed.active.phase, 'summary');
});
test('visible timer ticks read the sole controller clock without storage writes and freeze at pauses and completion', async () => {
  const e = await quizApp({ autoReady: false }), timers = new Map(); let timerId = 0;
  e.context.setTimeout = callback => { timers.set(++timerId, callback); return timerId; }; e.context.clearTimeout = id => timers.delete(id);
  await e.enter(); assert.equal(e.$('quiz-clock-value').textContent, '未開始');
  e.mounts.at(-1).onReady(); const saved = e.snapshot(); let writes = 0;
  const original = e.context.localStorage.setItem; e.context.localStorage.setItem = (...args) => { writes++; original(...args); };
  const tick = () => { const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach(callback => callback()); };
  e.clock = 1334; tick(); assert.equal(e.$('quiz-clock-value').textContent, '1.2 秒'); assert.equal(writes, 0); assert.deepEqual(e.snapshot(), saved);
  e.$('rest').click(); const pausedWrites = writes; e.clock = 9000; tick(); assert.equal(e.$('quiz-clock-value').textContent, '1.2 秒'); assert.equal(writes, pausedWrites); assert.equal(timers.size, 0);
  e.$('resume').click(); e.mounts.at(-1).onReady(); e.clock = 9500;
  e.send('STROKE_ACCEPTED', { strokeIndex: 0 }); e.send('STROKE_ACCEPTED', { strokeIndex: 1 }); e.send('WRITING_COMPLETE');
  assert.equal(e.$('quiz-clock-value').textContent, '1.7 秒'); const doneWrites = writes; e.clock = 20000; tick(); assert.equal(writes, doneWrites); assert.equal(timers.size, 0);
});

async function classroomApp({ uploadFails = false, holdUpload = false, restoredStore, assignment = [{ text: '二一', selectedIndexes: [0, 1] }] } = {}) {
  const e = environment(source('index.html')); e.mounts = []; e.calls = []; e.navigation = []; e.clock = 10;
  if (restoredStore) for (const [key, value] of restoredStore) e.store.set(key, value);
  e.context.crypto = require('node:crypto').webcrypto; e.context.performance = { now: () => e.clock };
  e.context.HanziWriter = {};
  e.context.location.assign = url => e.navigation.push(url);
  e.context.BishunSession = S; e.context.BishunWriting = {
    loadCharacter: () => Promise.resolve({ strokes: ['M1 1L2 2'] }),
    mount(_el, _char, _data, options) { e.mounts.push(options); queueMicrotask(options.onReady); return { dispose() {}, pause() {} }; }
  };
  e.context.fetch = async (url, options) => {
    e.calls.push({ url, ...options });
    if (url.endsWith('/members')) return { ok: true, json: async () => ({ code: 'ABCDEFGH', memberId: 'member-1', alias: '小星', expiresAt: Date.now() + 100000, assignment: { version: 1, entries: assignment } }) };
    if (uploadFails) throw new Error('offline');
    const response = { ok: true, json: async () => ({ runId: JSON.parse(options.body).runId, ranked: true, reason: null, score: { mistakes: 0, elapsedMs: 200 } }) };
    return holdUpload ? new Promise(resolve => { e.releaseUpload = () => resolve(response); }) : response;
  };
  for (const file of ['content.js', 'quiz-results.js', 'classroom.js', 'app.js']) vm.runInContext(source(file), e.context);
  if (restoredStore) return e;
  e.$('class-open').click(); e.$('class-code').value = 'ABCDEFGH'; e.$('class-alias').value = '小星'; e.$('class-join').click();
  await waitFor(() => e.$('class-identity').textContent.includes('小星'));
  e.$('class-start').click(); e.$('word-cards').childNodes[0].click(); await waitFor(() => e.mounts.length === 1);
  e.snapshot = () => JSON.parse(e.store.get('bishun-school:v1:' + e.store.get('bishun-school:v1:current')));
  e.complete = () => { const mount = e.mounts.at(-1); e.clock += 100; mount.onEvent({ type: 'STROKE_ACCEPTED', strokeIndex: 0, token: mount.token }); mount.onEvent({ type: 'WRITING_COMPLETE', token: mount.token }); e.$('main-next').click(); };
  e.allowUpload = () => { uploadFails = false; };
  return e;
}
test('class quiz uses its immutable assignment and automatically opens separate leaderboard only after a whole receipt', async () => {
  const e = await classroomApp(); assert.equal(e.snapshot().entries[0].text, '二一');
  e.complete(); await waitFor(() => e.mounts.length === 2); assert.equal(e.calls.length, 1); assert.equal(e.navigation.length, 0);
  e.complete(); await waitFor(() => e.navigation.length === 1);
  assert.deepEqual(e.navigation, ['leaderboard.html']); assert.equal(e.calls.filter(call => call.method === 'PUT').length, 1);
  const handoff = JSON.parse(e.store.get('bishun:board-handoff')); assert.equal(handoff.memberId, 'member-1'); assert.equal(handoff.runId, e.snapshot().id);
  e.$('teacher-open').click(); e.$('teacher-close').click(); assert.equal(e.navigation.length, 1, 'summary rerenders do not navigate or resubmit');
});
test('class assignments keep every assigned word and their word-list Back returns home without local groups', async () => {
  const assignment = [{ text: '二一', selectedIndexes: [1] }, { text: '粗', selectedIndexes: [0] }, { text: '密', selectedIndexes: [0] }, { text: '剪草機', selectedIndexes: [2] }];
  const e = await classroomApp({ assignment }), sessionId = e.snapshot().id;
  assert.deepEqual(e.snapshot().entries.map(word => word.text), ['二一', '粗', '密', '剪草機']);
  assert.deepEqual(e.snapshot().occurrences.map(item => item.index), [1, 0, 0, 2]);
  e.$('previous-step').click(); assert.equal(e.$('word-cards').childNodes.length, 4); assert.equal(e.$('choice-summary').textContent, '返回首頁');
  e.$('choice-summary').click(); assert.equal(e.$('home-view').hidden, false); assert.equal(e.$('group-view').hidden, true);
  const ended = JSON.parse(e.store.get('bishun-school:v1:' + sessionId)); assert.equal(ended.active.phase, 'summary'); assert.equal(ended.attempts[0].outcome, 'abandoned');
  e.$('start-quiz').click(); assert.equal(e.$('group-view').hidden, false); assert.equal(e.$('group-cards').childNodes[0].textContent, '測驗1粗、濃、鬍鬚');
  assert.equal(e.calls.filter(call => call.method === 'PUT').length, 0);
});
test('offline completion keeps exact pending evidence and navigates once after explicit retry succeeds', async () => {
  const e = await classroomApp({ uploadFails: true }); e.complete(); await waitFor(() => e.mounts.length === 2); e.complete();
  await waitFor(() => e.$('class-result-status').textContent.includes('尚未交'));
  assert.equal(e.navigation.length, 0); assert.equal(e.$('class-retry').hidden, false); const original = e.calls.at(-1).body;
  e.allowUpload(); e.$('class-retry').click(); await waitFor(() => e.navigation.length === 1);
  assert.equal(e.calls.at(-1).body, original); assert.equal(e.navigation[0], 'leaderboard.html');
});
test('cold restored pending run navigates once after explicit continue and retry', async () => {
  const first = await classroomApp({ uploadFails: true }); first.complete(); await waitFor(() => first.mounts.length === 2); first.complete();
  await waitFor(() => first.$('class-result-status').textContent.includes('尚未交'));
  const original = first.calls.at(-1).body;
  const e = await classroomApp({ restoredStore: first.store });
  assert.equal(e.navigation.length, 0);
  e.$('class-open').click(); assert.equal(e.$('class-continue').hidden, false);
  e.$('class-continue').click(); assert.equal(e.$('class-pending-retry').hidden, false);
  e.$('class-pending-retry').click(); await waitFor(() => e.navigation.length === 1);
  assert.equal(e.calls.at(-1).body, original);
  assert.deepEqual(e.navigation, ['leaderboard.html']);
  assert.equal(e.$('class-dialog').open, false);
  e.$('teacher-open').click(); e.$('teacher-close').click(); assert.equal(e.navigation.length, 1);
});
test('a late committed upload does not pull a learner out of a newly started local practice', async () => {
  const e = await classroomApp({ holdUpload: true }); e.complete(); await waitFor(() => e.mounts.length === 2); e.complete();
  await waitFor(() => typeof e.releaseUpload === 'function');
  e.$('new-session').click(); startLocal(e); e.releaseUpload();
  await waitFor(() => JSON.parse(e.store.get('bishun:classroom:v1')).receipt);
  assert.equal(e.navigation.length, 0); assert.equal(e.snapshot().mode, 'practice');
});
test('automatic board handoff waits until teacher tools close and the summary is visible', async () => {
  const e = await classroomApp({ holdUpload: true }); e.complete(); await waitFor(() => e.mounts.length === 2); e.complete();
  await waitFor(() => typeof e.releaseUpload === 'function');
  e.$('teacher-open').click(); e.document.hidden = true; e.document.emit('visibilitychange'); e.releaseUpload();
  await waitFor(() => JSON.parse(e.store.get('bishun:classroom:v1')).receipt);
  assert.equal(e.navigation.length, 0); e.$('teacher-close').click(); assert.equal(e.navigation.length, 0);
  e.document.hidden = false; e.document.emit('visibilitychange'); assert.deepEqual(e.navigation, ['leaderboard.html']);
});

test('dedicated board consumes immediate handoff once, polls only visibly and requires confirmation on cold visits', async () => {
  for (const immediate of [true, false]) {
    const e = environment(source('leaderboard.html')), timers = new Map(); let nextTimer = 0, reads = 0;
    e.context.setTimeout = callback => { timers.set(++nextTimer, callback); return nextTimer; }; e.context.clearTimeout = id => timers.delete(id);
    e.context.crypto = require('node:crypto').webcrypto;
    const member = { code: 'ABCDEFGH', memberId: 'me', alias: '小星', token: 'a'.repeat(64), expiresAt: Date.now() + 600000, assignment: { version: 1, entries: [{ text: '一', selectedIndexes: [0] }] } };
    e.store.set('bishun:classroom:v1', JSON.stringify({ member, receipt: { runId: 'done', ranked: true } }));
    if (immediate) e.store.set('bishun:board-handoff', JSON.stringify({ memberId: 'me', runId: 'done', at: Date.now() }));
    e.context.sessionStorage.removeItem = key => e.store.delete(key);
    e.context.fetch = async () => { reads++; return { ok: true, json: async () => ({ rows: [{ memberId: 'me', alias: '小星', rank: 1, mistakes: 0, elapsedMs: 1000, isMe: true }], personalBest: { mistakes: 0, elapsedMs: 1000 } }) }; };
    for (const file of ['quiz-results.js', 'classroom.js', 'leaderboard.js']) vm.runInContext(source(file), e.context);
    if (!immediate) { assert.equal(reads, 0); assert.equal(e.$('board-continue').hidden, false); e.$('board-continue').click(); }
    await waitFor(() => e.$('board-results').textContent.includes('小星'));
    assert.equal(reads, 1); assert.equal(e.store.has('bishun:board-handoff'), false); assert.equal(timers.size, 1);
    e.document.hidden = true; e.document.emit('visibilitychange'); assert.equal(timers.size, 0);
    e.document.hidden = false; e.document.emit('visibilitychange'); await waitFor(() => reads === 2 && timers.size === 1);
    e.emitWindow('pagehide'); assert.equal(timers.size, 0);
  }
});
test('mount failures are recoverable and stale same-token callbacks cannot ready a later mount', async () => {
  const e = await quizApp({ failMount: true }); await e.enter(); assert.equal(e.snapshot().active.phase, 'unavailable'); assert.equal(e.snapshot().attempts[0].elapsedMs, null);
  assert.equal(e.$('practice-instruction').hidden, false);
  const failed = e.mounts[0]; e.context.BishunWriting.mount = (_el, _char, _data, options) => { e.mounts.push(options); queueMicrotask(options.onReady); return { dispose() {}, pause() {} }; };
  e.$('retry-data').click(); await waitFor(() => e.snapshot().active.phase === 'quiz'); await new Promise(resolve => setImmediate(resolve));
  failed.onReady(); failed.onError(); assert.equal(e.snapshot().active.phase, 'quiz'); assert.equal(e.snapshot().attempts.at(-1).elapsedMs, 0);
  assert.equal(e.snapshot().attempts[0].outcome, 'abandoned'); assert.equal(S.validateSnapshot(e.snapshot()), true);
  e.context.localStorage.setItem = () => { throw new Error('quota'); }; e.send('STROKE_MISSED', { strokeIndex: 0 }); assert.equal(e.$('storage-notice').hidden, false); assert.equal('hidden' in e.$('quiz-mark').attributes, true);
});
test('pinned vendor retains original accepted ink through remount and resize while keeping canonical quiz strokes transparent', async () => {
  const e = environment(); vm.runInContext(source('vendor/hanzi-writer.min.js'), e.context); vm.runInContext(source('writing.js'), e.context);
  const W = e.context.BishunWriting, element = e.$('writer'), events = [];
  const data = { strokes: ['M100 500L900 500Z', 'M100 300L900 300Z'], medians: [[[100, 500], [900, 500]], [[100, 300], [900, 300]]], radStrokes: [1] };
  let ready = 0, size = 360; element.getBoundingClientRect = () => ({ width: size, height: size, left: 0, top: 0 });
  const mount = (token, currentStroke, phase = 'quiz') => W.mount(element, '二', data, { token, currentStroke, phase, onEvent: event => events.push(event), onReady: () => ready++ });
  const paths = () => walk(element).filter(node => node.nodeName === 'path');
  const ink = () => paths().filter(node => node.attributes['vector-effect'] === 'non-scaling-stroke');
  const draw = y => {
    const svg = element.childNodes.find(node => node.nodeName === 'svg'), t = e.context.HanziWriter.getScalingTransform(size, size, 24);
    const point = x => ({ clientX: t.x + x * t.scale, clientY: size - t.y - y * t.scale });
    svg.emit('mousedown', point(110)); for (let x = 210; x <= 910; x += 100) svg.emit('mousemove', point(x)); e.document.emit('mouseup');
  };
  let handle = mount('quiz-ink', 0); await waitFor(() => ready === 1); draw(510); await waitFor(() => events.length === 1);
  assert.equal(events[0].type, 'STROKE_ACCEPTED'); assert.equal(ink().length, 1); const original = ink()[0].attributes.d;
  assert(original.includes('510')); assert.notEqual(original, data.strokes[0]); assert.equal(ink()[0].attributes['stroke-width'], '8');
  for (const path of paths().filter(node => node.attributes['clip-path'])) assert.equal(path.attributes.stroke, 'rgba(33,75,59,0)');
  size = 400; [...e.observers][0].callback(); assert.equal(ink()[0].attributes.d, original);
  assert(walk(element).some(node => node.attributes.transform === e.context.HanziWriter.getScalingTransform(400, 400, 24).transform));
  handle.showHelp('outline'); handle.showHelp('stroke'); handle.play(true); handle.nextStroke(); handle.dispose();
  size = 420; handle = mount('quiz-ink', 1); await waitFor(() => ready === 2); assert.equal(ink()[0].attributes.d, original); assert.equal(ink().length, 1);
  assert(walk(element).some(node => node.attributes.transform === e.context.HanziWriter.getScalingTransform(420, 420, 24).transform));
  draw(310); await waitFor(() => events.some(event => event.type === 'WRITING_COMPLETE')); assert.equal(ink().length, 2);
  for (const path of paths().filter(node => node.attributes['clip-path'])) assert.equal(path.attributes.stroke, 'rgba(33,75,59,0)');
  handle.dispose(); handle = mount('retry-ink', 0); await waitFor(() => ready === 3); assert.equal(ink().length, 0);
  handle.dispose(); handle = mount('practice', 0, 'guided'); await waitFor(() => ready === 4);
  const restored = paths().filter(node => node.attributes['clip-path']).map(node => node.attributes.stroke);
  assert(restored.includes('rgba(33,75,59,1)')); assert(restored.includes('rgba(215,221,212,1)')); assert(restored.includes('rgba(186,100,45,1)')); assert(!restored.includes('rgba(33,75,59,0)'));
  assert.equal(e.document.listeners.mouseup.length, 1); assert.equal(e.document.listeners.touchend.length, 1); handle.dispose();
});
test('completed quiz keeps the same board and circle across rest, teacher and background without restarting time', async () => {
  const e = await quizApp(); await e.enter(); e.clock = 350;
  e.send('STROKE_ACCEPTED', { strokeIndex: 0 }); e.send('STROKE_ACCEPTED', { strokeIndex: 1 }); e.send('WRITING_COMPLETE');
  const count = e.mounts.length, elapsed = e.snapshot().attempts[0].elapsedMs;
  e.$('rest').click(); e.clock = 1000; e.$('resume').click(); e.$('teacher-open').click(); e.clock = 2000; e.$('teacher-close').click();
  e.document.hidden = true; e.document.emit('visibilitychange'); e.clock = 3000; e.document.hidden = false; e.document.emit('visibilitychange');
  assert.equal(e.mounts.length, count); assert.equal(e.snapshot().attempts[0].elapsedMs, elapsed); assert.equal(e.snapshot().active.phase, 'character-complete');
  assert.equal('hidden' in e.$('quiz-mark').attributes, false);
});
test('retry, previous and home retain exact abandoned time and cold reload never extrapolates it', async () => {
  const e = await quizApp(); await e.enter(); const id = e.snapshot().id;
  e.clock = 250; e.$('retry-writing').click(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(e.snapshot().attempts[0].elapsedMs, 150); assert.equal(e.snapshot().attempts[0].outcome, 'abandoned');
  e.clock = 450; e.$('previous-step').click(); assert.equal(e.snapshot().active.phase, 'choose-word'); assert.equal(e.snapshot().attempts[1].elapsedMs, 200);
  e.$('word-cards').childNodes[0].click(); await waitFor(() => e.snapshot().active.phase === 'quiz'); e.clock = 550;
  e.document.querySelector('.brand').click(); const closed = JSON.parse(e.store.get('bishun-school:v1:' + id));
  assert.equal(closed.attempts[2].elapsedMs, 100); assert.equal(S.summarize(closed)[0].elapsedMs, 450);
  const reload = environment(source('index.html')); const interrupted = structuredClone(closed); interrupted.active = { ...closed.active, phase: 'quiz', token: interrupted.attempts[2].id, attemptId: interrupted.attempts[2].id, occurrenceId: 'w0:0' }; delete interrupted.endedAt;
  interrupted.attempts[2].outcome = 'active'; delete interrupted.attempts[2].endedAt;
  reload.store.set('bishun-school:v1:' + id, JSON.stringify(interrupted)); reload.store.set('bishun-school:v1:current', id);
  reload.context.BishunSession = S; reload.context.BishunWriting = {}; reload.context.BishunContent = e.context.BishunContent;
  vm.runInContext(source('app.js'), reload.context); const saved = JSON.parse(reload.store.get('bishun-school:v1:' + id));
  assert.equal(saved.active.phase, 'summary'); assert.equal(saved.attempts[2].elapsedMs, 100); assert.equal(saved.version, 3); assert.equal(reload.$('home-view').hidden, false);
});
test('same-token loading restart ignores old failure and only accepts the new request', async () => {
  const e = await quizApp(); const requests = [];
  e.context.BishunWriting.loadCharacter = () => new Promise((resolve, reject) => requests.push({ resolve, reject }));
  startLocal(e, 'quiz'); e.$('word-cards').childNodes[0].click(); await waitFor(() => requests.length === 1);
  assert.equal(e.$('practice-instruction').hidden, false);
  e.$('rest').click(); e.$('resume').click(); await waitFor(() => requests.length === 2);
  requests[0].reject(new Error('old abort')); await new Promise(resolve => setImmediate(resolve)); assert.equal(e.snapshot().active.phase, 'loading');
  requests[1].resolve({ strokes: ['M1 1L2 2'] }); await waitFor(() => e.snapshot().active.phase === 'quiz'); assert.equal(e.snapshot().attempts.length, 1);
});
test('pinned vendor mount queue recovers after setup rejection and only latest mount announces readiness', async () => {
  const e = environment(); vm.runInContext(source('vendor/hanzi-writer.min.js'), e.context); vm.runInContext(source('writing.js'), e.context);
  const prototype = e.context.HanziWriter.prototype, original = prototype.setCharacter;
  let first = true;
  prototype.setCharacter = function(character) { if (first) { first = false; return Promise.reject(new Error('setup failed')); } return original.call(this, character); };
  const data = { strokes: ['M100 500L900 500Z'], medians: [[[100, 500], [900, 500]]] }, ready = [], errors = [];
  const options = token => ({ phase: 'quiz', token, onEvent() {}, onReady: () => ready.push(token), onError: error => errors.push(error.message) });
  const W = e.context.BishunWriting, element = e.$('writer');
  let handle = W.mount(element, '一', data, options('failed')); await waitFor(() => errors.length === 1); assert.deepEqual(ready, []); handle.dispose();
  handle = W.mount(element, '一', data, options('stale')); handle.dispose();
  handle = W.mount(element, '一', data, options('current')); await waitFor(() => ready.length === 1); assert.deepEqual(ready, ['current']); handle.dispose();
});
test('practice recall keeps its recorded outline assistance after teacher and rest remounts', async () => {
  const e = await feedbackApp(); e.complete(); e.$('main-next').click();
  e.$('teacher-open').click(); e.$('teacher-close').click();
  assert(e.mounts.at(-1).help.some(item => item.kind === 'outline')); const count = e.snapshot().attempts.at(-1).help.length;
  e.$('rest').click(); e.$('resume').click(); assert(e.mounts.at(-1).help.some(item => item.kind === 'outline')); assert.equal(e.snapshot().attempts.at(-1).help.length, count);
});
test('writer rejects malformed accepted ink and missing remount ink as recoverable tool failures', async () => {
  const e = environment(); vm.runInContext(source('vendor/hanzi-writer.min.js'), e.context); vm.runInContext(source('writing.js'), e.context);
  const prototype = e.context.HanziWriter.prototype, originalQuiz = prototype.quiz; let callbacks;
  prototype.quiz = function(options) { callbacks = options; return originalQuiz.call(this, options); };
  const W = e.context.BishunWriting, data = { strokes: ['M100 500L900 500Z'], medians: [[[100, 500], [900, 500]]] }, errors = [], events = [];
  let ready = 0, handle;
  for (const points of [null, [{ x: NaN, y: 2 }, { x: 4, y: 5 }], [{ x: 9000, y: 2 }, { x: 4, y: 5 }], Array(16385).fill({ x: 1, y: 2 })]) {
    const count = ready, errorCount = errors.length;
    handle = W.mount(e.$('writer'), '一', data, { phase: 'quiz', token: 'bad-' + count, onReady: () => ready++, onError: error => errors.push(error), onEvent: event => events.push(event) });
    await waitFor(() => ready > count); callbacks.onCorrectStroke({ strokeNum: 0, drawnPath: { points } });
    assert.equal(errors.length, errorCount + 1); assert.equal(events.length, 0); assert.equal(e.$('writer').style.visibility, 'hidden'); handle.dispose();
  }
  const errorCount = errors.length;
  handle = W.mount(e.$('writer'), '一', data, { phase: 'quiz', token: 'missing', currentStroke: 1, onReady: () => assert.fail('missing ink cannot become ready'), onError: error => errors.push(error), onEvent: event => events.push(event) });
  await waitFor(() => errors.length > errorCount); handle.dispose();
});

test('watch navigation opens every demo, resets playback and writes the shown glyph', async () => {
  for (const text of ['鬍鬚', '剪草機', '推來推去', '一二三四五六七八']) {
    const e = await feedbackApp(text, 2, false), played = [], disposed = [];
    const old = e.mounts.at(-1);
    e.context.BishunWriting.mount = (_element, character, _data, options) => {
      const mount = { ...options, character }; e.mounts.push(mount);
      return { dispose() { disposed.push(mount); }, pause() {}, play() { played.push(character); options.onDemoState('playing'); } };
    };
    assert.equal(e.$('demo-navigation').hidden, false); assert.equal(e.$('demo-previous').hidden, true);
    const chars = Array.from(text);
    for (let index = 1; index < chars.length; index++) {
      assert.equal(e.$('demo-next').textContent, '下一字：' + chars[index]);
      e.$('demo-next').click(); assert.equal(e.$('demo-navigation').hidden, true);
      await waitFor(() => e.snapshot().active.phase === 'watch');
      assert.equal(e.snapshot().active.occurrenceId, 'w0:' + index); assert.equal(e.mounts.at(-1).character, chars[index]);
      assert.equal(e.$('word-title').textContent, text); assert.equal(e.$('play').textContent, '▶ 播放');
      assert.equal(played.length, index - 1, 'browsing never autoplays'); e.$('play').click(); assert.equal(played.at(-1), chars[index]);
      const before = JSON.stringify(e.snapshot()); old.onDemoState('paused'); old.onError(); e.send('WRITING_COMPLETE', {}, old); assert.equal(JSON.stringify(e.snapshot()), before); assert.equal(e.$('play').textContent, '▶ 播放');
    }
    assert.equal(e.$('demo-next').hidden, true);
    e.$('demo-previous').click(); await waitFor(() => e.snapshot().active.phase === 'watch');
    assert.equal(e.snapshot().active.occurrenceId, 'w0:' + (chars.length - 2)); assert(disposed.length > 0);
    assert.deepEqual(e.snapshot().attempts, []); assert.deepEqual(e.snapshot().finished, []);
    e.$('main-next').click(); assert.equal(e.mounts.at(-1).character, chars.at(-2)); assert.equal(e.snapshot().attempts[0].occurrenceId, 'w0:' + (chars.length - 2)); assert.equal(e.$('demo-navigation').hidden, true);
    assert(e.mounts.every(mount => Array.from(mount.character).length === 1));
  }
});

test('sparse repeated demo positions keep their own targets and a single assigned position hides navigation', async () => {
  for (const indexes of [[0, 2, 3], [3]]) {
    const e = await feedbackApp(); e.$('teacher-open').click(); e.$('teacher-words').value = '推來推去'; e.$('validate-words').click();
    chooseCharacters(e, indexes.map(index => 'w0:' + index)); e.$('apply-words').click(); startLocal(e);
    e.snapshot = () => JSON.parse(e.store.get('bishun-school:v1:' + e.store.get('bishun-school:v1:current')));
    e.$('word-cards').childNodes[0].click(); await waitFor(() => e.snapshot().active.phase === 'watch');
    assert.equal(e.$('demo-navigation').hidden, indexes.length === 1);
    for (const index of indexes.slice(1)) {
      e.$('demo-next').click(); await waitFor(() => e.snapshot().active.phase === 'watch');
      assert.equal(e.snapshot().active.occurrenceId, 'w0:' + index); assert.equal(e.mounts.at(-1).character, Array.from('推來推去')[index]);
    }
    assert.deepEqual(e.snapshot().attempts, []); assert.deepEqual(e.snapshot().finished, []);
    e.$('rest').click(); assert.equal(e.$('demo-navigation').hidden, true); const before = JSON.stringify(e.snapshot()); e.$('demo-previous').emit('click'); assert.equal(JSON.stringify(e.snapshot()), before);
  }
});
async function demoApp(words = '鬍鬚', indexes, autoReady = true) {
  const e = environment(source('index.html')); e.mounts = []; e.played = [];
  e.context.BishunSession = S; e.context.HanziWriter = {};
  e.context.BishunContent = { words: words.split('\n'), cue: () => ['例子', 'M1 1L2 2'] };
  e.context.BishunWriting = {
    loadCharacter: () => Promise.resolve({ strokes: ['M1 1L2 2'] }),
    mount(_el, character, _data, options) {
      const mount = { ...options, character }; e.mounts.push(mount);
      if (autoReady) options.onReady();
      return { dispose() {}, play() { e.played.push(mount); options.onDemoState('playing'); }, pause() {}, nextStroke() {} };
    }
  };
  vm.runInContext(source('app.js'), e.context);
  if (indexes) {
    e.$('teacher-open').click(); chooseCharacters(e, indexes.map(index => 'w0:' + index)); e.$('apply-words').click();
  }
  startLocal(e);
  e.snapshot = () => JSON.parse(e.store.get('bishun-school:v1:' + e.store.get('bishun-school:v1:current')));
  e.$('word-cards').childNodes[0].click(); await waitFor(() => e.mounts.length === 1);
  return e;
}
const flushDemo = () => new Promise(resolve => setImmediate(resolve));

test('full demos autoplay each assigned occurrence once and stop within the selected word without recording writing', async () => {
  for (const [text, indexes] of [['鬍鬚'], ['剪草機'], ['推來推去'], ['一二三四五六七八'], ['推來推去', [0, 2, 3]], ['推來推去', [3]], ['粗'], ['鬍鬚\n剪草機\n粗']]) {
    const e = await demoApp(text, indexes), chars = Array.from(text.split('\n')[0]), expected = indexes || chars.map((_, index) => index);
    assert.equal(e.played.length, 0); e.$('play').click();
    for (const index of expected) {
      const mount = e.mounts.at(-1);
      assert.equal(mount.character, chars[index]); assert.equal(e.snapshot().active.occurrenceId, 'w0:' + index);
      mount.onCharacterDemoComplete(); await flushDemo();
      mount.onCharacterDemoComplete(); mount.onReady(); await flushDemo();
    }
    assert.deepEqual(e.played.map(mount => mount.character), expected.map(index => chars[index]));
    assert.equal(e.snapshot().active.occurrenceId, 'w0:' + expected.at(-1));
    assert.deepEqual(e.snapshot().attempts, []); assert.deepEqual(e.snapshot().finished, []);
    e.$('main-next').click();
    assert.equal(e.mounts.at(-1).character, chars[expected.at(-1)]);
    assert.equal(e.snapshot().attempts[0].occurrenceId, 'w0:' + expected.at(-1));
  }
});

test('autoplay waits for readiness once, rejects old completions and manual browsing stays idle', async () => {
  const e = await demoApp('推來推去', undefined, false), first = e.mounts[0];
  first.onReady(); e.$('play').click(); first.onCharacterDemoComplete(); await flushDemo();
  assert.equal(e.mounts.at(-1).character, '來'); assert.equal(e.played.length, 1);
  first.onCharacterDemoComplete(); first.onReady(); await flushDemo(); assert.equal(e.played.length, 1);
  const second = e.mounts.at(-1); second.onReady(); second.onReady(); await flushDemo();
  assert.equal(e.played.length, 2);
  e.$('demo-next').click(); await flushDemo(); e.mounts.at(-1).onReady(); await flushDemo();
  assert.equal(e.mounts.at(-1).character, '推'); assert.equal(e.played.length, 2);
  second.onCharacterDemoComplete(); await flushDemo(); assert.equal(e.snapshot().active.occurrenceId, 'w0:2');
});

test('lifecycle changes clear pending autoplay and returning to a demo remains idle', async () => {
  for (const change of ['rest', 'teacher', 'hidden', 'pagehide', 'guided', 'home']) {
    const e = await demoApp('鬍鬚', undefined, false), first = e.mounts[0];
    first.onReady(); e.$('play').click(); first.onCharacterDemoComplete(); await flushDemo();
    const pending = e.mounts.at(-1); pending.onReady();
    if (change === 'rest') { e.$('rest').click(); e.$('resume').click(); }
    if (change === 'teacher') { e.$('teacher-open').click(); e.$('teacher-close').click(); }
    if (change === 'hidden') { e.document.hidden = true; e.document.emit('visibilitychange'); e.document.hidden = false; e.document.emit('visibilitychange'); }
    if (change === 'pagehide') { e.emitWindow('pagehide'); e.emitWindow('pageshow'); }
    if (change === 'guided') e.$('main-next').click();
    if (change === 'home') e.document.querySelector('.brand').click();
    pending.onReady(); pending.onCharacterDemoComplete(); e.mounts.at(-1).onReady(); await flushDemo();
    assert.equal(e.played.length, 1, change);
  }
});

test('data and mount failures cancel autoplay and retry needs a manual play', async () => {
  for (const failure of ['load', 'mount']) {
    const e = await demoApp('鬍鬚', undefined, false), first = e.mounts[0];
    if (failure === 'load') e.context.BishunWriting.loadCharacter = () => Promise.reject(new Error('offline'));
    first.onCharacterDemoComplete(); await flushDemo();
    if (failure === 'mount') e.mounts.at(-1).onError();
    assert.equal(e.snapshot().active.phase, 'unavailable');
    e.context.BishunWriting.loadCharacter = () => Promise.resolve({ strokes: ['M1 1L2 2'] });
    e.$('retry-data').click(); await flushDemo(); e.mounts.at(-1).onReady(); await flushDemo();
    assert.equal(e.snapshot().active.phase, 'watch'); assert.equal(e.played.length, 0);
  }
});

test('writer full completion distinguishes cancel, replay, pause, one-stroke, suspension and disposal', async () => {
  const e = environment(); vm.runInContext(source('vendor/hanzi-writer.min.js'), e.context); vm.runInContext(source('writing.js'), e.context);
  const runs = [], strokes = [], states = [], complete = [], prototype = e.context.HanziWriter.prototype;
  let resumes = 0, pauses = 0;
  prototype.animateCharacter = function() { return new Promise(resolve => runs.push(resolve)); };
  prototype.animateStroke = function(index) { return new Promise(resolve => strokes.push({ index, resolve })); };
  prototype.pauseAnimation = () => { pauses++; }; prototype.resumeAnimation = () => { resumes++; };
  const data = { strokes: ['M100 500L900 500Z'], medians: [[[100, 500], [900, 500]]] };
  let ready = 0;
  const mount = phase => e.context.BishunWriting.mount(e.$('writer'), '一', data, { phase, token: 'watch', onReady: () => ready++, onEvent() {}, onDemoState: state => states.push(state), onCharacterDemoComplete: () => complete.push('done') });
  let handle = mount('watch'); await waitFor(() => ready === 1);
  handle.play(); await flushDemo(); handle.pause(); await flushDemo(); assert.equal(states.at(-1), 'paused');
  handle.play(); await flushDemo(); assert.equal(runs.length, 1); assert(resumes > 0); assert(pauses > 0);
  runs[0]({ canceled: false }); await flushDemo(); assert.equal(complete.length, 1);
  handle.play(); await flushDemo(); runs[1]({ canceled: true }); await flushDemo(); assert.equal(complete.length, 1);
  handle.play(); await flushDemo(); handle.play(true); await flushDemo();
  runs[2]({ canceled: false }); await flushDemo(); assert.equal(complete.length, 1);
  runs[3]({ canceled: false }); await flushDemo(); assert.equal(complete.length, 2);
  handle.play(); await flushDemo(); handle.nextStroke(); await flushDemo();
  runs[4]({ canceled: false }); strokes[0].resolve({ canceled: false }); await flushDemo(); assert.equal(complete.length, 2); assert.equal(states.at(-1), 'stopped');
  handle.play(); await flushDemo(); handle.suspend(); runs[5]({ canceled: false }); await flushDemo(); assert.equal(complete.length, 2);
  handle.dispose(); handle = mount('watch'); await waitFor(() => ready === 2);
  handle.play(); await flushDemo(); handle.dispose(); runs[6]({ canceled: false }); await flushDemo(); assert.equal(complete.length, 2);
  handle = mount('quiz'); await waitFor(() => ready === 3); handle.play(); handle.nextStroke(); await flushDemo(); assert.equal(runs.length, 7); assert.equal(strokes.length, 1); handle.dispose();
});

test('autoplay intent is discarded during loading and manual navigation before the ready microtask', async () => {
  const e = await demoApp('鬍鬚'), loads = [];
  e.context.BishunWriting.loadCharacter = () => new Promise(resolve => loads.push(resolve));
  e.$('play').click(); e.mounts[0].onCharacterDemoComplete(); await flushDemo();
  assert.equal(e.snapshot().active.phase, 'loading');
  e.document.hidden = true; e.document.emit('visibilitychange'); e.document.hidden = false; e.document.emit('visibilitychange'); await flushDemo();
  const data = { strokes: ['M1 1L2 2'] }; loads[0](data); await flushDemo(); assert.equal(e.snapshot().active.phase, 'loading');
  loads[1](data); await flushDemo(); assert.equal(e.snapshot().active.phase, 'watch'); assert.equal(e.played.length, 1);
  const manual = await demoApp('推來推去', undefined, false);
  manual.mounts[0].onCharacterDemoComplete(); await flushDemo(); manual.mounts.at(-1).onReady();
  manual.$('demo-next').click(); await flushDemo(); manual.mounts.at(-1).onReady(); await flushDemo();
  assert.equal(manual.snapshot().active.occurrenceId, 'w0:2'); assert.equal(manual.played.length, 0);
});

test('a quiz mount cannot advance demos or add hints from a full-demo callback', async () => {
  const e = await quizApp(); await e.enter(); const before = JSON.stringify(e.snapshot());
  e.mounts.at(-1).onCharacterDemoComplete(); await flushDemo();
  assert.equal(JSON.stringify(e.snapshot()), before); assert.deepEqual(e.snapshot().attempts[0].help, []);
});

test('practice starts with one cue, acknowledges real ink and keeps missed-stroke help actionable', async () => {
  const e = await feedbackApp('二', 2);
  e.voices.current = [{ lang: 'yue-HK', name: 'Cantonese' }];
  assert.equal(e.$('practice-instruction').textContent, '先寫一畫。');
  assert.equal(e.$('feedback').hidden, true); assert.equal(e.$('practice-stars').hidden, true);
  const beforeTouch = JSON.stringify(e.snapshot()); e.$('writer').emit('pointerdown');
  assert.equal(JSON.stringify(e.snapshot()), beforeTouch);
  assert.equal(e.$('practice-instruction').hidden, false);
  e.send('STROKE_MISSED', { strokeIndex: 0 });
  assert.equal(e.$('feedback-text').textContent, '再試呢一畫。');
  assert.equal(e.$('hint-stroke').textContent, '睇一畫再試');
  e.send('STROKE_ACCEPTED', { strokeIndex: 0 });
  assert.equal(e.$('feedback-text').textContent, '你再試成功咗！');
  e.send('STROKE_MISSED', { strokeIndex: 1 }); e.send('STROKE_MISSED', { strokeIndex: 1 });
  assert.equal(e.snapshot().active.currentStroke, 1); assert.equal(e.snapshot().attempts[0].mistakes, 3);
  assert.equal(e.snapshot().attempts[0].help.length, 1);
  assert.equal(e.$('feedback-text').textContent, '睇完呢一畫，再試。');
  assert.equal(e.$('practice-instruction').hidden, true); assert.equal(e.$('feedback').hidden, false);
  assert.equal(e.$('hear-instruction').getAttribute('aria-describedby'), 'feedback-text');
  const beforeVoice = JSON.stringify(e.snapshot()); e.$('hear-instruction').click();
  assert.equal(e.voices.spoken.at(-1).text, e.$('feedback-text').textContent);
  assert.equal(JSON.stringify(e.snapshot()), beforeVoice);
  e.complete(); assert.equal(e.$('practice-stars').textContent, '★ 1');
});

test('one-stroke practice acknowledges the start before retaining its completion category and one star', async () => {
  const e = await feedbackApp('一', 1);
  e.send('STROKE_ACCEPTED', { strokeIndex: 0 });
  assert.equal(e.$('feedback-text').textContent, '你開始咗，第一畫完成！');
  assert.equal(e.$('practice-stars').hidden, true);
  e.send('WRITING_COMPLETE');
  assert.equal(e.$('feedback').getAttribute('data-kind'), 'complete-guided');
  assert.equal(e.$('practice-stars').hidden, false); assert.equal(e.$('practice-stars').textContent, '★ 1');
  const complete = JSON.stringify(e.snapshot()), writes = e.$('practice-stars').textWrites;
  e.voices.changed(); e.send('WRITING_COMPLETE');
  assert.equal(JSON.stringify(e.snapshot()), complete); assert.equal(e.$('practice-stars').textWrites, writes);
  e.$('main-next').click(); e.$('hint-stroke').click(); e.complete();
  assert.equal(e.$('feedback').getAttribute('data-kind'), 'complete-assisted');
  assert.equal(e.$('practice-stars').textContent, '★ 1');
  e.$('retry-writing').click(); e.send('STROKE_MISSED', { strokeIndex: 0 });
  assert.equal(e.$('practice-stars').textContent, '★ 1'); e.complete();
  assert.equal(e.$('feedback').getAttribute('data-kind'), 'complete-independent');
  assert.equal(e.$('practice-stars').textContent, '★ 1');
  assert.equal(e.snapshot().attempts.length, 3); assert.equal(e.snapshot().finished.length, 1);
  assert.deepEqual(e.snapshot().attempts.map(a => [a.phase, a.outcome, a.mistakes, a.help.length]), [['guided', 'complete', 0, 0], ['recall', 'complete', 0, 1], ['recall', 'complete', 1, 0]]);
  e.$('main-next').click(); assert.equal(e.$('practice-stars').hidden, true);
  e.$('new-session').click(); assert.equal(e.$('practice-stars').hidden, true);
  e.snapshot = () => JSON.parse(e.store.get('bishun-school:v1:' + e.store.get('bishun-school:v1:current')));
  startLocal(e); e.$('word-cards').childNodes[0].click(); await waitFor(() => e.mounts.at(-1).phase === 'watch');
  assert.equal(e.$('practice-stars').hidden, true); e.$('main-next').click(); assert.equal(e.$('practice-stars').hidden, true);
});

test('stars distinguish sparse repeated positions and exclude skipped, abandoned and partial attempts', async () => {
  const e = await feedbackApp('推來推去', 2, false);
  e.$('teacher-open').click(); chooseCharacters(e, ['w0:0', 'w0:2', 'w0:3']); e.$('apply-words').click(); startLocal(e);
  e.snapshot = () => JSON.parse(e.store.get('bishun-school:v1:' + e.store.get('bishun-school:v1:current')));
  assert.equal(e.$('practice-stars').hidden, true);
  e.$('word-cards').childNodes[0].click(); await waitFor(() => e.snapshot().active.phase === 'watch');
  assert.equal(e.$('practice-stars').hidden, true); e.$('main-next').click();
  e.send('STROKE_ACCEPTED', { strokeIndex: 0 }); e.$('retry-writing').click();
  assert.equal(e.$('practice-stars').hidden, true); assert.equal(e.snapshot().attempts[0].outcome, 'abandoned');
  e.complete(); assert.equal(e.$('practice-stars').textContent, '★ 1');
  e.$('main-next').click(); e.complete(); assert.equal(e.$('practice-stars').textContent, '★ 1');
  e.$('main-next').click(); await waitFor(() => e.snapshot().active.phase === 'watch');
  assert.equal(e.snapshot().active.occurrenceId, 'w0:2'); e.$('main-next').click(); e.complete();
  assert.equal(e.$('practice-stars').textContent, '★ 2');
  e.$('main-next').click(); e.complete(); e.$('main-next').click(); await waitFor(() => e.snapshot().active.phase === 'watch');
  e.$('main-next').click(); e.send('STROKE_ACCEPTED', { strokeIndex: 0 });
  e.$('teacher-open').click(); e.$('teacher-skip').click();
  assert.equal(e.$('practice-stars').textContent, '★ 2'); assert.equal(e.snapshot().finished.length, 3);
  assert.equal(e.snapshot().attempts.at(-1).outcome, 'skipped');
  e.$('main-next').click(); assert.equal(e.$('practice-stars').hidden, true);
  const skipped = await feedbackApp(); skipped.$('teacher-open').click(); skipped.$('teacher-skip').click();
  assert.equal(skipped.$('practice-stars').hidden, true);
  const quiz = await quizApp(); await quiz.enter(); quiz.send('STROKE_ACCEPTED', { strokeIndex: 0 }); quiz.send('STROKE_ACCEPTED', { strokeIndex: 1 }); quiz.send('WRITING_COMPLETE');
  assert.equal(quiz.$('practice-stars').hidden, true);
});

test('arbitrary recall targets stay out of new star labels, visible cues and their spoken text', async () => {
  for (const character of new Set(Array.from('完成星練習達你開始咗第一畫再試成功睇完呢'))) {
    const e = await feedbackApp(character, 3); e.complete(); e.$('main-next').click();
    e.voices.current = [{ lang: 'yue-HK', name: 'Cantonese' }];
    for (const action of [() => {}, () => e.send('STROKE_ACCEPTED', { strokeIndex: 0 }), () => e.send('STROKE_MISSED', { strokeIndex: 1 }), () => e.send('STROKE_ACCEPTED', { strokeIndex: 1 })]) {
      action(); e.$('hear-instruction').click();
      const cue = e.$(e.$('hear-instruction').getAttribute('aria-describedby'));
      assert.notEqual(cue.hidden, true);
      assert.equal(e.voices.spoken.at(-1).text, cue.textContent);
      assert(!e.voices.spoken.at(-1).text.includes(character)); assert(!visibleText(e.document).includes(character));
      assert(!e.$('practice-stars').getAttribute('aria-label').includes(character));
      assert(!e.$('hint-stroke').textContent.includes(character));
      assert.notEqual(e.$('feedback').hidden, e.$('practice-instruction').hidden);
    }
  }
});

test('a changed stroke cue preserves current word narration but cancels an outdated instruction', async () => {
  const e = await feedbackApp('二', 3); e.voices.current = [{ lang: 'yue-HK', name: 'Cantonese' }];
  e.$('speak').click(); const wordCancels = e.voices.cancels;
  e.send('STROKE_ACCEPTED', { strokeIndex: 0 }); assert.equal(e.voices.cancels, wordCancels);
  e.$('hear-instruction').click(); const instructionCancels = e.voices.cancels;
  e.send('STROKE_ACCEPTED', { strokeIndex: 1 }); assert(e.voices.cancels > instructionCancels);
  e.$('hear-instruction').click(); assert.equal(e.voices.spoken.at(-1).text, e.$('feedback-text').textContent);
});


test('practice follows every curriculum card and Back edge without touching storage before choosing a group', async () => {
  const e = await quizApp(); let writes = 0;
  for (const name of ['setItem', 'removeItem']) {
    const original = e.context.localStorage[name];
    e.context.localStorage[name] = (...args) => { writes++; return original(...args); };
  }
  const labels = ['二年級', '2上1', '第一課《爸爸的鬍鬚》'];
  e.$('start-practice').click();
  for (const label of labels) {
    assert.equal(e.$('group-cards').childNodes.length, 1);
    assert.equal(e.$('group-cards').childNodes[0].textContent, label);
    assert.equal(e.$('home-view').hidden, true); assert.equal(e.$('group-view').hidden, false);
    e.$('group-cards').childNodes[0].click();
  }
  assert.equal(e.$('group-title').textContent, '第一課《爸爸的鬍鬚》');
  assert.equal(e.$('group-cards').childNodes.length, 2);
  assert.equal(e.$('group-home').textContent, '返回課文');
  for (const label of [...labels].reverse()) {
    e.$('group-home').click();
    assert.equal(e.$('group-cards').childNodes[0].textContent, label);
  }
  e.$('group-home').click(); assert.equal(e.$('home-view').hidden, false);
  assert.equal(writes, 0); assert.equal(e.store.size, 0);
  startLocal(e); assert(writes > 0); assert.equal(e.snapshot().mode, 'practice');
  e.$('choice-summary').click(); assert.equal(e.$('group-cards').childNodes.length, 2);
  assert.equal(e.$('group-home').textContent, '返回課文');
  e.$('group-home').click(); assert.equal(e.$('group-cards').childNodes[0].textContent, labels[2]);
});

test('brand and teacher apply reset curriculum browsing while keeping applied custom character positions', async () => {
  const e = await quizApp();
  e.$('start-practice').click(); e.$('group-cards').childNodes[0].click();
  e.document.querySelector('.brand').click();
  assert.equal(e.$('home-view').hidden, false); assert.equal(e.document.querySelector('.brand').getAttribute('aria-label'), '寫字樂首頁');
  e.$('start-practice').click(); assert.equal(e.$('group-cards').childNodes[0].textContent, '二年級');
  e.$('group-cards').childNodes[0].click(); e.$('teacher-open').click();
  e.$('teacher-words').value = '朋友朋'; e.$('validate-words').click(); chooseCharacters(e, ['w0:2']); e.$('apply-words').click();
  assert.equal(e.$('home-view').hidden, false); assert.equal(e.store.size, 0);
  e.$('start-practice').click(); assert.equal(e.$('group-cards').childNodes[0].textContent, '二年級');
  e.document.querySelector('.brand').click(); startLocal(e);
  assert.deepEqual(e.snapshot().entries.map(word => word.text), ['朋友朋']);
  assert.deepEqual(e.snapshot().occurrences.map(item => item.index), [2]);
});

test('quiz completion keeps only a short live announcement and reads the real visible next action through rerenders', async () => {
  const e = await quizApp(); await e.enter();
  e.voices.current = [{ lang: 'yue-HK', name: 'Cantonese' }];
  e.send('STROKE_ACCEPTED', { strokeIndex: 0 }); e.send('STROKE_ACCEPTED', { strokeIndex: 1 }); e.send('WRITING_COMPLETE');
  const check = action => {
    assert.equal(e.$('practice-title').textContent, '測驗完成');
    assert.equal(e.$('practice-instruction').hidden, true); assert.equal(e.$('practice-instruction').textContent, '');
    assert.equal(e.$('feedback-text').textContent, '測驗完成'); assert.equal(e.$('feedback').getAttribute('role'), 'status');
    assert.equal(e.$('feedback').getAttribute('data-kind'), 'quiz-complete'); assert(e.$('feedback').className.includes('sr-only')); assert.equal(e.$('feedback').hidden, false);
    assert.equal(e.$('feedback-icon').hidden, true); assert.equal('hidden' in e.$('quiz-mark').attributes, false);
    assert.equal(e.$('hear-instruction').getAttribute('aria-describedby'), 'main-next'); assert.equal(e.$('main-next').textContent, action + ' →');
    assert(!visibleText(e.document).includes('準備好，先行下一步。')); assert(!visibleText(e.document).includes('完成咗！準備好先行下一步。')); assert(!visibleText(e.document).includes('每一次嘅嘗試都保留喺紀錄。'));
    e.$('hear-instruction').click(); assert.equal(e.voices.spoken.at(-1).text, action);
  };
  check('下一個字');
  e.$('rest').click(); e.$('resume').click(); check('下一個字');
  e.$('teacher-open').click(); e.$('teacher-close').click(); check('下一個字');
  e.document.hidden = true; e.document.emit('visibilitychange'); e.document.hidden = false; e.document.emit('visibilitychange'); check('下一個字');
  e.$('simplify').click(); check('下一個字');
  for (let index = 1; index < 4; index++) {
    e.$('main-next').click(); await waitFor(() => e.snapshot().active.phase === 'quiz');
    e.send('STROKE_ACCEPTED', { strokeIndex: 0 }); e.send('STROKE_ACCEPTED', { strokeIndex: 1 }); e.send('WRITING_COMPLETE');
  }
  check('睇今次紀錄'); e.$('main-next').click(); assert.equal(e.snapshot().active.phase, 'summary');
  assert(!e.voices.spoken.some(item => /準備好.*先行下一步/.test(item.text)));
});

test('classroom last completion offers the actual submit action and never enters the practice hierarchy', async () => {
  const e = await classroomApp({ assignment: [{ text: '二', selectedIndexes: [0] }] });
  assert.equal(e.$('group-view').hidden, true); assert.equal(e.$('home-view').hidden, true);
  const mount = e.mounts.at(-1);
  mount.onEvent({ type: 'STROKE_ACCEPTED', strokeIndex: 0, token: mount.token }); mount.onEvent({ type: 'WRITING_COMPLETE', token: mount.token });
  assert.equal(e.$('main-next').textContent, '完成測驗 →'); assert.equal(e.$('hear-instruction').getAttribute('aria-describedby'), 'main-next');
  e.voices.current = [{ lang: 'yue-HK', name: 'Cantonese' }]; e.$('hear-instruction').click(); assert.equal(e.voices.spoken.at(-1).text, '完成測驗');
  assert.equal(e.calls.filter(call => call.method === 'PUT').length, 0);
  e.$('main-next').click(); await waitFor(() => e.navigation.length === 1); assert.equal(e.calls.filter(call => call.method === 'PUT').length, 1);
});

test('Pages and standalone source branding use 寫字樂 while persistent keys and classroom origin remain compatible', () => {
  for (const page of ['index.html', 'standalone.html']) assert(source(page).includes('<title>寫字樂 · 一筆一筆，慢慢學</title>'));
  assert(source('index.html').includes('aria-label="寫字樂首頁"'));
  assert(source('leaderboard.html').includes('<title>寫字樂 · 班級排行榜</title>'));
  assert(source('leaderboard.html').includes('href="index.html">寫字樂</a>'));
  assert(source('app.js').includes("const prefix = 'bishun-school:v1:'"));
  assert(source('app.js').includes('https://zimanman-classroom-1023.lokyau65.chatgpt.site'));
});
