'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('../dist/assessment-store.js');
function indexedDatabase() {
  let records = new Map(), tail = Promise.resolve(), fail = false;
  const database = {
    createObjectStore() { return { createIndex() {} }; },
    transaction(_name, mode) {
      let stopped = false, scheduled = false, working;
      const operations = [];
      const tx = { error: null, abort() { stopped = true; }, objectStore() { return store; } };
      function request(fn) { const result = {}; operations.push(() => { result.result = fn(); result.onsuccess?.(); }); return result; }
      const store = {
        get(key) { return request(() => structuredClone(working.get(key))); },
        getAll() { return request(() => structuredClone([...working.values()])); },
        put(value) { const copy = structuredClone(value); return request(() => { working.set(copy.key, copy); return copy.key; }); },
        delete(key) { return request(() => working.delete(key)); },
        index() { return { openCursor() {
          const result = {}; let keys, index = 0;
          function advance() {
            keys ||= [...working.keys()];
            const key = keys[index++];
            result.result = key === undefined ? null : { value: structuredClone(working.get(key)), delete() { working.delete(key); }, continue() { operations.push(advance); } };
            result.onsuccess?.();
          }
          operations.push(advance); return result;
        } }; },
      };
      tail = tail.then(async () => {
        scheduled = true; working = new Map([...records].map(([key, value]) => [key, structuredClone(value)]));
        if (mode === 'readwrite' && fail) { fail = false; stopped = true; tx.error = new Error('quota failure'); }
        await new Promise(resolve => setImmediate(resolve));
        while (operations.length && !stopped) operations.shift()();
        if (stopped) tx.onabort?.();
        else { if (mode === 'readwrite') records = working; tx.oncomplete?.(); }
      });
      assert.equal(scheduled, false, 'IndexedDB requests are asynchronous');
      return tx;
    },
  };
  return {
    failNext() { fail = true; }, get records() { return records; },
    open() { const request = { result: database }; queueMicrotask(() => { request.onupgradeneeded?.(); request.onsuccess?.(); }); return request; },
  };
}
const draft = (key, expiresAt = Date.now() + 10000) => ({ key, expiresAt, run: { phase: 'writing', answers: [{ strokes: [[[100, 200, 0], [300, 400, 20]]] }] } });
test('store request ordering retains a snapshot on reload and fails without replacing previous ink', async () => {
  const db = indexedDatabase(), store = create(db), record = draft('class:a:member:b:run:c');
  await store.put(record); const next = structuredClone(record); next.run.answers[0].strokes.push([[500, 500, 1]]);
  db.failNext(); await assert.rejects(store.put(next), /quota failure/);
  assert.deepEqual(await create(db).get(record.key), record);
  await store.put(next); assert.deepEqual(await create(db).get(next.key), next);
  const pending = store.put(next); next.run.answers[0].strokes.length = 0; await pending;
  assert.equal((await store.get(record.key)).run.answers[0].strokes.length, 2);
});
test('atomic initialization keeps separate member scopes and a sealed original cannot be overwritten', async () => {
  const db = indexedDatabase(), a = create(db), b = create(db);
  const [first, second] = await Promise.all([a.initialize('class:a:member:b', draft('run:first')), b.initialize('class:a:member:b', draft('run:second'))]);
  assert.equal(first.key, second.key); assert.equal(db.records.has('run:second'), false);
  const other = await b.initialize('class:a:member:c', draft('run:other')); assert.equal(other.key, 'run:other');
  first.run.phase = 'sealed'; await a.put(first);
  const modified = structuredClone(first); modified.run.answers[0].strokes = [];
  await assert.rejects(b.put(modified), /封存/); assert.deepEqual((await a.get(first.key)).run, first.run);
  first.review = { score: 1 }; await a.put(first); assert.equal((await b.get(first.key)).review.score, 1);
});
test('expiry purges only expired records including pointers and challenge copies', async () => {
  const db = indexedDatabase(), store = create(db);
  await store.putMany([draft('expired', 1), draft('expired:challenge', 1), { key: 'scope', runKey: 'expired', expiresAt: 1 }, draft('live')]);
  assert.equal(await store.get('expired'), null);
  await store.purge(); assert.deepEqual([...db.records.keys()], ['live']);
});
test('local review never lists classroom caches and the next pupil preserves sealed originals', async () => {
  const store = create(indexedDatabase()), first = { ...draft('local:assignment:one'), kind: 'official' };
  first.run.phase = 'sealed'; first.run.startedAt = 10;
  await store.initialize('local:assignment', first);
  assert.equal((await store.activeLocal()).key, first.key);
  await store.put({ ...first, key: 'class:room:member:one' });
  await store.put({ ...first, key: 'local:assignment:one:challenge', kind: 'challenge' });
  await store.release('local:assignment', first.key);
  assert.equal(await store.activeLocal(), null);
  assert.equal(await store.get('local:assignment'), null); assert.deepEqual(await store.get(first.key), first);
  await store.initialize('local:assignment', draft('local:assignment:two'));
  assert.deepEqual((await store.localOriginals()).map(row => row.key), [first.key]);
  await store.release('local:assignment', first.key);
  assert.equal((await store.get('local:assignment')).runKey, 'local:assignment:two');
});
