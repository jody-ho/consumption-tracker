// Campaign rules and coupon maths. Pure functions, no DOM: runs in the browser and in `node --test`.
(function (root) {
  'use strict';

  const MEMBERS = ['爸爸', '媽媽', '姐姐', '昌哥', '妹妹'];
  const WALLETS = ['MPay', '中銀', '工銀', '大豐', '國際', '支付寶', 'UEPay', '廣發'];
  const FACES = [10, 20, 50, 100, 200]; // e-voucher face values (MOP)
  const MULTIPLE = 3; // a voucher applies once the payment reaches face × 3
  const START = '2026-10-09'; // first Friday
  const END = '2026-12-17'; // last Thursday
  const DAY = 86400000;

  const toDay = key => Date.parse(`${key}T00:00:00Z`) / DAY;
  const fromDay = day => new Date(day * DAY).toISOString().slice(0, 10);
  const sum = (list, pick) => list.reduce((total, item) => total + pick(item), 0);
  const round = value => Math.round(value * 100) / 100;

  // Today's date in Macau as YYYY-MM-DD, whatever the phone's own time zone.
  function macauDate(now = new Date()) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Macau', year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(now).map(part => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  }

  // Weeks run Friday to Thursday. Vouchers drawn in a week expire that Thursday 23:59.
  function week(dateKey) {
    if (dateKey < START || dateKey > END) return null;
    const index = Math.floor((toDay(dateKey) - toDay(START)) / 7);
    const end = fromDay(toDay(START) + index * 7 + 6);
    return { key: `2026R2-W${index + 1}`, end, daysLeft: toDay(end) - toDay(dateKey) };
  }

  // What the payment app does by itself: largest voucher first, each one uses up face × 3 of the payment.
  function applied(coupons, spend) {
    let left = spend;
    return [...coupons].sort((a, b) => b.face - a.face).filter(coupon => {
      if (left < coupon.face * MULTIPLE) return false;
      left -= coupon.face * MULTIPLE;
      return true;
    });
  }

  // Unused e-vouchers grouped per wallet, in family order.
  // `coupons` is the stored map: id → { member, payment, type, amount, used }.
  function wallets(coupons) {
    const list = [];
    for (const member of MEMBERS) for (const payment of WALLETS) {
      const mine = Object.entries(coupons)
        .filter(([, c]) => c.member === member && c.payment === payment && c.type === 'gov' && !c.used)
        .map(([id, c]) => ({ id, face: c.amount }));
      if (!mine.length) continue;
      const face = sum(mine, c => c.face);
      list.push({ member, payment, coupons: mine, face, spend: face * MULTIPLE, pay: face * (MULTIPLE - 1) });
    }
    return list;
  }

  // Split a purchase of `price` across wallets so the most voucher value is used.
  // Each wallet pays once. Fewer payments win a tie.
  function plan(walletList, price) {
    const better = (a, b) => a.face !== b.face ? a.face > b.face : a.picks.length < b.picks.length;
    let states = new Map([[0, { face: 0, picks: [] }]]);
    for (const wallet of walletList) {
      const options = new Map();
      for (let mask = 1; mask < 1 << wallet.coupons.length; mask++) {
        const spend = MULTIPLE * sum(wallet.coupons.filter((_, i) => mask >> i & 1), c => c.face);
        if (spend > price || options.has(spend)) continue;
        const used = applied(wallet.coupons, spend);
        options.set(spend, { wallet, spend, coupons: used, face: sum(used, c => c.face) });
      }
      const next = new Map(states);
      for (const [spent, state] of states) for (const option of options.values()) {
        const total = spent + option.spend;
        if (total > price) continue;
        const candidate = { face: state.face + option.face, picks: [...state.picks, option] };
        if (!next.has(total) || better(candidate, next.get(total))) next.set(total, candidate);
      }
      states = next;
    }
    let best = { face: 0, picks: [] }, bestSpent = 0;
    for (const [spent, state] of states) if (better(state, best)) { best = state; bestSpent = spent; }

    // Whatever the vouchers don't need goes on the largest payment.
    const picks = best.picks.map(pick => ({ ...pick }));
    const rest = round(price - bestSpent);
    if (picks.length && rest > 0) {
      const target = picks.reduce((a, b) => (b.spend > a.spend ? b : a));
      target.spend = round(target.spend + rest);
      target.coupons = applied(target.wallet.coupons, target.spend);
      target.face = sum(target.coupons, c => c.face);
    }
    const face = sum(picks, pick => pick.face);
    const total = sum(walletList, wallet => wallet.face);
    return {
      payments: picks.map(pick => ({
        member: pick.wallet.member, payment: pick.wallet.payment,
        spend: pick.spend, face: pick.face, pay: round(pick.spend - pick.face), ids: pick.coupons.map(c => c.id)
      })),
      face, // voucher value used
      pay: round(price - face), // what the family pays
      left: total - face, // voucher value still unused afterwards
      full: total * MULTIPLE, // price needed to use everything
      least: walletList.length ? MULTIPLE * Math.min(...walletList.flatMap(w => w.coupons.map(c => c.face))) : 0
    };
  }

  const api = { MEMBERS, WALLETS, FACES, MULTIPLE, START, END, macauDate, week, applied, wallets, plan };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Core = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
