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
    weeks: {}, // every week's records, week key → id → row
    coupons: {}, // this week's records, id → row
    wallets: defaultWallets(), // member → wallet → enabled
    online: false,
    price: null, // the purchase being planned, or null
    merchantOk: false, // the shop being planned for accepts merchant coupons
    skip: new Set() // family members whose coupons are hidden and left out of the plan; remembered on this phone
  };
  let db = null;
  let sheetAction = null;
  let sheetChange = null; // called when something in the open sheet is ticked or unticked
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
  // A week's stored map as a list, oldest draw first, each row carrying its id.
  const records = coupons => Object.entries(coupons || {})
    .sort(([a, x], [b, y]) => (x.createdAt || 0) - (y.createdAt || 0) || a.localeCompare(b))
    .map(([id, c]) => ({ id, ...c }));
  const draws = (member, payment) => records(state.coupons).filter(c => c.member === member && c.payment === payment);

  // Every list is the same table: a label, then two numbers.
  const head = (first, second) => `<div class="cols" aria-hidden="true"><span></span><span>${first}</span><span>${second}</span></div>`;
  const cells = (first, second) => `<span>${num(first)}</span><span>${num(second)}</span>`;
  const readout = lines => `<dl class="readout">${lines.map(([label, value, big]) => `<div${big ? ' class="big"' : ''}><dt>${label}</dt><dd>${value}</dd></div>`).join('')}</dl>`;
  // One card per family member (`data-m` picks the member's colour): the name, the member's rows, and a subtotal line when there are several rows.
  const byMember = (items, row, subtotal) => MEMBERS.map(member => {
    const mine = items.filter(item => item.member === member);
    if (!mine.length) return '';
    return `<section class="person" data-m="${MEMBERS.indexOf(member)}"><h3>${esc(member)}</h3>${mine.map(row).join('')}${subtotal && mine.length > 1 ? `<div class="row sub"><span>小計</span>${subtotal(mine)}</div>` : ''}</section>`;
  }).join('');
  // Coupons as tags, so they never look like the amounts beside them. Each is [text, extra class].
  const tags = list => `<span class="tags">${list.map(([text, kind = '']) => `<b class="${kind}">${text}</b>`).join('')}</span>`;
  const faceTags = (faces, merchant) => tags([...faces.map(face => [face]), ...(merchant ? [['商戶', 'other']] : [])]);
  const drawTags = list => tags(list.map(c => [({ gov: c.amount, merchant: '商戶', gift: '禮遇' })[c.type] || '—',
    `${c.type === 'gov' ? '' : c.type === 'zero' ? 'none' : 'other'}${c.used ? ' used' : ''}`]));

  function saveCache() {
    try { localStorage.setItem(CACHE, JSON.stringify({ weeks: state.weeks, wallets: state.wallets, skip: [...state.skip] })); } catch { /* storage full or blocked */ }
  }

  // `byWeek` is week key → stored coupon map.
  function setWeeks(byWeek) {
    state.weeks = Object.fromEntries(Object.entries(byWeek || {}).map(([key, coupons]) => [key, cleanCoupons(coupons)]));
    state.coupons = (state.week && state.weeks[state.week.key]) || {};
  }

  function loadCache() {
    try {
      const cached = JSON.parse(localStorage.getItem(CACHE) || '{}');
      state.wallets = cleanWallets(cached.wallets);
      setWeeks(cached.weeks);
      state.skip = new Set((cached.skip || []).filter(member => MEMBERS.includes(member)));
    } catch { /* ignore a broken cache */ }
  }

  function connect() {
    if (typeof firebase === 'undefined') return;
    if (!firebase.apps.length) firebase.initializeApp(FIREBASE);
    db = firebase.database();
    db.ref('.info/connected').on('value', snapshot => { state.online = snapshot.val() === true; render(); });
    db.ref(`${ROOT}/settings/wallets`).on('value', snapshot => { state.wallets = cleanWallets(snapshot.val()); saveCache(); render(); });
    db.ref(`${ROOT}/weeks`).on('value', snapshot => {
      setWeeks(Object.fromEntries(Object.entries(snapshot.val() || {}).map(([key, week]) => [key, week?.coupons])));
      saveCache();
      render();
    });
  }

  // A new day can end the week (Friday) or change how soon the vouchers expire.
  function checkDate() {
    const next = Core.week(Core.macauDate());
    if (next?.key === state.week?.key && next?.daysLeft === state.week?.daysLeft) return;
    const changed = next?.key !== state.week?.key;
    state.week = next;
    if (changed) { state.coupons = (next && state.weeks[next.key]) || {}; state.price = null; $('price').value = ''; }
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
    const owners = MEMBERS.filter(member => (price && state.merchantOk ? withMerchant : list).some(w => w.member === member));
    $('who').hidden = owners.length < 2;
    $('who').innerHTML = owners.map(member =>
      `<label data-m="${MEMBERS.indexOf(member)}"><input type="checkbox" data-member="${esc(member)}"${state.skip.has(member) ? '' : ' checked'}><span>${esc(member)}</span></label>`).join('');
    const result = price ? currentPlan() : null;
    $('verdict').hidden = !result;
    $('markPlan').hidden = !result?.payments.length;
    const columns = head('給商家', '自付');
    const subtotal = mine => cells(sum(mine, item => item.spend), sum(mine, item => item.pay));

    if (result) {
      const left = total - result.face; // of the whole family's e-vouchers
      const hint = result.exact ? '剛剛好' : result.next ? `再買 ${mop(result.next.more)}，多減 ${mop(result.next.gain)}` : '';
      $('verdict').innerHTML = !result.least ? '沒有可用的券'
        : !result.off ? `未滿 ${mop(result.least)}，用不到券`
          : `券減 ${mop(result.off)}，電子券${left ? `還剩 ${mop(left)}` : '全部用完'}${hint ? `<small>${hint}</small>` : ''}`;
      $('verdict').classList.toggle('good', Boolean(result.off) && !left);
      $('useList').innerHTML = !result.payments.length ? '' : columns
        + `<div class="row total"><span>合計</span>${cells(price, result.pay)}</div>`
        + byMember(result.payments, p => `<div class="row"><span>${esc(p.payment)}${faceTags(p.faces, p.merchant)}</span>${cells(p.spend, p.pay)}</div>`, subtotal);
    } else if (!total) {
      const nothingYet = week && !Object.keys(state.coupons).length;
      $('useList').innerHTML = nothingYet ? '<a class="primary" href="#register">登記抽獎結果</a>' : '';
    } else {
      const shown = list.filter(w => !state.skip.has(w.member));
      $('useList').innerHTML = !shown.length ? '' : columns
        + `<div class="row total"><span>${shown.length === list.length ? '全家' : '合計'}</span>${subtotal(shown)}</div>`
        + byMember(shown, w => `<button class="row" type="button" data-use="${esc(w.member)}|${esc(w.payment)}" aria-label="${esc(w.member)} ${esc(w.payment)}：券 ${w.coupons.map(c => c.face).join('、')}，給商家 ${mop(w.spend)}，自付 ${mop(w.pay)}"><span>${esc(w.payment)}${faceTags(w.coupons.map(c => c.face))}</span>${cells(w.spend, w.pay)}</button>`, subtotal);
    }

    // Used this week, one row per payment made: what the shop got and what was paid out of pocket.
    const used = Core.payments(records(state.coupons));
    $('usedBox').hidden = !used.length;
    $('usedSummary').textContent = `已用電子券 ${mop(sum(used, p => p.face))}`;
    $('usedList').innerHTML = columns
      + `<div class="row total"><span>全家</span>${subtotal(used)}</div>`
      + byMember(used, p => `<button class="row" type="button" data-used="${esc(p.ids.join(','))}" aria-label="${esc(p.member)} ${esc(p.payment)}：給商家 ${mop(p.spend)}，自付 ${mop(p.pay)}"><span>${esc(p.payment)}${faceTags(p.faces, p.merchant)}</span>${cells(p.spend, p.pay)}</button>`, subtotal);
  }

  // The best way to pay the price typed in, using only the ticked family members' coupons.
  function currentPlan() {
    const list = Core.wallets(state.coupons, { merchant: state.merchantOk }).filter(w => !state.skip.has(w.member));
    return Core.plan(list, state.price);
  }

  // A payment already made: what was paid, and the way to take it back.
  function openUsedSheet(ids) {
    const payment = Core.payments(records(state.coupons)).find(p => p.ids.join(',') === ids);
    if (!payment) return;
    openSheet({
      title: `${payment.member} · ${payment.payment}`,
      body: readout([['給商家', mop(payment.spend)], ['券減', mop(payment.off)], ['自付', mop(payment.pay), true]]),
      ok: '復原為未用',
      action: () => markUnused(payment.ids)
    });
  }

  // Pay with one wallet. With several coupons, tick the ones used this time; all are ticked to start with.
  function openUseSheet(member, payment) {
    const wallet = Core.wallets(state.coupons).find(w => w.member === member && w.payment === payment);
    if (!wallet) return;
    const boxes = () => [...$('sheetBody').querySelectorAll('input')];
    const picked = () => {
      const coupons = boxes().length ? wallet.coupons.filter((_, index) => boxes()[index].checked) : wallet.coupons;
      const face = sum(coupons, c => c.face);
      return { member, payment, off: face, spend: face * Core.MULTIPLE, pay: face * (Core.MULTIPLE - 1), ids: coupons.map(c => c.id) };
    };
    const figures = p => readout([['給商家', mop(p.spend)], ['券減', mop(p.off)], ['自付', mop(p.pay), true]]);
    openSheet({
      title: `${member} · ${payment}`,
      body: (wallet.coupons.length < 2 ? '' : `<fieldset class="chips" aria-label="這次用哪幾張券">${wallet.coupons.map(c =>
        `<label><input type="checkbox" checked><span>${c.face}</span></label>`).join('')}</fieldset>`)
        + `<div id="figures">${figures({ ...wallet, off: wallet.face })}</div>`,
      ok: '已付款，記為已用',
      change: () => {
        const now = picked();
        boxes()[0].setCustomValidity(now.ids.length ? '' : 'pick one'); // nothing ticked: nothing to save
        $('figures').innerHTML = figures(now);
      },
      action: () => markUsed([picked()])
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
    $('regList').innerHTML = !state.week ? '' : byMember(all, w =>
      `<button class="row two" type="button" data-reg="${esc(w.member)}|${esc(w.payment)}"><span>${esc(w.payment)}</span>${w.draws.length ? drawTags(w.draws) : '<span class="todo">未登記</span>'}</button>`);

    // Every week so far: e-voucher value drawn and used.
    const weeks = Core.weeks(Core.macauDate());
    const tallies = weeks.map(week => Core.tally(records(state.weeks[week.key])));
    const weekRow = (key, label, won, used, total) => `<button class="row${total ? ' total' : ''}" type="button" data-week="${key}" aria-label="${label.replace(/<.*/, '')}：抽中 ${mop(won)}，已用 ${mop(used)}"><span>${label}</span>${cells(won, used)}</button>`;
    $('weeksBox').hidden = !weeks.length;
    $('weekList').innerHTML = head('抽中', '已用')
      + weekRow('all', '全期', sum(tallies, t => t.won), sum(tallies, t => t.used), true)
      + weeks.map((week, index) => weekRow(week.key, `${weekName(week)}<small>${weekDates(week)}</small>`, tallies[index].won, tallies[index].used)).join('');

    $('walletSettings').innerHTML = MEMBERS.map(member => `<fieldset class="chips"><legend>${esc(member)}</legend>${WALLETS.map(wallet =>
      `<label><input type="checkbox" data-wallet="${esc(member)}|${esc(wallet)}"${state.wallets[member][wallet] ? ' checked' : ''}><span>${esc(wallet)}</span></label>`).join('')}</fieldset>`).join('');
  }

  const weekName = week => (week.key === state.week?.key ? '本週' : `第 ${week.number} 週`);
  const weekDates = week => [week.start, week.end].map(day => `${Number(day.slice(5, 7))}/${Number(day.slice(8))}`).join(' – ');

  // One week, or the whole campaign (`key` "all"), read only: totals, who was luckiest, and every wallet's draws.
  function openWeekSheet(key) {
    const weeks = Core.weeks(Core.macauDate());
    const week = weeks.find(w => w.key === key);
    const sets = (week ? [week] : weeks).map(w => records(state.weeks[w.key]));
    const all = sets.flat();
    const total = field => sum(sets, set => Core.tally(set)[field]); // week by week: a payment belongs to one week
    const luck = Core.luck(all);
    const top = entry => `${esc(entry.name)} · ${mop(entry.won)}`;
    const wallets = MEMBERS.flatMap(member => WALLETS.map(payment => ({ member, payment, draws: all.filter(c => c.member === member && c.payment === payment) }))).filter(w => w.draws.length);
    const tally = list => { const t = Core.tally(list); return cells(t.won, t.used); };
    openSheet({
      title: week ? `${weekName(week)} · ${weekDates(week)}` : '全期',
      body: !all.length ? '<p class="note">沒有登記</p>' : readout([
        ['抽中', mop(total('won'))], ['已用', mop(total('used'))], ['給商家', mop(total('spend'))], ['自付', mop(total('pay'))],
        ...(luck.member ? [['手氣王', top(luck.member)]] : []), ...(luck.wallet ? [['最旺錢包', top(luck.wallet)]] : []),
        ...(luck.merchant ? [['商戶券', `${luck.merchant} 張`]] : []), ...(luck.gift ? [['禮遇券', `${luck.gift} 張`]] : [])
      ]) + head('抽中', '已用')
        + byMember(wallets, w => `<div class="row"><span>${esc(w.payment)}${week ? drawTags(w.draws) : ''}</span>${tally(w.draws)}</div>`, mine => tally(mine.flatMap(w => w.draws))),
      ok: ''
    });
  }

  // Everything as one file, in the same shape as the database.
  function exportBackup() {
    const data = {
      campaign: '2026R2', exportedAt: new Date().toISOString(),
      weeks: Object.fromEntries(Object.entries(state.weeks).map(([key, coupons]) => [key, { coupons }])),
      settings: { wallets: state.wallets }
    };
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    link.download = `消費券備份-${Core.macauDate()}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    toast('已匯出備份');
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

  function openSheet({ title, body, ok, action, change }) {
    $('sheetTitle').textContent = title;
    $('sheetBody').innerHTML = body;
    $('sheetOk').textContent = ok;
    $('sheetOk').hidden = !ok;
    $('sheetCancel').textContent = ok ? '取消' : '關閉';
    sheetAction = action;
    sheetChange = change;
    updateSheetOk();
    $('sheet').showModal();
    $('sheet').scrollTop = 0; // a long sheet opens at its top, not at the focused button
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
  $('who').addEventListener('change', event => {
    const member = event.target.dataset.member;
    if (event.target.checked) state.skip.delete(member); else state.skip.add(member);
    saveCache();
    renderUse();
  });
  $('clearPrice').addEventListener('click', () => {
    $('price').value = '';
    state.price = null;
    renderUse();
    $('price').focus();
  });
  $('markPlan').addEventListener('click', () => {
    const result = currentPlan();
    $('price').value = '';
    state.price = null;
    markUsed(result.payments);
  });
  $('useList').addEventListener('click', event => {
    const row = event.target.closest('[data-use]');
    if (row) openUseSheet(...row.dataset.use.split('|'));
  });
  $('usedList').addEventListener('click', event => {
    const row = event.target.closest('[data-used]');
    if (row) openUsedSheet(row.dataset.used);
  });
  $('export').addEventListener('click', exportBackup);
  $('regList').addEventListener('click', event => {
    const row = event.target.closest('[data-reg]');
    if (row) openRegisterSheet(...row.dataset.reg.split('|'));
  });
  $('weekList').addEventListener('click', event => {
    const row = event.target.closest('[data-week]');
    if (row) openWeekSheet(row.dataset.week);
  });
  $('walletSettings').addEventListener('change', event => {
    const [member, wallet] = event.target.dataset.wallet.split('|');
    state.wallets[member][wallet] = event.target.checked;
    render();
    if (!db) { toast('未能連線，請稍後再試'); return; }
    db.ref(`${ROOT}/settings/wallets/${member}/${wallet}`).set(event.target.checked).catch(() => toast('儲存失敗，請再試一次'));
  });

  $('sheetForm').addEventListener('change', () => { if (sheetChange) sheetChange(); updateSheetOk(); });
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
