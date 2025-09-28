const firebaseConfig = {
  apiKey: "AIzaSyCJY3vzA7xuC-bC6PLGk5wGAe_rjPMP4w4",
  authDomain: "testing-a7aba.firebaseapp.com",
  projectId: "testing-a7aba",
  storageBucket: "testing-a7aba.firebasestorage.app",
  messagingSenderId: "94291975544",
  appId: "1:94291975544:web:1fc1e0aff39d8fd0357c8d",
  databaseURL: "https://testing-a7aba-default-rtdb.firebaseio.com/",
};

let db;
const BASE_PATH = "coupons/2025-W";
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const BASE_DATE = new Date("2025-01-01");
const ACTIVITY_START = new Date("2025-09-01");
const ACTIVITY_END = new Date("2025-11-30");
const START_WEEK = 36;
const MAX_WEEK = 48;
const CONSUMABLE_MULTIPLIER = 3;
const SPENDING_MULTIPLIER = 3;
const AMOUNTS = [0, 10, 20, 50, 100, 200];

function initFirebase() {
  try {
    firebase.initializeApp(firebaseConfig);
    db = firebase.database();
    console.log("Firebase 初始化成功");
    document.getElementById("errorMessage").style.display = "none";
  } catch (error) {
    console.error("Firebase 初始化錯誤:", error);
    document.getElementById("errorMessage").innerHTML =
      "無法連線 Firebase，請檢查網路、API 密鑰或使用本地伺服器（npx http-server）。建議確認 Firebase 控制台中的 apiKey 和 databaseURL。";
    document.getElementById("errorMessage").style.display = "block";
  }
}

function getCurrentWeek() {
  const now = new Date();
  const start = new Date(BASE_DATE);
  start.setDate(start.getDate() - (start.getDay() || 7) + 1); // 調整到週一
  if (now < ACTIVITY_START) return START_WEEK;
  if (now > ACTIVITY_END) return MAX_WEEK;
  const diff = now - start;
  const week = Math.floor(diff / WEEK_MS) + 1;
  return Math.min(Math.max(week, START_WEEK), MAX_WEEK);
}

function formatDate(date) {
  return date
    .toLocaleDateString("zh-TW", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
    .replace(/\//g, "-");
}

function getWeekOptions() {
  const options = [];
  for (let i = START_WEEK; i <= MAX_WEEK; i++) {
    const start = new Date(BASE_DATE.getTime());
    start.setDate(start.getDate() - (start.getDay() || 7) + 1 + (i - 1) * 7); // 週一
    const end = new Date(start.getTime() + 6 * 24 * 60 * 60 * 1000); // 週日
    options.push({
      value: i,
      text: `第 ${i} 週 (${formatDate(start)} - ${formatDate(end)})`,
    });
  }
  return options;
}

function openModal() {
  const now = new Date();
  if (now < ACTIVITY_START) alert("注意：活動尚未開始，但可新增測試資料。");
  document.getElementById("entryModal").classList.remove("hidden");
}

function closeModal() {
  document.getElementById("entryModal").classList.add("hidden");
}

function exportToExcel() {
  if (!db) return alert("Firebase 未初始化");
  document.getElementById("loading").style.display = "block";
  const path = `${BASE_PATH}${selectedWeek}`;
  console.log(`匯出查詢路徑: ${path}`);
  db.ref(path)
    .once("value")
    .then((snapshot) => {
      const entries = snapshot.val();
      if (!entries) {
        alert("沒有資料可匯出");
        document.getElementById(
          "errorMessage"
        ).innerHTML = `無數據於路徑: ${path}`;
        document.getElementById("errorMessage").style.display = "block";
        return;
      }
      const rows = Object.entries(entries).map(([id, e]) => ({
        家庭成員: e.member,
        支付方式: e.payment,
        金額: e.amount,
        狀態: e.used ? "已使用" : "未使用",
      }));
      const ws = XLSX.utils.json_to_sheet(rows);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "優惠券");
      XLSX.writeFile(wb, `優惠券_第${selectedWeek}週.xlsx`);
    })
    .catch((error) => {
      console.error("匯出錯誤:", error);
      alert("匯出失敗，請檢查 console。");
    })
    .finally(() => {
      document.getElementById("loading").style.display = "none";
    });
}

let selectedWeek = getCurrentWeek();
let filters = { member: "", payment: "" };

function updateWeekSelector() {
  const selector = document.getElementById("weekSelector");
  selector.innerHTML = "";
  const current = getCurrentWeek();
  selectedWeek = current;
  getWeekOptions().forEach((opt) => {
    const option = document.createElement("option");
    option.value = opt.value;
    option.textContent = opt.text;
    selector.appendChild(option);
  });
  selector.value = selectedWeek;
  selector.onchange = () => {
    selectedWeek = parseInt(selector.value);
    loadData();
  };
  console.log(
    `週選擇器初始化：選項數=${selector.options.length}, 當前週=${selectedWeek}`
  );
}

function loadData() {
  document.getElementById("tableContainer").innerHTML =
    "<p>正在載入數據...</p>";
  document.getElementById("summaryTableContainer").innerHTML = "";
  if (!db) {
    document.getElementById("errorMessage").innerHTML =
      "Firebase 未初始化，無法載入資料。請檢查網路或 Firebase 設定。";
    document.getElementById("errorMessage").style.display = "block";
    updateWeekSelector();
    document.getElementById("tableContainer").innerHTML =
      "<p>無資料（Firebase 未連線）。</p>";
    return;
  }
  selectedWeek = Math.min(Math.max(selectedWeek, START_WEEK), MAX_WEEK);
  document.getElementById("loading").style.display = "block";
  const path = `${BASE_PATH}${selectedWeek}`;
  console.log(`查詢數據路徑: ${path}`);
  db.ref(path).on(
    "value",
    (snapshot) => {
      const data = snapshot.val() || {};
      console.log(`週 ${selectedWeek} 數據:`, data);
      if (!Object.keys(data).length) {
        document.getElementById(
          "errorMessage"
        ).innerHTML = `無數據於路徑: ${path}，請確認 Firebase 資料庫結構。`;
        document.getElementById("errorMessage").style.display = "block";
        document.getElementById("tableContainer").innerHTML =
          "<p>本週無優惠券數據。</p>";
        document.getElementById("summaryTableContainer").innerHTML = "";
      } else {
        document.getElementById("errorMessage").style.display = "none";
      }
      let filteredData = data;
      if (filters.member)
        filteredData = Object.fromEntries(
          Object.entries(data).filter(([_, e]) => e.member === filters.member)
        );
      if (filters.payment)
        filteredData = Object.fromEntries(
          Object.entries(filteredData).filter(
            ([_, e]) => e.payment === filters.payment
          )
        );
      console.log(`過濾後數據:`, filteredData);
      renderTable(filteredData);
      renderSummary(filteredData);
      document.getElementById("loading").style.display = "none";
    },
    (error) => {
      console.error("載入資料錯誤:", error);
      document.getElementById(
        "errorMessage"
      ).innerHTML = `載入資料失敗，路徑: ${path}，錯誤: ${error.message}`;
      document.getElementById("errorMessage").style.display = "block";
      document.getElementById("loading").style.display = "none";
      document.getElementById("tableContainer").innerHTML =
        "<p>無資料（查詢失敗）。</p>";
    }
  );
}

function renderTable(data) {
  const tableContainer = document.getElementById("tableContainer");
  if (!Object.keys(data).length) {
    tableContainer.innerHTML = "<p>本週無優惠券數據。</p>";
    return;
  }
  let html = `<table><thead><tr><th>家庭成員</th><th>支付方式</th><th>金額</th><th>操作</th></tr></thead><tbody>`;
  const groups = {};
  Object.entries(data).forEach(([id, entry]) => {
    const key = `${entry.member}-${entry.payment}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push({ id, amount: entry.amount, used: entry.used });
  });
  const sortedKeys = Object.keys(groups).sort((a, b) => {
    const [ma, pa] = a.split("-");
    const [mb, pb] = b.split("-");
    return ma.localeCompare(mb) || pa.localeCompare(pb);
  });
  for (const key of sortedKeys) {
    const [member, payment] = key.split("-");
    const entries = groups[key];
    entries.forEach((entry, index) => {
      const rowClass = entry.used ? "used" : "";
      html += `
        <tr class="${rowClass}">
          ${
            index === 0
              ? `<td rowspan="${entries.length}" class="member-${member}">${member}</td>`
              : ""
          }
          <td>${payment}</td>
          <td>${entry.amount}</td>
          <td>
            <button class="action-btn" onclick="markUsed('${
              entry.id
            }', ${!entry.used})">✅</button>
            <button class="action-btn" onclick="removeEntry('${
              entry.id
            }')">🗑️</button>
          </td>
        </tr>`;
    });
  }
  html += `</tbody></table>`;
  tableContainer.innerHTML = html;
}

function renderSummary(data) {
  const summary = {};
  let grandTotal = { consumable: 0, spending: 0, actual: 0 };
  for (const entry of Object.values(data)) {
    const { member, payment, amount, used } = entry;
    if (!AMOUNTS.includes(amount) || amount === 0) continue; // 忽略無效面額和 0 元
    if (!summary[member])
      summary[member] = {
        payments: {},
        memberTotal: { consumable: 0, spending: 0, actual: 0 },
      };
    if (!summary[member].payments[payment])
      summary[member].payments[payment] = {
        consumable: 0,
        spending: 0,
        actual: 0,
        count: 0,
        allUsed: true,
      };
    summary[member].payments[payment].count += 1;
    summary[member].payments[payment].allUsed =
      summary[member].payments[payment].allUsed && used;
    if (used) {
      const spending = amount * SPENDING_MULTIPLIER;
      const actual = spending - amount;
      summary[member].payments[payment].spending += spending;
      summary[member].payments[payment].actual += actual;
      summary[member].memberTotal.spending += spending;
      summary[member].memberTotal.actual += actual;
      grandTotal.spending += spending;
      grandTotal.actual += actual;
    } else {
      const consumable = amount * CONSUMABLE_MULTIPLIER;
      summary[member].payments[payment].consumable += consumable;
      summary[member].memberTotal.consumable += consumable;
      grandTotal.consumable += consumable;
    }
  }
  let html = `<table class="summary-table"><thead><tr><th>家庭成員</th><th>支付方式</th><th>可消費金額</th><th>支出金額</th><th>實際支出</th><th>操作</th></tr></thead><tbody>`;
  for (const [member, { payments, memberTotal }] of Object.entries(
    summary
  ).sort((a, b) => a[0].localeCompare(b[0]))) {
    const rowSpan = Object.keys(payments).length; // 僅計支付方式數量
    const rows = Object.entries(payments).map(
      ([payment, { consumable, spending, actual, allUsed }], index) =>
        `<tr>
        ${
          index === 0 && rowSpan > 0
            ? `<td rowspan="${rowSpan}" class="member-${member}">${member}</td>`
            : ""
        }
        <td>${payment}</td>
        <td>${consumable}</td>
        <td>${spending}</td>
        <td>${actual}</td>
        <td><button class="group-action-btn" onclick="markGroupUsed('${member}', '${payment}', ${!allUsed})">✅</button></td>
      </tr>`
    );
    rows.push(`
      <tr class="summary-total">
        <td colspan="2">${member}合計</td>
        <td>${memberTotal.consumable}</td>
        <td>${memberTotal.spending}</td>
        <td>${memberTotal.actual}</td>
        <td></td>
      </tr>
    `);
    html += rows.join("");
  }
  if (Object.keys(summary).length > 0) {
    html += `
      <tr class="summary-total">
        <td colspan="2">全家合計</td>
        <td>${grandTotal.consumable}</td>
        <td>${grandTotal.spending}</td>
        <td>${grandTotal.actual}</td>
        <td></td>
      </tr>`;
  }
  html += `</tbody></table>`;
  if (!Object.keys(summary).length)
    html += `<p>提示：無有效優惠券數據，金額計算為 0。</p>`;
  document.getElementById("summaryTableContainer").innerHTML = html;
}

function addEntry(e) {
  e.preventDefault();
  const member = document.getElementById("member").value;
  const payment = document.getElementById("payment").value;
  const amounts = [
    parseInt(document.getElementById("amount1").value),
    parseInt(document.getElementById("amount2").value),
    parseInt(document.getElementById("amount3").value),
  ];
  if (amounts.some((a) => !AMOUNTS.includes(a))) return alert("請選擇有效金額");
  if (!db) return alert("Firebase 未初始化");
  document.getElementById("loading").style.display = "block";
  const path = `${BASE_PATH}${selectedWeek}`;
  console.log(`新增數據路徑: ${path}`);
  amounts.forEach((amount) => {
    if (amount === 0) return; // 跳過 0 元
    const ref = db.ref(path).push();
    ref.set({ member, payment, amount, used: false }).catch((error) => {
      console.error("新增錯誤:", error);
      alert("新增失敗，請檢查 console。");
    });
  });
  document.getElementById("entryForm").reset();
  closeModal();
  document.getElementById("loading").style.display = "none";
}

function markUsed(id, status) {
  if (!db) return alert("Firebase 未初始化");
  document.getElementById("loading").style.display = "block";
  const path = `${BASE_PATH}${selectedWeek}/${id}`;
  console.log(`更新狀態路徑: ${path}`);
  db.ref(path)
    .update({ used: status })
    .catch((error) => {
      console.error("更新狀態錯誤:", error);
      alert("更新失敗，請檢查 console。");
    })
    .finally(() => {
      document.getElementById("loading").style.display = "none";
    });
}

function markGroupUsed(member, payment, targetStatus) {
  if (!db) return alert("Firebase 未初始化");
  document.getElementById("loading").style.display = "block";
  const path = `${BASE_PATH}${selectedWeek}`;
  console.log(
    `群組標記路徑: ${path}, 成員: ${member}, 支付方式: ${payment}, 目標狀態: ${targetStatus}`
  );
  db.ref(path)
    .once("value")
    .then((snapshot) => {
      const data = snapshot.val() || {};
      Object.entries(data).forEach(([id, entry]) => {
        if (entry.member === member && entry.payment === payment) {
          markUsed(id, targetStatus);
        }
      });
    })
    .catch((error) => {
      console.error("群組標記錯誤:", error);
      alert("群組標記失敗，請檢查 console。");
    })
    .finally(() => {
      document.getElementById("loading").style.display = "none";
    });
}

function removeEntry(id) {
  if (!db) return alert("Firebase 未初始化");
  document.getElementById("loading").style.display = "block";
  const path = `${BASE_PATH}${selectedWeek}/${id}`;
  console.log(`刪除數據路徑: ${path}`);
  db.ref(path)
    .remove()
    .catch((error) => {
      console.error("刪除錯誤:", error);
      alert("刪除失敗，請檢查 console。");
    })
    .finally(() => {
      document.getElementById("loading").style.display = "none";
    });
}

// 初始化
window.onload = () => {
  initFirebase();
  updateWeekSelector();
  loadData();
};
document.getElementById("entryForm").addEventListener("submit", addEntry);
document.getElementById("memberFilter").addEventListener("change", (e) => {
  filters.member = e.target.value;
  console.log(`篩選家庭成員: ${filters.member}`);
  setTimeout(loadData, 100);
});
document.getElementById("paymentFilter").addEventListener("change", (e) => {
  filters.payment = e.target.value;
  console.log(`篩選支付方式: ${filters.payment}`);
  setTimeout(loadData, 100);
});
