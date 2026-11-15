# 消費券

一家人用的「2026 社區消費連環賞」電子券記錄。只做兩件事：

- **用券**：本週還有多少電子券未用；每人每個錢包要「給商家」多少、「自付」多少；輸入價錢，算出用哪幾個錢包付最划算（可只用部分家人的券；會提示再買多少可多減，或「剛剛好」）。
收起的「已用電子券」列出本週每筆已付款的「給商家／自付」，點一筆可復原。
- **登記**：記下每個錢包每週三次抽獎的結果；收起的「各週抽中的券」可查看每一週和全期的抽中、已用、給商家、自付，以及手氣王、最旺錢包（只看，不能改），並可「匯出備份」（一個 JSON 檔，結構和資料庫相同）。

所有列表都是同一種表格：家人名字一列（有多個錢包時旁邊是小計），下面是各錢包。

已用券的「給商家／自付」用付款時存下的金額（`redemption.actualSpendCents`／`actualPaidCents`）；沒有存金額的舊紀錄以剛好用到券的最低消費估算。

## 活動規則（程式只依賴這幾條）

- 活動期 2026-10-09 至 2026-12-17，每週由週五到週四。
- 週五至週日抽獎，每個錢包每週 3 次；電子券面額 10／20／50／100／200。
- 電子券在該週週四 23:59 到期。
- 付款滿面額 3 倍自動扣減；同一錢包多張券由大至小逐張扣。
- 商戶券（滿 100 減 12，每筆一張，先扣）和禮遇券可以登記，但不計入首頁的數字和提醒；輸入價錢後勾選「這間店可用商戶券」才納入計算。

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

- `campaigns/2026R2/weeks/<週>/coupons/<id>`：`{ member, payment, type: "gov" | "merchant" | "gift" | "zero", amount, used, usedAt, createdAt, redemption }`
- `campaigns/2026R2/settings/wallets/<家人>/<錢包>`：`true | false`

## 先試用再發佈

```
python3 tests/preview.py      # 打開 http://localhost:8800/
```

用假資料開啟網站，不會讀寫正式的 Firebase；右上角會顯示「試用版・假資料」。同一個 Wi-Fi 下的手機可打開 `http://<電腦的 IP>:8800/`。試用資料留在瀏覽器裡，`/?reset` 還原成範例。

## 測試

```
node --test tests/core.test.js
python3 tests/flows.py        # 需要 playwright：pip install playwright && python3 -m playwright install chromium
```

`flows.py` 會擋住本機以外的所有連線；如果真的 Firebase SDK 被載入，它會立刻停止，不會動到家人的資料。
