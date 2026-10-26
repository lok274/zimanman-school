'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
require('../dist/quiz-results.js');
const A = require('../dist/assessment.js');
const assigned = A.assignment([{ text: '來去', selectedIndexes: [0,1] }], 'listen');
const stroke = [[1000,2000],[1500,2500]];
function complete(elapsed = 1051) {
  let run = A.startLocked(assigned, 'locked', 1);
  for (let index = 0; index < 2; index++) {
    if (index) run = A.transition(run, {type:'NEXT_CHARACTER'});
    for (const event of [{type:'DATA_READY',count:2},{type:'START_WORD'}, {type:'STROKE_ACCEPTED',strokeIndex:0,stroke}, {type:'STROKE_ACCEPTED',strokeIndex:1,stroke}, {type:'WRITING_COMPLETE'}, {type:'TIME',elapsedMs:elapsed},{type:'SUBMIT_CHARACTER'}]) run = A.transition(run,event);
  }
  return A.transition(run,{type:'SEAL'});
}

test('v4 accepted prefix rejects gaps, incomplete Complete/Submit and immutable submitted answers', () => {
  let run = A.startLocked(assigned,'locked');
  assert.throws(()=>A.transition(run,{type:'START_WORD'}));
  run = A.transition(run,{type:'DATA_READY',count:2});run=A.transition(run,{type:'START_WORD'});
  for(const type of ['WRITING_COMPLETE','SUBMIT_CHARACTER']) assert.throws(()=>A.transition(run,{type}));
  assert.throws(()=>A.transition(run,{type:'STROKE_ACCEPTED',strokeIndex:1,stroke}));
  run=A.transition(run,{type:'STROKE_ACCEPTED',strokeIndex:0,stroke}); assert.throws(()=>A.transition(run,{type:'STROKE_ACCEPTED',strokeIndex:0,stroke}));
  run=A.transition(run,{type:'STROKE_ACCEPTED',strokeIndex:1,stroke});assert(A.completeAnswer(run.answers[0]));
  assert.throws(()=>A.transition(run,{type:'STROKE_ACCEPTED',strokeIndex:2,stroke}));
  const undo=A.transition(run,{type:'UNDO'});assert(!A.completeAnswer(undo.answers[0]));assert.equal(undo.answers[0].strokes.length,1);
  run=A.transition(run,{type:'SUBMIT_CHARACTER'});assert.throws(()=>A.transition(run,{type:'UNDO'}));assert.throws(()=>A.transition(run,{type:'TIME',elapsedMs:2}));
  assert.throws(()=>A.transition(run,{type:'SEAL'}));
});

test('canonical v4 validates actual mode, full targets, bounded original two-coordinate ink and time totals', () => {
  const run=complete(); assert.equal(A.actualMode(run),'copy');assert.deepEqual(A.validateAutomatic(assigned,run,{來:2,去:2}),run);
  assert.throws(()=>A.validateSubmission(assigned,run));
  for(const change of [value=>value.answers[0].strokes.pop(),value=>value.answers[0].expectedStrokes=1,value=>value.answers[0].strokes[0][0].push(0),value=>value.answers[0].strokes[0][0][0]=-1,value=>value.answers[0].strokes[0][0][0]=10001,value=>value.answers[0].strokes[0][0][0]=.1,value=>value.wordProgress[0].elapsedMs++,value=>value.presentationMode='listen',value=>value.policy='freehand',value=>value.answers[0].status='skipped']){
    const changed=structuredClone(run);change(changed);assert.throws(()=>A.validateAutomatic(assigned,changed,{來:2,去:2}));
  }
  assert.throws(()=>A.validateAutomatic(assigned,run,{來:8,去:5}));
  const forged={...run,score:100,rank:1};assert(!('score' in A.validateAutomatic(assigned,forged)));assert(!('rank' in A.validateAutomatic(assigned,forged)));
});

test('time rankings round the total once and share the exact displayed-time tie', () => {
  const run=complete(1049);assert.equal(run.elapsedMs,2098);assert.equal(A.boardTime(run.elapsedMs),2100);
  const rows=A.timeRanks([{alias:'甲',elapsedMs:A.boardTime(2049)},{alias:'乙',elapsedMs:A.boardTime(2051)},{alias:'丙',elapsedMs:A.boardTime(2099)},{alias:'丁',elapsedMs:A.boardTime(2500)}]);
  assert.deepEqual(rows.map(row=>row.rank),[1,2,2,4]);assert.deepEqual(rows.map(row=>row.elapsedMs),[2000,2100,2100,2500]);
});

test('acceptance checks total ink capacity before mutating original progress', () => {
  let run=A.startLocked(assigned,'capacity');run=A.transition(run,{type:'DATA_READY',count:64});run=A.transition(run,{type:'START_WORD'});
  const large=Array.from({length:16384},()=>[10000,10000]);let failed=false;
  for(let index=0;index<64;index++) { const before=JSON.stringify(run);try { run=A.transition(run,{type:'STROKE_ACCEPTED',strokeIndex:index,stroke:large}); } catch { assert.equal(JSON.stringify(run),before);failed=true;break; } }
  assert(failed);
});
