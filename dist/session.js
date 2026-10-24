(function (root) {
  'use strict';
  const MAX_WORDS = 12;
  function parseEntries(text) {
    if (typeof text !== 'string' || text.length > 400) throw new Error('請輸入 1 至 12 項詞語，每項最多 8 個中文字。');
    const words = [...new Set(text.normalize('NFC').split(/[\s,，、;；（）()「」]+/u).filter(Boolean))];
    if (!words.length || words.length > MAX_WORDS || words.some(word => !/^\p{Script=Han}{1,8}$/u.test(word))) throw new Error('每項只可用 1 至 8 個中文字，最多 12 項。請用換行分開。');
    return words.map((text, index) => ({ id: 'w' + index, text, characters: Array.from(text) }));
  }
  function createSession({ id, entries, startedAt, mode = 'practice' }) {
    if (!['practice', 'quiz'].includes(mode) || typeof id !== 'string' || !id || id.length > 100 || !Number.isFinite(startedAt) || !Array.isArray(entries) || !entries.length || entries.length > 6) throw new Error('練習設定無效。');
    if (entries.some(entry => !entry || typeof entry.text !== 'string' || !/^\p{Script=Han}{1,8}$/u.test(entry.text))) throw new Error('練習設定無效。');
    const parsed = parseEntries(entries.map(entry => entry.text).join('\n'));
    if (parsed.length !== entries.length) throw new Error('詞語不能重複。');
    const occurrences = parsed.flatMap((word, wordIndex) => {
      const indexes = entries[wordIndex].selectedIndexes;
      if (!Array.isArray(indexes) || !indexes.length || new Set(indexes).size !== indexes.length || indexes.some(index => !Number.isInteger(index) || index < 0 || index >= word.characters.length)) throw new Error('請為每項詞語揀最少一個字。');
      return [...indexes].sort((a, b) => a - b).map(index => ({ id: word.id + ':' + index, wordId: word.id, index, character: word.characters[index] }));
    });
    return { version: mode === 'practice' ? 4 : 3, ...(mode === 'practice' ? { wordChoices: {} } : {}), mode, id, startedAt, entries: parsed, occurrences, attempts: [], finished: [], active: { phase: 'choose-word' }, resting: false };
  }
  function transition(state, event) {
    if (!state || !event || typeof event.type !== 'string') return state;
    const a = state.active, purposePractice = state.version === 4 && state.mode === 'practice';
    if (event.type === 'REST' && a.phase !== 'summary') return { ...state, resting: true };
    if (event.type === 'RESUME') return { ...state, resting: false };
    if (state.resting && event.type !== 'END_SESSION') return state;
    if (event.type === 'END_SESSION') {
      const s = JSON.parse(JSON.stringify(state));
      s.attempts.forEach(attempt => { if (attempt.outcome === 'active') { attempt.outcome = 'abandoned'; attempt.endedAt = event.at; } });
      s.active = { phase: 'summary' }; s.resting = false; s.endedAt = event.at;
      return s;
    }
    if (a.phase === 'summary') return state;
    if (event.type === 'CHOOSE_WORD' && a.phase === 'choose-word') {
      const occurrence = state.occurrences.find(item => item.wordId === event.wordId && !state.finished.includes(item.id));
      if (!occurrence || typeof event.newToken !== 'string') return state;
      if (purposePractice && !state.wordChoices[event.wordId]?.route) {
        const choice = state.wordChoices[event.wordId];
        if (!choice && !['label', null].includes(event.purpose)) return state;
        return { ...state, wordChoices: { ...state.wordChoices, [event.wordId]: choice || { purpose: event.purpose, route: null } }, active: { phase: 'choose-route', wordId: event.wordId, token: event.newToken } };
      }
      return { ...state, active: { phase: 'loading', occurrenceId: occurrence.id, token: event.newToken } };
    }
    if (event.token !== a.token) return state;
    if (purposePractice && event.type === 'CHOOSE_ROUTE' && ['choose-route', 'choose-purpose'].includes(a.phase) && ['independent', 'guided'].includes(event.route) && typeof event.newToken === 'string' && event.newToken && event.newToken !== a.token) {
      const choice = state.wordChoices[a.wordId];
      if (!choice && !['label', null].includes(event.purpose)) return state;
      const occurrence = state.occurrences.find(item => item.wordId === a.wordId && !state.finished.includes(item.id)) || state.occurrences.filter(item => item.wordId === a.wordId).at(-1);
      return { ...state, wordChoices: { ...state.wordChoices, [a.wordId]: { ...(choice || { purpose: event.purpose }), route: event.route } }, active: { phase: 'loading', occurrenceId: occurrence.id, token: event.newToken } };
    }
    if (event.type === 'BROWSE_DEMO') {
      if (state.mode !== 'practice' || a.phase !== 'watch' || ![1, -1].includes(event.direction) || typeof event.newToken !== 'string' || !event.newToken || event.newToken === a.token || state.attempts.some(item => item.id === event.newToken)) return state;
      const current = state.occurrences.find(item => item.id === a.occurrenceId);
      const assigned = state.occurrences.filter(item => item.wordId === current.wordId);
      const target = assigned[assigned.findIndex(item => item.id === current.id) + event.direction];
      return target ? { ...state, active: { phase: 'loading', occurrenceId: target.id, token: event.newToken, ...(purposePractice ? { demo: true } : {}) } } : state;
    }
    const writing = ['guided', 'recall', 'quiz'].includes(a.phase);
    const s = JSON.parse(JSON.stringify(state));
    const active = s.active;
    const attempt = s.attempts.find(item => item.id === a.attemptId);
    function start(phase) {
      if (typeof event.newToken !== 'string' || !event.newToken || event.newToken === a.token || s.attempts.some(item => item.id === event.newToken)) return state;
      if (attempt && attempt.outcome === 'active') { attempt.outcome = 'abandoned'; attempt.endedAt = event.at; }
      s.attempts.push({ id: event.newToken, occurrenceId: a.occurrenceId, phase, startedAt: event.at, help: [], mistakes: 0, outcome: 'active', ...(phase === 'quiz' ? { elapsedMs: null } : {}) });
      s.active = { ...a, phase, token: event.newToken, attemptId: event.newToken, currentStroke: 0, missesOnCurrentStroke: 0, writingDone: false };
      delete s.active.completedPhase;
      return s;
    }
    switch (event.type) {
      case 'DURATION_SNAPSHOT':
        if (s.mode !== 'quiz' || a.phase !== 'quiz' || !attempt || attempt.outcome !== 'active' || !Number.isFinite(event.elapsedMs) || event.elapsedMs < (attempt.elapsedMs || 0) || event.elapsedMs > Number.MAX_SAFE_INTEGER) return state;
        if (attempt.elapsedMs === event.elapsedMs) return state;
        attempt.elapsedMs = event.elapsedMs; return s;
      case 'MOUNT_FAILED':
        if (!['watch', 'guided', 'recall', 'quiz'].includes(a.phase)) return state;
        if (attempt && attempt.outcome === 'active') { attempt.outcome = 'abandoned'; attempt.endedAt = event.at; }
        s.active = { phase: 'unavailable', occurrenceId: a.occurrenceId, token: a.token }; return s;
      case 'DATA_READY':
        if (a.phase !== 'loading' || !Number.isInteger(event.strokeCount) || event.strokeCount < 1 || event.strokeCount > 64) return state;
        if (purposePractice && a.demo) { delete active.demo; active.phase = 'watch'; active.strokeCount = event.strokeCount; return s; }
        if (s.mode === 'quiz' || purposePractice) {
          const choice = purposePractice && s.wordChoices[s.occurrences.find(item => item.id === a.occurrenceId).wordId];
          const result = start(s.mode === 'quiz' ? 'quiz' : choice.route === 'independent' ? 'recall' : 'guided');
          if (result !== state) result.active.strokeCount = event.strokeCount;
          return result;
        }
        active.phase = 'watch'; active.strokeCount = event.strokeCount; return s;
      case 'DATA_FAILED':
        if (a.phase !== 'loading') return state;
        delete active.demo; active.phase = 'unavailable'; return s;
      case 'RETRY_DATA':
        if (a.phase !== 'unavailable' || typeof event.newToken !== 'string' || event.newToken === a.token) return state;
        active.phase = 'loading'; active.token = event.newToken; return s;
      case 'START_GUIDED': return state.mode !== 'quiz' && a.phase === 'watch' ? start('guided') : state;
      case 'START_RECALL': return !purposePractice && state.mode !== 'quiz' && a.phase === 'guided' && a.writingDone ? start('recall') : state;
      case 'RETRY': return writing ? start(a.phase) : a.phase === 'character-complete' && ['recall', 'quiz', ...(purposePractice ? ['guided'] : [])].includes(a.completedPhase) ? start(a.completedPhase) : state;
      case 'USE_GUIDANCE':
        if (!purposePractice || a.phase !== 'recall' || a.writingDone || !attempt || typeof event.newToken !== 'string' || !event.newToken || event.newToken === a.token || s.attempts.some(item => item.id === event.newToken)) return state;
        attempt.phase = 'guided'; attempt.help.push({ kind: 'guidance', strokeIndex: a.currentStroke, at: event.at });
        active.phase = 'guided'; active.token = event.newToken; return s;
      case 'PREVIOUS_STEP':
        if (purposePractice && ['choose-purpose', 'choose-route', 'word-complete', 'recall', 'loading', 'unavailable'].includes(a.phase)) {
          if (typeof event.newToken !== 'string' || !event.newToken || event.newToken === a.token) return state;
          if (attempt && attempt.outcome === 'active') { attempt.outcome = 'abandoned'; attempt.endedAt = event.at; }
          const wordId = a.wordId || s.occurrences.find(item => item.id === a.occurrenceId).wordId;
          s.active = ['choose-purpose', 'choose-route'].includes(a.phase) ? { phase: 'choose-word' } : { phase: 'choose-route', wordId, token: event.newToken };
          return s;
        }
        if (s.mode === 'quiz') {
          if (a.phase === 'choose-word') return state;
          if (attempt && attempt.outcome === 'active') { attempt.outcome = 'abandoned'; attempt.endedAt = event.at; }
          s.active = { phase: 'choose-word' }; return s;
        }
        if (!['loading', 'unavailable', 'watch', 'guided', 'recall', 'character-complete'].includes(a.phase) || typeof event.newToken !== 'string' || !event.newToken || event.newToken === a.token || s.attempts.some(item => item.id === event.newToken)) return state;
        if (a.phase === 'recall' || (a.phase === 'character-complete' && a.strokeCount)) return start('guided');
        if (a.phase === 'character-complete') s.active = { phase: 'loading', occurrenceId: a.occurrenceId, token: event.newToken };
        else if (a.phase === 'guided') {
          if (attempt && attempt.outcome === 'active') { attempt.outcome = 'abandoned'; attempt.endedAt = event.at; }
          s.active = { phase: 'watch', occurrenceId: a.occurrenceId, token: event.newToken, strokeCount: a.strokeCount };
        } else s.active = { phase: 'choose-word' };
        return s;
      case 'STROKE_ACCEPTED':
        if (!writing || a.writingDone || event.strokeIndex !== a.currentStroke || a.currentStroke >= a.strokeCount) return state;
        active.currentStroke++; active.missesOnCurrentStroke = 0; return s;
      case 'STROKE_MISSED':
        if (!writing || a.writingDone || event.strokeIndex !== a.currentStroke) return state;
        active.missesOnCurrentStroke++; attempt.mistakes++; return s;
      case 'REQUEST_HELP':
        if (s.mode === 'quiz' || !writing || a.writingDone || !['start', 'outline', 'stroke'].includes(event.kind)) return state;
        attempt.help.push({ kind: event.kind, strokeIndex: a.currentStroke, at: event.at }); return s;
      case 'WRITING_COMPLETE':
        if (!writing || a.writingDone || a.currentStroke !== a.strokeCount || !attempt || attempt.outcome !== 'active') return state;
        attempt.outcome = 'complete'; attempt.endedAt = event.at; active.writingDone = true;
        if (a.phase === 'recall' || a.phase === 'quiz' || purposePractice && a.phase === 'guided') { active.phase = 'character-complete'; active.completedPhase = a.phase; if (!s.finished.includes(a.occurrenceId)) s.finished.push(a.occurrenceId); }
        return s;
      case 'TEACHER_SKIP':
        if (!['watch', 'loading', 'unavailable', 'guided', 'recall', 'quiz'].includes(a.phase) || a.writingDone) return state;
        if (attempt) { attempt.outcome = 'skipped'; attempt.endedAt = event.at; } else s.attempts.push({ id: event.newToken, occurrenceId: a.occurrenceId, phase: 'teacher', ...(s.mode === 'quiz' ? { elapsedMs: null } : {}), help: [], mistakes: 0, outcome: 'skipped', startedAt: event.at, endedAt: event.at });
        if (!s.finished.includes(a.occurrenceId)) s.finished.push(a.occurrenceId);
        s.active = { ...a, phase: 'character-complete', completedPhase: 'skipped' }; return s;
      case 'NEXT': {
        if (purposePractice && a.phase === 'word-complete') {
          if (s.occurrences.every(item => s.finished.includes(item.id))) return transition(s, { type: 'END_SESSION', at: event.at });
          s.active = { phase: 'choose-word' }; return s;
        }
        if (a.phase !== 'character-complete' || typeof event.newToken !== 'string') return state;
        if (!purposePractice && s.occurrences.every(item => s.finished.includes(item.id))) return transition(s, { type: 'END_SESSION', at: event.at });
        const current = s.occurrences.find(item => item.id === a.occurrenceId);
        const next = s.occurrences.find(item => item.wordId === current.wordId && !s.finished.includes(item.id));
        s.active = next ? { phase: 'loading', occurrenceId: next.id, token: event.newToken } : purposePractice ? { phase: 'word-complete', wordId: current.wordId, token: event.newToken } : { phase: 'choose-word' }; return s;
      }
      case 'RETURN_TO_WORDS':
        if (!['unavailable', 'watch'].includes(a.phase)) return state;
        s.active = { phase: 'choose-word' }; return s;
      default: return state;
    }
  }
  function summarize(state) {
    return state.occurrences.map(occurrence => {
      const attempts = state.attempts.filter(item => item.occurrenceId === occurrence.id);
      const recall = attempts.filter(item => item.phase === (state.mode === 'quiz' ? 'quiz' : 'recall') && item.outcome === 'complete');
      const independent = recall.some(item => !item.help.length);
      const completed = attempts.filter(item => item.outcome === 'complete' && (item.phase === 'recall' || item.phase === 'quiz' || state.version === 4 && item.phase === 'guided'));
      const assisted = recall.some(item => item.help.length) || state.version === 4 && completed.some(item => item.phase === 'guided');
      const measured = attempts.filter(item => Number.isFinite(item.elapsedMs));
      const elapsedMs = measured.length ? measured.reduce((total, item) => total + item.elapsedMs, 0) : null;
      const timingComplete = attempts.length > 0 && measured.length === attempts.length;
      const skipped = attempts.some(item => item.outcome === 'skipped');
      return { ...occurrence, word: state.entries.find(word => word.id === occurrence.wordId).text, attempts, completedAttemptId: completed.at(-1)?.id || null, elapsedMs, timingComplete, independent, assisted, skipped, guided: attempts.some(item => item.phase === 'guided' && item.outcome === 'complete'), helpUsed: attempts.reduce((n, item) => n + item.help.length, 0), unfinished: !independent && !assisted && !skipped };
    });
  }
  function validateSnapshot(value) {
    try {
      if (!value || ![1, 2, 3, 4].includes(value.version) || !Number.isFinite(value.startedAt) || typeof value.id !== 'string' || value.id.length > 100 || !Array.isArray(value.attempts) || value.attempts.length > 2000 || !Array.isArray(value.entries) || !Array.isArray(value.occurrences) || value.occurrences.length > 48) return false;
      if (value.version >= 3 && !['practice', 'quiz'].includes(value.mode)) return false;
      if (value.version === 4 && value.mode !== 'practice') return false;
      const quiz = value.version === 3 && value.mode === 'quiz';
      const entries = value.entries.map(word => ({ text: word.text, selectedIndexes: value.version === 1 ? Array.from(word.text).map((_, index) => index) : value.occurrences.filter(item => item.wordId === word.id).map(item => item.index) }));
      const expected = createSession({ id: value.id, entries, startedAt: value.startedAt });
      if (JSON.stringify(value.entries) !== JSON.stringify(expected.entries) || JSON.stringify(value.occurrences) !== JSON.stringify(expected.occurrences) || !Array.isArray(value.finished) || new Set(value.finished).size !== value.finished.length || value.finished.some(id => !expected.occurrences.some(o => o.id === id))) return false;
      if (!value.active || !['choose-word', ...(value.version === 4 ? ['choose-purpose', 'choose-route', 'word-complete'] : []), 'loading', 'unavailable', 'watch', 'guided', 'recall', 'quiz', 'character-complete', 'summary'].includes(value.active.phase)) return false;
      const a = value.active;
      if (quiz ? ['watch', 'guided', 'recall'].includes(a.phase) : a.phase === 'quiz') return false;
      if (value.version === 4) {
        if (a.demo !== undefined && (a.phase !== 'loading' || a.demo !== true)) return false;
        if (!value.wordChoices || typeof value.wordChoices !== 'object' || Array.isArray(value.wordChoices) || Object.keys(value.wordChoices).length > 6) return false;
        for (const [wordId, choice] of Object.entries(value.wordChoices)) {
          if (!expected.entries.some(word => word.id === wordId) || !choice || Object.keys(choice).some(key => !['purpose', 'route'].includes(key)) || !['label', 'intro', null].includes(choice.purpose) || !['independent', 'guided', null].includes(choice.route)) return false;
        }
        if (['choose-purpose', 'choose-route', 'word-complete'].includes(a.phase) && (!expected.entries.some(word => word.id === a.wordId) || typeof a.token !== 'string' || !a.token)) return false;
        if (a.phase === 'choose-route' && !value.wordChoices[a.wordId]) return false;
        if (!['choose-word', 'choose-purpose', 'choose-route', 'summary'].includes(a.phase)) {
          const wordId = a.wordId || expected.occurrences.find(item => item.id === a.occurrenceId)?.wordId;
          if (!value.wordChoices[wordId]?.route) return false;
        }
      }
      if (value.version >= 3) {
        if (typeof value.resting !== 'boolean' || (value.endedAt !== undefined && !Number.isFinite(value.endedAt))) return false;
        const transientKeys = ['points', 'strokes', 'ink', 'drawnPath', 'openedMono'];
        if (transientKeys.some(key => key in value || key in a)) return false;
        for (const item of value.attempts) {
          if (!item || transientKeys.some(key => key in item)) return false;
          if (item.outcome !== 'active' && !Number.isFinite(item.endedAt)) return false;
          if (quiz) {
            if (!['quiz', 'teacher'].includes(item.phase) || !Array.isArray(item.help) || item.help.length) return false;
            if (item.elapsedMs !== null && (!Number.isFinite(item.elapsedMs) || item.elapsedMs < 0 || item.elapsedMs > Number.MAX_SAFE_INTEGER)) return false;
            if (item.phase === 'teacher' && item.elapsedMs !== null) return false;
          } else if (item.phase === 'quiz' || (item.elapsedMs !== undefined && item.elapsedMs !== null)) return false;
        }
        const live = value.attempts.filter(item => item.outcome === 'active');
        if (live.length > 1 || live.some(item => item.id !== a.attemptId || !['guided', 'recall', 'quiz'].includes(a.phase))) return false;
      }
      if (!['choose-word', 'summary', ...(value.version === 4 ? ['choose-purpose', 'choose-route', 'word-complete'] : [])].includes(a.phase) && (!expected.occurrences.some(o => o.id === a.occurrenceId) || typeof a.token !== 'string' || !a.token)) return false;
      if (a.attemptId !== undefined && !value.attempts.some(item => item.id === a.attemptId && item.occurrenceId === a.occurrenceId)) return false;
      if (['guided', 'recall', 'quiz'].includes(a.phase) && !value.attempts.some(item => item.id === a.attemptId && item.occurrenceId === a.occurrenceId && item.phase === a.phase)) return false;
      if (new Set(value.attempts.map(item => item.id)).size !== value.attempts.length) return false;
      return value.attempts.every(item => item && typeof item.id === 'string' && item.id.length <= 100 && expected.occurrences.some(o => o.id === item.occurrenceId) && ['guided', 'recall', 'teacher', ...(quiz ? ['quiz'] : [])].includes(item.phase) && ['active', 'complete', 'abandoned', 'skipped'].includes(item.outcome) && Number.isInteger(item.mistakes) && item.mistakes >= 0 && item.mistakes < 100000 && Number.isFinite(item.startedAt) && Array.isArray(item.help) && item.help.length <= 2000 && item.help.every(help => help && ['start', 'outline', 'stroke', ...(value.version === 4 ? ['guidance'] : [])].includes(help.kind) && Number.isInteger(help.strokeIndex) && help.strokeIndex >= 0 && help.strokeIndex < 64 && Number.isFinite(help.at)));
    } catch (_) { return false; }
  }
  const api = { parseEntries, createSession, transition, summarize, validateSnapshot };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.BishunSession = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
