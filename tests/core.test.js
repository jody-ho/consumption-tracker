const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../core.js');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Phones keep app.css, core.js and app.js until their address changes, so index.html asks for them by content version.
test('index.html asks for the current version of the files it loads', () => {
  const read = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8').replace(/\r/g, '');
  const files = ['app.css', 'core.js', 'app.js'];
  const version = crypto.createHash('sha256').update(files.map(read).join('\n')).digest('hex').slice(0, 8);
  const html = read('index.html');
  for (const name of files) assert.ok(html.includes(`"./${name}?v=${version}"`), `in index.html, load ${name} as ./${name}?v=${version}`);
});

const coupon = (member, payment, amount, used = false, type = 'gov') => ({ member, payment, type, amount, used });
const family = {
  a: coupon('爸爸', 'MPay', 20),
  b: coupon('媽媽', '工銀', 50), c: coupon('媽媽', '工銀', 10),
  d: coupon('媽媽', '大豐', 20),
  e: coupon('姐姐', '中銀', 100), f: coupon('姐姐', '中銀', 10),
  used: coupon('爸爸', 'MPay', 200, true),
  merchant: coupon('昌哥', 'UEPay', 12, false, 'merchant'),
  zero: coupon('昌哥', 'UEPay', 0, false, 'zero')
};

test('weeks run Friday to Thursday inside the campaign', () => {
  assert.deepEqual(Core.week('2026-10-09'), { key: '2026R2-W1', end: '2026-10-15', daysLeft: 6 });
  assert.deepEqual(Core.week('2026-10-15'), { key: '2026R2-W1', end: '2026-10-15', daysLeft: 0 });
  assert.equal(Core.week('2026-10-16').key, '2026R2-W2');
  assert.deepEqual(Core.week('2026-12-17'), { key: '2026R2-W10', end: '2026-12-17', daysLeft: 0 });
  assert.equal(Core.week('2026-10-08'), null);
  assert.equal(Core.week('2026-12-18'), null);
});

test('Macau date ignores the device time zone', () => {
  assert.equal(Core.macauDate(new Date('2026-10-15T15:59:00Z')), '2026-10-15');
  assert.equal(Core.macauDate(new Date('2026-10-15T16:00:00Z')), '2026-10-16');
});

test('vouchers apply largest first, each needing three times its face', () => {
  const mine = [{ id: 'x', face: 20 }, { id: 'y', face: 50 }, { id: 'z', face: 10 }];
  assert.deepEqual(Core.applied(mine, 29).map(c => c.id), []);
  assert.deepEqual(Core.applied(mine, 90).map(c => c.id), ['x', 'z']);
  assert.deepEqual(Core.applied(mine, 150).map(c => c.id), ['y']);
  assert.deepEqual(Core.applied(mine, 240).map(c => c.id), ['y', 'x', 'z']);
});

test('wallets list only unused e-vouchers with spend and own payment', () => {
  const list = Core.wallets(family);
  assert.deepEqual(list.map(w => [w.member, w.payment, w.face, w.spend, w.pay]), [
    ['爸爸', 'MPay', 20, 60, 40],
    ['媽媽', '工銀', 60, 180, 120],
    ['媽媽', '大豐', 20, 60, 40],
    ['姐姐', '中銀', 110, 330, 220]
  ]);
});

test('plan: price too small for any voucher', () => {
  const result = Core.plan(Core.wallets(family), 25);
  assert.deepEqual(result.payments, []);
  assert.equal(result.face, 0);
  assert.equal(result.pay, 25);
  assert.equal(result.least, 30);
  assert.deepEqual([result.exact, result.next], [false, { more: 5, gain: 10 }]);
});

test('plan: one wallet is enough and takes the whole price', () => {
  const result = Core.plan(Core.wallets(family), 65);
  assert.equal(result.payments.length, 1);
  assert.deepEqual([result.payments[0].spend, result.payments[0].face, result.payments[0].pay], [65, 20, 45]);
});

test('plan: splits across wallets to use the most vouchers', () => {
  const result = Core.plan(Core.wallets(family), 400);
  assert.equal(result.off, 130); // 110 + 20; 400 / 3 = 133
  assert.equal(result.pay, 270);
  assert.equal(result.payments.reduce((total, p) => total + p.spend, 0), 400);
  assert.equal(result.payments.length, 2);
  for (const p of result.payments) assert.ok(p.spend >= p.face * 3);
});

test('plan: price covers everything, the extra goes on one payment', () => {
  const result = Core.plan(Core.wallets(family), 700);
  assert.equal(result.face, 210);
  assert.deepEqual([result.exact, result.next], [false, null]);
  assert.equal(result.pay, 490);
  assert.equal(result.payments.length, 4);
  assert.equal(result.payments.reduce((total, p) => total + p.spend, 0), 700);
  assert.equal(result.payments.flatMap(p => p.ids).length, 6);
});

test('plan: exact threshold and cents', () => {
  assert.deepEqual([Core.plan(Core.wallets(family), 630).face, Core.plan(Core.wallets(family), 630).exact], [210, true]);
  const result = Core.plan(Core.wallets(family), 199.5);
  assert.equal(result.face, 60);
  assert.equal(result.pay, 139.5);
  assert.equal(result.payments.reduce((total, p) => total + p.spend, 0), 199.5);
});

test('plan: how much more to buy for the next coupon, or exactly right', () => {
  const list = Core.wallets(family);
  let result = Core.plan(list, 400); // 330 + 60 used; 420 would add the MOP 10 voucher
  assert.deepEqual([result.off, result.exact, result.next], [130, false, { more: 20, gain: 10 }]);
  result = Core.plan(list, 390);
  assert.deepEqual([result.off, result.exact], [130, true]);
  result = Core.plan(list, 59.5);
  assert.deepEqual([result.off, result.next], [10, { more: 0.5, gain: 10 }]);
  const dad = list.filter(w => w.member === '爸爸'); // only one person's coupons
  result = Core.plan(dad, 400);
  assert.deepEqual([result.off, result.payments.length, result.next], [20, 1, null]);
  const merchant = Core.wallets({ g: coupon('媽媽', '大豐', 20), m: coupon('媽媽', '大豐', 12, false, 'merchant') }, { merchant: true });
  assert.deepEqual(Core.plan(merchant, 80).next, { more: 20, gain: 12 });
});

test('weeks started so far, newest first', () => {
  assert.deepEqual(Core.weeks('2026-10-08'), []);
  assert.deepEqual(Core.weeks('2026-10-16'), [
    { key: '2026R2-W2', number: 2, start: '2026-10-16', end: '2026-10-22' },
    { key: '2026R2-W1', number: 1, start: '2026-10-09', end: '2026-10-15' }
  ]);
  assert.equal(Core.weeks('2026-12-17').length, 10);
  assert.equal(Core.weeks('2027-01-01').length, 10);
  assert.equal(Core.weeks('2027-01-01')[0].end, Core.END);
});

const rows = map => Object.entries(map).map(([id, c]) => ({ id, ...c }));

test('payments: used coupons grouped per payment, with saved or estimated amounts', () => {
  const saved = { transactionId: 't1', actualSpendCents: 25000, actualPaidCents: 18800 };
  const paid = Core.payments(rows({
    a: { ...coupon('媽媽', '大豐', 50, true), redemption: saved },
    b: { ...coupon('媽媽', '大豐', 12, true, 'merchant'), redemption: saved },
    c: { ...coupon('媽媽', '大豐', 10, true), redemption: { transactionId: 't2' } }, // an older row without amounts
    d: coupon('爸爸', 'MPay', 20, true), // no redemption at all
    e: { ...coupon('爸爸', 'MPay', 12, true, 'merchant'), usedAt: 9 },
    f: coupon('爸爸', 'MPay', 100), g: coupon('爸爸', 'MPay', 0, true, 'gift')
  }));
  assert.deepEqual(paid.map(p => [p.member, p.payment, p.face, p.merchant, p.ids.join(), p.off, p.spend, p.pay]), [
    ['媽媽', '大豐', 50, true, 'a,b', 62, 250, 188],
    ['媽媽', '大豐', 10, false, 'c', 10, 30, 20],
    ['爸爸', 'MPay', 20, false, 'd', 20, 60, 40],
    ['爸爸', 'MPay', 0, true, 'e', 12, 100, 88]
  ]);
});

test('estimate: the smallest payment that uses a set of coupons', () => {
  assert.deepEqual(Core.estimate([50, 10], false), { off: 60, spend: 180, pay: 120 });
  assert.deepEqual(Core.estimate([20], true), { off: 32, spend: 100, pay: 68 });
  assert.deepEqual(Core.estimate([50], true), { off: 62, spend: 162, pay: 100 });
  assert.deepEqual(Core.estimate([], true), { off: 12, spend: 100, pay: 88 });
  assert.deepEqual(Core.estimate([], false), { off: 0, spend: 0, pay: 0 });
});

test('tally counts e-vouchers drawn and used, and what was paid', () => {
  assert.deepEqual(Core.tally(rows(family)), { won: 410, used: 200, spend: 600, pay: 400 });
  assert.deepEqual(Core.tally([]), { won: 0, used: 0, spend: 0, pay: 0 });
});

test('luck: the luckiest person and wallet, ties in family order', () => {
  assert.deepEqual(Core.luck(rows(family)), { member: { name: '爸爸', won: 220 }, wallet: { name: 'MPay', won: 220 }, merchant: 1, gift: 0 });
  assert.deepEqual(Core.luck(rows({ a: coupon('媽媽', '工銀', 50), b: coupon('爸爸', 'MPay', 50), c: coupon('姐姐', '中銀', 0, false, 'gift') })).member, { name: '爸爸', won: 50 });
  assert.deepEqual(Core.luck([]), { member: null, wallet: null, merchant: 0, gift: 0 });
});

test('plan: no vouchers at all', () => {
  const result = Core.plan([], 100);
  assert.deepEqual([result.payments.length, result.face, result.pay, result.least, result.exact, result.next], [0, 0, 100, 0, false, null]);
});

test('merchant coupons are ignored unless asked for', () => {
  assert.equal(Core.wallets(family).some(w => w.merchantId), false);
  const list = Core.wallets(family, { merchant: true });
  assert.deepEqual(list.map(w => [w.member, w.payment, w.face, Boolean(w.merchantId)]).at(-1), ['昌哥', 'UEPay', 0, true]);
  assert.equal(Core.plan(Core.wallets(family), 100).off, 30); // 20 + 10 e-vouchers only
});

test('plan with a merchant coupon: MOP 12 off MOP 100, then e-vouchers on what is left', () => {
  const both = { g: coupon('媽媽', '大豐', 20), m: coupon('媽媽', '大豐', 12, false, 'merchant') };
  let result = Core.plan(Core.wallets(both, { merchant: true }), 100);
  assert.deepEqual([result.off, result.face, result.pay, result.payments[0].merchant], [32, 20, 68, true]);
  assert.deepEqual(result.payments[0].ids.sort(), ['g', 'm']);
  result = Core.plan(Core.wallets(both, { merchant: true }), 99); // under MOP 100: e-voucher only
  assert.deepEqual([result.off, result.payments[0].merchant, result.payments[0].ids], [20, false, ['g']]);
  const big = { g: coupon('媽媽', '大豐', 50), m: coupon('媽媽', '大豐', 12, false, 'merchant') };
  result = Core.plan(Core.wallets(big, { merchant: true }), 155); // 155 − 12 = 143 < 150, so pick whichever saves more
  assert.equal(result.off, 50);
  result = Core.plan(Core.wallets(big, { merchant: true }), 162);
  assert.deepEqual([result.off, result.pay], [62, 100]);
  const only = { m: coupon('昌哥', 'UEPay', 12, false, 'merchant') };
  result = Core.plan(Core.wallets(only, { merchant: true }), 120);
  assert.deepEqual([result.off, result.face, result.pay, result.least, result.payments[0].spend], [12, 0, 108, 100, 120]);
});
