'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const source = name => fs.readFileSync(require('node:path').join(__dirname, '../dist', name), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
class Element {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.attributes = {}; this.listeners = {}; this.hidden = false; this.disabled = false; this._text = ''; }
  append(...items) { for (const item of items) { if (item.parent) item.parent.children = item.parent.children.filter(child => child !== item); item.parent = this; this.children.push(item); } }
  replaceChildren(...items) { this.children = []; this._text = ''; this.append(...items); }
  get firstChild() { return this.children[0]; }
  set textContent(text) { this._text = String(text); this.children = []; }
  get textContent() { return this._text + this.children.map(item => item.textContent).join(''); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); }
  async emit(name, extra = {}) { for (const fn of this.listeners[name] || []) await fn({ preventDefault() {}, ...extra }); }
  async click() { if (!this.disabled) await this.emit('click'); }
  all() { return [this, ...this.children.flatMap(item => item.all())]; }
  querySelector(selector) { return this.all().find(item => selector.startsWith('.') ? item.className?.split(' ').includes(selector.slice(1)) : selector.startsWith('[') ? Object.hasOwn(item.attributes, selector.slice(1, -1)) : item.tagName === selector.toUpperCase()); }
  getBoundingClientRect() { return { left: 0, top: 0, width: 500, height: 500 }; }
  setPointerCapture() {}
  before(item) { const index = this.parent.children.indexOf(this); item.parent = this.parent; this.parent.children.splice(index, 0, item); }
}
function memory() {
  const records = new Map(); let blocked = false;
  const save = value => { if (blocked) throw new Error('儲存空間不足'); records.set(value.key, clone(value)); };
  return { records, set blocked(value) { blocked = value; },
    async get(key) { return clone(records.get(key) || null); }, async put(value) { save(value); }, async putMany(values) { values.forEach(save); },
    async initialize(scope, value) { const existing = records.get(scope); if (existing) return clone(records.get(existing.runKey)); save(value); save({ key: scope, runKey: value.key, expiresAt: value.expiresAt }); return clone(value); },
    async release(scope, runKey) { if (records.get(scope)?.runKey === runKey) records.delete(scope); },
    async localOriginals() { return [...records.values()].filter(record => record.key.startsWith('local:') && record.kind === 'official' && record.run?.phase === 'sealed').map(clone); },
    async activeLocal() { const pointer = [...records.values()].find(record => record.key.startsWith('local:') && record.runKey); return pointer ? clone(records.get(pointer.runKey)) : null; },
    async purge() { for (const [key, value] of records) if (value.expiresAt <= Date.now()) records.delete(key); } };
}
function boot({ store = memory(), classroom = null } = {}) {
  const body = new Element('body'), previous = new Element('main'); previous.textContent = '鬍鬚'; body.append(previous);
  const listeners = {}, document = { body, hidden: false, createElement: tag => new Element(tag), createElementNS: (_ns, tag) => new Element(tag), addEventListener(name, fn) { listeners[name] = fn; } };
  const timers = [], calls = { closed: 0, practice: [] }, spoken = [];
  const context = vm.createContext({ document, structuredClone, TextEncoder, crypto: webcrypto, performance, console, setTimeout(fn) { timers.push(fn); return timers.length; }, clearTimeout() {}, requestAnimationFrame: () => 1, cancelAnimationFrame() {}, addEventListener() {},
    speechSynthesis: { getVoices: () => [{ lang: 'zh-HK' }], cancel() {}, speak(value) { spoken.push(value.text); } }, SpeechSynthesisUtterance: class { constructor(text) { this.text = text; } } });
  for (const file of ['quiz-results.js', 'assessment.js', 'content.js', 'freehand.js', 'assessment-review.js', 'assessment-ui.js']) vm.runInContext(source(file), context);
  const ui = context.BishunAssessmentUI.create({ store, classroom, onClose() { calls.closed++; }, onPractice(assigned) { calls.practice.push(assigned); } });
  const assigned = context.BishunAssessment.assignment([{ text: '鬍鬚', selectedIndexes: [0, 1] }], 'listen');
  const panel = body.children.at(-1);
  const button = text => panel.all().find(item => item.tagName === 'BUTTON' && item.textContent === text);
  const click = async text => { const item = button(text); assert(item, 'button exists: ' + text); await item.click(); await new Promise(resolve => setImmediate(resolve)); };
  const stroke = async () => { const svg = panel.all().find(item => item.tagName === 'SVG' && item.listeners.pointerdown); assert(svg, 'freehand pad exists'); await svg.emit('pointerdown', { button: 0, pointerId: 1, clientX: 20, clientY: 30 }); await svg.emit('pointermove', { pointerId: 1, clientX: 420, clientY: 470 }); await svg.emit('pointerup', { pointerId: 1, clientX: 430, clientY: 480 }); await new Promise(resolve => setImmediate(resolve)); };
  const record = () => [...store.records.values()].find(value => value.run && value.kind === 'official');
  return { ui, context, store, panel, previous, calls, assigned, click, button, stroke, record, spoken, timers };
}
async function fill(e) {
  await e.click('第 1 題 · 詞語第 1 字 · 未提交'); await e.stroke(); await e.click('提交呢個字');
  await e.stroke(); await e.click('跳過，保留筆跡'); await e.click('交整份測驗');
}
test('listen quiz has a free pad with private checkpoints and no visible or accessible answer model', async () => {
  const e = boot(); await e.ui.open(e.assigned);
  assert.equal(e.previous.inert, true); assert.equal(e.previous.attributes['aria-hidden'], 'true');
  assert(!/鬍|鬚/.test(e.panel.textContent));
  await e.click('第 1 題 · 詞語第 1 字 · 未提交'); await e.click('聽詞語及情境');
  assert.match(e.spoken[0], /鬍鬚/); assert.match(e.spoken[0], /第 1 個字/);
  await e.stroke();
  assert.equal(e.record().run.answers[0].strokes[0].length, 3);
  assert.deepEqual(e.record().run.answers[0].strokes[0].map(point => point.slice(0, 2)), [[400, 600], [8400, 9400], [8600, 9600]]);
  const reloaded = boot({ store: e.store }); await reloaded.ui.open(reloaded.assigned);
  await reloaded.click('第 1 題 · 詞語第 1 字 · 未提交');
  assert(reloaded.panel.all().some(item => item.attributes.d?.includes('8400 9400')));
  assert(!/鬍|鬚/.test(reloaded.panel.textContent + JSON.stringify(reloaded.panel.all().map(item => item.attributes))));
});
test('explicit local resume restores the saved assignment and mode without showing any ink on cold load', async () => {
  const e = boot(); await e.ui.open(e.assigned); await e.click('第 1 題 · 詞語第 1 字 · 未提交'); await e.stroke();
  const reload = boot({ store: e.store }); assert.equal(reload.panel.hidden, true); assert.equal(await reload.ui.hasLocal(), true);
  assert.equal(await reload.ui.resumeLocal(), true); await reload.click('第 1 題 · 詞語第 1 字 · 未提交');
  assert(reload.panel.all().some(item => item.attributes.d?.includes('8400 9400'))); assert(!/鬍|鬚/.test(reload.panel.textContent));
});
test('save failure retains visible ink and prevents destructive navigation until retry saves it', async () => {
  const e = boot(); await e.ui.open(e.assigned); await e.click('第 1 題 · 詞語第 1 字 · 未提交');
  e.store.blocked = true; await e.stroke(); await e.click('提交呢個字');
  assert.match(e.panel.textContent, /儲存空間不足/); assert(e.button('提交呢個字'));
  assert(e.panel.all().some(item => item.attributes.d?.includes('8400 9400')));
  assert.equal(e.record().run.answers[0].strokes.length, 0);
  e.store.blocked = false; await e.click('提交呢個字');
  assert.equal(e.record().run.answers[0].status, 'submitted'); assert.equal(e.record().run.answers[0].strokes[0].length, 3);
});
test('pointer cancellation saves the original partial stroke without appending artificial coordinates', async () => {
  const e = boot(); await e.ui.open(e.assigned); await e.click('第 1 題 · 詞語第 1 字 · 未提交');
  const svg = e.panel.all().find(item => item.tagName === 'SVG' && item.listeners.pointerdown);
  await svg.emit('pointerdown', { button: 0, pointerId: 1, clientX: 100, clientY: 150 });
  await svg.emit('pointermove', { pointerId: 1, clientX: 200, clientY: 250 });
  await svg.emit('pointercancel', { pointerId: 1 }); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(e.record().run.answers[0].strokes[0].map(point => point.slice(0, 2)), [[2000, 3000], [4000, 5000]]);
  await e.click('跳過，保留筆跡'); assert.equal(e.record().run.answers[0].status, 'skipped');
});
test('local first original, skipped ink, teacher grading, revision and challenge stay separate', async () => {
  const e = boot(); await e.ui.open(e.assigned); await fill(e);
  const original = clone(e.record().run);
  assert.equal(e.record().run.answers[1].strokes.length, 1); assert.equal(e.record().review.score, null);
  assert(!e.panel.textContent.includes('O 正確'));
  await e.click('老師批改');
  const selects = e.panel.all().filter(item => item.tagName === 'SELECT');
  for (const select of selects) { select.value = 'correct'; await select.emit('change'); }
  await e.click('保存批改'); assert.equal(e.record().review.score, 2); assert.equal(e.record().review.revision, 1);
  selects[1].value = 'practice'; await selects[1].emit('change'); await e.click('保存批改');
  assert.equal(e.record().review.score, 1); assert.equal(e.record().review.revision, 2);
  await e.click('← 返回原卷'); assert(e.panel.textContent.includes('O 正確'));
  await e.click('情境小挑戰'); await e.click('第 1 題 · 詞語第 1 字 · 未提交'); await e.stroke(); await e.click('提交呢個字'); await e.stroke(); await e.click('提交呢個字'); await e.click('完成作品卡');
  assert.match(e.panel.textContent, /我的情境作品卡|給同學看的圖片介紹/);
  assert(e.panel.all().some(item => item.tagName === 'IMG' && item.src === 'images/beard.webp'));
  assert.deepEqual(e.record().run, original);
  await e.click('← 返回原卷'); await e.click('跟住練習'); assert.equal(e.calls.practice.length, 1);
  const reload = boot({ store: e.store }); await reload.ui.open(reload.assigned);
  assert.match(reload.panel.textContent, /原卷紀錄/); assert.equal(reload.record().review.score, 1);
});
test('failed class upload survives reload verbatim and other member keys cannot expose it', async () => {
  const sent = []; let offline = true;
  const classroom = { async ownAnswer() { return { answer: null }; }, async submitReviewed(run) { sent.push(clone(run)); if (offline) throw new Error('未能連線'); return { runId: run.runId, official: true }; } };
  const e = boot({ classroom }), member = { code: 'ABCDEFGH', memberId: 'member-a', expiresAt: Date.now() + 86400000 };
  await e.ui.open(e.assigned, member); await fill(e);
  assert.equal(e.record().receipt, undefined); assert.match(e.panel.textContent, /尚未交妥/);
  const other = boot({ store: e.store, classroom }); assert.equal(other.panel.hidden, true, 'cold UI must wait for identity confirmation');
  await other.ui.open(other.assigned, { ...member, memberId: 'member-b' });
  assert.equal(other.panel.all().filter(item => item.tagName === 'PATH' && item.attributes.d?.includes('8400 9400')).length, 0);
  const reload = boot({ store: e.store, classroom }); await reload.ui.open(reload.assigned, member); offline = false;
  await reload.click('重試交卷'); assert.deepEqual(sent[1], sent[0]); assert.equal(reload.record().receipt.official, true);
  assert(!reload.panel.textContent.includes('秒'));
});
test('new runtime modules and review styles reach the actual and portable page', () => {
  const html = source('index.html');
  for (const name of ['assessment.js', 'assessment-store.js', 'freehand.js', 'assessment-review.js', 'assessment-ui.js']) assert(html.includes('src="' + name + '?v='));
  assert(html.includes('href="assessment.css?v='));
  assert(source('app.js').includes('assessment.open(member.assignment, member)'));
});
test('intentional next pupil keeps the prior sealed local original available for teacher review', async () => {
  const e = boot(); await e.ui.open(e.assigned); await fill(e); const first = clone(e.record());
  await e.click('下一位同學／開始新小測'); assert.equal(e.ui.active(), false);
  const next = boot({ store: e.store }); await next.ui.open(next.assigned);
  assert.match(next.panel.textContent, /未提交/);
  assert.equal([...e.store.records.values()].filter(item => item.run).length, 2);
  assert.deepEqual(e.store.records.get(first.key), first);
  await fill(next); await next.click('本機原卷');
  assert.equal(next.panel.all().filter(item => item.tagName === 'BUTTON' && /聽詞寫 · 2 字/.test(item.textContent)).length, 2);
});
