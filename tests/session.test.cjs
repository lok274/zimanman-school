'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../dist/session.js');
const W = require('../dist/writing.js');
let counter = 0;
const token = () => 'token-' + (++counter);
function create(text = '粗\n推來推去') { return S.createSession({ id: 'session', entries: S.parseEntries(text), startedAt: 1 }); }
function send(state, type, extra = {}) { return S.transition(state, { type, token: state.active.token, at: 2, newToken: token(), ...extra }); }
function guided(text = '粗') { let s = create(text); s = send(s, 'CHOOSE_WORD', { wordId: 'w0' }); s = send(s, 'DATA_READY', { strokeCount: 2 }); return send(s, 'START_GUIDED'); }
function finish(s) { const start = s.active.currentStroke; for (let i = start; i < s.active.strokeCount; i++) s = send(s, 'STROKE_ACCEPTED', { strokeIndex: i }); return send(s, 'WRITING_COMPLETE'); }
test('teacher text accepts exact Traditional list, rejects non-Han and bounds', () => {
  const entries = S.parseEntries('粗、濃、鬍鬚、密、剪草機、推來推去');
  assert.deepEqual(entries.map(e => e.text), ['粗', '濃', '鬍鬚', '密', '剪草機', '推來推去']);
  assert.equal(S.parseEntries('粗\n粗').length, 1);
  for (const value of ['', null, 'hello', '<svg>', '粗'.repeat(9), '粗\u200b', '粗'.repeat(401)]) assert.throws(() => S.parseEntries(value));
  assert.throws(() => S.createSession({ id: '', entries, startedAt: 1 }));
});
test('guided completion cannot count as independent; recall needs completed guidance', () => {
  let s = guided(); assert.equal(send(s, 'START_RECALL'), s);
  s = finish(s); assert.equal(s.active.phase, 'guided'); assert.equal(S.summarize(s)[0].independent, false); assert.equal(S.summarize(s)[0].guided, true);
  s = send(s, 'START_RECALL'); assert.equal(s.active.phase, 'recall'); s = finish(s);
  assert.equal(S.summarize(s)[0].independent, true); assert.equal(s.active.phase, 'character-complete');
});
test('two current-stroke misses are observable before help; help permanently makes recall assisted', () => {
  let s = send(finish(guided()), 'START_RECALL');
  s = send(s, 'STROKE_MISSED', { strokeIndex: 0 }); s = send(s, 'STROKE_MISSED', { strokeIndex: 0 });
  assert.equal(s.active.missesOnCurrentStroke, 2); assert.equal(s.attempts.at(-1).help.length, 0);
  s = send(s, 'REQUEST_HELP', { kind: 'stroke' }); assert.equal(s.attempts.at(-1).help.length, 1);
  s = send(s, 'STROKE_ACCEPTED', { strokeIndex: 0 }); assert.equal(s.active.missesOnCurrentStroke, 0);
  s = finish(s); const row = S.summarize(s)[0]; assert.equal(row.independent, false); assert.equal(row.assisted, true);
});
test('retry creates a new token and retains prior help, misses and abandoned attempts', () => {
  let s = send(finish(guided()), 'START_RECALL'); const previous = s.active.token;
  s = send(s, 'REQUEST_HELP', { kind: 'outline' }); s = send(s, 'STROKE_MISSED', { strokeIndex: 0 }); s = send(s, 'RETRY');
  assert.notEqual(s.active.token, previous); assert.equal(s.attempts.at(-2).outcome, 'abandoned'); assert.equal(s.attempts.at(-2).help.length, 1); assert.equal(s.attempts.at(-2).mistakes, 1);
  assert.equal(send(s, 'WRITING_COMPLETE', { token: previous }), s);
  s = finish(s); assert.equal(S.summarize(s)[0].independent, true); assert.equal(S.summarize(s)[0].helpUsed, 1);
});
test('stale, duplicate and premature callbacks do not award work or advance', () => {
  let s = guided(); assert.equal(send(s, 'WRITING_COMPLETE'), s); assert.equal(send(s, 'STROKE_ACCEPTED', { strokeIndex: 1 }), s);
  s = send(s, 'STROKE_ACCEPTED', { strokeIndex: 0 }); assert.equal(send(s, 'STROKE_ACCEPTED', { strokeIndex: 0 }), s);
  s = finish(s); assert.equal(send(s, 'WRITING_COMPLETE'), s); assert.equal(s.finished.length, 0);
  s = send(s, 'START_RECALL'); s = finish(s); assert.equal(send(s, 'WRITING_COMPLETE'), s); assert.equal(s.finished.length, 1);
});
test('teacher skip is never completion and remains recorded', () => {
  let s = guided(); s = send(s, 'TEACHER_SKIP'); const row = S.summarize(s)[0]; assert.equal(row.skipped, true); assert.equal(row.independent, false); assert.equal(row.guided, false); assert.equal(s.active.phase, 'character-complete');
  s = send(s, 'NEXT'); assert.equal(s.active.phase, 'choose-word'); assert.equal(S.summarize(s)[0].attempts[0].outcome, 'skipped');
});
test('repeated characters have distinct positions and do not share achievement', () => {
  let s = guided('推來推去'); s = finish(s); s = send(s, 'START_RECALL'); s = finish(s); s = send(s, 'NEXT');
  assert.equal(s.active.occurrenceId, 'w0:1'); assert.equal(S.summarize(s)[0].independent, true); assert.equal(S.summarize(s)[2].independent, false); assert.notEqual(s.occurrences[0].id, s.occurrences[2].id);
});
test('rest and ending preserve assistance and unfinished work', () => {
  let s = send(finish(guided('粗\n濃')), 'START_RECALL'); s = send(s, 'REQUEST_HELP', { kind: 'start' }); s = send(s, 'REST');
  assert.equal(send(s, 'STROKE_ACCEPTED', { strokeIndex: 0 }), s); s = send(s, 'RESUME'); assert.equal(s.attempts.at(-1).help.length, 1);
  s = send(s, 'END_SESSION'); assert.equal(s.active.phase, 'summary'); assert.equal(s.attempts.at(-1).outcome, 'abandoned'); assert.equal(S.summarize(s).filter(r => r.unfinished).length, 2); assert.equal(S.validateSnapshot(s), true);
});
test('missing data is unavailable, not a learner mistake; retry and other word remain possible', () => {
  let s = create(); s = send(s, 'CHOOSE_WORD', { wordId: 'w0' }); s = send(s, 'DATA_FAILED'); assert.equal(s.active.phase, 'unavailable'); assert.equal(s.attempts.length, 0);
  const retry = send(s, 'RETRY_DATA'); assert.equal(retry.active.phase, 'loading'); assert.notEqual(retry.active.token, s.active.token);
  s = send(s, 'RETURN_TO_WORDS'); s = send(s, 'CHOOSE_WORD', { wordId: 'w1' }); assert.equal(s.active.occurrenceId, 'w1:0');
});
test('previous step returns loading, unavailable and watch to word choice without an attempt', () => {
  const loading = send(create(), 'CHOOSE_WORD', { wordId: 'w0' });
  for (const s of [loading, send(loading, 'DATA_FAILED'), send(loading, 'DATA_READY', { strokeCount: 2 })]) {
    const back = send(s, 'PREVIOUS_STEP');
    assert.equal(back.active.phase, 'choose-word'); assert.deepEqual(back.attempts, []); assert.deepEqual(back.finished, []);
    assert.equal(send(back, 'DATA_READY', { token: s.active.token, strokeCount: 2 }), back);
    assert.equal(send(back, 'DATA_FAILED', { token: s.active.token }), back);
  }
});
test('previous guidance step retains partial help and completed attempts and restarts watch', () => {
  let partial = guided();
  partial = send(partial, 'REQUEST_HELP', { kind: 'stroke' }); partial = send(partial, 'STROKE_MISSED', { strokeIndex: 0 }); partial = send(partial, 'STROKE_ACCEPTED', { strokeIndex: 0 });
  for (const original of [partial, finish(guided())]) {
    const back = send(original, 'PREVIOUS_STEP');
    assert.equal(back.active.phase, 'watch'); assert.equal(back.active.occurrenceId, original.active.occurrenceId); assert.equal(back.active.strokeCount, 2); assert.notEqual(back.active.token, original.active.token);
    assert.equal(back.attempts.length, 1); assert.equal(back.attempts[0].outcome, original.active.writingDone ? 'complete' : 'abandoned');
    assert.deepEqual(back.attempts[0].help, original.attempts[0].help); assert.equal(back.attempts[0].mistakes, original.attempts[0].mistakes);
    assert.equal(send(back, 'WRITING_COMPLETE', { token: original.active.token }), back);
    const restarted = send(back, 'START_GUIDED'); assert.equal(restarted.active.currentStroke, 0); assert.equal(restarted.active.writingDone, false); assert.equal(restarted.attempts.length, 2);
    assert.equal(send(restarted, 'START_RECALL'), restarted); assert.deepEqual(restarted.finished, original.finished);
  }
});
test('previous recall step starts fresh guidance while preserving help and every completed result', () => {
  let partial = send(finish(guided()), 'START_RECALL');
  partial = send(partial, 'REQUEST_HELP', { kind: 'outline' }); partial = send(partial, 'STROKE_MISSED', { strokeIndex: 0 });
  const assisted = finish(partial), independent = finish(send(assisted, 'RETRY'));
  const skipped = send(guided(), 'TEACHER_SKIP');
  for (const original of [partial, assisted, independent, skipped]) {
    const previousAttempt = original.attempts.at(-1), back = send(original, 'PREVIOUS_STEP');
    assert.equal(back.active.phase, 'guided'); assert.equal(back.active.occurrenceId, original.active.occurrenceId); assert.notEqual(back.active.token, original.active.token);
    assert.equal(back.active.currentStroke, 0); assert.equal(back.active.writingDone, false); assert.deepEqual(back.attempts.at(-1).help, []);
    assert.deepEqual(back.finished, original.finished); assert.deepEqual(back.attempts.at(-2).help, previousAttempt.help); assert.equal(back.attempts.at(-2).mistakes, previousAttempt.mistakes);
    assert.equal(back.attempts.at(-2).outcome, previousAttempt.outcome === 'active' ? 'abandoned' : previousAttempt.outcome);
    assert.equal(send(back, 'WRITING_COMPLETE', { token: original.active.token }), back); assert.equal(send(back, 'START_RECALL'), back);
    const beforeRow = S.summarize(original)[0], afterRow = S.summarize(back)[0];
    for (const field of ['independent', 'assisted', 'skipped', 'helpUsed']) assert.equal(afterRow[field], beforeRow[field]);
    const recall = send(finish(back), 'START_RECALL'); assert.equal(recall.active.phase, 'recall'); assert.notEqual(recall.active.token, back.active.token);
  }
});
test('previous step rejects rest, choice, summary, stale events and reused tokens', () => {
  const s = guided();
  for (const blocked of [create(), send(s, 'REST'), send(s, 'END_SESSION')]) assert.equal(send(blocked, 'PREVIOUS_STEP'), blocked);
  for (const extra of [{ token: 'late-token' }, { newToken: s.active.token }, { newToken: '' }, { newToken: null }]) assert.equal(send(s, 'PREVIOUS_STEP', extra), s);
  const recall = send(finish(s), 'START_RECALL');
  assert.equal(send(recall, 'PREVIOUS_STEP', { newToken: s.active.token }), recall);
});
test('returning to a skipped character without glyph data reloads before writing', () => {
  const loading = send(create(), 'CHOOSE_WORD', { wordId: 'w0' });
  for (const original of [loading, send(loading, 'DATA_FAILED')]) {
    const skipped = send(original, 'TEACHER_SKIP'), back = send(skipped, 'PREVIOUS_STEP');
    assert.equal(back.active.phase, 'loading'); assert.equal(back.active.occurrenceId, skipped.active.occurrenceId); assert.notEqual(back.active.token, skipped.active.token);
    assert.deepEqual(back.attempts, skipped.attempts); assert.deepEqual(back.finished, skipped.finished);
    assert.equal(send(back, 'START_GUIDED'), back);
    const ready = send(back, 'DATA_READY', { strokeCount: 2 }), practice = send(ready, 'START_GUIDED');
    assert.equal(practice.active.phase, 'guided'); assert.equal(practice.active.strokeCount, 2); assert.equal(S.summarize(practice)[0].skipped, true);
    assert.equal(S.summarize(practice)[0].independent, false);
  }
});
test('snapshot and glyph validation reject malformed stored or network values', () => {
  const s = create(); assert.equal(S.validateSnapshot(s), true); assert.equal(S.validateSnapshot({ ...s, entries: [] }), false); assert.equal(S.validateSnapshot({ ...s, occurrences: [] }), false); assert.equal(S.validateSnapshot({ ...s, attempts: [{ help: null }] }), false);
  const good = { strokes: ['M 1 2 L 3 4 Z'], medians: [[[1, 2], [3, 4]]] }; assert.equal(W.validateCharacter('粗', good).strokes.length, 1);
  for (const bad of [null, {}, { ...good, strokes: ['<svg>'] }, { ...good, medians: [[[1, Infinity], [3, 4]]] }, { ...good, character: '濃' }]) assert.throws(() => W.validateCharacter('粗', bad));
});
test('all bundled characters validate and required corrections remain present', () => {
  require('../dist/data/characters.js');
  const all = globalThis.BishunCharacters;
  assert.equal(Object.keys(all).length, 11);
  for (const [character, data] of Object.entries(all)) assert(W.validateCharacter(character, data).strokes.length > 0);
  assert.equal(all['草'].strokes.length, 10);
});
