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
    this.classList = { toggle: (name, value) => { const names = new Set(this.className.split(' ').filter(Boolean)); if (value) names.add(name); else names.delete(name); this.className = [...names].join(' '); } };
  }
  get parentElement() { return this.parentNode; }
  get className() { return this.attributes.class || ''; }
  set className(value) { this.attributes.class = value; }
  get textContent() { return this.nodeType === 3 ? this.nodeValue : this.childNodes.map(node => node.textContent).join(''); }
  set textContent(value) { if (this.nodeType === 3) this.nodeValue = value; else this.replaceChildren(new Node('#text', String(value))); }
  set innerHTML(value) { assert.equal(value, ''); this.replaceChildren(); }
  append(...nodes) { nodes.forEach(node => this.appendChild(typeof node === 'string' ? new Node('#text', node) : node)); }
  appendChild(node) { node.remove(); node.parentNode = this; this.childNodes.push(node); return node; }
  removeChild(node) { this.childNodes.splice(this.childNodes.indexOf(node), 1); node.parentNode = null; return node; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
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
  const observers = new Set();
  const context = vm.createContext({ document, console, setTimeout, clearTimeout, performance, AbortController, NodeFilter: { SHOW_TEXT: 4 },
    localStorage: storage, sessionStorage: storage, crypto: { randomUUID: () => 'runtime-test' },
    ResizeObserver: class { observe() { observers.add(this); } disconnect() { observers.delete(this); } },
    speechSynthesis: { getVoices: () => voices.current, cancel() {}, speak() {}, addEventListener(_name, fn) { voices.changed = fn; } },
    SpeechSynthesisUtterance: class { constructor(text) { this.text = text; } }, addEventListener() {}
  });
  context.window = context; context.location = { href: 'http://localhost/' };
  return { context, document, voices, store, observers, $: document.getElementById };
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
