'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const source = name => fs.readFileSync(require('node:path').join(__dirname, '../dist', name), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
class Element {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.attributes = {}; this.listeners = {}; this.hidden = false; this.disabled = false; this._text = ''; this.style = { values: {}, setProperty: (name, value) => { this.style.values[name] = String(value); } }; }
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
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(item => item !== this); this.parent = null; }
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
    async replacePointer(scope, expected, key, expiresAt, guard) { guard(); if (records.get(scope)?.runKey === expected) save({ key: scope, runKey: key, expiresAt }); },
    async activeLocal(version) { const pointer = [...records.values()].find(record => record.key.startsWith('local:') && record.runKey && (!version || records.get(record.runKey)?.run.version === version)); return pointer ? clone(records.get(pointer.runKey)) : null; },
    async purge(now = Date.now()) { for (const [key, value] of records) if (value.expiresAt <= now) records.delete(key); } };
}
function boot({ store = memory(), classroom = null, now = Date.now(), elapsed = () => performance.now() } = {}) {
  const body = new Element('body'), previous = new Element('main'); previous.textContent = '鬍鬚'; body.append(previous);
  const listeners = {}, document = { body, hidden: false, createElement: tag => new Element(tag), createElementNS: (_ns, tag) => new Element(tag), addEventListener(name, fn) { listeners[name] = fn; } };
  const timers = [], canceled = new Set(), calls = { closed: 0, practice: [] }, spoken = [];
  class Clock extends Date { static now() { return now; } }
  const context = vm.createContext({ document, Date: Clock, structuredClone, TextEncoder, AbortController, crypto: webcrypto, performance: { now: elapsed }, console, setTimeout(fn) { timers.push(fn); return timers.length; }, clearTimeout(id) { canceled.add(id); }, requestAnimationFrame: () => 1, cancelAnimationFrame() {}, addEventListener() {},
    speechSynthesis: { getVoices: () => [{ lang: 'zh-HK' }], cancel() {}, speak(value) { spoken.push(value.text); } }, SpeechSynthesisUtterance: class { constructor(text) { this.text = text; } } });
  for (const file of ['quiz-results.js', 'assessment.js', 'content.js', 'freehand.js', 'assessment-review.js', 'assessment-ui.js']) vm.runInContext(source(file), context);
  const mounts = [], hints = [];
  context.BishunWriting = {
    async loadCharacter() { return { strokes: ['M1 1L2 2', 'M2 2L3 3'], medians: [[[1,1],[2,2]],[[2,2],[3,3]]] }; },
    mount(target, character, data, options) {
      const mount = { target, character, options, suspended: false, ink: clone(options.acceptedInk) }; mounts.push(mount);
      const draw = () => { context.BishunFreehand.render(target, mount.ink, '原筆跡', character); };
      draw(); queueMicrotask(() => options.onReady());
      mount.stroke = (stroke = [[400,600],[8400,9400]], index = mount.ink.length) => {
        if (options.locked || mount.suspended) return false;
        const accepted = options.onEvent({ type: 'STROKE_ACCEPTED', strokeIndex: index, stroke });
        if (accepted) { mount.ink.push(stroke); draw(); if (mount.ink.length === data.strokes.length) options.onEvent({ type: 'WRITING_COMPLETE' }); }
        return accepted;
      };
      return { dispose() { mount.suspended = true; }, suspend() { mount.suspended = true; }, hint() { const completion = deferred(); hints.push({ ...completion, index: mount.ink.length }); return completion.promise; } };
    }
  };
  const ui = context.BishunAssessmentUI.create({ store, classroom, onClose() { calls.closed++; }, onPractice(assigned) { calls.practice.push(assigned); } });
  const assigned = context.BishunAssessment.assignment([{ text: '鬍鬚', selectedIndexes: [0, 1] }], 'listen');
  const panel = body.children.at(-1);
  const button = text => panel.all().find(item => item.tagName === 'BUTTON' && (item.textContent === text || item.attributes['aria-label'] === text || item.attributes['aria-label']?.startsWith(text + '；')));
  const click = async text => { const item = button(text); assert(item, 'button exists: ' + text); await item.click(); await new Promise(resolve => setImmediate(resolve)); };
  const stroke = async (x = 400) => { const result = mounts.at(-1).stroke([[x,600],[8400,9400]]); await tick(); return result; };
  const record = () => [...store.records.values()].find(value => value.run && value.kind === 'official');
  return { ui, context, store, panel, previous, calls, assigned, click, button, stroke, record, spoken, timers, canceled, mounts, hints, listeners, setNow(value) { now = value; } };
}
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
async function chooseFirst(e) { const card = e.panel.all().find(item => item.tagName === 'BUTTON' && item.className?.includes('assessment-choice-card') && !item.disabled); assert(card); await card.click(); await tick(); }
async function begin(e) { await chooseFirst(e); await e.click('開始'); }
async function character(e) { await e.stroke(); await e.stroke(); await e.click('交答案'); }
async function fill(e) { await begin(e); await character(e); await e.click('下一個字'); await character(e); await e.click('下一個字'); }
const ink = e => e.mounts.at(-1).ink;
function classClient(extra = {}) { return { cancelRequests() {}, async ownAutomaticAnswer() { return { answer: null }; }, async submitAutomatic(run) { return { version: 4, policy: 'locked-strokes-0.9-v1', runId: run.runId, official: true, elapsedMs: Math.round(run.elapsedMs / 100) * 100 }; }, async automaticBoard() { return { rows: [{ alias: '小星', rank: 1, elapsedMs: 1000 }] }; }, ...extra }; }
const member = () => ({ code: 'CLASSAAA', memberId: 'one', expiresAt: Date.now() + 86400000 });

test('locked challenge preserves copy presentation and original ordinal speech for a legacy listen assignment', async () => {
  const e = boot(); await e.ui.open(e.assigned); assert.equal(e.previous.inert, true); await begin(e); await e.click('聽題目');
  assert.equal(e.spoken[0], '鬍。寫第 1 個字。'); assert.equal(e.record().run.version, 4); assert.equal(e.record().run.presentationMode, 'copy'); assert.equal(e.record().run.assignment.mode, 'listen');
  assert(e.panel.querySelector('[data-hint]')); assert(e.button('交答案').disabled);
  await e.stroke(); assert(e.button('交答案').disabled); const before = clone(e.record().run.answers[0].strokes);
  e.mounts.at(-1).options.onEvent({ type: 'STROKE_MISSED', strokeIndex: 1 }); assert.match(e.panel.textContent, /↻ 請重新書寫此筆。/); assert.deepEqual(e.record().run.answers[0].strokes, before);
  await e.stroke(); assert.equal(e.button('交答案').disabled, false); await e.click('交答案'); assert(e.panel.textContent.includes('O')); assert(!e.panel.textContent.includes('批改'));
  assert(!e.button('擦掉前一筆')); await e.click('下一個字'); await e.click('聽題目'); assert.equal(e.spoken[1], '鬚。寫第 2 個字。'); assert(!e.button('開始'));
  assert.equal(new Set(e.mounts.map(mount => mount.target)).size, 1);
});

test('completion shows only time board and Back releases exactly its local pointer while retaining history', async () => {
  const e = boot(); await e.ui.open(e.assigned); await fill(e); const first = clone(e.record());
  assert.match(e.panel.textContent, /本機排行榜/); assert.match(e.panel.textContent, /紀錄 1/); assert.equal(e.panel.all().filter(item => item.tagName === 'BUTTON').length, 1);
  for (const text of ['老師批改', '原卷紀錄', '情境小挑戰', '跟住練習', '下一位同學', '查看原筆跡']) assert(!e.panel.textContent.includes(text));
  const revision = e.record().revision; await e.listeners.visibilitychange(); await tick(); assert.equal(e.record().revision, revision);
  await e.click('← 返回課程'); assert.equal(e.previous.inert, false); assert.deepEqual(e.store.records.get(first.key), first);
  await e.ui.open(e.assigned); assert(e.button('鬍鬚')); await fill(e); assert.match(e.panel.textContent, /紀錄 2/);
  assert.equal([...e.store.records.values()].filter(item => item.run).length, 2);
});

test('Start gates ink and time; Submit pauses result waiting; Next resumes only inside the same word', async () => {
  let time = 0; const e = boot({ elapsed: () => time });
  const assigned = e.context.BishunAssessment.assignment([{ text: '鬍鬚', selectedIndexes: [0,1] }, { text: '粗', selectedIndexes: [0] }], 'copy');
  await e.ui.open(assigned); await chooseFirst(e); time = 5000; await e.stroke(); assert.equal(e.record().run.elapsedMs, 0); assert.equal(ink(e).length, 0);
  await e.click('開始'); time = 6000; await character(e); assert.equal(e.record().run.elapsedMs, 1000);
  time = 50000; await e.click('下一個字'); time = 51000; await character(e); assert.equal(e.record().run.elapsedMs, 2000);
  time = 90000; await e.click('下一個字'); assert(e.button('鬍鬚已完成').disabled); await e.click('粗'); assert(e.button('開始'));
  await e.click('開始'); time = 91000; await character(e); await e.click('下一個字'); assert.equal(e.record().run.elapsedMs, 3000);
});

test('Hint includes foreground time, preserves original prefix, retries same next stroke and Undo rewinds full unsubmitted ink', async () => {
  let time = 0; const e = boot({ elapsed: () => time }); await e.ui.open(e.assigned); await begin(e);
  time = 1000; await e.stroke(); const before = clone(ink(e)); await e.click('提示'); assert.equal(e.hints[0].index, 1);
  await e.stroke(); assert.deepEqual(ink(e), before); time = 3000; e.hints[0].resolve(); await tick(); assert.deepEqual(ink(e), before);
  await e.stroke(); assert.equal(e.button('交答案').disabled, false); assert(e.button('提示').disabled);
  await e.click('擦掉前一筆'); assert.deepEqual(ink(e), before); assert(e.button('交答案').disabled);
  await e.click('提示'); assert.equal(e.hints[1].index, 1); e.hints[1].resolve(); await tick();
  await e.stroke(); await e.click('交答案'); assert.equal(e.record().run.elapsedMs, 3000); assert.equal(e.record().run.answers[0].hintUsed, true);
});

test('menu, hidden and cold reopen exclude waits and restore exact ink with Start required after menu or cold reopen', async () => {
  let time = 0; const e = boot({ elapsed: () => time }); await e.ui.open(e.assigned); await begin(e);
  time = 1000; await e.stroke(); time = 2000; e.context.document.hidden = true; e.listeners.visibilitychange(); await tick();
  const original = clone(e.record().run.answers[0].strokes); assert.equal(e.record().run.elapsedMs, 2000);
  time = 90000; e.context.document.hidden = false; e.listeners.visibilitychange(); await tick(); assert.deepEqual(ink(e), original);
  time = 91000; await e.click('← 返回選題'); assert.equal(e.record().run.elapsedMs, 3000);
  time = 180000; await chooseFirst(e); assert(e.button('開始')); await e.stroke(); assert.deepEqual(ink(e), original);
  const reload = boot({ store: e.store }); await reload.ui.open(e.assigned); await chooseFirst(reload); assert(reload.button('開始')); assert.deepEqual(ink(reload), original); assert.equal(reload.spoken.length, 0);
});

test('storage failure retains visible accepted ink and stops time and new input until saved', async () => {
  let time = 0; const e = boot({ elapsed: () => time }); await e.ui.open(e.assigned); await begin(e); time = 1000; await e.stroke();
  e.store.blocked = true; time = 2000; await e.stroke(); assert.equal(ink(e).length, 2); assert.match(e.panel.textContent, /儲存空間不足/); assert(e.button('交答案').disabled);
  time = 50000; await e.stroke(); assert.equal(ink(e).length, 2); await e.click('← 返回選題'); assert(e.button('重試保存及載入'));
  e.store.blocked = false; await e.click('重試保存及載入'); assert.equal(e.record().run.answers[0].strokes.length, 2);
  await e.click('交答案'); assert.equal(e.record().run.elapsedMs, 2000);
});

test('two tabs preserve the losing visible ink without overwriting the newer saved draft', async () => {
  const store = memory(), first = boot({ store }), second = boot({ store }); await first.ui.open(first.assigned); await begin(first); await second.ui.open(second.assigned); await begin(second);
  await second.stroke(20); const saved = clone(second.record().run); await first.stroke(80); assert.match(first.panel.textContent, /另一分頁/); assert.equal(ink(first)[0][0][0], 80); assert.deepEqual(second.record().run, saved);
  await first.click('重試保存及載入'); assert.match(first.panel.textContent, /另一分頁/); assert.deepEqual(second.record().run, saved);
});

test('late cold class response cannot write private ink into a newly opened local context', async () => {
  const response = deferred(), e = boot({ classroom: classClient({ ownAutomaticAnswer: () => response.promise }) });
  const opening = e.ui.open(e.assigned, member()); await tick(); await e.click('← 返回課程'); await e.ui.open(e.assigned);
  response.resolve({ answer: { private: 'private-original' } }); await opening;
  assert([...e.store.records.keys()].every(key => key.startsWith('local:v4:'))); assert(!JSON.stringify([...e.store.records.values()]).includes('private-original'));
});

test('expired upload response cannot resurrect or redisplay a private original', async () => {
  const receipt = deferred(), uploading = deferred(), joined = member(), e = boot({ classroom: classClient({ submitAutomatic() { uploading.resolve(); return receipt.promise; } }) });
  await e.ui.open(e.assigned, joined); const completion = fill(e); await uploading.promise; assert.equal(e.record().run.phase, 'sealed');
  e.setNow(joined.expiresAt + 1); await e.timers.at(-1)(); assert.equal(e.store.records.size, 0);
  receipt.resolve({ version:4, official:true }); await completion; assert.equal(e.store.records.size, 0); assert.match(e.panel.textContent, /小挑戰已到期/);
});

test('unavailable custom data keeps draft and retry, without allowing writing or showing wrong feedback', async () => {
  const e = boot(); e.context.BishunWriting.loadCharacter = async () => { throw new Error('offline'); }; await e.ui.open(e.assigned); await chooseFirst(e);
  assert.match(e.panel.textContent, /字形暫未能載入/); assert(!e.panel.textContent.includes('重新書寫此筆')); assert(e.button('開始').disabled); assert(e.button('重試保存及載入'));
  e.context.BishunWriting.loadCharacter = async () => ({ strokes: ['a','b'] }); await e.click('重試保存及載入'); assert.equal(e.button('開始').disabled, false);
});

test('late hint completion and old pad callbacks cannot change another character', async () => {
  const e = boot(); await e.ui.open(e.assigned); await begin(e); await e.click('提示'); const old = e.mounts.at(-1).options;
  await e.click('← 返回選題'); e.hints[0].resolve(); await tick(); assert(e.button('鬍鬚')); const before = clone(e.record().run);
  assert.equal(old.onEvent({ type:'STROKE_ACCEPTED', strokeIndex:0, stroke:[[1,2],[3,4]] }), false); assert.deepEqual(e.record().run, before);
});

test('old freehand drafts stay untouched in old scopes and are not resumed as accepted progress', async () => {
  const e = boot(), A = e.context.BishunAssessment, oldRun = A.startWords(e.assigned, 'old-freehand'), scope = 'local:' + JSON.stringify(e.assigned);
  oldRun.answers[0].strokes = [[[1,2,0],[3,4,20]]]; await e.store.initialize(scope, { key:scope+':old',run:oldRun,expiresAt:Date.now()+86400000,kind:'official' });
  const old = clone([...e.store.records.values()]); assert.equal(await e.ui.hasLocal(), false); await e.ui.open(e.assigned); await begin(e); assert.equal(e.mounts.at(-1).ink.length,0);
  for(const value of old) assert.deepEqual(e.store.records.get(value.key),value);
});

test('class board polls metadata only, stops hidden and ignores late updates', async () => {
  let reads = 0, boards = 0; const late = deferred();
  const e = boot({ classroom:classClient({ async ownAutomaticAnswer(){ reads++; return {answer:null}; }, automaticBoard(){ boards++; return boards === 2 ? late.promise : Promise.resolve({rows:[{alias:'小星',rank:1,elapsedMs:1000}]}); } }) });
  await e.ui.open(e.assigned,member()); await fill(e); assert.equal(reads,1); assert.equal(boards,1); assert.match(e.panel.textContent,/小星/);
  const polling=e.timers.at(-1)(); await tick(); e.context.document.hidden=true; e.listeners.visibilitychange(); late.resolve({rows:[{alias:'stale',rank:1,elapsedMs:1000}]}); await polling; assert(!e.panel.textContent.includes('stale'));
  e.context.document.hidden=false; e.listeners.visibilitychange(); await tick(); assert.equal(reads,1); assert.equal(boards,3);
});

test('first automatic conflict keeps the local sealed alternative and adopts the official original pointer', async () => {
  const A = boot().context.BishunAssessment, assigned=A.assignment([{text:'鬍鬚',selectedIndexes:[0,1]}],'listen');
  let official=A.startLocked(assigned,'official'); official.answers.forEach(answer=>{answer.status='submitted';answer.expectedStrokes=2;answer.strokes=[[[1,2],[3,4]],[[3,4],[5,6]]];});official.wordProgress[0].phase='submitted';official=A.transition(official,{type:'SEAL'});
  const receipt={version:4,policy:A.policy,runId:'official',official:true,elapsedMs:0}; let reads=0;
  const e=boot({classroom:classClient({async ownAutomaticAnswer(){return {answer:++reads===1?null:{run:official,receipt}};},async submitAutomatic(){throw Object.assign(new Error('first'),{code:'FIRST_SUBMISSION'});}})});
  await e.ui.open(e.assigned,member());await fill(e);const records=[...e.store.records.values()].filter(value=>value.run);assert.equal(records.length,2);assert(records.every(value=>value.run.phase==='sealed'));
  const pointer=[...e.store.records.values()].find(value=>value.runKey);assert.equal(e.store.records.get(pointer.runKey).run.runId,'official');assert.match(e.panel.textContent,/班級排行榜/);
});

test('repeated Hint cancels the previous promise and speech cannot leave matching paused', async () => {
  const e=boot();await e.ui.open(e.assigned);await begin(e);await e.click('提示');await e.click('提示');assert.equal(e.hints.length,2);
  e.hints[0].resolve();await tick();assert.equal(await e.stroke(),false);e.hints[1].resolve();await tick();assert.equal(await e.stroke(),true);
  await e.click('提示');await e.click('聽題目');assert.equal(e.spoken.length,1);assert.equal(await e.stroke(),true);e.hints[2].resolve();await tick();assert.equal(e.record().run.answers[0].strokes.length,2);
});

test('loading delays and failed same-word Next do not advance the displayed or saved character',async()=>{
  let time=0;const e=boot({elapsed:()=>time});await e.ui.open(e.assigned);await begin(e);time=1000;await character(e);
  e.store.blocked=true;await e.click('下一個字');assert.equal(e.record().run.cursor,0);assert.equal(e.mounts.at(-1).character,'鬍');e.store.blocked=false;await e.click('重試保存及載入');
  const load=deferred(),loader=e.context.BishunWriting.loadCharacter;e.context.BishunWriting.loadCharacter=()=>load.promise;
  time=50000;await e.click('下一個字');assert.equal(e.record().run.cursor,1);assert(e.button('交答案').disabled);
  time=90000;load.resolve(await loader());await tick();time=91000;await character(e);assert.equal(e.record().run.elapsedMs,2000);
});

test('local board filters assignment, actual mode and policy without writing their revisions',async()=>{
  const e=boot();await e.ui.open(e.assigned);await fill(e);const original=clone(e.record()),unrelated=clone(original),freehand=clone(original),policy=clone(original);
  unrelated.key='local:v4:other';unrelated.run.assignment.entries[0].selectedIndexes=[0];freehand.key='local:old';freehand.run.version=3;policy.key='local:policy';policy.run.policy='other';
  for(const value of [unrelated,freehand,policy])e.store.records.set(value.key,value);
  const before=JSON.stringify([...e.store.records]);e.listeners.visibilitychange();await tick();assert.equal(JSON.stringify([...e.store.records]),before);assert(!e.panel.textContent.includes('紀錄 2'));
});

test('Back remains available during an automatic upload and late receipt cannot reopen the closed view',async()=>{
  const uploaded=deferred(),e=boot({classroom:classClient({submitAutomatic:()=>uploaded.promise})});await e.ui.open(e.assigned,member());await fill(e);assert.match(e.panel.textContent,/交卷中/);
  await e.click('← 返回課程');assert.equal(e.ui.active(),false);const before=JSON.stringify([...e.store.records]);uploaded.resolve({version:4,official:true});await tick();assert.equal(JSON.stringify([...e.store.records]),before);assert.equal(e.ui.active(),false);
});
