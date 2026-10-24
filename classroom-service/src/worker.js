import Q from './quiz-results.js';
import A from './assessment.js';
import teacherHTML from './teacher-page.js';

const allowedOrigins = new Set(['https://lok274.github.io', 'http://127.0.0.1:4173', 'http://localhost:4173']);
const keyPattern = /^[\w-]{1,100}$/;
function fail(status, code, message) { throw Object.assign(new Error(message), { status, code }); }
async function hash(value) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(n => n.toString(16).padStart(2, '0')).join(''); }
async function teacher(request) {
  const capability = request.headers.get('x-teacher-capability');
  if (!/^[a-f0-9]{64}$/.test(capability || '')) fail(401, 'TEACHER_REQUIRED', '開班身份無效，請重新開啟老師頁面。');
  return hash(capability);
}
function sameOrigin(request) {
  if (request.headers.get('origin') !== new URL(request.url).origin && !(request.headers.get('origin') === null && request.headers.get('sec-fetch-site') === 'same-origin')) fail(403, 'ORIGIN', '請在老師頁面管理班級。');
}
async function body(request, maximum = 262144) {
  if (!request.headers.get('content-type')?.startsWith('application/json')) fail(415, 'JSON_REQUIRED', '請傳送 JSON。');
  const reader = request.body?.getReader();
  if (!reader) fail(400, 'INVALID_BODY', '資料無效。');
  const chunks = []; let size = 0;
  while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > maximum) { await reader.cancel(); fail(413, 'TOO_LARGE', '紀錄太大，原稿仍保留在裝置。'); } chunks.push(value); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { const value = JSON.parse(new TextDecoder().decode(bytes)); if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error(); return value; }
  catch { fail(400, 'INVALID_BODY', '資料無效。'); }
}
function key(value) { if (typeof value !== 'string' || !keyPattern.test(value)) fail(400, 'INVALID_ID', '紀錄編號無效。'); return value; }
function canonicalAssignment(data) { try { return data.version === 2 ? A.assignment(data.entries, data.mode) : Q.assignment(data.entries); } catch (error) { fail(400, 'INVALID_ASSIGNMENT', error.message); } }
function roomReply(room) { return { code: room.code, assignment: JSON.parse(room.assignment_json), expiresAt: room.expires_at }; }
async function roomFor(db, code) {
  const room = await db.prepare('SELECT * FROM classes WHERE code = ?').bind(code).first();
  if (!room) fail(404, 'CLASS_NOT_FOUND', '搵唔到呢個班級，請核對班級碼。');
  if (room.expires_at <= Date.now()) fail(410, 'EXPIRED', '班級已到期，請老師開新一班。');
  return room;
}
async function memberFor(request, db, code) {
  const token = request.headers.get('authorization')?.replace(/^Bearer /, '');
  if (!token || !/^[a-f0-9]{64}$/.test(token)) fail(401, 'MEMBERSHIP_REQUIRED', '請重新加入班級。');
  const member = await db.prepare('SELECT * FROM members WHERE code = ? AND token_hash = ?').bind(code, await hash(token)).first();
  if (!member) fail(401, 'MEMBERSHIP_REQUIRED', '參加身份無效。');
  return member;
}
async function board(db, code, memberId) {
  const { results } = await db.prepare(`WITH best AS (
    SELECT m.id AS memberId, m.alias, r.mistakes, r.elapsed_ms AS elapsedMs,
      ROW_NUMBER() OVER (PARTITION BY m.id ORDER BY r.mistakes, r.elapsed_ms, r.id) AS choice
    FROM members m JOIN runs r ON r.member_id = m.id WHERE m.code = ? AND r.reason IS NULL
  ) SELECT memberId, alias, mistakes, elapsedMs FROM best WHERE choice = 1`).bind(code).all();
  const rows = Q.ranks(results).map(row => ({ ...row, isMe: row.memberId === memberId }));
  return { rows, personalBest: rows.find(row => row.isMe) || null };
}
async function ownerFor(request, room) {
  if (await teacher(request) !== room.owner_id) fail(403, 'OWNER_REQUIRED', '只限開班瀏覽器查看。');
  sameOrigin(request);
}
async function reviewedBoard(db, room) {
  const published = !!await db.prepare('SELECT code FROM publications WHERE code = ?').bind(room.code).first();
  if (!published) return { published: false, rows: [], expiresAt: room.expires_at };
  const { results } = await db.prepare('SELECT m.alias, s.score FROM members m JOIN reviewed_submissions s ON s.member_id = m.id WHERE m.code = ? AND s.score IS NOT NULL').bind(room.code).all();
  return { published, rows: A.ranks(results), expiresAt: room.expires_at };
}
function original(row, includeTime = false) {
  const run = JSON.parse(row.ink_json);
  if (!includeTime) { delete run.elapsedMs; delete run.startedAt; }
  return { run, marks: JSON.parse(row.marks_json), revision: row.revision, score: row.score, ...(includeTime ? { elapsedMs: row.elapsed_ms } : {}) };
}
async function api(request, env, url) {
  const db = env.DB;
  if (!db) fail(503, 'UNAVAILABLE', '班級服務暫未準備好。');
  const route = url.pathname.split('/').filter(Boolean).slice(3);
  if (route.length === 1 && route[0] === 'cleanup' && request.method === 'POST') {
    await db.prepare('DELETE FROM classes WHERE code IN (SELECT code FROM classes WHERE expires_at <= ? ORDER BY expires_at LIMIT 10)').bind(Date.now()).run();
    return { cleaned: true };
  }
  if (!route.length && request.method === 'POST') {
    sameOrigin(request); const owner = await teacher(request), data = await body(request);
    const requestId = key(data.requestId), assignment = canonicalAssignment(data), payloadHash = await hash(JSON.stringify(assignment));
    const existing = await db.prepare('SELECT * FROM classes WHERE owner_id = ? AND request_id = ?').bind(owner, requestId).first();
    if (existing) { if (existing.payload_hash !== payloadHash) fail(409, 'CONFLICT', '相同編號已有另一份設定。'); if (existing.expires_at <= Date.now()) fail(410, 'EXPIRED', '班級已到期。'); return roomReply(existing); }
    await db.prepare('DELETE FROM classes WHERE code IN (SELECT code FROM classes WHERE expires_at <= ? ORDER BY expires_at LIMIT 10)').bind(Date.now()).run();
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    for (let attempt = 0; attempt < 4; attempt++) {
      const code = [...crypto.getRandomValues(new Uint8Array(8))].map(n => alphabet[n % alphabet.length]).join('');
      const now = Date.now();
      await db.prepare(`INSERT OR IGNORE INTO classes(code, owner_id, assignment_json, expires_at, request_id, payload_hash)
        SELECT ?, ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM classes WHERE owner_id = ? AND expires_at > ?) < 10
        AND (SELECT COUNT(*) FROM classes WHERE expires_at > ?) < 100`)
        .bind(code, owner, JSON.stringify(assignment), now + 86400000, requestId, payloadHash, owner, now, now).run();
      const saved = await db.prepare('SELECT * FROM classes WHERE owner_id = ? AND request_id = ?').bind(owner, requestId).first();
      if (saved) { if (saved.payload_hash !== payloadHash) fail(409, 'CONFLICT', '相同編號已有另一份設定。'); return roomReply(saved); }
      const count = await db.prepare('SELECT COUNT(*) AS n FROM classes WHERE owner_id = ? AND expires_at > ?').bind(owner, now).first();
      if (count.n >= 10) fail(429, 'CLASS_LIMIT', '最多同時開 10 班，請等舊班到期。');
      const total = await db.prepare('SELECT COUNT(*) AS n FROM classes WHERE expires_at > ?').bind(now).first();
      if (total.n >= 100) fail(429, 'SERVICE_LIMIT', '服務最多同時開 100 班，請等舊班到期。');
    }
    fail(503, 'TRY_AGAIN', '暫未能建立班級，請重試。');
  }
  const [code, action, runId] = route;
  if (!/^[A-Z2-9]{8}$/.test(code || '') || route.length > 3) fail(404, 'NOT_FOUND', '搵唔到呢個頁面。');
  const room = await roomFor(db, code);
  const assigned = JSON.parse(room.assignment_json);
  if (route.length === 1 && request.method === 'DELETE') {
    await ownerFor(request, room);
    await db.prepare('DELETE FROM classes WHERE code = ? AND owner_id = ?').bind(code, room.owner_id).run();
    return { deleted: true };
  }
  if (assigned.version === 2 && action === 'answers' && route.length === 2) {
    const member = await memberFor(request, db, code);
    if (request.method === 'GET') {
      const saved = await db.prepare('SELECT * FROM reviewed_submissions WHERE member_id = ?').bind(member.id).first();
      return { answer: saved ? original(saved) : null, expiresAt: room.expires_at };
    }
    if (request.method === 'PUT') {
      const data = await body(request, A.limits.bytes);
      let run;
      try { run = A.validateSubmission(assigned, data); } catch (error) { fail(400, 'INVALID_INK', error.message); }
      const json = JSON.stringify(run), bytes = new TextEncoder().encode(json).length, payloadHash = await hash(json);
      await db.prepare(`INSERT OR IGNORE INTO reviewed_submissions(member_id, run_id, payload_hash, ink_json, ink_bytes, elapsed_ms, submitted_at, marks_json)
        SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM classes WHERE code = ? AND expires_at > ?)
        AND COALESCE((SELECT SUM(s.ink_bytes) FROM reviewed_submissions s JOIN members m ON s.member_id = m.id WHERE m.code = ?), 0) + ? <= 67108864
        AND COALESCE((SELECT SUM(ink_bytes) FROM reviewed_submissions), 0) + ? <= 268435456`)
        .bind(member.id, run.runId, payloadHash, json, bytes, run.elapsedMs, Date.now(), JSON.stringify(A.unmarked(assigned)), code, Date.now(), code, bytes, bytes).run();
      const saved = await db.prepare('SELECT * FROM reviewed_submissions WHERE member_id = ?').bind(member.id).first();
      if (!saved) { await roomFor(db, code); fail(507, 'INK_CAPACITY', '班級儲存已滿，原稿仍保留在裝置，請老師處理後重試。'); }
      if (saved.run_id !== run.runId) fail(409, 'FIRST_SUBMISSION', '第一份原卷已收妥，之後練習不會取代。');
      if (saved.payload_hash !== payloadHash) fail(409, 'CONFLICT', '原卷編號已有另一份筆跡。');
      return { runId: saved.run_id, official: true };
    }
  }
  if (assigned.version === 2 && action === 'reviews') {
    await ownerFor(request, room);
    if (route.length === 2 && request.method === 'GET') {
      const { results } = await db.prepare('SELECT m.id AS memberId, m.alias, s.run_id AS runId, s.revision, s.score, s.elapsed_ms AS elapsedMs FROM members m LEFT JOIN reviewed_submissions s ON s.member_id = m.id WHERE m.code = ? ORDER BY m.alias').bind(code).all();
      return { members: results, ...await reviewedBoard(db, room) };
    }
    if (route.length === 3) {
      const saved = await db.prepare('SELECT s.* FROM reviewed_submissions s JOIN members m ON m.id = s.member_id WHERE m.code = ? AND m.id = ?').bind(code, key(runId)).first();
      if (!saved) fail(404, 'ANSWER_NOT_FOUND', '未有原卷。');
      if (request.method === 'GET') return original(saved, true);
      if (request.method === 'PUT') {
        const data = await body(request); let reviewed;
        if (!Number.isSafeInteger(data.revision) || data.revision < 0) fail(400, 'INVALID_REVIEW', '批改版本無效。');
        try { reviewed = A.review(assigned, data.marks); } catch (error) { fail(400, 'INVALID_REVIEW', error.message); }
        const updated = await db.prepare(`UPDATE reviewed_submissions SET marks_json = ?, score = ?, revision = revision + 1
          WHERE member_id = ? AND revision = ? AND EXISTS (SELECT 1 FROM classes WHERE code = ? AND expires_at > ?) RETURNING revision`)
          .bind(JSON.stringify(reviewed.marks), reviewed.score, runId, data.revision, code, Date.now()).first();
        if (!updated) { await roomFor(db, code); fail(409, 'REVIEW_CHANGED', '批改已更新，請重新載入原卷再改。'); }
        return { ...reviewed, revision: updated.revision };
      }
    }
  }
  if (assigned.version === 2 && action === 'publication' && route.length === 2 && request.method === 'POST') {
    await ownerFor(request, room);
    await db.prepare('INSERT OR IGNORE INTO publications(code, published_at) SELECT ?, ? WHERE EXISTS (SELECT 1 FROM classes WHERE code = ? AND expires_at > ?)').bind(code, Date.now(), code, Date.now()).run();
    return reviewedBoard(db, room);
  }
  if (assigned.version === 2 && action === 'board' && route.length === 2 && request.method === 'GET') {
    const member = await memberFor(request, db, code);
    if (!await db.prepare('SELECT member_id FROM reviewed_submissions WHERE member_id = ?').bind(member.id).first()) fail(403, 'FINISH_FIRST', '請先交卷。');
    return reviewedBoard(db, room);
  }
  if (assigned.version === 2 && ['runs', 'teacher-board'].includes(action)) fail(409, 'ASSESSMENT_VERSION', '本班採用原筆跡批改，請開新版測驗。');
  if (action === 'members' && route.length === 2 && request.method === 'POST') {
    const data = await body(request), requestId = key(data.requestId);
    if (typeof data.alias !== 'string') fail(400, 'INVALID_ALIAS', '請輸入暱稱。');
    const alias = data.alias.normalize('NFC').trim();
    if (!alias || Array.from(alias).length > 20 || /[\p{Cc}\p{Cf}]/u.test(alias)) fail(400, 'INVALID_ALIAS', '暱稱限 1 至 20 個字，不可用控制字元。');
    if (typeof data.memberToken !== 'string' || !/^[a-f0-9]{64}$/.test(data.memberToken)) fail(400, 'INVALID_TOKEN', '參加身份無效。');
    const tokenHash = await hash(data.memberToken), aliasKey = alias.toLocaleLowerCase('en-US'), payloadHash = await hash(JSON.stringify({ alias, tokenHash }));
    await db.prepare(`INSERT OR IGNORE INTO members(id, code, alias, alias_key, token_hash, request_id, payload_hash)
      SELECT ?, ?, ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM members WHERE code = ?) < 100 AND EXISTS (SELECT 1 FROM classes WHERE code = ? AND expires_at > ?)`)
      .bind(crypto.randomUUID(), code, alias, aliasKey, tokenHash, requestId, payloadHash, code, code, Date.now()).run();
    const saved = await db.prepare('SELECT * FROM members WHERE code = ? AND request_id = ?').bind(code, requestId).first();
    if (saved) { if (saved.payload_hash !== payloadHash) fail(409, 'CONFLICT', '相同加入編號已有另一份資料。'); return { ...roomReply(room), memberId: saved.id, alias: saved.alias }; }
    const taken = await db.prepare('SELECT id FROM members WHERE code = ? AND alias_key = ?').bind(code, aliasKey).first();
    if (taken) fail(409, 'ALIAS_TAKEN', '呢個暱稱已有人用，請用另一個；同名唔會接管原有紀錄。');
    fail(429, 'MEMBER_LIMIT', '班級已滿或身份已使用，請聯絡老師。');
  }
  if (action === 'runs' && route.length === 3 && request.method === 'PUT') {
    key(runId); const member = await memberFor(request, db, code), data = await body(request);
    if (data.runId !== runId) fail(400, 'INVALID_ID', '紀錄編號唔一致。');
    let result;
    try { result = Q.evaluate(JSON.parse(room.assignment_json).entries, data); } catch (error) { fail(400, 'INVALID_RUN', error.message); }
    if (!result.terminal) fail(422, 'INCOMPLETE', '完成全部題目後先可以睇班級榜。');
    const payloadHash = await hash(JSON.stringify(result.evidence));
    await db.prepare(`INSERT OR IGNORE INTO runs(id, member_id, payload_hash, mistakes, elapsed_ms, reason, submitted_at)
      SELECT ?, ?, ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM runs WHERE member_id = ?) < 20 AND EXISTS (SELECT 1 FROM classes WHERE code = ? AND expires_at > ?)`)
      .bind(runId, member.id, payloadHash, result.score?.mistakes ?? null, result.score?.elapsedMs ?? null, result.reason, Date.now(), member.id, code, Date.now()).run();
    const saved = await db.prepare('SELECT * FROM runs WHERE member_id = ? AND id = ?').bind(member.id, runId).first();
    if (!saved) fail(429, 'RUN_LIMIT', '已交 20 次測驗，請老師開新一班。');
    if (saved.payload_hash !== payloadHash) fail(409, 'CONFLICT', '相同測驗編號已有另一份紀錄。');
    return { runId, ranked: saved.reason === null, reason: saved.reason, score: saved.reason === null ? { mistakes: saved.mistakes, elapsedMs: saved.elapsed_ms } : null };
  }
  if (action === 'board' && route.length === 2 && request.method === 'GET') {
    const member = await memberFor(request, db, code);
    if (!await db.prepare('SELECT id FROM runs WHERE member_id = ? LIMIT 1').bind(member.id).first()) fail(403, 'FINISH_FIRST', '完成全部題目後先可以睇班級榜。');
    return { ...await board(db, code, member.id), expiresAt: room.expires_at };
  }
  if (action === 'teacher-board' && route.length === 2 && request.method === 'GET') {
    if (await teacher(request) !== room.owner_id) fail(403, 'OWNER_REQUIRED', '只限開班瀏覽器查看。');
    return { ...await board(db, code, null), expiresAt: room.expires_at };
  }
  fail(404, 'NOT_FOUND', '搵唔到呢個頁面。');
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url), origin = request.headers.get('origin');
    const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Vary': 'Origin' };
    if (origin && (allowedOrigins.has(origin) || origin === url.origin)) {
      headers['Access-Control-Allow-Origin'] = origin;
      headers['Access-Control-Allow-Methods'] = 'GET, POST, PUT, OPTIONS';
      headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization';
    }
    try {
      if (origin && !headers['Access-Control-Allow-Origin']) fail(403, 'ORIGIN', '來源未獲允許。');
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
      if (['/', '/teacher'].includes(url.pathname) && request.method === 'GET') return new Response(teacherHTML, { headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' } });
      if (url.pathname !== '/api/v1/classes' && !url.pathname.startsWith('/api/v1/classes/')) fail(404, 'NOT_FOUND', '搵唔到呢個頁面。');
      return Response.json(await api(request, env, url), { headers });
    } catch (error) {
      if (!error.status) console.error('Classroom request failed', error.name);
      return Response.json({ error: { code: error.code || 'SERVICE_ERROR', message: error.status ? error.message : '班級服務暫時未能連線，請稍後重試。' } }, { status: error.status || 503, headers });
    }
  },
};
