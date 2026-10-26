'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const dist = path.join(__dirname, '..', 'dist');
const scripts = ['vendor/hanzi-writer.min.js', 'data/characters.js', 'content.js', 'session.js', 'quiz-results.js', 'assessment.js', 'assessment-store.js', 'freehand.js', 'classroom.js', 'assessment-ui.js', 'character-data.js', 'writing.js', 'app.js'];
let html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
html = html.replace('<body>', '<body data-standalone>');
for (const file of ['styles.css', 'assessment.css']) {
  const tags = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].filter(match => match[1].split('?')[0] === file);
  assert.equal(tags.length, 1, 'exactly one stylesheet tag for ' + file);
  html = html.replace(tags[0][0], () => '<style>\n' + fs.readFileSync(path.join(dist, file), 'utf8') + '\n</style>');
}
for (const file of scripts) {
  const tags = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].filter(match => match[1].split('?')[0] === file);
  assert.equal(tags.length, 1, 'exactly one script tag for ' + file);
  let source = fs.readFileSync(path.join(dist, file), 'utf8');
  if (file === 'content.js') {
    const context = {}; vm.runInNewContext(source, context);
    for (const imagePath of Object.values(context.BishunContent.photos)) {
      const dataUrl = 'data:image/webp;base64,' + fs.readFileSync(path.join(dist, imagePath)).toString('base64');
      source = source.replaceAll(imagePath, () => dataUrl);
    }
  }
  source = source.replace(/<\/script/gi, '<\\/script');
  html = html.replace(tags[0][0], () => '<script>\n' + source + '\n</script>');
}
const escape = value => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const licenses = [['data/ARPHICPL.TXT', 'Arphic Public License 全文'], ['data/NOTICE.txt', '字庫來源及修改紀錄'], ['LICENSES/hanzi-writer-MIT.txt', 'Hanzi Writer 3.5.0 MIT 授權']];
for (const [file, label] of licenses) {
  const link = new RegExp('<a href="' + file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"[^>]*>[^<]*</a>');
  assert(link.test(html), 'license link exists for ' + file);
  html = html.replace(link, () => '<details><summary>' + label + '</summary><pre class="license-text">' + escape(fs.readFileSync(path.join(dist, file), 'utf8')) + '</pre></details>');
}
assert(!/<script\s+src=/.test(html), 'no external runtime scripts');
assert(!/<link\s+rel="stylesheet"/.test(html), 'no external stylesheets');
assert(html.includes('ARPHIC PUBLIC LICENSE') || html.includes('Arphic Public License'), 'complete license included');
fs.writeFileSync(path.join(dist, 'standalone.html'), html, 'utf8');
console.log('Built dist/standalone.html (' + Buffer.byteLength(html) + ' bytes).');
