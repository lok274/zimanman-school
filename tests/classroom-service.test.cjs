'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { randomBytes, randomUUID } = require('node:crypto');
const root = path.join(__dirname, '../classroom-service');
execFileSync(process.execPath, [path.join(root, 'build.mjs')]);
const worker = import(pathToFileURL(path.join(root, 'dist/server/index.js'))).then(module => module.default);
const entries = [{ text: '推來推去', selectedIndexes: [0, 2] }];
const teacherCapability = 'a'.repeat(64);
const teacherHeaders = { origin: 'https://class.test', 'x-teacher-capability': teacherCapability };
function setup(t) {
  const sqlite = new DatabaseSync(':memory:'); sqlite.exec('PRAGMA foreign_keys = ON;');
  for (const file of fs.readdirSync(path.join(root, 'drizzle')).filter(file => file.endsWith('.sql'))) sqlite.exec(fs.readFileSync(path.join(root, 'drizzle', file), 'utf8'));
  t.after(() => sqlite.close());
  const db = { prepare(sql) { const statement = sqlite.prepare(sql); let args = []; return { bind(...values) { args = values; return this; }, async first() { return statement.get(...args) || null; }, async all() { return { results: statement.all(...args) }; }, async run() { return statement.run(...args); } }; } };
  const call = async (route, method = 'GET', body, headers = {}) => {
    const response = await (await worker).fetch(new Request('https://class.test/api/v1/classes' + route, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) }), { DB: db });
    return { status: response.status, headers: response.headers, data: response.status === 204 ? null : await response.json() };
  };
  const create = (requestId = 'class-one', extra = {}) => call('', 'POST', { requestId, entries }, { ...teacherHeaders, ...extra });
  const join = (code, alias, requestId = randomUUID(), token = randomBytes(32).toString('hex')) => call('/' + code + '/members', 'POST', { alias, requestId, memberToken: token }).then(result => ({ ...result, token }));
  const evidence = (runId = 'run', mistakes = 1, extra = {}) => ({ runId, attempts: [0, 2].map((index, i) => ({ id: 'attempt-' + i, occurrenceId: 'w0:' + index, phase: 'quiz', outcome: 'complete', mistakes, elapsedMs: 1049, help: [], ...extra })) });
  const submit = (code, token, data) => call('/' + code + '/runs/' + data.runId, 'PUT', data, { authorization: 'Bearer ' + token });
  return { sqlite, db, call, create, join, evidence, submit };
}
test('Worker package contains exactly the canonical scorer', () => {
  const source = fs.readFileSync(path.join(__dirname, '../dist/quiz-results.js'), 'utf8');
  assert(fs.readFileSync(path.join(root, 'dist/server/index.js'), 'utf8').includes(source));
  assert.equal(fs.readFileSync(path.join(root, 'src/quiz-results.js'), 'utf8'), source + '\nexport default globalThis.BishunQuizResults;\n');
});
test('browser owner capability, separate teacher board and same-origin creation are enforced', async t => {
  const e = setup(t);
  assert.equal((await e.call('', 'POST', { requestId: 'no', entries }, { origin: 'https://class.test' })).status, 401);
  assert.equal((await e.create('malformed', { 'x-teacher-capability': 'A'.repeat(64) })).status, 401);
  assert.equal((await e.call('', 'POST', { requestId: 'old-identity', entries }, { origin: 'https://class.test', 'oai-authenticated-user-id': 'teacher', 'oai-authenticated-user-email': 'teacher@example.invalid' })).status, 401);
  assert.equal((await e.create('bad', { origin: 'https://lok274.github.io' })).status, 403);
  assert.equal((await e.create('bad2', { origin: 'https://evil.test' })).status, 403);
  const room = await e.create(); assert.equal(room.status, 200);
  const path = '/' + room.data.code;
  assert.equal((await e.call(path + '/teacher-board')).status, 401);
  assert.equal((await e.call(path + '/teacher-board', 'GET', undefined, { 'x-teacher-capability': 'b'.repeat(64) })).status, 403);
  assert.equal((await e.call(path + '/teacher-board', 'GET', undefined, teacherHeaders)).status, 200);
  assert.equal((await e.call(path + '/board', 'GET', undefined, teacherHeaders)).status, 401);
  const member = await e.join(room.data.code, '小星');
  assert.equal((await e.call(path + '/teacher-board', 'GET', undefined, { authorization: 'Bearer ' + member.token })).status, 401);
  const stored = e.sqlite.prepare('SELECT owner_id FROM classes').get().owner_id;
  assert.equal(stored.length, 64); assert.notEqual(stored, teacherCapability);
  const cors = await e.call(path + '/teacher-board', 'OPTIONS', undefined, { origin: 'https://lok274.github.io', 'access-control-request-headers': 'X-Teacher-Capability' });
  assert.equal(cors.headers.get('access-control-allow-origin'), 'https://lok274.github.io');
  assert.equal(cors.headers.get('access-control-allow-headers'), 'Content-Type, Authorization');
  assert.equal(cors.headers.get('cache-control'), 'no-store');
});
test('two members see shared best results only after terminal receipts; retries, ties and conflicts are immutable', async t => {
  const e = setup(t), room = (await e.create()).data, a = await e.join(room.code, '小星'), b = await e.join(room.code, '小月');
  const get = token => e.call('/' + room.code + '/board', 'GET', undefined, { authorization: 'Bearer ' + token });
  assert.equal((await get(a.token)).status, 403);
  const data = e.evidence(); data.attempts.unshift({ ...data.attempts[0], id: 'retry', outcome: 'abandoned', mistakes: 4, elapsedMs: 1051 });
  const [first, repeated] = await Promise.all([e.submit(room.code, a.token, data), e.submit(room.code, a.token, data)]);
  assert.equal(first.status, 200); assert.deepEqual(first.data, repeated.data); assert.deepEqual(first.data.score, { mistakes: 6, elapsedMs: 3100 });
  assert.equal((await e.submit(room.code, a.token, { ...data, attempts: data.attempts.slice(1) })).status, 409);
  await e.submit(room.code, b.token, e.evidence('b-best', 0));
  await e.submit(room.code, a.token, e.evidence('a-best', 0));
  let board = (await get(a.token)).data; assert.deepEqual(board.rows.map(row => row.rank), [1, 1]); assert.equal(board.personalBest.mistakes, 0); assert.equal(board.personalBest.elapsedMs, 2100);
  assert.equal(e.sqlite.prepare('SELECT COUNT(*) AS n FROM runs').get().n, 3);
  assert(!JSON.stringify(e.sqlite.prepare('SELECT * FROM members').all()).includes(a.token));
  const skipped = await e.join(room.code, '小雨'); assert.equal((await e.submit(room.code, skipped.token, e.evidence('skip', 0, { outcome: 'skipped' }))).data.ranked, false);
  assert.equal((await get(skipped.token)).data.rows.length, 2);
  const incomplete = e.evidence('short'); incomplete.attempts.pop(); assert.equal((await e.submit(room.code, skipped.token, incomplete)).status, 422);
});
test('join retries retain capability and aliases refuse takeover under concurrent requests', async t => {
  const e = setup(t), code = (await e.create()).data.code, token = randomBytes(32).toString('hex');
  const [a, b] = await Promise.all([e.join(code, '小星', 'same', token), e.join(code, '小星', 'same', token)]);
  assert.equal(a.status, 200); assert.equal(b.status, 200); assert.equal(a.data.memberId, b.data.memberId);
  assert.equal((await e.join(code, '小星', 'other')).data.error.code, 'ALIAS_TAKEN');
  assert.equal((await e.join(code, '小月', 'same')).data.error.code, 'CONFLICT');
  assert.equal(e.sqlite.prepare('SELECT COUNT(*) AS n FROM members').get().n, 1);
});
test('atomic class, member and run quotas hold at their concurrent boundaries', async t => {
  const e = setup(t);
  for (let i = 0; i < 9; i++) assert.equal((await e.create('class-' + i)).status, 200);
  const classes = await Promise.all([e.create('last-a'), e.create('last-b')]); assert.deepEqual(classes.map(x => x.status).sort(), [200, 429]);
  assert.equal((await e.create('class-0')).status, 200);
  assert.equal((await e.call('', 'POST', { requestId: 'class-0', entries: [{ text: '一', selectedIndexes: [0] }] }, teacherHeaders)).status, 409);
  const code = classes.find(x => x.status === 200).data.code;
  for (let i = 0; i < 99; i++) await e.join(code, 'user-' + i);
  const members = await Promise.all([e.join(code, 'last-a'), e.join(code, 'last-b')]); assert.deepEqual(members.map(x => x.status).sort(), [200, 429]);
  const token = members.find(x => x.status === 200).token;
  for (let i = 0; i < 19; i++) await e.submit(code, token, e.evidence('run-' + i));
  const runs = await Promise.all([e.submit(code, token, e.evidence('last-a')), e.submit(code, token, e.evidence('last-b'))]); assert.deepEqual(runs.map(x => x.status).sort(), [200, 429]);
});

test('global creation cap is atomic across owners and retries precede full-capacity rejection', async t => {
  const e = setup(t);
  let first;
  for (let owner = 0; owner < 10; owner++) {
    for (let i = 0; i < (owner === 9 ? 9 : 10); i++) {
      const result = await e.create('class-' + owner + '-' + i, { 'x-teacher-capability': owner.toString(16).repeat(64) });
      assert.equal(result.status, 200); first ||= result.data;
    }
  }
  const results = await Promise.all([e.create('final-a', { 'x-teacher-capability': 'c'.repeat(64) }), e.create('final-b', { 'x-teacher-capability': 'd'.repeat(64) })]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 429]);
  assert.equal(results.find(result => result.status === 429).data.error.code, 'SERVICE_LIMIT');
  assert.equal(e.sqlite.prepare('SELECT COUNT(*) AS n FROM classes').get().n, 100);
  assert.deepEqual((await e.create('class-0-0', { 'x-teacher-capability': '0'.repeat(64) })).data, first);
  e.sqlite.prepare('UPDATE classes SET expires_at = 0 WHERE code = ?').run(first.code);
  assert.equal((await e.create('class-0-0', { 'x-teacher-capability': '0'.repeat(64) })).status, 410);
  assert.equal((await e.create('replacement', { 'x-teacher-capability': 'e'.repeat(64) })).status, 200);
});
test('expiry immediately denies reads and writes; later class creation cleans expired data with cascade', async t => {
  const e = setup(t), code = (await e.create()).data.code, member = await e.join(code, '小星');
  await e.submit(code, member.token, e.evidence());
  e.sqlite.prepare('UPDATE classes SET expires_at = 0 WHERE code = ?').run(code);
  assert.equal((await e.call('/' + code + '/board', 'GET', undefined, { authorization: 'Bearer ' + member.token })).status, 410);
  assert.equal((await e.join(code, '晚到')).status, 410);
  await e.create('next');
  assert.equal(e.sqlite.prepare('SELECT COUNT(*) AS n FROM members').get().n, 0); assert.equal(e.sqlite.prepare('SELECT COUNT(*) AS n FROM runs').get().n, 0);
});

globalThis.BishunQuizResults = require('../dist/quiz-results.js');
const A = require('../dist/assessment.js');
async function reviewed(t) {
  const e = setup(t);
  e.room = (await e.call('', 'POST', { requestId: 'reviewed', version: 2, mode: 'listen', entries }, teacherHeaders)).data;
  e.member = await e.join(e.room.code, '小星');
  e.run = A.start(e.room.assignment, 'official'); e.run.phase = 'sealed'; e.run.elapsedMs = 13000;
  e.run.answers.forEach((answer, i) => { answer.status = i ? 'skipped' : 'submitted'; answer.strokes = [[[120, 340, 0], [200, 9900, 20]]]; });
  e.run = A.validateSubmission(e.room.assignment, e.run);
  e.own = { authorization: 'Bearer ' + e.member.token };
  e.put = (run = e.run, headers = e.own) => e.call('/' + e.room.code + '/answers', 'PUT', run, headers);
  return e;
}
test('reviewed originals are private, first-only, atomic and exactly idempotent', async t => {
  const e = await reviewed(t), path = '/' + e.room.code;
  const [a, b] = await Promise.all([e.put(), e.put()]);
  assert.equal(a.status, 200); assert.deepEqual(a.data, b.data);
  assert.equal((await e.put({ ...e.run, elapsedMs: 10 })).status, 409);
  assert.equal((await e.put({ ...e.run, runId: 'later' })).data.error.code, 'FIRST_SUBMISSION');
  assert.equal(e.sqlite.prepare('SELECT COUNT(*) AS n FROM reviewed_submissions').get().n, 1);
  assert.equal((await e.call(path + '/answers')).status, 401);
  const other = await e.join(e.room.code, '小月');
  assert.equal((await e.call(path + '/answers', 'GET', undefined, { authorization: 'Bearer ' + other.token })).data.answer, null);
  const own = (await e.call(path + '/answers', 'GET', undefined, e.own)).data.answer;
  assert.deepEqual(own.run.answers, e.run.answers); assert.equal(own.score, null);
  assert(!Object.hasOwn(own.run, 'elapsedMs')); assert(!Object.hasOwn(own.run, 'startedAt'));
  assert.equal((await e.call(path + '/reviews', 'GET', undefined, e.own)).status, 401);
  assert.equal((await e.call(path + '/reviews', 'GET', undefined, { ...teacherHeaders, origin: 'https://lok274.github.io' })).status, 403);
  assert.equal((await e.call(path + '/reviews', 'GET', undefined, { 'x-teacher-capability': teacherCapability, 'sec-fetch-site': 'same-origin' })).status, 200);
  const teacher = (await e.call(path + '/reviews/' + e.member.data.memberId, 'GET', undefined, teacherHeaders)).data;
  assert.deepEqual(teacher.run, e.run); assert.equal(teacher.elapsedMs, 13000);
  const raceMember = await e.join(e.room.code, '小雨'), headers = { authorization: 'Bearer ' + raceMember.token };
  const race = await Promise.all([e.put({ ...e.run, runId: 'first-a' }, headers), e.put({ ...e.run, runId: 'first-b' }, headers)]);
  assert.deepEqual(race.map(row => row.status).sort(), [200, 409]);
});
test('review revisions, explicit publication and tied shape ranks never use timing', async t => {
  const e = await reviewed(t), path = '/' + e.room.code;
  await e.put(); const other = await e.join(e.room.code, '小月');
  await e.put({ ...e.run, runId: 'other', elapsedMs: 1 }, { authorization: 'Bearer ' + other.token });
  const get = () => e.call(path + '/board', 'GET', undefined, e.own);
  const mark = (member, revision, marks, headers = teacherHeaders) => e.call(path + '/reviews/' + member.data.memberId, 'PUT', { revision, marks }, headers);
  const marks = A.unmarked(e.room.assignment); marks[0].correct = true;
  assert.equal((await mark(e.member, 0, marks, e.own)).status, 401);
  assert.equal((await mark(e.member, 0, marks)).data.score, null);
  assert.deepEqual((await get()).data.rows, []); assert.equal((await get()).data.published, false);
  marks[1].correct = false; marks[0].strokePractice = true;
  assert.equal((await mark(e.member, 1, marks)).data.score, 1);
  assert.equal((await mark(e.member, 1, marks)).status, 409);
  await mark(other, 0, marks);
  assert.deepEqual((await get()).data.rows, []);
  assert.equal((await e.call(path + '/publication', 'POST', {}, e.own)).status, 401);
  await e.call(path + '/publication', 'POST', {}, teacherHeaders);
  let board = (await get()).data;
  assert.deepEqual(board.rows.map(row => row.rank), [1, 1]);
  assert(board.rows.every(row => Object.keys(row).sort().join() === 'alias,mode,rank,score' && row.mode === 'listen'));
  marks[1].correct = true; await mark(e.member, 2, marks);
  board = (await get()).data;
  assert.equal(board.rows[0].alias, '小星'); assert.equal(board.rows[0].score, 2);
  assert.equal(board.rows[1].rank, 2);
  assert.deepEqual(JSON.parse(e.sqlite.prepare('SELECT ink_json FROM reviewed_submissions WHERE member_id = ?').get(e.member.data.memberId).ink_json), e.run);
});

function wordOriginal(assignment, id, elapsedMs) {
  let run = A.startWords(assignment, id, 1);
  run = A.transition(run, { type: 'START_WORD' }); run = A.transition(run, { type: 'HINT' }); run = A.transition(run, { type: 'TIME', elapsedMs });
  for (let index = 0; index < run.answers.length; index++) {
    run = A.transition(run, { type: 'STROKE', stroke: [[100, 200, 0], [9000, 8000, 30]] });
    run = A.transition(run, { type: index + 1 === run.answers.length ? 'SUBMIT_WORD' : 'NEXT_CHARACTER' });
  }
  return A.transition(run, { type: 'SEAL' });
}

test('v3 word time, actual presentation mode and hint survive round trip while legacy listen and new copy scores rank separately', async t => {
  const e = await reviewed(t), path = '/' + e.room.code; await e.put();
  const second = await e.join(e.room.code, '小月'), third = await e.join(e.room.code, '小雨');
  const run = wordOriginal(e.room.assignment, 'word-original', 7500), own = { authorization: 'Bearer ' + second.token };
  assert.equal(run.assignment.mode, 'listen'); assert.equal(A.actualMode(run), 'copy');
  const receipt = await e.put(run, own); assert.equal(receipt.status, 200); assert.deepEqual(receipt.data, { runId: run.runId, official: true, version: 3 });
  assert.deepEqual((await e.put(run, own)).data, receipt.data);
  const teacher = (await e.call(path + '/reviews/' + second.data.memberId, 'GET', undefined, teacherHeaders)).data;
  assert.deepEqual(teacher.run, run); assert.equal(teacher.elapsedMs, 7500);
  const pupil = (await e.call(path + '/answers', 'GET', undefined, own)).data.answer;
  assert.deepEqual(pupil.run.wordProgress, run.wordProgress); assert.equal(pupil.run.answers[0].hintUsed, true); assert.equal(pupil.run.presentationMode, 'copy');
  assert(!Object.hasOwn(pupil.run, 'elapsedMs')); assert(!Object.hasOwn(pupil.run, 'startedAt'));
  const changed = structuredClone(run); changed.answers[0].hintUsed = false; assert.equal((await e.put(changed, own)).status, 409);
  const invalid = structuredClone(run); invalid.presentationMode = 'listen'; assert.equal((await e.put(invalid, { authorization: 'Bearer ' + third.token })).status, 400);
  await e.put(wordOriginal(e.room.assignment, 'third', 1), { authorization: 'Bearer ' + third.token });
  for (const [member, score] of [[e.member, 2], [second, 1], [third, 1]]) {
    const marks = A.unmarked(e.room.assignment); marks.forEach((mark, index) => { mark.correct = index < score; });
    await e.call(path + '/reviews/' + member.data.memberId, 'PUT', { revision: 0, marks }, teacherHeaders);
  }
  await e.call(path + '/publication', 'POST', {}, teacherHeaders);
  const board = (await e.call(path + '/board', 'GET', undefined, own)).data;
  assert.deepEqual(board.rows.filter(row => row.mode === 'copy').map(row => row.rank), [1, 1]);
  assert.deepEqual(board.rows.filter(row => row.mode === 'listen').map(row => row.rank), [1]);
  assert(board.rows.every(row => Object.keys(row).sort().join() === 'alias,mode,rank,score'));
  assert.deepEqual((await e.call(path + '/reviews', 'GET', undefined, teacherHeaders)).data.rows, board.rows);
});
test('reviewed payload validation and checked quotas leave no partial original', async t => {
  const e = await reviewed(t);
  const bad = structuredClone(e.run); bad.answers[0].strokes[0][0][0] = -1;
  assert.equal((await e.put(bad)).status, 400);
  bad.answers[0].strokes = Array.from({ length: 257 }, () => [[1, 1, 0]]);
  assert.equal((await e.put(bad)).status, 400);
  const huge = { ...e.run, padding: 'x'.repeat(4194304) };
  assert.equal((await e.put(huge)).status, 413);
  assert.equal(e.sqlite.prepare('SELECT COUNT(*) AS n FROM reviewed_submissions').get().n, 0);
  await e.put(); e.sqlite.prepare('UPDATE reviewed_submissions SET ink_bytes = 67108864').run();
  const other = await e.join(e.room.code, '小月');
  const result = await e.put(e.run, { authorization: 'Bearer ' + other.token });
  assert.equal(result.status, 507); assert.equal(result.data.error.code, 'INK_CAPACITY');
  assert.equal(e.sqlite.prepare('SELECT COUNT(*) AS n FROM reviewed_submissions').get().n, 1);
  assert.equal((await e.put()).status, 200, 'exact retries work even when quota is full');
});
test('initial publication atomically requires a submission and complete marks on every submitted original', async t => {
  const e = await reviewed(t), path = '/' + e.room.code;
  const publish = () => e.call(path + '/publication', 'POST', {}, teacherHeaders);
  assert.equal((await publish()).data.error.code, 'MARKING_PENDING');
  await e.put(); assert.equal((await publish()).status, 409);
  const marks = A.unmarked(e.room.assignment).map(mark => ({ ...mark, correct: true }));
  await e.call(path + '/reviews/' + e.member.data.memberId, 'PUT', { revision: 0, marks }, teacherHeaders);
  const other = await e.join(e.room.code, 'late');
  const prepare = e.db.prepare; let injected = false;
  e.db.prepare = sql => {
    const statement = prepare(sql);
    if (!sql.startsWith('INSERT OR IGNORE INTO publications')) return statement;
    const run = statement.run;
    statement.run = async () => {
      if (!injected) { injected = true; await e.put(e.run, { authorization: 'Bearer ' + other.token }); }
      return run();
    };
    return statement;
  };
  assert.equal((await publish()).status, 409, 'a submission arriving immediately before the insert still blocks publication');
  assert.equal(e.sqlite.prepare('SELECT COUNT(*) AS n FROM publications').get().n, 0);
  await e.call(path + '/reviews/' + other.data.memberId, 'PUT', { revision: 0, marks }, teacherHeaders);
  assert.equal((await publish()).data.published, true);
  marks[0].correct = null;
  await e.call(path + '/reviews/' + other.data.memberId, 'PUT', { revision: 1, marks }, teacherHeaders);
  assert.equal((await publish()).data.published, true, 'an already published board remains live after a regrade');
  assert.equal((await publish()).data.rows.length, 1);
});
test('expiry, bounded maintenance and owner deletion cascade original ink and reviews', async t => {
  const e = await reviewed(t), path = '/' + e.room.code; await e.put();
  await e.call(path + '/publication', 'POST', {}, teacherHeaders);
  assert.equal((await e.call('/cleanup', 'POST', { cutoff: Number.MAX_SAFE_INTEGER, code: e.room.code })).status, 200);
  assert.equal(e.sqlite.prepare('SELECT COUNT(*) AS n FROM reviewed_submissions').get().n, 1);
  assert.equal((await e.call(path, 'DELETE', undefined, e.own)).status, 401);
  assert.equal((await e.call(path, 'DELETE', undefined, teacherHeaders)).status, 200);
  assert.equal(e.sqlite.prepare('SELECT COUNT(*) AS n FROM reviewed_submissions').get().n, 0);
  assert.equal(e.sqlite.prepare('SELECT COUNT(*) AS n FROM publications').get().n, 0);
  assert.equal((await e.call(path + '/answers', 'GET', undefined, e.own)).status, 404);
  const next = await reviewed(t); await next.put(); next.sqlite.prepare('UPDATE classes SET expires_at = 0').run();
  for (const suffix of ['/answers', '/reviews', '/board']) assert.equal((await next.call('/' + next.room.code + suffix, 'GET', undefined, suffix === '/reviews' ? teacherHeaders : next.own)).status, 410);
  assert.equal((await next.put()).status, 410);
  await next.call('/cleanup', 'POST');
  assert.equal(next.sqlite.prepare('SELECT COUNT(*) AS n FROM reviewed_submissions').get().n, 0);
});
test('simultaneous byte quota checks are atomic per class and across classes', async t => {
  for (const global of [false, true]) {
    const e = await reviewed(t); await e.put();
    const bytes = Buffer.byteLength(JSON.stringify(e.run));
    let room = e.room;
    if (global) room = (await e.call('', 'POST', { requestId: 'another', version: 2, mode: 'listen', entries }, { ...teacherHeaders, 'x-teacher-capability': 'b'.repeat(64) })).data;
    e.sqlite.prepare('UPDATE reviewed_submissions SET ink_bytes = ?').run((global ? 268435456 : 67108864) - bytes);
    const a = await e.join(room.code, 'a'), b = await e.join(room.code, 'b');
    const put = member => e.call('/' + room.code + '/answers', 'PUT', e.run, { authorization: 'Bearer ' + member.token });
    const results = await Promise.all([put(a), put(b)]);
    assert.deepEqual(results.map(result => result.status).sort(), [200, 507]);
    assert.equal(e.sqlite.prepare('SELECT COUNT(*) AS n FROM reviewed_submissions').get().n, 2);
  }
});
test('maintenance is bounded, ignores caller cutoffs and never exposes an MCP service', async t => {
  const e = setup(t);
  for (let i = 0; i < 11; i++) {
    const room = await e.create('expired-' + i);
    e.sqlite.prepare('UPDATE classes SET expires_at = ? WHERE code = ?').run(Date.now() + 100000, room.data.code);
    if (i === 8) e.sqlite.prepare('UPDATE classes SET owner_id = ?').run('other-owner');
  }
  const live = (await e.create('live')).data;
  e.sqlite.prepare('UPDATE classes SET expires_at = 0 WHERE code != ?').run(live.code);
  const response = await (await worker).fetch(new Request('https://class.test/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) }), { DB: e.db });
  assert.equal(response.status, 404);
  assert.equal(e.sqlite.prepare('SELECT COUNT(*) AS n FROM classes').get().n, 12);
  assert.deepEqual((await e.call('/cleanup', 'POST', { cutoff: Number.MAX_SAFE_INTEGER })).data, { cleaned: true });
  assert.equal(e.sqlite.prepare('SELECT COUNT(*) AS n FROM classes').get().n, 2);
  assert(e.sqlite.prepare('SELECT code FROM classes WHERE code = ?').get(live.code));
  await e.call('/cleanup', 'POST', { cutoff: Number.MAX_SAFE_INTEGER });
  assert.equal(e.sqlite.prepare('SELECT COUNT(*) AS n FROM classes').get().n, 1);
});
