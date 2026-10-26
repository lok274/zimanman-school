'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');

test('page asset URLs change when the application or stylesheet changes', () => {
  const dist = path.join(__dirname, '..', 'dist');
  for (const [page, assets] of [['index.html', ['app.js', 'session.js', 'writing.js', 'quiz-results.js', 'classroom.js', 'styles.css', 'assessment.js', 'assessment-store.js', 'freehand.js', 'character-data.js', 'assessment-ui.js', 'assessment.css']], ['leaderboard.html', ['leaderboard.js', 'quiz-results.js', 'assessment.js', 'classroom.js', 'styles.css']]]) {
    const html = fs.readFileSync(path.join(dist, page), 'utf8');
    for (const file of assets) {
      const version = createHash('sha256').update(fs.readFileSync(path.join(dist, file), 'utf8').replace(/\r\n/g, '\n')).digest('hex').slice(0, 12);
      assert(html.includes(file + '?v=' + version), file + ' URL must be ' + file + '?v=' + version);
    }
  }
});

test('the portable page embeds all word photos and preserves literal script text', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'bishun-standalone-'));
  try {
    const root = path.join(__dirname, '..'), dist = path.join(fixture, 'dist');
    fs.cpSync(path.join(root, 'dist'), dist, { recursive: true, filter: file => path.basename(file) !== 'standalone.html' });
    fs.mkdirSync(path.join(fixture, 'scripts'));
    fs.copyFileSync(path.join(root, 'scripts/standalone.cjs'), path.join(fixture, 'scripts/standalone.cjs'));
    const context = {}; vm.runInNewContext(fs.readFileSync(path.join(dist, 'content.js'), 'utf8'), context);
    fs.mkdirSync(path.join(dist, 'images'), { recursive: true });
    const paths = Object.values(context.BishunContent.photos);
    paths.forEach((file, index) => fs.writeFileSync(path.join(dist, file), Buffer.from('fixture-photo-' + index)));
    const literal = "// Literal replacement tokens $& $' $`";
    fs.appendFileSync(path.join(dist, 'app.js'), '\n' + literal + '\n');
    execFileSync(process.execPath, [path.join(fixture, 'scripts/standalone.cjs')]);
    const portable = fs.readFileSync(path.join(dist, 'standalone.html'), 'utf8');
    assert.equal((portable.match(/data:image\/webp;base64,/g) || []).length, 6);
    paths.forEach((file, index) => {
      assert(!portable.includes(file), 'no local photo dependency remains');
      assert(portable.includes('data:image/webp;base64,' + Buffer.from('fixture-photo-' + index).toString('base64')));
    });
    assert(portable.includes(literal), 'script replacement leaves dollar tokens unchanged');
    assert(!/<script\s+src=/.test(portable));
  } finally {
    assert.equal(path.dirname(path.resolve(fixture)), path.resolve(os.tmpdir()));
    assert(path.basename(fixture).startsWith('bishun-standalone-'));
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test('web and generated standalone expose the same simplified controls and student names', () => {
  for (const file of ['index.html', 'standalone.html']) {
    const html = fs.readFileSync(path.join(__dirname, '../dist', file), 'utf8');
    for (const id of ['hear-instruction', 'rest', 'rest-dialog', 'practice-tools', 'hint-stroke', 'hint-outline', 'retry-writing', 'speak-label']) assert(!html.includes('id="' + id + '"'), file + ': ' + id);
    assert.match(html, /id="undo-stroke"[^>]*>擦掉前一筆<\/button>/);
    assert.match(html, /id="start-quiz"[^>]*><strong>小挑戰<\/strong>/);
    assert.match(html, /id="speak"[^>]*><svg[^>]*aria-hidden="true"/);
    assert(html.includes('測驗題型')); assert(html.includes('用以上範圍開班級測驗'));
  }
  const css = fs.readFileSync(path.join(__dirname, '../dist/styles.css'), 'utf8');
  assert.match(css, /\.simplified-practice \.speech-button\{width:60px;min-width:60px;height:60px;min-height:60px/);
  assert.match(css, /\.speech-button:focus-visible\{outline:3px/);
  assert.match(css, /\.v4-practice\.simplified-practice \.semantic-cue\{display:block/);
});
