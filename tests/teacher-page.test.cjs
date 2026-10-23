'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { webcrypto } = require('node:crypto');
const root = path.join(__dirname, '../classroom-service');
execFileSync(process.execPath, [path.join(root, 'build.mjs')]);
const page = fs.readFileSync(path.join(root, 'src/teacher-page.js'), 'utf8');
const html = JSON.parse(page.slice('export default '.length, -2));
const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
function boot({ data = new Map(), hash = '', blocked = false } = {}) {
  const nodes = new Map();
  for (const id of ['status', 'assignment', 'create', 'room', 'code', 'expiry', 'refresh', 'board']) nodes.set(id, { textContent: '', hidden: id === 'room', addEventListener() {} });
  const storage = { getItem: key => data.get(key) || null, setItem(key, value) { if (blocked) throw new Error('blocked'); data.set(key, value); } };
  vm.runInNewContext(script, { document: { getElementById: id => nodes.get(id) }, crypto: webcrypto, sessionStorage: storage, location: { hash }, history: { replaceState() {} } });
  return { nodes, draft: JSON.parse(data.get('zimanman:teacher') || 'null'), data };
}

test('ordinary teacher page gets canonical six-word scope and retains its request after reload', () => {
  const e = boot();
  const content = {}; vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../dist/content.js'), 'utf8'), content);
  assert.deepEqual(e.draft.entries.map(entry => entry.text), Array.from(content.BishunContent.words));
  for (const entry of e.draft.entries) assert.deepEqual(entry.selectedIndexes, Array.from(entry.text, (_, i) => i));
  assert.equal(e.nodes.get('create').disabled, false);
  assert.equal(boot({ data: e.data }).draft.requestId, e.draft.requestId);
});

test('selected scope remains optional and storage failure disables creation before writing', () => {
  const entries = [{ text: '推來推去', selectedIndexes: [3] }];
  const e = boot({ hash: '#' + encodeURIComponent(JSON.stringify({ entries })) });
  assert.deepEqual(e.draft.entries, entries); assert.equal(e.nodes.get('assignment').textContent, '去');
  const denied = boot({ blocked: true });
  assert.equal(denied.draft, null); assert.equal(denied.nodes.get('create').disabled, true);
  assert.match(denied.nodes.get('status').textContent, /儲存/);
});

test('standalone service export builds with exact shared content and scorer copies', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'bishun-service-export-'));
  try {
    fs.cpSync(root, fixture, { recursive: true, filter: file => !['node_modules', '.wrangler', 'dist', 'shared'].includes(path.basename(file)) });
    fs.mkdirSync(path.join(fixture, 'shared'));
    for (const file of ['quiz-results.js', 'content.js']) fs.copyFileSync(path.join(__dirname, '../dist', file), path.join(fixture, 'shared', file));
    execFileSync(process.execPath, [path.join(fixture, 'build.mjs')]);
    assert.equal(fs.readFileSync(path.join(fixture, 'dist/server/index.js'), 'utf8'), fs.readFileSync(path.join(root, 'dist/server/index.js'), 'utf8'));
  } finally {
    assert.equal(path.dirname(path.resolve(fixture)), path.resolve(os.tmpdir()));
    assert(path.basename(fixture).startsWith('bishun-service-export-'));
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
