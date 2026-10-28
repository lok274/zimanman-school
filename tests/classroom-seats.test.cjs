'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const Q = require('../dist/quiz-results.js');
const A = require('../dist/assessment.js');
const source = fs.readFileSync(require.resolve('../dist/classroom.js'), 'utf8');
const assignment = Q.assignment([{ text: '一', selectedIndexes: [0] }]);
const response = (data, status = 200) => ({ ok: status === 200, status, json: async () => data });
const error = code => response({ error: { code, message: code } }, 409);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function settle() { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); }
function setup(handler) {
  const now = 0; let serial = 0;
  const timers = new Map(), calls = [], storage = new Map(), held = new Map();
  const snapshot = (occupied = [...held.keys()]) => ({ occupied, serverNow: 1000000 + now, joinExpiresAt: 1900000, expiresAt: 87400000 });
  const joined = alias => ({ code: 'ABCDEFGH', alias, memberId: 'member-one', assignment, expiresAt: 87400000 });
  const context = vm.createContext({ URL, AbortController, crypto: webcrypto, BishunAssessment: A, BishunQuizResults: Q, performance: { now: () => now }, Date: class extends Date { static now() { return 9999999999999; } }, setTimeout(fn, delay) { const id = ++serial; timers.set(id, { at: now + delay, fn }); return id; }, clearTimeout: id => timers.delete(id) });
  vm.runInContext(source, context);
  const options = { origin: 'https://class.test', storage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) }, fetch: async (url, init) => {
    const call = { url, ...init, data: init.body ? JSON.parse(init.body) : null }; calls.push(call);
    const custom = handler?.(call, { snapshot, joined, held });
    if (custom !== undefined) return custom;
    if (url.endsWith('/members')) return response(joined(call.data.alias));
    if (init.method === 'GET') return response(snapshot());
    const { action, seat, token, expiresAt } = call.data;
    if (action === 'release') { if (held.get(seat)?.token === token) held.delete(seat); return response({ released: true }); }
    held.set(seat, { token, expiresAt });
    return response({ seat, expiresAt, serverNow: 1000000 + now, joinExpiresAt: 1900000 });
  } };
  storage.set('bishun:classroom:v1:https://class.test', JSON.stringify({ join: { code: 'ABCDEFGH', body: { requestId: 'old-join', alias: '1號', memberToken: 'a'.repeat(64), seatToken: 'b'.repeat(64) } } }));
  const client = context.BishunClassroom.create(options);
  return { client, calls, storage, held, snapshot, joined, reload: () => context.BishunClassroom.create(options), timers };
}

test('a pending join owns the hold and retries the exact saved identity after reload', async () => {
  let memberCalls = 0, savedBody;
  const e = setup(call => {
    if (call.url.endsWith('/members')) { memberCalls++; if (memberCalls === 1) { savedBody = call.body; throw new Error('lost response'); } return response(e.joined(call.data.alias)); }
  });
  await e.client.join('ABCDEFGH', '1號');
  assert.equal(e.calls.filter(call => call.data?.action === 'release').length, 0);
  const pending = JSON.parse([...e.storage.values()][0]).join;
  assert.equal(JSON.parse(savedBody).seatToken, pending.body.seatToken);
  const reload = e.reload(); assert.equal(reload.seatPicker, undefined); assert.equal(reload.selectSeat, undefined);
  await reload.join('ABCDEFGH', '1號');
  assert.equal(e.calls.filter(call => call.url.endsWith('/members'))[1].body, savedBody);
  assert.equal(reload.view().accepted, true);
});

test('expired pending holds reacquire with the same token and one join operation owns the whole retry', async () => {
  const snapshot = deferred(); let memberCalls = 0, recovery = false;
  const e = setup(call => {
    if (call.url.endsWith('/members')) { memberCalls++; if (memberCalls === 1) { recovery = true; return error('LEASE_EXPIRED'); } }
    if (recovery && call.method === 'GET') return snapshot.promise;
  });
  const joining = e.client.join('ABCDEFGH', '1號'); await settle();
  assert.equal(e.client.view().busy, true);
  await e.client.join('ABCDEFGH', '1號'); assert.equal(memberCalls, 1);
  snapshot.resolve(response(e.snapshot())); await joining;
  assert.equal(memberCalls, 2); assert.equal(e.client.view().busy, false); assert.equal(e.client.view().accepted, true);
  const members = e.calls.filter(call => call.url.endsWith('/members'));
  assert.equal(members[0].body, members[1].body);
  assert.equal(e.calls.filter(call => call.data?.action === 'claim').at(-1).data.token, members[0].data.seatToken);
});

test('leaving during expired-join recovery prevents an old claim or compensates its late acknowledgement', async () => {
  for (const stage of ['snapshot', 'claim']) {
    const pending = deferred(); let recovery = false;
    const e = setup(call => {
      if (call.url.endsWith('/members')) { recovery = true; return error('LEASE_EXPIRED'); }
      if (recovery && (stage === 'snapshot' && call.method === 'GET' || stage === 'claim' && call.data?.action === 'claim')) return pending.promise;
    });
    const joining = e.client.join('ABCDEFGH', '1號'); await settle();
    e.client.leave(); const claim = e.calls.filter(call => call.data?.action === 'claim').at(-1);
    pending.resolve(response(stage === 'snapshot' ? e.snapshot() : { seat: 1, expiresAt: claim.data.expiresAt, serverNow: 1000000, joinExpiresAt: 1900000 }));
    await joining; await settle();
    assert.equal(e.client.view().member, null); assert.equal(e.client.view().joining, null); assert.equal(e.client.view().busy, false);
    assert.equal(e.calls.filter(call => call.url.endsWith('/members')).length, 1);
    assert.equal(e.calls.filter(call => call.data?.action === 'claim').length, stage === 'snapshot' ? 0 : 1);
    if (stage === 'claim') assert(e.calls.some(call => call.data?.action === 'release' && call.data.token === claim.data.token));
    assert.deepEqual(JSON.parse([...e.storage.values()][0]), {});
  }
});
