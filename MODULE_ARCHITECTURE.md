# 寫字樂：模組單體架構與程式碼說明

## 1. 先說結論

本專案採用「模組單體（modular monolith）」：

- 網頁、練習、測驗、排行榜和老師工具仍然是同一個網站。
- 每項功能在自己的 JavaScript 模組中管理。
- 模組之間只透過清楚的資料形狀和公開 API 溝通。
- 不把學生資料拆到多個服務，也不新增登入、打包器或付費依賴。

這個選擇適合學校平板和 GitHub Pages：部署簡單，離線單檔版可以繼續使用，資料儲存和班級服務的責任也容易分辨。

## 2. 模組地圖

```text
index.html
  ├─ content.js             詞語、圖片、例句和字庫來源
  ├─ session.js              練習狀態、流程轉移、紀錄摘要
  ├─ quiz-results.js         小挑戰結果、排行榜分數資料
  ├─ assessment.js           小挑戰題目及提交規則
  ├─ assessment-store.js     小挑戰原稿的本機保存
  ├─ freehand.js              自由書寫取樣及筆跡資料
  ├─ assessment-review.js     老師批改、公布結果和重播資料
  ├─ classroom.js             班級 API、暱稱、收卷及權限邊界
  ├─ assessment-ui.js         小挑戰畫面及操作控制器
  ├─ writing.js               Hanzi Writer 書寫格、筆順及提示
  └─ app.js                   應用程式組合根：路由、DOM 和事件協調

leaderboard.html
  ├─ quiz-results.js
  ├─ assessment.js
  ├─ classroom.js
  └─ leaderboard.js           只負責排行榜頁面

standalone.html               由 scripts/standalone.cjs 產生
  └─ 將 index.html 和上述模組嵌入單一檔案
```

`app.js` 是組合根，不是資料庫或規則中心。它把模組接到頁面和事件上；真正的練習規則仍在 `session.js`、`writing.js` 和 `assessment.js`。

## 3. 各模組的責任

### 3.1 `content.js`：內容資料

它只提供內容，不改變練習狀態。

```js
globalThis.BishunContent = {
  words: ['粗', '濃', '鬍鬚', '密', '剪草機', '推來推去'],
  cues,
  purposes,
  photos,
  dataUrl
};
```

應由它管理的項目：

- 課本詞語和詞語順序
- 圖片路徑
- 語意提示和作品卡句子
- 筆順資料的來源網址

不應由它管理：目前寫到第幾筆、是否完成、排行榜分數或 DOM。

### 3.2 `session.js`：練習領域模型

它是練習的純狀態核心，主要輸入是目前狀態和事件，輸出是下一個狀態。

```js
const next = BishunSession.transition(state, {
  type: 'STROKE_ACCEPTED',
  token,
  strokeIndex,
  points
});
```

狀態包括：

- `version`：練習紀錄版本
- `mode`：`practice` 或 `quiz`
- `entries`：詞語和指定字位
- `occurrences`：每個詞語位置的獨立練習項目
- `active`：目前畫面和目前字位
- `attempts`：每次嘗試、提示、重試和跳過紀錄
- `wordChoices`：學生選擇「自己寫」或「跟隨書寫」的路徑

這些資料要保持可序列化，因為本機紀錄會寫入 `localStorage`，測驗原稿則由 `assessment-store.js` 以 IndexedDB 保存。

### 3.3 `writing.js`：書寫工具適配層

它包住 Hanzi Writer，避免其他模組直接依賴第三方 API。

主要責任：

- 建立和銷毀書寫格
- 播放筆順示範
- 接收書寫筆畫事件
- 顯示跟隨書寫的起點和方向
- 把接受的筆畫回傳給 `app.js`

`writing.js` 不決定學生是否完成整個詞語，也不保存班級資料。它只處理「這一格如何顯示及回報事件」。

### 3.4 `freehand.js`：自由書寫資料

小挑戰不使用逐畫配對，而是保存學生真正畫下的取樣點：

```js
{
  id: 'attempt-id',
  position: 2,
  strokes: [
    [{ x: 0.12, y: 0.28, t: 14 }, ...]
  ],
  outcome: 'submitted'
}
```

它只負責：

- 將觸控點轉成可保存資料
- 保留原始筆跡
- 一次撤回最後一筆
- 驗證點的範圍、順序及數量

字形是否正確由老師在 `assessment-review.js` 批改，不在這個模組猜測。

### 3.5 `assessment.js`：小挑戰規則

它定義小挑戰的題目和不可變規則：

- 看字寫或聽詞寫
- 每頁一個字
- 提交、跳過、完成和待批改狀態
- 第一份完整原卷才是正式成績
- 後續補練不覆蓋正式原卷

這些規則必須保持純函式化，方便測試，也避免 UI 按鈕直接改寫原稿。

### 3.6 `assessment-store.js`：本機原稿保存

這個模組是 IndexedDB 邊界。它負責：

- 保存每次落筆的取樣點
- 保存提交前的草稿
- 在儲存失敗時保留畫面原稿
- 重新載入時恢復明確選擇的原卷

它不應該知道按鈕文字、排行榜或 Hanzi Writer。

### 3.7 `assessment-review.js`：老師批改

它把老師的判斷保存為獨立資料：

```js
{
  position: 2,
  shape: 'correct',       // correct | retry | pending
  strokeOrder: 'practise' // practise | okay | pending
}
```

排行榜只使用 `shape: 'correct'` 的數量。筆順需要補練則另外記錄，避免把「寫得出」和「筆順需要教」混成一個分數。

### 3.8 `classroom.js`：班級服務邊界

它是唯一直接接觸班級服務 API 的前端模組，負責：

- 建立和加入班級
- 保存班級碼、暱稱及瀏覽器憑證
- 上傳已提交原卷
- 讀取老師公布的排行榜
- 處理 24 小時到期和權限錯誤

學生頁不應直接呼叫 `fetch()` 讀班級 API；需要班級資料時，呼叫 `BishunClassroom` 的方法。這樣可集中處理重試、過期和錯誤訊息。

### 3.9 `assessment-ui.js`：小挑戰畫面控制器

它把 `assessment.js` 的狀態顯示成 UI，並把按鈕事件轉回規則層。

```js
const assessment = BishunAssessmentUI.create({
  classroom,
  onClose: goHome,
  onPractice: startPracticeFromAssignment
});
```

它不應自己計分，也不應繞過 `assessment-store.js` 直接保存原稿。

### 3.10 `app.js`：組合根和畫面協調

`app.js` 的工作是把以上模組接在一起：

1. 讀取目前 DOM。
2. 建立本機練習或小挑戰工作階段。
3. 將按鈕事件轉成領域事件。
4. 呼叫保存、語音、書寫格和班級模組。
5. 根據狀態重新繪畫畫面。

它可以知道所有 UI 模組，但不應把資料規則偷偷複製一份。當一條規則同時出現在 `app.js` 和 `session.js`，應把規則移回領域模組，`app.js` 只保留協調。

## 4. 一次練習的資料流

```text
學生按下「自己寫」
  ↓
app.js 建立 session
  ↓
session.js 回傳 active.phase = recall
  ↓
writing.js 建立自由書寫格
  ↓
學生觸控 → freehand.js 收集取樣點
  ↓
app.js 發出 STROKE_ACCEPTED / STROKE_MISSED
  ↓
session.js 更新 attempts
  ↓
app.js render() 更新畫面
  ↓
localStorage 保存練習摘要
```

小挑戰的提交路徑不同：

```text
學生按「交答案」
  ↓
assessment.js 封存該字的狀態
  ↓
assessment-store.js 先保存原筆跡
  ↓
assessment-ui.js 顯示「已交」
  ↓
老師在 review 畫面批改
  ↓
assessment-review.js 保存字形判斷
  ↓
quiz-results.js 只用已確認的正確字數排名
```

## 5. 依賴方向

依賴應由上而下，不能反過來：

```text
頁面組合層：app.js / assessment-ui.js / leaderboard.js
        ↓
領域規則：session.js / assessment.js / quiz-results.js
        ↓
資料邊界：assessment-store.js / classroom.js / localStorage
        ↓
外部適配：writing.js / SpeechSynthesis / fetch / IndexedDB
```

實際寫新功能時，遵守以下規則：

1. 不在 UI 事件中直接改 `state`。
2. 不在 `content.js` 寫保存或網絡邏輯。
3. 不在 `writing.js` 判斷排行榜分數。
4. 不在 `classroom.js` 修改學生書寫流程。
5. 不讓單檔版加入一套不同的規則；它只嵌入同一批模組。

## 6. 為甚麼沒有拆成微服務

這個網站面向學校平板，主要需求是穩定、簡單和不需登入。把練習、排行榜和語音拆成多個網絡服務會增加：

- 部署失敗的組合點
- 平板網絡延遲
- 跨服務資料一致性問題
- 教師排錯成本

因此目前只保留真正需要跨平板共享的班級服務；學生練習、原稿和本機歷史仍在前端保存。這不是「所有程式放在一個檔案」，而是「一個可部署單體內有清楚模組邊界」。

## 7. 新增功能的步驟

以新增「練習完成後播放鼓勵語音」為例：

1. 先在領域資料中定義事件或狀態，例如 `completion.kind`。
2. 在 `session.js` 或 `assessment.js` 更新狀態，不先改 DOM。
3. 在 `app.js` 的協調層訂閱完成狀態。
4. 在語音適配函式播放，並處理沒有粵語聲音的情況。
5. 在 `tests/runtime.test.cjs` 測試學生可見行為。
6. 重新產生 `standalone.html`，確保單檔版使用相同規則。

## 8. 驗證方法

每次模組修改後執行：

```powershell
node scripts/version-assets.cjs
node scripts/standalone.cjs
node --test tests/*.test.cjs
node classroom-service/build.mjs
node dist/data/self-check.mjs
git diff --check
```

測試重點不是檔案名稱，而是可觀察行為：

- 練習返回後筆跡和進度仍在
- 擦掉前一筆只移除當次最後一筆
- 小挑戰原稿不會被補練覆蓋
- 老師批改後排行榜只計算已確認字形
- 權限、過期及儲存失敗不會洩漏其他學生資料
- 網頁版和單檔版使用相同控制及資料規則

## 9. 目前的實際限制

`app.js` 仍是較大的組合根，因為它同時負責 DOM、路由和生命週期。這是有意保留的邊界：若只為了「看起來更細」而把它切成十多個互相呼叫的薄包裝，會增加讀者要追蹤的層數，並提高單檔版和舊紀錄回歸風險。

下一次真的需要拆 `app.js` 時，應一次只抽出一個有明確輸入和輸出的領域，例如先抽出「語音控制器」或「本機歷史」，每次抽出後立即跑完整測試和單檔建置；不要先引入框架或打包器。
