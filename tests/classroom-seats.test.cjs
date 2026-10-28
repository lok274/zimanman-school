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
  let now = 0, serial = 0;
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
  const client = context.BishunClassroom.create(options);
  async function advance(ms) {
    const end = now + ms;
    while (true) {
      const next = [...timers].filter(([, task]) => task.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      now = next[1].at; timers.delete(next[0]); next[1].fn(); await settle();
    }
    now = end; await settle();
  }
  async function open(code = 'ABCDEFGH') { client.seatPicker({ code, active: true }); await settle(); }
  return { client, calls, storage, held, snapshot, joined, open, advance, reload: () => context.BishunClassroom.create(options), timers };
}

test('foreground polling is independent of joining and only confirmed holds become selected', async () => {
  const ack = deferred(); let claimed = false;
  const e = setup(call => { if (call.data?.action === 'claim' && !claimed) { claimed = true; return ack.promise; } });
  await e.open(); assert.equal(e.client.view().busy, false); assert.equal(e.client.view().seats.status, 'ready');
  const selecting = e.client.selectSeat(2); await settle();
  assert.equal(e.client.view().seats.selected, null); assert.equal(e.client.view().seats.choosing, true); assert.equal(e.client.view().busy, false);
  const claim = e.calls.find(call => call.data?.action === 'claim');
  ack.resolve(response({ seat: 2, expiresAt: claim.data.expiresAt, serverNow: 1000000, joinExpiresAt: 1900000 })); await selecting;
  assert.equal(e.client.view().seats.selected, 2);
  assert(!JSON.stringify(e.client.view()).includes(claim.data.token));
  e.held.set(1, { token: 'other' });
  await e.advance(10500);
  assert.equal(e.client.view().seats.occupied.includes(1), true);
  const renew = e.calls.find(call => call.data?.action === 'renew');
  assert.equal(renew.data.token, claim.data.token); assert(renew.data.expiresAt > claim.data.expiresAt);
  assert.equal(e.calls.filter(call => call.url.endsWith('/members')).length, 0);
  e.client.seatPicker({ active: false }); await settle();
  assert.equal(e.timers.size, 0); assert.equal(e.held.has(2), false);
});

test('a poll never overlaps a pending read and malformed or offline snapshots keep known occupancy', async () => {
  const read = deferred(); let gets = 0;
  const e = setup(call => {
    if (call.method === 'GET') { gets++; if (gets === 1) return response(e.snapshot([1])); if (gets === 2) return read.promise; if (gets === 3) return response({ occupied: [] }); throw new TypeError('Failed to fetch'); }
  });
  await e.open(); await e.advance(1500); await e.advance(4000);
  assert.equal(gets, 2); assert.equal(e.client.view().busy, false);
  read.resolve(response(e.snapshot([1, 3]))); await settle();
  await e.advance(1500); assert.equal(e.client.view().seats.status, 'offline'); assert.equal(Array.from(e.client.view().seats.occupied).join(), '1,3');
  await e.advance(1500); assert.match(e.client.view().seats.message, /未能同步/); assert.doesNotMatch(e.client.view().seats.message, /Failed to fetch/);
  assert.equal(Array.from(e.client.view().seats.occupied).join(), '1,3');
  await e.client.selectSeat(4); assert.equal(e.client.view().seats.selected, null);
  e.client.seatPicker({ active: false }); await settle(); assert.equal(e.timers.size, 0);
});

test('a rejected claim cannot enable Start and marks the contested number occupied', async () => {
  const e = setup(call => call.data?.action === 'claim' ? error('SEAT_TAKEN') : undefined);
  await e.open(); await e.client.selectSeat(1);
  assert.equal(e.client.view().seats.selected, null); assert.equal(e.client.view().seats.choosing, false); assert(e.client.view().seats.occupied.includes(1));
  e.client.seatPicker({ active: false }); await settle();
});

test('close, code changes and manual input compensate late claims without restoring an old choice', async () => {
  for (const action of ['close', 'code', 'manual']) {
    const ack = deferred(); let claimed = false;
    const e = setup(call => { if (call.data?.action === 'claim' && !claimed) { claimed = true; return ack.promise; } });
    await e.open(); const selecting = e.client.selectSeat(1); await settle();
    const claim = e.calls.find(call => call.data?.action === 'claim');
    if (action === 'manual') e.client.selectSeat(null);
    else e.client.seatPicker(action === 'code' ? { code: 'BCDEFGHJ', active: true } : { active: false });
    ack.resolve(response({ seat: 1, expiresAt: claim.data.expiresAt, serverNow: 1000000, joinExpiresAt: 1900000 }));
    await selecting; await settle();
    assert.equal(e.client.view().seats.selected, null, action);
    assert(e.calls.some(call => call.data?.action === 'release' && call.data.token === claim.data.token), action);
    assert.equal(e.calls.filter(call => call.url.endsWith('/members')).length, 0, action);
    if (action === 'code') assert.equal(e.client.view().seats.code, 'BCDEFGHJ');
    e.client.seatPicker({ active: false }); await settle(); assert.equal(e.timers.size, 0);
  }
});

test('timeouts retain the original absolute lease deadline despite a skewed device clock', async () => {
  const lost = deferred(); let attempts = 0;
  const e = setup(call => { if (call.data?.action === 'claim' && ++attempts === 1) return lost.promise; });
  await e.open(); const selecting = e.client.selectSeat(5); await settle();
  const original = e.calls.find(call => call.data?.action === 'claim');
  assert.equal(original.data.expiresAt, 1029000);
  await e.advance(8000); await selecting;
  assert.equal(original.signal.aborted, true); assert.equal(e.client.view().seats.selected, null);
  await e.advance(1000);
  const claims = e.calls.filter(call => call.data?.action === 'claim');
  assert.equal(claims.length, 2); assert.deepEqual(claims[1].data, original.data);
  assert.equal(e.client.view().seats.selected, 5);
  e.client.seatPicker({ active: false }); await settle();
  lost.resolve(response({ seat: 5, expiresAt: original.data.expiresAt, serverNow: 1000000, joinExpiresAt: 1900000 })); await settle();
  assert.equal(e.client.view().seats.selected, null); assert.equal(e.timers.size, 0);
});

test('background-style invalidation bounds orphan claims and reopening gets a fresh snapshot', async () => {
  const lost = deferred();
  const e = setup(call => call.data?.action === 'claim' ? lost.promise : undefined);
  await e.open(); const selecting = e.client.selectSeat(6); await settle();
  e.client.seatPicker({ active: false });
  await e.advance(8000); await selecting; await settle();
  assert.equal(e.timers.size, 0); assert.equal(e.client.view().seats.selected, null);
  assert(e.calls.some(call => call.data?.action === 'release'));
  await e.open(); assert.equal(e.client.view().seats.status, 'ready');
  e.client.seatPicker({ active: false }); await settle();
});

test('a pending join owns the hold and retries the exact saved identity after reload', async () => {
  let memberCalls = 0, savedBody;
  const e = setup(call => {
    if (call.url.endsWith('/members')) { memberCalls++; if (memberCalls === 1) { savedBody = call.body; throw new Error('lost response'); } return response(e.joined(call.data.alias)); }
  });
  await e.open(); await e.client.selectSeat(1); await e.client.join('ABCDEFGH', '1號');
  assert.equal(e.calls.filter(call => call.data?.action === 'release').length, 0);
  const pending = JSON.parse([...e.storage.values()][0]).join;
  assert.equal(JSON.parse(savedBody).seatToken, pending.body.seatToken);
  const reload = e.reload(); reload.seatPicker({ code: 'BCDEFGHJ', active: true }); await settle();
  assert.equal(reload.view().seats.status, 'inactive');
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
  await e.open(); await e.client.selectSeat(1);
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
    await e.open(); await e.client.selectSeat(1);
    const joining = e.client.join('ABCDEFGH', '1號'); await settle();
    e.client.leave(); const claim = e.calls.filter(call => call.data?.action === 'claim').at(-1);
    pending.resolve(response(stage === 'snapshot' ? e.snapshot() : { seat: 1, expiresAt: claim.data.expiresAt, serverNow: 1000000, joinExpiresAt: 1900000 }));
    await joining; await settle();
    assert.equal(e.client.view().member, null); assert.equal(e.client.view().joining, null); assert.equal(e.client.view().busy, false);
    assert.equal(e.calls.filter(call => call.url.endsWith('/members')).length, 1);
    assert.equal(e.calls.filter(call => call.data?.action === 'claim').length, stage === 'snapshot' ? 1 : 2);
    if (stage === 'claim') assert(e.calls.some(call => call.data?.action === 'release' && call.data.token === claim.data.token));
    assert.deepEqual(JSON.parse([...e.storage.values()][0]), {});
  }
});
