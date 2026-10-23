import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
const origin = process.argv[2] || 'http://127.0.0.1:8788';
assert(['127.0.0.1', 'localhost'].includes(new URL(origin).hostname), 'smoke test is local only');
const teacher = { origin, 'x-teacher-capability': randomBytes(32).toString('hex') };
async function call(path, method = 'GET', data, headers = {}) {
  const response = await fetch(origin + '/api/v1/classes' + path, { method, headers: { ...headers, ...(data ? { 'Content-Type': 'application/json' } : {}) }, ...(data ? { body: JSON.stringify(data) } : {}) });
  return { status: response.status, data: await response.json() };
}
const entries = [{ text: '一', selectedIndexes: [0] }];
assert.equal((await fetch(origin + '/')).status, 200);
assert.equal((await call('', 'POST', { entries, requestId: randomUUID() }, { origin })).status, 401);
const room = await call('', 'POST', { entries, requestId: randomUUID() }, teacher); assert.equal(room.status, 200);
const code = room.data.code;
assert.equal((await call('/' + code + '/teacher-board', 'GET', undefined, { 'x-teacher-capability': randomBytes(32).toString('hex') })).status, 403);
assert.equal((await call('/' + code + '/board', 'GET', undefined, teacher)).status, 401);
const students = [];
for (const alias of ['甲', '乙']) {
  const token = randomBytes(32).toString('hex'), request = { alias, requestId: randomUUID(), memberToken: token };
  const [a, b] = await Promise.all([call('/' + code + '/members', 'POST', request), call('/' + code + '/members', 'POST', request)]);
  assert.equal(a.status, 200); assert.deepEqual(a.data, b.data); students.push({ token, memberId: a.data.memberId });
}
const auth = student => ({ authorization: 'Bearer ' + student.token });
assert.equal((await call('/' + code + '/board', 'GET', undefined, auth(students[0]))).status, 403);
for (const student of students) {
  const runId = randomUUID(), evidence = { runId, attempts: [{ id: randomUUID(), occurrenceId: 'w0:0', phase: 'quiz', outcome: 'complete', mistakes: 1, elapsedMs: 1234.56, help: [] }] };
  const [a, b] = await Promise.all([call('/' + code + '/runs/' + runId, 'PUT', evidence, auth(student)), call('/' + code + '/runs/' + runId, 'PUT', evidence, auth(student))]);
  assert.equal(a.status, 200); assert.deepEqual(a.data, b.data);
  evidence.attempts[0].mistakes = 2; assert.equal((await call('/' + code + '/runs/' + runId, 'PUT', evidence, auth(student))).status, 409);
}
const board = await call('/' + code + '/board', 'GET', undefined, auth(students[0]));
assert.equal(board.status, 200); assert.deepEqual(board.data.rows.map(row => row.rank), [1, 1]); assert.equal(board.data.personalBest.elapsedMs, 1200);
assert.equal((await call('/' + code + '/teacher-board', 'GET', undefined, teacher)).data.rows.length, 2);
console.log(JSON.stringify({ code, checks: 'Real local Worker/D1: anonymous browser-owned creation, owner denial, two memberships, concurrent idempotency, pre-finish board denial, changed-payload conflicts, shared tied best results', passed: true }));
