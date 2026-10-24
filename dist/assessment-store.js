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
    async function transaction(mode, operation, guard = () => {}) {
      const db = await database();
      guard();
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
    async function put(value, guard = () => {}) {
      const snapshot = structuredClone(value);
      const db = await database();
      guard();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('records', 'readwrite'), store = tx.objectStore('records'), request = store.get(snapshot.key); let failure;
        request.onsuccess = () => {
          try {
            guard();
            if (snapshot.expiresAt <= Date.now()) throw new Error('測驗已到期。');
            if (request.result?.run?.phase === 'sealed' && JSON.stringify(request.result.run) !== JSON.stringify(snapshot.run)) throw new Error('原卷已封存，請重新開啟原卷。');
            if ((request.result?.revision || 0) !== (snapshot.revision || 0)) throw new Error('另一分頁已更新原稿。眼前筆跡仍保留，請勿關頁，請老師協助。');
            snapshot.revision = (snapshot.revision || 0) + 1;
            store.put(snapshot);
          } catch (problem) { failure = problem; tx.abort(); }
        };
        tx.oncomplete = () => resolve(snapshot);
        tx.onabort = tx.onerror = () => reject(failure || tx.error || new Error('原稿未能保存，請保持頁面開啟再試。'));
      });
    }
    function putMany(values, guard) {
      const snapshots = structuredClone(values);
      return transaction('readwrite', store => { for (const value of snapshots) store.put(value); }, guard);
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
    async function initialize(scope, candidate, guard = () => {}) {
      const db = await database(), snapshot = structuredClone(candidate);
      guard();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('records', 'readwrite'), store = tx.objectStore('records'); let saved, failure;
        const pointer = store.get(scope);
        function valid() { try { guard(); if (snapshot.expiresAt <= Date.now()) throw new Error('測驗已到期。'); return true; } catch (problem) { failure = problem; tx.abort(); return false; } }
        function insert() { if (!valid()) return; saved = { ...snapshot, revision: 1 }; store.put(saved); store.put({ key: scope, runKey: saved.key, expiresAt: saved.expiresAt }); }
        pointer.onsuccess = () => {
          if (!valid()) return;
          if (!pointer.result || pointer.result.expiresAt <= Date.now()) { insert(); return; }
          const existing = store.get(pointer.result.runKey);
          existing.onsuccess = () => { if (!valid()) return; if (existing.result?.expiresAt > Date.now()) saved = existing.result; else insert(); };
        };
        tx.oncomplete = () => resolve(saved);
        tx.onabort = tx.onerror = () => reject(failure || tx.error || new Error('原稿未能保存。'));
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
