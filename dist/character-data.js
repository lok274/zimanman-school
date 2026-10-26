(function (root) {
  'use strict';
  function validateCharacter(character, raw) {
    const data = raw && raw.data ? raw.data : raw;
    if (!/^\p{Script=Han}$/u.test(character) || !data || (data.character && data.character !== character) || !Array.isArray(data.strokes) || !data.strokes.length || data.strokes.length > 64 || !Array.isArray(data.medians) || data.medians.length !== data.strokes.length) throw new Error('字形資料不完整。');
    let size = 0;
    data.strokes.forEach(path => {
      if (typeof path !== 'string' || path.length > 150000 || !/^[Mm]/.test(path) || !/^[MmLlQqTtCcSsVvHhZzAa0-9+.,\s-]+$/.test(path)) throw new Error('筆畫資料無效。');
      const numbers = path.match(/[+-]?(?:\d*\.)?\d+/g) || [];
      if (!numbers.length || numbers.some(n => !Number.isFinite(Number(n)) || Math.abs(Number(n)) > 8192)) throw new Error('筆畫座標無效。');
      size += path.length;
    });
    if (size > 1200000 || data.medians.some(points => !Array.isArray(points) || points.length < 2 || points.length > 2000 || points.some(p => !Array.isArray(p) || p.length !== 2 || p.some(n => !Number.isFinite(n) || Math.abs(n) > 8192)))) throw new Error('筆畫座標無效。');
    return { strokes: data.strokes, medians: data.medians, radStrokes: Array.isArray(data.radStrokes) ? data.radStrokes.filter(n => Number.isInteger(n) && n >= 0 && n < data.strokes.length) : [] };
  }
  async function loadCharacter(character, signal, registry = root.BishunCharacters || {}, dataUrl = root.BishunContent?.dataUrl) {
    if (!/^\p{Script=Han}$/u.test(character)) throw new Error('請使用單一中文字。');
    if (Object.prototype.hasOwnProperty.call(registry, character)) return validateCharacter(character, registry[character]);
    // shortcut: 草 requires the reviewed ten-stroke asset; never fall back to the nine-stroke upstream file.
    if (character === '草') throw new Error('呢個字嘅香港筆順資料尚未備妥。');
    const response = await fetch(dataUrl + encodeURIComponent(character) + '.json', { signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (!response.ok) throw new Error('暫時未能載入呢個字。');
    const declared = Number(response.headers.get('content-length'));
    if (declared > 2000000) throw new Error('字形資料過大。');
    const reader = response.body && response.body.getReader();
    let text = '';
    if (reader) {
      const decoder = new TextDecoder(); let bytes = 0;
      while (true) { const result = await reader.read(); if (result.done) break; bytes += result.value.byteLength; if (bytes > 2000000) { await reader.cancel(); throw new Error('字形資料過大。'); } text += decoder.decode(result.value, { stream: true }); }
      text += decoder.decode();
    } else { text = await response.text(); if (text.length > 2000000) throw new Error('字形資料過大。'); }
    return validateCharacter(character, JSON.parse(text));
  }
  const api = { validateCharacter, loadCharacter };
  root.BishunCharacterData = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
