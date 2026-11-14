// UI and storage. All rules and maths live in core.js.
(() => {
  'use strict';
  const { MEMBERS, WALLETS, FACES } = Core;

  const FIREBASE = {
    apiKey: 'AIzaSyCJY3vzA7xuC-bC6PLGk5wGAe_rjPMP4w4',
    authDomain: 'testing-a7aba.firebaseapp.com',
    databaseURL: 'https://testing-a7aba-default-rtdb.firebaseio.com/',
    projectId: 'testing-a7aba',
    appId: '1:94291975544:web:1fc1e0aff39d8fd0357c8d'
  };
  // Database layout (unchanged from earlier versions):
  //   campaigns/2026R2/weeks/<week key>/coupons/<id> = { member, payment, type, amount, used, usedAt, createdAt, redemption }
  //   campaigns/2026R2/settings/wallets/<member>/<wallet> = true | false
  const ROOT = 'campaigns/2026R2';
  const DEFAULT_WALLETS = {
    爸爸: ['MPay'],
    媽媽: ['MPay', '中銀', '工銀', '大豐', '國際'],
    姐姐: ['MPay', '中銀', '工銀', '大豐', '支付寶', 'UEPay'],
    昌哥: ['MPay', '中銀', '工銀', '支付寶', 'UEPay'],
    妹妹: ['MPay', '中銀', '工銀', '國際', '支付寶', 'UEPay']
  };
  const CACHE = 'coupons-v5';

  const $ = id => document.getElementById(id);
  const esc = value => String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
  const num = value => new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value);
  const mop = value => `MOP ${num(value)}`;
  const sum = (list, pick) => list.reduce((total, item) => total + pick(item), 0);

  const state = {
    week: Core.week(Core.macauDate()), // null outside the campaign
    coupons: {}, // this week's records, id → row
    wallets: defaultWallets(), // member → wallet → enabled
    online: false,
    price: null, // the purchase being planned, or null
    merchantOk: false // the shop being planned for accepts merchant coupons
  };
  let db = null;
  let couponsRef = null;
  let sheetAction = null;
  let toastTimer = null;

  // ---------- data ----------

  function defaultWallets() {
    return Object.fromEntries(MEMBERS.map(member => [member, Object.fromEntries(WALLETS.map(wallet => [wallet, DEFAULT_WALLETS[member].includes(wallet)]))]));
  }

  function cleanWallets(value) {
    const safe = defaultWallets();
    for (const member of MEMBERS) for (const wallet of WALLETS) {
      if (typeof value?.[member]?.[wallet] === 'boolean') safe[member][wallet] = value[member][wallet];
    }
    return safe;
  }

  function cleanCoupons(value) {
    const safe = {};
    for (const [id, row] of Object.entries(value || {})) {
      if (!row || !MEMBERS.includes(row.member) || !WALLETS.includes(row.payment)) continue;
      const gov = row.type === 'gov' && FACES.includes(Number(row.amount));
      const type = gov ? 'gov' : ['merchant', 'gift'].includes(row.type) ? row.type : 'zero';
      safe[id] = { ...row, type, amount: gov ? Number(row.amount) : 0, used: row.used === true };
    }
    return safe;
  }

  const activeWallets = member => WALLETS.filter(wallet => state.wallets[member][wallet]);
  const draws = (member, payment) => Object.entries(state.coupons)
    .filter(([, c]) => c.member === member && c.payment === payment)
    .sort(([a, x], [b, y]) => (x.createdAt || 0) - (y.createdAt || 0) || a.localeCompare(b))
    .map(([id, c]) => ({ id, ...c }));

  function saveCache() {
    try { localStorage.setItem(CACHE, JSON.stringify({ week: state.week?.key, coupons: state.coupons, wallets: state.wallets })); } catch { /* storage full or blocked */ }
  }

  function loadCache() {
    try {
      const cached = JSON.parse(localStorage.getItem(CACHE) || '{}');
      state.wallets = cleanWallets(cached.wallets);
      if (state.week && cached.week === state.week.key) state.coupons = cleanCoupons(cached.coupons);
    } catch { /* ignore a broken cache */ }
  }

  function connect() {
    if (typeof firebase === 'undefined') return;
    if (!firebase.apps.length) firebase.initializeApp(FIREBASE);
    db = firebase.database();
    db.ref('.info/connected').on('value', snapshot => { state.online = snapshot.val() === true; render(); });
    db.ref(`${ROOT}/settings/wallets`).on('value', snapshot => { state.wallets = cleanWallets(snapshot.val()); saveCache(); render(); });
    listen();
  }

  function listen() {
    if (couponsRef) couponsRef.off();
    couponsRef = null;
    if (!db || !state.week) return;
    couponsRef = db.ref(`${ROOT}/weeks/${state.week.key}/coupons`);
    couponsRef.on('value', snapshot => { state.coupons = cleanCoupons(snapshot.val()); saveCache(); render(); });
  }

  // A new day can end the week (Friday) or change how soon the vouchers expire.
  function checkDate() {
    const next = Core.week(Core.macauDate());
    if (next?.key === state.week?.key && next?.daysLeft === state.week?.daysLeft) return;
    const changed = next?.key !== state.week?.key;
    state.week = next;
    if (changed) { state.coupons = {}; state.price = null; $('price').value = ''; listen(); }
    render();
  }

  // `updates` are paths under this week, e.g. { 'coupons/<id>/used': true }.
  function write(updates, message, undo) {
    if (!db || !state.week) { toast('未能連線，請稍後再試'); return; }
    if (!state.online) toast('離線中，連線後會自動儲存');
    db.ref(`${ROOT}/weeks/${state.week.key}`).update(updates).then(
      () => toast(message, undo),
      () => toast('儲存失敗，請再試一次')
    );
  }

  function markUsed(payments) {
    const now = Date.now();
    const updates = {};
    payments.forEach((payment, index) => {
      const redemption = {
        date: Core.macauDate(), transactionId: `${now}-${index}`, amountKind: 'actual', amountSource: 'coupon-face-value',
        actualSpendCents: Math.round(payment.spend * 100), actualPaidCents: Math.round(payment.pay * 100)
      };
      for (const id of payment.ids) {
        updates[`coupons/${id}/used`] = true;
        updates[`coupons/${id}/usedAt`] = now;
        updates[`coupons/${id}/redemption`] = redemption;
      }
    });
    const ids = payments.flatMap(payment => payment.ids);
    write(updates, `已記為已用：券 ${mop(sum(payments, p => p.off))}`, () => markUnused(ids));
  }

  function markUnused(ids) {
    const updates = {};
    for (const id of ids) {
      updates[`coupons/${id}/used`] = false;
      updates[`coupons/${id}/usedAt`] = null;
      updates[`coupons/${id}/redemption`] = null;
    }
    write(updates, '已復原');
  }

  function saveDraws(member, payment, values) {
    const now = Date.now();
    const updates = {};
    for (const old of draws(member, payment)) updates[`coupons/${old.id}`] = null;
    values.forEach((value, index) => {
      const gov = FACES.includes(Number(value));
      updates[`coupons/c${now}${index}${Math.random().toString(36).slice(2, 8)}`] = {
        member, payment, type: gov ? 'gov' : value, amount: gov ? Number(value) : value === 'merchant' ? Core.MERCHANT.off : 0, used: false, createdAt: now + index
      };
    });
    write(updates, `已儲存：${member} · ${payment}`);
  }

  // ---------- 用券 ----------

  function renderUse() {
    const week = state.week;
    const list = Core.wallets(state.coupons);
    const total = sum(list, w => w.face);
    const urgent = Boolean(week) && week.daysLeft <= 1 && total > 0;
    $('caption').textContent = !week ? '活動已結束'
      : `本週未用電子券 · ${week.daysLeft === 0 ? '今晚到期' : week.daysLeft === 1 ? '明晚到期' : '週四到期'}`;
    $('caption').classList.toggle('urgent', urgent);
    $('hero').textContent = week ? mop(total) : '';
    $('hero').classList.toggle('urgent', urgent);
    document.querySelector('.price').hidden = !week || (!total && !Core.wallets(state.coupons, { merchant: true }).length);
    $('clearPrice').hidden = !$('price').value;

    const withMerchant = Core.wallets(state.coupons, { merchant: true });
    const hasMerchant = withMerchant.some(w => w.merchantId);
    const price = total || hasMerchant ? state.price : null;
    $('merchantBox').hidden = !price || !hasMerchant;
    const result = price ? Core.plan(state.merchantOk ? withMerchant : list, price) : null;
    $('verdict').hidden = !result;
    $('markPlan').hidden = !result?.payments.length;
    const head = '<div class="cols" aria-hidden="true"><span></span><span>給商家</span><span>自付</span></div>';
    const cells = (spend, pay) => `<span>${num(spend)}</span><span>${num(pay)}</span>`;

    if (result) {
      $('verdict').innerHTML = !result.off ? `未滿 ${mop(result.least)}，用不到券`
        : !result.left ? `券減 ${mop(result.off)}，電子券全部用完`
          : `券減 ${mop(result.off)}，電子券還剩 ${mop(result.left)}<small>買滿 ${mop(result.full)} 才全部用完</small>`;
      $('verdict').classList.toggle('good', Boolean(result.off) && !result.left);
      $('useList').innerHTML = !result.payments.length ? '' : head
        + result.payments.map(p => `<div class="row"><span>${esc(p.member)} · ${esc(p.payment)}<small>${[p.face ? `券 ${num(p.face)}` : '', p.merchant ? `商戶券 ${Core.MERCHANT.off}` : ''].filter(Boolean).join(' + ')}</small></span>${cells(p.spend, p.pay)}</div>`).join('')
        + `<div class="row total"><span>合計</span>${cells(price, result.pay)}</div>`;
    } else if (!total) {
      const nothingYet = week && !Object.keys(state.coupons).length;
      $('useList').innerHTML = nothingYet ? '<a class="primary" href="#register">登記抽獎結果</a>' : '';
    } else {
      $('useList').innerHTML = head
        + `<div class="row total"><span>全家</span>${cells(total * 3, total * 2)}</div>`
        + MEMBERS.map(member => {
          const mine = list.filter(w => w.member === member);
          if (!mine.length) return '';
          return `<div class="row member"><span>${esc(member)}</span>${mine.length > 1 ? cells(sum(mine, w => w.spend), sum(mine, w => w.pay)) : ''}</div>`
            + mine.map(w => `<button class="row" type="button" data-use="${esc(w.member)}|${esc(w.payment)}" aria-label="${esc(w.member)} ${esc(w.payment)}：給商家 ${mop(w.spend)}，自付 ${mop(w.pay)}"><span>${esc(w.payment)}<small>券 ${w.coupons.map(c => c.face).join(' + ')}</small></span>${cells(w.spend, w.pay)}</button>`).join('');
        }).join('');
    }

    const used = usedGroups();
    $('usedBox').hidden = !used.length;
    $('usedSummary').textContent = `已用電子券 ${mop(sum(used, g => g.face))}`;
    $('usedList').innerHTML = used.map(g => `<div class="row two"><span>${esc(g.member)} · ${esc(g.payment)}<small>${[g.face ? `券 ${num(g.face)}` : '', g.merchant ? '商戶券' : ''].filter(Boolean).join(' + ')}</small></span><button class="link" type="button" data-undo="${esc(g.ids.join(','))}">復原</button></div>`).join('');
  }

  // Used e-vouchers, one entry per payment.
  function usedGroups() {
    const groups = new Map();
    for (const [id, c] of Object.entries(state.coupons)) {
      if (!c.used || !['gov', 'merchant'].includes(c.type)) continue;
      const key = `${c.member}|${c.payment}|${c.redemption?.transactionId || c.usedAt || id}`;
      const group = groups.get(key) || { member: c.member, payment: c.payment, face: 0, merchant: false, ids: [] };
      if (c.type === 'gov') group.face += c.amount; else group.merchant = true;
      group.ids.push(id);
      groups.set(key, group);
    }
    return [...groups.values()];
  }

  function openUseSheet(member, payment) {
    const wallet = Core.wallets(state.coupons).find(w => w.member === member && w.payment === payment);
    if (!wallet) return;
    openSheet({
      title: `${member} · ${payment}`,
      body: `<dl class="readout"><div><dt>給商家</dt><dd>${mop(wallet.spend)}</dd></div><div><dt>券減</dt><dd>${mop(wallet.face)}</dd></div><div class="big"><dt>自付</dt><dd>${mop(wallet.pay)}</dd></div></dl>`,
      ok: '已付款，記為已用',
      action: () => markUsed([{ ...wallet, off: wallet.face, ids: wallet.coupons.map(c => c.id) }])
    });
  }

  // ---------- 登記 ----------

  function renderRegister() {
    const all = MEMBERS.flatMap(member => activeWallets(member).map(payment => ({ member, payment, draws: draws(member, payment) })));
    const pending = all.filter(w => !w.draws.length).length;
    $('regCaption').textContent = state.week ? `已登記 ${all.length - pending} / ${all.length}` : '活動已結束';
    // Draws happen Friday to Sunday, so the reminder badge only shows on those days.
    const drawing = Boolean(state.week) && state.week.daysLeft >= 4;
    $('badge').hidden = !drawing || !pending;
    $('badge').textContent = pending;
    $('regList').innerHTML = !state.week ? '' : MEMBERS.map(member => {
      const mine = all.filter(w => w.member === member);
      if (!mine.length) return '';
      return `<div class="row member two"><span>${esc(member)}</span></div>` + mine.map(w => {
        const text = w.draws.map(c => ({ gov: c.amount, merchant: '商戶', gift: '禮遇' })[c.type] || '—').join(' · ');
        return `<button class="row two" type="button" data-reg="${esc(member)}|${esc(w.payment)}"><span>${esc(w.payment)}</span>${w.draws.length ? `<span>${text}</span>` : '<span class="todo">未登記</span>'}</button>`;
      }).join('');
    }).join('');
    $('walletSettings').innerHTML = MEMBERS.map(member => `<fieldset class="chips"><legend>${esc(member)}</legend>${WALLETS.map(wallet =>
      `<label><input type="checkbox" data-wallet="${esc(member)}|${esc(wallet)}"${state.wallets[member][wallet] ? ' checked' : ''}><span>${esc(wallet)}</span></label>`).join('')}</fieldset>`).join('');
  }

  function openRegisterSheet(member, payment) {
    const existing = draws(member, payment);
    const locked = existing.some(c => c.used);
    const current = index => (!existing[index] ? '' : existing[index].type === 'gov' ? String(existing[index].amount) : existing[index].type);
    const options = [...FACES.map(face => [String(face), face]), ['merchant', '商戶券'], ['gift', '禮遇券'], ['zero', '沒有']];
    openSheet({
      title: `${member} · ${payment}`,
      body: [0, 1, 2].map(index => `<fieldset class="chips"${locked ? ' disabled' : ''}><legend>第 ${index + 1} 次</legend>${options.map(([value, label]) =>
        `<label><input type="radio" name="draw${index}" value="${value}"${current(index) === value ? ' checked' : ''} required><span>${label}</span></label>`).join('')}</fieldset>`).join('')
        + (locked ? '<p class="note">已用過券。要改請先在「用券」頁復原。</p>' : ''),
      ok: locked ? '' : '儲存',
      action: form => saveDraws(member, payment, [0, 1, 2].map(index => form.elements[`draw${index}`].value))
    });
  }

  // ---------- sheet, toast, navigation ----------

  function openSheet({ title, body, ok, action }) {
    $('sheetTitle').textContent = title;
    $('sheetBody').innerHTML = body;
    $('sheetOk').textContent = ok;
    $('sheetOk').hidden = !ok;
    $('sheetCancel').textContent = ok ? '取消' : '關閉';
    sheetAction = action;
    updateSheetOk();
    $('sheet').showModal();
    history.pushState({ sheet: true }, ''); // so the phone's back button closes the sheet
  }

  function updateSheetOk() {
    $('sheetOk').disabled = !$('sheetForm').checkValidity();
  }

  function toast(message, undo) {
    clearTimeout(toastTimer);
    $('toast').innerHTML = `<span>${esc(message)}</span>${undo ? '<button type="button" class="link">復原</button>' : ''}`;
    $('toast').hidden = false;
    $('toast').querySelector('button')?.addEventListener('click', () => { $('toast').hidden = true; undo(); });
    toastTimer = setTimeout(() => { $('toast').hidden = true; }, undo ? 8000 : 3500);
  }

  function render() {
    const tab = location.hash === '#register' ? 'register' : 'use';
    $('use').hidden = tab !== 'use';
    $('register').hidden = tab !== 'register';
    for (const link of document.querySelectorAll('.tabs a')) {
      if (link.dataset.tab === tab) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
    renderUse();
    renderRegister();
  }

  $('price').addEventListener('input', () => {
    const value = Number($('price').value.replace(/[^\d.]/g, ''));
    state.price = value > 0 ? Math.round(value * 100) / 100 : null;
    renderUse();
  });
  $('merchantOk').addEventListener('change', () => { state.merchantOk = $('merchantOk').checked; renderUse(); });
  $('clearPrice').addEventListener('click', () => {
    $('price').value = '';
    state.price = null;
    renderUse();
    $('price').focus();
  });
  $('markPlan').addEventListener('click', () => {
    const result = Core.plan(Core.wallets(state.coupons, { merchant: state.merchantOk }), state.price);
    $('price').value = '';
    state.price = null;
    markUsed(result.payments);
  });
  $('useList').addEventListener('click', event => {
    const row = event.target.closest('[data-use]');
    if (row) openUseSheet(...row.dataset.use.split('|'));
  });
  $('usedList').addEventListener('click', event => {
    const button = event.target.closest('[data-undo]');
    if (button) markUnused(button.dataset.undo.split(','));
  });
  $('regList').addEventListener('click', event => {
    const row = event.target.closest('[data-reg]');
    if (row) openRegisterSheet(...row.dataset.reg.split('|'));
  });
  $('walletSettings').addEventListener('change', event => {
    const [member, wallet] = event.target.dataset.wallet.split('|');
    state.wallets[member][wallet] = event.target.checked;
    render();
    if (!db) { toast('未能連線，請稍後再試'); return; }
    db.ref(`${ROOT}/settings/wallets/${member}/${wallet}`).set(event.target.checked).catch(() => toast('儲存失敗，請再試一次'));
  });

  $('sheetForm').addEventListener('change', updateSheetOk);
  $('sheetForm').addEventListener('submit', event => {
    event.preventDefault();
    const action = sheetAction;
    $('sheet').close();
    if (action) action($('sheetForm'));
  });
  $('sheetCancel').addEventListener('click', () => $('sheet').close());
  $('sheet').addEventListener('click', event => { if (event.target === $('sheet')) $('sheet').close(); });
  $('sheet').addEventListener('close', () => {
    sheetAction = null;
    if (history.state?.sheet) history.back();
  });
  window.addEventListener('popstate', () => {
    if ($('sheet').open) $('sheet').close();
    render();
  });
  window.addEventListener('hashchange', () => { window.scrollTo(0, 0); render(); });
  document.addEventListener('visibilitychange', checkDate);
  setInterval(checkDate, 60000);

  if (history.state?.sheet) history.replaceState(null, ''); // reloaded while a sheet was open
  loadCache();
  render();
  connect();
})();
