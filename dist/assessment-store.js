(function (root) {
  'use strict';
  function create(indexedDB = root.indexedDB) {
    let opening;
    function database() {
      if (!opening) opening = new Promise((resolve, reject) => {
        if (!indexedDB) { reject(new Error('此瀏覽器未能保存原稿，請開啟瀏覽器儲存。')); return; }
        const request = indexedDB.open('bishun-assessments-v2', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('records', { keyPath: 'key' }).createIndex('expiry', 'expiresAt');
        request.onerror = () => { opening = null; reject(request.error); };
        request.onblocked = () => { opening = null; reject(new Error('請關閉其他舊版測驗分頁後重試。')); };
        request.onsuccess = () => resolve(request.result);
      });
      return opening;
    }
    async function transaction(mode, operation) {
      const db = await database();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('records', mode), request = operation(tx.objectStore('records'));
        tx.oncomplete = () => resolve(request?.result);
        tx.onabort = tx.onerror = () => reject(tx.error || new Error('原稿未能保存，請保持頁面開啟再試。'));
      });
    }
    async function get(key, now = Date.now()) {
      const value = await transaction('readonly', store => store.get(key));
      if (value && value.expiresAt <= now) { await remove(key); return null; }
      return value || null;
    }
    async function put(value) {
      const snapshot = structuredClone(value);
      const db = await database();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('records', 'readwrite'), store = tx.objectStore('records'), request = store.get(snapshot.key); let conflict = false;
        request.onsuccess = () => {
          if (request.result?.run?.phase === 'sealed' && JSON.stringify(request.result.run) !== JSON.stringify(snapshot.run)) { conflict = true; tx.abort(); return; }
          store.put(snapshot);
        };
        tx.oncomplete = () => resolve();
        tx.onabort = tx.onerror = () => reject(conflict ? new Error('原卷已封存，請重新開啟原卷。') : tx.error || new Error('原稿未能保存，請保持頁面開啟再試。'));
      });
    }
    function putMany(values) {
      const snapshots = structuredClone(values);
      return transaction('readwrite', store => { for (const value of snapshots) store.put(value); });
    }
    function remove(key) { return transaction('readwrite', store => store.delete(key)); }
    async function localOriginals() {
      const records = await transaction('readonly', store => store.getAll());
      return records.filter(record => record.key.startsWith('local:') && record.kind === 'official' && record.run?.phase === 'sealed' && record.expiresAt > Date.now()).sort((a, b) => b.run.startedAt - a.run.startedAt);
    }
    async function activeLocal() {
      const records = await transaction('readonly', store => store.getAll()), now = Date.now();
      const pointers = new Set(records.filter(record => record.key.startsWith('local:') && record.runKey && record.expiresAt > now).map(record => record.runKey));
      return records.filter(record => pointers.has(record.key) && record.expiresAt > now).sort((a, b) => b.run.startedAt - a.run.startedAt)[0] || null;
    }
    async function release(scope, runKey) {
      await transaction('readwrite', store => {
        const request = store.get(scope);
        request.onsuccess = () => { if (request.result?.runKey === runKey) store.delete(scope); };
      });
    }
    async function initialize(scope, candidate) {
      const db = await database(), snapshot = structuredClone(candidate);
      return new Promise((resolve, reject) => {
        const tx = db.transaction('records', 'readwrite'), store = tx.objectStore('records'); let saved;
        const pointer = store.get(scope);
        function insert() { saved = snapshot; store.put(saved); store.put({ key: scope, runKey: saved.key, expiresAt: saved.expiresAt }); }
        pointer.onsuccess = () => {
          if (!pointer.result || pointer.result.expiresAt <= Date.now()) { insert(); return; }
          const existing = store.get(pointer.result.runKey);
          existing.onsuccess = () => { if (existing.result) saved = existing.result; else insert(); };
        };
        tx.oncomplete = () => resolve(saved);
        tx.onabort = tx.onerror = () => reject(tx.error || new Error('原稿未能保存。'));
      });
    }
    async function purge(now = Date.now()) {
      await transaction('readwrite', store => {
        const cursor = store.index('expiry').openCursor();
        cursor.onsuccess = () => { const item = cursor.result; if (!item) return; if (item.value.expiresAt <= now) item.delete(); item.continue(); };
      });
    }
    return { get, put, putMany, initialize, remove, localOriginals, activeLocal, release, purge };
  }
  const api = { create };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.BishunAssessmentStore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
