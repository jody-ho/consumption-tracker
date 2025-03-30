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

// Define payment methods
const paymentMethods = [
  { key: 'boc', name: '中銀' },
  { key: 'icbc', name: '工商' },
  { key: 'bocom', name: '國際' },
  { key: 'tfb', name: '大豐' },
  { key: 'mpay', name: 'MPay' },
  { key: 'uepay', name: 'UEPay' }
];

// Password for login
const correctPassword = '960417'; // Replace with your password

// Login function
function checkPassword() {
  const input = document.getElementById('password').value;
  if (input === correctPassword) {
    document.getElementById('login').style.display = 'none';
    document.getElementById('main').style.display = 'block';
    loadWeekData();
  } else {
    document.getElementById('error').style.display = 'block';
  }
}

// Load week data
let unsubscribe = null;
function loadWeekData() {
  if (unsubscribe) {
    unsubscribe();
  }
  const selectedWeek = document.getElementById('week-select').value;
  unsubscribe = db.collection('weeks').doc(selectedWeek).onSnapshot(doc => {
    if (doc.exists) {
      const data = doc.data();
      document.querySelectorAll('.draw').forEach(select => {
        const method = select.dataset.method;
        const draw = select.dataset.draw;
        select.value = data.payments[method]['draw' + draw] || 0;
      });
    } else {
      document.querySelectorAll('.draw').forEach(select => {
        select.value = 0;
      });
    }
    calculateTotals();
  });
}

// Calculate totals
function calculateTotals() {
  let weeklyTotal = 0;
  paymentMethods.forEach(method => {
    const draws = [1,2,3].map(draw => parseInt(document.querySelector(`.draw[data-method="${method.key}"][data-draw="${draw}"]`).value) || 0);
    const total = draws.reduce((sum, val) => sum + val, 0);
    const required = total * 3;
    document.querySelector(`.total[data-method="${method.key}"]`).textContent = total;
    document.querySelector(`.required[data-method="${method.key}"]`).textContent = required;
    weeklyTotal += required;
  });
  document.getElementById('weekly-total').textContent = weeklyTotal;
}

// Save data
function saveData() {
  const selectedWeek = document.getElementById('week-select').value;
  const data = { payments: {} };
  paymentMethods.forEach(method => {
    data.payments[method.key] = {
      draw1: parseInt(document.querySelector(`.draw[data-method="${method.key}"][data-draw="1"]`).value) || 0,
      draw2: parseInt(document.querySelector(`.draw[data-method="${method.key}"][data-draw="2"]`).value) || 0,
      draw3: parseInt(document.querySelector(`.draw[data-method="${method.key}"][data-draw="3"]`).value) || 0
    };
  });
  db.collection('weeks').doc(selectedWeek).set(data)
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
document.querySelectorAll('.draw').forEach(select => {
  select.addEventListener('change', calculateTotals);
});
