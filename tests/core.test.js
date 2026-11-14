const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../core.js');

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
  assert.equal(result.left, 210);
});

test('plan: one wallet is enough and takes the whole price', () => {
  const result = Core.plan(Core.wallets(family), 65);
  assert.equal(result.payments.length, 1);
  assert.deepEqual([result.payments[0].spend, result.payments[0].face, result.payments[0].pay], [65, 20, 45]);
  assert.equal(result.left, 190);
});

test('plan: splits across wallets to use the most vouchers', () => {
  const result = Core.plan(Core.wallets(family), 400);
  assert.equal(result.face, 130); // 110 + 20; 400 / 3 = 133
  assert.equal(result.pay, 270);
  assert.equal(result.payments.reduce((total, p) => total + p.spend, 0), 400);
  assert.equal(result.payments.length, 2);
  for (const p of result.payments) assert.ok(p.spend >= p.face * 3);
});

test('plan: price covers everything, the extra goes on one payment', () => {
  const result = Core.plan(Core.wallets(family), 700);
  assert.equal(result.face, 210);
  assert.equal(result.left, 0);
  assert.equal(result.full, 630);
  assert.equal(result.pay, 490);
  assert.equal(result.payments.length, 4);
  assert.equal(result.payments.reduce((total, p) => total + p.spend, 0), 700);
  assert.equal(result.payments.flatMap(p => p.ids).length, 6);
});

test('plan: exact threshold and cents', () => {
  assert.equal(Core.plan(Core.wallets(family), 630).left, 0);
  const result = Core.plan(Core.wallets(family), 199.5);
  assert.equal(result.face, 60);
  assert.equal(result.pay, 139.5);
  assert.equal(result.payments.reduce((total, p) => total + p.spend, 0), 199.5);
});

test('plan: no vouchers at all', () => {
  const result = Core.plan([], 100);
  assert.deepEqual([result.payments.length, result.face, result.pay, result.left, result.full, result.least], [0, 0, 100, 0, 0, 0]);
});
