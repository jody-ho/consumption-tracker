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

  function summarizeActualSpend(couponEntries, startDate, endDate) {
    const byMember = Object.create(null);
    const groupedTransactions = new Map();
    const getMember = member => {
      if (!byMember[member]) byMember[member] = { totalCents: 0, hasUnrecorded: false };
      return byMember[member];
    };
    const entries = Array.isArray(couponEntries) ? couponEntries : Object.values(couponEntries || {});

    for (const coupon of entries) {
      if (!coupon || !coupon.used) continue;
      const member = String(coupon.member || '').trim();
      if (!member) continue;
      const redemption = coupon.redemption;
      let date = String(redemption && redemption.date || '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        const rawUsedAt = coupon.usedAt;
        const numericUsedAt = Number(rawUsedAt);
        const usedAtDate = new Date(numericUsedAt);
        if (rawUsedAt !== null && rawUsedAt !== undefined && String(rawUsedAt).trim() !== '' && Number.isFinite(usedAtDate.getTime())) {
          date = `${usedAtDate.getFullYear()}-${String(usedAtDate.getMonth() + 1).padStart(2, '0')}-${String(usedAtDate.getDate()).padStart(2, '0')}`;
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

  function estimateUnusedGovernmentSpend(couponEntries) {
    const byMember = Object.create(null);
    const entries = Array.isArray(couponEntries) ? couponEntries : Object.values(couponEntries || {});
    for (const coupon of entries) {
      if (!coupon || coupon.used !== false || coupon.type !== 'gov') continue;
      const member = String(coupon.member || '').trim();
      const amountCents = toCents(coupon.amount);
      if (!member || !Number.isInteger(amountCents) || amountCents < 0) continue;
      byMember[member] = (byMember[member] || 0) + amountCents * 2;
    }
    return {
      byMember,
      totalCents: Object.values(byMember).reduce((sum, amountCents) => sum + amountCents, 0)
    };
  }

  function filterWalletRedemptions(walletRedemptions, member = 'all', payment = 'all') {
    const rows = Array.isArray(walletRedemptions) ? walletRedemptions : [];
    return rows.filter(wallet => wallet &&
      (member === 'all' || wallet.member === member) &&
      (payment === 'all' || wallet.payment === payment));
  }

  function validateRedemptionThresholds(actualPaidCents, governmentAmountCents, merchantCount = 0) {
    const paid = Number(actualPaidCents);
    const government = Number(governmentAmountCents);
    const merchant = Number(merchantCount);
    const inputsValid = Number.isInteger(paid) && paid >= 0 && Number.isInteger(government) && government >= 0 && Number.isInteger(merchant) && merchant >= 0;
    const safePaid = Number.isInteger(paid) && paid >= 0 ? paid : 0;
    const safeGovernment = Number.isInteger(government) && government >= 0 ? government : 0;
    const safeMerchant = Number.isInteger(merchant) && merchant >= 0 ? merchant : 0;
    const netBeforeGovernmentCents = safePaid + safeGovernment;
    const governmentThresholdCents = safeGovernment * 3;
    const governmentShortfallCents = safeGovernment > 0 ? Math.max(0, governmentThresholdCents - netBeforeGovernmentCents) : 0;
    const purchaseBeforeMerchantDiscountCents = netBeforeGovernmentCents + safeMerchant * MERCHANT_DISCOUNT_CENTS;
    const merchantShortfallCents = safeMerchant > 0 ? Math.max(0, MERCHANT_MIN_CENTS - purchaseBeforeMerchantDiscountCents) : 0;
    return {
      valid: inputsValid && safeMerchant <= 1 && governmentShortfallCents === 0 && merchantShortfallCents === 0,
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
          const governmentAmountCents = bucket.reduce((sum, coupon) => sum + Number(coupon.amount) * CENTS, 0);
          // The program checks net transaction spend after merchant/payment discounts, before e-vouchers.
          const governmentThresholdCents = governmentAmountCents * 3;
          const netSpendBeforeGovernmentCents = governmentThresholdCents;
          const minSpendCents = usesMerchant
            ? Math.max(MERCHANT_MIN_CENTS, netSpendBeforeGovernmentCents + MERCHANT_DISCOUNT_CENTS)
            : netSpendBeforeGovernmentCents;
          return {
            member: group.member,
            payment: group.payment,
            governmentCoupons: [...bucket],
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
        const targetGovernmentAmountCents = toCents(transaction.governmentAmount) + faceCents;
        const targetGovCents = targetGovernmentAmountCents * 3;
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

  const api = { planHousehold, optimizeRemaining, groupChoices, nextGovernmentCoupon, nextMerchantCoupon, summarizeActualSpend, estimateUnusedGovernmentSpend, filterWalletRedemptions, validateRedemptionThresholds };
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
      const CAMPAIGN_START = new Date(2026, 9, 9, 12);
      const CAMPAIGN_END = new Date(2026, 11, 17, 12);
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
          end.setDate(end.getDate() + 6);
          if (end > CAMPAIGN_END) end.setTime(CAMPAIGN_END.getTime());
          const index = weeks.length;
          weeks.push({
            key: `2026R2-W${index + 1}`,
            start,
            end,
            label: `第 ${index + 1} 週（${start.getMonth() + 1}/${start.getDate()}–${end.getMonth() + 1}/${end.getDate()}）`
          });
          start = new Date(start);
          start.setDate(start.getDate() + 7);
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
      const localDateKey = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

      let database = null;
      let weekReference = null;
      let settingsReference = null;
      const walletSaveQueues = Object.create(null);
      let online = false;
      let currentWeek = WEEKS[0].key;
      let coupons = Object.create(null);
      let pendingRedemption = null;
      let pendingWalletRedemption = null;
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
          const coupon = { type: row.type, member: row.member, payment: row.payment, used: row.used };
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
            const date = String(redemption.date || '');
            const rawActualPaidCents = redemption.actualPaidCents;
            const actualPaidCents = Number(rawActualPaidCents);
            if (rawActualPaidCents !== null && rawActualPaidCents !== undefined && String(rawActualPaidCents).trim() !== '' && /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isInteger(actualPaidCents) && actualPaidCents >= 0) {
              const sanitizedRedemption = { date, actualPaidCents };
              const transactionId = String(redemption.transactionId || '');
              if (/^[A-Za-z0-9_-]{1,100}$/.test(transactionId)) sanitizedRedemption.transactionId = transactionId;
              coupon.redemption = sanitizedRedemption;
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
        renderDrawStates();
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

      function renderDrawStates() {
        const totals = { govAwarded: 0, govUnused: 0, govUsed: 0, merchantDrawn: 0, giftDrawn: 0, merchant: 0, gift: 0, registered: 0, wallets: 0 };
        const weekExpired = isWeekExpired(currentWeek);
        const estimatedSpend = weekExpired
          ? { byMember: Object.create(null), totalCents: 0 }
          : ConsumeCalc.estimateUnusedGovernmentSpend(Object.values(coupons));
        const estimatedSpendValue = weekExpired ? '已過期' : `MOP ${formatMop(estimatedSpend.totalCents / CENTS)}`;
        const drawnRows = [];
        const undrawnRows = [];
        const compareRows = [];
        const walletRedemptions = [];
        let undrawnWallets = 0;

        for (const member of MEMBERS) {
          const memberTotals = { govAwarded: 0, govUnused: 0, govUsed: 0, merchantDrawn: 0, giftDrawn: 0, merchant: 0, gift: 0, registered: 0, wallets: 0 };
          let memberUndrawn = 0;
          for (const payment of activeWallets(member)) {
            totals.wallets++;
            memberTotals.wallets++;
            const records = Object.entries(coupons)
              .filter(([, coupon]) => coupon.member === member && coupon.payment === payment)
              .map(([id, coupon]) => ({ ...coupon, id }))
              .sort((a, b) => (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0));
            const redeemable = isWeekExpired(currentWeek) ? [] : records.filter(coupon => !coupon.used && ['gov', 'merchant', 'gift'].includes(coupon.type));
            if (redeemable.length) walletRedemptions.push({ member, payment, coupons: redeemable });
            const registered = records.length > 0;
            if (registered) {
              totals.registered++;
              memberTotals.registered++;
            }
            const government = records.filter(coupon => coupon.type === 'gov');
            const unusedAmount = government.filter(coupon => !coupon.used).reduce((sum, coupon) => sum + coupon.amount, 0);
            const usedAmount = government.filter(coupon => coupon.used).reduce((sum, coupon) => sum + coupon.amount, 0);
            const awardedAmount = unusedAmount + usedAmount;
            const merchantDrawn = records.filter(coupon => coupon.type === 'merchant').length;
            const giftDrawn = records.filter(coupon => coupon.type === 'gift').length;
            const merchantCount = records.filter(coupon => coupon.type === 'merchant' && !coupon.used).length;
            const giftCount = records.filter(coupon => coupon.type === 'gift' && !coupon.used).length;
            totals.govAwarded += awardedAmount;
            totals.govUnused += unusedAmount;
            totals.govUsed += usedAmount;
            totals.merchantDrawn += merchantDrawn;
            totals.giftDrawn += giftDrawn;
            totals.merchant += merchantCount;
            totals.gift += giftCount;
            memberTotals.govAwarded += awardedAmount;
            memberTotals.govUnused += unusedAmount;
            memberTotals.govUsed += usedAmount;
            memberTotals.merchantDrawn += merchantDrawn;
            memberTotals.giftDrawn += giftDrawn;
            memberTotals.merchant += merchantCount;
            memberTotals.gift += giftCount;
            const results = records.length
              ? `<div class="result-pills">${records.map(coupon => resultPill(coupon)).join('')}</div>`
              : '<span class="muted">—</span>';
            const registrationLabel = !registered
              ? '未登記／未抽'
              : records.length >= 3 ? `已登記 ${records.length} 格` : `部分結果 ${records.length}/3 格`;
            if (registered) {
              drawnRows.push(`<tr class="wallet-row">
                <th scope="row" class="member-cell">${escapeHtml(member)}</th>
                <td>${escapeHtml(payment)}</td>
                <td class="num">MOP ${formatMop(awardedAmount)}</td>
                <td class="num">MOP ${formatMop(unusedAmount)}</td>
                <td class="num">MOP ${formatMop(usedAmount)}</td>
                <td class="num">${merchantDrawn} 張</td>
                <td class="num">${giftDrawn} 張</td>
                <td class="result-cell">${results}</td>
                <td><span class="tag status-tag">${registrationLabel}</span></td>
              </tr>`);
            } else {
              undrawnWallets++;
              memberUndrawn++;
              undrawnRows.push(`<tr class="wallet-row">
                <th scope="row" class="member-cell">${escapeHtml(member)}</th>
                <td>${escapeHtml(payment)}</td>
                <td><span class="tag muted-tag">尚未抽／未登記（0/3 格）</span></td>
              </tr>`);
            }
          }
          if (memberTotals.registered) drawnRows.push(`<tr class="member-subtotal">
            <th scope="row" colspan="2">${escapeHtml(member)} · 已抽小計</th>
            <td class="num">MOP ${formatMop(memberTotals.govAwarded)}</td>
            <td class="num">MOP ${formatMop(memberTotals.govUnused)}</td>
            <td class="num">MOP ${formatMop(memberTotals.govUsed)}</td>
            <td class="num">${memberTotals.merchantDrawn} 張</td>
            <td class="num">${memberTotals.giftDrawn} 張</td>
            <td>—</td>
            <td>${memberTotals.registered} / ${memberTotals.wallets} 個方式</td>
          </tr>`);
          if (memberUndrawn) undrawnRows.push(`<tr class="member-subtotal">
            <th scope="row" colspan="2">${escapeHtml(member)} · 未抽小計</th>
            <td>${memberUndrawn} 個支付方式</td>
          </tr>`);
          compareRows.push({ member, ...memberTotals });
        }

        $('memberCompare').innerHTML = `<table class="member-compare-table">
          <thead><tr><th scope="col">家庭成員</th><th scope="col">估算自付</th><th scope="col">電子券抽中總額</th><th scope="col">未核銷電子券</th><th scope="col">已核銷電子券</th><th scope="col">商戶券抽中</th><th scope="col">禮遇券抽中</th><th scope="col">已登記錢包</th></tr></thead>
          <tbody>${compareRows.map(row => {
            const memberEstimateValue = weekExpired
              ? '已過期'
              : `MOP ${formatMop((estimatedSpend.byMember[row.member] || 0) / CENTS)}`;
            return `<tr>
              <th scope="row">${escapeHtml(row.member)}</th>
              <td class="num estimated-spend-cell"><strong>${memberEstimateValue}</strong></td>
              <td class="num amount-cell"><strong>MOP ${formatMop(row.govAwarded)}</strong></td>
              <td class="num">MOP ${formatMop(row.govUnused)}</td><td class="num">MOP ${formatMop(row.govUsed)}</td>
              <td class="num">${row.merchantDrawn} 張</td><td class="num">${row.giftDrawn} 張</td><td class="num">${row.registered} / ${row.wallets}</td>
            </tr>`;
          }).join('')}</tbody>
          <tfoot><tr><th scope="row">全家合計</th><td class="num estimated-spend-cell">${estimatedSpendValue}</td><td class="num">MOP ${formatMop(totals.govAwarded)}</td><td class="num">MOP ${formatMop(totals.govUnused)}</td><td class="num">MOP ${formatMop(totals.govUsed)}</td><td class="num">${totals.merchantDrawn} 張</td><td class="num">${totals.giftDrawn} 張</td><td class="num">${totals.registered} / ${totals.wallets}</td></tr></tfoot>
        </table>`;

        $('drawStats').innerHTML = [
          stat('未核銷電子優惠', `MOP ${formatMop(totals.govUnused)}`),
          stat('未核銷商戶券', `${totals.merchant} 張`),
          stat('未核銷禮遇券', `${totals.gift} 張`),
          stat('已登記錢包', `${totals.registered} / ${totals.wallets}`)
        ].join('');
        const filteredWalletRedemptions = ConsumeCalc.filterWalletRedemptions(
          walletRedemptions,
          $('walletRedemptionMemberFilter').value || 'all',
          $('walletRedemptionPaymentFilter').value || 'all'
        );
        $('walletRedemptionCards').innerHTML = filteredWalletRedemptions.length
          ? filteredWalletRedemptions.map(wallet => `<article class="wallet-redemption-card">
              <div class="wallet-redemption-heading"><h4>${escapeHtml(wallet.member)} · ${escapeHtml(wallet.payment)}</h4><span class="wallet-redemption-count">${wallet.coupons.length} 張可用</span></div>
              <div class="wallet-redemption-coupons">${wallet.coupons.map(coupon => {
                const label = coupon.type === 'gov' ? `電子券 MOP ${formatMop(coupon.amount)}`
                  : coupon.type === 'merchant' ? '商戶券 MOP 100 減 12'
                    : String(coupon.label || '消費禮遇券');
                return `<span class="wallet-redemption-coupon">${escapeHtml(label)}</span>`;
              }).join('')}</div>
              <button class="button" type="button" data-wallet-redemption data-member="${escapeHtml(wallet.member)}" data-payment="${escapeHtml(wallet.payment)}" aria-label="${escapeHtml(wallet.member)} ${escapeHtml(wallet.payment)} 直接核銷">直接核銷</button>
            </article>`).join('')
          : `<p class="wallet-redemption-empty">${walletRedemptions.length
            ? '目前篩選沒有符合的未核銷券，請選「全部」或改選其他家人／支付方式。'
            : weekExpired ? '所選週已過期，只能查看券紀錄。' : '本週沒有未核銷券；未登記／未開獎的錢包會在下方狀態明細顯示。'}</p>`;
        $('drawnStates').innerHTML = `<table class="weekly-detail-table">
          <thead><tr><th scope="col">家庭成員</th><th scope="col">支付方式</th><th scope="col">電子券抽中總額</th><th scope="col">未核銷電子優惠</th><th scope="col">已核銷電子優惠</th><th scope="col">商戶券抽中</th><th scope="col">禮遇券抽中</th><th scope="col">三次抽獎結果</th><th scope="col">登記狀態</th></tr></thead>
          <tbody>${drawnRows.length ? drawnRows.join('') : '<tr class="empty-row"><td colspan="9">本週尚未有已抽／登記結果。</td></tr>'}</tbody>
          <tfoot><tr><th scope="row" colspan="2">已抽合計</th><td class="num">MOP ${formatMop(totals.govAwarded)}</td><td class="num">MOP ${formatMop(totals.govUnused)}</td><td class="num">MOP ${formatMop(totals.govUsed)}</td><td class="num">${totals.merchantDrawn} 張</td><td class="num">${totals.giftDrawn} 張</td><td>—</td><td>${totals.registered} / ${totals.wallets} 個方式</td></tr></tfoot>
        </table>`;
        $('undrawnStates').innerHTML = `<table class="weekly-detail-table undrawn-table">
          <thead><tr><th scope="col">家庭成員</th><th scope="col">支付方式</th><th scope="col">本週狀態</th></tr></thead>
          <tbody>${undrawnRows.length ? undrawnRows.join('') : `<tr class="empty-row"><td colspan="3">${totals.wallets ? '所有已啟用的支付方式都已有抽獎紀錄。' : '目前沒有啟用的家庭支付方式。'}</td></tr>`}</tbody>
          <tfoot><tr><th scope="row" colspan="2">尚未抽合計</th><td>${undrawnWallets} 個支付方式</td></tr></tfoot>
        </table>`;
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
        const walletTotals = Object.fromEntries(WALLETS.map(wallet => [wallet, { amount: 0, count: 0 }]));
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
                walletTotals[coupon.payment].amount += coupon.amount;
                walletTotals[coupon.payment].count++;
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
        const bestMember = MEMBERS.map(member => ({ name: member, ...memberTotals[member] }))
          .filter(row => row.amount > 0).sort((a, b) => b.amount - a.amount || MEMBERS.indexOf(a.name) - MEMBERS.indexOf(b.name))[0];
        const bestWallet = WALLETS.map(wallet => ({ name: wallet, ...walletTotals[wallet] }))
          .filter(row => row.amount > 0).sort((a, b) => b.amount - a.amount || WALLETS.indexOf(a.name) - WALLETS.indexOf(b.name))[0];
        $('funStats').innerHTML = [
          `<div class="stat"><strong>${bestMember ? `${escapeHtml(bestMember.name)} · MOP ${formatMop(bestMember.amount)}` : '尚無電子優惠'}</strong><span>手氣王${bestMember ? ` · 商戶券 ${bestMember.merchant} 張／禮遇券 ${bestMember.gift} 張` : ''}</span></div>`,
          `<div class="stat"><strong>${bestWallet ? `${escapeHtml(bestWallet.name)} · MOP ${formatMop(bestWallet.amount)}` : '尚無電子優惠'}</strong><span>最強平台 · 按電子優惠面值加總</span></div>`,
          `<div class="stat"><strong>商戶 ${merchantTotal} 張 · 禮遇 ${giftTotal} 張</strong><span>${mode === 'all' ? '全期非現金獎券' : '本週非現金獎券'}</span></div>`
        ].join('');
        const cachedWeeks = Object.keys(periodData || {}).length;
        const periodText = mode === 'all' ? `全期 ${cachedWeeks}/${WEEKS.length} 週` : '本週';
        const completeness = mode === 'all' && !online
          ? `離線僅統計本機已載入週次（${cachedWeeks}/${WEEKS.length}）；連線後可取得全期。`
          : allPeriodStatsError;
        $('funStatsNote').textContent = `${periodText}；排行金額只計政府電子優惠，商戶券／禮遇券另列張數。${completeness ? ` ${completeness}` : ''}`;
      }

      function renderRegistrationStatus() {
        const member = $('recordMember').value;
        const payment = $('recordWallet').value;
        if (!member || !payment) {
          $('recordStatus').textContent = '此成員尚未在家庭支付設定啟用方式。';
          return;
        }
        const recordCount = Object.values(coupons).filter(coupon => coupon.member === member && coupon.payment === payment).length;
        $('recordStatus').textContent = recordCount
          ? `${member} · ${payment} 本週已有 ${recordCount} 項結果紀錄；如需整批重登，請先在券庫移除此錢包的三項結果。`
          : `${member} · ${payment} 本週未有結果紀錄；三格儲存後會自動列為已登記。`;
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
          ? ConsumeCalc.summarizeActualSpend(Object.values(coupons), localDateKey(selectedWeek.start), localDateKey(selectedWeek.end))
          : { byMember: Object.create(null), totalCents: 0, hasUnrecorded: false };
        const spendLabel = (totalCents, hasUnrecorded) => {
          const amountText = `MOP ${formatMop(totalCents / CENTS)}`;
          return hasUnrecorded ? (totalCents > 0 ? `${amountText} + 未記錄` : '未記錄') : amountText;
        };
        $('actualSpendSummary').innerHTML = `<table class="actual-spend-table">
          <thead><tr><th scope="col">家庭成員</th><th scope="col">實際自付</th></tr></thead>
          <tbody>${MEMBERS.map(member => {
            const spend = actualSpend.byMember[member];
            return `<tr><th scope="row">${escapeHtml(member)}</th><td class="num">${spendLabel(spend?.totalCents || 0, Boolean(spend?.hasUnrecorded))}</td></tr>`;
          }).join('')}</tbody>
          <tfoot><tr><th scope="row">全家合計</th><td class="num">${spendLabel(actualSpend.totalCents, actualSpend.hasUnrecorded)}</td></tr></tfoot>
        </table>`;
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
            if (statusFilter === 'unused') return !coupon.used && ['gov', 'merchant', 'gift'].includes(coupon.type);
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
        </section>`).join('');
      }

      function couponRedemptionSummary(coupon) {
        if (!coupon.used) return '';
        if (!coupon.redemption) return '<div class="redemption-summary">實付金額未記錄（舊紀錄未保存）</div>';
        return `<div class="redemption-summary">核銷日期 ${escapeHtml(coupon.redemption.date)}；實付 MOP ${formatMop(coupon.redemption.actualPaidCents / CENTS)}</div>`;
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
            <button class="button danger small" type="button" data-action="delete" data-id="${escapeHtml(coupon.id)}" aria-label="刪除${escapeHtml(coupon.member)} ${escapeHtml(coupon.payment)} 的${escapeHtml(couponName(coupon))}">刪除</button>
          </div>
        </div>`;
      }

      function renderSlots() {
        const choices = GOV_AMOUNTS.map(amount => ({ value: String(amount), label: `MOP ${amount}`, ariaLabel: `政府電子優惠 MOP ${amount}` }))
          .concat([
            { value: 'merchant', label: '商戶券', ariaLabel: '商戶滿 MOP 100 減 MOP 12' },
            { value: 'gift', label: '禮遇券', ariaLabel: '消費禮遇券' }
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
          ? `<div class="plan-actions"><button class="button" type="button" data-use-plan="${index}">確認核銷本方案（電子券 ${option.usedGovernmentCoupons.length} 張／商戶券 ${option.usedMerchantCoupons.length} 張）</button></div>`
          : '';
        return `<article class="plan-card ${index === 0 ? 'best' : ''}">
          <h3>${escapeHtml(title)}</h3>
          <div class="plan-amount-hero">
            <span>全家預估自付</span>
            <strong>MOP ${formatMop(option.totalPay)}</strong>
            <small>計劃總消費 MOP ${formatMop(plan.total)} − 用券折抵 MOP ${formatMop(option.discount)}</small>
          </div>
          ${nextCouponHints(option)}
          ${planBreakdown(option, plan)}
          <p class="breakdown-note">每單商戶券限 1 張；政府券可多張。順序：商戶券 → 電子券門檻 → 自付。表格可左右滑動。</p>
          <details class="plan-details">
            <summary>查看分單與實際用券明細（${option.transactions.length} 筆）</summary>
            <div class="plan-details-content">
              ${firstTransaction}${transactions}${unallocated}
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
        const today = currentMacauDate();
        return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
      }

      function redemptionDateInCurrentWeek(value) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
        const week = WEEKS.find(item => item.key === currentWeek);
        if (!week) return false;
        const date = new Date(`${value}T12:00:00`);
        return Number.isFinite(date.getTime()) && date >= week.start && date <= week.end;
      }

      function openCouponRedemption(id) {
        const coupon = coupons[id];
        if (!coupon || !['gov', 'merchant', 'gift'].includes(coupon.type)) return;
        const transaction = {
          member: coupon.member,
          payment: coupon.payment,
          couponIds: [id],
          governmentCoupons: coupon.type === 'gov' ? [coupon] : [],
          pay: null
        };
        openRedemptionDialog([id], [transaction]);
      }

      function openWalletRedemption(member, payment) {
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
        pendingWalletRedemption = { member, payment, candidates };
        $('walletRedeemTitle').textContent = `直接核銷 · ${member} · ${payment}`;
        $('walletRedeemIntro').textContent = '勾選本次同一筆交易實際使用的券。政府電子券可多張；每單最多一張商戶券。下一步會要求輸入實付並顯示核對摘要。';
        $('walletRedeemChoices').innerHTML = candidates.map(coupon => {
          const label = coupon.type === 'gov' ? `政府電子優惠 MOP ${formatMop(coupon.amount)}`
            : coupon.type === 'merchant' ? '商戶滿 MOP 100 減 MOP 12'
              : String(coupon.label || '消費禮遇券');
          return `<label class="wallet-redeem-option"><input type="checkbox" data-wallet-coupon="${escapeHtml(coupon.id)}"><span><strong>${escapeHtml(label)}</strong><small>${escapeHtml(couponTypeName(coupon.type))} · ${escapeHtml(coupon.member)}／${escapeHtml(coupon.payment)}</small></span></label>`;
        }).join('');
        $('walletRedeemStatus').className = 'notice neutral';
        $('walletRedeemStatus').textContent = '請勾選本次要用的券；未勾選的券會保留。';
        $('continueWalletRedeem').disabled = true;
        $('walletRedeemDialog').showModal();
        $('walletRedeemChoices').querySelector('input')?.focus({ preventScroll: true });
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
            ? `已選 ${selected.length} 張：${selected.map(coupon => couponName(coupon)).join('、')}。下一步填實付金額並核對摘要。`
            : '請勾選本次同一筆交易要使用的券；未勾選的券會保留。';
        $('continueWalletRedeem').disabled = !valid;
        return { valid, selected };
      }

      function continueWalletRedemption(event) {
        event.preventDefault();
        const selection = updateWalletRedemptionSelection();
        if (!selection.valid || !pendingWalletRedemption) return;
        const { member, payment } = pendingWalletRedemption;
        const couponIds = selection.selected.map(coupon => coupon.id);
        const transaction = {
          member,
          payment,
          couponIds,
          governmentCoupons: selection.selected.filter(coupon => coupon.type === 'gov'),
          pay: null
        };
        $('walletRedeemDialog').close();
        pendingWalletRedemption = null;
        openRedemptionDialog(couponIds, [transaction]);
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
          return {
            index,
            member: transaction.member,
            payment: transaction.payment,
            couponIds: transactionIds,
            coupons: transactionCoupons,
            governmentAmountCents,
            thresholdCents: governmentAmountCents * 3,
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

        pendingRedemption = { ids, transactions: normalized };
        $('redeemDate').value = redemptionDateInputValue();
        $('redeemTransactions').innerHTML = normalized.map(transaction => {
          const amountId = `redeemAmount-${transaction.index}`;
          const value = transaction.payCents === null ? '' : (transaction.payCents / CENTS).toFixed(2);
          const placeholder = transaction.governmentAmountCents
            ? (2 * transaction.governmentAmountCents / CENTS).toFixed(2)
            : '按支付平台記錄輸入';
          const merchantCoupons = transaction.coupons.filter(coupon => coupon.type === 'merchant');
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
          if (transaction.governmentAmountCents) ruleParts.push(`政府券折抵前淨額須達 MOP ${formatMop(transaction.thresholdCents / CENTS)}（電子券面額總和的 3 倍）。`);
          if (merchantCoupons.length) ruleParts.push('商戶券每筆限 1 張，優惠前消費須達 MOP 100。');
          const rule = ruleParts.length
            ? `<p class="muted">${ruleParts.join('')}</p>`
            : '<p class="muted">請按支付平台交易記錄輸入本次實付金額。</p>';
          const showThresholdStatus = transaction.governmentAmountCents > 0 || merchantCoupons.length > 0;
          return `<section class="redeem-transaction">
            <h3>${escapeHtml(transaction.member)} · ${escapeHtml(transaction.payment)}</h3>
            ${couponGroups}
            ${couponOrder}
            <label for="${amountId}">實付金額（MOP，按交易記錄輸入）</label>
            <input id="${amountId}" class="control" data-redemption-amount="${transaction.index}" type="number" min="0" step="0.01" inputmode="decimal" value="${value}" placeholder="${escapeHtml(placeholder)}" required>
            ${rule}
            ${showThresholdStatus ? `<p id="redeemThreshold-${transaction.index}" class="redeem-threshold-status" role="status" aria-live="polite"></p>` : ''}
          </section>`;
        }).join('');
        $('redeemValidation').textContent = '只記錄下方列出的券與實付金額。';
        $('redeemValidation').classList.remove('invalid');
        $('redeemDialog').showModal();
        validateRedemptionForm();
        $('redeemDate').focus({ preventScroll: true });
      }

      function validateRedemptionForm() {
        const failures = [];
        if (!pendingRedemption?.ids.length) failures.push('請先選擇本次要核銷的券。');
        if (!redemptionDateInCurrentWeek($('redeemDate').value)) failures.push('核銷日期須在所選活動週內。');
        const amounts = [];
        const summaries = [];
        for (const transaction of pendingRedemption?.transactions || []) {
          const input = $(`redeemAmount-${transaction.index}`);
          const paidCents = input && input.value !== '' ? toCents(input.value) : NaN;
          amounts[transaction.index] = paidCents;
          const status = $(`redeemThreshold-${transaction.index}`);
          if (!Number.isFinite(paidCents) || paidCents < 0) {
            failures.push(`請填寫 ${transaction.member} · ${transaction.payment} 的實付金額。`);
            if (status) status.textContent = '請先按交易記錄輸入實付金額。';
            continue;
          }

          const merchantCount = transaction.coupons.filter(coupon => coupon.type === 'merchant').length;
          const check = ConsumeCalc.validateRedemptionThresholds(paidCents, transaction.governmentAmountCents, merchantCount);
          const transactionFailures = [];
          if (check.merchantLimitExceeded) {
            transactionFailures.push('每筆交易最多核銷一張商戶券。');
            failures.push(`${transaction.member} · ${transaction.payment}：每筆交易最多核銷一張商戶券。`);
          }
          if (check.governmentShortfallCents > 0) {
            transactionFailures.push(`電子券門檻尚差 MOP ${formatMop(check.governmentShortfallCents / CENTS)}`);
            failures.push(`${transaction.member} · ${transaction.payment} 電子券前淨額尚差 MOP ${formatMop(check.governmentShortfallCents / CENTS)}；本單至少須實付 MOP ${formatMop((check.governmentThresholdCents - transaction.governmentAmountCents) / CENTS)}。`);
          }
          if (check.merchantShortfallCents > 0) {
            transactionFailures.push(`商戶券最低消費尚差 MOP ${formatMop(check.merchantShortfallCents / CENTS)}`);
            failures.push(`${transaction.member} · ${transaction.payment} 使用商戶券時，優惠前消費尚差 MOP ${formatMop(check.merchantShortfallCents / CENTS)}（需達 MOP 100）。`);
          }
          if (status) {
            const ruleParts = [];
            if (transaction.governmentAmountCents) ruleParts.push(`政府券前淨額 MOP ${formatMop(check.netBeforeGovernmentCents / CENTS)}／門檻 MOP ${formatMop(check.governmentThresholdCents / CENTS)}`);
            if (merchantCount) ruleParts.push(`商戶券優惠前消費 MOP ${formatMop(check.purchaseBeforeMerchantDiscountCents / CENTS)}／最低 MOP 100`);
            status.textContent = `${ruleParts.join('；')}；${transactionFailures.length ? transactionFailures.join('；') : '門檻符合'}；本次實付 MOP ${formatMop(paidCents / CENTS)}。`;
            status.classList.toggle('shortfall', transactionFailures.length > 0);
          }
          const summaryParts = [`${transaction.member} · ${transaction.payment}：實付 MOP ${formatMop(paidCents / CENTS)}`];
          if (transaction.governmentAmountCents) summaryParts.push(`政府券前淨額 MOP ${formatMop(check.netBeforeGovernmentCents / CENTS)}／門檻 MOP ${formatMop(check.governmentThresholdCents / CENTS)}`);
          if (merchantCount) summaryParts.push(`商戶券優惠前消費 MOP ${formatMop(check.purchaseBeforeMerchantDiscountCents / CENTS)}／最低 MOP 100`);
          summaries.push(summaryParts.join('；'));
        }
        const validation = $('redeemValidation');
        validation.textContent = failures.length
          ? failures.join(' ')
          : `核對完成：${summaries.join('；')}。共 ${pendingRedemption?.ids.length || 0} 張券；按「確認並記錄核銷」後才會標記已核銷。`;
        validation.classList.toggle('invalid', failures.length > 0);
        $('confirmRedemption').disabled = failures.length > 0 || !pendingRedemption?.ids.length;
        return { valid: failures.length === 0, amounts };
      }

      async function submitRedemption(event) {
        event.preventDefault();
        const check = validateRedemptionForm();
        if (!check.valid || !pendingRedemption) return;
        const { ids, transactions } = pendingRedemption;
        if (ids.some(id => !coupons[id] || coupons[id].used)) {
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
          const redemption = {
            date: redeemedOn,
            actualPaidCents: check.amounts[transaction.index],
            transactionId: `${usedAt}-${transactionNonce}-${transaction.index}`
          };
          for (const id of transaction.couponIds) byCoupon.set(id, redemption);
        }
        const updates = {};
        const updatedCoupons = {};
        for (const id of ids) {
          const redemption = byCoupon.get(id);
          updates[`coupons/${id}/used`] = true;
          updates[`coupons/${id}/usedAt`] = usedAt;
          updates[`coupons/${id}/redemption`] = redemption;
          updatedCoupons[id] = { ...coupons[id], used: true, usedAt, redemption };
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

      function redeemPlan(index) {
        const option = lastCalculatedPlan?.plans[index];
        if (!option || !option.usedCouponIds.length) return;
        const transactions = option.transactions.map(transaction => ({
          member: transaction.member,
          payment: transaction.payment,
          couponIds: [
            transaction.merchantCoupon?.id,
            ...transaction.governmentCoupons.map(coupon => coupon.id)
          ].filter(Boolean),
          governmentCoupons: transaction.governmentCoupons,
          pay: transaction.pay
        })).filter(transaction => transaction.couponIds.length);
        openRedemptionDialog(option.usedCouponIds, transactions);
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

      function storeBatch(rows) {
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
        invalidateAllPeriodStats();
        if (online && database) {
          return database.ref(`${weekPath()}/coupons/${id}`).set(value)
            .catch(() => {
              if (value === null) delete coupons[id];
              else coupons[id] = value;
              saveLocal();
              render();
              showToast('雲端儲存失敗；變更只保存在此裝置。');
            });
        }
        if (value === null) delete coupons[id];
        else coupons[id] = value;
        saveLocal();
        render();
        return Promise.resolve();
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
        const parts = new Intl.DateTimeFormat('en-CA', {
          timeZone: 'Asia/Macau', year: 'numeric', month: '2-digit', day: '2-digit'
        }).formatToParts(new Date());
        const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
        return new Date(Number(values.year), Number(values.month) - 1, Number(values.day), 12);
      }

      function isWeekExpired(weekKey) {
        const week = WEEKS.find(item => item.key === (weekKey || currentWeek));
        return Boolean(week && currentMacauDate() > week.end);
      }

      function renderWeekExpiry() {
        const week = WEEKS.find(item => item.key === currentWeek);
        if (!week) return;
        const weekday = ['日', '一', '二', '三', '四', '五', '六'][week.end.getDay()];
        const expiry = `${week.end.getMonth() + 1}/${week.end.getDate()}（週${weekday}）23:59`;
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
        if (!calculatePlan()) return;
        const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        $('calcResults').scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
      });
      $('totalSpend').addEventListener('input', renderCalc);
      $('firstSpend').addEventListener('input', renderCalc);
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
        redeemPlan(Number(button.dataset.usePlan));
      });
      $('redeemForm').addEventListener('submit', submitRedemption);
      $('redeemDate').addEventListener('input', validateRedemptionForm);
      $('redeemTransactions').addEventListener('input', event => {
        if (event.target.matches('[data-redemption-amount]')) validateRedemptionForm();
      });
      $('cancelRedemption').addEventListener('click', () => $('redeemDialog').close());
      $('redeemDialog').addEventListener('close', () => { pendingRedemption = null; });
      $('walletRedeemForm').addEventListener('submit', continueWalletRedemption);
      $('walletRedeemChoices').addEventListener('change', updateWalletRedemptionSelection);
      $('cancelWalletRedeem').addEventListener('click', () => $('walletRedeemDialog').close());
      $('walletRedeemDialog').addEventListener('close', () => { pendingWalletRedemption = null; });

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
        storeBatch(rows).finally(() => { $('saveDraw').disabled = false; });
      });
      $('memberSettings').addEventListener('change', event => {
        const input = event.target.closest('[data-member][data-wallet]');
        if (!input) return;
        walletConfig[input.dataset.member][input.dataset.wallet] = input.checked;
        saveWalletSettings(input.dataset.member);
      });
      $('walletRedemptionCards').addEventListener('click', event => {
        const button = event.target.closest('[data-wallet-redemption]');
        if (!button) return;
        openWalletRedemption(button.dataset.member, button.dataset.payment);
      });
      $('walletRedemptionMemberFilter').addEventListener('change', renderDrawStates);
      $('walletRedemptionPaymentFilter').addEventListener('change', renderDrawStates);
      $('couponList').addEventListener('click', event => {
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
          writeCoupon(id, null).then(() => showToast('結果已刪除。'));
          return;
        }
        if (button.dataset.action === 'redeem') openCouponRedemption(id);
      });

      $('export').addEventListener('click', exportBackup);
      $('import').addEventListener('change', importBackup);
      document.querySelectorAll('[data-nav]').forEach(button => button.addEventListener('click', () => setActivePanel(button.dataset.nav)));
      initialize();
    })();
