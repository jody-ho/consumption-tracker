const test = require('node:test');
const assert = require('node:assert/strict');
const calc = require('../script.js');

const coupon = (id, member, payment, type, amount, extra = {}) => ({ id, member, payment, type, amount, used: false, ...extra });

test('merchant 100−12 and government three-times thresholds remain intact', () => {
  const merchant = coupon('m', '爸爸', 'MPay', 'merchant', 12);
  const gov = coupon('g', '爸爸', 'MPay', 'gov', 20);
  const plan = calc.planHousehold(100, 0, [merchant, gov], { merchantAvailable: true });
  assert.equal(plan.valid, true);
  assert.equal(plan.plans[0].totalPay, 68);
  assert.equal(plan.plans[0].transactions.length, 1);
  assert.equal(plan.plans[0].transactions[0].merchantCoupon.id, 'm');
  assert.equal(calc.validateRedemptionThresholds(6800, 2000, 1, [2000]).valid, true);
  assert.equal(calc.validateRedemptionThresholds(3900, 2000, 1, [2000]).valid, false);
  assert.equal(calc.validateRedemptionThresholds(8000, 2000, 2, [2000]).valid, false);
  assert.equal(calc.validateRedemptionThresholds(6000, 3000, 0, [1000, 2000]).valid, true);
  assert.equal(calc.validateRedemptionThresholds(5999, 3000, 0, [1000, 2000]).valid, false);
  const merchantOnly = calc.planHousehold(100, 0, [merchant], { merchantAvailable: true });
  assert.equal(merchantOnly.plans[0].totalPay, 88);
});

test('wallets stay separate and first spend reduces only the remaining budget', () => {
  const entries = [coupon('a', '爸爸', 'MPay', 'gov', 20), coupon('b', '媽媽', '中銀', 'gov', 20)];
  const plan = calc.planHousehold(120, 0, entries);
  assert.equal(plan.plans[0].transactions.length, 2);
  assert.deepEqual(new Set(plan.plans[0].transactions.map(t => `${t.member}|${t.payment}`)), new Set(['爸爸|MPay', '媽媽|中銀']));
  const first = calc.planHousehold(100, 50, entries);
  assert.equal(first.firstSpend, 50);
  assert.equal(first.remaining, 50);
  assert.equal(first.plans[0].usedGovernmentCoupons.length, 0);
});

test('Macau date is stable across UTC boundary', () => {
  assert.equal(calc.macauDateKey(new Date('2026-10-08T15:59:00Z')), '2026-10-08');
  assert.equal(calc.macauDateKey(new Date('2026-10-08T16:01:00Z')), '2026-10-09');
});

test('dashboard counts eligible unused government vouchers and deduplicates actual transactions', () => {
  const records = [
    coupon('a', '爸爸', 'MPay', 'gov', 20),
    coupon('b', '爸爸', 'MPay', 'merchant', 12),
    coupon('c', '媽媽', '中銀', 'gov', 10, {used: true, redemption: {transactionId: 'one', date: '2026-10-09', actualSpendCents: 10000, actualPaidCents: 9000}}),
    coupon('d', '媽媽', '中銀', 'gov', 20, {used: true, redemption: {transactionId: 'one', date: '2026-10-09', actualSpendCents: 10000, actualPaidCents: 9000}}),
    coupon('e', '姐姐', 'MPay', 'gift', 0, {used: true, redemption: {transactionId: 'missing', date: '2026-10-09'}})
  ];
  const summary = calc.summarizeDashboard(records, '2026-10-09', '2026-10-15', false);
  assert.equal(summary.unusedGovernmentCents, 2000);
  assert.equal(summary.minimumSpendCents, 6000);
  assert.equal(summary.estimatedPayCents, 4000);
  assert.equal(summary.actualSpendCents, 10000);
  assert.equal(summary.actualPaidCents, 9000);
  assert.equal(summary.discountCents, 1000);
  assert.equal(summary.hasMissingActual, true);
  assert.equal(summary.byWallet['媽媽|中銀'].actualSpendCents, 10000);
  assert.equal(calc.summarizeDashboard(records, '2026-10-09', '2026-10-15', true).unusedGovernmentCents, 0);
});

test('legacy usedAt groups a multi-voucher purchase without a transaction id', () => {
  const at = Date.parse('2026-10-10T12:00:00+08:00');
  const entries = [
    coupon('a', '爸爸', 'MPay', 'gov', 10, { used: true, usedAt: at, redemption: { actualSpendCents: 10000, actualPaidCents: 7000 } }),
    coupon('b', '爸爸', 'MPay', 'gov', 20, { used: true, usedAt: at, redemption: { actualSpendCents: 10000, actualPaidCents: 7000 } })
  ];
  const result = calc.summarizeDashboard(entries, '2026-10-09', '2026-10-15');
  assert.equal(result.recordedTransactions, 1);
  assert.equal(result.actualSpendCents, 10000);
  assert.equal(result.actualPaidCents, 7000);
  assert.equal(result.hasMissingActual, false);
});

test('ambiguous legacy and conflicting amounts never become actual totals', () => {
  const entries = [
    coupon('a', '爸爸', 'MPay', 'gov', 10, { used: true, redemption: { date: '2026-10-10', actualSpendCents: 3000, actualPaidCents: 2000 } }),
    coupon('b', '媽媽', '中銀', 'gov', 10, { used: true, redemption: { transactionId: 'same', date: '2026-10-10', actualSpendCents: 3000, actualPaidCents: 2000 } }),
    coupon('c', '媽媽', '中銀', 'gov', 20, { used: true, redemption: { transactionId: 'same', date: '2026-10-10', actualSpendCents: 4000, actualPaidCents: 2000 } })
  ];
  const result = calc.summarizeDashboard(entries, '2026-10-09', '2026-10-15');
  assert.equal(result.actualSpendCents, 0);
  assert.equal(result.hasMissingActual, true);
});
