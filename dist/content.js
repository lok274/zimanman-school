(function () {
  'use strict';
  const cues = {
    粗: ['條繩好粗。', 'M14 19C24 11 37 27 50 18M14 26C24 18 37 34 50 25M14 33C24 25 37 41 50 32M14 40C24 32 37 48 50 39'],
    濃: ['呢杯茶好濃。', 'M16 20H44V40Q44 48 36 48H24Q16 48 16 40ZM44 24H49Q58 24 53 34H44M14 53H49M24 9V15M34 9V15'],
    鬍鬚: ['伯伯留住鬍鬚。', 'M32 29C22 11 20 43 7 32C9 50 29 49 32 37C35 49 55 50 57 32C44 43 42 11 32 29Z'],
    密: ['啲樹葉生得好密。', 'M32 53V15M32 25C13 28 10 10 17 10C30 10 32 25 32 25ZM32 34C49 37 56 21 48 20C34 19 32 34 32 34ZM32 44C12 46 8 31 16 31C28 31 32 44 32 44ZM32 18C32 4 43 4 44 10C44 17 32 18 32 18Z'],
    剪草機: ['我用剪草機剪草。', 'M12 40H48L43 28H21ZM43 28L50 10H59M19 47A5 5 0 1 0 19 48M43 47A5 5 0 1 0 43 48M7 56V50M30 56V51M55 56V50'],
    推來推去: ['我將積木推來推去。', 'M23 25H42V45H23ZM5 16H24M5 16L11 10M5 16L11 22M59 53H40M59 53L53 47M59 53L53 59']
  };
  globalThis.BishunContent = {
    words: ['粗', '濃', '鬍鬚', '密', '剪草機', '推來推去'], cues,
    purposes: {
      粗: { label: '幫粗繩做標籤', intro: ['條繩好', '。'] },
      濃: { label: '幫濃茶做標籤', intro: ['呢杯茶好', '。'] },
      鬍鬚: { label: '幫鬍鬚做標籤', intro: ['伯伯留住', '。'] },
      密: { label: '幫樹葉做標籤', intro: ['啲樹葉生得好', '。'] },
      剪草機: { label: '幫剪草機做標籤', intro: ['我用', '剪草。'] },
      推來推去: { label: '幫積木動作做標籤', intro: ['我將積木', '。'] }
    },
    photos: { 粗: 'images/rope.webp', 濃: 'images/tea.webp', 鬍鬚: 'images/beard.webp', 密: 'images/leaves.webp', 剪草機: 'images/mower.webp', 推來推去: 'images/push-block.webp' },
    dataUrl: 'https://cdn.jsdelivr.net/npm/hanzi-writer-data@2.0.1/',
    edbUrl: 'https://www.edbchinese.hk/lexlist_ch/',
    cue(text) { return cues[text] || ['一齊讀出呢個詞語。', 'M15 13H43V52H15ZM23 23H35M23 32H35M23 41H31M43 15L52 10L56 16L43 34']; }
  };
})();
