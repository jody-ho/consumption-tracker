// Firebase 初始化
const firebaseConfig = {
  apiKey: "AIzaSyCJY3vzA7xuC-bC6PLGk5wGAe_rjPMP4w4",
  authDomain: "testing-a7aba.firebaseapp.com",
  projectId: "testing-a7aba",
  storageBucket: "testing-a7aba.firebasestorage.app",
  messagingSenderId: "94291975544",
  appId: "1:94291975544:web:1fc1e0aff39d8fd0357c8d",
  databaseURL: "https://testing-a7aba-default-rtdb.firebaseio.com/"
};
firebase.initializeApp(firebaseConfig);
const db = firebase.database();

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const BASE_DATE = new Date("2025-01-01");

function getCurrentWeek() {
  const now = new Date();
  return Math.floor((now - BASE_DATE) / WEEK_MS) + 1;
}

function getWeekOptions(currentWeek) {
  return Array.from({ length: currentWeek }, (_, i) => i + 1);
}

function openModal() {
  document.getElementById("entryModal").classList.remove("hidden");
}

function closeModal() {
  document.getElementById("entryModal").classList.add("hidden");
}

function exportToExcel() {
  db.ref("coupons/" + selectedWeek).once("value", (snapshot) => {
    const entries = snapshot.val();
    if (!entries) return alert("沒有資料可匯出");

    const rows = Object.entries(entries).map(([id, e]) => ({
      家庭成員: e.member,
      支付方式: e.method,
      金額: e.amount,
      狀態: e.used ? "已使用" : "未使用"
    }));

    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "優惠券");
    XLSX.writeFile(wb, `優惠券_第${selectedWeek}週.xlsx`);
  });
}

let selectedWeek = getCurrentWeek();

function updateWeekSelector() {
  const selector = document.getElementById("weekSelector");
  selector.innerHTML = "";
  getWeekOptions(selectedWeek).reverse().forEach(w => {
    const opt = document.createElement("option");
    opt.value = w;
    opt.textContent = `第 ${w} 週`;
    selector.appendChild(opt);
  });
  selector.value = selectedWeek;
  selector.onchange = () => {
    selectedWeek = parseInt(selector.value);
    loadData();
  };
}

function loadData() {
  db.ref("coupons/" + selectedWeek).on("value", (snapshot) => {
    const data = snapshot.val() || {};
    renderTable(data);
    renderSummary(data);
  });
}

function renderTable(data) {
  const tableContainer = document.getElementById("tableContainer");
  let html = `<table><thead><tr><th>家庭成員</th><th>支付方式</th><th>金額</th><th>狀態</th><th>操作</th></tr></thead><tbody>`;
  for (const [id, entry] of Object.entries(data)) {
    html += `<tr class="member-${entry.member}">
      <td>${entry.member}</td>
      <td>${entry.method}</td>
      <td>${entry.amount}</td>
      <td>${entry.used ? "✅" : "❌"}</td>
      <td>
        <button class="action-btn" onclick="markUsed('${id}', ${!entry.used})">📝</button>
        <button class="action-btn" onclick="removeEntry('${id}')">🗑️</button>
      </td>
    </tr>`;
  }
  html += `</tbody></table>`;
  tableContainer.innerHTML = html;
}

function renderSummary(data) {
  const summary = {};
  let total = 0;

  for (const entry of Object.values(data)) {
    if (!entry.used) continue;
    const { member, method, amount } = entry;
    if (!summary[member]) summary[member] = { total: 0, methods: {} };
    if (!summary[member].methods[method]) summary[member].methods[method] = 0;
    summary[member].methods[method] += amount;
    summary[member].total += amount;
    total += amount;
  }

  let html = `<table><thead><tr><th>家庭成員</th><th>支付方式</th><th>金額</th><th>合計</th></tr></thead><tbody>`;
  for (const [member, { total: sum, methods }] of Object.entries(summary)) {
    const rows = Object.entries(methods).map(([method, amt]) =>
      `<tr><td>${member}</td><td>${method}</td><td>${amt}</td><td rowspan="${Object.keys(methods).length}">${sum}</td></tr>`
    );
    html += rows.join("");
  }
  html += `</tbody></table><p><strong>全家本週可消費金額：${total} 元</strong></p>`;
  document.getElementById("summaryTableContainer").innerHTML = html;
}

function addEntry(e) {
  e.preventDefault();
  const member = document.getElementById("member").value;
  const method = document.getElementById("method").value;
  const amount = parseInt(document.getElementById("amount").value);
  const count = parseInt(document.getElementById("count").value);

  for (let i = 0; i < count; i++) {
    const ref = db.ref("coupons/" + selectedWeek).push();
    ref.set({ member, method, amount, used: false });
  }
  document.getElementById("entryForm").reset();
  closeModal();
}

function markUsed(id, status) {
  db.ref(`coupons/${selectedWeek}/${id}`).update({ used: status });
}

function removeEntry(id) {
  db.ref(`coupons/${selectedWeek}/${id}`).remove();
}

// 初始化
updateWeekSelector();
loadData();
document.getElementById("entryForm").addEventListener("submit", addEntry);
