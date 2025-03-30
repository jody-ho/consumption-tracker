// Replace with your Firebase config
const firebaseConfig = {
  apiKey: "AIzaSyCJY3vzA7xuC-bC6PLGk5wGAe_rjPMP4w4",
  authDomain: "testing-a7aba.firebaseapp.com",
  projectId: "testing-a7aba",
  storageBucket: "testing-a7aba.firebasestorage.app",
  messagingSenderId: "94291975544",
  appId: "1:94291975544:web:1fc1e0aff39d8fd0357c8d"
};
// Initialize Firebase
firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();

// Load last used family role from localStorage
const familyRoles = ["Dad", "Mom", "Son", "Daughter", "Grandpa", "Grandma"];
document.getElementById('family-role').value = localStorage.getItem('lastFamilyRole') || "Dad";

// Event listener for family role change
document.getElementById('family-role').addEventListener('change', (e) => {
  localStorage.setItem('lastFamilyRole', e.target.value);
});

// Initialize variables
let currentDraws = {};

// Function to load data from Firestore
function loadWeekData() {
  const selectedWeek = document.getElementById('week-select').value;
  db.doc(`weeks/${selectedWeek}`).onSnapshot(doc => {
    if (doc.exists) {
      currentDraws = doc.data().draws || {};
    } else {
      currentDraws = {};
    }
    updateTable();
    calculateTotals();
  });
}

// Function to add a new draw
document.getElementById('add-draw').addEventListener('click', () => {
  const familyRole = document.getElementById('family-role').value;
  const paymentMethod = document.getElementById('payment-method').value;
  const drawValue = parseInt(document.getElementById('draw-value').value);

  if (!currentDraws[paymentMethod]) {
    currentDraws[paymentMethod] = [];
  }

  // Ensure we have 3 draws, fill with {value: 0, used: false} if less
  while (currentDraws[paymentMethod].length < 3) {
    currentDraws[paymentMethod].push({ value: 0, used: false, familyRole: "" });
  }

  // Find the first null or 0 value to replace
  let replaced = false;
  for (let i = 0; i < 3; i++) {
    if (currentDraws[paymentMethod][i].value === 0 || currentDraws[paymentMethod][i].value === null) {
      currentDraws[paymentMethod][i] = { value: drawValue, used: false, familyRole: familyRole };
      replaced = true;
      break;
    }
  }

  if (!replaced) {
    alert("每個支付方式最多3次抽獎，已滿！");
    return;
  }

  saveData();
});

// Function to update the table display
function updateTable() {
  const tbody = document.querySelector('#draws-table tbody');
  tbody.innerHTML = '';
  for (const [method, draws] of Object.entries(currentDraws)) {
    draws.forEach((draw, index) => {
      if (draw.value > 0) { // Only show draws with value > 0
        const row = document.createElement('tr');
        row.innerHTML = `
          <td>${draw.familyRole}</td>
          <td>${getMethodName(method)}</td>
          <td>抽獎 ${index + 1}</td>
          <td>${draw.value} 元</td>
          <td>
            <input type="checkbox" class="used-checkbox" data-method="${method}" data-index="${index}" ${draw.used ? 'checked' : ''}>
          </td>
          <td>已使用</td>
        `;
        tbody.appendChild(row);
      }
    });
  }

  // Add event listeners for used checkboxes
  document.querySelectorAll('.used-checkbox').forEach(checkbox => {
    checkbox.addEventListener('change', (e) => {
      const method = e.target.dataset.method;
      const index = parseInt(e.target.dataset.index);
      currentDraws[method][index].used = e.target.checked;
      saveData();
    });
  });
}

// Function to get payment method name
function getMethodName(key) {
  const method = paymentMethods.find(m => m.key === key);
  return method ? method.name : key;
}

// Function to calculate totals
function calculateTotals() {
  let totalRequired = 0;
  const roleTotals = {};

  for (const [method, draws] of Object.entries(currentDraws)) {
    draws.forEach(draw => {
      if (draw.value > 0 && !draw.used) {
        const required = draw.value * 3;
        totalRequired += required;
        if (draw.familyRole) {
          roleTotals[draw.familyRole] = (roleTotals[draw.familyRole] || 0) + required;
        }
      }
    });
  }

  document.getElementById('total-required').textContent = totalRequired;
  const roleTotalsDiv = document.getElementById('role-totals');
  roleTotalsDiv.innerHTML = '<h5>小計：</h5>';
  for (const [role, amount] of Object.entries(roleTotals)) {
    roleTotalsDiv.innerHTML += `<p>${role}: ${amount} 元</p>`;
  }
}

// Function to save data to Firestore
function saveData() {
  const selectedWeek = document.getElementById('week-select').value;
  db.doc(`weeks/${selectedWeek}`).set({ draws: currentDraws })
    .then(() => {
      alert('數據保存成功');
    })
    .catch(error => {
      alert('保存數據時出錯：' + error.message);
    });
}

// Event listeners
document.getElementById('week-select').addEventListener('change', loadWeekData);
document.getElementById('save-btn').addEventListener('click', saveData);

// Initial load
loadWeekData();
