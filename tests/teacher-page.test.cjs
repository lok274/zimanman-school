'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { webcrypto } = require('node:crypto');
const { defaultOrigin } = require('../dist/classroom.js');
const root = path.join(__dirname, '../classroom-service');
execFileSync(process.execPath, [path.join(root, 'build.mjs')]);
const page = fs.readFileSync(path.join(root, 'src/teacher-page.js'), 'utf8');
const html = JSON.parse(page.slice('export default '.length, -2));
const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
const pagesHTML = fs.readFileSync(path.join(__dirname, '../dist/teacher.html'), 'utf8');
function boot({ data = new Map(), owners = new Map(), origin = 'https://worker.test', hash = '', pathname = '/teacher', search = '', pageScript = script, blocked = false, blockedOwners = false, clipboard, fetch: send = async () => { throw new Error('offline'); } } = {}) {
  const nodes = new Map();
  const node = () => ({ textContent: '', children: [], listeners: {}, append(...items) { this.children.push(...items); }, replaceChildren(...items) { this.children = items; }, addEventListener(type, handler) { this.listeners[type] = handler; } });
  for (const id of ['status', 'assignment', 'create', 'new-class', 'room', 'code', 'expiry', 'refresh', 'board', 'mode', 'publish', 'delete-class', 'members', 'review', 'join-qr', 'student-link', 'copy-student-link']) nodes.set(id, { ...node(), hidden: ['room', 'new-class', 'publish'].includes(id) });
  const controls = { blocked, blockedOwners };
  const storage = (map, flag) => ({ getItem: key => map.get(key) || null, setItem(key, value) { if (controls[flag]) throw new Error('blocked'); map.set(key, value); } });
  const calls = [], navigation = [];
  const key = vm.runInNewContext(pageScript + '\n;storageKey;', { document: { getElementById: id => nodes.get(id), createElement: node }, crypto: webcrypto, Uint8Array, URL, navigator: { clipboard }, localStorage: storage(owners, 'blockedOwners'), sessionStorage: storage(data, 'blocked'), location: { origin, hash, pathname, search }, history: { replaceState(...args) { navigation.push(args); } }, fetch(url, options) { calls.push({ url, options }); return send(url, options); } });
  return { nodes, get draft() { return JSON.parse(data.get(key) || 'null'); }, data, owners, controls, calls, navigation, click: id => nodes.get(id).listeners.click() };
}
const room = { code: 'ABCDEFGH', expiresAt: Date.now() + 86400000, assignment: { version: 1, entries: [{ text: '一', selectedIndexes: [0] }] } };
const response = (data, ok = true) => ({ ok, json: async () => data });

test('teacher shares only the public class link, creates its QR locally and restores both after reload', async () => {
  const copied = [], numericRoom = { ...room, code: '123' };
  const e = boot({ clipboard: { writeText: async value => copied.push(value) }, fetch: async () => response(numericRoom) });
  await e.click('create');
  const student = 'https://lok274.github.io/zimanman-school/?class=123';
  assert.equal(e.nodes.get('student-link').href, student);
  assert.match(e.nodes.get('join-qr').innerHTML, /^<svg/);
  const qrContext = {}; vm.runInNewContext(fs.readFileSync(path.join(root, 'vendor/qrcode.js'), 'utf8'), qrContext);
  const qr = qrContext.qrcode(0, 'M'); qr.addData(student, 'Byte'); qr.make();
  assert.equal(e.nodes.get('join-qr').innerHTML, qr.createSvgTag({ cellSize: 6, margin: 24, scalable: true }));
  await e.click('copy-student-link'); assert.deepEqual(copied, [student]);
  assert(!student.includes(e.draft.ownerCapability)); assert.deepEqual([...new URL(student).searchParams.keys()], ['class']);
  const reload = boot({ data: e.data, owners: e.owners });
  assert.equal(reload.nodes.get('student-link').href, student); assert.equal(reload.nodes.get('join-qr').innerHTML, e.nodes.get('join-qr').innerHTML);
  await reload.click('copy-student-link'); assert.match(reload.nodes.get('status').textContent, /長按學生頁面連結/);
  reload.click('new-class');
  assert.equal(reload.nodes.get('room').hidden, true);
  const next = boot({ data: reload.data, owners: reload.owners, fetch: async () => response({ ...room, code: '456' }) });
  await next.click('create'); assert.equal(next.nodes.get('student-link').href, 'https://lok274.github.io/zimanman-school/?class=456');
  assert.notEqual(next.nodes.get('join-qr').innerHTML, e.nodes.get('join-qr').innerHTML);
  assert.match(html, /MIT License/); assert(!/<script[^>]+src=/.test(html));
});

test('Pages and legacy teacher use the canonical page, omit cookies and retain assignment, path, query and retry identity', async () => {
  const serviceOrigin = defaultOrigin;
  assert.equal(pagesHTML, html.replace('const apiOrigin = "";', 'const apiOrigin = "' + serviceOrigin + '";'));
  assert(!/__API_ORIGIN__|__DEFAULT_ENTRIES__|__ASSESSMENT_/.test(pagesHTML));
  for (const [document, prefix, pathname] of [[html, '', '/teacher'], [pagesHTML, serviceOrigin, '/zimanman-school/teacher.html']]) {
    const pageScript = document.match(/<script>([\s\S]*)<\/script>/)[1];
    const entries = [{ text: '推來推去', selectedIndexes: [3] }]; let attempts = 0;
    const options = { pageScript, pathname, search: '?lesson=one', hash: '#' + encodeURIComponent(JSON.stringify({ entries, ownerCapability: 'b'.repeat(64) })), fetch: async (_url, init) => {
      if (!attempts++) throw new Error('offline');
      return response(init.method === 'DELETE' ? { deleted: true } : { ...room, assignment: { ...room.assignment, version: 2 } });
    } };
    const e = boot(options), owner = e.draft.ownerCapability;
    assert.equal(e.navigation[0][2], pathname + '?lesson=one');
    assert.deepEqual(e.draft.entries, entries); assert.notEqual(owner, 'b'.repeat(64));
    await e.click('create'); await e.click('create');
    assert.equal(e.calls[0].options.body, e.calls[1].options.body);
    assert.equal(e.calls[0].url, prefix + '/api/v1/classes');
    const reload = boot({ ...options, hash: '', data: e.data, owners: e.owners });
    assert.equal(reload.draft.requestId, e.draft.requestId); assert.equal(reload.draft.ownerCapability, owner);
    await reload.click('refresh'); await reload.click('delete-class'); await reload.click('delete-class');
    assert.equal(reload.calls[0].url, prefix + '/api/v1/classes/' + room.code + '/reviews');
    assert.equal(reload.calls.at(-1).options.method, 'DELETE');
    for (const call of [...e.calls, ...reload.calls]) {
      assert.equal(call.options.credentials, 'omit');
      assert.equal(call.options.headers['X-Teacher-Capability'], owner);
      assert(!Object.keys(call.options.headers).some(name => /cookie|authorization/i.test(name)));
    }
  }
});

test('teacher drafts stay with the API origin while owner identity and old records survive', async () => {
  const old = boot({ fetch: async () => response(room) });
  await old.click('create');
  const oldDraft = JSON.stringify(old.draft), owner = old.draft.ownerCapability;
  old.data.set('zimanman:teacher', oldDraft);
  old.data.set('bishun-school:v1:history', 'local practice record');
  const pageScript = pagesHTML.match(/<script>([\s\S]*)<\/script>/)[1];
  const options = { data: old.data, owners: old.owners, pageScript, origin: 'https://lok274.github.io', fetch: async () => response(room) };
  const next = boot(options);
  assert.equal(next.draft.room, undefined);
  assert.equal(next.nodes.get('room').hidden, true);
  assert.notEqual(next.draft.requestId, old.draft.requestId);
  assert.equal(next.draft.ownerCapability, owner);
  assert.equal(next.calls.length, 0);
  const requestId = next.draft.requestId;
  const pendingReload = boot(options);
  assert.equal(pendingReload.draft.requestId, requestId);
  await pendingReload.click('create');
  assert.equal(pendingReload.calls[0].url, defaultOrigin + '/api/v1/classes');
  assert.equal(pendingReload.calls[0].options.headers['X-Teacher-Capability'], owner);
  const reload = boot(options);
  assert.equal(reload.draft.requestId, requestId);
  assert.equal(reload.draft.room.code, room.code);
  assert.equal(reload.draft.ownerCapability, owner);
  const sameAPI = boot({ ...options, origin: 'https://another-static.test' });
  assert.equal(sameAPI.draft.requestId, requestId);
  const oldReload = boot({ data: old.data, owners: old.owners });
  assert.equal(JSON.stringify(oldReload.draft), oldDraft);
  assert.equal(old.data.get('zimanman:teacher'), oldDraft);
  assert.equal(old.data.get('bishun-school:v1:history'), 'local practice record');
  assert.equal(old.owners.get('zimanman:teacher-owner'), owner);
});

test('ordinary teacher page gets canonical six-word scope and retains its request after reload', () => {
  const e = boot();
  const content = {}; vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../dist/content.js'), 'utf8'), content);
  assert.deepEqual(e.draft.entries.map(entry => entry.text), Array.from(content.BishunContent.words));
  for (const entry of e.draft.entries) assert.deepEqual(entry.selectedIndexes, Array.from(entry.text, (_, i) => i));
  assert.equal(e.nodes.get('create').disabled, false);
  const reload = boot({ data: e.data, owners: e.owners });
  assert.equal(reload.draft.requestId, e.draft.requestId); assert.equal(reload.draft.ownerCapability, e.draft.ownerCapability);
  assert.match(e.draft.ownerCapability, /^[a-f0-9]{64}$/);
  assert.equal(e.owners.get('zimanman:teacher-owner'), e.draft.ownerCapability);
  assert(!/signin-with-chatgpt|ChatGPT|type="password"/.test(html));
  assert(!/同學用班級碼|第一份原卷計分|開班資料由|原筆跡和批改只供/.test(html));
});
test('teacher chooses reviewed mode, privately collects originals, publishes and deliberately deletes', async () => {
  const reviewedRoom = { ...room, assignment: { ...room.assignment, version: 2, mode: 'listen' } };
  const e = boot({ fetch: async (url, options) => response(options.method === 'DELETE' ? { deleted: true } : url.endsWith('/reviews') ? { members: [{ alias: '小星', memberId: 'one', runId: 'run', score: 1, elapsedMs: 40 }], published: false, rows: [] } : url.endsWith('/publication') ? { published: true, rows: [{ alias: '小星', rank: 1, score: 1 }] } : reviewedRoom) });
  const first = e.draft.requestId; e.nodes.get('mode').value = 'listen'; e.nodes.get('mode').listeners.change();
  assert.notEqual(e.draft.requestId, first); await e.click('create');
  assert.equal(JSON.parse(e.calls[0].options.body).mode, 'listen'); assert.equal(JSON.parse(e.calls[0].options.body).version, 2);
  await e.click('refresh'); assert.equal(e.calls[1].url, '/api/v1/classes/' + room.code + '/reviews');
  assert.equal(e.calls[1].options.headers['X-Teacher-Capability'], e.draft.ownerCapability);
  await e.click('publish'); assert.equal(e.calls[2].options.method, 'POST'); assert.equal(e.nodes.get('publish').disabled, true);
  const before = e.calls.length; await e.click('delete-class'); assert.equal(e.calls.length, before);
  await e.click('delete-class'); assert.equal(e.calls.at(-1).options.method, 'DELETE'); assert.equal(e.nodes.get('room').hidden, true); assert.equal(e.draft.room, undefined);
});
test('teacher publication stays disabled for no submissions or any incomplete submitted review', async () => {
  const reviewedRoom = { ...room, assignment: { ...room.assignment, version: 2, mode: 'listen' } }; let members = [];
  const e = boot({ fetch: async url => response(url.endsWith('/reviews') ? { members, published: false, rows: [] } : reviewedRoom) });
  await e.click('create'); assert.equal(e.nodes.get('publish').disabled, true); assert.equal(e.nodes.get('publish').hidden, true);
  await e.click('refresh'); assert.equal(e.nodes.get('publish').disabled, true); assert.equal(e.nodes.get('publish').hidden, true);
  members = [{ alias: 'a', runId: null, score: null }]; await e.click('refresh'); assert.equal(e.nodes.get('publish').disabled, true);
  members.push({ alias: 'b', runId: 'one', score: null }); await e.click('refresh'); assert.equal(e.nodes.get('publish').disabled, true); assert.equal(e.nodes.get('publish').hidden, false);
  members[1].score = 0; await e.click('refresh'); assert.equal(e.nodes.get('publish').disabled, false, 'zero is a complete teacher grade');
  members.push({ alias: 'c', runId: 'two', score: null }); await e.click('refresh'); assert.equal(e.nodes.get('publish').disabled, true);
});

test('selected scope remains optional and storage failure disables creation before writing', () => {
  const entries = [{ text: '推來推去', selectedIndexes: [3] }];
  const e = boot({ hash: '#' + encodeURIComponent(JSON.stringify({ entries })) });
  assert.deepEqual(e.draft.entries, entries); assert.equal(e.nodes.get('assignment').textContent, '去');
  const denied = boot({ blocked: true });
  assert.equal(denied.draft, null); assert.equal(denied.nodes.get('create').disabled, true);
  assert.match(denied.nodes.get('status').textContent, /儲存/);
  const ownerDenied = boot({ blockedOwners: true });
  assert.equal(ownerDenied.draft, null); assert.equal(ownerDenied.nodes.get('create').disabled, true);
});

test('teacher retries retain owner and request, reload restores room and an explicit new class gets a fresh request', async () => {
  let attempts = 0;
  const e = boot({ fetch: async () => { if (!attempts++) throw new Error('Failed to fetch'); return response(room); } });
  const requestId = e.draft.requestId, owner = e.draft.ownerCapability;
  await e.click('create');
  assert.match(e.nodes.get('status').textContent, /未能連線/); assert.equal(e.nodes.get('create').disabled, false);
  await e.click('create');
  assert.equal(e.calls[0].options.body, e.calls[1].options.body); assert.equal(e.calls[1].options.headers['X-Teacher-Capability'], owner);
  assert.deepEqual(JSON.parse(e.calls[1].options.body), { requestId, version: 2, mode: 'copy', entries: e.draft.entries });
  assert.equal(e.draft.room.code, room.code); assert.equal(e.nodes.get('create').disabled, true);
  const reload = boot({ data: e.data, owners: e.owners, fetch: async () => response({ rows: [] }) });
  assert.equal(reload.nodes.get('room').hidden, false); assert.equal(reload.nodes.get('code').textContent, room.code);
  await reload.click('refresh');
  assert.equal(reload.calls[0].url, '/api/v1/classes/' + room.code + '/teacher-board');
  assert.equal(reload.calls[0].options.headers['X-Teacher-Capability'], owner);
  reload.click('new-class');
  assert.notEqual(reload.draft.requestId, requestId); assert.equal(reload.draft.ownerCapability, owner);
  assert.equal(reload.nodes.get('room').hidden, true); assert.equal(reload.nodes.get('create').disabled, false);
});

test('creation persists intent before sending and retains retry identity if saving its response fails', async () => {
  let e;
  e = boot({ fetch: async (_url, options) => {
    assert.equal(JSON.parse(options.body).requestId, e.draft.requestId);
    e.controls.blocked = true;
    return response(room);
  } });
  const requestId = e.draft.requestId;
  await e.click('create');
  assert.equal(e.nodes.get('code').textContent, room.code); assert.match(e.nodes.get('status').textContent, /未能保存/);
  assert.equal(e.draft.room, undefined); assert.equal(e.draft.requestId, requestId);
  const reload = boot({ data: e.data, owners: e.owners, fetch: async () => response(room) });
  await reload.click('create');
  assert.equal(JSON.parse(reload.calls[0].options.body).requestId, requestId); assert.equal(reload.draft.room.code, room.code);
  const denied = boot(); denied.controls.blocked = true;
  await denied.click('create'); assert.equal(denied.calls.length, 0);
  reload.controls.blocked = true; reload.click('new-class');
  assert.equal(reload.draft.requestId, requestId); assert.equal(reload.nodes.get('room').hidden, false);
});

test('an expired unsaved request can be replaced and another tab cannot change the current draft owner', async () => {
  const e = boot({ fetch: async () => response({ error: { code: 'EXPIRED', message: '班級已到期。' } }, false) });
  const previous = e.draft;
  await e.click('create'); assert.equal(e.nodes.get('new-class').hidden, false);
  e.click('new-class'); assert.notEqual(e.draft.requestId, previous.requestId);
  e.owners.clear();
  const other = boot({ owners: e.owners });
  assert.notEqual(other.draft.ownerCapability, previous.ownerCapability);
  const reload = boot({ data: e.data, owners: e.owners, fetch: async () => response(room) });
  await reload.click('create');
  assert.equal(reload.calls[0].options.headers['X-Teacher-Capability'], previous.ownerCapability);
  const selected = boot({ owners: e.owners, hash: '#' + encodeURIComponent(JSON.stringify({ entries: [{ text: '一', selectedIndexes: [0] }], ownerCapability: previous.ownerCapability })) });
  assert.equal(selected.draft.ownerCapability, other.draft.ownerCapability); assert.equal(selected.navigation[0][2], '/teacher');
});

test('pending creation locks the draft until a delayed expiry or success has settled', async () => {
  let finish, attempts = 0;
  const expired = () => response({ error: { code: 'EXPIRED', message: '班級已到期。' } }, false);
  const e = boot({ fetch: async () => !attempts++ ? expired() : new Promise(resolve => { finish = resolve; }) });
  await e.click('create');
  const requestId = e.draft.requestId;
  const retry = e.click('create');
  e.click('new-class');
  e.click('create');
  assert.equal(e.draft.requestId, requestId, 'a pending retry must retain its draft');
  assert.equal(e.calls.length, 2);
  assert.equal(e.nodes.get('create').disabled, true); assert.equal(e.nodes.get('new-class').disabled, true);
  finish(expired()); await retry;
  assert.equal(e.nodes.get('create').disabled, false); assert.equal(e.nodes.get('new-class').disabled, false);
  e.click('new-class');
  const nextId = e.draft.requestId;
  assert.notEqual(nextId, requestId);
  const creating = e.click('create');
  e.click('new-class');
  e.click('create');
  assert.equal(e.draft.requestId, nextId); assert.equal(e.calls.length, 3);
  assert.equal(e.nodes.get('new-class').disabled, true);
  finish(response(room)); await creating;
  assert.equal(e.draft.requestId, nextId); assert.equal(e.draft.room.code, room.code);
  assert.equal(JSON.parse(e.calls[2].options.body).requestId, nextId);
  assert.equal(e.nodes.get('create').disabled, true); assert.equal(e.nodes.get('new-class').disabled, false);
  e.click('new-class');
  assert.notEqual(e.draft.requestId, nextId); assert.equal(e.draft.room, undefined);
});

test('a late teacher board response does not populate a newly selected class', async () => {
  let finish;
  const e = boot({ fetch: async url => url.endsWith('/teacher-board') ? new Promise(resolve => { finish = resolve; }) : response(room) });
  await e.click('create');
  const waiting = e.click('refresh');
  e.click('new-class');
  finish(response({ rows: [{ rank: 1, alias: '舊班', mistakes: 0, elapsedMs: 1000 }] }));
  await waiting;
  assert.equal(e.nodes.get('board').children.length, 0); assert.equal(e.nodes.get('room').hidden, true);
});

test('standalone service export builds with exact shared content and scorer copies', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'bishun-service-export-'));
  const service = path.join(fixture, 'service');
  try {
    fs.cpSync(root, service, { recursive: true, filter: file => !['node_modules', '.wrangler', 'dist', 'shared'].includes(path.basename(file)) });
    fs.mkdirSync(path.join(service, 'shared'));
    for (const file of ['quiz-results.js', 'content.js', 'assessment.js', 'freehand.js', 'assessment-review.js', 'assessment.css', 'character-data.js']) fs.copyFileSync(path.join(__dirname, '../dist', file), path.join(service, 'shared', file));
    fs.mkdirSync(path.join(service, 'shared/data'), { recursive: true });
    fs.copyFileSync(path.join(__dirname, '../dist/data/characters.js'), path.join(service, 'shared/data/characters.js'));
    fs.mkdirSync(path.join(service, 'drizzle'), { recursive: true });
    fs.copyFileSync(path.join(__dirname, '../classroom-service/drizzle/0002_automatic_submissions.sql'), path.join(service, 'drizzle/0002_automatic_submissions.sql'));
    const parentDist = path.join(fixture, 'dist');
    fs.mkdirSync(parentDist);
    fs.writeFileSync(path.join(parentDist, 'quiz-results.js'), 'invalid sibling scorer');
    fs.writeFileSync(path.join(parentDist, 'teacher.html'), 'parent teacher stays unchanged');
    execFileSync(process.execPath, [path.join(service, 'build.mjs')]);
    assert.equal(fs.readFileSync(path.join(parentDist, 'teacher.html'), 'utf8'), 'parent teacher stays unchanged');
    assert.deepEqual(fs.readdirSync(parentDist).sort(), ['quiz-results.js', 'teacher.html']);
    assert.equal(fs.readFileSync(path.join(service, 'dist/server/index.js'), 'utf8'), fs.readFileSync(path.join(root, 'dist/server/index.js'), 'utf8'));
  } finally {
    assert.equal(path.dirname(path.resolve(fixture)), path.resolve(os.tmpdir()));
    assert(path.basename(fixture).startsWith('bishun-service-export-'));
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test('owner sees automatic completion time and a readonly original action without a grading requirement',async()=>{
  const reviewedRoom={...room,assignment:{...room.assignment,version:2,mode:'copy'}};
  const e=boot({fetch:async url=>response(url.endsWith('/reviews')?{members:[{alias:'小星',memberId:'one',runId:null,automaticRunId:'locked',automaticElapsedMs:1200}],published:false,rows:[]}:reviewedRoom)});
  await e.click('create');await e.click('refresh');
  const texts=node=>[node.textContent,...node.children.flatMap(texts)].join(' '),members=texts(e.nodes.get('members'));
  assert.match(members,/已完成 · 1.2 秒/);assert.match(members,/查看筆順小挑戰原卷/);assert(!members.includes('查看／批改原卷'));assert(!members.includes('待批改'));
  assert.equal(e.nodes.get('publish').hidden,true);assert(!texts(e.nodes.get('board')).includes('請先完成'));assert.match(texts(e.nodes.get('board')),/1.2 秒/);
});
