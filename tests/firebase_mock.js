// Isolated browser fixture. No request is made to a live Firebase project.
(() => {
  const week = 'campaigns/2026R2/weeks/2026R2-W1';
  const root = { campaigns: { '2026R2': { weeks: { '2026R2-W1': { coupons: {
    dadGov: { member: '爸爸', payment: 'MPay', type: 'gov', amount: 20, used: false },
    dadMerchant: { member: '爸爸', payment: 'MPay', type: 'merchant', amount: 12, used: false },
    dadGift: { member: '爸爸', payment: 'MPay', type: 'gift', label: '消費禮遇券', used: false },
    momGov10: { member: '媽媽', payment: '中銀', type: 'gov', amount: 10, used: true, redemption: { transactionId: 'mom-one', date: '2026-10-10', actualSpendCents: 10000, actualPaidCents: 7000 } },
    momGov20: { member: '媽媽', payment: '中銀', type: 'gov', amount: 20, used: true, redemption: { transactionId: 'mom-one', date: '2026-10-10', actualSpendCents: 10000, actualPaidCents: 7000 } },
    momZero: { member: '媽媽', payment: '中銀', type: 'zero', amount: 0, used: false },
    sisGift: { member: '姐姐', payment: 'MPay', type: 'gift', label: '消費禮遇券', used: true, redemption: { transactionId: 'missing', date: '2026-10-10' } },
    broZero: { member: '昌哥', payment: 'MPay', type: 'zero', amount: 0, used: false },
    littleZero: { member: '妹妹', payment: 'MPay', type: 'zero', amount: 0, used: false }
  } } } } } };
  const listeners = [];
  const parts = path => String(path || '').split('/').filter(Boolean);
  const read = path => parts(path).reduce((node, part) => node?.[part], root);
  const write = (path, value) => {
    const keys = parts(path);
    const parent = keys.slice(0, -1).reduce((node, part) => node[part] ||= {}, root);
    if (value === null) delete parent[keys.at(-1)];
    else parent[keys.at(-1)] = value;
  };
  const snapshot = path => ({ val: () => read(path), exists: () => read(path) !== undefined });
  const publish = () => listeners.forEach(({ path, callback }) => callback(snapshot(path)));
  const database = { ref(path = '') { return {
    on(event, callback, error) { if (event === 'value') { listeners.push({ path, callback, error }); callback(snapshot(path)); } },
    off() { for (let i = listeners.length - 1; i >= 0; i--) if (listeners[i].path === path) listeners.splice(i, 1); },
    once() { return Promise.resolve(snapshot(path)); },
    update(changes) { if (window.__fake.failNext) { window.__fake.failNext = false; return Promise.reject(Error('simulated write failure')); } Object.entries(changes).forEach(([key, value]) => write(`${path}/${key}`, value)); window.__fake.writes.push({ path, changes }); publish(); return Promise.resolve(); },
    set(value) { if (window.__fake.failNext) { window.__fake.failNext = false; return Promise.reject(Error('simulated write failure')); } write(path, value); window.__fake.writes.push({ path, value }); publish(); return Promise.resolve(); }
  }; } };
  window.__fake = { root, writes: [], week, failNext: false, goOffline() { listeners.forEach(listener => listener.error?.(Error('simulated offline'))); } };
  window.firebase = { apps: [], initializeApp() { this.apps.push({}); }, database() { return database; } };
})();
