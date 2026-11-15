# 給 Claude Code 的說明

私人用的電子券記錄，靜態網站。規則寫在 `core.js` 的註解和常數裡，資料格式寫在 `app.js` 開頭。

這個 repo 是公開的：README、這份文件、commit 訊息和 PR 說明都不要寫地點、活動名稱、使用者的個人情況，或資料庫的存取設定。

## 使用者是誰
- 只用手機。字要大、步驟要少、儲存後要明確看到成功。
- 不登入、不用帳號。
- 他們最想知道：每個人每個錢包要「給商家」多少、「自付」多少；買一件東西時怎樣付才用得到最多券。
- 只提醒電子券；商戶券和禮遇券可以登記，但不提醒。

## 設計原則
- 像 Linear 官網或蘋果備忘錄一樣乾淨。先砍功能，再砍文字；一個畫面只有一個主要動作，次要入口收起來。
- 畫面要靠版面看得懂，不要靠說明文字。
- 外觀是日系繪本風：只用淺色底（和紙白 `#FFFCF6`），3px 墨灰粗線框 `#3E3A39`，大圓角，平塗不用漸層；配色只用珊瑚粉 `#F2A497`、山吹黃 `#F6D27A`、水色 `#A8D3E6`、若竹綠 `#B9DAA5`；字型 Google Fonts「Huninn」。顏色都在 `app.css` 最上面的變數裡。
- 改動要小步上線，讓使用者跟得上。

## 做事方式
- 規則和計算只放在 `core.js`（純函式），畫面和 Firebase 放在 `app.js`。沒有建置步驟，不加框架。
- 不要改 Firebase 路徑和紀錄格式；正式資料庫有真實資料，測試一律用 `tests/mock-firebase.js`。
- 改了 `app.css`、`core.js` 或 `app.js`，要更新 `index.html` 裡三個 `?v=` 版本號，手機才會拿到新檔案；`core.test.js` 會檢查，忘了會失敗並告訴你該填的值。
- 每次改動都要跑：`node --test tests/core.test.js` 和 `python3 tests/flows.py`。新流程要在 `flows.py` 加上提交、返回、復原的檢查。
- 在分支上開發並開 PR 到 `main`；不要直接推到發佈中的分支。

## 已確認
- 店家可以分開多個錢包付款，所以試算會把一筆消費分給多個錢包。
- GitHub Pages 自 2026-11-15 起由分支 `claude/clever-lamport-1x0ztb` 發佈（原本是 `main`）；推到這個分支就會上線。
- 網站不需要登入。

## 檔案

| 檔案 | 內容 |
| --- | --- |
| `core.js` | 規則與計算，純函式，沒有畫面。改規則只改這裡。 |
| `app.js` | 畫面與 Firebase 讀寫。 |
| `index.html`、`app.css` | 版面與樣式。 |
| `tests/core.test.js` | 計算的單元測試。 |
| `tests/flows.py` | 用瀏覽器走完所有流程（提交、返回、復原、失敗、換週）。 |

沒有建置步驟，直接以靜態檔案發佈。

## 資料

路徑和紀錄格式寫在 `app.js` 開頭的註解。

## 先試用再發佈

```
python3 tests/preview.py      # 打開 http://localhost:8800/
```

用假資料開啟網站，不會讀寫正式資料；右上角會顯示「試用版・假資料」。同一個 Wi-Fi 下的手機可打開 `http://<電腦的 IP>:8800/`。試用資料留在瀏覽器裡，`/?reset` 還原成範例。

## 測試

```
node --test tests/core.test.js
python3 tests/flows.py        # 需要 playwright：pip install playwright && python3 -m playwright install chromium
```

`flows.py` 會擋住本機以外的所有連線；如果真的資料庫 SDK 被載入，它會立刻停止，不會動到正式資料。
