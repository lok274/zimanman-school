import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import './src/quiz-results.js';
import A from './src/assessment.js';
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
const reviewed = await call('', 'POST', { entries: [{ text: '鬍鬚', selectedIndexes: [0, 1] }], version: 2, mode: 'listen', requestId: randomUUID() }, teacher);
assert.equal(reviewed.status, 200); const reviewedCode = reviewed.data.code;
const reviewers = [];
for (const alias of ['原稿甲', '原稿乙']) {
  const token = randomBytes(32).toString('hex');
  const member = await call('/' + reviewedCode + '/members', 'POST', { alias, requestId: randomUUID(), memberToken: token });
  assert.equal(member.status, 200); reviewers.push({ token, memberId: member.data.memberId });
}
const run = A.start(reviewed.data.assignment, randomUUID()); run.phase = 'sealed'; run.elapsedMs = 9000;
run.answers.forEach((answer, index) => { answer.status = index ? 'skipped' : 'submitted'; answer.strokes = [[[10, 100, 0], [9900, 9800, 100]]]; });
const submitted = A.validateSubmission(reviewed.data.assignment, run);
const put = (student, value) => call('/' + reviewedCode + '/answers', 'PUT', value, auth(student));
const concurrent = await Promise.all([put(reviewers[0], submitted), put(reviewers[0], submitted)]);
assert.equal(concurrent[0].status, 200); assert.deepEqual(concurrent[0].data, concurrent[1].data);
assert.equal((await put(reviewers[0], { ...submitted, runId: randomUUID() })).status, 409);
assert.equal((await call('/' + reviewedCode + '/answers', 'GET', undefined, auth(reviewers[1]))).data.answer, null);
await put(reviewers[1], { ...submitted, runId: randomUUID(), elapsedMs: 1 });
const own = await call('/' + reviewedCode + '/answers', 'GET', undefined, auth(reviewers[0]));
assert.deepEqual(own.data.answer.run.answers, submitted.answers); assert(!Object.hasOwn(own.data.answer.run, 'elapsedMs'));
assert.equal((await call('/' + reviewedCode + '/reviews', 'GET', undefined, auth(reviewers[0]))).status, 401);
const marks = A.unmarked(reviewed.data.assignment).map(mark => ({ ...mark, correct: true, strokePractice: true }));
for (const student of reviewers) assert.equal((await call('/' + reviewedCode + '/reviews/' + student.memberId, 'PUT', { revision: 0, marks }, teacher)).status, 200);
assert.equal((await call('/' + reviewedCode + '/board', 'GET', undefined, auth(reviewers[0]))).data.published, false);
await call('/' + reviewedCode + '/publication', 'POST', undefined, teacher);
let reviewedBoard = (await call('/' + reviewedCode + '/board', 'GET', undefined, auth(reviewers[0]))).data;
assert.deepEqual(reviewedBoard.rows.map(row => row.rank), [1, 1]);
assert(reviewedBoard.rows.every(row => Object.keys(row).sort().join() === 'alias,rank,score'));
marks[1].correct = false;
assert.equal((await call('/' + reviewedCode + '/reviews/' + reviewers[0].memberId, 'PUT', { revision: 1, marks }, teacher)).status, 200);
assert.equal((await call('/' + reviewedCode + '/reviews/' + reviewers[0].memberId, 'PUT', { revision: 1, marks }, teacher)).status, 409);
reviewedBoard = (await call('/' + reviewedCode + '/board', 'GET', undefined, auth(reviewers[0]))).data;
assert.deepEqual(reviewedBoard.rows.map(row => row.score), [2, 1]);
assert.equal((await call('/' + reviewedCode, 'DELETE', undefined, teacher)).status, 200);
assert.equal((await call('/' + reviewedCode + '/answers', 'GET', undefined, auth(reviewers[0]))).status, 404);
console.log(JSON.stringify({ checks: 'Real local Worker/D1 reviewed originals: immutable concurrent submission, private originals, skipped ink, teacher revisions, explicit publication, score-only ties, live regrading and owner deletion', passed: true }));
const fullEntries = ['粗', '濃', '鬍鬚', '密', '剪草機', '推來推去'].map(text => ({ text, selectedIndexes: Array.from(text, (_, i) => i) }));
const fullRoom = await call('', 'POST', { entries: fullEntries, version: 2, mode: 'copy', requestId: randomUUID() }, teacher);
assert.equal(fullRoom.status, 200);
const fullToken = randomBytes(32).toString('hex');
await call('/' + fullRoom.data.code + '/members', 'POST', { alias: '容量驗證', requestId: randomUUID(), memberToken: fullToken });
const full = A.start(fullRoom.data.assignment, randomUUID()), counts = [11, 16, 19, 22, 11, 11, 10, 16, 11, 8, 11, 5]; full.phase = 'sealed';
full.answers.forEach((answer, i) => { answer.status = 'submitted'; answer.strokes = Array.from({ length: counts[i] }, () => Array.from({ length: 512 }, (_, j) => [j * 19, 9999 - j * 19, j * 10])); });
const fullSubmission = A.validateSubmission(fullRoom.data.assignment, full), fullBytes = Buffer.byteLength(JSON.stringify(fullSubmission));
assert.equal((await call('/' + fullRoom.data.code + '/answers', 'PUT', fullSubmission, { authorization: 'Bearer ' + fullToken })).status, 200);
const retrieved = (await call('/' + fullRoom.data.code + '/answers', 'GET', undefined, { authorization: 'Bearer ' + fullToken })).data.answer;
assert.deepEqual(retrieved.run.answers, fullSubmission.answers);
assert.equal((await call('/' + fullRoom.data.code, 'DELETE', undefined, teacher)).status, 200);
console.log(JSON.stringify({ checks: 'Real local Worker/D1 whole 12-position 151-stroke, 512-samples-per-stroke JSON round trip', fullBytes, points: 151 * 512, passed: true }));
