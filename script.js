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

  function validGovernmentCoupon(coupon) {
    const amount = Number(coupon && coupon.amount);
    return Boolean(coupon && !coupon.used && coupon.type === 'gov' && GOV_DENOMINATIONS.has(amount));
  }

  function validMerchantCoupon(coupon) {
    return Boolean(coupon && !coupon.used && coupon.type === 'merchant');
  }

  function groupGovernmentCoupons(entries) {
    const groups = new Map();
    for (const coupon of entries || []) {
      if (!validGovernmentCoupon(coupon)) continue;
      const member = String(coupon.member || '');
      const payment = String(coupon.payment || '');
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
          const governmentThresholdCents = governmentAmountCents * 3;
          const minSpendCents = usesMerchant
            ? Math.max(MERCHANT_MIN_CENTS, governmentThresholdCents + MERCHANT_DISCOUNT_CENTS)
            : governmentThresholdCents;
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
    const merchantLimit = Math.min(stock.length, Math.floor(budgetCents / MERCHANT_MIN_CENTS));
    if (requireMerchant && merchantLimit < 1) return null;

    let states = new Map([['0|0', {
      costCents: 0,
      discountCents: 0,
      governmentCount: 0,
      merchantCount: 0,
      transactions: []
    }]]);

    for (const group of groupGovernmentCoupons(governmentEntries)) {
      const choices = groupChoices(group, merchantLimit);
      const next = new Map(states);
      for (const state of states.values()) {
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
      states = next;
    }

    const completed = new Map();
    const fallback = normalizeFallbackWallet(fallbackWallet);
    for (const state of states.values()) {
      const maxStandalone = Math.min(
        merchantLimit - state.merchantCount,
        Math.floor((budgetCents - state.costCents) / MERCHANT_MIN_CENTS)
      );
      for (let count = 0; count <= maxStandalone; count++) {
        const merchantTransactions = Array.from({ length: count }, () => ({
          member: fallback.member,
          payment: fallback.payment,
          governmentCoupons: [],
          governmentAmountCents: 0,
          governmentThresholdCents: 0,
          minSpendCents: MERCHANT_MIN_CENTS,
          usesMerchant: true,
          merchantOnly: true
        }));
        keepBest(completed, {
          costCents: state.costCents + count * MERCHANT_MIN_CENTS,
          discountCents: state.discountCents + count * MERCHANT_DISCOUNT_CENTS,
          governmentCount: state.governmentCount,
          merchantCount: state.merchantCount + count,
          transactions: [...state.transactions, ...merchantTransactions]
        });
      }
    }

    let best = null;
    for (const state of completed.values()) {
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
      merchantOnly: transaction.merchantOnly
    }));

    const usedMerchantCoupons = [];
    for (const transaction of transactions) {
      if (!transaction.usesMerchant) continue;
      const coupon = stock[usedMerchantCoupons.length];
      if (coupon) {
        transaction.merchantCoupon = coupon;
        usedMerchantCoupons.push(coupon);
      }
    }

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
        transaction.governmentCoupons.length > 0 &&
        transaction.member === coupon.member && transaction.payment === coupon.payment
      );
      for (const transaction of sameWalletTransactions) {
        const oldFaceCents = toCents(transaction.governmentAmount);
        const targetGovCents = (oldFaceCents + faceCents) * 3;
        const targetSpendCents = transaction.usesMerchant
          ? Math.max(MERCHANT_MIN_CENTS, targetGovCents + MERCHANT_DISCOUNT_CENTS)
          : targetGovCents;
        const targetTotalCents = allocatedCents - toCents(transaction.minSpend) + targetSpendCents;
        const additionalCents = Math.max(0, targetTotalCents - budgetCents);
        if (!best || additionalCents < best.additionalCents) best = { coupon, additionalCents };
      }
      const standAloneSpend = faceCents * 3;
      const additionalCents = Math.max(0, allocatedCents + standAloneSpend - budgetCents);
      if (!best || additionalCents < best.additionalCents) best = { coupon, additionalCents };
    }
    return best ? { coupon: best.coupon, additionalSpend: fromCents(best.additionalCents) } : null;
  }

  function nextMerchantCoupon(option) {
    const coupon = (option.unusedMerchantCoupons || [])[0];
    if (!coupon) return null;
    const budgetCents = toCents(option.amount);
    const allocatedCents = toCents(option.allocatedSpend);
    let bestCents = Math.max(0, allocatedCents + MERCHANT_MIN_CENTS - budgetCents);
    for (const transaction of option.transactions) {
      if (transaction.usesMerchant) continue;
      const targetSpendCents = Math.max(
        MERCHANT_MIN_CENTS,
        toCents(transaction.governmentThreshold) + MERCHANT_DISCOUNT_CENTS
      );
      const targetTotalCents = allocatedCents - toCents(transaction.minSpend) + targetSpendCents;
      bestCents = Math.min(bestCents, Math.max(0, targetTotalCents - budgetCents));
    }
    return { coupon, additionalSpend: fromCents(bestCents) };
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

    return {
      valid: true,
      total: fromCents(totalCents),
      firstSpend: fromCents(firstCents),
      remaining,
      selectedMembers: selectedMembers ? [...selectedMembers] : null,
      selectedPayments: selectedPayments ? [...selectedPayments] : null,
      merchantAvailableCount: merchantCoupons.length,
      giftAvailableCount: giftCoupons.length,
      plans
    };
  }

  const api = { planHousehold, optimizeRemaining, groupChoices, nextGovernmentCoupon, nextMerchantCoupon };
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
      const DEFAULT_WALLETS = {
        爸爸: { MPay: true },
        媽媽: { MPay: true, 中銀: true, 工銀: true, 大豐: true, 國際: true },
        姐姐: { MPay: true, 中銀: true, 工銀: true, 大豐: true, 支付寶: true, UEPay: true },
        昌哥: { MPay: true, 中銀: true, 工銀: true, 支付寶: true, UEPay: true },
        妹妹: { MPay: true, 中銀: true, 工銀: true, 國際: true, 支付寶: true, UEPay: true }
      };
      const WEEKS = Array.from({ length: 10 }, (_, index) => {
        const start = new Date(2026, 9, 9 + index * 7);
        const end = new Date(start);
        end.setDate(end.getDate() + 6);
        return {
          key: `2026R2-W${index + 1}`,
          start,
          end,
          label: `第 ${index + 1} 週（${start.getMonth() + 1}/${start.getDate()}–${end.getMonth() + 1}/${end.getDate()}）`
        };
      });
      const $ = id => document.getElementById(id);
      const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
      })[character]);
      const formatMop = value => {
        const amount = Math.round((Number(value) + Number.EPSILON) * 100) / 100;
        return new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(amount);
      };

      let database = null;
      let weekReference = null;
      let settingsReference = null;
      const walletSaveQueues = Object.create(null);
      let online = false;
      let currentWeek = WEEKS[0].key;
      let coupons = Object.create(null);
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
          .filter(coupon => walletConfig[coupon.member]?.[coupon.payment]);
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
        const rows = [];
        const compareRows = [];

        for (const member of MEMBERS) {
          const memberTotals = { govAwarded: 0, govUnused: 0, govUsed: 0, merchantDrawn: 0, giftDrawn: 0, merchant: 0, gift: 0, registered: 0, wallets: 0 };
          for (const payment of activeWallets(member)) {
            totals.wallets++;
            memberTotals.wallets++;
            const records = Object.entries(coupons)
              .filter(([, coupon]) => coupon.member === member && coupon.payment === payment)
              .map(([id, coupon]) => ({ ...coupon, id }))
              .sort((a, b) => (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0));
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
            rows.push(`<tr class="wallet-row">
              <td class="member-cell" data-label="家庭成員">${escapeHtml(member)}</td>
              <td data-label="支付方式">${escapeHtml(payment)}</td>
              <td class="result-cell" data-label="三次抽獎結果">${results}</td>
              <td class="num" data-label="未核銷電子優惠">MOP ${formatMop(unusedAmount)}</td>
              <td class="num" data-label="未核銷商戶券">${merchantCount} 張</td>
              <td class="num" data-label="未核銷禮遇券">${giftCount} 張</td>
              <td class="num" data-label="電子券所需基數">MOP ${formatMop(unusedAmount * 3)}</td>
              <td class="num" data-label="已核銷電子優惠">MOP ${formatMop(usedAmount)}</td>
              <td data-label="登記狀態"><span class="tag status-tag ${registered ? '' : 'muted-tag'}">${registrationLabel}</span></td>
            </tr>`);
          }
          if (memberTotals.wallets) rows.push(`<tr class="member-subtotal">
            <td class="subtotal-heading" colspan="3" data-label="家庭成員小計">${escapeHtml(member)} · 小計</td>
            <td class="num" data-label="未核銷電子優惠">MOP ${formatMop(memberTotals.govUnused)}</td>
            <td class="num" data-label="未核銷商戶券">${memberTotals.merchant} 張</td>
            <td class="num" data-label="未核銷禮遇券">${memberTotals.gift} 張</td>
            <td class="num" data-label="電子券所需基數">MOP ${formatMop(memberTotals.govUnused * 3)}</td>
            <td class="num" data-label="已核銷電子優惠">MOP ${formatMop(memberTotals.govUsed)}</td>
            <td data-label="已登記支付方式">${memberTotals.registered} / ${memberTotals.wallets} 已登記</td>
          </tr>`);
          compareRows.push({ member, ...memberTotals });
        }

        const maxAwarded = Math.max(0, ...compareRows.map(row => row.govAwarded));
        $('memberCompare').innerHTML = `<table class="member-compare-table">
          <thead><tr><th scope="col">家庭成員</th><th scope="col">電子券抽中總額</th><th scope="col">未核銷電子券</th><th scope="col">已核銷電子券</th><th scope="col">商戶券抽中</th><th scope="col">禮遇券抽中</th><th scope="col">已登記錢包</th></tr></thead>
          <tbody>${compareRows.map(row => {
            const meter = maxAwarded ? Math.round(row.govAwarded / maxAwarded * 100) : 0;
            return `<tr>
              <th scope="row">${escapeHtml(row.member)}</th>
              <td class="num amount-cell"><strong>MOP ${formatMop(row.govAwarded)}</strong><span class="member-meter" aria-hidden="true"><span style="width:${meter}%"></span></span></td>
              <td class="num">MOP ${formatMop(row.govUnused)}</td><td class="num">MOP ${formatMop(row.govUsed)}</td>
              <td class="num">${row.merchantDrawn} 張</td><td class="num">${row.giftDrawn} 張</td><td class="num">${row.registered} / ${row.wallets}</td>
            </tr>`;
          }).join('')}</tbody>
          <tfoot><tr><th scope="row">全家合計</th><td class="num">MOP ${formatMop(totals.govAwarded)}</td><td class="num">MOP ${formatMop(totals.govUnused)}</td><td class="num">MOP ${formatMop(totals.govUsed)}</td><td class="num">${totals.merchantDrawn} 張</td><td class="num">${totals.giftDrawn} 張</td><td class="num">${totals.registered} / ${totals.wallets}</td></tr></tfoot>
        </table>`;

        $('drawStats').innerHTML = [
          stat('未核銷電子優惠', `MOP ${formatMop(totals.govUnused)}`),
          stat('未核銷商戶券', `${totals.merchant} 張`),
          stat('未核銷禮遇券', `${totals.gift} 張`),
          stat('已登記錢包', `${totals.registered} / ${totals.wallets}`)
        ].join('');
        $('drawStates').innerHTML = `<table class="weekly-table">
          <thead><tr><th>家庭成員</th><th>支付方式</th><th>三次抽獎結果</th><th>未核銷電子優惠</th><th>未核銷商戶券</th><th>未核銷禮遇券</th><th>電子券所需基數</th><th>已核銷電子優惠</th><th>登記狀態</th></tr></thead>
          <tbody>${rows.join('')}</tbody>
          <tfoot><tr class="family-total"><th class="total-heading" colspan="3" data-label="家庭總計">全家合計</th><td class="num" data-label="未核銷電子優惠">MOP ${formatMop(totals.govUnused)}</td><td class="num" data-label="未核銷商戶券">${totals.merchant} 張</td><td class="num" data-label="未核銷禮遇券">${totals.gift} 張</td><td class="num" data-label="電子券所需基數">MOP ${formatMop(totals.govUnused * 3)}</td><td class="num" data-label="已核銷電子優惠">MOP ${formatMop(totals.govUsed)}</td><td data-label="已登記支付方式">${totals.registered} / ${totals.wallets}</td></tr></tfoot>
        </table>`;
      }

      function resultPill(coupon) {
        if (coupon.type === 'gov') {
          return `<span class="result-pill gov-pill ${coupon.used ? 'used' : ''}">電子 MOP ${formatMop(coupon.amount)} · ${coupon.used ? '已用' : '未用'}</span>`;
        }
        if (coupon.type === 'merchant') return `<span class="result-pill merchant-pill ${coupon.used ? 'used' : ''}">商戶 100−12 · ${coupon.used ? '已用' : '未用'}</span>`;
        if (coupon.type === 'gift') return `<span class="result-pill gift-pill ${coupon.used ? 'used' : ''}">消費禮遇券 · ${coupon.used ? '已用' : '未用'}</span>`;
        return '<span class="result-pill zero-pill">謝謝參與</span>';
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
        if (type === 'zero') return '謝謝參與';
        return '未識別結果';
      }

      function couponName(coupon) {
        if (coupon.type === 'gov') return `MOP ${formatMop(coupon.amount)}`;
        if (coupon.type === 'merchant') return '消費滿 MOP 100 減 MOP 12';
        if (coupon.type === 'gift') return String(coupon.label || '消費禮遇券');
        return '謝謝參與';
      }

      function renderCouponVault() {
        const entries = Object.entries(coupons);
        const unusedGovernment = entries.filter(([, coupon]) => coupon.type === 'gov' && !coupon.used);
        const unusedAmount = unusedGovernment.reduce((sum, [, coupon]) => sum + coupon.amount, 0);
        const unusedMerchant = entries.filter(([, coupon]) => coupon.type === 'merchant' && !coupon.used).length;
        const unusedGifts = entries.filter(([, coupon]) => coupon.type === 'gift' && !coupon.used).length;
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
            return true;
          })
          .sort((a, b) => MEMBERS.indexOf(a.member) - MEMBERS.indexOf(b.member) ||
            WALLETS.indexOf(a.payment) - WALLETS.indexOf(b.payment) ||
            (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0));

        $('filterCount').textContent = `顯示 ${filtered.length} 項／本週共 ${entries.length} 項結果；上方摘要固定為全週合計。`;
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
          <h3>${escapeHtml(group.member)} <span aria-hidden="true">·</span> ${escapeHtml(group.payment)}</h3>
          ${group.coupons.map(coupon => couponRow(coupon)).join('')}
        </section>`).join('');
      }

      function couponRow(coupon) {
        const status = coupon.used
          ? '<span class="tag muted-tag">已核銷</span>'
          : ['gov', 'merchant', 'gift'].includes(coupon.type)
            ? '<span class="tag">未核銷</span>'
            : '<span class="tag muted-tag">結果紀錄</span>';
        const actions = ['gov', 'merchant', 'gift'].includes(coupon.type)
          ? `<button class="button secondary small" type="button" data-action="toggle" data-id="${escapeHtml(coupon.id)}">${coupon.used ? '還原' : '核銷'}</button>`
          : '';
        return `<div class="coupon-row">
          <div class="coupon-info">
            ${status}<span class="tag muted-tag">${escapeHtml(couponTypeName(coupon.type))}</span>
            <div class="coupon-name">${escapeHtml(couponName(coupon))}</div>
          </div>
          <div class="coupon-actions">
            ${actions}
            <button class="button danger small" type="button" data-action="delete" data-id="${escapeHtml(coupon.id)}" aria-label="刪除${escapeHtml(coupon.member)} ${escapeHtml(coupon.payment)} 的${escapeHtml(couponName(coupon))}">刪除</button>
          </div>
        </div>`;
      }

      function renderSlots() {
        const choices = GOV_AMOUNTS.map(amount => ({ value: String(amount), label: `電子優惠 MOP ${amount}` }))
          .concat([
            { value: 'merchant', label: '商戶券 MOP 100−12' },
            { value: 'gift', label: '消費禮遇券' },
            { value: 'zero', label: '謝謝參與' }
          ]);
        $('slots').innerHTML = slotSelections.map((selected, index) => `<section class="slot">
          <h3>抽獎結果 ${index + 1}</h3>
          <div class="slot-choices">${choices.map(choice => `<button class="slot-choice" type="button" data-slot-index="${index}" data-result="${choice.value}" aria-pressed="${selected === choice.value}">${escapeHtml(choice.label)}</button>`).join('')}</div>
          <div class="slot-state">${selected === null ? '尚未選擇' : `已選：${escapeHtml(choices.find(choice => choice.value === selected)?.label || '')}`}</div>
        </section>`).join('');
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

      function planCard(option, index, plan) {
        const breakdown = planBreakdown(option, plan);
        const transactions = option.transactions.map((transaction, transactionIndex) => {
          const governmentText = transaction.governmentCoupons.length
            ? `政府券 ${transaction.governmentCoupons.map(coupon => `MOP ${formatMop(coupon.amount)}`).join(' + ')}`
            : '';
          const merchantText = transaction.usesMerchant ? '商戶券 − MOP 12' : '';
          const merchantSource = transaction.merchantCoupon
            ? `<div class="coupon-source">商戶券來源：${escapeHtml(transaction.merchantCoupon.member)} · ${escapeHtml(transaction.merchantCoupon.payment)}</div>`
            : '';
          const thresholdText = transaction.governmentCoupons.length
            ? `政府券門檻 MOP ${formatMop(transaction.governmentThreshold)}；扣商戶券後基數 MOP ${formatMop(transaction.base)}`
            : '獨立商戶優惠交易；請選商戶接受的家庭支付方式。';
          const discounts = [merchantText, governmentText].filter(Boolean).join('；');
          return `<div class="transaction">
            <div class="transaction-title">第 ${transactionIndex + 1} 單 · ${escapeHtml(transaction.member)} · ${escapeHtml(transaction.payment)}　原始交易 MOP ${formatMop(transaction.spend)}</div>
            <div class="muted">${discounts ? `${discounts}；` : ''}${thresholdText}；本單實付 MOP ${formatMop(transaction.pay)}</div>
            ${merchantSource}
          </div>`;
        }).join('');
        const unusedParts = [];
        if (option.unusedCoupons.length) unusedParts.push(`未用電子券：${option.unusedCoupons.map(coupon => `${escapeHtml(coupon.member)} · ${escapeHtml(coupon.payment)} MOP ${formatMop(coupon.amount)}`).join('、')}`);
        if (option.unusedMerchantCoupons.length) unusedParts.push(`未用商戶券：${option.unusedMerchantCoupons.map(coupon => `${escapeHtml(coupon.member)} · ${escapeHtml(coupon.payment)}`).join('、')}`);
        const unused = unusedParts.length ? unusedParts.join('；') : '此方案沒有剩餘未核銷電子券／商戶券。';
        const thresholdHints = [];
        if (option.nextCoupon) {
          const coupon = option.nextCoupon.coupon;
          const amount = option.nextCoupon.additionalSpend;
          thresholdHints.push(amount === 0
            ? `現有金額已足夠；調整分單後可多用 ${escapeHtml(coupon.member)} · ${escapeHtml(coupon.payment)} 的 MOP ${formatMop(coupon.amount)} 電子優惠。`
            : `再消費 MOP ${formatMop(amount)}，並以 ${escapeHtml(coupon.member)} · ${escapeHtml(coupon.payment)} 付款，即可多用一張 MOP ${formatMop(coupon.amount)} 電子優惠。`);
        }
        if (option.nextMerchant) {
          const amount = option.nextMerchant.additionalSpend;
          thresholdHints.push(amount === 0
            ? '現有金額已達門檻；調整分單後可多用一張未核銷商戶滿減券。'
            : `再消費 MOP ${formatMop(amount)} 並安排一筆滿 MOP 100 的交易，即可多用一張商戶滿減券。`);
        }
        if (option.exactMatch) thresholdHints.push('目前金額剛好達到本方案所用券的最低消費門檻。');
        const title = `${index === 0 ? '較省方案' : '比較方案'}：${option.merchantScenario ? `使用商戶券 ${option.merchantUsedCount} 張` : '保留商戶券'}`;
        const firstTransaction = plan.firstSpend
          ? `<div class="transaction"><div class="transaction-title">已先消費 MOP ${formatMop(plan.firstSpend)}</div><div class="muted">未指定家人或支付方式；這筆金額不使用本次分配的券。</div></div>`
          : '';
        const unallocated = option.unallocatedSpend > 0
          ? `<div class="transaction"><div class="transaction-title">尚無折扣的餘額　MOP ${formatMop(option.unallocatedSpend)}</div><div class="muted">未達用券條件的金額，可按實際情況選擇付款方式。</div></div>`
          : '';
        const giftNote = option.unusedGiftCoupons.length
          ? `<div class="muted">另有 ${option.unusedGiftCoupons.length} 張消費禮遇券，不折算現金；請依券面／商戶條件使用。</div>`
          : '';
        const redeemButton = option.usedCouponIds.length
          ? `<div class="plan-actions"><button class="button" type="button" data-use-plan="${index}">確認核銷本方案（電子券 ${option.usedGovernmentCoupons.length} 張／商戶券 ${option.usedMerchantCoupons.length} 張）</button></div>`
          : '';
        const unallocatedNote = option.unallocatedSpend > 0
          ? `另有 MOP ${formatMop(option.unallocatedSpend)} 尚未指定支付方式；此金額已計入全家預估自付額，但未分配至個別家人。`
          : '已先消費金額（如有）會列為未指定家人的支出；最低需消費只計入用券交易。';
        return `<article class="plan-card ${index === 0 ? 'best' : ''}">
          <h3>${escapeHtml(title)}</h3>
          <div class="plan-amount-hero">
            <span>全家預估自付</span>
            <strong>MOP ${formatMop(option.totalPay)}</strong>
            <small>計劃總消費 MOP ${formatMop(plan.total)} − 用券折抵 MOP ${formatMop(option.discount)}</small>
          </div>
          ${breakdown}
          <p class="breakdown-note">${unallocatedNote} 用券折抵包含電子券面額及商戶券折扣。</p>
          <details class="plan-details">
            <summary>查看分單明細（${option.transactions.length} 筆）</summary>
            <div class="plan-details-content">
              ${firstTransaction}${transactions}${unallocated}
              <div class="muted">${unused}</div>
              ${giftNote}
              ${thresholdHints.map(hint => `<div class="notice ${option.exactMatch ? 'neutral' : ''}">${hint}</div>`).join('')}
              <div class="muted">政府券折扣 MOP ${formatMop(option.governmentDiscount)}；商戶折扣 MOP ${formatMop(option.merchantDiscount)}。</div>
            </div>
          </details>
          ${redeemButton}
        </article>`;
      }

      function planBreakdown(option, plan) {
        const byMember = new Map();
        const ensure = member => {
          if (!byMember.has(member)) byMember.set(member, { member, voucherDiscount: 0, minimumSpend: 0, allocatedSpend: 0, outOfPocket: 0 });
          return byMember.get(member);
        };
        selectedCalcMembers.forEach(ensure);
        if (plan.firstSpend > 0) {
          const first = ensure('已先消費（未指定家人）');
          first.allocatedSpend += plan.firstSpend;
          first.outOfPocket += plan.firstSpend;
        }
        for (const transaction of option.transactions) {
          const row = ensure(transaction.member);
          const governmentDiscount = transaction.governmentCoupons.reduce((sum, coupon) => sum + Number(coupon.amount), 0);
          row.voucherDiscount += governmentDiscount + transaction.merchantDiscount;
          row.minimumSpend += transaction.minSpend;
          row.allocatedSpend += transaction.spend;
          row.outOfPocket += transaction.pay;
        }
        const rows = [...byMember.values()];
        const totalMinimum = rows.reduce((sum, row) => sum + row.minimumSpend, 0);
        const totalAllocated = rows.reduce((sum, row) => sum + row.allocatedSpend, 0);
        const cells = row => `<td data-label="使用券折抵">MOP ${formatMop(row.voucherDiscount)}</td>
          <td data-label="最低需消費">MOP ${formatMop(row.minimumSpend)}</td>
          <td data-label="分配消費">MOP ${formatMop(row.allocatedSpend)}</td>
          <td data-label="預估自付">MOP ${formatMop(row.outOfPocket)}</td>`;
        const personRows = rows.length
          ? rows.map(row => `<tr><th scope="row">${escapeHtml(row.member)}</th>${cells(row)}</tr>`).join('')
          : '<tr><th scope="row">尚未選取家人</th><td colspan="4">請選擇家人或支付方式以查看明細。</td></tr>';
        const mobileRows = rows.map(row => `<article class="breakdown-person-card">
          <h4>${escapeHtml(row.member)}</h4>
          <div class="breakdown-metrics">
            <div><span>使用券折抵</span><strong>MOP ${formatMop(row.voucherDiscount)}</strong></div>
            <div><span>最低需消費</span><strong>MOP ${formatMop(row.minimumSpend)}</strong></div>
            <div><span>分配消費</span><strong>MOP ${formatMop(row.allocatedSpend)}</strong></div>
            <div><span>預估自付</span><strong>MOP ${formatMop(row.outOfPocket)}</strong></div>
          </div>
        </article>`).join('');
        const totalValues = `<td data-label="使用券折抵">MOP ${formatMop(option.discount)}</td>
          <td data-label="最低需消費">MOP ${formatMop(totalMinimum)}</td>
          <td data-label="分配消費">MOP ${formatMop(totalAllocated)}</td>
          <td data-label="預估自付">MOP ${formatMop(option.totalPay)}</td>`;
        const mobileTotal = `<article class="breakdown-total-card">
          <h4>全家合計</h4>
          <div class="breakdown-metrics">
            <div><span>使用券折抵</span><strong>MOP ${formatMop(option.discount)}</strong></div>
            <div><span>最低需消費</span><strong>MOP ${formatMop(totalMinimum)}</strong></div>
            <div><span>分配消費</span><strong>MOP ${formatMop(totalAllocated)}</strong></div>
            <div><span>預估自付</span><strong>MOP ${formatMop(option.totalPay)}</strong></div>
          </div>
        </article>`;
        return `<section class="plan-breakdown" aria-label="每人及全家金額對照">
          <h4>金額對照</h4>
          <div class="breakdown-table-wrap"><table class="breakdown-table">
          <thead><tr><th scope="col">家人／金額來源</th><th scope="col">使用券折抵</th><th scope="col">最低需消費</th><th scope="col">分配消費</th><th scope="col">預估自付</th></tr></thead>
            <tbody>${personRows}</tbody>
            <tfoot><tr><th scope="row">全家合計</th>${totalValues}</tr></tfoot>
          </table></div>
          <div class="breakdown-mobile">${mobileRows || '<div class="empty">尚未選取家人。</div>'}${mobileTotal}</div>
        </section>`;
      }

      async function redeemPlan(index) {
        const option = lastCalculatedPlan?.plans[index];
        if (!option || !option.usedCouponIds.length) return;
        const ids = [...new Set(option.usedCouponIds)];
        const rows = ids.map(id => [id, coupons[id]]);
        if (rows.some(([, coupon]) => !coupon || coupon.used)) {
          showToast('券庫已更新或所選券已核銷，請重新試算。');
          renderCalc();
          return;
        }
        const detail = rows.map(([, coupon]) => `${couponTypeName(coupon.type)} · ${coupon.member} · ${coupon.payment}`).join('\n');
        if (!window.confirm(`將只核銷下列 ${ids.length} 張券；首單與未列出的券不會變更：\n\n${detail}\n\n是否確認？`)) return;
        if (online && database) {
          const updates = Object.fromEntries(ids.map(id => [`coupons/${id}/used`, true]));
          try {
            await database.ref(weekPath()).update(updates);
          } catch {
            showToast('雲端核銷失敗；券庫未更新，請確認連線後再試。');
            return;
          }
        }
        for (const id of ids) coupons[id] = { ...coupons[id], used: true };
        saveLocal();
        invalidateAllPeriodStats();
        render();
        showToast(online ? `已核銷 ${ids.length} 張券。` : `已在本機標記 ${ids.length} 張券；尚未同步雲端。`);
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
          if (value === 'zero') coupon.type = 'zero';
          else if (value === 'merchant') {
            coupon.type = 'merchant';
            coupon.amount = 12;
          } else if (value === 'gift') {
            coupon.type = 'gift';
            coupon.label = '消費禮遇券';
          }
          else {
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

      function setActiveTab(tab) {
        document.querySelectorAll('.tab').forEach(button => {
          const selected = button.dataset.panel === tab;
          button.classList.toggle('active', selected);
          button.setAttribute('aria-selected', String(selected));
        });
        document.querySelectorAll('[data-nav]').forEach(button => {
          if (button.dataset.nav === tab) button.setAttribute('aria-current', 'page');
          else button.removeAttribute('aria-current');
        });
        document.querySelectorAll('.panel').forEach(panel => {
          const selected = panel.id === tab;
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
        fillSelect('filterWallet', [{ value: 'all', label: '全部支付方式' }]
          .concat(WALLETS.map(wallet => ({ value: wallet, label: wallet }))), 'all');
        coupons = sanitizeCoupons(localData[currentWeek]?.coupons);
        renderSlotsAndFilters();
        render();
        setActiveTab('overview');
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
        renderRegistrationStatus();
      });
      $('recordWallet').addEventListener('change', renderRegistrationStatus);
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
        const button = event.target.closest('[data-slot-index]');
        if (!button) return;
        slotSelections[Number(button.dataset.slotIndex)] = button.dataset.result;
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
      $('couponList').addEventListener('click', event => {
        const button = event.target.closest('button[data-action]');
        if (!button) return;
        const id = button.dataset.id;
        const coupon = coupons[id];
        if (!coupon) return;
        if (button.dataset.action === 'delete') {
          if (!window.confirm('確定刪除此抽獎結果？刪除最後一項後，該支付方式會顯示未登記。建議先匯出備份。')) return;
          writeCoupon(id, null).then(() => showToast('結果已刪除。'));
          return;
        }
        coupon.used = !coupon.used;
        coupon.usedAt = coupon.used ? Date.now() : null;
        writeCoupon(id, coupon).then(() => showToast(coupon.used ? '已標記核銷。' : '已還原。'));
      });

      $('export').addEventListener('click', exportBackup);
      $('import').addEventListener('change', importBackup);
      document.querySelectorAll('.tab').forEach(button => button.addEventListener('click', () => setActiveTab(button.dataset.panel)));
      document.querySelectorAll('[data-nav]').forEach(button => button.addEventListener('click', () => setActiveTab(button.dataset.nav)));
      initialize();
    })();
