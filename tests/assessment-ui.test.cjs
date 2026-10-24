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
    async get(key) { return clone(records.get(key) || null); }, async put(value, guard = () => {}) { guard(); if ((records.get(value.key)?.revision || 0) !== (value.revision || 0)) throw new Error('另一分頁已更新原稿'); const saved = { ...value, revision: (value.revision || 0) + 1 }; save(saved); return clone(saved); }, async putMany(values, guard = () => {}) { guard(); values.forEach(save); },
    async initialize(scope, value, guard = () => {}) { guard(); const existing = records.get(scope); if (existing) return clone(records.get(existing.runKey)); const saved = { ...value, revision: 1 }; save(saved); save({ key: scope, runKey: value.key, expiresAt: value.expiresAt }); return clone(saved); },
    async release(scope, runKey) { if (records.get(scope)?.runKey === runKey) records.delete(scope); },
    async localOriginals() { return [...records.values()].filter(record => record.key.startsWith('local:') && record.kind === 'official' && record.run?.phase === 'sealed').map(clone); },
    async activeLocal() { const pointer = [...records.values()].find(record => record.key.startsWith('local:') && record.runKey); return pointer ? clone(records.get(pointer.runKey)) : null; },
    async purge(now = Date.now()) { for (const [key, value] of records) if (value.expiresAt <= now) records.delete(key); } };
}
function boot({ store = memory(), classroom = null, now = Date.now(), elapsed = () => performance.now() } = {}) {
  const body = new Element('body'), previous = new Element('main'); previous.textContent = '鬍鬚'; body.append(previous);
  const listeners = {}, document = { body, hidden: false, createElement: tag => new Element(tag), createElementNS: (_ns, tag) => new Element(tag), addEventListener(name, fn) { listeners[name] = fn; } };
  const timers = [], calls = { closed: 0, practice: [] }, spoken = [];
  class Clock extends Date { static now() { return now; } }
  const context = vm.createContext({ document, Date: Clock, structuredClone, TextEncoder, crypto: webcrypto, performance: { now: elapsed }, console, setTimeout(fn) { timers.push(fn); return timers.length; }, clearTimeout() {}, requestAnimationFrame: () => 1, cancelAnimationFrame() {}, addEventListener() {},
    speechSynthesis: { getVoices: () => [{ lang: 'zh-HK' }], cancel() {}, speak(value) { spoken.push(value.text); } }, SpeechSynthesisUtterance: class { constructor(text) { this.text = text; } } });
  for (const file of ['quiz-results.js', 'assessment.js', 'content.js', 'freehand.js', 'assessment-review.js', 'assessment-ui.js']) vm.runInContext(source(file), context);
  const ui = context.BishunAssessmentUI.create({ store, classroom, onClose() { calls.closed++; }, onPractice(assigned) { calls.practice.push(assigned); } });
  const assigned = context.BishunAssessment.assignment([{ text: '鬍鬚', selectedIndexes: [0, 1] }], 'listen');
  const panel = body.children.at(-1);
  const button = text => panel.all().find(item => item.tagName === 'BUTTON' && item.textContent === text);
  const click = async text => { const item = button(text); assert(item, 'button exists: ' + text); await item.click(); await new Promise(resolve => setImmediate(resolve)); };
  const stroke = async (x = 20) => { const svg = panel.all().find(item => item.tagName === 'SVG' && item.listeners.pointerdown); assert(svg, 'freehand pad exists'); await svg.emit('pointerdown', { button: 0, pointerId: 1, clientX: x, clientY: 30 }); await svg.emit('pointermove', { pointerId: 1, clientX: 420, clientY: 470 }); await svg.emit('pointerup', { pointerId: 1, clientX: 430, clientY: 480 }); await new Promise(resolve => setImmediate(resolve)); };
  const record = () => [...store.records.values()].find(value => value.run && value.kind === 'official');
  return { ui, context, store, panel, previous, calls, assigned, click, button, stroke, record, spoken, timers, listeners, setNow(value) { now = value; } };
}
async function fill(e) {
  await e.click('第 1 題 · 詞語第 1 字 · 未提交'); await e.stroke(); await e.click('交答案');
  await e.stroke(); await e.click('暫時跳過'); await e.click('交整份測驗');
}
test('listen quiz has a free pad with private checkpoints and no visible or accessible answer model', async () => {
  const e = boot(); await e.ui.open(e.assigned);
  assert.equal(e.previous.inert, true); assert.equal(e.previous.attributes['aria-hidden'], 'true');
  assert(!/鬍|鬚/.test(e.panel.textContent));
  await e.click('第 1 題 · 詞語第 1 字 · 未提交'); await e.click('聽題目');
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
  e.store.blocked = true; await e.stroke(); await e.click('交答案');
  assert.match(e.panel.textContent, /儲存空間不足/); assert(e.button('交答案'));
  assert(e.panel.all().some(item => item.attributes.d?.includes('8400 9400')));
  assert.equal(e.record().run.answers[0].strokes.length, 0);
  e.store.blocked = false; await e.click('交答案');
  assert.equal(e.record().run.answers[0].status, 'submitted'); assert.equal(e.record().run.answers[0].strokes[0].length, 3);
});
test('pointer cancellation saves the original partial stroke without appending artificial coordinates', async () => {
  const e = boot(); await e.ui.open(e.assigned); await e.click('第 1 題 · 詞語第 1 字 · 未提交');
  const svg = e.panel.all().find(item => item.tagName === 'SVG' && item.listeners.pointerdown);
  await svg.emit('pointerdown', { button: 0, pointerId: 1, clientX: 100, clientY: 150 });
  await svg.emit('pointermove', { pointerId: 1, clientX: 200, clientY: 250 });
  await svg.emit('pointercancel', { pointerId: 1 }); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(e.record().run.answers[0].strokes[0].map(point => point.slice(0, 2)), [[2000, 3000], [4000, 5000]]);
  await e.click('暫時跳過'); assert.equal(e.record().run.answers[0].status, 'skipped');
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
  await e.click('← 返回原卷'); await e.click('查看原筆跡'); assert(e.panel.textContent.includes('O 正確')); await e.click('← 返回原卷');
  await e.click('情境小挑戰'); await e.click('第 1 題 · 詞語第 1 字 · 未提交');
  assert(!e.panel.textContent.includes('替圖片寫標籤，向同學介紹。')); assert(e.panel.all().some(item => item.tagName === 'IMG' && item.src === 'images/beard.webp'));
  await e.click('聽題目'); assert.match(e.spoken.at(-1), /第 1 個字/);
  await e.stroke(); await e.click('交答案'); await e.stroke(); await e.click('交答案'); await e.click('完成作品卡');
  assert.match(e.panel.textContent, /我的情境作品卡/); assert(!e.panel.textContent.includes('給同學看的圖片介紹'));
  assert.equal(e.panel.querySelector('h2').className, 'sr-only'); assert(e.panel.all().some(item => item.attributes.d?.includes('8400 9400')));
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
  await e.click('下一位同學'); assert.equal(e.ui.active(), false);
  const next = boot({ store: e.store }); await next.ui.open(next.assigned);
  assert.match(next.panel.textContent, /未提交/);
  assert.equal([...e.store.records.values()].filter(item => item.run).length, 2);
  assert.deepEqual(e.store.records.get(first.key), first);
  await fill(next); await next.click('本機原卷');
  assert.equal(next.panel.all().filter(item => item.tagName === 'BUTTON' && /聽詞寫 · 2 字/.test(item.textContent)).length, 2);
});
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
test('late cold class response cannot initialize private ink under the next local context', async () => {
  const response = deferred(), lookup = deferred(), store = memory(), get = store.get;
  let waiting = false;
  store.get = key => key.startsWith('local:') ? (waiting = true, lookup.promise) : get(key);
  const e = boot({ store, classroom: { ownAnswer: () => response.promise } });
  const opening = e.ui.open(e.assigned, { code: 'CLASSAAA', memberId: 'private', expiresAt: Date.now() + 86400000 }); await tick();
  await e.click('← 返回課程'); const local = e.ui.open(e.assigned); await tick(); assert(waiting);
  const run = e.context.BishunAssessment.start(e.assigned, 'private-ink'); run.phase = 'sealed'; run.answers.forEach(answer => { answer.status = 'submitted'; answer.strokes = [[[1234, 5678, 0]]]; });
  response.resolve({ answer: { run, marks: [], score: null, revision: 0 } }); await opening;
  assert.equal(store.records.size, 0, 'the stale response performs no initialize mutation');
  lookup.resolve(null); await local;
  assert(!JSON.stringify([...store.records.values()]).includes('1234'));
  assert([...store.records.keys()].every(key => key.startsWith('local:')));
  assert.match(e.panel.textContent, /未提交/);
});
test('receipt arriving after 24-hour expiry cannot resurrect or redisplay an original', async () => {
  const receipt = deferred(), uploading = deferred(), start = Date.now(), member = { code: 'CLASSAAA', memberId: 'one', expiresAt: start + 86400000 };
  const e = boot({ now: start, classroom: { async ownAnswer() { return { answer: null }; }, submitReviewed() { uploading.resolve(); return receipt.promise; } } });
  await e.ui.open(e.assigned, member); const completion = fill(e); await uploading.promise;
  assert(e.record().run.phase === 'sealed');
  e.setNow(member.expiresAt + 1); await e.timers[0](); assert.equal(e.store.records.size, 0);
  receipt.resolve({ runId: 'late', official: true }); await completion;
  assert.equal(e.store.records.size, 0); assert.match(e.panel.textContent, /測驗已到期/);
  assert.equal(e.panel.all().filter(item => item.tagName === 'PATH').length, 0);
});
test('persistent storage failure allows audio, pause and repeated undo while retaining reduced visible ink', async () => {
  const e = boot(); await e.ui.open(e.assigned); await e.click('第 1 題 · 詞語第 1 字 · 未提交'); e.store.blocked = true;
  const inkCount = () => e.panel.all().filter(item => item.tagName === 'PATH' && !item.attributes['aria-hidden']).length;
  await e.stroke(); await e.stroke(); assert.equal(inkCount(), 2);
  await e.click('聽題目'); assert.equal(e.spoken.length, 1);
  await e.click('撤回一筆'); assert.equal(inkCount(), 1);
  await e.click('休息一下'); assert(e.button('繼續寫字')); await e.click('繼續寫字');
  assert.equal(inkCount(), 1);
  await e.click('撤回一筆'); assert.equal(inkCount(), 0);
  assert.match(e.panel.textContent, /儲存空間不足/); assert(e.button('重試保存'));
  await e.click('← 返回選題'); assert(e.button('撤回一筆'), 'destructive navigation stays blocked');
  e.store.blocked = false; await e.click('重試保存'); assert.equal(e.record().run.answers[0].strokes.length, 0);
});
test('reviewing an older local original does not change the active next-pupil pointer', async () => {
  const e = boot(); await e.ui.open(e.assigned); await fill(e); const first = e.record().key;
  await e.click('下一位同學'); await e.ui.open(e.assigned); await fill(e);
  const second = [...e.store.records.values()].find(item => item.run && item.key !== first).key;
  await e.click('本機原卷'); const older = e.panel.all().find(item => item.tagName === 'BUTTON' && /聽詞寫 · 2 字 · 1$/.test(item.textContent));
  assert(older); await older.click(); await tick(); await e.click('← 返回原卷'); await e.click('下一位同學');
  await e.ui.open(e.assigned);
  const runs = [...e.store.records.values()].filter(item => item.run); assert.equal(runs.length, 3);
  assert(runs.some(item => item.key === first)); assert(runs.some(item => item.key === second));
  assert.match(e.panel.textContent, /未提交/);
});
test('pause excludes rest from teacher elapsed time and resumes the exact ink without speaking', async () => {
  let time = 0; const e = boot({ elapsed: () => time }); await e.ui.open(e.assigned); await e.click('第 1 題 · 詞語第 1 字 · 未提交');
  time = 100; await e.stroke(); time = 1000; await e.click('休息一下');
  const ink = clone(e.record().run.answers[0].strokes); assert.equal(e.record().run.elapsedMs, 1000);
  time = 50000; await e.click('繼續寫字'); assert.equal(e.spoken.length, 0);
  time = 51000; await e.click('交答案'); assert.equal(e.record().run.elapsedMs, 2000); assert.deepEqual(e.record().run.answers[0].strokes, ink);
  assert(!e.panel.textContent.includes('秒'));
  for (const label of ['聽題目', '休息一下', '交答案', '暫時跳過', '撤回一筆']) assert.equal(e.button(label).tagName, 'BUTTON', 'native keyboard activation remains available');
});
test('partial formal selections expand to complete words in the separate context challenge', async () => {
  for (const word of ['鬍鬚', '剪草機', '推來推去']) {
    const e = boot(), assigned = e.context.BishunAssessment.assignment([{ text: word, selectedIndexes: [0] }], 'listen');
    await e.ui.open(assigned); await e.click('第 1 題 · 詞語第 1 字 · 未提交'); await e.stroke(); await e.click('交答案'); await e.click('交整份測驗');
    const original = clone(e.record().run); await e.click('情境小挑戰');
    const challenge = [...e.store.records.values()].find(item => item.kind === 'challenge');
    assert.equal(challenge.run.answers.length, Array.from(word).length); assert.deepEqual(challenge.run.assignment.entries[0].selectedIndexes, Array.from(word, (_, i) => i));
    assert.deepEqual(e.record().run, original); assert.equal(original.answers.length, 1);
  }
});
test('twelve-position summary keeps actions separate from paged original details and six work cards', async () => {
  const e = boot(), words = Array.from(e.context.BishunContent.words);
  const assignment = e.context.BishunAssessment.assignment(words.map(text => ({ text, selectedIndexes: Array.from(text, (_, index) => index) })), 'listen');
  await e.ui.open(assignment); await e.click('第 1 題 · 詞語第 1 字 · 未提交');
  for (let index = 0; index < 12; index++) { await e.stroke(); await e.click('交答案'); }
  await e.click('交整份測驗');
  assert.equal(e.panel.all().filter(item => item.tagName === 'SVG').length, 0, 'summary does not render twelve large sheets above its actions');
  for (const label of ['查看原筆跡', '老師批改', '本機原卷', '下一位同學', '情境小挑戰', '跟住練習', '← 返回課程']) assert(e.button(label));
  await e.click('查看原筆跡'); assert.equal(e.panel.all().filter(item => item.tagName === 'SVG').length, 1);
  assert.equal(e.button('上一項').disabled, true);
  for (let index = 1; index < 12; index++) { await e.click('下一項'); assert.equal(e.panel.all().filter(item => item.tagName === 'SVG').length, 1); }
  assert.equal(e.button('下一項').disabled, true); assert.match(e.panel.textContent, /12 \/ 12/);
  await e.click('← 返回原卷'); await e.click('情境小挑戰'); await e.click('第 1 題 · 詞語第 1 字 · 未提交');
  for (let index = 0; index < 12; index++) { await e.stroke(); await e.click('交答案'); }
  await e.click('完成作品卡');
  for (const [index, word] of words.entries()) {
    assert.equal(e.panel.all().filter(item => item.className === 'assessment-workcard').length, 1);
    assert.equal(e.panel.all().filter(item => item.tagName === 'SVG').length, Array.from(word).length);
    assert(!e.panel.textContent.includes('＿＿')); assert(e.button('← 返回原卷'));
    if (index < words.length - 1) await e.click('下一項');
  }
  assert.equal(e.button('下一項').disabled, true);
});
test('a conflicting second tab preserves its visible ink and never overwrites the saved first tab', async () => {
  const store = memory(), first = boot({ store }), second = boot({ store });
  await first.ui.open(first.assigned); await second.ui.open(second.assigned);
  await first.click('第 1 題 · 詞語第 1 字 · 未提交'); await second.click('第 1 題 · 詞語第 1 字 · 未提交');
  await first.stroke(20); const saved = clone(first.record().run.answers);
  await second.stroke(80); assert.match(second.panel.textContent, /另一分頁/);
  assert(second.panel.all().some(item => item.attributes.d?.startsWith('M1600 600')));
  assert.deepEqual(first.record().run.answers, saved);
  await second.click('重試保存'); assert.match(second.panel.textContent, /另一分頁/);
  assert(second.panel.all().some(item => item.attributes.d?.startsWith('M1600 600')));
  assert.deepEqual(first.record().run.answers, saved);
});
