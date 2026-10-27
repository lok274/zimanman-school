(function (root) {
  'use strict';
  const storageKey = 'bishun:classroom:v1';
  const defaultOrigin = 'https://zimanman-classroom-1023.lokyau65.chatgpt.site';
  const codePattern = /^(?:[1-9]\d{2}|[A-Z2-9]{8})$/;
  function validateAssignment(value) { return value.version === 2 ? root.BishunAssessment.assignment(value.entries, value.mode) : root.BishunQuizResults.assignment(value.entries); }
  function create({ origin = defaultOrigin, storage = root.sessionStorage, fetch = root.fetch.bind(root), crypto = root.crypto, changed = () => {} } = {}) {
    origin = new URL(origin).origin;
    const key = storageKey + ':' + origin;
    let saved = {}, accepted = false, generation = 0, controller = null, busy = false, message = '', board = null, storageOkay = true;
    try {
      const raw = storage.getItem(key);
      if (raw && raw.length < 300000) {
        const value = JSON.parse(raw);
        if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('Invalid saved classroom');
        if (value.member && (!codePattern.test(value.member.code) || !/^[a-f0-9]{64}$/.test(value.member.token) || typeof value.member.memberId !== 'string' || typeof value.member.alias !== 'string' || !Number.isFinite(value.member.expiresAt))) throw new Error('Invalid saved membership');
        if (value.member) validateAssignment(value.member.assignment);
        if (value.join && (!codePattern.test(value.join.code) || !value.join.body || typeof value.join.body.alias !== 'string' || !/^[\w-]{1,100}$/.test(value.join.body.requestId) || !/^[a-f0-9]{64}$/.test(value.join.body.memberToken))) throw new Error('Invalid saved join');
        if (value.pending && (!value.member || value.pending.runId !== value.boundRunId || !root.BishunQuizResults.evaluate(value.member.assignment.entries, value.pending).terminal)) throw new Error('Invalid pending result');
        if (value.receipt && (!value.member || typeof value.receipt.runId !== 'string' || (value.member.assignment.version === 2 ? value.receipt.official !== true : typeof value.receipt.ranked !== 'boolean'))) throw new Error('Invalid saved receipt');
        if (value.receipt?.version === 4) validateAutomaticReceipt(value.receipt);
        saved = value;
      }
    } catch { storageOkay = false; }
    function persist() { try { storage.setItem(key, JSON.stringify(saved)); storageOkay = true; } catch { storageOkay = false; } return storageOkay; }
    function view() { return { member: saved.member ? { code: saved.member.code, memberId: saved.member.memberId, alias: saved.member.alias, assignment: saved.member.assignment, expiresAt: saved.member.expiresAt } : null, needsContinue: !!saved.member && !accepted, accepted, busy, message: message.replaceAll('測驗', '小挑戰'), pending: !!saved.pending, receipt: saved.receipt || null, board, storageOkay, boundRunId: saved.boundRunId || null }; }
    function notify() { changed(view()); }
    function invalidate() { generation++; controller?.abort(); controller = null; busy = false; }
    async function request(path, method = 'GET', value, token) {
      const ownGeneration = generation;
      if (busy) throw new Error('請等目前連線完成。');
      busy = true; controller = new AbortController(); notify();
      try {
        let response, data;
        try { response = await fetch(origin + '/api/v1/classes' + path, { method, signal: controller.signal, credentials: 'omit', headers: { ...(value ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}) }, ...(value ? { body: JSON.stringify(value) } : {}) }); }
        catch { throw new Error('班級服務未能連線，請稍後重試。'); }
        try { data = await response.json(); }
        catch { throw new Error('班級服務回應無效，請稍後重試。'); }
        if (ownGeneration !== generation) throw Object.assign(new Error('身份已切換。'), { stale: true });
        if (!data || typeof data !== 'object') throw new Error('班級服務回應無效，請稍後重試。');
        if (!response.ok) throw Object.assign(new Error(data.error?.message || '班級服務未能連線，請稍後重試。'), { code: data.error?.code });
        return data;
      } catch (error) {
        if (ownGeneration !== generation) throw Object.assign(new Error('身份已切換。'), { stale: true });
        throw error;
      } finally { if (ownGeneration === generation) { busy = false; controller = null; } }
    }
    async function join(code, alias) {
      if (busy) return;
      code = code.trim().toUpperCase(); alias = alias.normalize('NFC').trim();
      if (!codePattern.test(code) || !alias || Array.from(alias).length > 20) { message = '請輸入 3 位數字班級碼和 1 至 20 字暱稱。'; notify(); return; }
      if (!saved.join || saved.join.code !== code || saved.join.body.alias !== alias) {
        const token = [...crypto.getRandomValues(new Uint8Array(32))].map(n => n.toString(16).padStart(2, '0')).join('');
        saved = { join: { code, body: { requestId: crypto.randomUUID(), alias, memberToken: token } } };
      }
      if (!persist()) { message = '此瀏覽器未能保存參加身份，暫時不能加入班級。可以返回首頁做本機小挑戰。'; notify(); return; }
      const pending = saved.join; message = '加入中…';
      try {
        const member = await request('/' + pending.code + '/members', 'POST', pending.body);
        if (!member || member.code !== pending.code || typeof member.memberId !== 'string' || typeof member.alias !== 'string' || !Number.isFinite(member.expiresAt)) throw new Error('班級回應無效，請重試。');
        validateAssignment(member.assignment);
        saved = { member: { ...member, token: pending.body.memberToken } }; accepted = true; message = '已加入。準備好就開始小挑戰。'; persist();
      } catch (error) { if (error.stale) return; message = error.message || '班級服務未能連線。'; }
      notify();
    }
    function continueMember() { if (saved.member) { accepted = true; message = saved.pending ? '上次小挑戰尚未交到班級榜，請重試交卷。' : '已確認參加身份。'; notify(); } }
    function leave() { invalidate(); saved = {}; accepted = false; board = null; message = ''; persist(); notify(); }
    function bindRun(runId) {
      if (!accepted || !saved.member || saved.pending || busy) throw new Error('請先確認身份，並交回上次小挑戰。');
      saved.boundRunId = runId; saved.receipt = null; board = null; message = '';
      if (!persist()) throw new Error('此頁未能保存參加身份，請恢復瀏覽器儲存後再試，或返回首頁做本機小挑戰。');
      notify();
    }
    async function retry() {
      if (!accepted || !saved.member || !saved.pending || busy) return;
      const member = saved.member, evidence = saved.pending;
      if (!persist()) { message = '小挑戰已完成，但待交紀錄未能保存。請保持頁面開啟，恢復瀏覽器儲存後再重試。'; notify(); return; }
      message = '交緊小挑戰紀錄…';
      try {
        const receipt = await request('/' + member.code + '/runs/' + evidence.runId, 'PUT', evidence, member.token);
        if (receipt.runId !== evidence.runId || typeof receipt.ranked !== 'boolean') throw new Error('交卷回應無效，請重試。');
        saved.receipt = receipt; delete saved.pending;
        if (!persist()) { saved.pending = evidence; delete saved.receipt; message = '班級已收卷，但本頁未能保存回條。請保持頁面開啟，再撳重試。'; notify(); return; }
        message = receipt.ranked ? '已交卷。' : '已交卷；今次有跳過或未有計時資料，不列入排名。'; notify();
      } catch (error) { if (error.stale) return; message = '已完成，尚未交到班級榜。' + (error.message || '請重試。'); notify(); }
    }
    function finish(result) {
      if (!accepted || !saved.member || !result?.terminal || saved.boundRunId !== result.evidence.runId || saved.receipt || saved.pending) return;
      saved.pending = result.evidence; persist(); retry();
    }
    async function refresh() {
      if (!accepted || !saved.member || !saved.receipt || busy) return;
      try {
        const automatic = saved.receipt.version === 4;
        const data = await request('/' + saved.member.code + (automatic ? '/automatic-board' : '/board'), 'GET', undefined, saved.member.token);
        if (automatic) {
          validateAutomaticBoard(data); board = { ...data, automatic: true, personalBest: data.rows.find(row => row.memberId === saved.member.memberId) || null };
          message = '班級榜已更新。'; notify(); return;
        }
        if (saved.member.assignment.version === 2) {
          validateReviewedBoard(data);
          board = { ...data, reviewed: true, personalBest: data.rows.find(row => row.alias === saved.member.alias) || null };
          message = data.published ? '老師已公布班級榜。' : '等老師公布班級榜。'; notify(); return;
        }
        if (!Array.isArray(data.rows) || data.rows.length > 100 || data.rows.some(row => !row || typeof row.memberId !== 'string' || typeof row.alias !== 'string' || !Number.isInteger(row.rank) || row.rank < 1 || !Number.isSafeInteger(row.mistakes) || row.mistakes < 0 || !Number.isSafeInteger(row.elapsedMs) || row.elapsedMs < 0)) throw new Error('排行榜回應無效。');
        board = { ...data, personalBest: data.rows.find(row => row.memberId === saved.member.memberId) || null };
        message = saved.receipt.ranked ? '班級榜已更新。' : '今次不排名，仍可睇班級榜。';
      }
      catch (error) { if (error.stale) return; message = '已交卷，班級榜暫未能更新。' + (error.message || '請重試。'); }
      notify();
    }
    function validateReviewedBoard(data) {
      if (typeof data.published !== 'boolean' || !Array.isArray(data.rows) || data.rows.length > 100 || data.rows.some(row => !row || typeof row.alias !== 'string' || !Number.isInteger(row.score) || row.score < 0 || !Number.isInteger(row.rank) || row.rank < 1 || row.mode !== undefined && !['copy', 'listen'].includes(row.mode))) throw new Error('排行榜回應無效。');
      return data;
    }
    async function reviewedRequest(action, method, value) {
      if (!accepted || saved.member?.assignment.version !== 2) throw new Error('請先確認參加身份。');
      const member = saved.member;
      try { return await request('/' + member.code + '/' + action, method, value, member.token); }
      finally { notify(); }
    }
    async function submitReviewed(run) {
      const receipt = await reviewedRequest('answers', 'PUT', run);
      if (receipt.runId !== run.runId || receipt.official !== true || run.version === 3 && receipt.version !== 3) throw new Error('交卷回應無效，原稿仍然保留，請重試。');
      saved.receipt = receipt; persist(); notify(); return receipt;
    }
    function validateAutomaticReceipt(receipt, run) {
      if (!receipt || receipt.version !== 4 || receipt.policy !== root.BishunAssessment.policy || receipt.official !== true || typeof receipt.runId !== 'string' || !/^[\w-]{1,100}$/.test(receipt.runId) || !Number.isSafeInteger(receipt.elapsedMs) || receipt.elapsedMs < 0 || receipt.elapsedMs > root.BishunAssessment.limits.duration || receipt.elapsedMs % 100 || run && (receipt.runId !== run.runId || receipt.elapsedMs !== root.BishunAssessment.boardTime(run.elapsedMs))) throw new Error('交卷回應無效，原稿仍然保留，請重試。');
      return receipt;
    }
    function validateAutomaticBoard(data) {
      if (data.version !== 4 || data.policy !== root.BishunAssessment.policy || !Number.isSafeInteger(data.expiresAt) || !Array.isArray(data.rows) || data.rows.length > 100 || data.rows.some(row => !row || typeof row.memberId !== 'string' || typeof row.alias !== 'string' || Array.from(row.alias).length > 20 || typeof row.isMe !== 'boolean' || !Number.isInteger(row.rank) || row.rank < 1 || !Number.isSafeInteger(row.elapsedMs) || row.elapsedMs < 0 || row.elapsedMs > root.BishunAssessment.limits.duration || row.elapsedMs % 100)) throw new Error('排行榜回應無效。');
      return data;
    }
    async function submitAutomatic(run) {
      const canonical = root.BishunAssessment.validateAutomatic(saved.member.assignment, run);
      const receipt = validateAutomaticReceipt(await reviewedRequest('automatic-answers', 'PUT', canonical), canonical);
      saved.receipt = receipt;
      if (!persist()) throw new Error('班級已收卷，但本頁未能保存回條，請重試。');
      notify(); return receipt;
    }
    async function ownAutomaticAnswer() {
      const result = await reviewedRequest('automatic-answers', 'GET');
      if (result.answer) {
        const run = root.BishunAssessment.validateAutomatic(saved.member.assignment, result.answer.run);
        const receipt = validateAutomaticReceipt(result.answer.receipt, run);
        saved.receipt = receipt; persist(); notify();
        return { ...result, answer: { run, receipt } };
      }
      if (result.answer !== null) throw new Error('原卷回應無效。');
      return result;
    }
    return { view, join, continueMember, leave, bindRun, finish, retry, refresh, cancelRequests: invalidate, submitReviewed, submitAutomatic, ownAutomaticAnswer, automaticBoard: async () => validateAutomaticBoard(await reviewedRequest('automatic-board', 'GET')),
      ownAnswer: () => reviewedRequest('answers', 'GET'), reviewedBoard: async () => validateReviewedBoard(await reviewedRequest('board', 'GET')) };
  }
  const api = { create, storageKey, defaultOrigin };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.BishunClassroom = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
