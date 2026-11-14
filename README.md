# 消費券

一家人用的「2026 社區消費連環賞」電子券記錄。只做兩件事：

- **用券**：本週還有多少電子券未用；每人每個錢包要「給商家」多少、「自付」多少；輸入價錢，算出用哪幾個錢包付最划算。
- **登記**：記下每個錢包每週三次抽獎的結果。

## 活動規則（程式只依賴這幾條）

- 活動期 2026-10-09 至 2026-12-17，每週由週五到週四。
- 週五至週日抽獎，每個錢包每週 3 次；電子券面額 10／20／50／100／200。
- 電子券在該週週四 23:59 到期。
- 付款滿面額 3 倍自動扣減；同一錢包多張券由大至小逐張扣。
- 商戶券、禮遇券不記錄、不提醒。

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

Firebase Realtime Database：

- `campaigns/2026R2/weeks/<週>/coupons/<id>`：`{ member, payment, type: "gov" | "zero", amount, used, usedAt, createdAt, redemption }`
- `campaigns/2026R2/settings/wallets/<家人>/<錢包>`：`true | false`

## 測試

```
node --test tests/core.test.js
python3 tests/flows.py        # 需要 playwright
```
