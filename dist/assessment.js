(function (root) {
  'use strict';
  const limits = Object.freeze({ bytes: 1800000, bodyBytes: 4194304, points: 200000, strokes: 256, positions: 48, coordinate: 10000, duration: 86400000 });
  function assignment(entries, mode) {
    if (!['copy', 'listen'].includes(mode)) throw new Error('請揀照寫或聽寫。');
    const base = root.BishunQuizResults.assignment(entries);
    return { version: 2, mode, entries: base.entries };
  }
  function positions(assigned) { return assigned.entries.flatMap((entry, wordIndex) => entry.selectedIndexes.map(index => ({ id: 'w' + wordIndex + ':' + index, word: entry.text, index, character: Array.from(entry.text)[index] }))); }
  function start(assigned, runId, now = Date.now()) {
    const canonical = assignment(assigned.entries, assigned.mode);
    return { version: 2, runId, assignment: canonical, startedAt: now, elapsedMs: 0, phase: 'writing', cursor: 0, answers: positions(canonical).map(item => ({ occurrenceId: item.id, status: 'draft', strokes: [] })) };
  }
  function startWords(assigned, runId, now = Date.now()) {
    const run = start(assigned, runId, now);
    return { ...run, version: 3, presentationMode: 'copy', legacyElapsedMs: 0, wordProgress: run.assignment.entries.map((entry, index) => ({ wordId: 'w' + index, phase: 'unstarted', elapsedMs: 0, timeKnown: true })), answers: run.answers.map(answer => ({ ...answer, hintUsed: false })) };
  }
  const policy = 'locked-strokes-0.9-v1';
  function startLocked(assigned, runId, now = Date.now()) {
    const run = startWords(assigned, runId, now);
    delete run.legacyElapsedMs;
    return { ...run, version: 4, policy, answers: run.answers.map(answer => ({ ...answer, expectedStrokes: null })) };
  }
  function lockedInk(strokes, count) {
    if (!Array.isArray(strokes) || strokes.length > 64) throw new Error('筆跡資料無效。');
    return strokes.map(stroke => {
      if (!Array.isArray(stroke) || stroke.length < 2 || stroke.length > 16384) throw new Error('筆跡資料無效。');
      return stroke.map(point => {
        if (++count.n > limits.points) throw new Error('筆跡超出容量，原稿仍然保留。');
        if (!Array.isArray(point) || point.length !== 2 || point.some(n => !Number.isSafeInteger(n) || n < 0 || n > limits.coordinate)) throw new Error('筆跡座標無效。');
        return [...point];
      });
    });
  }
  function targetCount(value) { return Number.isInteger(value) && value > 0 && value <= 64; }
  function completeAnswer(answer) { return targetCount(answer.expectedStrokes) && answer.strokes.length === answer.expectedStrokes; }
  function boardTime(milliseconds) { return Math.round(milliseconds / 100) * 100; }
  function validateAutomatic(assigned, run, counts) {
    const canonical = assignment(assigned.entries, assigned.mode), expected = positions(canonical), count = { n: 0 };
    if (run?.version !== 4 || run.policy !== policy || run.presentationMode !== 'copy' || typeof run.runId !== 'string' || !/^[\w-]{1,100}$/.test(run.runId) || run.phase !== 'sealed' || JSON.stringify(run.assignment) !== JSON.stringify(canonical) || !Number.isSafeInteger(run.startedAt) || run.startedAt < 0 || !Number.isSafeInteger(run.elapsedMs) || run.elapsedMs < 0 || run.elapsedMs > limits.duration || !Array.isArray(run.answers) || run.answers.length !== expected.length || !Array.isArray(run.wordProgress) || run.wordProgress.length !== canonical.entries.length) throw new Error('小挑戰紀錄或題目不一致。');
    const wordProgress = run.wordProgress.map((word, index) => {
      if (!word || word.wordId !== 'w' + index || word.phase !== 'submitted' || word.timeKnown !== true || !Number.isSafeInteger(word.elapsedMs) || word.elapsedMs < 0 || word.elapsedMs > limits.duration) throw new Error('詞語用時紀錄無效。');
      return { wordId: word.wordId, phase: 'submitted', elapsedMs: word.elapsedMs, timeKnown: true };
    });
    if (wordProgress.reduce((sum, word) => sum + word.elapsedMs, 0) !== run.elapsedMs) throw new Error('詞語用時紀錄不一致。');
    const answers = run.answers.map((answer, index) => {
      if (!answer || answer.occurrenceId !== expected[index].id || answer.status !== 'submitted' || typeof answer.hintUsed !== 'boolean' || !targetCount(answer.expectedStrokes) || counts && answer.expectedStrokes !== counts[expected[index].character]) throw new Error('請先完成每個字的筆順。');
      const strokes = lockedInk(answer.strokes, count);
      if (strokes.length !== answer.expectedStrokes) throw new Error('請先完成每個字的筆順。');
      return { occurrenceId: answer.occurrenceId, status: 'submitted', strokes, hintUsed: answer.hintUsed, expectedStrokes: answer.expectedStrokes };
    });
    const result = { version: 4, policy, runId: run.runId, assignment: canonical, presentationMode: 'copy', startedAt: run.startedAt, elapsedMs: run.elapsedMs, phase: 'sealed', wordProgress, answers };
    if (new TextEncoder().encode(JSON.stringify(result)).length > limits.bytes) throw new Error('筆跡超出容量，原稿仍然保留。');
    return result;
  }
  function lockedTransition(run, event) {
    if (run.phase !== 'writing') throw new Error('原卷已封存。');
    const next = structuredClone(run), answer = next.answers[next.cursor], group = wordAt(next), word = next.wordProgress[group.wordIndex];
    if (event.type === 'SELECT') {
      if (!Number.isInteger(event.index) || !next.answers[event.index]) throw new Error('題目無效。');
      next.cursor = event.index;
    } else if (event.type === 'DATA_READY') {
      if (!targetCount(event.count) || answer.expectedStrokes !== null && answer.expectedStrokes !== event.count || answer.strokes.length > event.count) throw new Error('字形資料不一致，原稿仍然保留。');
      answer.expectedStrokes = event.count;
    } else if (event.type === 'START_WORD') {
      if (word.phase === 'submitted' || !targetCount(answer.expectedStrokes)) throw new Error('請先載入字形。');
      word.phase = 'writing';
    } else if (event.type === 'SEAL') {
      next.phase = 'sealed'; return validateAutomatic(next.assignment, next);
    } else if (event.type === 'NEXT_CHARACTER') {
      if (answer.status !== 'submitted' || next.cursor + 1 >= group.end) throw new Error('請先交答案。');
      next.cursor++;
    } else {
      if (word.phase !== 'writing' || answer.status !== 'draft') throw new Error('請先按開始。');
      if (event.type === 'TIME') {
        if (!Number.isSafeInteger(event.elapsedMs) || event.elapsedMs < 0) throw new Error('計時紀錄無效。');
        const elapsed = Math.min(event.elapsedMs, limits.duration - next.elapsedMs); word.elapsedMs += elapsed; next.elapsedMs += elapsed;
      } else if (event.type === 'STROKE_ACCEPTED') {
        if (!targetCount(answer.expectedStrokes) || event.strokeIndex !== answer.strokes.length || answer.strokes.length >= answer.expectedStrokes) throw new Error('筆順紀錄不一致，原稿仍然保留。');
        answer.strokes.push(event.stroke); checkLockedInk(next);
      } else if (event.type === 'UNDO') answer.strokes.pop();
      else if (event.type === 'HINT') answer.hintUsed = true;
      else if (['WRITING_COMPLETE', 'SUBMIT_CHARACTER'].includes(event.type)) {
        if (!completeAnswer(answer)) throw new Error('請先完成此字的筆順。');
        if (event.type === 'SUBMIT_CHARACTER') {
          answer.status = 'submitted';
          if (next.answers.slice(group.start, group.end).every(item => item.status === 'submitted')) word.phase = 'submitted';
        }
      } else throw new Error('小挑戰操作無效。');
    }
    return next;
  }
  function checkLockedInk(run) {
    const count = { n: 0 };
    for (const answer of run.answers) {
      lockedInk(answer.strokes, count);
      if (answer.strokes.length && (!targetCount(answer.expectedStrokes) || answer.strokes.length > answer.expectedStrokes)) throw new Error('筆順紀錄不一致。');
    }
    if (new TextEncoder().encode(JSON.stringify(run)).length + 2048 > limits.bytes) throw new Error('筆跡超出容量，原稿仍然保留。');
  }
  function timeRanks(rows) {
    let rank = 0;
    return rows.slice().sort((a, b) => a.elapsedMs - b.elapsedMs || a.alias.localeCompare(b.alias)).map((row, i, sorted) => {
      if (!i || row.elapsedMs !== sorted[i - 1].elapsedMs) rank = i + 1;
      return { ...row, rank };
    });
  }
  function actualMode(run) { return [3, 4].includes(run.version) ? run.presentationMode : run.assignment.mode; }
  function wordAt(run, index = run.cursor) {
    let start = 0;
    for (let wordIndex = 0; wordIndex < run.assignment.entries.length; wordIndex++) {
      const end = start + run.assignment.entries[wordIndex].selectedIndexes.length;
      if (index >= start && index < end) return { wordIndex, start, end };
      start = end;
    }
    throw new Error('題目無效。');
  }
  function upgradeWords(run) {
    if (run.version !== 2 || run.phase !== 'writing') return run;
    const next = startWords(run.assignment, run.runId, run.startedAt);
    next.cursor = run.cursor; next.legacyElapsedMs = run.elapsedMs; next.elapsedMs = run.elapsedMs;
    next.answers = structuredClone(run.answers).map(answer => ({ ...answer, hintUsed: false }));
    for (const word of next.wordProgress) {
      const answers = next.answers.filter(answer => answer.occurrenceId.startsWith(word.wordId + ':'));
      const complete = answers.every(answer => answer.status === 'submitted');
      word.phase = complete ? 'submitted' : 'unstarted'; word.timeKnown = !run.elapsedMs && !answers.some(answer => answer.strokes.length);
      if (!complete) for (const answer of answers) answer.status = 'draft';
    }
    return next;
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
    if (![2, 3].includes(run?.version) || typeof run.runId !== 'string' || !/^[\w-]{1,100}$/.test(run.runId) || run.phase !== 'sealed' || JSON.stringify(run.assignment) !== JSON.stringify(canonical) || !Number.isSafeInteger(run.startedAt) || run.startedAt < 0 || !Number.isSafeInteger(run.elapsedMs) || run.elapsedMs < 0 || run.elapsedMs > limits.duration || !Array.isArray(run.answers) || run.answers.length !== expected.length) throw new Error('測驗紀錄或題目不一致。');
    if (run.version === 3) {
      if (run.presentationMode !== 'copy' || !Number.isSafeInteger(run.legacyElapsedMs) || run.legacyElapsedMs < 0 || !Array.isArray(run.wordProgress) || run.wordProgress.length !== canonical.entries.length) throw new Error('詞語用時紀錄無效。');
      const total = run.wordProgress.reduce((sum, word, index) => {
        if (!word || word.wordId !== 'w' + index || word.phase !== 'submitted' || !Number.isSafeInteger(word.elapsedMs) || word.elapsedMs < 0 || word.elapsedMs > limits.duration || typeof word.timeKnown !== 'boolean') throw new Error('詞語用時紀錄無效。');
        return sum + word.elapsedMs;
      }, run.legacyElapsedMs);
      if (total !== run.elapsedMs || total > limits.duration) throw new Error('詞語用時紀錄不一致。');
    }
    const answers = run.answers.map((answer, index) => {
      if (!answer || answer.occurrenceId !== expected[index].id || !['submitted', 'skipped'].includes(answer.status)) throw new Error('請先提交或跳過每一字。');
      if (run.version === 3 && (answer.status !== 'submitted' || typeof answer.hintUsed !== 'boolean')) throw new Error('請先提交每個詞語。');
      const strokes = ink(answer.strokes, count);
      if (answer.status === 'submitted' && !strokes.length) throw new Error('未寫字，請先書寫或選跳過。');
      return { occurrenceId: answer.occurrenceId, status: answer.status, strokes, ...(run.version === 3 ? { hintUsed: answer.hintUsed } : {}) };
    });
    const result = envelope({ ...run, assignment: canonical }, answers);
    if (new TextEncoder().encode(JSON.stringify(result)).length > limits.bytes) throw new Error('筆跡超出容量，原稿仍然保留，請聯絡老師。');
    return result;
  }
  function transition(run, event) {
    if (run.version === 4) return lockedTransition(run, event);
    if (run.phase !== 'writing') throw new Error('原卷已封存。');
    const next = structuredClone(run), answer = next.answers[next.cursor];
    if (run.version === 3) {
      const group = wordAt(next), word = next.wordProgress[group.wordIndex];
      if (event.type === 'START_WORD') { if (word.phase === 'submitted') throw new Error('此詞語已提交。'); word.phase = 'writing'; return next; }
      if (event.type === 'TIME') {
        if (word.phase !== 'writing' || !Number.isSafeInteger(event.elapsedMs) || event.elapsedMs < 0) throw new Error('計時紀錄無效。');
        const elapsed = Math.min(event.elapsedMs, limits.duration - next.elapsedMs); word.elapsedMs += elapsed; next.elapsedMs += elapsed; return next;
      }
      if (['STROKE', 'UNDO', 'HINT', 'NEXT_CHARACTER', 'SUBMIT_WORD'].includes(event.type) && (word.phase !== 'writing' || answer.status === 'submitted')) throw new Error('請先按開始。');
      if (event.type === 'HINT') { answer.hintUsed = true; return next; }
      if (event.type === 'NEXT_CHARACTER') {
        if (!answer.strokes.length) throw new Error('請先書寫。');
        if (next.cursor + 1 >= group.end) throw new Error('請提交此詞語。');
        answer.status = 'ready'; checkInk(next); next.cursor++; return next;
      }
      if (event.type === 'SUBMIT_WORD') {
        const answers = next.answers.slice(group.start, group.end);
        if (answers.some(item => !item.strokes.length)) throw new Error('請先完成此詞語。');
        for (const item of answers) item.status = 'submitted'; word.phase = 'submitted'; checkInk(next); return next;
      }
      if (event.type === 'ANSWER') throw new Error('請提交整個詞語。');
    }
    if (event.type === 'STROKE') { if (!['draft', 'ready'].includes(answer.status)) throw new Error('此字已提交。'); answer.strokes.push(event.stroke); }
    else if (event.type === 'UNDO') { if (!['draft', 'ready'].includes(answer.status)) throw new Error('此字已提交。'); answer.strokes.pop(); }
    else if (event.type === 'ANSWER') {
      if (answer.status !== 'draft' || !['submitted', 'skipped'].includes(event.status)) throw new Error('此字已提交。');
      if (event.status === 'submitted' && !answer.strokes.length) throw new Error('未寫字，請先書寫或選跳過。');
      answer.status = event.status; checkInk(next);
      next.cursor = Math.min(next.cursor + 1, next.answers.length - 1);
    } else if (event.type === 'SELECT') {
      if (!Number.isInteger(event.index) || event.index < 0 || event.index >= next.answers.length) throw new Error('題目無效。');
      next.cursor = event.index;
    } else if (event.type === 'SEAL') {
      next.phase = 'sealed'; if (next.version === 2) next.elapsedMs = Math.min(limits.duration, Math.max(0, Math.round(event.elapsedMs)));
      return validateSubmission(next.assignment, next);
    } else throw new Error('測驗操作無效。');
    return next;
  }
  function checkInk(run) {
    if (run.version === 4) return checkLockedInk(run);
    const count = { n: 0 };
    for (const answer of run.answers) ink(answer.strokes, count);
    const terminal = envelope({ ...run, elapsedMs: limits.duration, ...(run.version === 3 ? { wordProgress: run.wordProgress.map(word => ({ ...word, phase: 'submitted', elapsedMs: limits.duration })) } : {}) }, run.answers.map(answer => ({ occurrenceId: answer.occurrenceId, status: ['draft', 'ready'].includes(answer.status) ? 'submitted' : answer.status, strokes: answer.strokes, ...(run.version === 3 ? { hintUsed: answer.hintUsed } : {}) })));
    if (new TextEncoder().encode(JSON.stringify(terminal)).length > limits.bytes) throw new Error('筆跡超出容量，請撤回本字上一筆再試。原稿仍然保留。');
  }
  function envelope(run, answers) { return { version: run.version, runId: run.runId, assignment: run.assignment, startedAt: run.startedAt, elapsedMs: run.elapsedMs, phase: 'sealed', answers, ...(run.version === 3 ? { presentationMode: run.presentationMode, legacyElapsedMs: run.legacyElapsedMs, wordProgress: run.wordProgress.map(word => ({ wordId: word.wordId, phase: word.phase, elapsedMs: word.elapsedMs, timeKnown: word.timeKnown })) } : {}) }; }
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
    let rank = 0, start = 0;
    return rows.filter(row => Number.isInteger(row.score)).sort((a, b) => (a.mode || '').localeCompare(b.mode || '') || b.score - a.score || a.alias.localeCompare(b.alias)).map((row, i, sorted) => {
      if (!i || row.mode !== sorted[i - 1].mode) { start = i; rank = 1; }
      else if (row.score !== sorted[i - 1].score) rank = i - start + 1;
      return { ...row, rank };
    });
  }
  const api = { policy, startLocked, validateAutomatic, completeAnswer, boardTime, timeRanks, limits, assignment, positions, start, startWords, actualMode, wordAt, upgradeWords, transition, checkInk, validateSubmission, review, unmarked, ranks };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.BishunAssessment = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
