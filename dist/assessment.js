(function (root) {
  'use strict';
  const limits = Object.freeze({ bytes: 4194304, points: 200000, strokes: 256, positions: 48, coordinate: 10000, duration: 86400000 });
  function assignment(entries, mode) {
    if (!['copy', 'listen'].includes(mode)) throw new Error('請揀照寫或聽寫。');
    const base = root.BishunQuizResults.assignment(entries);
    return { version: 2, mode, entries: base.entries };
  }
  function positions(assigned) { return assigned.entries.flatMap((entry, wordIndex) => entry.selectedIndexes.map(index => ({ id: 'w' + wordIndex + ':' + index, word: entry.text, index, character: Array.from(entry.text)[index] }))); }
  function start(assigned, runId, now = Date.now()) {
    return { version: 2, runId, assignment: assignment(assigned.entries, assigned.mode), startedAt: now, elapsedMs: 0, phase: 'writing', cursor: 0, answers: positions(assigned).map(item => ({ occurrenceId: item.id, status: 'draft', strokes: [] })) };
  }
  function ink(strokes, count) {
    if (!Array.isArray(strokes) || strokes.length > limits.strokes) throw new Error('每字最多 256 筆，原筆跡仍然保留，請返回檢查。');
    return strokes.map(stroke => {
      if (!Array.isArray(stroke) || !stroke.length) throw new Error('筆跡資料無效。');
      let previous = -1;
      return stroke.map(point => {
        count.n++;
        if (count.n > limits.points) throw new Error('筆跡超出容量，原稿仍然保留，請聯絡老師。');
        if (!Array.isArray(point) || point.length !== 3 || point.some(n => !Number.isSafeInteger(n)) || point[0] < 0 || point[0] > limits.coordinate || point[1] < 0 || point[1] > limits.coordinate || point[2] < 0 || point[2] < previous || point[2] > limits.duration) throw new Error('筆跡座標或時間無效。');
        previous = point[2]; return [...point];
      });
    });
  }
  function validateSubmission(assigned, run) {
    const canonical = assignment(assigned.entries, assigned.mode), expected = positions(canonical), count = { n: 0 };
    if (run?.version !== 2 || typeof run.runId !== 'string' || !/^[\w-]{1,100}$/.test(run.runId) || run.phase !== 'sealed' || JSON.stringify(run.assignment) !== JSON.stringify(canonical) || !Number.isSafeInteger(run.startedAt) || run.startedAt < 0 || !Number.isSafeInteger(run.elapsedMs) || run.elapsedMs < 0 || run.elapsedMs > limits.duration || !Array.isArray(run.answers) || run.answers.length !== expected.length) throw new Error('測驗紀錄或題目不一致。');
    const answers = run.answers.map((answer, index) => {
      if (!answer || answer.occurrenceId !== expected[index].id || !['submitted', 'skipped'].includes(answer.status)) throw new Error('請先提交或跳過每一字。');
      const strokes = ink(answer.strokes, count);
      if (answer.status === 'submitted' && !strokes.length) throw new Error('未寫字，請先書寫或選跳過。');
      return { occurrenceId: answer.occurrenceId, status: answer.status, strokes };
    });
    const result = { version: 2, runId: run.runId, assignment: canonical, startedAt: run.startedAt, elapsedMs: run.elapsedMs, phase: 'sealed', answers };
    if (new TextEncoder().encode(JSON.stringify(result)).length > limits.bytes) throw new Error('筆跡超出容量，原稿仍然保留，請聯絡老師。');
    return result;
  }
  function transition(run, event) {
    if (run.phase !== 'writing') throw new Error('原卷已封存。');
    const next = structuredClone(run), answer = next.answers[next.cursor];
    if (event.type === 'STROKE') { if (answer.status !== 'draft') throw new Error('此字已提交。'); answer.strokes.push(event.stroke); }
    else if (event.type === 'UNDO') { if (answer.status !== 'draft') throw new Error('此字已提交。'); answer.strokes.pop(); }
    else if (event.type === 'ANSWER') {
      if (answer.status !== 'draft' || !['submitted', 'skipped'].includes(event.status)) throw new Error('此字已提交。');
      if (event.status === 'submitted' && !answer.strokes.length) throw new Error('未寫字，請先書寫或選跳過。');
      ink(answer.strokes, { n: 0 }); answer.status = event.status;
      next.cursor = Math.min(next.cursor + 1, next.answers.length - 1);
    } else if (event.type === 'SELECT') {
      if (!Number.isInteger(event.index) || event.index < 0 || event.index >= next.answers.length) throw new Error('題目無效。');
      next.cursor = event.index;
    } else if (event.type === 'SEAL') {
      next.phase = 'sealed'; next.elapsedMs = Math.min(limits.duration, Math.max(0, Math.round(event.elapsedMs)));
      return validateSubmission(next.assignment, next);
    } else throw new Error('測驗操作無效。');
    return next;
  }
  function review(assigned, marks) {
    const expected = positions(assigned);
    if (!Array.isArray(marks) || marks.length !== expected.length) throw new Error('批改項目不完整。');
    const result = marks.map((mark, index) => {
      if (!mark || mark.occurrenceId !== expected[index].id || ![null, true, false].includes(mark.correct) || typeof mark.strokePractice !== 'boolean') throw new Error('批改資料無效。');
      return { occurrenceId: mark.occurrenceId, correct: mark.correct, strokePractice: mark.strokePractice };
    });
    return { marks: result, score: result.some(mark => mark.correct === null) ? null : result.filter(mark => mark.correct).length };
  }
  function unmarked(assigned) { return positions(assigned).map(item => ({ occurrenceId: item.id, correct: null, strokePractice: false })); }
  function ranks(rows) {
    let rank = 0;
    return rows.filter(row => Number.isInteger(row.score)).sort((a, b) => b.score - a.score || a.alias.localeCompare(b.alias)).map((row, i, sorted) => { if (!i || row.score !== sorted[i - 1].score) rank = i + 1; return { ...row, rank }; });
  }
  const api = { limits, assignment, positions, start, transition, validateSubmission, review, unmarked, ranks };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.BishunAssessment = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
