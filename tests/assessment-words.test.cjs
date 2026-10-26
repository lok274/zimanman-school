'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
globalThis.BishunQuizResults = require('../dist/quiz-results.js');
const A = require('../dist/assessment.js');
const assignment = A.assignment([{text:'推來推去',selectedIndexes:[0,2]},{text:'粗',selectedIndexes:[0]}], 'listen');
const stroke = [[1,2,0],[3000,4000,20]];
function word(run, hinted = false) {
  run = A.transition(run, {type:'START_WORD'});
  if (hinted) run = A.transition(run, {type:'HINT'});
  const end = A.wordAt(run).end;
  while (run.cursor < end) {
    run = A.transition(run, {type:'STROKE',stroke});
    if (run.cursor + 1 === end) return A.transition(run, {type:'SUBMIT_WORD'});
    run = A.transition(run, {type:'NEXT_CHARACTER'});
  }
}
test('word challenge requires Start and submits repeated selected positions atomically', () => {
  let run = A.startWords(assignment, 'word', 1);
  assert.throws(() => A.transition(run,{type:'STROKE',stroke}), /開始/);
  assert.throws(() => A.transition(run,{type:'HINT'}), /開始/);
  run = A.transition(run,{type:'START_WORD'}); run = A.transition(run,{type:'STROKE',stroke});
  assert.throws(() => A.transition(run,{type:'SUBMIT_WORD'}), /完成/);
  assert.equal(run.answers[0].status,'draft');
  run = A.transition(run,{type:'NEXT_CHARACTER'}); assert.equal(run.answers[0].status,'ready'); assert.equal(run.cursor,1);
  assert.throws(() => A.transition(run,{type:'NEXT_CHARACTER'}), /書寫/);
  run = A.transition(run,{type:'HINT'}); run = A.transition(run,{type:'STROKE',stroke}); run = A.transition(run,{type:'TIME',elapsedMs:4200});
  run = A.transition(run,{type:'SUBMIT_WORD'});
  assert.deepEqual(run.answers.map(a=>a.status),['submitted','submitted','draft']);
  assert.deepEqual(run.wordProgress.map(w=>w.phase),['submitted','unstarted']);
  assert.equal(run.answers[1].hintUsed,true); assert.equal(run.wordProgress[0].elapsedMs,4200);
  assert.throws(() => A.transition(run,{type:'ANSWER',status:'skipped'}), /整個詞語/);
  run = A.transition(run,{type:'SELECT',index:2}); run = word(run); run = A.transition(run,{type:'SEAL'});
  assert.equal(run.version,3); assert.equal(run.elapsedMs,4200); assert.equal(run.answers[1].hintUsed,true);
  assert.equal(run.presentationMode,'copy'); assert.equal(A.actualMode(run),'copy'); assert.equal(run.assignment.mode,'listen'); assert.equal(A.actualMode(A.start(assignment,'old',1)),'listen');
  assert.deepEqual(A.validateSubmission(assignment,run),run);
});
test('word timing and hint metadata are validated and survive canonical transport', () => {
  let run = word(A.startWords(assignment,'canonical',1),true);
  run = A.transition(run,{type:'SELECT',index:2}); run = word(run); run = A.transition(run,{type:'SEAL'});
  for (const change of [r=>r.presentationMode='listen',r=>r.answers[0].hintUsed='yes',r=>r.wordProgress[0].elapsedMs=-1,r=>r.wordProgress[0].wordId='w1',r=>r.elapsedMs=1,r=>r.wordProgress[0].phase='writing']) {
    const invalid=structuredClone(run); change(invalid); assert.throws(()=>A.validateSubmission(assignment,invalid));
  }
  assert.throws(()=>A.transition(A.startWords(assignment,'invalid',1),{type:'SEAL'}));
});
test('upgrading a legacy draft preserves ink and unknown historical time without changing sealed originals', () => {
  let old=A.start(assignment,'legacy',1); old=A.transition(old,{type:'STROKE',stroke}); old.elapsedMs=9000;
  const run=A.upgradeWords(old);
  assert.deepEqual(run.answers[0].strokes,old.answers[0].strokes);
  assert.equal(run.legacyElapsedMs,9000); assert.equal(run.elapsedMs,9000);
  assert(run.wordProgress.every(w=>w.elapsedMs===0&&!w.timeKnown));
  old.phase='sealed'; assert.equal(A.upgradeWords(old),old);
});
