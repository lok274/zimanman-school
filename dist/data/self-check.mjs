import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const root = new URL('./', import.meta.url);
const load = name => JSON.parse(readFileSync(new URL(name, root), 'utf8'));
const expected = { 粗:11, 濃:16, 鬍:19, 鬚:22, 密:11, 剪:11, 草:10, 機:16, 推:11, 來:8, 去:5 };
const data = {};

function contours(path) {
  const tokens = path.match(/[MLQCZ]|-?\d+(?:\.\d+)?/g);
  assert(tokens?.length && path.replace(/[MLQCZ\s\d.\-]/g, '') === '', 'supported SVG path syntax');
  const result = [];
  let point = [0, 0], polygon = [];
  for (let i = 0; i < tokens.length;) {
    const operation = tokens[i++];
    const size = { M:2, L:2, Q:4, C:6, Z:0 }[operation];
    assert(size !== undefined, 'explicit SVG commands');
    const values = tokens.slice(i, i += size).map(Number);
    assert(values.length === size && values.every(Number.isFinite), 'finite SVG coordinates');
    if (operation === 'Z') {
      result.push(polygon);
      polygon = [];
      continue;
    }
    if (operation === 'M' || operation === 'L') {
      if (operation === 'M' && polygon.length) result.push(polygon);
      if (operation === 'M') polygon = [];
      point = values;
      polygon.push(point);
      continue;
    }
    const controls = [point];
    for (let j = 0; j < values.length; j += 2) controls.push(values.slice(j, j + 2));
    for (let step = 1; step <= 24; step++) {
      const t = step / 24;
      let level = controls;
      while (level.length > 1) level = level.slice(1).map((b, j) => b.map((v, k) => level[j][k] * (1-t) + v*t));
      polygon.push(level[0]);
    }
    point = controls.at(-1);
  }
  if (polygon.length) result.push(polygon);
  assert(result.length && result.every(p => p.length >= 3), 'nonempty closed stroke geometry');
  return result;
}

function segmentDistance(p, a, b) {
  const length = (b[0]-a[0])**2 + (b[1]-a[1])**2;
  const t = length ? Math.max(0, Math.min(1, ((p[0]-a[0])*(b[0]-a[0])+(p[1]-a[1])*(b[1]-a[1])) / length)) : 0;
  return Math.hypot(p[0]-a[0]-t*(b[0]-a[0]), p[1]-a[1]-t*(b[1]-a[1]));
}

function insideOrNear(point, polygons) {
  let inside = false;
  for (const polygon of polygons) {
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const a = polygon[i], b = polygon[j];
      if (segmentDistance(point, a, b) <= 20) return true;
      if ((a[1] > point[1]) !== (b[1] > point[1]) && point[0] < (b[0]-a[0]) * (point[1]-a[1]) / (b[1]-a[1]) + a[0]) inside = !inside;
    }
  }
  return inside;
}

const provenance = load('provenance.json');
assert.equal(provenance.characters.length, 11);
for (const [character, count] of Object.entries(expected)) {
  const file = `chars/${character}.json`;
  const raw = readFileSync(new URL(file, root));
  const item = load(file);
  data[character] = item;
  assert.equal(item.strokes.length, count, `${character} stroke count`);
  assert.equal(item.medians.length, count, `${character} matching medians`);
  const record = provenance.characters.find(record => record.character === character);
  assert.equal(createHash('sha256').update(raw).digest('hex'), record.outputSHA256, `${character} provenance hash`);
  if (record.modified) assert(item._notice?.changes && item._notice.modified === '2026-10-22', `${character} modification notice`);
  item.strokes.forEach((path, index) => {
    const polygons = contours(path);
    const median = item.medians[index];
    assert(median.length >= 2 && median.every(p => p.length === 2 && p.every(Number.isFinite)), `${character} finite median ${index+1}`);
    assert(median.every(p => insideOrNear(p, polygons)), `${character} median follows its own stroke ${index+1}`);
    assert(median.slice(1).reduce((sum, p, i) => sum + Math.hypot(p[0]-median[i][0], p[1]-median[i][1]), 0) > 15, `${character} nonzero stroke ${index+1}`);
  });
}
const grass = data.草;
assert.deepEqual(grass.radStrokes, [0,1,2,3], 'four-stroke grass radical');
assert(grass.medians[0].every(p => p[0] <= 510), 'first horizontal remains left');
assert(grass.medians[2].every(p => p[0] >= 550), 'third horizontal remains right');
assert(grass.medians[0][0][0] < grass.medians[0].at(-1)[0] && grass.medians[2][0][0] < grass.medians[2].at(-1)[0], 'horizontal direction');
assert(grass.medians[1][0][1] > grass.medians[1].at(-1)[1] && grass.medians[3][0][1] > grass.medians[3].at(-1)[1], 'vertical direction');
assert.deepEqual(data.密.medians[6][0], [726,515], '密 writes the right dot seventh');
assert.deepEqual(data.密.medians[7][0], [591,619], '密 writes the long falling stroke eighth');
assert.deepEqual(data.來.medians[1][0], [443,849], '來 writes the central vertical second');
assert.deepEqual(data.來.medians[2][0], [291,610], '來 writes the left falling stroke third');
console.log('PASS: 11 characters, 140 strokes, geometry, HK ordering, notices, and provenance hashes.');
