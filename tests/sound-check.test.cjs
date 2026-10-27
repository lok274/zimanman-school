'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync(require('node:path').join(__dirname, '../dist/sound-check.html'), 'utf8');
function boot(speechSynthesis) {
  const result = {}, button = { addEventListener(_name, fn) { this.click = fn; } };
  vm.runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], {
    window: { speechSynthesis }, document: { getElementById: id => id === 'voices' ? result : button }
  });
  return { result, button };
}
test('voice diagnostic reads raw metadata at startup, on change and on demand', () => {
  let voices = [], changed;
  const e = boot({ getVoices: () => voices, addEventListener(name, fn) { assert.equal(name, 'voiceschanged'); changed = fn; } });
  assert.equal(e.result.value, '語音數目：0');
  voices = [{ lang: 'zh-Hant-HK', name: '<Hong Kong>' }, { lang: 'zh-CN', name: 'Mandarin' }]; changed();
  assert.equal(e.result.value, '語音數目：2\nzh-Hant-HK | <Hong Kong>\nzh-CN | Mandarin');
  voices = []; e.button.click(); assert.equal(e.result.value, '語音數目：0');
  assert.match(html, /<textarea[^>]*\breadonly\b/);
});
test('voice diagnostic reports unsupported or failed browser APIs', () => {
  assert.equal(boot().result.value, '此瀏覽器不支援語音。');
  assert.equal(boot({ getVoices() { throw new Error('unavailable'); }, addEventListener() {} }).result.value, '未能讀取瀏覽器語音。');
});
