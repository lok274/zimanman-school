(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const client = BishunClassroom.create({ origin: document.body.getAttribute('data-classroom-origin') || 'https://zimanman-classroom-1023.lokyau65.chatgpt.site', changed: render });
  let poll = null, remaining = 120, active = !document.hidden;
  function node(tag, text, className) { const element = document.createElement(tag); element.textContent = text; if (className) element.className = className; return element; }
  function score(row) { return Number.isInteger(row.score) ? '字形正確 ' + row.score + ' 字' : '錯誤 ' + row.mistakes + ' 次 · ' + (row.elapsedMs / 1000).toFixed(1) + ' 秒'; }
  function render() {
    const view = client.view(), member = view.member, reviewed = member?.assignment.version === 2;
    $('board-identity').textContent = member ? '班級 ' + member.code + ' · ' + member.alias : '';
    $('board-status').textContent = !member ? '未有參加身份。請先加入班級，完成全部題目後再睇榜。' : view.needsContinue ? '共用平板請先核對暱稱；如果唔係你，返回首頁換下一位同學。' : !view.receipt ? '完成全部題目並交卷後先可以睇榜。' : view.message;
    $('board-continue').hidden = !view.needsContinue;
    $('board-continue').textContent = member ? '繼續以「' + member.alias + '」查看' : '確認暱稱並查看';
    $('board-refresh').hidden = !view.accepted || !view.receipt;
    $('board-refresh').disabled = view.busy;
    $('board-join').hidden = !!member && !!view.receipt;
    $('board-best').textContent = view.board?.personalBest ? member.alias + (reviewed ? ' · 第一份原卷：' : ' · 個人最佳：') + score(view.board.personalBest) : view.board ? reviewed ? '原卷仍待批改或公布。' : '個人最佳：未有可排名紀錄。' : '';
    if ($('board-policy')) $('board-policy').textContent = reviewed ? '第一份原卷字形正確數，同分同名次。' : '先比錯誤次數，再比書寫時間。同分同名次。';
    const container = $('board-results'); container.replaceChildren();
    if (active && view.accepted && view.board && !view.busy && poll === null && remaining > 0 && member.expiresAt > Date.now()) poll = setTimeout(() => { poll = null; remaining--; client.refresh(); }, 5000);
    if (!view.accepted || !view.board) return;
    if (!remaining) $('board-status').textContent += ' 自動更新已暫停，撳「更新排行榜」繼續。';
    if (!view.board.rows.length) { container.append(node('p', '未有可排名嘅完成紀錄。')); return; }
    const podium = node('div', '', 'class-podium');
    view.board.rows.filter(row => row.rank <= 3).forEach(row => { const card = node('div', '', 'podium-place'); card.append(node('strong', '第 ' + row.rank + ' 名'), node('span', row.alias), node('small', score(row))); podium.append(card); });
    const table = document.createElement('table'), header = document.createElement('tr');
    table.append(node('caption', reviewed ? '每位同學第一份原卷' : '每位同學全份測驗嘅最佳成績'));
    for (const text of reviewed ? ['名次', '暱稱', '字形正確'] : ['名次', '暱稱', '錯誤', '時間（秒）']) { const cell = node('th', text); cell.setAttribute('scope', 'col'); header.append(cell); } table.append(header);
    for (const row of view.board.rows) { const tr = document.createElement('tr'); if (row.isMe) tr.className = 'is-me'; for (const text of reviewed ? [row.rank, row.alias, row.score] : [row.rank, row.alias + (row.isMe ? '（你）' : ''), row.mistakes, (row.elapsedMs / 1000).toFixed(1)]) tr.append(node('td', String(text))); table.append(tr); }
    container.append(podium, table);
  }
  $('board-continue').addEventListener('click', () => { client.continueMember(); client.refresh(); });
  $('board-refresh').addEventListener('click', () => { remaining = 120; client.refresh(); });
  function pause() { active = false; clearTimeout(poll); poll = null; client.cancelRequests(); }
  document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); else { active = true; client.refresh(); } });
  window.addEventListener('pagehide', pause);
  window.addEventListener('pageshow', () => { active = !document.hidden; if (active) client.refresh(); });
  try {
    const handoff = JSON.parse(sessionStorage.getItem('bishun:board-handoff') || 'null');
    sessionStorage.removeItem('bishun:board-handoff');
    const view = client.view();
    if (handoff && handoff.memberId === view.member?.memberId && handoff.runId === view.receipt?.runId && Date.now() - handoff.at >= 0 && Date.now() - handoff.at < 60000) { client.continueMember(); client.refresh(); }
  } catch {}
  render();
})();
