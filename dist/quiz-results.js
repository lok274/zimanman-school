(function (root) {
  'use strict';
  function assignment(entries) {
    if (!Array.isArray(entries) || !entries.length || entries.length > 6) throw new Error('請選 1 至 6 項詞語。');
    const seen = new Set();
    return { version: 1, entries: entries.map(entry => {
      if (!entry || typeof entry.text !== 'string' || !/^\p{Script=Han}{1,8}$/u.test(entry.text) || seen.has(entry.text)) throw new Error('詞語設定無效。');
      seen.add(entry.text);
      const indexes = entry.selectedIndexes;
      if (!Array.isArray(indexes) || !indexes.length || new Set(indexes).size !== indexes.length || indexes.some(index => !Number.isInteger(index) || index < 0 || index >= Array.from(entry.text).length)) throw new Error('選字設定無效。');
      return { text: entry.text, selectedIndexes: [...indexes].sort((a, b) => a - b) };
    }) };
  }
  function evaluate(entries, evidence) {
    const assigned = assignment(entries);
    if (!evidence || typeof evidence.runId !== 'string' || !/^[\w-]{1,100}$/.test(evidence.runId) || !Array.isArray(evidence.attempts) || evidence.attempts.length > 2000) throw new Error('測驗紀錄無效。');
    const occurrences = assigned.entries.flatMap((word, i) => word.selectedIndexes.map(index => 'w' + i + ':' + index));
    const ids = new Set(), covered = new Set();
    let mistakes = 0, elapsedMs = 0, reason = '';
    const attempts = evidence.attempts.map(item => {
      if (!item || typeof item.id !== 'string' || !/^[\w-]{1,100}$/.test(item.id) || ids.has(item.id) || !occurrences.includes(item.occurrenceId) || !['quiz', 'teacher'].includes(item.phase) || !['complete', 'abandoned', 'skipped'].includes(item.outcome) || !Number.isInteger(item.mistakes) || item.mistakes < 0 || item.mistakes >= 100000 || !Array.isArray(item.help) || item.help.length || (item.elapsedMs !== null && (!Number.isFinite(item.elapsedMs) || item.elapsedMs < 0 || item.elapsedMs > Number.MAX_SAFE_INTEGER)) || (item.phase === 'teacher' && (item.outcome !== 'skipped' || item.elapsedMs !== null))) throw new Error('測驗嘗試無效。');
      ids.add(item.id);
      if (item.outcome === 'complete' || item.outcome === 'skipped') covered.add(item.occurrenceId);
      if (item.outcome === 'skipped') reason = 'skipped';
      if (item.elapsedMs === null && !reason) reason = 'unknown-time';
      mistakes += item.mistakes; elapsedMs += item.elapsedMs || 0;
      return { id: item.id, occurrenceId: item.occurrenceId, phase: item.phase, outcome: item.outcome, mistakes: item.mistakes, elapsedMs: item.elapsedMs, help: [] };
    });
    elapsedMs = Math.round(elapsedMs / 100) * 100;
    if (!Number.isSafeInteger(mistakes) || !Number.isSafeInteger(elapsedMs)) throw new Error('測驗合計超出範圍。');
    const terminal = occurrences.every(id => covered.has(id));
    if (!terminal) reason = 'incomplete';
    return { terminal, ranked: terminal && !reason, reason: reason || null, score: terminal && !reason ? { mistakes, elapsedMs } : null, evidence: { runId: evidence.runId, attempts } };
  }
  function entriesFromSession(session) {
    return session.entries.map(word => ({ text: word.text, selectedIndexes: session.occurrences.filter(item => item.wordId === word.id).map(item => item.index) }));
  }
  function fromSession(session, entries = entriesFromSession(session)) {
    if (session.mode !== 'quiz' || session.active.phase !== 'summary' || JSON.stringify(assignment(entriesFromSession(session))) !== JSON.stringify(assignment(entries))) return null;
    return evaluate(entries, { runId: session.id, attempts: session.attempts });
  }
  function compare(a, b) { return a.mistakes - b.mistakes || a.elapsedMs - b.elapsedMs; }
  function ranks(rows) {
    const sorted = [...rows].sort((a, b) => compare(a, b) || a.memberId.localeCompare(b.memberId));
    let rank = 0;
    return sorted.map((row, i) => { if (!i || compare(row, sorted[i - 1])) rank = i + 1; return { ...row, rank }; });
  }
  const api = { assignment, evaluate, entriesFromSession, fromSession, compare, ranks };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.BishunQuizResults = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
