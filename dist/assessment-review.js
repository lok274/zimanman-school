(function (root) {
  'use strict';
  function node(tag, text, className) { const item = document.createElement(tag); if (text) item.textContent = text; if (className) item.className = className; return item; }
  function mount(container, data, onSave) {
    const A = root.BishunAssessment, F = root.BishunFreehand, positions = A.positions(data.run.assignment);
    let marks = structuredClone(data.marks), revision = data.revision, stopReplay = null, disposed = false;
    const status = node('p', '', 'review-status'); status.setAttribute('role', 'status');
    const rows = node('div', '', 'review-answers');
    data.run.answers.forEach((answer, index) => {
      const position = positions[index], row = node('section', '', 'review-answer');
      row.append(node('h3', position.word + ' · 第 ' + (position.index + 1) + ' 字「' + position.character + '」'));
      const word = data.run.wordProgress?.[A.wordAt(data.run, index).wordIndex];
      if (word && A.wordAt(data.run, index).start === index) row.append(node('p', (word.timeKnown ? '詞語用時 ' : '續寫用時 ') + (word.elapsedMs / 1000).toFixed(1) + ' 秒'));
      if (answer.hintUsed) row.append(node('p', '有提示'));
      const paper = node('div', '', 'review-paper'); F.render(paper, answer.strokes); row.append(paper);
      row.append(node('p', answer.status === 'skipped' ? '跳過，保留原筆跡' : '已提交原筆跡'));
      const replay = node('button', '重播原筆跡', 'button secondary');
      replay.addEventListener('click', () => { stopReplay?.(); stopReplay = F.replay(paper, answer.strokes); }); row.append(replay);
      const label = node('label', '字形 '), select = node('select'); select.setAttribute('aria-label', '第 ' + (index + 1) + ' 題字形');
      for (const [value, text] of [['pending', '待批改'], ['correct', 'O 正確'], ['practice', '再練習']]) { const option = node('option', text); option.value = value; select.append(option); }
      select.value = marks[index].correct === null ? 'pending' : marks[index].correct ? 'correct' : 'practice';
      select.addEventListener('change', () => { marks[index].correct = select.value === 'pending' ? null : select.value === 'correct'; });
      label.append(select); row.append(label);
      const note = node('label', '筆順需要練習 '), checkbox = node('input'); checkbox.type = 'checkbox'; checkbox.checked = marks[index].strokePractice;
      checkbox.addEventListener('change', () => { marks[index].strokePractice = checkbox.checked; }); note.append(checkbox); row.append(note); rows.append(row);
    });
    const save = node('button', '保存批改', 'button primary');
    save.addEventListener('click', async () => {
      if (save.disabled) return; save.disabled = true;
      try {
        const result = await onSave({ marks: structuredClone(marks), revision });
        if (disposed) return;
        revision = result.revision; marks = structuredClone(result.marks);
        status.textContent = result.score === null ? '已保存，仍有待批改項目。' : '已保存。字形正確 ' + result.score + ' / ' + marks.length;
      } catch (error) { if (!disposed) status.textContent = error.message; }
      finally { if (!disposed) save.disabled = false; }
    });
    container.replaceChildren(node('p', (A.actualMode(data.run) === 'copy' ? '看字寫' : '聽詞寫') + ' · 書寫時間 ' + ((data.elapsedMs ?? data.run.elapsedMs) / 1000).toFixed(1) + ' 秒 · 批改版本 ' + revision), rows, save, status);
    return () => { disposed = true; stopReplay?.(); };
  }
  root.BishunAssessmentReview = { mount };
})(typeof globalThis !== 'undefined' ? globalThis : this);
