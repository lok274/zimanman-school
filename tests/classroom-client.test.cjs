'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Q = require('../dist/quiz-results.js');
const C = require('../dist/classroom.js');
globalThis.BishunAssessment = require('../dist/assessment.js');
const { webcrypto } = require('node:crypto');
const assignment = Q.assignment([{ text: '一', selectedIndexes: [0] }]);
const member = { code: 'ABCDEFGH', memberId: 'member-a', alias: '小星', assignment, expiresAt: Date.now() + 86400000 };
const evidence = { runId: 'run-a', attempts: [{ id: 'a', occurrenceId: 'w0:0', phase: 'quiz', outcome: 'complete', mistakes: 1, elapsedMs: 1501, help: [] }] };
const response = (data, status = 200) => ({ ok: status === 200, status, json: async () => data });
function setup(fetch) {
  const data = new Map(), calls = [];
  const storage = { getItem: key => data.get(key) || null, setItem: (key, value) => data.set(key, value) };
  const options = { origin: 'https://class.test', storage, crypto: webcrypto, fetch: async (url, init) => { calls.push({ url, ...init }); return fetch(url, init); } };
  return { client: C.create(options), data, calls, storage, options, key: C.storageKey + ':' + new URL(options.origin).origin };
}
test('classroom state belongs to its API origin and leaves old records untouched', async () => {
  const e = setup(() => response(member));
  await e.client.join(member.code, member.alias);
  const original = e.data.get(e.key);
  assert.equal(typeof original, 'string');
  e.data.set(C.storageKey, original);
  e.data.set('bishun-school:v1:history', 'local practice record');
  const other = C.create({ ...e.options, origin: 'https://other.test' });
  assert.equal(other.view().member, null);
  assert.equal(other.view().receipt, null);
  assert.equal(e.calls.length, 1);
  await other.join(member.code, member.alias);
  assert.equal(e.calls[1].url, 'https://other.test/api/v1/classes/' + member.code + '/members');
  assert.notEqual(JSON.parse(e.calls[0].body).memberToken, JSON.parse(e.calls[1].body).memberToken);
  other.leave();
  const reload = C.create({ ...e.options, origin: 'https://CLASS.test:443/' });
  assert.equal(reload.view().member.memberId, member.memberId);
  assert.equal(reload.view().needsContinue, true);
  assert.equal(e.data.get(e.key), original);
  assert.equal(e.data.get(C.storageKey), original);
  assert.equal(e.data.get('bishun-school:v1:history'), 'local practice record');
});
test('lost join retries keep their request and capability after a same-origin reload', async () => {
  let offline = true;
  const e = setup(() => { if (offline) throw new Error('offline'); return response(member); });
  await e.client.join(member.code, member.alias);
  const other = C.create({ ...e.options, origin: 'https://other.test' });
  await other.join(member.code, member.alias);
  assert.notEqual(e.calls[0].body, e.calls[1].body);
  offline = false;
  const reload = C.create({ ...e.options, origin: 'https://class.test/' });
  await reload.join(member.code, member.alias);
  assert.equal(e.calls[2].body, e.calls[0].body);
  assert.equal(e.calls[2].url, e.calls[0].url);
  assert.equal(reload.view().accepted, true);
});
test('classroom requests use the canonical default when no origin is supplied', async () => {
  const e = setup(() => response(member));
  const { origin, ...options } = e.options;
  assert.equal(new URL(C.defaultOrigin).origin, C.defaultOrigin);
  const client = C.create(options);
  await client.join(member.code, member.alias);
  assert.equal(e.calls[0].url, C.defaultOrigin + '/api/v1/classes/' + member.code + '/members');
});
test('reviewed transport keeps sealed payloads out of sessionStorage and requires explicit identity after reload', async () => {
  const reviewedMember = { ...member, assignment: BishunAssessment.assignment(assignment.entries, 'listen') };
  const run = BishunAssessment.start(reviewedMember.assignment, 'ink-run'); run.phase = 'sealed'; run.answers[0].status = 'submitted'; run.answers[0].strokes = [[[1, 2, 0], [3, 4, 10]]];
  const e = setup(url => response(url.endsWith('/members') ? reviewedMember : url.endsWith('/board') ? { published: true, rows: [{ alias: member.alias, rank: 1, score: 1 }] } : { runId: run.runId, official: true }));
  await e.client.join(member.code, member.alias); await e.client.submitReviewed(run);
  assert(!e.data.get(e.key).includes('"strokes":'));
  const reload = C.create(e.options); assert.equal(reload.view().needsContinue, true);
  await assert.rejects(reload.ownAnswer(), /身份/);
  reload.continueMember(); await reload.refresh();
  assert.equal(reload.view().board.reviewed, true); assert.equal(reload.view().board.personalBest.score, 1);
  assert(!JSON.stringify(reload.view().board).includes('elapsedMs'));
});
test('reviewed late uploads and private reads cannot restore a switched member', async () => {
  for (const method of ['submitReviewed', 'ownAnswer']) {
    let finish;
    const reviewedMember = { ...member, assignment: BishunAssessment.assignment(assignment.entries, 'copy') };
    const e = setup(url => url.endsWith('/members') ? response(reviewedMember) : new Promise(resolve => { finish = resolve; }));
    await e.client.join(member.code, member.alias);
    const pending = e.client[method]({ runId: 'one' }); e.client.leave();
    finish(response({ runId: 'one', official: true, answer: { private: true } }));
    await assert.rejects(pending, /身份/); assert.equal(e.client.view().member, null); assert.equal(e.client.view().receipt, null);
  }
});

test('v3 originals require a version-preserving receipt and reviewed boards validate actual mode', async () => {
  const reviewedMember = { ...member, assignment: BishunAssessment.assignment(assignment.entries, 'listen') };
  let receipt = { runId: 'new-word', official: true }, rows = [{ alias: member.alias, rank: 1, score: 1, mode: 'copy' }];
  const e = setup(url => response(url.endsWith('/members') ? reviewedMember : url.endsWith('/board') ? { published: true, rows } : receipt));
  await e.client.join(member.code, member.alias);
  const run = { version: 3, runId: 'new-word' };
  await assert.rejects(e.client.submitReviewed(run), /回應無效/); assert.equal(e.client.view().receipt, null);
  receipt = { ...receipt, version: 3 }; await e.client.submitReviewed(run);
  assert.equal((await e.client.reviewedBoard()).rows[0].mode, 'copy');
  rows = [{ ...rows[0], mode: 'unknown' }]; await assert.rejects(e.client.reviewedBoard(), /排行榜回應無效/);
  rows = [{ alias: member.alias, rank: 1, score: 1 }]; assert.equal((await e.client.reviewedBoard()).rows.length, 1, 'legacy board readers remain compatible');
});
async function settled(client) { for (let i = 0; i < 30 && client.view().busy; i++) await new Promise(resolve => setImmediate(resolve)); assert.equal(client.view().busy, false); }
test('lost join responses retry the exact request ID and pre-generated capability', async () => {
  let fail = true;
  const e = setup(() => { if (fail) throw new Error('offline'); return response(member); });
  await e.client.join('abcdefgh', ' 小星 '); fail = false; await e.client.join('ABCDEFGH', '小星');
  assert.equal(e.calls[0].body, e.calls[1].body); assert.match(JSON.parse(e.calls[0].body).memberToken, /^[a-f0-9]{64}$/); assert.equal(e.client.view().accepted, true);
});
test('three-digit membership survives reload while malformed and legacy code forms stay distinct', async () => {
  const numeric = { ...member, code: '123', joinExpiresAt: Date.now() + 900000 };
  const e = setup(() => response(numeric));
  for (const code of ['000', '099', '12', '1234', 'ABC12345']) await e.client.join(code, '小星');
  assert.equal(e.calls.length, 0);
  await e.client.join(' 123 ', '小星');
  assert.equal(e.client.view().member.code, '123');
  const reload = C.create(e.options);
  assert.equal(reload.view().member.code, '123'); assert.equal(reload.view().needsContinue, true);
  const legacy = setup(() => response(member));
  await legacy.client.join('abcdefgh', '小星');
  assert.equal(legacy.client.view().member.code, 'ABCDEFGH');
});
test('network and invalid JSON errors use Chinese copy while server messages survive', async () => {
  const offline = setup(() => { throw new TypeError('Failed to fetch'); });
  await offline.client.join('ABCDEFGH', '小星');
  assert.match(offline.client.view().message, /班級服務未能連線/);
  assert.doesNotMatch(offline.client.view().message, /Failed to fetch/);

  const broken = setup(url => url.endsWith('/members') ? response(member) : { ok: true, json: async () => { throw new SyntaxError('Unexpected token'); } });
  await broken.client.join('ABCDEFGH', '小星'); broken.client.bindRun('run-a'); broken.client.finish(Q.evaluate(assignment.entries, evidence)); await settled(broken.client);
  assert.match(broken.client.view().message, /班級服務回應無效/);
  assert.doesNotMatch(broken.client.view().message, /Unexpected token/);

  const rejected = setup(() => response({ error: { message: '班級已結束。' } }, 410));
  await rejected.client.join('ABCDEFGH', '小星');
  assert.match(rejected.client.view().message, /班級已結束。/);
});
test('pending result survives reload and is retried identically only after explicit membership continuation', async () => {
  let fail = true;
  const e = setup(url => {
    if (url.endsWith('/members')) return response(member);
    if (fail) throw new Error('offline');
    return response({ runId: 'run-a', ranked: true, reason: null, score: { mistakes: 1, elapsedMs: 1500 } });
  });
  await e.client.join('ABCDEFGH', '小星'); e.client.bindRun('run-a'); e.client.finish(Q.evaluate(assignment.entries, evidence)); await settled(e.client);
  assert.equal(e.client.view().pending, true); const original = e.calls.at(-1);
  const reloaded = C.create(e.options); assert.equal(reloaded.view().needsContinue, true);
  const before = e.calls.length; await reloaded.retry(); assert.equal(e.calls.length, before);
  fail = false; reloaded.continueMember(); await reloaded.retry();
  assert.equal(e.calls.at(-1).body, original.body); assert.equal(e.calls.at(-1).headers.Authorization, original.headers.Authorization);
  assert.equal(reloaded.view().pending, false); assert.equal(reloaded.view().receipt.runId, 'run-a');
});
test('late join, upload and board responses cannot restore a previous learner after switching', async () => {
  for (const stage of ['join', 'upload', 'board']) {
    let finish;
    const e = setup(url => {
      const currentStage = url.endsWith('/members') ? 'join' : url.endsWith('/board') ? 'board' : 'upload';
      if (currentStage === stage) return new Promise(resolve => { finish = resolve; });
      return response(currentStage === 'join' ? member : { runId: 'run-a', ranked: true });
    });
    const joining = e.client.join('ABCDEFGH', '小星');
    if (stage !== 'join') {
      await joining; e.client.bindRun('run-a'); e.client.finish(Q.evaluate(assignment.entries, evidence));
      if (stage === 'board') { await settled(e.client); e.client.refresh(); }
    }
    await new Promise(resolve => setImmediate(resolve)); assert.equal(typeof finish, 'function');
    e.client.leave(); finish(response(stage === 'join' ? member : stage === 'board' ? { rows: [], personalBest: null } : { runId: 'run-a', ranked: true }));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(e.client.view().member, null); assert.equal(e.client.view().receipt, null); assert.equal(e.client.view().board, null); assert.equal(e.client.view().pending, false);
    assert.deepEqual(JSON.parse(e.data.get(e.key)), {});
  }
});
test('completion never overwrites pending evidence and no board fetch happens before a committed receipt', async () => {
  const e = setup(url => url.endsWith('/members') ? response(member) : Promise.reject(new Error('offline')));
  await e.client.join('ABCDEFGH', '小星'); await e.client.refresh(); assert.equal(e.calls.length, 1);
  e.client.bindRun('run-a'); e.client.finish(Q.evaluate(assignment.entries, evidence)); await settled(e.client);
  assert.throws(() => e.client.bindRun('run-b'));
  e.client.finish(Q.evaluate(assignment.entries, { ...evidence, runId: 'run-b' }));
  assert.equal(JSON.parse(e.data.get(e.key)).pending.runId, 'run-a');
});
test('storage denial prevents joining before a network write and later denial preserves pending completion', async () => {
  const e = setup(url => response(url.endsWith('/members') ? member : { runId: 'run-a', ranked: true }));
  const write = e.storage.setItem; e.storage.setItem = () => { throw new Error('blocked'); };
  await e.client.join('ABCDEFGH', '小星'); assert.equal(e.calls.length, 0); assert.equal(e.client.view().storageOkay, false);
  e.storage.setItem = write; await e.client.join('ABCDEFGH', '小星'); e.client.bindRun('run-a');
  e.storage.setItem = () => { throw new Error('full'); }; e.client.finish(Q.evaluate(assignment.entries, evidence)); await settled(e.client);
  assert.equal(e.calls.length, 1); assert.equal(e.client.view().pending, true); assert.equal(e.client.view().receipt, null);
  e.storage.setItem = write; await e.client.retry(); assert.equal(e.client.view().receipt.runId, 'run-a'); assert.equal(e.client.view().storageOkay, true);
});
test('failure to save a committed receipt keeps the exact retry and never releases navigation', async () => {
  const e = setup(url => {
    if (url.endsWith('/members')) return response(member);
    e.storage.setItem = () => { throw new Error('storage became full'); };
    return response({ runId: 'run-a', ranked: true });
  });
  await e.client.join('ABCDEFGH', '小星'); e.client.bindRun('run-a'); e.client.finish(Q.evaluate(assignment.entries, evidence)); await settled(e.client);
  assert.equal(e.client.view().receipt, null); assert.equal(e.client.view().pending, true); assert.match(e.client.view().message, /已收卷/);
});
test('malformed persisted join drafts are discarded and cannot crash joining', async () => {
  for (const value of [{ join: {} }, { join: { code: 'ABCDEFGH', body: null } }, { pending: evidence }, []]) {
    const e = setup(() => response(member)); e.data.set(e.key, JSON.stringify(value));
    const client = C.create(e.options); await client.join('ABCDEFGH', '小星'); assert.equal(client.view().accepted, true);
  }
});

test('student classroom errors use challenge wording without changing the server response', async () => {
  const serverError = { error: { code: 'expired', message: '測驗已到期。' } };
  const e = setup(() => response(serverError, 410));
  await e.client.join(member.code, member.alias);
  assert.equal(e.client.view().message, '小挑戰已到期。');
  assert.equal(serverError.error.message, '測驗已到期。');
});

function lockedRun(assigned) {
  const A=BishunAssessment;let run=A.startLocked(assigned,'automatic-client',1);
  for(const event of [{type:'DATA_READY',count:1},{type:'START_WORD'},{type:'STROKE_ACCEPTED',strokeIndex:0,stroke:[[1,2],[3,4]]},{type:'TIME',elapsedMs:1049},{type:'SUBMIT_CHARACTER'},{type:'SEAL'}])run=A.transition(run,event);
  return run;
}
test('automatic transport requires versioned canonical receipt, preserves only receipt in session storage and resumes automatic board',async()=>{
  const joined={...member,assignment:BishunAssessment.assignment(assignment.entries,'listen')},run=lockedRun(joined.assignment);let receipt={runId:run.runId,official:true};
  const board={version:4,policy:BishunAssessment.policy,expiresAt:joined.expiresAt,rows:[{memberId:joined.memberId,alias:joined.alias,isMe:true,rank:1,elapsedMs:1000}]};
  const e=setup(url=>response(url.endsWith('/members')?joined:url.endsWith('/automatic-board')?board:receipt));await e.client.join(member.code,member.alias);
  await assert.rejects(e.client.submitAutomatic(run),/回應無效/);assert.equal(e.client.view().receipt,null);
  receipt={version:4,policy:BishunAssessment.policy,runId:run.runId,official:true,elapsedMs:1000};await e.client.submitAutomatic(run);
  assert(!e.data.get(e.key).includes('"strokes":'));assert(e.calls.filter(call=>call.method==='PUT').every(call=>call.url.endsWith('/automatic-answers')));
  const reload=C.create(e.options);reload.continueMember();await reload.refresh();assert.equal(reload.view().board.automatic,true);assert.equal(reload.view().board.personalBest.elapsedMs,1000);
  receipt={...receipt,elapsedMs:1100};await assert.rejects(e.client.submitAutomatic(run),/回應無效/);
});

test('automatic private cold recovery validates original and cannot restore a switched identity',async()=>{
  const joined={...member,assignment:BishunAssessment.assignment(assignment.entries,'copy')},run=lockedRun(joined.assignment),receipt={version:4,policy:BishunAssessment.policy,runId:run.runId,official:true,elapsedMs:1000};let finish;
  const e=setup(url=>url.endsWith('/members')?response(joined):new Promise(resolve=>{finish=resolve;}));await e.client.join(member.code,member.alias);
  const pending=e.client.ownAutomaticAnswer();e.client.leave();finish(response({answer:{run,receipt}}));await assert.rejects(pending,/身份/);assert.equal(e.client.view().receipt,null);assert.equal(e.client.view().member,null);
});

test('automatic failed receipt persistence reports recoverable error and never falls back to reviewed routes',async()=>{
  const joined={...member,assignment:BishunAssessment.assignment(assignment.entries,'copy')},run=lockedRun(joined.assignment),receipt={version:4,policy:BishunAssessment.policy,runId:run.runId,official:true,elapsedMs:1000};
  const e=setup(url=>response(url.endsWith('/members')?joined:receipt));await e.client.join(member.code,member.alias);e.storage.setItem=()=>{throw new Error('quota');};await assert.rejects(e.client.submitAutomatic(run),/回條/);
  assert(e.calls.at(-1).url.endsWith('/automatic-answers'));assert.equal(e.calls.filter(call=>call.url.endsWith('/answers')).length,0);
});
