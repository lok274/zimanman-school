'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const currentSession = require('../dist/session.js');
const S = { ...currentSession, createSession(options) { const state = currentSession.createSession(options); if (state.mode === 'practice') { state.version = 3; delete state.wordChoices; } return state; } };
const W = require('../dist/writing.js');
let counter = 0;
const token = () => 'token-' + (++counter);
function create(text = '粗\n推來推去') { return S.createSession({ id: 'session', entries: S.parseEntries(text).map(entry => ({ ...entry, selectedIndexes: entry.characters.map((_, index) => index) })), startedAt: 1 }); }
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
  s = send(s, 'NEXT'); assert.equal(s.active.phase, 'summary'); assert.equal(S.summarize(s)[0].attempts[0].outcome, 'skipped');
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
test('new sessions require explicit valid character positions and canonicalize their order', () => {
  const options = { id: 'assignment', startedAt: 1 };
  for (const text of ['', '粗 粗', '粗\n粗', '粗A', '粗'.repeat(9)]) assert.throws(() => S.createSession({ ...options, entries: [{ text, selectedIndexes: [0] }] }));
  for (const selectedIndexes of [undefined, null, [], [0, 0], [-1], [4], [0.5], ['0']]) assert.throws(() => S.createSession({ ...options, entries: [{ text: '推來推去', selectedIndexes }] }));
  const state = S.createSession({ ...options, entries: [{ text: '推來推去', selectedIndexes: [2, 0] }] });
  assert.equal(state.version, 3); assert.equal(state.entries[0].text, '推來推去');
  assert.deepEqual(state.occurrences.map(o => [o.id, o.index, o.character]), [['w0:0', 0, '推'], ['w0:2', 2, '推']]);
  assert.equal(S.validateSnapshot(state), true);
});
test('a single nonfirst assignment ends only on explicit next and excludes unassigned positions', () => {
  let s = S.createSession({ id: 'one-position', entries: [{ text: '推來推去', selectedIndexes: [2] }], startedAt: 1 });
  s = send(s, 'CHOOSE_WORD', { wordId: 'w0' }); assert.equal(s.active.occurrenceId, 'w0:2');
  s = send(s, 'DATA_READY', { strokeCount: 1 }); s = send(s, 'START_GUIDED'); s = finish(s); s = send(s, 'START_RECALL'); s = finish(s);
  assert.equal(s.active.phase, 'character-complete'); assert.equal(s.endedAt, undefined); assert.equal(S.summarize(s).length, 1);
  assert.equal(S.summarize(s)[0].unfinished, false); s = send(s, 'NEXT');
  assert.equal(s.active.phase, 'summary'); assert.equal(s.endedAt, 2); assert.equal(S.validateSnapshot(s), true);
});
test('repeated assigned positions advance separately, preserve skips and support out of order word choice', () => {
  let s = S.createSession({ id: 'positions', entries: [{ text: '粗', selectedIndexes: [0] }, { text: '推來推去', selectedIndexes: [0, 2] }], startedAt: 1 });
  s = send(s, 'CHOOSE_WORD', { wordId: 'w1' }); s = send(s, 'TEACHER_SKIP'); s = send(s, 'NEXT');
  assert.equal(s.active.occurrenceId, 'w1:2'); s = send(s, 'TEACHER_SKIP'); s = send(s, 'NEXT'); assert.equal(s.active.phase, 'choose-word');
  s = send(s, 'CHOOSE_WORD', { wordId: 'w0' }); s = send(s, 'TEACHER_SKIP'); s = send(s, 'NEXT');
  assert.equal(s.active.phase, 'summary'); assert(S.summarize(s).every(row => row.skipped && !row.independent && !row.unfinished));
});
test('version two stored scope rejects noncanonical membership and invalid active references', () => {
  const s = S.createSession({ id: 'scope', entries: [{ text: '推來推去', selectedIndexes: [0, 2] }], startedAt: 1 });
  s.version = 2; delete s.mode; assert.equal(S.validateSnapshot(s), true);
  for (const mutate of [v => v.occurrences.push(v.occurrences[0]), v => v.occurrences.reverse(), v => v.occurrences[0].wordId = 'w5', v => v.occurrences[0].character = '來', v => v.finished = ['w0:0', 'w0:0'], v => v.finished = ['w0:1'], v => v.active = { phase: 'watch', occurrenceId: 'w0:1', token: 'bad' }, v => v.active = { phase: 'character-complete', occurrenceId: 'w0:0', token: 'bad', attemptId: 'missing' }]) {
    const broken = structuredClone(s); mutate(broken); assert.equal(S.validateSnapshot(broken), false);
  }
  assert.equal(S.validateSnapshot({ ...s, version: 3 }), false);
});
test('original version one fixture retains its full task and interrupted assistance', () => {
  const legacy = require('./fixtures/session-v1.json'), before = JSON.stringify(legacy);
  assert.equal(S.validateSnapshot(legacy), true); assert.equal(legacy.version, 1); assert.equal(legacy.occurrences.length, 5);
  const closed = send(legacy, 'END_SESSION');
  assert.equal(closed.version, 1); assert.equal(S.validateSnapshot(closed), true); assert.equal(closed.attempts.at(-1).outcome, 'abandoned'); assert.equal(closed.attempts.at(-1).mistakes, 1); assert.equal(closed.attempts.at(-1).help.length, 1);
  const rows = S.summarize(closed); assert.equal(rows.filter(row => row.assisted).length, 1); assert.equal(rows.filter(row => row.unfinished).length, 4);
  assert.equal(JSON.stringify(legacy), before, 'reading and closing a copy do not migrate the original');
});
function quizState() {
  let state = S.createSession({ id: 'quiz', mode: 'quiz', entries: [{ text: '推來推去', selectedIndexes: [0, 2] }], startedAt: 1 });
  state = send(state, 'CHOOSE_WORD', { wordId: 'w0' });
  return send(state, 'DATA_READY', { strokeCount: 2 });
}
test('quiz enters directly without help and preserves completed results across retry, back and skip', () => {
  let state = quizState(); assert.equal(state.active.phase, 'quiz'); assert.equal(state.attempts[0].elapsedMs, null);
  for (const type of ['START_GUIDED', 'START_RECALL', 'REQUEST_HELP']) assert.equal(send(state, type, { kind: 'outline' }), state);
  for (let i = 0; i < 4; i++) state = send(state, 'STROKE_MISSED', { strokeIndex: 0 });
  assert.equal(state.attempts[0].help.length, 0); assert.equal(state.attempts[0].mistakes, 4);
  state = send(state, 'DURATION_SNAPSHOT', { elapsedMs: 1200.5 }); state = finish(state);
  assert.equal(state.active.phase, 'character-complete'); assert.equal(state.active.completedPhase, 'quiz'); assert.equal(state.finished.length, 1);
  state = send(state, 'RETRY'); assert.equal(state.active.phase, 'quiz'); assert.equal(state.finished.length, 1); assert.equal(state.attempts.at(-1).elapsedMs, null);
  state = send(state, 'DURATION_SNAPSHOT', { elapsedMs: 500 }); state = send(state, 'PREVIOUS_STEP');
  assert.equal(state.active.phase, 'choose-word'); assert.equal(state.attempts.at(-1).outcome, 'abandoned');
  assert.equal(S.summarize(state)[0].elapsedMs, 1700.5); assert.equal(S.summarize(state)[0].independent, true);
  state = send(state, 'CHOOSE_WORD', { wordId: 'w0' }); assert.equal(state.active.occurrenceId, 'w0:2'); state = send(state, 'TEACHER_SKIP');
  assert.equal(state.attempts.at(-1).elapsedMs, null); assert.equal(state.active.completedPhase, 'skipped');
  state = send(state, 'NEXT'); assert.equal(state.active.phase, 'summary'); assert.equal(S.validateSnapshot(state), true);
  assert.equal(S.summarize(state)[1].elapsedMs, null); assert.equal(S.summarize(state)[1].timingComplete, false);
});
test('duration snapshots are absolute, bounded, monotonic, mode gated and cannot modify a closed attempt', () => {
  let state = quizState(); state = send(state, 'DURATION_SNAPSHOT', { elapsedMs: 0 });
  assert.equal(state.attempts[0].elapsedMs, 0); assert.equal(S.validateSnapshot(state), true);
  state = send(state, 'DURATION_SNAPSHOT', { elapsedMs: 1234.75 });
  for (const elapsedMs of [1234.75, 0, -1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '2000']) assert.equal(send(state, 'DURATION_SNAPSHOT', { elapsedMs }), state);
  assert.equal(send(state, 'DURATION_SNAPSHOT', { elapsedMs: 2000, token: 'stale' }), state);
  const practice = guided(); assert.equal(send(practice, 'DURATION_SNAPSHOT', { elapsedMs: 100 }), practice);
  state = finish(state); assert.equal(send(state, 'DURATION_SNAPSHOT', { elapsedMs: 2000 }), state);
  assert.equal(state.attempts[0].elapsedMs, 1234.75);
});
test('v3 rejects unknown modes, invalid timing and stored ink while v2 keeps selected positions without timing', () => {
  const state = quizState(); assert.equal(S.validateSnapshot(state), true);
  for (const mutate of [v => delete v.mode, v => v.mode = 'exam', v => v.mode = 'practice', v => v.attempts[0].elapsedMs = -1, v => v.attempts[0].elapsedMs = Infinity, v => delete v.attempts[0].elapsedMs, v => v.attempts[0].elapsedMs = '1', v => v.attempts[0].help.push({ kind: 'outline', strokeIndex: 0, at: 1 }), v => v.ink = [], v => v.attempts[0].drawnPath = {}, v => v.active.phase = 'guided']) {
    const broken = structuredClone(state); mutate(broken); assert.equal(S.validateSnapshot(broken), false);
  }
  const practice = guided(); const broken = structuredClone(practice); broken.attempts[0].elapsedMs = 0; assert.equal(S.validateSnapshot(broken), false);
  const legacy = S.createSession({ id: 'v2', startedAt: 1, entries: [{ text: '推來推去', selectedIndexes: [2] }] }); legacy.version = 2; delete legacy.mode;
  const raw = JSON.stringify(legacy); assert.equal(S.validateSnapshot(legacy), true); assert.equal(S.summarize(legacy)[0].index, 2); assert.equal(S.summarize(legacy)[0].elapsedMs, null); assert.equal(JSON.stringify(legacy), raw);
});

test('demo browsing visits assigned positions in both directions without awarding work', () => {
  for (const [text, indexes] of [['鬍鬚', [0, 1]], ['剪草機', [0, 1, 2]], ['推來推去', [0, 1, 2, 3]], ['一二三四五六七八', [0, 1, 2, 3, 4, 5, 6, 7]], ['推來推去', [0, 2, 3]], ['剪草機', [0, 2]], ['推來推去', [3]]]) {
    let state = S.createSession({ id: 'browse', entries: [{ text, selectedIndexes: indexes }, { text: '粗', selectedIndexes: [0] }], startedAt: 1 });
    state = send(send(state, 'CHOOSE_WORD', { wordId: 'w0' }), 'DATA_READY', { strokeCount: 2 });
    const original = state;
    assert.equal(send(state, 'BROWSE_DEMO', { direction: -1 }), state);
    for (const index of indexes.slice(1)) {
      const oldToken = state.active.token;
      state = send(state, 'BROWSE_DEMO', { direction: 1 });
      assert.equal(state.active.phase, 'loading'); assert.equal(state.active.occurrenceId, 'w0:' + index);
      assert.equal(send(state, 'DATA_READY', { token: oldToken, strokeCount: 2 }), state);
      assert(S.validateSnapshot(state));
      state = send(state, 'DATA_READY', { strokeCount: 2 });
    }
    assert.equal(send(state, 'BROWSE_DEMO', { direction: 1 }), state);
    for (const index of indexes.slice(0, -1).reverse()) {
      state = send(state, 'BROWSE_DEMO', { direction: -1 });
      assert.equal(state.active.occurrenceId, 'w0:' + index);
      state = send(state, 'DATA_READY', { strokeCount: 2 });
    }
    assert.deepEqual(state.entries, original.entries); assert.deepEqual(state.occurrences, original.occurrences);
    assert.deepEqual(state.attempts, []); assert.deepEqual(state.finished, []);
    assert(S.summarize(state).every(row => !row.guided && !row.independent && !row.skipped));
  }
});

test('demo browsing rejects wrong phases, modes, directions and reused tokens', () => {
  let watch = send(send(create('鬍鬚'), 'CHOOSE_WORD', { wordId: 'w0' }), 'DATA_READY', { strokeCount: 2 });
  const abandoned = send(send(watch, 'START_GUIDED'), 'PREVIOUS_STEP');
  for (const extra of [{ direction: 0 }, { direction: 2 }, { direction: '1' }, { newToken: '' }, { newToken: null }, { newToken: watch.active.token }, { token: 'old' }]) assert.equal(send(watch, 'BROWSE_DEMO', { direction: 1, ...extra }), watch);
  assert.equal(send(abandoned, 'BROWSE_DEMO', { direction: 1, newToken: abandoned.attempts[0].id }), abandoned);
  const loading = send(create('鬍鬚'), 'CHOOSE_WORD', { wordId: 'w0' }), guidance = send(watch, 'START_GUIDED'), recall = send(finish(guidance), 'START_RECALL');
  for (const state of [create('鬍鬚'), loading, send(loading, 'DATA_FAILED'), guidance, recall, finish(recall), send(watch, 'REST'), { ...watch, mode: 'quiz' }, send(watch, 'END_SESSION')]) assert.equal(send(state, 'BROWSE_DEMO', { direction: 1 }), state);
});

test('writing the chosen demo records that position and normal NEXT returns to unfinished work', () => {
  let state = send(send(create('鬍鬚'), 'CHOOSE_WORD', { wordId: 'w0' }), 'DATA_READY', { strokeCount: 2 });
  state = send(send(state, 'BROWSE_DEMO', { direction: 1 }), 'DATA_READY', { strokeCount: 2 });
  state = send(state, 'START_GUIDED'); assert.equal(state.attempts[0].occurrenceId, 'w0:1');
  state = finish(send(finish(state), 'START_RECALL'));
  assert.deepEqual(state.finished, ['w0:1']); assert(state.attempts.every(attempt => attempt.occurrenceId === 'w0:1'));
  state = send(state, 'NEXT'); assert.equal(state.active.phase, 'loading'); assert.equal(state.active.occurrenceId, 'w0:0');
});

test('v4 choices enter writing directly and keep manual guidance on the same attempt', () => {
  let s = currentSession.createSession({ id: 'purpose', startedAt: 1, entries: [{ text: '推來推去', selectedIndexes: [0, 2] }] });
  assert.equal(s.version, 4); assert(currentSession.validateSnapshot(s));
  s = send(s, 'CHOOSE_WORD', { wordId: 'w0', purpose: 'label' }); assert.equal(s.active.phase, 'loading');
  assert.deepEqual(s.wordChoices.w0, { purpose: 'label', route: 'independent' }); assert(currentSession.validateSnapshot(s));
  s = send(s, 'DATA_READY', { strokeCount: 3 }); assert.equal(s.active.phase, 'recall');
  s = send(s, 'STROKE_ACCEPTED', { strokeIndex: 0 });
  s = send(send(s, 'STROKE_MISSED', { strokeIndex: 1 }), 'STROKE_MISSED', { strokeIndex: 1 });
  const before = structuredClone(s); assert.equal(s.attempts[0].help.length, 0);
  s = send(s, 'USE_GUIDANCE'); assert.equal(s.active.phase, 'guided'); assert.equal(s.active.attemptId, before.active.attemptId);
  assert.notEqual(s.active.token, before.active.token); assert.equal(s.active.currentStroke, 1); assert.equal(s.attempts[0].mistakes, 2); assert.equal(s.attempts[0].startedAt, before.attempts[0].startedAt);
  assert.equal(send(s, 'WRITING_COMPLETE', { token: before.active.token }), s);
  s = finish(s); assert.equal(s.active.phase, 'character-complete'); assert.equal(s.finished.length, 1);
  assert.equal(S.summarize(s)[0].assisted, true); assert.equal(S.summarize(s)[0].independent, false);
  const success = S.summarize(s)[0].completedAttemptId;
  const retry = send(s, 'PREVIOUS_STEP'); assert.equal(retry.active.phase, 'recall'); assert.equal(retry.active.occurrenceId, 'w0:0'); assert.equal(S.summarize(retry)[0].completedAttemptId, success);
  s = send(s, 'NEXT'); s = send(s, 'DATA_READY', { strokeCount: 1 }); assert.equal(s.active.phase, 'recall'); assert.equal(s.active.occurrenceId, 'w0:2');
  s = finish(s); s = send(s, 'NEXT'); assert.equal(s.active.phase, 'word-complete'); assert.equal(s.active.wordId, 'w0'); assert(currentSession.validateSnapshot(s));
  s = send(s, 'NEXT'); assert.equal(s.active.phase, 'summary'); assert(currentSession.validateSnapshot(s));
});

test('v4 custom choice, guided Back and completion keep the chosen task honest', () => {
  let s = currentSession.createSession({ id: 'custom', startedAt: 1, entries: [{ text: '來', selectedIndexes: [0] }] });
  s = send(s, 'CHOOSE_WORD', { wordId: 'w0', purpose: null });
  assert.equal(s.active.phase, 'loading'); assert.deepEqual(s.wordChoices.w0, { purpose: null, route: 'independent' }); assert(currentSession.validateSnapshot(s));
  assert.equal(send(s, 'PREVIOUS_STEP').active.phase, 'choose-word');
  s = send(s, 'DATA_READY', { strokeCount: 1 }); s = send(s, 'USE_GUIDANCE'); assert.equal(s.active.phase, 'guided');
  const guided = s; s = send(s, 'PREVIOUS_STEP'); assert.equal(s.active.phase, 'recall'); assert.equal(s.active.attemptId, guided.active.attemptId); assert.deepEqual(s.attempts[0].help, guided.attempts[0].help);
  s = finish(s); assert.equal(s.active.phase, 'character-complete'); assert.equal(S.summarize(s)[0].assisted, true); assert.equal(send(s, 'START_RECALL'), s);
  const legacy = structuredClone(s); legacy.version = 3; delete legacy.wordChoices; assert.equal(S.summarize(legacy)[0].assisted, true); assert.equal(S.summarize(legacy)[0].unfinished, false);
  for (const mutate of [v => v.wordChoices.w0.points = [], v => v.wordChoices.w0.route = 'auto', v => v.wordChoices.w0.purpose = 'unknown', v => v.active.ink = [], v => v.attempts[0].drawnPath = {}]) { const bad = structuredClone(s); mutate(bad); assert.equal(currentSession.validateSnapshot(bad), false); }
});

test('v4 guided retry starts a fresh independent attempt and Back returns to words', () => {
  let s = currentSession.createSession({ id: 'guided-retry', startedAt: 1, entries: [{ text: '粗', selectedIndexes: [0] }] });
  s = send(s, 'CHOOSE_WORD', { wordId: 'w0', purpose: 'label' }); s = send(s, 'DATA_READY', { strokeCount: 11 });
  s = send(s, 'USE_GUIDANCE'); const guidedAttempt = s.active.attemptId;
  s = send(s, 'RETRY');
  assert.equal(s.active.phase, 'recall'); assert.notEqual(s.active.attemptId, guidedAttempt); assert.deepEqual(s.attempts.at(-1).help, []);
  s = send(s, 'PREVIOUS_STEP'); assert.equal(s.active.phase, 'choose-word'); assert(currentSession.validateSnapshot(s));
});

test('legacy v4 guided Back still returns to watch without inventing guidance', () => {
  let s = currentSession.createSession({ id: 'demos', startedAt: 1, entries: [{ text: '推來推去', selectedIndexes: [0,2] }] });
  s.wordChoices.w0 = { purpose: 'label', route: 'guided' }; s.active = { phase: 'loading', occurrenceId: 'w0:0', token: token() }; assert(currentSession.validateSnapshot(s));
  s = send(s, 'DATA_READY', { strokeCount: 11 }); assert.equal(s.active.phase, 'guided'); s = send(s, 'PREVIOUS_STEP');
  assert.equal(s.active.phase, 'watch'); assert.equal(s.attempts[0].outcome, 'abandoned');
  s = send(s, 'BROWSE_DEMO', { direction: 1 }); assert.equal(s.active.demo, true); assert.equal(s.active.occurrenceId, 'w0:2'); assert(currentSession.validateSnapshot(s));
  s = send(s, 'DATA_READY', { strokeCount: 11 }); assert.equal(s.active.phase, 'watch'); assert.equal(s.active.demo, undefined); assert.equal(s.attempts.length, 1); assert.equal(s.wordChoices.w0.route, 'guided');
  const broken = structuredClone(s); broken.active.demo = true; assert.equal(currentSession.validateSnapshot(broken), false);
});

test('v4 work card back keeps purpose and offers a fresh last-position attempt without losing success', () => {
  let s = currentSession.createSession({ id: 'redo', startedAt: 1, entries: [{ text: '推來推去', selectedIndexes: [2] }] });
  s.active = { phase: 'choose-purpose', wordId: 'w0', token: token() }; s.wordChoices.w0 = { purpose: 'intro', route: null }; assert(currentSession.validateSnapshot(s));
  for (const [type, extra] of [['CHOOSE_ROUTE', { route: 'independent', purpose: 'label' }], ['DATA_READY', { strokeCount: 1 }]]) s = send(s, type, extra);
  s = send(finish(s), 'NEXT'); const completed = S.summarize(s)[0].completedAttemptId;
  s = send(s, 'PREVIOUS_STEP'); assert.equal(s.active.phase, 'loading'); assert.equal(s.wordChoices.w0.purpose, 'intro');
  s = send(s, 'DATA_READY', { strokeCount: 1 });
  assert.equal(s.active.phase, 'recall'); assert.equal(s.active.occurrenceId, 'w0:2'); assert.equal(S.summarize(s)[0].completedAttemptId, completed);
  s = finish(s); assert.notEqual(S.summarize(s)[0].completedAttemptId, completed); assert.equal(send(s, 'NEXT').active.phase, 'word-complete');
});

test('v4 completed second occurrence Back retries that occurrence independently', () => {
  let s = currentSession.createSession({ id: 'second', startedAt: 1, entries: [{ text: '推來推去', selectedIndexes: [0, 2] }] });
  s = send(s, 'CHOOSE_WORD', { wordId: 'w0', purpose: null }); s = send(s, 'DATA_READY', { strokeCount: 1 }); s = finish(s);
  s = send(s, 'NEXT'); s = send(s, 'DATA_READY', { strokeCount: 1 });
  assert.equal(s.active.occurrenceId, 'w0:2'); assert.equal(s.active.phase, 'recall');
  s = send(s, 'USE_GUIDANCE'); s = finish(s); const completed = s.active.attemptId;
  s = send(s, 'PREVIOUS_STEP'); assert.equal(s.active.phase, 'recall'); assert.equal(s.active.occurrenceId, 'w0:2');
  assert.notEqual(s.active.attemptId, completed); assert.equal(s.wordChoices.w0.route, 'independent');
  assert.equal(S.summarize(s)[1].completedAttemptId, completed); assert(currentSession.validateSnapshot(s));
});

test('v4 choices reject missing or invalid fresh defaults and preserve saved choices on word selection', () => {
  const fresh = currentSession.createSession({ id: 'defaults', startedAt: 1, entries: [{ text: '粗', selectedIndexes: [0] }] });
  for (const purpose of [undefined, 'intro', 'unknown', false]) assert.equal(send(fresh, 'CHOOSE_WORD', { wordId: 'w0', purpose }), fresh);
  for (const purpose of ['label', 'intro', null]) {
    const saved = { ...fresh, wordChoices: { w0: { purpose, route: null } } };
    const selected = send(saved, 'CHOOSE_WORD', { wordId: 'w0', purpose: 'label' });
    assert.equal(selected.active.phase, 'loading'); assert.deepEqual(selected.wordChoices.w0, { purpose, route: 'independent' }); assert(currentSession.validateSnapshot(selected));
    const back = send(selected, 'PREVIOUS_STEP'); assert.equal(back.active.phase, 'choose-word'); assert.deepEqual(back.wordChoices, selected.wordChoices); assert(currentSession.validateSnapshot(back));
    const routed = { ...saved, wordChoices: { w0: { purpose, route: 'guided' } } };
    const continued = send(routed, 'CHOOSE_WORD', { wordId: 'w0' }); assert.equal(continued.active.phase, 'loading'); assert.deepEqual(continued.wordChoices.w0, { purpose, route: 'independent' }); assert(currentSession.validateSnapshot(continued));
  }
});

test('historical v4 purpose states use route choices without overwriting purpose or history', () => {
  for (const choice of [undefined, { purpose: 'intro', route: 'guided' }, { purpose: 'label', route: null }, { purpose: null, route: null }]) {
    const old = currentSession.createSession({ id: 'historical', startedAt: 1, entries: [{ text: '粗', selectedIndexes: [0] }] });
    old.active = { phase: 'choose-purpose', wordId: 'w0', token: token() }; if (choice) old.wordChoices.w0 = choice;
    assert(currentSession.validateSnapshot(old)); assert(currentSession.validateSnapshot({ ...old, resting: true }));
    const before = JSON.stringify(old);
    assert.equal(send(old, 'CHOOSE_PURPOSE', { purpose: 'label' }), old);
    const back = send(old, 'PREVIOUS_STEP'); assert.equal(back.active.phase, 'choose-word'); assert.deepEqual(back.wordChoices, old.wordChoices); assert(currentSession.validateSnapshot(back));
    if (!choice) for (const purpose of [undefined, 'intro', 'unknown']) assert.equal(send(old, 'CHOOSE_ROUTE', { route: 'independent', purpose }), old);
    for (const purpose of ['label', null]) {
      const routed = send(old, 'CHOOSE_ROUTE', { route: 'independent', purpose });
      assert.equal(routed.active.phase, 'loading'); assert.deepEqual(routed.wordChoices.w0, { purpose: choice ? choice.purpose : purpose, route: 'independent' }); assert(currentSession.validateSnapshot(routed));
      assert.equal(send(routed, 'CHOOSE_ROUTE', { route: 'guided', token: old.active.token, purpose }), routed);
      const ended = send(routed, 'END_SESSION'); assert.equal(ended.active.phase, 'summary'); assert.deepEqual(ended.wordChoices, routed.wordChoices); assert(currentSession.validateSnapshot(ended));
    }
    assert.equal(JSON.stringify(old), before);
  }
});

test('v4 undo removes one accepted stroke and preserves the live attempt evidence', () => {
  for (const phase of ['recall', 'guided']) {
    let state = currentSession.createSession({ id: 'undo', entries: assignedUndo(), startedAt: 1 });
    state = send(state, 'CHOOSE_WORD', { wordId: 'w0', purpose: null });
    state = send(state, 'DATA_READY', { strokeCount: 3 });
    if (phase === 'guided') state = send(state, 'USE_GUIDANCE');
    state = send(state, 'STROKE_MISSED', { strokeIndex: 0 });
    state = send(state, 'STROKE_ACCEPTED', { strokeIndex: 0 });
    state = send(state, 'STROKE_ACCEPTED', { strokeIndex: 1 });
    state = send(state, 'STROKE_MISSED', { strokeIndex: 2 });
    const before = state;
    state = send(state, 'UNDO_STROKE', { strokeIndex: 1 });
    assert.equal(state.active.currentStroke, 1);
    assert.equal(state.active.attemptId, before.active.attemptId);
    assert.equal(state.active.phase, phase); assert.equal(state.active.missesOnCurrentStroke, 0);
    assert.deepEqual(state.attempts, before.attempts); assert.deepEqual(state.finished, before.finished);
    assert.notEqual(state.active.token, before.active.token); assert(currentSession.validateSnapshot(state));
    for (const extra of [{ token: before.active.token }, { strokeIndex: 1 }, { newToken: state.active.token }, { newToken: state.active.attemptId }, { newToken: '' }]) assert.equal(send(state, 'UNDO_STROKE', { strokeIndex: 0, ...extra }), state);
    for (const changed of [{ version: 3 }, { resting: true }, { mode: 'quiz' }, { active: { ...state.active, writingDone: true } }, { active: { ...state.active, currentStroke: 3 } }]) { const refused = { ...state, ...changed }; assert.equal(send(refused, 'UNDO_STROKE', { strokeIndex: refused.active.currentStroke - 1 }), refused); }
    state = send(state, 'UNDO_STROKE', { strokeIndex: 0 }); assert.equal(state.active.currentStroke, 0);
    assert.equal(send(state, 'UNDO_STROKE', { strokeIndex: -1 }), state);
  }
});
function assignedUndo() { return [{ text: '來', selectedIndexes: [0] }]; }
