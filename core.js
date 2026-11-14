// Campaign rules and coupon maths. Pure functions, no DOM: runs in the browser and in `node --test`.
(function (root) {
  'use strict';

  const MEMBERS = ['爸爸', '媽媽', '姐姐', '昌哥', '妹妹'];
  const WALLETS = ['MPay', '中銀', '工銀', '大豐', '國際', '支付寶', 'UEPay', '廣發'];
  const FACES = [10, 20, 50, 100, 200]; // e-voucher face values (MOP)
  const MULTIPLE = 3; // a voucher applies once the payment reaches face × 3
  const MERCHANT = { off: 12, min: 100 }; // merchant coupon: MOP 12 off a payment of MOP 100 or more, one per payment
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
  // With `merchant`, wallets also carry their unused merchant coupon (and are listed even with no e-voucher).
  function wallets(coupons, { merchant = false } = {}) {
    const list = [];
    for (const member of MEMBERS) for (const payment of WALLETS) {
      const unused = Object.entries(coupons).filter(([, c]) => c.member === member && c.payment === payment && !c.used);
      const mine = unused.filter(([, c]) => c.type === 'gov').map(([id, c]) => ({ id, face: c.amount }));
      const merchantId = merchant ? (unused.find(([, c]) => c.type === 'merchant') || [null])[0] : null;
      if (!mine.length && !merchantId) continue;
      const face = sum(mine, c => c.face);
      list.push({ member, payment, coupons: mine, merchantId, face, spend: face * MULTIPLE, pay: face * (MULTIPLE - 1) });
    }
    return list;
  }

  // One payment from one wallet: the merchant coupon comes off first, then e-vouchers apply to what is left.
  function settle(wallet, spend, merchant) {
    const first = merchant ? MERCHANT.off : 0;
    const used = applied(wallet.coupons, spend - first);
    const face = sum(used, c => c.face);
    return { wallet, spend, merchant, coupons: used, face, off: face + first };
  }

  // Split a purchase of `price` across wallets so the most is taken off.
  // Each wallet pays once. Fewer payments win a tie.
  function plan(walletList, price) {
    const better = (a, b) => a.off !== b.off ? a.off > b.off : a.picks.length < b.picks.length;
    let states = new Map([[0, { off: 0, picks: [] }]]);
    for (const wallet of walletList) {
      const options = new Map();
      for (let mask = 0; mask < 1 << wallet.coupons.length; mask++) {
        const need = MULTIPLE * sum(wallet.coupons.filter((_, i) => mask >> i & 1), c => c.face);
        const spends = [];
        if (mask) spends.push([need, false]);
        if (wallet.merchantId) spends.push([Math.max(MERCHANT.min, need + MERCHANT.off), true]);
        for (const [spend, merchant] of spends) {
          if (spend > price) continue;
          const option = settle(wallet, spend, merchant);
          const key = `${spend}|${merchant}`;
          if (!options.has(key)) options.set(key, option);
        }
      }
      const next = new Map(states);
      for (const [spent, state] of states) for (const option of options.values()) {
        const total = spent + option.spend;
        if (total > price) continue;
        const candidate = { off: state.off + option.off, picks: [...state.picks, option] };
        if (!next.has(total) || better(candidate, next.get(total))) next.set(total, candidate);
      }
      states = next;
    }
    let best = { off: 0, picks: [] }, bestSpent = 0;
    for (const [spent, state] of states) if (better(state, best)) { best = state; bestSpent = spent; }

    // Whatever the coupons don't need goes on the largest payment.
    const picks = [...best.picks];
    const rest = round(price - bestSpent);
    if (picks.length && rest > 0) {
      const index = picks.reduce((at, pick, i) => (pick.spend > picks[at].spend ? i : at), 0);
      picks[index] = settle(picks[index].wallet, round(picks[index].spend + rest), picks[index].merchant);
    }
    const face = sum(picks, pick => pick.face);
    const off = sum(picks, pick => pick.off);
    const total = sum(walletList, wallet => wallet.face);
    const faces = walletList.flatMap(w => w.coupons.map(c => c.face));
    const least = [...faces.map(f => f * MULTIPLE), ...(walletList.some(w => w.merchantId) ? [MERCHANT.min] : [])];
    return {
      payments: picks.map(pick => ({
        member: pick.wallet.member, payment: pick.wallet.payment, merchant: pick.merchant,
        spend: pick.spend, face: pick.face, off: pick.off, pay: round(pick.spend - pick.off),
        ids: [...pick.coupons.map(c => c.id), ...(pick.merchant ? [pick.wallet.merchantId] : [])]
      })),
      face, // e-voucher value used
      off, // everything taken off, merchant coupons included
      pay: round(price - off), // what the family pays
      left: total - face, // e-voucher value still unused afterwards
      full: total * MULTIPLE, // price needed to use every e-voucher
      least: least.length ? Math.min(...least) : 0 // smallest price that uses anything
    };
  }

  const api = { MEMBERS, WALLETS, FACES, MULTIPLE, MERCHANT, START, END, macauDate, week, applied, wallets, plan };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Core = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
