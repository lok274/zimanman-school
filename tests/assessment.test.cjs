'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
globalThis.BishunQuizResults = require('../dist/quiz-results.js');
const A = require('../dist/assessment.js');
const assigned = A.assignment([{ text: '推來推去', selectedIndexes: [0, 2] }], 'listen');
function completed() {
  let run = A.start(assigned, 'one');
  for (let i = 0; i < 2; i++) {
    run = A.transition(run, { type: 'STROKE', stroke: [[30, 40, 0], [9999, 10000, 20]] });
    run = A.transition(run, { type: 'ANSWER', status: i ? 'skipped' : 'submitted' });
  }
  return A.transition(run, { type: 'SEAL', elapsedMs: 3400 });
}
test('freehand originals preserve every point and skipped ink, with no recognizer success event', () => {
  const run = completed();
  assert.deepEqual(run.answers[0].strokes, run.answers[1].strokes);
  assert.equal(run.answers[1].status, 'skipped');
  assert.throws(() => A.transition(run, { type: 'UNDO' }), /封存/);
  assert.throws(() => A.transition(A.start(assigned, 'two'), { type: 'STROKE_ACCEPTED' }), /無效/);
  assert.equal(A.review(assigned, A.unmarked(assigned)).score, null);
  assert.equal(A.review(assigned, A.unmarked(assigned).map(mark => ({ ...mark, correct: true, strokePractice: true }))).score, 2);
});
test('submission checks exact assignment, terminal coverage, bounds and finite monotonic points', () => {
  assert.throws(() => A.validateSubmission({ ...assigned, mode: 'copy' }, completed()));
  for (const point of [[NaN, 0, 0], [0, Infinity, 0], [-1, 0, 0], [0, 0, -1], [0, 0, 86400001], [10001, 0, 0]]) {
    const run = completed(); run.answers[0].strokes = [[point]];
    assert.throws(() => A.validateSubmission(assigned, run));
  }
  const run = completed(); run.answers[0].strokes = [[[1, 1, 2], [1, 1, 1]]];
  assert.throws(() => A.validateSubmission(assigned, run));
  run.answers[0].strokes = Array.from({ length: 257 }, () => [[1, 1, 0]]);
  assert.throws(() => A.validateSubmission(assigned, run), /256/);
  run.answers[0].strokes = [Array.from({ length: 200001 }, () => [1, 1, 0])];
  assert.throws(() => A.validateSubmission(assigned, run), /容量/);
});
test('teacher shape scores alone determine tied ranks; missing marks stay pending', () => {
  assert.deepEqual(A.ranks([{ alias: 'a', score: 2, elapsedMs: 90000 }, { alias: 'b', score: 2, elapsedMs: 1 }, { alias: 'c', score: null }, { alias: 'd', score: 0 }]).map(row => row.rank), [1, 1, 3]);
  const marks = A.unmarked(assigned); marks[0].correct = true;
  assert.equal(A.review(assigned, marks).score, null);
  marks[1].correct = false; assert.equal(A.review(assigned, marks).score, 1);
});
test('aggregate capacity is checked before the current answer becomes immutable', () => {
  for (const [samples, point] of [[100001, [1, 1, 0]], [60000, [10000, 10000, 86400000]]]) {
    let run = A.start(assigned, 'aggregate');
    const stroke = Array.from({ length: samples }, () => [...point]);
    run = A.transition(run, { type: 'STROKE', stroke });
    run = A.transition(run, { type: 'ANSWER', status: 'submitted' });
    run = A.transition(run, { type: 'STROKE', stroke });
    assert.throws(() => A.transition(run, { type: 'ANSWER', status: 'submitted' }), /容量/);
    assert.equal(run.answers[1].status, 'draft'); assert.equal(run.answers[1].strokes[0].length, samples);
    run = A.transition(run, { type: 'UNDO' });
    run = A.transition(run, { type: 'ANSWER', status: 'skipped' });
    assert.equal(A.transition(run, { type: 'SEAL', elapsedMs: 1 }).phase, 'sealed');
  }
});
test('the full 12-position 151-stroke fixture with 512 samples retains original points', () => {
  require('../dist/content.js');
  const assignment = A.assignment(BishunContent.words.map(text => ({ text, selectedIndexes: Array.from(text, (_, i) => i) })), 'copy');
  const counts = [11, 16, 19, 22, 11, 11, 10, 16, 11, 8, 11, 5];
  const run = A.start(assignment, 'full'); run.phase = 'sealed';
  run.answers.forEach((answer, i) => { answer.status = 'submitted'; answer.strokes = Array.from({ length: counts[i] }, () => Array.from({ length: 512 }, (_, j) => [j * 19, 9999 - j * 19, j * 10])); });
  const valid = A.validateSubmission(assignment, run);
  assert.equal(valid.answers.flatMap(a => a.strokes).length, 151);
  assert.equal(valid.answers.flatMap(a => a.strokes).flat().length, 77312);
  assert.deepEqual(valid.answers, run.answers);
  assert(Buffer.byteLength(JSON.stringify(valid)) > 262144);
});
test('ordinary JSON near the supported D1 row budget passes and oversize fails explicitly', () => {
  const run = completed(), point = [10000, 10000, 86400000];
  const samples = Math.floor(A.limits.bytes / (Buffer.byteLength(JSON.stringify(point)) + 1)) - 50;
  run.answers[0].strokes = [Array.from({ length: samples }, () => [...point])];
  const valid = A.validateSubmission(assigned, run), bytes = Buffer.byteLength(JSON.stringify(valid));
  assert(bytes > 1790000 && bytes < 1800000);
  assert(bytes + Buffer.byteLength(JSON.stringify(A.unmarked(assigned))) + 1000 < 2000000);
  run.answers[0].strokes[0].push(...Array.from({ length: 100 }, () => [...point]));
  assert.throws(() => A.validateSubmission(assigned, run), /容量/);
  assert.equal(run.answers[0].strokes[0].length, samples + 100);
});
