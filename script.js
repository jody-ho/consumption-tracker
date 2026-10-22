/* Household coupon optimizer: keeps government wallets separate and tracks issued merchant vouchers. */
(function (root) {
  'use strict';

  const CENTS = 100;
  const GOV_DENOMINATIONS = new Set([10, 20, 50, 100, 200]);
  const MERCHANT_MIN_CENTS = 10000;
  const MERCHANT_DISCOUNT_CENTS = 1200;

  function toCents(value) {
    const amount = Number(value);
    return Number.isFinite(amount) ? Math.round((amount + Number.EPSILON) * CENTS) : NaN;
  }

  function fromCents(value) {
    return value / CENTS;
  }

  // Flatten coupon associations into financial/audit records without losing a prior transaction.
  function redemptionEntries(couponEntries) {
    const entries = Array.isArray(couponEntries) ? couponEntries : Object.values(couponEntries || {});
    return entries.flatMap(coupon => {
      if (!coupon) return [];
      const sources = [];
      if (coupon.used || coupon.redemption?.undoAudit) sources.push(coupon.redemption || {});
      if (Array.isArray(coupon.redemptionHistory)) sources.push(...coupon.redemptionHistory.filter(r => r && typeof r === 'object'));
      const seen = new Set();
      return sources.filter(r => {
        const key = r.transactionId || JSON.stringify(r);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }).map(redemption => ({ ...coupon, used: true, redemption, redemptionHistory: [] }));
    });
  }

  function summarizeActualSpend(couponEntries, startDate, endDate) {
    const byMember = Object.create(null);
    const groupedTransactions = new Map();
    const getMember = member => {
      if (!byMember[member]) byMember[member] = { totalCents: 0, hasUnrecorded: false };
      return byMember[member];
    };
    const entries = redemptionEntries(couponEntries);

    for (const coupon of entries) {
      if (!coupon || !coupon.used) continue;
      if (coupon.redemption?.undoAudit && (coupon.redemption.actualPaidCents === null || coupon.redemption.actualPaidCents === undefined || String(coupon.redemption.actualPaidCents).trim() === '')) continue;
      const member = String(coupon.member || '').trim();
      if (!member) continue;
      const redemption = coupon.redemption;
      let date = String(redemption && redemption.date || '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        const rawUsedAt = coupon.usedAt;
        const numericUsedAt = Number(rawUsedAt);
        const usedAtDate = new Date(numericUsedAt);
        if (rawUsedAt !== null && rawUsedAt !== undefined && String(rawUsedAt).trim() !== '' && Number.isFinite(usedAtDate.getTime())) {
          const dateParts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Macau', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(usedAtDate).map(part => [part.type, part.value]));
          date = `${dateParts.year}-${dateParts.month}-${dateParts.day}`;
        }
      }
      if (/^\d{4}-\d{2}-\d{2}$/.test(date) && (date < startDate || date > endDate)) continue;
      const memberSummary = getMember(member);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        memberSummary.hasUnrecorded = true;
        continue;
      }
      const rawActualPaidCents = redemption && redemption.actualPaidCents;
      const actualPaidCents = Number(rawActualPaidCents);
      if (rawActualPaidCents === null || rawActualPaidCents === undefined || String(rawActualPaidCents).trim() === '' || !Number.isInteger(actualPaidCents) || actualPaidCents < 0) {
        memberSummary.hasUnrecorded = true;
        continue;
      }

      const payment = String(coupon.payment || '').trim();
      const transactionId = String(redemption && redemption.transactionId || '').trim();
      const rawCouponUsedAt = coupon.usedAt;
      const usedAt = rawCouponUsedAt !== null && rawCouponUsedAt !== undefined && String(rawCouponUsedAt).trim() !== '' && Number.isFinite(Number(rawCouponUsedAt))
        ? String(Number(rawCouponUsedAt))
        : '';
      const transactionKey = transactionId
        ? `id:${member}|${payment}|${transactionId}`
        : usedAt
          ? `legacy:${member}|${payment}|${date}|at:${usedAt}`
          : `legacy:${member}|${payment}|${date}|amount:${actualPaidCents}`;
      const previous = groupedTransactions.get(transactionKey);
      if (previous) {
        if (previous.actualPaidCents !== actualPaidCents) {
          previous.invalid = true;
          memberSummary.hasUnrecorded = true;
        }
        continue;
      }
      groupedTransactions.set(transactionKey, { member, actualPaidCents, invalid: false });
    }

    for (const transaction of groupedTransactions.values()) {
      if (!transaction.invalid) getMember(transaction.member).totalCents += transaction.actualPaidCents;
    }
    const summaries = Object.values(byMember);
    return {
      byMember,
      totalCents: summaries.reduce((sum, row) => sum + row.totalCents, 0),
      hasUnrecorded: summaries.some(row => row.hasUnrecorded)
    };
  }

  // Display-only fallback: linked transactions only; isolation is per member and wallet.
  function estimateMissingTransactionAmounts(couponEntries, startDate, endDate) {
    const groups = new Map();
    for (const coupon of redemptionEntries(couponEntries)) {
      const r = coupon.redemption || {};
      const transactionId = String(r.transactionId || '').trim();
      if (!coupon.used || !transactionId || r.undoAudit) continue;
      let date = String(r.date || '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) && coupon.usedAt != null && Number.isFinite(Number(coupon.usedAt))) {
        const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Macau', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(Number(coupon.usedAt))).map(x => [x.type, x.value]));
        date = `${p.year}-${p.month}-${p.day}`;
      }
      if (/^\d{4}-\d{2}-\d{2}$/.test(date) && ((startDate && date < startDate) || (endDate && date > endDate))) continue;
      const key = JSON.stringify([coupon.member || '', coupon.payment || '', transactionId]);
      if (!groups.has(key)) groups.set(key, { transactionId, member: coupon.member || '', payment: coupon.payment || '', date, rows: [] });
      groups.get(key).rows.push(coupon);
    }
    const transactions = [];
    for (const group of groups.values()) {
      const govCents = group.rows.filter(c => c.type === 'gov').reduce((sum, c) => { const n = toCents(c.amount); return Number.isInteger(n) && n > 0 ? sum + n : sum; }, 0);
      const actualState = field => {
        const values = group.rows.map(c => c.redemption?.[field]);
        const missing = v => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
        if (values.some(v => !missing(v))) return 'present';
        return 'missing';
      };
      const estimatedSpendCents = actualState('actualSpendCents') === 'missing' && govCents ? govCents * 3 : null;
      const estimatedPaidCents = actualState('actualPaidCents') === 'missing' && govCents ? govCents * 2 : null;
      if (estimatedSpendCents === null && estimatedPaidCents === null) continue;
      transactions.push({ ...group, estimatedSpendCents, estimatedPaidCents });
    }
    const byMember = Object.create(null);
    for (const t of transactions) { const m = byMember[t.member] || (byMember[t.member] = { spendCents: 0, paidCents: 0 }); m.spendCents += t.estimatedSpendCents || 0; m.paidCents += t.estimatedPaidCents || 0; }
    return { transactions, byMember, totalSpendCents: transactions.reduce((n, t) => n + (t.estimatedSpendCents || 0), 0), totalPaidCents: transactions.reduce((n, t) => n + (t.estimatedPaidCents || 0), 0) };
  }

  function estimateUnusedGovernmentSpend(couponEntries) {
    const byMember = Object.create(null);
    const entries = Array.isArray(couponEntries) ? couponEntries : Object.values(couponEntries || {});
    for (const coupon of entries) {
      if (!coupon || coupon.used !== false || coupon.type !== 'gov') continue;
      const member = String(coupon.member || '').trim();
      const amountCents = toCents(coupon.amount);
      if (!member || !Number.isInteger(amountCents) || amountCents < 0) continue;
      byMember[member] = (byMember[member] || 0) + amountCents * 3;
    }
    return {
      byMember,
      totalCents: Object.values(byMember).reduce((sum, amountCents) => sum + amountCents, 0)
    };
  }

  function macauDateKey(date = new Date()) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Macau', year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(date).map(part => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  }

  // A single display selector keeps the household, member and wallet totals in sync.
  // Unknown legacy transaction grouping is reported as incomplete instead of guessing money.
  function summarizeDashboard(couponEntries, startDate, endDate, expired = false) {
    const entries = Array.isArray(couponEntries) ? couponEntries : Object.entries(couponEntries || {}).map(([id, row]) => ({ ...row, id }));
    const empty = () => ({ unusedGovernmentCents: 0, minimumSpendCents: 0, estimatedPayCents: 0,
      actualSpendCents: 0, actualPaidCents: 0, discountCents: 0, hasMissingActual: false, recordedTransactions: 0 });
    const result = { ...empty(), byMember: Object.create(null), byWallet: Object.create(null), hasResults: entries.length > 0 };
    const transactions = new Map();
    const rowFor = coupon => {
      const member = String(coupon.member || '').trim();
      const payment = String(coupon.payment || '').trim();
      if (!member || !payment) return null;
      if (!result.byMember[member]) result.byMember[member] = empty();
      const walletKey = `${member}|${payment}`;
      if (!result.byWallet[walletKey]) result.byWallet[walletKey] = { ...empty(), member, payment };
      return [result, result.byMember[member], result.byWallet[walletKey]];
    };
    const add = (rows, field, value) => rows.forEach(row => { row[field] += value; });
    const missing = rows => rows.forEach(row => { row.hasMissingActual = true; });
    for (const [index, coupon] of entries.entries()) {
      if (!coupon) continue;
      const rows = rowFor(coupon);
      if (!rows) continue;
      if (!expired && !coupon.used && coupon.type === 'gov' && GOV_DENOMINATIONS.has(Number(coupon.amount))) {
        const value = toCents(coupon.amount);
        add(rows, 'unusedGovernmentCents', value);
        add(rows, 'minimumSpendCents', value * 3);
        add(rows, 'estimatedPayCents', value * 2);
      }
      if (!coupon.used || coupon.redemption?.undoAudit) continue;
      const redemption = coupon.redemption || {};
      const date = /^\d{4}-\d{2}-\d{2}$/.test(redemption.date || '') ? redemption.date
        : Number.isFinite(Number(coupon.usedAt)) && coupon.usedAt != null ? macauDateKey(new Date(Number(coupon.usedAt))) : '';
      if (date && (date < startDate || date > endDate)) continue;
      if (!date) { missing(rows); continue; }
      const transactionId = String(redemption.transactionId || '').trim();
      const usedAt = coupon.usedAt != null && Number.isFinite(Number(coupon.usedAt)) ? String(Number(coupon.usedAt)) : '';
      const key = transactionId ? `id:${coupon.member}|${coupon.payment}|${transactionId}`
        : usedAt ? `legacy:${coupon.member}|${coupon.payment}|${usedAt}` : '';
      if (!key) { missing(rows); continue; }
      if (!transactions.has(key)) transactions.set(key, { rows, redemptions: [], index });
      transactions.get(key).redemptions.push(redemption);
    }
    const amount = (redemptions, field) => {
      const values = redemptions.map(r => r[field]);
      if (values.some(v => v === null || v === undefined || String(v).trim() === '')) return null;
      const numbers = values.map(Number);
      return numbers.every(v => Number.isInteger(v) && v >= 0 && v === numbers[0]) ? numbers[0] : null;
    };
    for (const { rows, redemptions } of transactions.values()) {
      const spend = amount(redemptions, 'actualSpendCents');
      const paid = amount(redemptions, 'actualPaidCents');
      if (spend === null || paid === null || paid > spend) { missing(rows); continue; }
      add(rows, 'actualSpendCents', spend);
      add(rows, 'actualPaidCents', paid);
      add(rows, 'discountCents', spend - paid);
      add(rows, 'recordedTransactions', 1);
    }
    return result;
  }

  function filterWalletRedemptions(walletRedemptions, member = 'all', payment = 'all') {
    const rows = Array.isArray(walletRedemptions) ? walletRedemptions : [];
    return rows.filter(wallet => wallet &&
      (member === 'all' || wallet.member === member) &&
      (payment === 'all' || wallet.payment === payment));
  }

  function validateRedemptionThresholds(actualPaidCents, governmentAmountCents, merchantCount = 0, governmentVoucherAmountsCents = null) {
    const paid = Number(actualPaidCents);
    const government = Number(governmentAmountCents);
    const merchant = Number(merchantCount);
    const inputsValid = Number.isInteger(paid) && paid >= 0 && Number.isInteger(government) && government >= 0 && Number.isInteger(merchant) && merchant >= 0;
    const safePaid = Number.isInteger(paid) && paid >= 0 ? paid : 0;
    const safeGovernment = Number.isInteger(government) && government >= 0 ? government : 0;
    const safeMerchant = Number.isInteger(merchant) && merchant >= 0 ? merchant : 0;
    const netBeforeGovernmentCents = safePaid + safeGovernment;
    const voucherAmounts = Array.isArray(governmentVoucherAmountsCents)
      ? governmentVoucherAmountsCents.map(Number)
      : safeGovernment > 0 ? [safeGovernment] : [];
    const voucherAmountsValid = voucherAmounts.every(amount => Number.isInteger(amount) && amount > 0) &&
      voucherAmounts.reduce((sum, amount) => sum + amount, 0) === safeGovernment;
    // Process vouchers largest-first: each voucher consumes three times its face value
    // from the eligible net before the next voucher is checked.
    const orderedVoucherAmounts = [...voucherAmounts].sort((a, b) => b - a);
    const governmentThresholdCents = orderedVoucherAmounts.reduce((sum, amount) => sum + amount * 3, 0);
    const governmentShortfallCents = Math.max(0, governmentThresholdCents - netBeforeGovernmentCents);
    const purchaseBeforeMerchantDiscountCents = netBeforeGovernmentCents + safeMerchant * MERCHANT_DISCOUNT_CENTS;
    const merchantShortfallCents = safeMerchant > 0 ? Math.max(0, MERCHANT_MIN_CENTS - purchaseBeforeMerchantDiscountCents) : 0;
    return {
      valid: inputsValid && voucherAmountsValid && safeMerchant <= 1 && governmentShortfallCents === 0 && merchantShortfallCents === 0,
      netBeforeGovernmentCents,
      governmentThresholdCents,
      governmentShortfallCents,
      purchaseBeforeMerchantDiscountCents,
      merchantShortfallCents,
      merchantLimitExceeded: safeMerchant > 1
    };
  }

  function validGovernmentCoupon(coupon) {
    const amount = Number(coupon && coupon.amount);
    return Boolean(coupon && !coupon.used && coupon.type === 'gov' && GOV_DENOMINATIONS.has(amount));
  }

  function validMerchantCoupon(coupon) {
    const payment = String(coupon && coupon.payment || '').trim();
    return Boolean(coupon && !coupon.used && coupon.type === 'merchant' && payment);
  }

  function groupGovernmentCoupons(entries) {
    const groups = new Map();
    for (const coupon of entries || []) {
      if (!validGovernmentCoupon(coupon)) continue;
      const member = String(coupon.member || '').trim();
      const payment = String(coupon.payment || '').trim();
      if (!member || !payment) continue;
      const key = `${member}\u001f${payment}`;
      if (!groups.has(key)) groups.set(key, { member, payment, coupons: [] });
      groups.get(key).coupons.push(coupon);
    }
    return [...groups.values()];
  }

  function enumeratePartitions(items) {
    const output = [];
    const buckets = [];
    function visit(index) {
      if (index === items.length) {
        if (buckets.length) output.push(buckets.map(bucket => [...bucket]));
        return;
      }
      visit(index + 1);
      for (let bucketIndex = 0; bucketIndex < buckets.length; bucketIndex++) {
        buckets[bucketIndex].push(items[index]);
        visit(index + 1);
        buckets[bucketIndex].pop();
      }
      buckets.push([items[index]]);
      visit(index + 1);
      buckets.pop();
    }
    visit(0);
    return output;
  }

  function groupChoices(group, merchantLimit) {
    const coupons = (group.coupons || []).filter(validGovernmentCoupon).slice(0, 3);
    if (!coupons.length) return [];
    const choices = [];

    for (const buckets of enumeratePartitions(coupons)) {
      for (let mask = 0; mask < (1 << buckets.length); mask++) {
        let merchantCount = 0;
        const transactions = buckets.map((bucket, index) => {
          const usesMerchant = Boolean(mask & (1 << index));
          if (usesMerchant) merchantCount++;
          const orderedCoupons = [...bucket].sort((a, b) => Number(b.amount) - Number(a.amount));
          const governmentCouponAmountsCents = orderedCoupons.map(coupon => Number(coupon.amount) * CENTS);
          const governmentAmountCents = governmentCouponAmountsCents.reduce((sum, amount) => sum + amount, 0);
          // Each larger voucher first consumes 3x its face value from eligible net.
          const governmentThresholdCents = governmentCouponAmountsCents.reduce((sum, amount) => sum + amount * 3, 0);
          const netSpendBeforeGovernmentCents = governmentThresholdCents;
          const minSpendCents = usesMerchant
            ? Math.max(MERCHANT_MIN_CENTS, netSpendBeforeGovernmentCents + MERCHANT_DISCOUNT_CENTS)
            : netSpendBeforeGovernmentCents;
          return {
            member: group.member,
            payment: group.payment,
            governmentCoupons: orderedCoupons,
            governmentAmountCents,
            governmentThresholdCents,
            minSpendCents,
            usesMerchant,
            merchantOnly: false
          };
        });
        if (merchantCount > merchantLimit) continue;
        choices.push({
          costCents: transactions.reduce((sum, transaction) => sum + transaction.minSpendCents, 0),
          discountCents: transactions.reduce((sum, transaction) => sum + transaction.governmentAmountCents + (transaction.usesMerchant ? MERCHANT_DISCOUNT_CENTS : 0), 0),
          governmentCount: transactions.reduce((sum, transaction) => sum + transaction.governmentCoupons.length, 0),
          merchantCount,
          transactions
        });
      }
    }
    return choices;
  }

  function isBetter(candidate, previous) {
    if (!previous) return true;
    if (candidate.discountCents !== previous.discountCents) return candidate.discountCents > previous.discountCents;
    if (candidate.governmentCount !== previous.governmentCount) return candidate.governmentCount > previous.governmentCount;
    if (candidate.transactions.length !== previous.transactions.length) return candidate.transactions.length < previous.transactions.length;
    return candidate.costCents < previous.costCents;
  }

  function keepBest(states, candidate) {
    const key = `${candidate.costCents}|${candidate.merchantCount}`;
    const old = states.get(key);
    if (isBetter(candidate, old)) states.set(key, candidate);
  }

  function normalizeFallbackWallet(fallbackWallet) {
    return {
      member: String(fallbackWallet && fallbackWallet.member || '自選家人'),
      payment: String(fallbackWallet && fallbackWallet.payment || '商戶支援的支付方式')
    };
  }

  function optimizeRemaining(amount, governmentEntries, merchantStock = [], requireMerchant = false, fallbackWallet = null) {
    const budgetCents = toCents(amount);
    if (!Number.isFinite(budgetCents) || budgetCents < 0) return null;
    const stock = Array.isArray(merchantStock) ? merchantStock.filter(validMerchantCoupon) : [];
    const fallback = normalizeFallbackWallet(fallbackWallet);
    const walletKey = (member, payment) => `${String(member || '').trim()}\u001f${String(payment || '').trim()}`;
    const merchantStockByWallet = new Map();
    for (const coupon of stock) {
      const member = String(coupon.member || fallback.member).trim();
      const payment = String(coupon.payment || '').trim();
      const key = walletKey(member, payment);
      if (!merchantStockByWallet.has(key)) merchantStockByWallet.set(key, []);
      merchantStockByWallet.get(key).push(coupon);
    }
    const governmentGroupsByWallet = new Map();
    for (const group of groupGovernmentCoupons(governmentEntries)) {
      const key = walletKey(group.member, group.payment);
      if (!governmentGroupsByWallet.has(key)) governmentGroupsByWallet.set(key, []);
      governmentGroupsByWallet.get(key).push(group);
    }
    const walletOrder = [...new Set([...governmentGroupsByWallet.keys(), ...merchantStockByWallet.keys()])];
    let states = new Map([['0|0', {
      costCents: 0,
      discountCents: 0,
      governmentCount: 0,
      merchantCount: 0,
      transactions: []
    }]]);

    for (const wallet of walletOrder) {
      const paymentStock = merchantStockByWallet.get(wallet) || [];
      const governmentGroups = governmentGroupsByWallet.get(wallet) || [];
      const payment = String(governmentGroups[0]?.payment || paymentStock[0]?.payment || '').trim();
      const merchantLimit = Math.min(paymentStock.length, Math.floor(budgetCents / MERCHANT_MIN_CENTS));
      let paymentStates = new Map([['0|0', {
        costCents: 0,
        discountCents: 0,
        governmentCount: 0,
        merchantCount: 0,
        transactions: []
      }]]);

      for (const group of governmentGroups) {
        const choices = groupChoices(group, merchantLimit);
        const next = new Map(paymentStates);
        for (const state of paymentStates.values()) {
          for (const choice of choices) {
            const costCents = state.costCents + choice.costCents;
            const merchantCount = state.merchantCount + choice.merchantCount;
            if (costCents > budgetCents || merchantCount > merchantLimit) continue;
            keepBest(next, {
              costCents,
              discountCents: state.discountCents + choice.discountCents,
              governmentCount: state.governmentCount + choice.governmentCount,
              merchantCount,
              transactions: [...state.transactions, ...choice.transactions]
            });
          }
        }
        paymentStates = next;
      }

      const paymentOptions = new Map();
      for (const state of paymentStates.values()) {
        let usedIndex = 0;
        const assignedTransactions = state.transactions.map(transaction => {
          if (!transaction.usesMerchant) return transaction;
          const coupon = paymentStock[usedIndex++];
          return { ...transaction, merchantCoupon: coupon };
        });
        const maxStandalone = Math.min(
          merchantLimit - usedIndex,
          Math.floor((budgetCents - state.costCents) / MERCHANT_MIN_CENTS)
        );
        for (let count = 0; count <= maxStandalone; count++) {
          const merchantTransactions = Array.from({ length: count }, (_, index) => {
            const coupon = paymentStock[usedIndex + index];
            return {
              member: String(coupon.member || fallback.member),
              payment,
              governmentCoupons: [],
              governmentAmountCents: 0,
              governmentThresholdCents: 0,
              minSpendCents: MERCHANT_MIN_CENTS,
              usesMerchant: true,
              merchantOnly: true,
              merchantCoupon: coupon
            };
          });
          keepBest(paymentOptions, {
            costCents: state.costCents + count * MERCHANT_MIN_CENTS,
            discountCents: state.discountCents + count * MERCHANT_DISCOUNT_CENTS,
            governmentCount: state.governmentCount,
            merchantCount: usedIndex + count,
            transactions: [...assignedTransactions, ...merchantTransactions]
          });
        }
      }

      const nextStates = new Map();
      for (const state of states.values()) {
        for (const choice of paymentOptions.values()) {
          const costCents = state.costCents + choice.costCents;
          if (costCents > budgetCents) continue;
          keepBest(nextStates, {
            costCents,
            discountCents: state.discountCents + choice.discountCents,
            governmentCount: state.governmentCount + choice.governmentCount,
            merchantCount: state.merchantCount + choice.merchantCount,
            transactions: [...state.transactions, ...choice.transactions]
          });
        }
      }
      states = nextStates;
    }

    let best = null;
    for (const state of states.values()) {
      if (requireMerchant && state.merchantCount === 0) continue;
      if (isBetter(state, best)) best = state;
    }
    if (!best) return null;

    const transactions = best.transactions.map(transaction => ({
      member: transaction.member,
      payment: transaction.payment,
      governmentCoupons: transaction.governmentCoupons,
      governmentAmount: fromCents(transaction.governmentAmountCents),
      governmentThreshold: fromCents(transaction.governmentThresholdCents),
      minSpend: fromCents(transaction.minSpendCents),
      spend: fromCents(transaction.minSpendCents),
      base: fromCents(transaction.minSpendCents - (transaction.usesMerchant ? MERCHANT_DISCOUNT_CENTS : 0)),
      pay: fromCents(transaction.minSpendCents - transaction.governmentAmountCents - (transaction.usesMerchant ? MERCHANT_DISCOUNT_CENTS : 0)),
      merchantDiscount: transaction.usesMerchant ? 12 : 0,
      usesMerchant: transaction.usesMerchant,
      merchantOnly: transaction.merchantOnly,
      merchantCoupon: transaction.merchantCoupon || null
    }));

    const usedMerchantCoupons = transactions
      .filter(transaction => transaction.usesMerchant && transaction.merchantCoupon)
      .map(transaction => transaction.merchantCoupon);

    const leftoverCents = Math.max(0, budgetCents - best.costCents);
    if (transactions.length && leftoverCents > 0) {
      const extra = fromCents(leftoverCents);
      transactions[0].spend += extra;
      transactions[0].base += extra;
      transactions[0].pay += extra;
    }

    const usedGovernmentCoupons = transactions.flatMap(transaction => transaction.governmentCoupons);
    const usedGov = new Set(usedGovernmentCoupons);
    const usedMerchant = new Set(usedMerchantCoupons);
    const governmentCoupons = (governmentEntries || []).filter(validGovernmentCoupon);
    const availableMerchantCoupons = stock;
    const totalDiscountCents = best.discountCents;
    return {
      amount: fromCents(budgetCents),
      discount: fromCents(totalDiscountCents),
      governmentDiscount: fromCents(totalDiscountCents - best.merchantCount * MERCHANT_DISCOUNT_CENTS),
      merchantDiscount: fromCents(best.merchantCount * MERCHANT_DISCOUNT_CENTS),
      merchantUsedCount: best.merchantCount,
      totalPay: fromCents(budgetCents - totalDiscountCents),
      allocatedSpend: fromCents(best.costCents),
      unallocatedSpend: transactions.length ? 0 : fromCents(budgetCents),
      exactMatch: totalDiscountCents > 0 && leftoverCents === 0,
      transactions,
      usedGovernmentCoupons,
      usedMerchantCoupons,
      usedCouponIds: [...usedGovernmentCoupons, ...usedMerchantCoupons].map(coupon => coupon.id).filter(Boolean),
      unusedCoupons: governmentCoupons.filter(coupon => !usedGov.has(coupon)),
      unusedMerchantCoupons: availableMerchantCoupons.filter(coupon => !usedMerchant.has(coupon)),
      governmentCount: best.governmentCount
    };
  }

  function nextGovernmentCoupon(option, eligibleCoupons) {
    const unused = (eligibleCoupons || []).filter(validGovernmentCoupon)
      .filter(coupon => option.unusedCoupons.includes(coupon));
    if (!unused.length) return null;
    const budgetCents = toCents(option.amount);
    const allocatedCents = toCents(option.allocatedSpend);
    let best = null;

    for (const coupon of unused) {
      const faceCents = Number(coupon.amount) * CENTS;
      const sameWalletTransactions = option.transactions.filter(transaction =>
        transaction.member === coupon.member && transaction.payment === coupon.payment
      );
      for (const transaction of sameWalletTransactions) {
        const currentVoucherFaceCents = (transaction.governmentCoupons || []).map(existing => Number(existing.amount) * CENTS);
        const targetGovCents = [...currentVoucherFaceCents, faceCents].reduce((sum, amount) => sum + amount * 3, 0);
        const targetSpendCents = transaction.usesMerchant
          ? Math.max(MERCHANT_MIN_CENTS, targetGovCents + MERCHANT_DISCOUNT_CENTS)
          : targetGovCents;
        const targetTotalCents = allocatedCents - toCents(transaction.minSpend) + targetSpendCents;
        const additionalCents = Math.max(0, targetTotalCents - budgetCents);
        const currentNetCents = Number.isFinite(Number(transaction.base))
          ? toCents(transaction.base)
          : Math.max(0, toCents(transaction.spend) - toCents(transaction.merchantDiscount || 0));
        if (!best || additionalCents < best.additionalCents) {
          best = {
            coupon,
            additionalCents,
            currentNetCents,
            governmentThresholdCents: targetGovCents,
            usesMerchant: Boolean(transaction.usesMerchant),
            hasExistingTransaction: true
          };
        }
      }
      const standAloneSpend = faceCents * 3;
      const additionalCents = Math.max(0, allocatedCents + standAloneSpend - budgetCents);
      if (!best || additionalCents < best.additionalCents) {
        best = {
          coupon,
          additionalCents,
          currentNetCents: null,
          governmentThresholdCents: standAloneSpend,
          usesMerchant: false,
          hasExistingTransaction: false
        };
      }
    }
    return best ? {
      coupon: best.coupon,
      additionalSpend: fromCents(best.additionalCents),
      currentNet: best.hasExistingTransaction ? fromCents(best.currentNetCents) : null,
      governmentThreshold: fromCents(best.governmentThresholdCents),
      usesMerchant: best.usesMerchant,
      hasExistingTransaction: best.hasExistingTransaction
    } : null;
  }

  function nextMerchantCoupon(option) {
    const unusedCoupons = option.unusedMerchantCoupons || [];
    if (!unusedCoupons.length) return null;
    const budgetCents = toCents(option.amount);
    const allocatedCents = toCents(option.allocatedSpend);
    let best = null;
    for (const coupon of unusedCoupons) {
      const payment = String(coupon.payment || '').trim();
      let candidate = {
        additionalCents: Math.max(0, allocatedCents + MERCHANT_MIN_CENTS - budgetCents),
        transaction: null
      };
      for (const transaction of option.transactions) {
        if (transaction.usesMerchant || transaction.member !== coupon.member || transaction.payment !== payment) continue;
        const targetSpendCents = Math.max(
          MERCHANT_MIN_CENTS,
          toCents(transaction.governmentThreshold) + MERCHANT_DISCOUNT_CENTS
        );
        const targetTotalCents = allocatedCents - toCents(transaction.minSpend) + targetSpendCents;
        const additionalCents = Math.max(0, targetTotalCents - budgetCents);
        if (additionalCents < candidate.additionalCents) candidate = { additionalCents, transaction };
      }
      if (!best || candidate.additionalCents < best.additionalCents) {
        best = { coupon, ...candidate };
      }
    }
    if (!best) return null;
    const transaction = best.transaction;
    const currentNetCents = transaction
      ? (Number.isFinite(Number(transaction.base))
        ? toCents(transaction.base)
        : Math.max(0, toCents(transaction.spend) - toCents(transaction.merchantDiscount || 0)))
      : null;
    return {
      coupon: best.coupon,
      additionalSpend: fromCents(best.additionalCents),
      projectedNetAfterMerchant: currentNetCents === null
        ? null
        : fromCents(Math.max(0, currentNetCents - MERCHANT_DISCOUNT_CENTS)),
      governmentThreshold: transaction ? Number(transaction.governmentThreshold) || 0 : 0,
      governmentCoupons: transaction ? transaction.governmentCoupons || [] : []
    };
  }

  function planHousehold(total, firstSpend, entries, options = {}) {
    const totalCents = toCents(total);
    const firstCents = toCents(firstSpend);
    const valid = Number.isFinite(totalCents) && Number.isFinite(firstCents) && totalCents >= 0 &&
      firstCents >= 0 && firstCents <= totalCents;
    if (!valid) return { valid: false, total: Number(total), firstSpend: Number(firstSpend), remaining: 0, plans: [] };

    const selectedMembers = Array.isArray(options.selectedMembers) ? new Set(options.selectedMembers) : null;
    const selectedPayments = Array.isArray(options.selectedPayments) ? new Set(options.selectedPayments) : null;
    const scopedEntries = (entries || []).filter(coupon =>
      (!selectedMembers || selectedMembers.has(coupon.member)) &&
      (!selectedPayments || selectedPayments.has(coupon.payment))
    );
    const governmentCoupons = scopedEntries.filter(validGovernmentCoupon);
    const merchantCoupons = scopedEntries.filter(validMerchantCoupon);
    const giftCoupons = scopedEntries.filter(coupon => coupon && coupon.type === 'gift' && !coupon.used);
    const remaining = fromCents(totalCents - firstCents);
    const fallbackWallet = options.fallbackWallet || null;
    const noMerchant = optimizeRemaining(remaining, governmentCoupons, [], false, fallbackWallet);
    const plans = [];

    if (options.merchantAvailable && merchantCoupons.length) {
      const withMerchant = optimizeRemaining(remaining, governmentCoupons, merchantCoupons, true, fallbackWallet);
      if (withMerchant) {
        withMerchant.label = '使用商戶滿減券';
        withMerchant.merchantScenario = true;
        withMerchant.nextCoupon = nextGovernmentCoupon(withMerchant, governmentCoupons);
        withMerchant.nextMerchant = nextMerchantCoupon(withMerchant);
        plans.push(withMerchant);
      }
    }

    noMerchant.label = merchantCoupons.length && options.merchantAvailable ? '保留／不使用商戶滿減券' : '不使用商戶滿減券';
    noMerchant.merchantScenario = false;
    noMerchant.unusedMerchantCoupons = merchantCoupons;
    noMerchant.nextCoupon = nextGovernmentCoupon(noMerchant, governmentCoupons);
    noMerchant.nextMerchant = options.merchantAvailable ? nextMerchantCoupon(noMerchant) : null;
    plans.push(noMerchant);

    for (const option of plans) {
      option.totalPay += fromCents(firstCents);
      option.unusedGiftCoupons = giftCoupons;
    }
    plans.sort((a, b) => a.totalPay - b.totalPay || a.merchantUsedCount - b.merchantUsedCount || a.transactions.length - b.transactions.length);
    const lowestPayPlan = plans[0] || null;

    return {
      valid: true,
      total: fromCents(totalCents),
      firstSpend: fromCents(firstCents),
      remaining,
      selectedMembers: selectedMembers ? [...selectedMembers] : null,
      selectedPayments: selectedPayments ? [...selectedPayments] : null,
      merchantAvailableCount: merchantCoupons.length,
      giftAvailableCount: giftCoupons.length,
      plans: lowestPayPlan ? [lowestPayPlan] : []
    };
  }

  function calculateWalletSpendScenarios(walletCoupons, expired = false) {
    const coupons = Array.isArray(walletCoupons) ? walletCoupons : Object.values(walletCoupons || {});
    const governmentCoupons = coupons.filter(coupon => coupon && coupon.type === 'gov' && GOV_DENOMINATIONS.has(Number(coupon.amount)));
    const merchantCoupons = coupons.filter(coupon => coupon && coupon.type === 'merchant' && String(coupon.payment || '').trim());
    const governmentAwardedCents = governmentCoupons.reduce((sum, coupon) => sum + Number(coupon.amount) * CENTS, 0);
    const governmentUsedCents = governmentCoupons.filter(coupon => coupon.used).reduce((sum, coupon) => sum + Number(coupon.amount) * CENTS, 0);
    const governmentUnredeemedCents = governmentCoupons.filter(coupon => !coupon.used).reduce((sum, coupon) => sum + Number(coupon.amount) * CENTS, 0);
    const merchantUnredeemedCount = merchantCoupons.filter(coupon => !coupon.used).length;
    const governmentAvailableAmounts = expired ? [] : governmentCoupons.filter(coupon => !coupon.used)
      .map(coupon => Number(coupon.amount)).sort((a, b) => b - a);
    const governmentAvailableCents = expired ? 0 : governmentUnredeemedCents;
    const merchantAvailableCount = expired ? 0 : merchantUnredeemedCount;
    // Largest-first sequential eligibility consumes 3x each available voucher's face value.
    const governmentThresholdCents = governmentAvailableAmounts.reduce((sum, amount) => sum + amount * CENTS * 3, 0);
    const noMerchant = governmentAvailableCents > 0
      ? {
          requiredGrossSpendCents: governmentThresholdCents,
          merchantDiscountCents: 0,
          netBeforeGovernmentCents: governmentThresholdCents,
          governmentDiscountCents: governmentAvailableCents,
          governmentThresholdCents,
          governmentOrderNetBeforeGovernmentCents: governmentThresholdCents,
          outOfPocketCents: governmentThresholdCents - governmentAvailableCents
        }
      : null;
    let withMerchant = null;
    if (merchantAvailableCount > 0) {
      const requiredGrossSpendCents = Math.max(MERCHANT_MIN_CENTS, governmentThresholdCents + MERCHANT_DISCOUNT_CENTS);
      const merchantDiscountCents = MERCHANT_DISCOUNT_CENTS;
      const netBeforeGovernmentCents = requiredGrossSpendCents - merchantDiscountCents;
      withMerchant = {
        requiredGrossSpendCents,
        merchantDiscountCents,
        netBeforeGovernmentCents,
        governmentDiscountCents: governmentAvailableCents,
        governmentThresholdCents,
        governmentOrderSpendCents: requiredGrossSpendCents,
        governmentOrderNetBeforeGovernmentCents: netBeforeGovernmentCents,
        outOfPocketCents: netBeforeGovernmentCents - governmentAvailableCents
      };
    }
    return {
      governmentAwardedCents,
      governmentUsedCents,
      governmentUnredeemedCents,
      governmentAvailableCents,
      merchantAwardedCount: merchantCoupons.length,
      merchantUsedCount: merchantCoupons.filter(coupon => coupon.used).length,
      merchantUnredeemedCount,
      merchantAvailableCount,
      governmentAvailableAmounts,
      withoutMerchant: noMerchant,
      withMerchant
    };
  }

  const api = { redemptionEntries, planHousehold, optimizeRemaining, groupChoices, nextGovernmentCoupon, nextMerchantCoupon, summarizeActualSpend, summarizeDashboard, macauDateKey, estimateMissingTransactionAmounts, estimateUnusedGovernmentSpend, filterWalletRedemptions, validateRedemptionThresholds, calculateWalletSpendScenarios };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ConsumeCalc = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

(() => {
      'use strict';
      if (typeof document === 'undefined') return;

      const CONFIG = {
        apiKey: 'AIzaSyCJY3vzA7xuC-bC6PLGk5wGAe_rjPMP4w4',
        authDomain: 'testing-a7aba.firebaseapp.com',
        databaseURL: 'https://testing-a7aba-default-rtdb.firebaseio.com/',
        projectId: 'testing-a7aba',
        appId: '1:94291975544:web:1fc1e0aff39d8fd0357c8d'
      };
      const MEMBERS = ['爸爸', '媽媽', '姐姐', '昌哥', '妹妹'];
      const WALLETS = ['MPay', '中銀', '工銀', '大豐', '國際', '支付寶', 'UEPay', '廣發'];
      const RESULT_TYPES = ['gov', 'zero', 'merchant', 'gift'];
      const GOV_AMOUNTS = [10, 20, 50, 100, 200];
      // UTC calendar anchors are paired with Macau's current date key, so a
      // visitor's device time zone cannot change week boundaries.
      const CAMPAIGN_START = new Date(Date.UTC(2026, 9, 9, 12));
      const CAMPAIGN_END = new Date(Date.UTC(2026, 11, 17, 12));
      const DEFAULT_WALLETS = {
        爸爸: { MPay: true },
        媽媽: { MPay: true, 中銀: true, 工銀: true, 大豐: true, 國際: true },
        姐姐: { MPay: true, 中銀: true, 工銀: true, 大豐: true, 支付寶: true, UEPay: true },
        昌哥: { MPay: true, 中銀: true, 工銀: true, 支付寶: true, UEPay: true },
        妹妹: { MPay: true, 中銀: true, 工銀: true, 國際: true, 支付寶: true, UEPay: true }
      };
      const WEEKS = (() => {
        const weeks = [];
        let start = new Date(CAMPAIGN_START);
        while (start <= CAMPAIGN_END) {
          const end = new Date(start);
          end.setUTCDate(end.getUTCDate() + 6);
          if (end > CAMPAIGN_END) end.setTime(CAMPAIGN_END.getTime());
          const index = weeks.length;
          weeks.push({
            key: `2026R2-W${index + 1}`,
            start,
            end,
            label: `第 ${index + 1} 週（${start.getUTCMonth() + 1}/${start.getUTCDate()}–${end.getUTCMonth() + 1}/${end.getUTCDate()}）`
          });
          start = new Date(start);
          start.setUTCDate(start.getUTCDate() + 7);
        }
        return weeks;
      })();
      const $ = id => document.getElementById(id);
      const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
      })[character]);
      const CENTS = 100;
      const toCents = value => {
        const amount = Number(value);
        return Number.isFinite(amount) ? Math.round((amount + Number.EPSILON) * CENTS) : NaN;
      };
      const formatMop = value => {
        const amount = Math.round((Number(value) + Number.EPSILON) * 100) / 100;
        return new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(amount);
      };
      const localDateKey = date => date.toISOString().slice(0, 10);

      let database = null;
      let weekReference = null;
      let settingsReference = null;
      const walletSaveQueues = Object.create(null);
      let online = false;
      let currentWeek = WEEKS[0].key;
      let coupons = Object.create(null);
      let pendingRedemption = null;
      let expandedWallet = null;
      const expandedMembers = new Set(['爸爸']);
      let pendingCorrection = null;
      const undoingTransactions = new Set();
      let pendingWalletRedemption = null;
      const walletPlanRedemptionContexts = new Map();
      let walletPlanRedemptionSequence = 0;
      let walletPlanReturnFocus = null;
      let walletPlanTransitioning = false;
      let localData = Object.create(null);
      let walletConfig = cloneDefaultWallets();
      let selectedCalcMembers = [...MEMBERS];
      let selectedCalcPayments = [...WALLETS];
      let selectedVaultMembers = [...MEMBERS];
      let slotSelections = [null, null, null];
      let allPeriodData = null;
      let allPeriodStatsLoading = false;
      let allPeriodStatsError = '';
      let allPeriodRequestId = 0;
      let lastCalculatedPlan = null;
      let hasCalculatedResult = false;
      let calcMode = 'shopping';
      const cacheKey = 'macau-consume-2026r2-household';
      const settingsPath = 'campaigns/2026R2/settings/wallets';
      const weekPath = () => `campaigns/2026R2/weeks/${currentWeek}`;

      function cloneDefaultWallets() {
        return Object.fromEntries(MEMBERS.map(member => [
          member,
          Object.fromEntries(WALLETS.map(wallet => [wallet, Boolean(DEFAULT_WALLETS[member]?.[wallet])]))
        ]));
      }

      function sanitizeWallets(value) {
        const safe = cloneDefaultWallets();
        if (!value || typeof value !== 'object' || Array.isArray(value)) return safe;
        for (const member of MEMBERS) {
          const row = value[member];
          if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
          for (const wallet of WALLETS) {
            if (typeof row[wallet] === 'boolean') safe[member][wallet] = row[wallet];
          }
        }
        return safe;
      }

      function sanitizeCoupons(value) {
        const safe = Object.create(null);
        if (!value || typeof value !== 'object' || Array.isArray(value)) return safe;
        for (const [id, row] of Object.entries(value)) {
          if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) continue;
          if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
          if (!RESULT_TYPES.includes(row.type) || !MEMBERS.includes(row.member) || !WALLETS.includes(row.payment) || typeof row.used !== 'boolean') continue;
          const coupon = { ...row, type: row.type, member: row.member, payment: row.payment, used: row.used };
          if (row.type === 'gov') {
            const amount = Number(row.amount);
            if (!GOV_AMOUNTS.includes(amount)) continue;
            coupon.amount = amount;
          } else if (row.type === 'merchant') {
            coupon.amount = 12;
          } else if (row.type === 'gift') {
            coupon.label = String(row.label || '消費禮遇券').slice(0, 80);
          }
          if (Number.isFinite(Number(row.createdAt))) coupon.createdAt = Number(row.createdAt);
          if (row.usedAt === null || Number.isFinite(Number(row.usedAt))) coupon.usedAt = row.usedAt;
          const redemption = row.redemption;
          if (redemption && typeof redemption === 'object' && !Array.isArray(redemption)) {
            coupon.redemption = { ...redemption };
            for (const field of ['actualPaidCents', 'actualSpendCents', 'estimatedPaidCents', 'estimatedSpendCents']) {
              const value = redemption[field];
              if (value === null || value === undefined || String(value).trim() === '' || !Number.isInteger(Number(value)) || Number(value) < 0) delete coupon.redemption[field];
              else coupon.redemption[field] = Number(value);
            }
          }
          safe[id] = coupon;
        }
        return safe;
      }

      function showToast(message) {
        $('toast').textContent = message;
        $('toast').classList.remove('hidden');
        clearTimeout(showToast.timer);
        showToast.timer = setTimeout(() => $('toast').classList.add('hidden'), 2600);
      }

      function isDrawn(member, payment) {
        return Object.values(coupons).some(coupon => coupon.member === member && coupon.payment === payment);
      }

      function activeWallets(member) {
        return WALLETS.filter(wallet => walletConfig[member]?.[wallet]);
      }

      function allWalletEntries() {
        return Object.entries(coupons)
          .map(([id, coupon]) => ({ ...coupon, id }))
          .filter(coupon => walletConfig[coupon.member]?.[coupon.payment])
          .filter(() => !isWeekExpired(currentWeek));
      }

      function fillSelect(id, values, selected) {
        const node = $(id);
        node.innerHTML = values.map(item => `<option value="${escapeHtml(item.value)}">${escapeHtml(item.label)}</option>`).join('');
        if (selected && values.some(item => item.value === selected)) node.value = selected;
      }

      function fillMemberSelects() {
        for (const id of ['recordMember']) {
          const oldValue = $(id).value;
          fillSelect(id, MEMBERS.map(member => ({ value: member, label: member })), oldValue);
        }
      }

      function setWalletOptions(id, member, preferred) {
        const available = activeWallets(member);
        fillSelect(id, available.map(wallet => ({ value: wallet, label: wallet })), preferred);
        $(id).disabled = !available.length;
        if (!available.length) $(id).innerHTML = '<option value="">請先在家庭支付設定啟用方式</option>';
      }

      function saveLocal() {
        localData[currentWeek] = { coupons };
        try {
          localStorage.setItem(cacheKey, JSON.stringify(localData));
        } catch {
          showToast('本機儲存空間不足，請先匯出備份。');
        }
      }

      function saveLocalWallets() {
        try {
          localStorage.setItem(`${cacheKey}:wallets`, JSON.stringify(walletConfig));
        } catch {
          showToast('本機儲存空間不足，請先匯出家庭設定。');
        }
      }

      function loadLocal() {
        try {
          const saved = JSON.parse(localStorage.getItem(cacheKey) || '{}');
          localData = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : Object.create(null);
        } catch {
          localData = Object.create(null);
        }
        try {
          const savedWallets = JSON.parse(localStorage.getItem(`${cacheKey}:wallets`) || 'null');
          if (savedWallets) walletConfig = sanitizeWallets(savedWallets);
        } catch {
          walletConfig = cloneDefaultWallets();
        }
      }

      function render() {
        renderSelectors();
        renderWeekExpiry();
        renderCalcMemberFilter();
        renderCalcPaymentFilter();
        renderVaultMemberFilter();
        renderWalletPlanFilters();
        renderDrawStates();
        renderWalletSpendPlans();
        renderRegistrationStatus();
        renderWalletSettings();
        renderCouponVault();
        renderFunStats();
        renderCalc();
      }

      function renderSelectors() {
        const recordMember = $('recordMember').value || MEMBERS[0];
        const recordWallet = $('recordWallet').value;
        fillMemberSelects();
        setWalletOptions('recordWallet', recordMember, recordWallet);
        if (!$('recordWallet').value && activeWallets(recordMember).length) $('recordWallet').value = activeWallets(recordMember)[0];
      }

      function renderWalletPlanFilters() {
        const selectedMember = $('walletPlanMemberFilter').value || 'all';
        const selectedPayment = $('walletPlanPaymentFilter').value || 'all';
        fillSelect('walletPlanMemberFilter', [{ value: 'all', label: '全家' }, ...MEMBERS.map(member => ({ value: member, label: member }))], selectedMember);
        fillSelect('walletPlanPaymentFilter', [{ value: 'all', label: '全部支付方式' }, ...WALLETS.map(payment => ({ value: payment, label: payment }))], selectedPayment);
      }

      function renderMemberChips(containerId, selectedMembers, dataAttribute) {
        const allSelected = selectedMembers.length === MEMBERS.length;
        const buttons = [{ value: 'all', label: '全家', selected: allSelected }]
          .concat(MEMBERS.map(member => ({
            value: member,
            label: member,
            selected: !allSelected && selectedMembers.includes(member)
          })));
        $(containerId).innerHTML = buttons.map(button =>
          `<button class="filter-chip" type="button" data-${dataAttribute}="${escapeHtml(button.value)}" aria-pressed="${button.selected}">${escapeHtml(button.label)}</button>`
        ).join('');
      }

      function renderCalcMemberFilter() {
        renderCalcSelection('calcMemberFilter', selectedCalcMembers, MEMBERS, 'member');
      }

      function renderCalcPaymentFilter() {
        renderCalcSelection('calcPaymentFilter', selectedCalcPayments, WALLETS, 'payment');
      }

      function renderCalcSelection(containerId, selectedValues, choices, kind) {
        const allSelected = selectedValues.length === choices.length;
        const attribute = `data-calc-${kind}`;
        $(containerId).innerHTML = `<div class="filter-actions">
          <button class="filter-action" type="button" data-calc-filter-action="${kind}" data-selection="all" aria-pressed="${allSelected}">全選</button>
          <button class="filter-action" type="button" data-calc-filter-action="${kind}" data-selection="clear" aria-pressed="${selectedValues.length === 0}">清除</button>
          <span class="selection-count">${allSelected ? `已選全部 ${choices.length} 項` : `已選 ${selectedValues.length}／${choices.length} 項`}</span>
        </div>
        <div class="filter-chips">${choices.map(choice =>
          `<button class="filter-chip" type="button" ${attribute}="${escapeHtml(choice)}" aria-pressed="${selectedValues.includes(choice)}">${escapeHtml(choice)}</button>`
        ).join('')}</div>`;
      }

      function toggleCalcSelection(currentSelection, choice, choices) {
        if (currentSelection.length === choices.length) return [choice];
        const next = currentSelection.includes(choice)
          ? currentSelection.filter(item => item !== choice)
          : [...currentSelection, choice];
        return choices.filter(item => next.includes(item));
      }

      function updateCalcSelection(kind, selection) {
        const choices = kind === 'member' ? MEMBERS : WALLETS;
        const next = selection === 'all' ? [...choices] : [];
        if (kind === 'member') selectedCalcMembers = next;
        else selectedCalcPayments = next;
        renderCalcMemberFilter();
        renderCalcPaymentFilter();
        renderCalc();
      }

      function renderVaultMemberFilter() {
        renderMemberChips('vaultMemberFilter', selectedVaultMembers, 'vault-member');
      }

      function selectMembers(currentSelection, member) {
        if (member === 'all') return [...MEMBERS];
        if (currentSelection.length === MEMBERS.length) return [member];
        const next = currentSelection.includes(member)
          ? currentSelection.filter(item => item !== member)
          : [...currentSelection, member];
        if (!next.length) {
          showToast('至少保留一位家人；如要恢復全部，請選「全家」。');
          return currentSelection;
        }
        return MEMBERS.filter(item => next.includes(item));
      }

      function walletRecords(member, payment) {
        return Object.entries(coupons).filter(([, c]) => c.member === member && (!payment || c.payment === payment)).map(([id, c]) => ({ ...c, id }));
      }

      function recordedTransactions(records) {
        const groups = new Map();
        const week = WEEKS.find(w => w.key === currentWeek);
        for (const c of ConsumeCalc.redemptionEntries(records)) {
          const r = c.redemption || {};
          const date = /^\d{4}-\d{2}-\d{2}$/.test(r.date || '') ? r.date : c.usedAt ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Macau', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(c.usedAt)) : '';
          if (date && week && (date < localDateKey(week.start) || date > localDateKey(week.end))) continue;
          const key = `${c.member}|${c.payment}|${r.transactionId || (c.usedAt ? `legacy-${c.usedAt}` : `legacy-${r.date || ''}-${r.actualPaidCents ?? c.id}`)}`;
          if (!groups.has(key)) groups.set(key, { member: c.member, payment: c.payment, rows: [], redemption: r, undone: Boolean(r.undoAudit) });
          groups.get(key).rows.push(c);
        }
        return [...groups.values()];
      }

      function recordedAmount(records, field, compact = false) {
        const transactions = recordedTransactions(records);
        let sum = 0, known = 0, missing = false;
        for (const t of transactions) {
          const values = t.rows.map(c => c.redemption?.[field]);
          if (t.undone && values.every(v => v === null || v === undefined || (typeof v === 'string' && v.trim() === ''))) continue;
          const value = values[0];
          if (Number.isInteger(value) && value >= 0 && values.every(v => v === value)) { sum += value; known++; }
          else missing = true;
        }
        if (!known) return '未記錄';
        return `${compact ? '' : 'MOP '}${formatMop(sum / CENTS)}${missing ? '＋未記錄' : ''}`;
      }

      function transactionAmountLabel(t, field) {
        const raw = t.rows.map(c => c.redemption?.[field]);
        const valid = raw.filter(v => Number.isInteger(v) && v >= 0);
        if (valid.length) return valid.every(v => v === valid[0]) ? `MOP ${formatMop(valid[0] / CENTS)}` : '實際金額不一致';
        const missing = raw.every(v => v === null || v === undefined || (typeof v === 'string' && v.trim() === ''));
        const estimate = !t.undone && missing ? ConsumeCalc.estimateMissingTransactionAmounts(t.rows).transactions[0] : null;
        const value = estimate?.[field === 'actualSpendCents' ? 'estimatedSpendCents' : 'estimatedPaidCents'];
        return Number.isInteger(value) ? `估算 MOP ${formatMop(value / CENTS)}` : '未記錄';
      }
      function transactionRecordMarkup(t) {
        const { member, payment } = t; const r = t.redemption; const estimated = r.amountKind === 'estimate';
        const validTransactionId = typeof r.transactionId === 'string' && Boolean(r.transactionId.trim());
        const canUndo = !isWeekExpired(currentWeek) && validTransactionId && !t.undone && t.rows.every(c => coupons[c.id]?.used && coupons[c.id]?.redemption?.transactionId === r.transactionId);
        return `<div class="transaction-record"><span>交易記錄：支出 ${transactionAmountLabel(t, 'actualSpendCents')}／實付 ${transactionAmountLabel(t, 'actualPaidCents')}</span>${!t.undone ? '<small>估算為非實際金額，不計入已記錄金額。</small>' : ''}${t.undone ? `<strong class="restored-marker">${estimated ? '已復原（估算已取消）' : '已復原（保留金融紀錄）'}</strong>` : ''}${!isWeekExpired(currentWeek) && validTransactionId && t.undone && !estimated ? `<button type="button" class="text-button" data-correct-transaction="${escapeHtml(r.transactionId)}" data-member="${escapeHtml(member)}" data-payment="${escapeHtml(payment)}">更正實際金額</button>` : ''}${canUndo ? `<details class="transaction-actions"><summary>復原或更正此筆交易</summary><div class="undo-transaction"><span><strong>${escapeHtml(member)}／${escapeHtml(payment)}</strong> · ${t.rows.map(c => escapeHtml(couponName(c))).join('、')}</span><small class="undo-warning">網頁復原不等於支付平台退券或退款；請先核對平台紀錄。</small><button type="button" class="text-button" data-undo-transaction="${escapeHtml(r.transactionId)}" data-member="${escapeHtml(member)}" data-payment="${escapeHtml(payment)}">復原並刪除此筆核銷記錄</button></div><button type="button" class="text-button" data-correct-transaction="${escapeHtml(r.transactionId)}" data-member="${escapeHtml(member)}" data-payment="${escapeHtml(payment)}">更正實際金額</button></details>` : !validTransactionId ? '<small>舊紀錄缺少交易識別，未推算金額</small>' : ''}</div>`;
      }
      function renderDrawStates() {
        const all = Object.entries(coupons).map(([id, coupon]) => ({ ...coupon, id }));
        const week = WEEKS.find(item => item.key === currentWeek);
        const expired = isWeekExpired(currentWeek);
        const summary = ConsumeCalc.summarizeDashboard(all, localDateKey(week.start), localDateKey(week.end), expired);
        const money = cents => `MOP ${formatMop(cents / CENTS)}`;
        const actual = (row, field) => `${money(row[field])}${row.hasMissingActual ? ' · 部分交易未記錄' : ''}`;
        $('memberCompare').innerHTML = !summary.hasResults
          ? `<div class="empty dashboard-empty"><strong>本週尚無登記結果</strong><p>登記完整三次抽獎結果後，可在此查看待用券與實際消費。</p><button class="button" type="button" data-open-registration>前往登記</button></div>`
          : `<div class="dashboard-sections">
              <section class="dashboard-block unused-block" aria-label="未使用的券">
                <div class="dashboard-block-head"><span class="dashboard-kicker">消費前</span><h3>未使用的券</h3></div>
                <p class="dashboard-main"><span>政府電子券面額</span><strong>${money(summary.unusedGovernmentCents)}</strong></p>
                <div class="dashboard-pair"><p><span>最低購物額參考</span><strong>${money(summary.minimumSpendCents)}</strong></p><p><span>預計自付</span><strong>${money(summary.estimatedPayCents)}</strong></p></div>
                <small>估算 · 僅計仍有效的政府券，購物額按面額 × 3；商戶券及禮遇券另計。</small>
              </section>
              <section class="dashboard-block used-block" aria-label="已使用的券">
                <div class="dashboard-block-head"><span class="dashboard-kicker">消費後</span><h3>已使用的券</h3></div>
                <p class="dashboard-main"><span>已記錄實際自付</span><strong>${money(summary.actualPaidCents)}</strong></p>
                <div class="dashboard-pair"><p><span>已記錄實際支出</span><strong>${money(summary.actualSpendCents)}</strong></p><p><span>已知交易折扣</span><strong>${money(summary.discountCents)}</strong></p></div>
                <small>實際記錄 · 同筆多券只計一次。${summary.hasMissingActual ? '<strong class="missing-note">部分交易未記錄金額，以上合計並非全部支出。</strong>' : ''}</small>
              </section>
            </div>`;
        $('walletRedemptionCards').innerHTML = MEMBERS.map(member => {
          const records = all.filter(coupon => coupon.member === member);
          const memberSummary = summary.byMember[member] || { unusedGovernmentCents: 0, actualPaidCents: 0, hasMissingActual: false };
          const wallets = WALLETS.filter(payment => walletConfig[member]?.[payment] || records.some(coupon => coupon.payment === payment));
          return `<details class="member-wallet-section" data-member-group="${escapeHtml(member)}"${expandedMembers.has(member) ? ' open' : ''}><summary class="member-heading"><h3>${escapeHtml(member)}</h3><span>待用 ${money(memberSummary.unusedGovernmentCents)} · 已付 ${actual(memberSummary, 'actualPaidCents')}</span></summary>${wallets.map(payment => {
            const list = records.filter(coupon => coupon.payment === payment);
            const row = summary.byWallet[`${member}|${payment}`] || { unusedGovernmentCents: 0, minimumSpendCents: 0, estimatedPayCents: 0, actualPaidCents: 0, hasMissingActual: false };
            const available = list.filter(coupon => !coupon.used && ['gov', 'merchant', 'gift'].includes(coupon.type));
            const key = `${member}|${payment}`;
            const open = expandedWallet === key;
            const panelId = `wallet-panel-${MEMBERS.indexOf(member)}-${WALLETS.indexOf(payment)}`;
            const status = !list.length ? '未登記' : list.length < 3 ? `不完整 · ${list.length} 項` : list.length > 3 ? `歷史異常 · ${list.length} 項` : expired ? '已到期' : `${available.length} 張未用`;
            const txns = recordedTransactions(list);
            return `<div class="flat-wallet"><button type="button" class="wallet-toggle" data-expand-wallet data-member="${escapeHtml(member)}" data-payment="${escapeHtml(payment)}" aria-expanded="${open}" aria-controls="${panelId}"><span><strong>${escapeHtml(payment)}</strong> <small>${status}</small></span><span>待用 ${money(row.unusedGovernmentCents)}<small>已付 ${actual(row, 'actualPaidCents')}</small></span><span aria-hidden="true">${open ? '−' : '＋'}</span></button><div id="${panelId}" class="wallet-expanded"${open ? '' : ' hidden'}><div class="wallet-figures"><p>最低購物額參考 <strong>${money(row.minimumSpendCents)}</strong></p><p>預計自付 <strong>${money(row.estimatedPayCents)}</strong></p><p>已記錄實際自付 <strong>${actual(row, 'actualPaidCents')}</strong></p></div><div class="flat-coupons">${list.length ? list.map(coupon => `<p>${escapeHtml(couponTypeName(coupon.type))} ${escapeHtml(couponName(coupon))} <strong>${coupon.used ? '已核銷' : expired ? '已過期' : '未使用'}</strong></p>`).join('') : '<p>本週尚未登記結果。</p>'}</div>${available.length && !expired ? `<div class="redemption-card"><span>核對這筆實際交易後儲存</span><button class="button" type="button" data-wallet-redemption data-member="${escapeHtml(member)}" data-payment="${escapeHtml(payment)}">快速核銷</button></div>` : ''}${txns.length ? `<details class="wallet-history"><summary>交易記錄與更正</summary>${txns.map(transactionRecordMarkup).join('')}</details>` : ''}</div></div>`;
          }).join('') || '<p class="hint">尚未啟用支付方式</p>'}</details>`;
        }).join('');
        $('walletRedemptionCards').querySelectorAll('[data-member-group]').forEach(node => node.addEventListener('toggle', () => {
          if (!node.isConnected) return;
          if (node.open) expandedMembers.add(node.dataset.memberGroup);
          else expandedMembers.delete(node.dataset.memberGroup);
        }));
      }

      function resultPill(coupon) {
        const expired = !coupon.used && isWeekExpired(currentWeek);
        const status = coupon.used ? '已核銷' : expired ? '已過期' : '未核銷';
        const stateClass = coupon.used ? 'used' : expired ? 'expired' : '';
        if (coupon.type === 'gov') {
          return `<span class="result-pill gov-pill ${stateClass}">電子 MOP ${formatMop(coupon.amount)} · ${status}</span>`;
        }
        if (coupon.type === 'merchant') return `<span class="result-pill merchant-pill ${stateClass}">商戶 100−12 · ${status}</span>`;
        if (coupon.type === 'gift') return `<span class="result-pill gift-pill ${stateClass}">消費禮遇券 · ${status}</span>`;
        return '<span class="result-pill zero-pill">無券結果（舊記錄）</span>';
      }

      function renderWalletSpendPlans() {
        const expired = isWeekExpired(currentWeek);
        const selectedMember = $('walletPlanMemberFilter').value || 'all';
        const selectedPayment = $('walletPlanPaymentFilter').value || 'all';
        const allRows = MEMBERS.flatMap(member => activeWallets(member).map(payment => {
          const walletCoupons = Object.values(coupons).filter(coupon => coupon.member === member && coupon.payment === payment);
          return { member, payment, ...ConsumeCalc.calculateWalletSpendScenarios(walletCoupons, expired) };
        }));
        const rows = allRows.filter(row =>
          (selectedMember === 'all' || row.member === selectedMember) &&
          (selectedPayment === 'all' || row.payment === selectedPayment)
        );
        const usableWalletCount = rows.filter(row => row.governmentAvailableCents > 0 || row.merchantAvailableCount > 0).length;
        const scope = `${selectedMember === 'all' ? '全家' : selectedMember}／${selectedPayment === 'all' ? '全部支付方式' : selectedPayment}`;
        $('walletPlanSummary').textContent = expired
          ? `${scope}：顯示 ${rows.length}／${allRows.length} 個已啟用錢包；所選週已過期，未核銷券僅供查閱，不能再使用。`
          : `${scope}：顯示 ${rows.length}／${allRows.length} 個已啟用錢包；${usableWalletCount} 個錢包有可用電子券或滿減券。`;
        walletPlanRedemptionContexts.clear();
        if (!rows.length) {
          $('walletSpendPlanTable').innerHTML = '<p class="wallet-plan-empty">目前篩選沒有符合的已啟用支付方式；請改選「全家」或「全部支付方式」。</p>';
          return;
        }
        const money = cents => `MOP ${formatMop(cents / CENTS)}`;
        const scenarioMarkup = (row, scenario, title, includeMerchant, governmentIds, merchantId) => {
          const selectedCouponIds = [...governmentIds];
          if (includeMerchant && merchantId) selectedCouponIds.push(merchantId);
          const contextId = `wallet-plan-redemption-${walletPlanRedemptionSequence++}`;
          walletPlanRedemptionContexts.set(contextId, {
            member: row.member,
            payment: row.payment,
            scenarioTitle: title,
            couponIds: selectedCouponIds,
            minimumGrossSpendCents: scenario.requiredGrossSpendCents,
            prefillPayCents: scenario.outOfPocketCents
          });
          const ariaLabel = `直接核銷：${row.member}／${row.payment}，${title}，最低原始消費額 ${money(scenario.requiredGrossSpendCents)}`;
          return `<section class="wallet-plan-scenario"><h4>${title}</h4><div class="wallet-plan-values"><div class="wallet-plan-minimum-value"><div><span>最低原始消費額</span><strong>${money(scenario.requiredGrossSpendCents)}</strong></div><button type="button" class="button secondary wallet-plan-redemption-button" data-wallet-plan-redemption="${contextId}" aria-haspopup="dialog" aria-label="${escapeHtml(ariaLabel)}">直接核銷</button></div><div class="wallet-plan-outlay"><span>估算自付</span><strong>${money(scenario.outOfPocketCents)}</strong></div></div></section>`;
        };
        $('walletSpendPlanTable').innerHTML = `<div class="wallet-plan-list">${rows.map(row => {
          const hasGovernmentPlan = Boolean(row.withoutMerchant);
          const hasMerchantPlan = Boolean(row.withMerchant);
          const scenarioCount = Number(hasGovernmentPlan) + Number(hasMerchantPlan);
          const walletEntries = Object.entries(coupons).filter(([, coupon]) => coupon.member === row.member && coupon.payment === row.payment && !coupon.used && (coupon.type === 'merchant' || (coupon.type === 'gov' && [10, 20, 50, 100, 200].includes(Number(coupon.amount)))));
          const governmentIds = walletEntries.filter(([, coupon]) => coupon.type === 'gov')
            .sort((a, b) => Number(b[1].amount) - Number(a[1].amount) || String(a[0]).localeCompare(String(b[0])))
            .map(([id]) => id);
          const merchantId = walletEntries.find(([, coupon]) => coupon.type === 'merchant')?.[0] || '';
          const walletNote = row.merchantAvailableCount > 1
            ? `<p class="wallet-plan-merchant-note">可用滿減券 ${row.merchantAvailableCount} 張；以下只計一筆交易使用一張，其餘券須另開交易。</p>`
            : '';
          const emptyMessage = scenarioCount
            ? ''
            : expired && (row.governmentUnredeemedCents > 0 || row.merchantUnredeemedCount > 0)
              ? '<p class="wallet-plan-empty-row">所選週已過期，券只供查閱，不能再使用。</p>'
              : '<p class="wallet-plan-empty-row">本錢包目前沒有可用政府電子券或商戶滿減券。</p>';
          return `<article class="wallet-plan-row ${scenarioCount > 1 ? 'wallet-plan-two-cases' : 'wallet-plan-one-case'}">
            <div class="wallet-plan-wallet"><strong>${escapeHtml(row.member)}</strong><span>${escapeHtml(row.payment)}</span><p>可用政府券 E <b>${money(row.governmentAvailableCents)}</b></p>${walletNote}</div>
            ${hasGovernmentPlan ? scenarioMarkup(row, row.withoutMerchant, '不使用滿減券', false, governmentIds, '') : ''}
            ${hasMerchantPlan ? scenarioMarkup(row, row.withMerchant, '使用一張滿減券', true, governmentIds, merchantId) : ''}
            ${emptyMessage}
          </article>`;
        }).join('')}</div>`;
      }

      function stat(label, value) {
        return `<div class="stat"><strong>${escapeHtml(value)}</strong><span>${escapeHtml(label)}</span></div>`;
      }

      function invalidateAllPeriodStats() {
        allPeriodRequestId++;
        allPeriodData = null;
        allPeriodStatsLoading = false;
        allPeriodStatsError = '';
      }

      function localPeriodSnapshot() {
        const snapshot = Object.create(null);
        for (const week of WEEKS) {
          if (localData[week.key]?.coupons) snapshot[week.key] = { coupons: sanitizeCoupons(localData[week.key].coupons) };
        }
        snapshot[currentWeek] = { coupons: sanitizeCoupons(coupons) };
        return snapshot;
      }

      async function loadAllPeriodStats() {
        const requestId = ++allPeriodRequestId;
        allPeriodStatsLoading = true;
        allPeriodStatsError = '';
        if (!database || !online) {
          allPeriodData = localPeriodSnapshot();
          allPeriodStatsLoading = false;
          renderFunStats();
          return;
        }
        const rows = await Promise.all(WEEKS.map(async week => {
          try {
            if (week.key === currentWeek) return [week.key, { coupons: sanitizeCoupons(coupons) }];
            const snapshot = await database.ref(`campaigns/2026R2/weeks/${week.key}`).once('value');
            return [week.key, { coupons: sanitizeCoupons(snapshot.val()?.coupons) }];
          } catch {
            return null;
          }
        }));
        if (requestId !== allPeriodRequestId) return;
        const successful = rows.filter(Boolean);
        allPeriodData = Object.fromEntries(successful);
        allPeriodStatsLoading = false;
        allPeriodStatsError = successful.length < WEEKS.length
          ? `只成功讀取 ${successful.length}/${WEEKS.length} 週；排行可能不完整。`
          : '';
        renderFunStats();
      }

      function renderFunStats() {
        const mode = $('statMode').value || 'week';
        if (mode === 'all' && !allPeriodData) {
          if (allPeriodStatsLoading) {
            $('funStats').innerHTML = '<div class="empty">正在讀取全期統計…</div>';
            $('funStatsNote').textContent = '全期模式僅讀取本活動十週資料，不會寫入。';
            return;
          }
          if (!database || !online) {
            allPeriodData = localPeriodSnapshot();
          } else {
            loadAllPeriodStats();
            $('funStats').innerHTML = '<div class="empty">正在準備統計…</div>';
            return;
          }
        }

        const periodData = mode === 'all'
          ? allPeriodData
          : { [currentWeek]: { coupons: sanitizeCoupons(coupons) } };
        const memberTotals = Object.fromEntries(MEMBERS.map(member => [member, { amount: 0, merchant: 0, gift: 0, count: 0 }]));
        const memberWalletTotals = Object.fromEntries(MEMBERS.map(member => [member, Object.fromEntries(WALLETS.map(wallet => [wallet, 0]))]));
        let merchantTotal = 0;
        let giftTotal = 0;
        for (const weekData of Object.values(periodData || {})) {
          for (const coupon of Object.values(weekData?.coupons || {})) {
            if (!MEMBERS.includes(coupon.member)) continue;
            const member = memberTotals[coupon.member];
            member.count++;
            if (coupon.type === 'gov') {
              member.amount += coupon.amount;
              if (WALLETS.includes(coupon.payment)) {
                memberWalletTotals[coupon.member][coupon.payment] += coupon.amount;
              }
            } else if (coupon.type === 'merchant') {
              member.merchant++;
              merchantTotal++;
            } else if (coupon.type === 'gift') {
              member.gift++;
              giftTotal++;
            }
          }
        }
        const maxAmount = Math.max(1, ...MEMBERS.map(member => memberTotals[member].amount));
        $('funStats').innerHTML = `<div class="draw-bars" role="list" aria-label="五位家人的政府電子券抽中面額比較">${MEMBERS.map(member => {
          const amount = memberTotals[member].amount;
          const width = Math.round(amount / maxAmount * 100);
          const wallets = WALLETS.filter(wallet => memberWalletTotals[member][wallet] > 0);
          return `<div class="draw-bar-row" role="listitem"><span>${escapeHtml(member)}</span><div class="draw-bar-track"><i style="width:${width}%"></i></div><strong>MOP ${formatMop(amount)}</strong><details><summary>支付方式</summary>${wallets.length ? wallets.map(wallet => `<p>${escapeHtml(wallet)} · MOP ${formatMop(memberWalletTotals[member][wallet])}</p>`).join('') : '<p>暫無政府券</p>'}</details></div>`;
        }).join('')}</div><p class="hint">商戶券 ${merchantTotal} 張、禮遇券 ${giftTotal} 張另計；圖表只比較政府電子券抽中面額。</p>`;
        const cachedWeeks = Object.keys(periodData || {}).length;
        const periodText = mode === 'all' ? `全期 ${cachedWeeks}/${WEEKS.length} 週` : '本週';
        const completeness = mode === 'all' && !online
          ? `離線僅統計本機已載入週次（${cachedWeeks}/${WEEKS.length}）；連線後可取得全期。`
          : allPeriodStatsError;
        $('funStatsNote').textContent = `${periodText}；圖表只計政府電子券，包含已用券。${completeness ? ` ${completeness}` : ''}`;
      }

      function renderRegistrationStatus() {
        const member = $('recordMember').value;
        const payment = $('recordWallet').value;
        if (!member || !payment) {
          $('recordStatus').textContent = '此成員尚未在家庭支付設定啟用方式。';
          $('saveDraw').disabled = true;
          return;
        }
        const recordCount = Object.values(coupons).filter(coupon => coupon.member === member && coupon.payment === payment).length;
        const state = recordCount === 0 ? '未登記' : recordCount === 3 ? '已完成' : recordCount < 3 ? `不完整（${recordCount}/3）` : `歷史異常（${recordCount} 項）`;
        $('recordStatus').textContent = `${member} · ${payment}：${state}。${isWeekExpired(currentWeek) ? '本週已到期，只供查閱。' : recordCount ? '已有結果不可覆蓋；如需重登，先在券庫核對並移除舊結果。' : '選齊三次結果才可整批儲存。'}`;
        $('saveDraw').disabled = isWeekExpired(currentWeek) || recordCount > 0;
      }

      function renderWalletSettings() {
        $('memberSettings').innerHTML = MEMBERS.map(member => `<section class="member-box">
          <h3>${escapeHtml(member)}</h3>
          <div class="wallet-grid">${WALLETS.map(wallet => `<label class="wallet-option">
            <input type="checkbox" data-member="${escapeHtml(member)}" data-wallet="${escapeHtml(wallet)}" ${walletConfig[member]?.[wallet] ? 'checked' : ''}>
            <span>${escapeHtml(wallet)}</span>
          </label>`).join('')}</div>
        </section>`).join('');
      }

      function couponTypeName(type) {
        if (type === 'gov') return '政府電子優惠';
        if (type === 'merchant') return '商戶滿減券';
        if (type === 'gift') return '消費禮遇券';
        if (type === 'zero') return '舊期無券記錄';
        return '未識別結果';
      }

      function couponName(coupon) {
        if (coupon.type === 'gov') return `MOP ${formatMop(coupon.amount)}`;
        if (coupon.type === 'merchant') return '消費滿 MOP 100 減 MOP 12';
        if (coupon.type === 'gift') return String(coupon.label || '消費禮遇券');
        return '無券結果（舊記錄）';
      }

      function renderCouponVault() {
        const entries = Object.entries(coupons);
        const selectedWeek = WEEKS.find(week => week.key === currentWeek);
        const actualSpend = selectedWeek
          ? ConsumeCalc.summarizeDashboard(Object.entries(coupons).map(([id, row]) => ({ ...row, id })), localDateKey(selectedWeek.start), localDateKey(selectedWeek.end), isWeekExpired(currentWeek))
          : { byMember: Object.create(null), actualPaidCents: 0, hasMissingActual: false };
        const missingEstimates = selectedWeek ? ConsumeCalc.estimateMissingTransactionAmounts(Object.values(coupons), localDateKey(selectedWeek.start), localDateKey(selectedWeek.end)) : { byMember: Object.create(null), totalSpendCents: 0, totalPaidCents: 0 };
        const spendLabel = (totalCents, hasUnrecorded) => {
          const amountText = `MOP ${formatMop(totalCents / CENTS)}`;
          return hasUnrecorded ? (totalCents > 0 ? `${amountText} + 未記錄` : '未記錄') : amountText;
        };
        $('actualSpendSummary').innerHTML = `<table class="actual-spend-table">
          <thead><tr><th scope="col">家庭成員</th><th scope="col">實際自付</th></tr></thead>
          <tbody>${MEMBERS.map(member => {
            const spend = actualSpend.byMember[member];
            return `<tr><th scope="row">${escapeHtml(member)}</th><td class="num">${spendLabel(spend?.actualPaidCents || 0, Boolean(spend?.hasMissingActual))}</td></tr>`;
          }).join('')}</tbody>
          <tfoot><tr><th scope="row">全家合計</th><td class="num">${spendLabel(actualSpend.actualPaidCents, actualSpend.hasMissingActual)}</td></tr></tfoot>
        </table><p class="hint"><strong>非實際估算（不計入已記錄金額）</strong>：支出 MOP ${formatMop(missingEstimates.totalSpendCents / CENTS)} · 自付 MOP ${formatMop(missingEstimates.totalPaidCents / CENTS)}</p>`;
        const activeEntries = isWeekExpired(currentWeek) ? [] : entries;
        const unusedGovernment = activeEntries.filter(([, coupon]) => coupon.type === 'gov' && !coupon.used);
        const unusedAmount = unusedGovernment.reduce((sum, [, coupon]) => sum + coupon.amount, 0);
        const unusedMerchant = activeEntries.filter(([, coupon]) => coupon.type === 'merchant' && !coupon.used).length;
        const unusedGifts = activeEntries.filter(([, coupon]) => coupon.type === 'gift' && !coupon.used).length;
        $('stats').innerHTML = [
          stat('未核銷電子優惠', `MOP ${formatMop(unusedAmount)}`),
          stat('電子券所需基數', `MOP ${formatMop(unusedAmount * 3)}`),
          stat('未核銷商戶券', `${unusedMerchant} 張`),
          stat('未核銷禮遇券', `${unusedGifts} 張`)
        ].join('');

        const paymentFilter = $('filterWallet').value || 'all';
        const statusFilter = $('filterStatus').value || 'all';
        const filtered = entries
          .map(([id, coupon]) => ({ ...coupon, id }))
          .filter(coupon => selectedVaultMembers.includes(coupon.member))
          .filter(coupon => paymentFilter === 'all' || coupon.payment === paymentFilter)
          .filter(coupon => {
            if (statusFilter === 'unused') return !isWeekExpired(currentWeek) && !coupon.used && ['gov', 'merchant', 'gift'].includes(coupon.type);
            if (statusFilter === 'used') return coupon.used;
            if (statusFilter === 'expired') return isWeekExpired(currentWeek) && !coupon.used && ['gov', 'merchant', 'gift'].includes(coupon.type);
            return true;
          })
          .sort((a, b) => MEMBERS.indexOf(a.member) - MEMBERS.indexOf(b.member) ||
            WALLETS.indexOf(a.payment) - WALLETS.indexOf(b.payment) ||
            (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0));

        $('filterCount').textContent = `顯示 ${filtered.length} 項／本週共 ${entries.length} 項結果；上方摘要只計尚未到期的券。${isWeekExpired(currentWeek) ? '本週券已過期，僅供查閱。' : ''}`;
        if (!filtered.length) {
          $('couponList').innerHTML = '<div class="empty">目前篩選條件沒有券或抽獎結果。</div>';
          return;
        }

        const groups = new Map();
        for (const coupon of filtered) {
          const key = `${coupon.member}\u001f${coupon.payment}`;
          if (!groups.has(key)) groups.set(key, { member: coupon.member, payment: coupon.payment, coupons: [] });
          groups.get(key).coupons.push(coupon);
        }
        $('couponList').innerHTML = [...groups.values()].map(group => `<section class="coupon-group">
          <div class="coupon-group-heading"><h3>${escapeHtml(group.member)}／${escapeHtml(group.payment)}</h3><button class="button secondary small" type="button" data-wallet-plan data-member="${escapeHtml(group.member)}" data-payment="${escapeHtml(group.payment)}" aria-label="只用${escapeHtml(group.member)}／${escapeHtml(group.payment)}試算">只試算此錢包</button></div>
          ${group.coupons.map(coupon => couponRow(coupon)).join('')}
          ${vaultTransactionsMarkup(group)}
        </section>`).join('');
      }

      function vaultTransactionsMarkup(group) {
        const visibleIds = new Set(group.coupons.map(c => c.id));
        const transactions = recordedTransactions(walletRecords(group.member, group.payment))
          .filter(t => t.rows.some(c => visibleIds.has(c.id)));
        return transactions.length ? `<section class="vault-transactions" aria-label="${escapeHtml(group.member)}／${escapeHtml(group.payment)}核銷交易"><h4>核銷交易與復原</h4><p class="hint">同筆多張券會一併復原；請先核對下方券組。</p>${transactions.map(transactionRecordMarkup).join('')}</section>` : '';
      }

      function couponRedemptionSummary(coupon) {
        if (!coupon.used) return '';
        const transactions = recordedTransactions(walletRecords(coupon.member, coupon.payment));
        const t = transactions.find(group => group.rows.some(row => row.id === coupon.id));
        if (!t) return '<div class="redemption-summary">實付金額未記錄（舊紀錄未保存）</div>';
        return `<div class="redemption-summary">核銷日期 ${escapeHtml(t.redemption.date || '')}；支出 ${transactionAmountLabel(t, 'actualSpendCents')}／實付 ${transactionAmountLabel(t, 'actualPaidCents')}</div>`;
      }
      function couponRow(coupon) {
        const expired = !coupon.used && isWeekExpired(currentWeek);
        const status = coupon.used
          ? '<span class="tag muted-tag">已核銷</span>'
          : expired
            ? '<span class="tag expired-tag">已過期</span>'
          : ['gov', 'merchant', 'gift'].includes(coupon.type)
            ? '<span class="tag">未核銷</span>'
            : '<span class="tag muted-tag">結果紀錄</span>';
        const actions = !expired && !coupon.used && ['gov', 'merchant', 'gift'].includes(coupon.type)
          ? `<button class="button secondary small" type="button" data-action="redeem" data-id="${escapeHtml(coupon.id)}" aria-label="記錄核銷：${escapeHtml(coupon.member)}、${escapeHtml(coupon.payment)}、${escapeHtml(couponTypeName(coupon.type))}、${escapeHtml(couponName(coupon))}">記錄核銷</button>`
          : '';
        return `<div class="coupon-row">
          <div class="coupon-info">
            <div class="coupon-label-line">${status}<span class="coupon-type">${escapeHtml(couponTypeName(coupon.type))}</span></div>
            <div class="coupon-name">${escapeHtml(couponName(coupon))}</div>
            ${couponRedemptionSummary(coupon)}
          </div>
          <div class="coupon-actions">
            ${actions}
            ${isWeekExpired(currentWeek) ? '' : `<button class="button danger small" type="button" data-action="delete" data-id="${escapeHtml(coupon.id)}" aria-label="刪除${escapeHtml(coupon.member)} ${escapeHtml(coupon.payment)} 的${escapeHtml(couponName(coupon))}">刪除</button>`}
          </div>
        </div>`;
      }

      function renderSlots() {
        const choices = GOV_AMOUNTS.map(amount => ({ value: String(amount), label: `MOP ${amount}`, ariaLabel: `政府電子優惠 MOP ${amount}` }))
          .concat([
            { value: 'merchant', label: '商戶券', ariaLabel: '商戶滿 MOP 100 減 MOP 12' },
            { value: 'gift', label: '禮遇券', ariaLabel: '消費禮遇券' },
            { value: 'zero', label: '未抽中', ariaLabel: '無券結果／謝謝參與' }
          ]);
        $('slots').innerHTML = slotSelections.map((selected, index) => {
          const selectedChoice = choices.find(choice => choice.value === selected);
          return `<section class="slot">
            <div class="slot-head">
              <div class="slot-title-row"><h3>第 ${index + 1} 次</h3><button class="slot-clear" type="button" data-slot-clear="${index}" aria-label="清除第 ${index + 1} 次抽獎結果">清除</button></div>
              <div class="slot-state">${selectedChoice ? `已選：${escapeHtml(selectedChoice.label)}` : '未開獎／未登記'}</div>
            </div>
            <div class="slot-choices" role="group" aria-label="第 ${index + 1} 次抽獎結果">${choices.map(choice => `<button class="slot-choice" type="button" data-slot-index="${index}" data-result="${choice.value}" aria-label="${escapeHtml(choice.ariaLabel)}" aria-pressed="${selected === choice.value}">${escapeHtml(choice.label)}</button>`).join('')}</div>
          </section>`;
        }).join('');
      }

      function availableMerchantCoupons(members = selectedCalcMembers, payments = selectedCalcPayments) {
        return allWalletEntries().filter(coupon =>
          coupon.type === 'merchant' && !coupon.used && members.includes(coupon.member) && payments.includes(coupon.payment)
        );
      }

      function fallbackWalletFor(members) {
        for (const member of members) {
          const payment = activeWallets(member)[0];
          if (payment) return { member, payment };
        }
        return null;
      }

      function renderCalc() {
        const hadResults = hasCalculatedResult;
        lastCalculatedPlan = null;
        const selectedMerchant = availableMerchantCoupons();
        const merchantAvailable = $('merchantAvailable').checked;
        const memberScope = selectedCalcMembers.length === MEMBERS.length ? '全家' : selectedCalcMembers.length ? selectedCalcMembers.join('、') : '未選家人';
        const paymentScope = selectedCalcPayments.length === WALLETS.length ? '全部支付方式' : selectedCalcPayments.length ? selectedCalcPayments.join('、') : '未選支付方式';
        $('merchantAvailability').textContent = `${memberScope}／${paymentScope}範圍內有 ${selectedMerchant.length} 張未核銷商戶券；${merchantAvailable ? '已勾選商戶可用，計算時會按庫存試算。' : '尚未勾選商戶可用，商戶券會保留。'}`;
        $('plans').innerHTML = '';
        $('plans').classList.remove('single-plan');
        $('planSummary').className = 'notice neutral';
        $('planSummary').textContent = hadResults
          ? '條件已變更；按「計算用券方案」更新結果。'
          : '填入計劃總消費額，再按「計算用券方案」查看結果。';
        renderUseCoupons();
      }

      function setCalcMode(mode) {
        calcMode = mode;
        const useCoupons = mode === 'coupons';
        for (const id of ['shoppingAmountField', 'firstSpendField', 'calcSubmitRow', 'calcResults']) $(id).hidden = useCoupons;
        $('useCouponsResults').hidden = !useCoupons;
        $('modeShopping').setAttribute('aria-pressed', String(!useCoupons));
        $('modeUseCoupons').setAttribute('aria-pressed', String(useCoupons));
        $('modeShopping').classList.toggle('secondary', useCoupons);
        $('modeUseCoupons').classList.toggle('secondary', !useCoupons);
        $('calcModeIntro').textContent = useCoupons
          ? '不用輸入消費額。以下按家人與錢包列出可用券，以及各錢包的最低購物額參考；不同錢包不能併成一單。'
          : '輸入優惠前消費總額，查看分單後的預計實付。試算不含其他支付優惠、禮遇券或 MOP 500 卡式優惠。';
        if (useCoupons) renderUseCoupons();
      }

      function renderUseCoupons() {
        const target = $('useCouponsResults');
        if (isWeekExpired(currentWeek)) {
          target.innerHTML = '<div class="empty">所選週已到期，券只供查閱。</div>';
          return;
        }
        const rows = [];
        for (const member of MEMBERS.filter(value => selectedCalcMembers.includes(value))) {
          for (const payment of WALLETS.filter(value => selectedCalcPayments.includes(value) && walletConfig[member]?.[value])) {
            const list = walletRecords(member, payment).filter(coupon => !coupon.used);
            const scenario = ConsumeCalc.calculateWalletSpendScenarios(list);
            const giftCount = list.filter(coupon => coupon.type === 'gift').length;
            if (!scenario.governmentAvailableCents && !scenario.merchantAvailableCount && !giftCount) continue;
            const withMerchant = $('merchantAvailable').checked ? scenario.withMerchant : null;
            const caseToShow = withMerchant || scenario.withoutMerchant;
            rows.push({ member, payment, scenario, giftCount, caseToShow,
              priority: caseToShow?.requiredGrossSpendCents ?? Number.MAX_SAFE_INTEGER });
          }
        }
        rows.sort((a, b) => a.priority - b.priority || MEMBERS.indexOf(a.member) - MEMBERS.indexOf(b.member) || WALLETS.indexOf(a.payment) - WALLETS.indexOf(b.payment));
        const week = WEEKS.find(value => value.key === currentWeek);
        const deadline = `${week.end.getUTCMonth() + 1}/${week.end.getUTCDate()} 23:59`;
        target.innerHTML = `<h3>可先完成的錢包</h3><p class="hint">按單一錢包所需購物額排序；到期 ${deadline}（澳門時間）。每張券的實際資格仍須核對。</p>${rows.length ? `<div class="use-coupon-list">${rows.map((row, index) => {
          const { member, payment, scenario, giftCount, caseToShow } = row;
          const merchantNote = scenario.merchantAvailableCount ? `商戶券 ${scenario.merchantAvailableCount} 張${$('merchantAvailable').checked ? '；本參考額每單最多計一張' : '；勾選合資格商戶後可另試算'}` : '';
          return `<article class="use-coupon-card"><div class="use-coupon-head"><span class="priority-badge">建議 ${index + 1}</span><h4>${escapeHtml(member)} · ${escapeHtml(payment)}</h4></div><p>未用政府券 <strong>MOP ${formatMop(scenario.governmentAvailableCents / CENTS)}</strong></p><div class="dashboard-pair"><p><span>最低購物額參考</span><strong>${caseToShow ? `MOP ${formatMop(caseToShow.requiredGrossSpendCents / CENTS)}` : '—'}</strong></p><p><span>預計自付</span><strong>${caseToShow ? `MOP ${formatMop(caseToShow.outOfPocketCents / CENTS)}` : '—'}</strong></p></div><small>${merchantNote}${giftCount ? ` · 禮遇券 ${giftCount} 張另依券面使用` : ''}</small><button class="button secondary" type="button" data-wallet-redemption data-member="${escapeHtml(member)}" data-payment="${escapeHtml(payment)}">核對交易後核銷</button></article>`;
        }).join('')}</div>` : '<div class="empty">目前篩選沒有可用券；可切換家人與支付方式。</div>'}`;
      }

      function calculatePlan() {
        lastCalculatedPlan = null;
        $('plans').innerHTML = '';
        const rawTotal = $('totalSpend').value;
        const rawFirstSpend = $('firstSpend').value;
        const total = rawTotal === '' ? NaN : Number(rawTotal);
        const firstSpend = rawFirstSpend === '' ? 0 : Number(rawFirstSpend);
        const selectedMerchant = availableMerchantCoupons();
        const selectedGift = allWalletEntries().filter(coupon =>
          coupon.type === 'gift' && !coupon.used && selectedCalcMembers.includes(coupon.member) && selectedCalcPayments.includes(coupon.payment)
        );
        const merchantAvailable = $('merchantAvailable').checked;
        const memberScope = selectedCalcMembers.length === MEMBERS.length ? '全家' : selectedCalcMembers.length ? selectedCalcMembers.join('、') : '未選家人';
        const paymentScope = selectedCalcPayments.length === WALLETS.length ? '全部支付方式' : selectedCalcPayments.length ? selectedCalcPayments.join('、') : '未選支付方式';
        if (rawTotal === '') {
          $('planSummary').textContent = '請先輸入計劃總消費額。';
          return false;
        }
        if (isWeekExpired(currentWeek)) {
          $('planSummary').textContent = '所選週的券已於週四 23:59 到期；可查看紀錄，但不可再用於試算或核銷。';
          return false;
        }
        const plan = ConsumeCalc.planHousehold(total, firstSpend, allWalletEntries(), {
          selectedMembers: selectedCalcMembers,
          selectedPayments: selectedCalcPayments,
          merchantAvailable,
          fallbackWallet: fallbackWalletFor(selectedCalcMembers)
        });
        if (!plan.valid) {
          $('planSummary').textContent = firstSpend > total
            ? '已先消費金額不能大於計劃總消費額。'
            : '請輸入有效的非負消費金額。';
          return false;
        }

        const remaining = plan.remaining;
        const firstText = firstSpend > 0
          ? `已先消費 MOP ${formatMop(firstSpend)}（不指定家人／支付方式）；`
          : '已先消費 MOP 0；';
        const selectionText = `${memberScope}／${paymentScope}`;
        const merchantText = merchantAvailable
          ? selectedMerchant.length ? `商戶接受券，庫存 ${selectedMerchant.length} 張` : '商戶接受券，但所選家人沒有未核銷商戶券'
          : '本方案不使用商戶券';
        const giftText = selectedGift.length ? `另有 ${selectedGift.length} 張禮遇券（不折算現金）` : '';
        $('planSummary').textContent = `${firstText}餘額 MOP ${formatMop(remaining)}；以${selectionText}的未核銷券分單。${merchantText}。${giftText}`;
        lastCalculatedPlan = plan;
        hasCalculatedResult = true;
        $('plans').classList.toggle('single-plan', plan.plans.length === 1);
        $('plans').innerHTML = plan.plans.map((option, index) => planCard(option, index, plan)).join('');
        return true;
      }

      function nextCouponHints(option) {
        if (option.exactMatch) {
          return '<aside class="next-coupon-hints exact-fit" aria-label="剛好用盡預算"><h4>剛剛好</h4><p>本方案剛好用盡本次預算。</p></aside>';
        }
        const recommendations = [];
        if (option.nextCoupon) recommendations.push({ kind: 'government', data: option.nextCoupon });
        if (option.nextMerchant) recommendations.push({ kind: 'merchant', data: option.nextMerchant });
        recommendations.sort((a, b) => Number(a.data.additionalSpend) - Number(b.data.additionalSpend));
        const items = recommendations.map(({ kind, data }) => {
          const { additionalSpend } = data;
          const needsMore = Number(additionalSpend) > 0;
          if (kind === 'government') {
            const { coupon, currentNet, governmentThreshold, usesMerchant, hasExistingTransaction } = data;
            const message = needsMore
              ? `再消費 MOP ${formatMop(additionalSpend)}，即可多用一張 MOP ${formatMop(coupon.amount)} 電子券`
              : `目前預算內可多用一張 MOP ${formatMop(coupon.amount)} 電子券`;
            const mathItems = [];
            if (hasExistingTransaction) {
              mathItems.push(`<div><span>${usesMerchant ? '商戶券後淨額' : '現有優惠後淨額'}</span><strong>MOP ${formatMop(currentNet)}</strong></div>`);
            }
            mathItems.push(`<div><span>下一張政府券門檻</span><strong>MOP ${formatMop(governmentThreshold)}</strong></div>`);
            mathItems.push(`<div><span>${needsMore ? '尚差額外消費' : '所需額外消費'}</span><strong>${needsMore ? `MOP ${formatMop(additionalSpend)}` : '現有預算可達'}</strong></div>`);
            const math = `<div class="next-coupon-math">${mathItems.join('')}</div>`;
            const note = '尚差額是額外消費，不是自付。';
            return `<li><strong>${message}</strong>${math}<small>${note} 來源：${escapeHtml(coupon.member || '未指定家人')} · ${escapeHtml(coupon.payment || '未指定支付方式')}</small></li>`;
          }
          const { coupon, projectedNetAfterMerchant, governmentThreshold, governmentCoupons } = data;
          const govAmounts = governmentCoupons.map(row => formatMop(row.amount)).join(' + ');
          const hasGovernmentPlan = govAmounts && Number(governmentThreshold) > 0;
          const message = needsMore
            ? hasGovernmentPlan
              ? `再消費 MOP ${formatMop(additionalSpend)}，商戶券後即可同單用 MOP ${govAmounts} 電子券`
              : `再消費 MOP ${formatMop(additionalSpend)}，即可多用一張 MOP 100 減 MOP 12 商戶券`
            : hasGovernmentPlan
              ? `目前預算內用商戶券後即可同單用 MOP ${govAmounts} 電子券`
              : '目前預算內可多用一張 MOP 100 減 MOP 12 商戶券';
          const mathItems = hasGovernmentPlan ? [
            `<div><span>商戶券後淨額</span><strong>MOP ${formatMop(projectedNetAfterMerchant)}</strong></div>`,
            `<div><span>政府電子券門檻</span><strong>MOP ${formatMop(governmentThreshold)}</strong></div>`,
            `<div><span>${needsMore ? '尚差額外消費' : '所需額外消費'}</span><strong>${needsMore ? `MOP ${formatMop(additionalSpend)}` : '現有預算可達'}</strong></div>`
          ] : [];
          const math = mathItems.length ? `<div class="next-coupon-math">${mathItems.join('')}</div>` : '';
          const note = needsMore ? '尚差額是額外消費，不是自付。' : '商戶滿減券每筆限 1 張。';
          return `<li><strong>${message}</strong>${math}<small>${note} 來源：${escapeHtml(coupon.member || '未指定家人')} · ${escapeHtml(coupon.payment || '未指定支付方式')}</small></li>`;
        });
        if (!items.length) return '';
        return `<aside class="next-coupon-hints" aria-label="再消費可使用的下一張券"><h4>再消費可多用一張券</h4><ul>${items.join('')}</ul></aside>`;
      }

      function planCard(option, index, plan) {
        const transactions = option.transactions.map((transaction, transactionIndex) => {
          const governmentCouponsText = transaction.governmentCoupons.length
            ? transaction.governmentCoupons.map(coupon => `MOP ${formatMop(coupon.amount)}`).join(' + ')
            : '本單未使用';
          const merchantGroup = `<section class="coupon-use-group merchant-coupon-group" aria-label="商戶滿減券，每筆最多一張">
            <strong>商戶滿減券 <span class="coupon-limit">每筆限 1 張</span></strong>
            <span>${transaction.usesMerchant ? '已用 MOP 100 減 12' : '未使用'}</span>
          </section>`;
          const governmentGroup = `<section class="coupon-use-group government-coupon-group" aria-label="政府電子券，可多張">
            <strong>政府電子券 <span class="coupon-limit">可多張</span></strong>
            <span>${governmentCouponsText}</span>
          </section>`;
          const merchantSource = transaction.merchantCoupon
            ? `<div class="coupon-source">商戶券來源：${escapeHtml(transaction.merchantCoupon.member || '未指定家人')} · ${escapeHtml(transaction.merchantCoupon.payment)}</div>`
            : '';
          const netBeforeGovernment = Number.isFinite(Number(transaction.base))
            ? Number(transaction.base)
            : Number(transaction.spend) - Number(transaction.merchantDiscount || 0);
          const thresholdGap = Math.max(0, Number(transaction.governmentThreshold) - netBeforeGovernment);
          const governmentThresholdText = transaction.governmentCoupons.length
            ? `其他優惠後、政府券折抵前淨額 MOP ${formatMop(netBeforeGovernment)}；門檻 MOP ${formatMop(transaction.governmentThreshold)}${thresholdGap > 0 ? `，尚差 MOP ${formatMop(thresholdGap)}` : '，已達門檻'}（未計其他支付優惠）`
            : '';
          return `<div class="transaction">
            <div class="transaction-title">第 ${transactionIndex + 1} 單 · ${escapeHtml(transaction.member)} · ${escapeHtml(transaction.payment)}</div>
            <div class="coupon-use-groups">${merchantGroup}${governmentGroup}</div>
            <div class="muted">優惠前 MOP ${formatMop(transaction.spend)}；折券後自付 MOP ${formatMop(transaction.pay)}。${governmentThresholdText ? ` ${governmentThresholdText}。` : ''}</div>
            ${merchantSource}
          </div>`;
        }).join('');
        const unusedParts = [];
        if (option.unusedCoupons.length) unusedParts.push(`未用電子券：${option.unusedCoupons.map(coupon => `${escapeHtml(coupon.member)} · ${escapeHtml(coupon.payment)} MOP ${formatMop(coupon.amount)}`).join('、')}`);
        if (option.unusedMerchantCoupons.length) unusedParts.push(`未用商戶券：${option.unusedMerchantCoupons.map(coupon => `${escapeHtml(coupon.member)} · ${escapeHtml(coupon.payment)}`).join('、')}`);
        const unused = unusedParts.length ? unusedParts.join('；') : '此方案沒有剩餘未核銷電子券／商戶券。';
        const title = '最低實付方案';
        const firstTransaction = plan.firstSpend
          ? `<div class="transaction"><div class="transaction-title">已先消費 MOP ${formatMop(plan.firstSpend)}</div><div class="muted">未指定家人或支付方式；這筆金額不使用本次分配的券。</div></div>`
          : '';
        const unallocated = option.unallocatedSpend > 0
          ? `<div class="transaction"><div class="transaction-title">未分配支付方式的餘額　MOP ${formatMop(option.unallocatedSpend)}</div><div class="muted">尚未指定由哪位家人或哪種支付方式付款。</div></div>`
          : '';
        const giftNote = option.unusedGiftCoupons.length
          ? `<div class="muted">另有 ${option.unusedGiftCoupons.length} 張消費禮遇券，不折算現金；請依券面／商戶條件使用。</div>`
          : '';
        const redeemButton = option.usedCouponIds.length
          ? `<div class="plan-actions">${option.transactions.map((transaction, transactionIndex) => transaction.governmentCoupons.length || transaction.merchantCoupon
            ? `<button class="button" type="button" data-use-plan="${index}" data-transaction-index="${transactionIndex}">核對第 ${transactionIndex + 1} 單 · ${escapeHtml(transaction.member)}／${escapeHtml(transaction.payment)}</button>` : '').join('')}</div>`
          : '';
        const transactionSummary = option.transactions.map((transaction, transactionIndex) => `<li><strong>第 ${transactionIndex + 1} 單 · ${escapeHtml(transaction.member)} · ${escapeHtml(transaction.payment)}</strong><span>購物 MOP ${formatMop(transaction.spend)} · 預計自付 MOP ${formatMop(transaction.pay)}</span></li>`).join('');
        return `<article class="plan-card ${index === 0 ? 'best' : ''}">
          <h3>${escapeHtml(title)}</h3>
          <div class="plan-amount-hero">
            <span>全家預估自付</span>
            <strong>MOP ${formatMop(option.totalPay)}</strong>
            <small>預計優惠 MOP ${formatMop(option.discount)} · 建議 ${option.transactions.length} 單${plan.firstSpend ? '，另有已先消費' : ''}</small>
          </div>
          <ul class="plan-transaction-summary">${transactionSummary || '<li>本次未使用任何券。</li>'}</ul>
          <details class="plan-details"><summary>再消費提示與門檻說明</summary>${nextCouponHints(option)}<p class="breakdown-note">提示的「需增加購物額」不是自付。每單商戶券限 1 張，政府券逐張核對。</p></details>
          <details class="plan-details">
            <summary>查看分單、尚未使用的券與數學明細</summary>
            <div class="plan-details-content">
              ${firstTransaction}${transactions}${unallocated}
              ${planBreakdown(option, plan)}
              <div class="muted">${unused}</div>
              ${giftNote}
              <div class="muted">電子券折扣 MOP ${formatMop(option.governmentDiscount)}；商戶折扣 MOP ${formatMop(option.merchantDiscount)}。</div>
            </div>
          </details>
          ${redeemButton}
        </article>`;
      }

      function planBreakdown(option, plan) {
        const byMember = new Map();
        const ensurePayment = (member, payment) => {
          if (!byMember.has(member)) byMember.set(member, { member, payments: new Map(), paymentAmount: 0, discountAmount: 0, actualSpend: 0 });
          const family = byMember.get(member);
          if (!family.payments.has(payment)) family.payments.set(payment, { payment, paymentAmount: 0, discountAmount: 0, actualSpend: 0 });
          return { family, row: family.payments.get(payment) };
        };
        for (const transaction of option.transactions) {
          const { family, row } = ensurePayment(transaction.member, transaction.payment);
          const governmentDiscount = transaction.governmentCoupons.reduce((sum, coupon) => sum + Number(coupon.amount), 0);
          const discount = governmentDiscount + Number(transaction.merchantDiscount || 0);
          const paymentAmount = Number(transaction.spend) || 0;
          const actualSpend = Number(transaction.pay) || 0;
          row.paymentAmount += paymentAmount;
          row.discountAmount += discount;
          row.actualSpend += actualSpend;
          family.paymentAmount += paymentAmount;
          family.discountAmount += discount;
          family.actualSpend += actualSpend;
        }
        const memberRank = new Map(MEMBERS.map((member, index) => [member, index]));
        const paymentRank = new Map(WALLETS.map((payment, index) => [payment, index]));
        const amountCells = row => `<td data-label="支付金額">MOP ${formatMop(row.paymentAmount)}</td>
          <td data-label="折扣金額">MOP ${formatMop(row.discountAmount)}</td>
          <td data-label="實花金額">MOP ${formatMop(row.actualSpend)}</td>`;
        const sortedFamilies = [...byMember.values()].sort((a, b) =>
          (memberRank.get(a.member) ?? MEMBERS.length) - (memberRank.get(b.member) ?? MEMBERS.length) || a.member.localeCompare(b.member)
        );
        const familyRows = sortedFamilies.map(family => {
          const paymentRows = [...family.payments.values()]
            .sort((a, b) => (paymentRank.get(a.payment) ?? WALLETS.length) - (paymentRank.get(b.payment) ?? WALLETS.length) || a.payment.localeCompare(b.payment))
            .map(row => `<tr class="payment-detail-row"><th scope="row">${escapeHtml(family.member)}／${escapeHtml(row.payment)}</th>${amountCells(row)}</tr>`)
            .join('');
          return `${paymentRows}<tr class="member-subtotal"><th scope="row">${escapeHtml(family.member)} 小計</th>${amountCells(family)}</tr>`;
        }).join('');
        const firstSpend = Number(plan.firstSpend) || 0;
        const unallocatedSpend = Number(option.unallocatedSpend) || 0;
        const firstSpendRow = firstSpend > 0
          ? `<tr class="unassigned-row"><th scope="row">已先消費／未指定家人或支付方式</th><td data-label="支付金額">MOP ${formatMop(firstSpend)}</td><td data-label="折扣金額">MOP ${formatMop(0)}</td><td data-label="實花金額">MOP ${formatMop(firstSpend)}</td></tr>`
          : '';
        const unallocatedRow = unallocatedSpend > 0
          ? `<tr class="unassigned-row"><th scope="row">未分配／未指定支付方式</th><td data-label="支付金額">MOP ${formatMop(unallocatedSpend)}</td><td data-label="折扣金額">MOP ${formatMop(0)}</td><td data-label="實花金額">MOP ${formatMop(unallocatedSpend)}</td></tr>`
          : '';
        const emptyRow = !firstSpendRow && !familyRows && !unallocatedRow
          ? '<tr class="empty-row"><td colspan="4">目前沒有需要分配的付款金額。</td></tr>'
          : '';
        return `<section class="plan-breakdown" aria-label="家人與支付方式金額明細">
          <h4>家人／支付方式明細</h4>
          <div class="breakdown-table-wrap" role="region" aria-label="家人支付金額表，可左右滑動" tabindex="0"><table class="breakdown-table">
            <thead><tr><th scope="col">家人／支付方式</th><th scope="col">支付金額</th><th scope="col">折扣金額</th><th scope="col">實花金額</th></tr></thead>
            <tbody>${firstSpendRow}${familyRows}${unallocatedRow}${emptyRow}</tbody>
            <tfoot><tr><th scope="row">全家合計</th><td data-label="支付金額">MOP ${formatMop(plan.total)}</td><td data-label="折扣金額">MOP ${formatMop(option.discount)}</td><td data-label="實花金額">MOP ${formatMop(option.totalPay)}</td></tr></tfoot>
          </table></div>
        </section>`;
      }

      function redemptionDateInputValue() {
        return ConsumeCalc.macauDateKey();
      }

      function redemptionDateInCurrentWeek(value) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
        const week = WEEKS.find(item => item.key === currentWeek);
        if (!week) return false;
        const date = new Date(`${value}T12:00:00Z`);
        return Number.isFinite(date.getTime()) && localDateKey(date) === value && value <= ConsumeCalc.macauDateKey() && date >= week.start && date <= week.end;
      }

      function restoreWalletPlanFocus() {
        const target = walletPlanReturnFocus;
        walletPlanReturnFocus = null;
        if (target?.isConnected) {
          target.focus({ preventScroll: true });
          return;
        }
        document.querySelector('.wallet-plan-details > summary')?.focus({ preventScroll: true });
      }

      function openWalletRedemption(member, payment, options = {}) {
        if (isWeekExpired(currentWeek)) {
          showToast('所選週已過期，只能查看券紀錄。');
          return;
        }
        const candidates = Object.entries(coupons)
          .filter(([, coupon]) => coupon.member === member && coupon.payment === payment && !coupon.used && ['gov', 'merchant', 'gift'].includes(coupon.type))
          .map(([id, coupon]) => ({ ...coupon, id }))
          .sort((a, b) => ['gov', 'merchant', 'gift'].indexOf(a.type) - ['gov', 'merchant', 'gift'].indexOf(b.type) || (Number(b.amount) || 0) - (Number(a.amount) || 0));
        if (!candidates.length) {
          showToast('這個錢包沒有可核銷的未用券。');
          render();
          return;
        }
        const preselectedIds = new Set(options.preselectedIds || candidates.filter(c => c.type === 'gov').map(c => c.id));
        const candidateIds = new Set(candidates.map(coupon => coupon.id));
        if ([...preselectedIds].some(id => !candidateIds.has(id))) {
          showToast('方案中的券狀態已更新，請重新開啟用券金額規劃。');
          render();
          return;
        }
        if (options.returnFocus) walletPlanReturnFocus = options.returnFocus;
        pendingWalletRedemption = {
          member,
          payment,
          candidates,
          scenarioTitle: options.scenarioTitle || '',
          minimumGrossSpendCents: options.minimumGrossSpendCents ?? null,
          prefillPayCents: options.prefillPayCents ?? null
        };
        $('walletRedeemTitle').textContent = options.scenarioTitle
          ? `${options.scenarioTitle} · ${member} · ${payment}`
          : `直接核銷 · ${member} · ${payment}`;
        $('walletRedeemIntro').textContent = options.scenarioTitle
          ? `已依此方案預選用券；最低原始消費額參考 MOP ${formatMop((options.minimumGrossSpendCents || 0) / CENTS)}。請按實際交易記錄核對實付；最後確認前不會改變券狀態。`
          : '勾選本次同一筆交易實際使用的券。政府電子券可多張；每單最多一張商戶券。下一步須填入實際支出與實付。';
        $('walletRedeemChoices').innerHTML = candidates.map(coupon => {
          const label = coupon.type === 'gov' ? `政府電子優惠 MOP ${formatMop(coupon.amount)}`
            : coupon.type === 'merchant' ? '商戶滿 MOP 100 減 MOP 12'
              : String(coupon.label || '消費禮遇券');
          const checked = preselectedIds.has(coupon.id) ? ' checked' : '';
          return `<label class="wallet-redeem-option"><input type="checkbox" data-wallet-coupon="${escapeHtml(coupon.id)}"${checked}><span><strong>${escapeHtml(label)}</strong><small>${escapeHtml(couponTypeName(coupon.type))} · ${escapeHtml(coupon.member)}／${escapeHtml(coupon.payment)}</small></span></label>`;
        }).join('');
        $('walletRedeemStatus').className = 'notice neutral';
        $('walletRedeemStatus').textContent = '請勾選本次要用的券；未勾選的券會保留。';
        const selection = updateWalletRedemptionSelection();
        $('continueWalletRedeem').disabled = !selection.valid;
        $('walletRedeemDialog').showModal();
        ($('walletRedeemChoices').querySelector('[data-wallet-coupon]:checked') || $('walletRedeemChoices').querySelector('[data-wallet-coupon]'))?.focus({ preventScroll: true });
      }

      function updateWalletRedemptionSelection() {
        if (!pendingWalletRedemption) return { valid: false, selected: [] };
        const selectedIds = new Set([...$('walletRedeemChoices').querySelectorAll('[data-wallet-coupon]:checked')].map(input => input.dataset.walletCoupon));
        const selected = pendingWalletRedemption.candidates.filter(coupon => selectedIds.has(coupon.id));
        const merchantCount = selected.filter(coupon => coupon.type === 'merchant').length;
        for (const input of $('walletRedeemChoices').querySelectorAll('[data-wallet-coupon]')) {
          const coupon = pendingWalletRedemption.candidates.find(row => row.id === input.dataset.walletCoupon);
          input.disabled = Boolean(coupon?.type === 'merchant' && merchantCount >= 1 && !input.checked);
        }
        const status = $('walletRedeemStatus');
        const valid = selected.length > 0 && merchantCount <= 1;
        status.className = `notice ${valid ? 'neutral' : merchantCount > 1 ? 'invalid' : 'neutral'}`;
        status.textContent = merchantCount > 1
          ? '每筆交易最多選一張商戶券，請取消多出的商戶券。'
          : selected.length
            ? `已選 ${selected.length} 張：${selected.map(coupon => couponName(coupon)).join('、')}。下一步核對實際交易日期、支出與實付。`
            : '請勾選本次同一筆交易要使用的券；未勾選的券會保留。';
        $('continueWalletRedeem').disabled = !valid;
        return { valid, selected };
      }

      function continueWalletRedemption(event) {
        event.preventDefault();
        const selection = updateWalletRedemptionSelection();
        if (!selection.valid || !pendingWalletRedemption) return;
        const context = pendingWalletRedemption;
        const { member, payment } = context;
        const couponIds = selection.selected.map(coupon => coupon.id);
        const transaction = {
          member,
          payment,
          couponIds,
          governmentCoupons: selection.selected.filter(coupon => coupon.type === 'gov'),
          pay: null
        };
        walletPlanTransitioning = Boolean(walletPlanReturnFocus);
        $('walletRedeemDialog').close();
        pendingWalletRedemption = null;
        openRedemptionDialog(couponIds, [transaction]);
        walletPlanTransitioning = false;
      }

      function openRedemptionDialog(couponIds, transactions) {
        if (isWeekExpired(currentWeek)) {
          showToast('所選週已過期，不能新增核銷記錄。');
          return;
        }
        const ids = [...new Set(couponIds || [])];
        const rows = ids.map(id => [id, coupons[id]]);
        if (!ids.length || rows.some(([, coupon]) => !coupon || coupon.used)) {
          showToast('券庫已更新或所選券已核銷，請重新試算。');
          renderCalc();
          return;
        }
        const normalized = (transactions || []).map((transaction, index) => {
          const transactionIds = [...new Set(transaction.couponIds || [])].filter(id => ids.includes(id));
          const transactionCoupons = transactionIds.map(id => coupons[id]);
          const governmentCoupons = transactionCoupons.filter(coupon => coupon.type === 'gov');
          const governmentAmountCents = governmentCoupons.reduce((sum, coupon) => sum + toCents(coupon.amount), 0);
          const thresholdCents = governmentAmountCents * 3;
          return {
            index,
            member: transaction.member,
            payment: transaction.payment,
            couponIds: transactionIds,
            coupons: transactionCoupons,
            governmentAmountCents,
            thresholdCents,
            payCents: transaction.pay !== null && transaction.pay !== undefined && transaction.pay !== '' && Number.isFinite(Number(transaction.pay))
              ? toCents(transaction.pay)
              : null
          };
        }).filter(transaction => transaction.couponIds.length);
        const assignedIds = new Set(normalized.flatMap(transaction => transaction.couponIds));
        if (ids.some(id => !assignedIds.has(id))) {
          showToast('方案明細不完整，請重新試算。');
          return;
        }

        pendingRedemption = { ids, transactions: normalized, week: currentWeek };
        $('redeemDialogTitle').textContent = '確認核銷';
        $('redeemDialogHint').textContent = '請參照支付平台交易紀錄自行輸入實際支出與實付。最低估算只供參考，不會自動當作實際金額。';
        $('redeemDateField').hidden = false;
        $('redeemDate').value = redemptionDateInputValue();
        $('redeemTransactions').innerHTML = normalized.map(transaction => {
          const amountId = `redeemAmount-${transaction.index}`;
          const merchantCoupons = transaction.coupons.filter(coupon => coupon.type === 'merchant');
          const minimum = Math.max(transaction.thresholdCents + merchantCoupons.length * 1200, merchantCoupons.length ? 10000 : 0);
          const estimatedPaid = minimum - transaction.governmentAmountCents - merchantCoupons.length * 1200;
          const canEstimate = transaction.governmentAmountCents > 0 || merchantCoupons.length > 0;
          const governmentCoupons = transaction.coupons.filter(coupon => coupon.type === 'gov');
          const otherCoupons = transaction.coupons.filter(coupon => !['merchant', 'gov'].includes(coupon.type));
          const couponList = rows => rows.length
            ? `<ul>${rows.map(coupon => `<li>${escapeHtml(couponName(coupon))}</li>`).join('')}</ul>`
            : '<p class="redeem-coupon-empty">本單未使用</p>';
          const hasVoucherGroups = merchantCoupons.length || governmentCoupons.length;
          const couponGroups = hasVoucherGroups
            ? `<div class="redeem-coupon-groups">
                <section class="redeem-coupon-group merchant-coupon-group">
                  <h4>商戶滿減券 <span class="coupon-limit">每筆限 1 張</span></h4>
                  ${couponList(merchantCoupons)}
                </section>
                <section class="redeem-coupon-group government-coupon-group">
                  <h4>政府電子券 <span class="coupon-limit">可多張</span></h4>
                  ${couponList(governmentCoupons)}
                </section>
                ${otherCoupons.length ? `<section class="redeem-coupon-group"><h4>其他券</h4>${couponList(otherCoupons)}</section>` : ''}
              </div>`
            : `<section class="redeem-coupon-group"><h4>其他優惠券</h4>${couponList(otherCoupons)}</section>`;
          const couponOrder = hasVoucherGroups
            ? '<p class="redeem-sequence">順序：商戶券（每單 1 張）→ 電子券（可多張，逐張核門檻）→ 自付。</p>'
            : '';
          const ruleParts = [];
          if (transaction.governmentAmountCents) ruleParts.push(`政府券按面額由大至小核對，每用一張扣去其面額的 3 倍，再核對下一張；本組逐張合計門檻 MOP ${formatMop(transaction.thresholdCents / CENTS)}。`);
          if (merchantCoupons.length) ruleParts.push('商戶券每筆限 1 張，優惠前消費須達 MOP 100。');
          const rule = ruleParts.length
            ? `<p class="muted">${ruleParts.join('')}</p>`
            : '<p class="muted">請按支付平台交易記錄輸入本次實付金額。</p>';
          const showThresholdStatus = transaction.governmentAmountCents > 0 || merchantCoupons.length > 0;
          const thresholdStatus = showThresholdStatus ? `<p id="redeemThreshold-${transaction.index}" class="redeem-threshold-status" role="status" aria-live="polite"></p>` : '';
          const detailContent = `${couponGroups}${couponOrder}${rule}${thresholdStatus}`;
          return `<section class="redeem-transaction">
            <h3>${escapeHtml(transaction.member)} · ${escapeHtml(transaction.payment)}</h3>
            <p class="hint">${canEstimate ? `最低購物額參考 MOP ${formatMop(minimum / CENTS)}；估算自付 MOP ${formatMop(estimatedPaid / CENTS)}。請填真實交易金額。` : '請按已完成交易填入實際金額。'}</p>
            <label for="redeemSpend-${transaction.index}">支出金額（優惠前 MOP；必填）</label>
            <input id="redeemSpend-${transaction.index}" class="control" data-redemption-amount="${transaction.index}" type="number" min="0" step="0.01" inputmode="decimal" required>
            <label for="${amountId}">實付金額（MOP；必填）</label>
            <input id="${amountId}" class="control" data-redemption-amount="${transaction.index}" type="number" min="0" step="0.01" inputmode="decimal" required>
            <details class="redeem-review-details"><summary>查看已選券與計算詳情</summary>${detailContent}</details>
          </section>`;
        }).join('');
        $('redeemValidation').innerHTML = '';
        $('redeemValidation').classList.remove('invalid');
        $('redeemDialog').showModal();
        validateRedemptionForm();
        $('redeemValidation').focus({ preventScroll: true });
      }

      function redemptionReviewEntryMarkup(transaction, paidCents, check, merchantCount) {
        const hasValidPaid = Number.isFinite(paidCents) && paidCents >= 0;
        const paidLabel = paidCents === null ? '待輸入' : hasValidPaid ? `MOP ${formatMop(paidCents / CENTS)}` : '金額無效';
        const selectedCoupons = transaction.coupons.map(coupon => {
          const label = coupon.type === 'gov'
            ? `政府電子券 ${couponName(coupon)}`
            : coupon.type === 'merchant'
              ? `商戶滿減券 ${couponName(coupon)}`
              : couponName(coupon);
          return escapeHtml(label);
        }).join('、') || '無';
        const thresholdLines = [];
        const detailRows = [];
        if (transaction.governmentAmountCents) {
          const netAmount = hasValidPaid ? `MOP ${formatMop(check.netBeforeGovernmentCents / CENTS)}` : '待輸入';
          const governmentStatus = !hasValidPaid
            ? paidCents === null ? '輸入實付後核對' : '請輸入有效金額'
            : check.governmentShortfallCents > 0
              ? `尚差 MOP ${formatMop(check.governmentShortfallCents / CENTS)}`
              : '達標';
          thresholdLines.push(`<p class="redeem-review-line"><span>政府券資格</span><strong>券前淨額 ${netAmount}／門檻 MOP ${formatMop((check?.governmentThresholdCents ?? transaction.thresholdCents) / CENTS)} · ${governmentStatus}</strong></p>`);
          detailRows.push(`<p><span>政府券前淨額</span><strong>${netAmount}</strong></p>`);
          detailRows.push(`<p><span>政府券核銷門檻</span><strong>MOP ${formatMop(transaction.thresholdCents / CENTS)}</strong></p>`);
        }
        if (merchantCount) {
          const purchaseAmount = hasValidPaid ? `MOP ${formatMop(check.purchaseBeforeMerchantDiscountCents / CENTS)}` : '待輸入';
          const merchantStatus = !hasValidPaid
            ? paidCents === null ? '輸入實付後核對' : '請輸入有效金額'
            : check.merchantShortfallCents > 0
              ? `尚差 MOP ${formatMop(check.merchantShortfallCents / CENTS)}`
              : check.merchantLimitExceeded ? '超出每筆上限' : '達標';
          thresholdLines.push(`<p class="redeem-review-line"><span>滿減券資格</span><strong>優惠前消費 ${purchaseAmount}／最低 MOP 100 · ${merchantStatus}</strong></p>`);
          detailRows.push(`<p><span>滿減券優惠前消費</span><strong>${purchaseAmount}</strong></p>`);
          detailRows.push('<p><span>滿減券最低消費</span><strong>MOP 100</strong></p>');
        }
        if (!thresholdLines.length) thresholdLines.push('<p class="redeem-review-line"><span>用券資格</span><strong>無額外金額門檻</strong></p>');
        detailRows.push(`<p><span>本次實付金額</span><strong>${paidLabel}</strong></p>`);
        return `<section class="redeem-review-entry">
          <p class="redeem-review-paid"><span>實付</span><strong>${paidLabel}</strong></p>
          <p class="redeem-review-line"><span>家人／支付方式</span><strong>${escapeHtml(transaction.member)}／${escapeHtml(transaction.payment)}</strong></p>
          <p class="redeem-review-line"><span>已選用券</span><strong>${selectedCoupons}</strong></p>
          <div class="redeem-review-thresholds">${thresholdLines.join('')}</div>
          <details class="redeem-review-math"><summary>查看計算詳情</summary><div class="redeem-review-math-rows">${detailRows.join('')}</div></details>
        </section>`;
      }

      function validateRedemptionForm() {
        const failures = [], amounts = [], spends = [], estimates = [];
        const summaries = [];
        if (!pendingRedemption?.ids.length || pendingRedemption.week !== currentWeek || isWeekExpired(currentWeek)) failures.push('券庫週次已改變或到期，請重新選擇。');
        if (!redemptionDateInCurrentWeek($('redeemDate').value)) failures.push('核銷日期須在所選活動週內。');
        for (const t of pendingRedemption?.transactions || []) {
          const paidRaw = $(`redeemAmount-${t.index}`).value;
          const spendRaw = $(`redeemSpend-${t.index}`).value;
          const paid = paidRaw === '' ? null : toCents(paidRaw);
          const spend = spendRaw === '' ? null : toCents(spendRaw);
          amounts[t.index] = paid; spends[t.index] = spend;
          const merchantCount = t.coupons.filter(c => c.type === 'merchant').length;
          const minimum = Math.max(t.governmentAmountCents * 3 + merchantCount * 1200, merchantCount ? 10000 : 0);
          const estimatePaid = minimum - t.governmentAmountCents - merchantCount * 1200;
          estimates[t.index] = { estimatedSpendCents: minimum, estimatedPaidCents: estimatePaid };
          if (paid === null || spend === null) failures.push('請填入支出與實付金額，才可確認為實際交易。');
          if (merchantCount > 1) failures.push('每筆最多一張商戶券。');
          if (t.coupons.some(c => c.member !== t.member || c.payment !== t.payment)) failures.push('券不能跨人或錢包。');
          if (paid !== null) {
            const check = ConsumeCalc.validateRedemptionThresholds(paid, t.governmentAmountCents, merchantCount, t.coupons.filter(c => c.type === 'gov').map(c => toCents(c.amount)));
            if (!check.valid) failures.push(`${t.member}／${t.payment}：實付金額無效或未達用券門檻。`);
          }
          if (spend !== null && (!Number.isInteger(spend) || spend < minimum)) failures.push(`${t.member}／${t.payment}：優惠前支出至少 MOP ${formatMop(minimum / CENTS)}。`);
          if (spend !== null && paid !== null && paid > spend) failures.push('實付不可大於優惠前支出。');
          summaries.push(`<section class="redeem-review-entry"><strong>${escapeHtml(t.member)}／${escapeHtml(t.payment)}</strong><p>${t.coupons.map(c => escapeHtml(couponName(c))).join('、')}</p><p>用券最低支出估算 MOP ${formatMop(minimum / CENTS)}／估算實付 MOP ${formatMop(estimatePaid / CENTS)}</p><p>請確認為本筆實際金額：支出 ${spend === null ? '待填' : `MOP ${formatMop(spend / CENTS)}`} · 實付 ${paid === null ? '待填' : `MOP ${formatMop(paid / CENTS)}`}</p></section>`);
        }
        $('redeemValidation').innerHTML = summaries.join('') + `<p>${escapeHtml(failures.join(' ') || '確認即記錄上述實際金額及已選券；取消不會更改資料。')}</p>`;
        $('redeemValidation').classList.toggle('invalid', failures.length > 0);
        $('confirmRedemption').disabled = failures.length > 0;
        return { valid: failures.length === 0, amounts, spends, estimates };
      }

      async function submitRedemption(event) {
        event.preventDefault();
        const check = validateRedemptionForm();
        if (!check.valid || !pendingRedemption) return;
        const { ids, transactions } = pendingRedemption;
        if (ids.some(id => !coupons[id] || coupons[id].used) || transactions.some(t => t.couponIds.some((id, i) => coupons[id]?.member !== t.member || coupons[id]?.payment !== t.payment || coupons[id]?.type !== t.coupons[i].type || coupons[id]?.amount !== t.coupons[i].amount))) {
          showToast('券庫已更新或所選券已核銷，請重新整理後再試。');
          $('redeemDialog').close();
          render();
          return;
        }

        const redeemedOn = $('redeemDate').value;
        const usedAt = Date.now();
        const byCoupon = new Map();
        const transactionNonce = Math.random().toString(36).slice(2, 10) || 'local';
        for (const transaction of transactions) {
          const paid = check.amounts[transaction.index], spend = check.spends[transaction.index];
          const redemption = {
            date: redeemedOn,
            ...check.estimates[transaction.index],
            amountKind: 'actual',
            actualConfirmedAt: usedAt,
            transactionId: `${usedAt}-${transactionNonce}-${transaction.index}`
          };
          if (paid !== null) redemption.actualPaidCents = paid;
          if (spend !== null) redemption.actualSpendCents = spend;
          for (const id of transaction.couponIds) byCoupon.set(id, redemption);
        }
        const updates = {};
        const updatedCoupons = {};
        for (const id of ids) {
          const redemption = byCoupon.get(id);
          updates[`coupons/${id}/used`] = true;
          updates[`coupons/${id}/usedAt`] = usedAt;
          updates[`coupons/${id}/redemption`] = redemption;
          const priorHistory = Array.isArray(coupons[id].redemptionHistory) ? coupons[id].redemptionHistory : [];
          const history = coupons[id].redemption ? [...priorHistory.filter(r => r.transactionId !== coupons[id].redemption.transactionId), coupons[id].redemption] : priorHistory;
          updates[`coupons/${id}/redemptionHistory`] = history;
          updatedCoupons[id] = { ...coupons[id], used: true, usedAt, redemption, redemptionHistory: history };
        }
        $('confirmRedemption').disabled = true;
        if (online && database) {
          try {
            await database.ref(weekPath()).update(updates);
          } catch {
            $('confirmRedemption').disabled = false;
            showToast('雲端核銷記錄失敗；券庫未更新，請確認連線後再試。');
            return;
          }
        }
        Object.assign(coupons, updatedCoupons);
        saveLocal();
        invalidateAllPeriodStats();
        $('redeemDialog').close();
        pendingRedemption = null;
        render();
        showToast(online ? `已核銷並記錄 ${ids.length} 張券。` : `已在本機記錄 ${ids.length} 張核銷；尚未同步雲端。`);
      }

      function redeemPlan(index, transactionIndex) {
        const option = lastCalculatedPlan?.plans[index];
        if (!option || !option.usedCouponIds.length) return;
        const transaction = option.transactions[transactionIndex];
        if (!transaction) return;
        const ids = [transaction.merchantCoupon?.id, ...transaction.governmentCoupons.map(coupon => coupon.id)].filter(Boolean);
        if (!ids.length) return;
        openWalletRedemption(transaction.member, transaction.payment, {
          preselectedIds: ids,
          scenarioTitle: `方案第 ${transactionIndex + 1} 單`,
          minimumGrossSpendCents: toCents(transaction.spend)
        });
      }

      function renderCouponVaultFilters() {
        renderVaultMemberFilter();
        fillSelect('filterWallet', [{ value: 'all', label: '全部支付方式' }]
          .concat(WALLETS.map(wallet => ({ value: wallet, label: wallet }))), $('filterWallet').value || 'all');
      }

      function renderSlotsAndFilters() {
        renderSlots();
        renderCouponVaultFilters();
      }

      function collectDrawResults() {
        if (isWeekExpired(currentWeek)) {
          showToast('所選週已到期，只供查閱。');
          return null;
        }
        const member = $('recordMember').value;
        const payment = $('recordWallet').value;
        if (!member || !payment) {
          showToast('請先在家庭設定啟用此成員的支付方式。');
          return null;
        }
        if (isDrawn(member, payment)) {
          showToast('此成員／支付方式已有結果紀錄；請先到券庫移除該錢包的三項結果。');
          return null;
        }
        if (slotSelections.some(value => value === null)) {
          showToast('請先為三格各選一個結果。');
          return null;
        }
        return slotSelections.map(value => {
          const coupon = { member, payment, used: false, createdAt: Date.now() };
          if (value === 'merchant') {
            coupon.type = 'merchant';
            coupon.amount = 12;
          } else if (value === 'gift') {
            coupon.type = 'gift';
            coupon.label = '消費禮遇券';
          } else if (value === 'zero') {
            coupon.type = 'zero';
            coupon.amount = 0;
          } else {
            const amount = Number(value);
            if (!GOV_AMOUNTS.includes(amount)) return null;
            coupon.type = 'gov';
            coupon.amount = amount;
          }
          return coupon;
        });
      }

      function resetDrawResults() {
        slotSelections = [null, null, null];
        renderSlots();
      }

      async function undoTransaction(member, payment, transactionId) {
        if (isWeekExpired(currentWeek)) { showToast('所選週已到期，只供查閱。'); return; }
        // Never infer a legacy transaction from a wallet, timestamp, or missing ID.
        if (typeof transactionId !== 'string' || !transactionId.trim() || !member || !payment) return;
        const operationWeek = currentWeek, operationPath = weekPath();
        const lockKey = JSON.stringify([operationWeek, member, payment, transactionId]);
        if (undoingTransactions.has(lockKey)) return;
        const rows = walletRecords(member, payment).filter(c => c.used && c.redemption?.transactionId === transactionId);
        if (!rows.length || rows.some(c => c.member !== member || c.payment !== payment)) return;
        if (!online || !database) { showToast('尚未連接雲端；未復原或刪除，請連線後再試。'); return; }
        undoingTransactions.add(lockKey);
        const current = walletRecords(member, payment).filter(c => c.used && c.redemption?.transactionId === transactionId);
        if (current.length !== rows.length || current.some(c => !rows.some(old => old.id === c.id))) { undoingTransactions.delete(lockKey); showToast('原交易已變更，未復原。'); return; }
        const updates = {}, next = {};
        for (const c of current) {
          updates[`coupons/${c.id}/used`] = false;
          updates[`coupons/${c.id}/usedAt`] = null;
          // RTDB null deletes the entire monetary record, including estimates/audit.
          updates[`coupons/${c.id}/redemption`] = null;
          next[c.id] = { ...c, used: false, usedAt: null };
          delete next[c.id].redemption;
          if (Array.isArray(c.redemptionHistory) && c.redemptionHistory.some(r => r?.transactionId === transactionId)) {
            const history = c.redemptionHistory.filter(r => r?.transactionId !== transactionId);
            updates[`coupons/${c.id}/redemptionHistory`] = history.length ? history : null;
            if (history.length) next[c.id].redemptionHistory = history;
            else delete next[c.id].redemptionHistory;
          }
        }
        try {
          // One atomic multi-path write; do not change local state until it succeeds.
          await database.ref(operationPath).update(updates);
          localData[operationWeek] = { coupons: { ...(localData[operationWeek]?.coupons || {}), ...next } };
          try { localStorage.setItem(cacheKey, JSON.stringify(localData)); } catch { /* keep remote update */ }
          if (currentWeek === operationWeek) { Object.assign(coupons, next); invalidateAllPeriodStats(); render(); }
          showToast(`已將 ${current.length} 張券還原為未使用，並刪除此筆核銷及支出／實付記錄（含估算）。`);
        } catch { showToast('雲端儲存失敗；未復原，請稍後再試。'); }
        finally { undoingTransactions.delete(lockKey); }
      }

      function correctionRedemption(coupon, transactionId) {
        if (coupon?.redemption?.transactionId === transactionId) return coupon.redemption;
        return (Array.isArray(coupon?.redemptionHistory) ? coupon.redemptionHistory : []).find(r => r.transactionId === transactionId);
      }

      function openCorrection(member, payment, transactionId) {
        if (isWeekExpired(currentWeek)) { showToast('所選週已到期，只供查閱。'); return; }
        const rows = walletRecords(member, payment).filter(c => correctionRedemption(c, transactionId));
        if (!rows.length) return;
        pendingCorrection = { member, payment, transactionId, ids: rows.map(c => c.id), week: currentWeek };
        const r = correctionRedemption(rows[0], transactionId);
        $('correctionContext').textContent = `${member}／${payment} · ${r.date}；只更新這筆原交易，不新增或重複計算。`;
        $('correctionSpend').value = Number.isInteger(r.actualSpendCents) ? r.actualSpendCents / CENTS : '';
        $('correctionPaid').value = Number.isInteger(r.actualPaidCents) ? r.actualPaidCents / CENTS : '';
        $('correctionStatus').textContent = '';
        $('correctionDialog').showModal();
      }

      async function submitCorrection(event) {
        event.preventDefault();
        const context = pendingCorrection;
        if (!context || context.week !== currentWeek) return;
        const rows = context.ids.map(id => coupons[id]);
        if (rows.some(c => !c || c.member !== context.member || c.payment !== context.payment || !correctionRedemption(c, context.transactionId))) {
          $('correctionStatus').textContent = '原交易已變更，請取消後重新開啟。'; return;
        }
        const spend = $('correctionSpend').value === '' ? NaN : toCents($('correctionSpend').value);
        const paid = $('correctionPaid').value === '' ? NaN : toCents($('correctionPaid').value);
        const reversed = Boolean(correctionRedemption(rows[0], context.transactionId).undoAudit);
        const gov = rows.filter(c => c.type === 'gov').reduce((sum, c) => sum + toCents(c.amount), 0);
        const merchants = rows.filter(c => c.type === 'merchant').length;
        const check = ConsumeCalc.validateRedemptionThresholds(paid, gov, merchants, rows.filter(c => c.type === 'gov').map(c => toCents(c.amount)));
        if (!Number.isInteger(spend) || !Number.isInteger(paid) || spend < 0 || paid < 0 || paid > spend || (!reversed && (spend < Math.max(gov * 3 + merchants * 1200, merchants ? 10000 : 0) || !check.valid))) {
          $('correctionStatus').textContent = '請填有效的實際金額，並核對用券門檻。'; return;
        }
        const updates = {}, next = {}, correctedAt = Date.now(), operationPath = weekPath();
        const amend = r => ({ ...r, actualSpendCents: spend, actualPaidCents: paid, amountKind: 'actual', actualConfirmedAt: correctedAt, correctedAt });
        context.ids.forEach((id, i) => {
          const row = rows[i]; next[id] = { ...row };
          if (row.redemption?.transactionId === context.transactionId) {
            next[id].redemption = amend(row.redemption);
            updates[`coupons/${id}/redemption`] = next[id].redemption;
          }
          const history = Array.isArray(row.redemptionHistory) ? row.redemptionHistory : [];
          if (history.some(r => r.transactionId === context.transactionId)) {
            next[id].redemptionHistory = history.map(r => r.transactionId === context.transactionId ? amend(r) : r);
            updates[`coupons/${id}/redemptionHistory`] = next[id].redemptionHistory;
          }
        });
        $('saveCorrection').disabled = true;
        try {
          if (online && database) await database.ref(operationPath).update(updates);
          localData[context.week] = { coupons: { ...(localData[context.week]?.coupons || {}), ...next } };
          try { localStorage.setItem(cacheKey, JSON.stringify(localData)); } catch { /* Preserve successful remote update. */ }
          if (currentWeek === context.week) { Object.assign(coupons, next); invalidateAllPeriodStats(); render(); }
          $('correctionDialog').close(); pendingCorrection = null;
          showToast(online ? '已更新同一筆交易，沒有新增或重複計算。' : '更正只保存在此裝置，尚未同步雲端。');
        } catch { $('correctionStatus').textContent = '雲端儲存失敗；原交易未更改，請稍後再試。'; }
        finally { $('saveCorrection').disabled = false; }
      }

      function storeBatch(rows) {
        if (!Array.isArray(rows) || rows.length !== 3 || isWeekExpired(currentWeek) || isDrawn(rows[0].member, rows[0].payment)) {
          showToast('三項結果不完整、已有紀錄或週次已到期；未儲存。');
          return Promise.resolve();
        }
        const updates = {};
        const timestamp = Date.now();
        for (const [index, row] of rows.entries()) {
          const id = `c${timestamp}${index}${Math.random().toString(36).slice(2, 8)}`;
          coupons[id] = { ...row, createdAt: timestamp };
          updates[`coupons/${id}`] = coupons[id];
        }
        invalidateAllPeriodStats();
        if (online && database) {
          return database.ref(weekPath()).update(updates)
            .then(() => {
              resetDrawResults();
              showToast('三個抽獎結果已一起儲存。');
              render();
            })
            .catch(() => {
              saveLocal();
              resetDrawResults();
              render();
              showToast('雲端儲存失敗；結果只保存在此裝置，請先匯出備份。');
            });
        }
        saveLocal();
        resetDrawResults();
        render();
        showToast('三個結果已保存在此裝置；連線後請確認是否需共用。');
        return Promise.resolve();
      }

      function writeCoupon(id, value) {
        if (isWeekExpired(currentWeek)) { showToast('所選週已到期，只供查閱。'); return Promise.resolve(false); }
        invalidateAllPeriodStats();
        if (online && database) {
          return database.ref(`${weekPath()}/coupons/${id}`).set(value)
            .then(() => true)
            .catch(() => {
              if (value === null) delete coupons[id];
              else coupons[id] = value;
              saveLocal();
              render();
              showToast('雲端儲存失敗；變更只保存在此裝置。');
              return false;
            });
        }
        if (value === null) delete coupons[id];
        else coupons[id] = value;
        saveLocal();
        render();
        showToast('變更只保存在此裝置，尚未同步雲端。');
        return Promise.resolve(true);
      }

      function saveWalletSettings(member) {
        saveLocalWallets();
        render();
        if (online && database && member) {
          const snapshot = { ...walletConfig[member] };
          const previous = walletSaveQueues[member] || Promise.resolve();
          const write = previous.catch(() => {}).then(() => database.ref(`${settingsPath}/${member}`).set(snapshot));
          walletSaveQueues[member] = write;
          write.then(() => {
            if (walletSaveQueues[member] === write) showToast('家庭支付設定已儲存。');
          }).catch(() => {
            if (walletSaveQueues[member] === write) showToast('雲端同步失敗；設定只保存在此裝置。');
          });
        } else {
          showToast('家庭支付設定已保存在此裝置。');
        }
      }

      function exportBackup() {
        const data = { campaign: '2026R2', week: currentWeek, coupons, walletConfig };
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `消費連環賞_${currentWeek}.json`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }

      async function importBackup(event) {
        const file = event.target.files?.[0];
        if (!file) return;
        if (isWeekExpired(currentWeek)) {
          showToast('所選週已到期，只供查閱；未匯入備份。');
          event.target.value = '';
          return;
        }
        try {
          if (file.size > 1024 * 1024) throw new Error('size');
          const data = JSON.parse(await file.text());
          if (data.campaign !== '2026R2' || !data.coupons || typeof data.coupons !== 'object' || Array.isArray(data.coupons)) throw new Error('format');
          if (!window.confirm('匯入會以備份內容覆蓋本週券庫，並同步家庭支付設定。是否繼續？')) return;
          coupons = sanitizeCoupons(data.coupons);
          invalidateAllPeriodStats();
          if (data.walletConfig) walletConfig = sanitizeWallets(data.walletConfig);
          saveLocal();
          saveLocalWallets();
          render();
          const cloudWrites = online && database
            ? Promise.all([
              database.ref(`${weekPath()}/coupons`).set(coupons),
              ...MEMBERS.map(member => database.ref(`${settingsPath}/${member}`).set(walletConfig[member]))
            ])
            : Promise.resolve();
          await cloudWrites;
          showToast(online ? '本週備份已匯入並同步。' : '備份已匯入本機；連線後請確認同步狀態。');
        } catch {
          showToast('備份格式不正確或同步失敗；請檢查檔案並保留原備份。');
        } finally {
          event.target.value = '';
        }
      }

      function setActivePanel(panelId) {
        document.querySelectorAll('[data-nav]').forEach(button => {
          if (button.dataset.nav === panelId) button.setAttribute('aria-current', 'page');
          else button.removeAttribute('aria-current');
        });
        document.querySelectorAll('.panel').forEach(panel => {
          const selected = panel.id === panelId;
          panel.classList.toggle('active', selected);
          panel.hidden = !selected;
        });
        const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        window.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' });
      }

      function currentMacauDate() {
        return new Date(`${ConsumeCalc.macauDateKey()}T12:00:00Z`);
      }

      function isWeekExpired(weekKey) {
        const week = WEEKS.find(item => item.key === (weekKey || currentWeek));
        return Boolean(week && currentMacauDate() > week.end);
      }

      function renderWeekExpiry() {
        const week = WEEKS.find(item => item.key === currentWeek);
        if (!week) return;
        const weekday = ['日', '一', '二', '三', '四', '五', '六'][week.end.getUTCDay()];
        const expiry = `${week.end.getUTCMonth() + 1}/${week.end.getUTCDate()}（週${weekday}）23:59`;
        const expired = isWeekExpired(currentWeek);
        const today = currentMacauDate();
        if (today < CAMPAIGN_START) {
          $('weekExpiry').textContent = `本期尚未開始；目前顯示 ${week.label}`;
        } else if (today > CAMPAIGN_END) {
          $('weekExpiry').textContent = `本期已於 12/17 結束；所選週只供查閱`;
        } else {
          $('weekExpiry').textContent = expired
            ? `所選週獎賞已於 ${expiry} 失效；只供查閱`
            : `所選週券最遲於 ${expiry} 失效`;
        }
        $('weekExpiry').classList.toggle('expired', expired || today > CAMPAIGN_END);
      }

      function defaultWeekKey() {
        const today = currentMacauDate();
        const index = WEEKS.findIndex(week => today >= week.start && today <= week.end);
        if (index < 0) return today < WEEKS[0].start ? WEEKS[0].key : WEEKS[WEEKS.length - 1].key;
        return WEEKS[index].key;
      }

      function initializeFirebase() {
        if (typeof firebase === 'undefined') {
          $('connection').textContent = '離線（本機）';
          return;
        }
        try {
          if (!firebase.apps.length) firebase.initializeApp(CONFIG);
          database = firebase.database();
          weekReference = database.ref(weekPath());
          weekReference.on('value', snapshot => {
            const data = snapshot.val() || {};
            coupons = sanitizeCoupons(data.coupons);
            invalidateAllPeriodStats();
            online = true;
            $('connection').textContent = '已連線';
            localData[currentWeek] = { coupons };
            try { localStorage.setItem(cacheKey, JSON.stringify(localData)); } catch { /* 本機空間不足時仍保留雲端資料 */ }
            render();
          }, () => {
            online = false;
            $('connection').textContent = '離線（本機）';
          });
          settingsReference = database.ref(settingsPath);
          settingsReference.on('value', snapshot => {
            if (snapshot.exists()) {
              walletConfig = sanitizeWallets(snapshot.val());
              saveLocalWallets();
              render();
            }
          }, () => {});
        } catch {
          $('connection').textContent = '離線（本機）';
        }
      }

      function initialize() {
        loadLocal();
        currentWeek = defaultWeekKey();
        $('week').innerHTML = WEEKS.map(week => `<option value="${week.key}">${escapeHtml(week.label)}</option>`).join('');
        $('week').value = currentWeek;
        fillMemberSelects();
        setWalletOptions('recordWallet', MEMBERS[0]);
        fillSelect('walletRedemptionMemberFilter', [{ value: 'all', label: '全部家人' }]
          .concat(MEMBERS.map(member => ({ value: member, label: member }))), 'all');
        fillSelect('walletRedemptionPaymentFilter', [{ value: 'all', label: '全部支付方式' }]
          .concat(WALLETS.map(wallet => ({ value: wallet, label: wallet }))), 'all');
        fillSelect('filterWallet', [{ value: 'all', label: '全部支付方式' }]
          .concat(WALLETS.map(wallet => ({ value: wallet, label: wallet }))), 'all');
        coupons = sanitizeCoupons(localData[currentWeek]?.coupons);
        renderSlotsAndFilters();
        render();
        setActivePanel('overview');
        initializeFirebase();
      }

      $('week').addEventListener('change', event => {
        currentWeek = event.target.value;
        expandedWallet = null;
        $('redeemDialog').close(); $('walletRedeemDialog').close(); $('correctionDialog').close();
        invalidateAllPeriodStats();
        if (weekReference) weekReference.off();
        coupons = sanitizeCoupons(localData[currentWeek]?.coupons);
        render();
        if (database) {
          weekReference = database.ref(weekPath());
          weekReference.on('value', snapshot => {
            const data = snapshot.val() || {};
            coupons = sanitizeCoupons(data.coupons);
            invalidateAllPeriodStats();
            online = true;
            $('connection').textContent = '已連線';
            localData[currentWeek] = { coupons };
            try { localStorage.setItem(cacheKey, JSON.stringify(localData)); } catch { /* 本機空間不足時仍保留雲端資料 */ }
            render();
          }, () => {
            online = false;
            $('connection').textContent = '離線（本機）';
          });
        }
      });

      $('recordMember').addEventListener('change', () => {
        setWalletOptions('recordWallet', $('recordMember').value);
        resetDrawResults();
        renderRegistrationStatus();
      });
      $('recordWallet').addEventListener('change', () => {
        resetDrawResults();
        renderRegistrationStatus();
      });
      $('calcForm').addEventListener('submit', event => {
        event.preventDefault();
        if (calcMode !== 'shopping') return;
        if (!calculatePlan()) return;
        const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        $('calcResults').scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
      });
      $('totalSpend').addEventListener('input', renderCalc);
      $('firstSpend').addEventListener('input', renderCalc);
      $('modeShopping').addEventListener('click', () => setCalcMode('shopping'));
      $('modeUseCoupons').addEventListener('click', () => setCalcMode('coupons'));
      $('statMode').addEventListener('change', renderFunStats);

      $('calcMemberFilter').addEventListener('click', event => {
        const action = event.target.closest('[data-calc-filter-action="member"]');
        if (action) {
          updateCalcSelection('member', action.dataset.selection);
          return;
        }
        const button = event.target.closest('[data-calc-member]');
        if (!button) return;
        selectedCalcMembers = toggleCalcSelection(selectedCalcMembers, button.dataset.calcMember, MEMBERS);
        renderCalcMemberFilter();
        renderCalc();
      });
      $('calcPaymentFilter').addEventListener('click', event => {
        const action = event.target.closest('[data-calc-filter-action="payment"]');
        if (action) {
          updateCalcSelection('payment', action.dataset.selection);
          return;
        }
        const button = event.target.closest('[data-calc-payment]');
        if (!button) return;
        selectedCalcPayments = toggleCalcSelection(selectedCalcPayments, button.dataset.calcPayment, WALLETS);
        renderCalcPaymentFilter();
        renderCalc();
      });
      $('merchantAvailable').addEventListener('change', renderCalc);
      $('plans').addEventListener('click', event => {
        const button = event.target.closest('[data-use-plan]');
        if (!button) return;
        redeemPlan(Number(button.dataset.usePlan), Number(button.dataset.transactionIndex));
      });
      $('redeemForm').addEventListener('submit', submitRedemption);
      $('redeemDate').addEventListener('input', validateRedemptionForm);
      $('redeemTransactions').addEventListener('input', event => {
        if (event.target.matches('[data-redemption-amount]')) validateRedemptionForm();
      });
      $('cancelRedemption').addEventListener('click', () => $('redeemDialog').close());
      $('redeemDialog').addEventListener('close', () => {
        pendingRedemption = null;
        if (walletPlanReturnFocus) restoreWalletPlanFocus();
      });
      $('walletRedeemForm').addEventListener('submit', continueWalletRedemption);
      $('walletRedeemChoices').addEventListener('change', updateWalletRedemptionSelection);
      $('cancelWalletRedeem').addEventListener('click', () => $('walletRedeemDialog').close());
      $('walletRedeemDialog').addEventListener('close', () => {
        const movingToPaymentReview = walletPlanTransitioning || Boolean(pendingRedemption);
        pendingWalletRedemption = null;
        if (walletPlanReturnFocus && !movingToPaymentReview) restoreWalletPlanFocus();
      });

      $('vaultMemberFilter').addEventListener('click', event => {
        const button = event.target.closest('[data-vault-member]');
        if (!button) return;
        selectedVaultMembers = selectMembers(selectedVaultMembers, button.dataset.vaultMember);
        renderVaultMemberFilter();
        renderCouponVault();
      });
      $('filterWallet').addEventListener('change', renderCouponVault);
      $('filterStatus').addEventListener('change', renderCouponVault);
      $('slots').addEventListener('click', event => {
        const clearButton = event.target.closest('[data-slot-clear]');
        if (clearButton) {
          slotSelections[Number(clearButton.dataset.slotClear)] = null;
          renderSlots();
          return;
        }
        const button = event.target.closest('[data-slot-index]');
        if (!button) return;
        const index = Number(button.dataset.slotIndex);
        slotSelections[index] = slotSelections[index] === button.dataset.result ? null : button.dataset.result;
        renderSlots();
      });
      $('saveDraw').addEventListener('click', () => {
        const rows = collectDrawResults();
        if (!rows) return;
        $('saveDraw').disabled = true;
        storeBatch(rows).finally(renderRegistrationStatus);
      });
      $('memberSettings').addEventListener('change', event => {
        const input = event.target.closest('[data-member][data-wallet]');
        if (!input) return;
        walletConfig[input.dataset.member][input.dataset.wallet] = input.checked;
        saveWalletSettings(input.dataset.member);
      });
      $('walletRedemptionCards').addEventListener('click', event => {
        const toggle = event.target.closest('[data-expand-wallet]');
        if (toggle) {
          const key = `${toggle.dataset.member}|${toggle.dataset.payment}`;
          expandedWallet = expandedWallet === key ? null : key;
          renderDrawStates();
          document.querySelector(`[data-expand-wallet][data-member="${toggle.dataset.member}"][data-payment="${toggle.dataset.payment}"]`)?.focus({ preventScroll: true });
          return;
        }
        const correction = event.target.closest('[data-correct-transaction]');
        const undo = event.target.closest('[data-undo-transaction]');
        if (undo) { undoTransaction(undo.dataset.member, undo.dataset.payment, undo.dataset.undoTransaction); return; }
        if (correction) { openCorrection(correction.dataset.member, correction.dataset.payment, correction.dataset.correctTransaction); return; }
        const button = event.target.closest('[data-wallet-redemption]');
        if (!button) return;
        openWalletRedemption(button.dataset.member, button.dataset.payment);
      });
      $('memberCompare').addEventListener('click', event => {
        if (event.target.closest('[data-open-registration]')) setActivePanel('record');
      });
      $('useCouponsResults').addEventListener('click', event => {
        const button = event.target.closest('[data-wallet-redemption]');
        if (button) openWalletRedemption(button.dataset.member, button.dataset.payment);
      });
      $('walletSpendPlanTable').addEventListener('click', event => {
        const button = event.target.closest('[data-wallet-plan-redemption]');
        if (!button) return;
        const context = walletPlanRedemptionContexts.get(button.dataset.walletPlanRedemption);
        if (!context) return;
        openWalletRedemption(context.member, context.payment, {
          returnFocus: button,
          preselectedIds: context.couponIds,
          scenarioTitle: context.scenarioTitle,
          minimumGrossSpendCents: context.minimumGrossSpendCents,
          prefillPayCents: context.prefillPayCents
        });
      });
      $('walletRedemptionMemberFilter').addEventListener('change', renderDrawStates);
      $('walletRedemptionPaymentFilter').addEventListener('change', renderDrawStates);
      $('couponList').addEventListener('click', event => {
        const undo = event.target.closest('[data-undo-transaction]');
        if (undo) { undoTransaction(undo.dataset.member, undo.dataset.payment, undo.dataset.undoTransaction); return; }
        const correction = event.target.closest('[data-correct-transaction]');
        if (correction) { openCorrection(correction.dataset.member, correction.dataset.payment, correction.dataset.correctTransaction); return; }
        const walletPlan = event.target.closest('[data-wallet-plan]');
        if (walletPlan) {
          selectedCalcMembers = [walletPlan.dataset.member];
          selectedCalcPayments = [walletPlan.dataset.payment];
          renderCalcMemberFilter();
          renderCalcPaymentFilter();
          renderCalc();
          setActivePanel('calc');
          showToast(`已限定 ${walletPlan.dataset.member} · ${walletPlan.dataset.payment}；輸入此錢包本次消費額後試算。`);
          $('totalSpend').focus({ preventScroll: true });
          return;
        }
        const button = event.target.closest('button[data-action]');
        if (!button) return;
        const id = button.dataset.id;
        const coupon = coupons[id];
        if (!coupon) return;
        if (button.dataset.action === 'delete') {
          const message = coupon.used
            ? '此券已記錄核銷。刪除只會移除此工具內的紀錄，不會撤銷支付平台核銷；確定刪除？'
            : '確定刪除此抽獎結果？刪除最後一項後，該支付方式會顯示未登記。建議先匯出備份。';
          if (!window.confirm(message)) return;
          writeCoupon(id, null).then(saved => { if (saved && online) showToast('結果已刪除並同步。'); });
          return;
        }
        if (button.dataset.action === 'redeem') openWalletRedemption(coupon.member, coupon.payment, { preselectedIds: [id] });
      });

      $('export').addEventListener('click', exportBackup);
      $('import').addEventListener('change', importBackup);
      document.querySelectorAll('[data-nav]').forEach(button => button.addEventListener('click', () => setActivePanel(button.dataset.nav)));
      $('walletPlanMemberFilter').addEventListener('change', renderWalletSpendPlans);
      $('walletPlanPaymentFilter').addEventListener('change', renderWalletSpendPlans);
      document.querySelectorAll('.info-toggle').forEach(button => button.addEventListener('click', () => { const expanded = button.getAttribute('aria-expanded') !== 'true'; button.setAttribute('aria-expanded', String(expanded)); $(button.getAttribute('aria-controls')).hidden = !expanded; }));
      $('correctionForm').addEventListener('submit', submitCorrection);
      $('cancelCorrection').addEventListener('click', () => $('correctionDialog').close());
      $('correctionDialog').addEventListener('close', () => { pendingCorrection = null; });
      initialize();
    })();
