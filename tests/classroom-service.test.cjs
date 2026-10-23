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
