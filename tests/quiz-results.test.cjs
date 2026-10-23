'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Q = require('../dist/quiz-results.js');
const entries = [{ text: '推來推去', selectedIndexes: [0, 2] }];
const attempt = (id, occurrenceId, extra = {}) => ({ id, occurrenceId, phase: 'quiz', outcome: 'complete', mistakes: 0, elapsedMs: 1025.2, help: [], ...extra });
test('whole quiz includes abandoned retries, repeated completed writing and repeated character positions, rounding once', () => {
  const result = Q.evaluate(entries, { runId: 'run', attempts: [attempt('a', 'w0:0', { outcome: 'abandoned', mistakes: 4, elapsedMs: 2024.2 }), attempt('b', 'w0:0'), attempt('c', 'w0:0'), attempt('d', 'w0:2')] });
  assert.equal(result.ranked, true); assert.deepEqual(result.score, { mistakes: 4, elapsedMs: 5100 });
  assert.equal(Q.evaluate(entries, { runId: 'run', attempts: [attempt('a', 'w0:0')] }).terminal, false);
});
test('skips and unknown time are terminal unranked, never substituted with zero', () => {
  for (const missing of [{ phase: 'teacher', outcome: 'skipped', elapsedMs: null }, { elapsedMs: null }]) {
    const result = Q.evaluate(entries, { runId: 'run', attempts: [attempt('a', 'w0:0'), attempt('b', 'w0:2', missing)] });
    assert.equal(result.terminal, true); assert.equal(result.ranked, false); assert.equal(result.score, null);
  }
});
test('invalid evidence, unknown occurrences, duplicate IDs and incomplete live attempts cannot rank', () => {
  for (const patch of [{ phase: 'recall' }, { outcome: 'active' }, { elapsedMs: NaN }, { mistakes: -1 }, { help: [{}] }, { occurrenceId: 'w0:1' }]) assert.throws(() => Q.evaluate(entries, { runId: 'run', attempts: [attempt('a', 'w0:0', patch)] }));
  assert.throws(() => Q.evaluate(entries, { runId: 'run', attempts: [attempt('a', 'w0:0'), attempt('a', 'w0:2')] }));
  assert.throws(() => Q.assignment([{ text: '推', selectedIndexes: [1] }]));
});
test('best score compares mistakes then rounded active time with competition ties', () => {
  const rows = Q.ranks([{ memberId: 'c', mistakes: 1, elapsedMs: 100 }, { memberId: 'b', mistakes: 0, elapsedMs: 1000 }, { memberId: 'a', mistakes: 0, elapsedMs: 1000 }]);
  assert.deepEqual(rows.map(row => [row.memberId, row.rank]), [['a', 1], ['b', 1], ['c', 3]]);
});
