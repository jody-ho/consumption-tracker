"""Run against a local HTTP server with the isolated Firebase fixture.

python3 -m http.server 8765 --bind 127.0.0.1
python3 tests/browser_smoke.py
"""
from datetime import datetime, timezone
from pathlib import Path
import json
import os

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parent
URL = 'http://127.0.0.1:8765/'


def page_for(browser, width=375, time_zone='Asia/Macau', now=datetime(2026, 10, 10, 12, tzinfo=timezone.utc)):
    page = browser.new_page(viewport={'width': width, 'height': 850}, timezone_id=time_zone)
    page.clock.install(time=now)
    page.add_init_script(path=str(ROOT / 'firebase_mock.js'))
    page.route('https://**', lambda route: route.fulfill(status=200, content_type='application/javascript', body=''))
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(URL, wait_until='load')
    assert not errors, errors
    assert page.locator('#connection').inner_text() == '已連線'
    return page, errors


def write_count(page):
    return page.evaluate('window.__fake.writes.length')


def open_dad_history(page):
    toggle = page.locator('[data-expand-wallet][data-member="爸爸"][data-payment="MPay"]')
    if toggle.get_attribute('aria-expanded') != 'true':
        toggle.click()
    history = page.locator('#wallet-panel-0-0 .wallet-history')
    if not history.get_attribute('open'):
        history.locator('summary').first.click()
    actions = page.locator('#wallet-panel-0-0 .transaction-actions')
    if not actions.get_attribute('open'):
        actions.locator('summary').click()


with sync_playwright() as playwright:
    chromium_path = os.environ.get('CHROMIUM_PATH') or ('/usr/bin/chromium' if Path('/usr/bin/chromium').exists() else None)
    launch_options = {'headless': True, 'args': ['--no-sandbox']}
    if chromium_path:
        launch_options['executable_path'] = chromium_path
    browser = playwright.chromium.launch(**launch_options)
    page, errors = page_for(browser)
    assert page.locator('#week').input_value() == '2026R2-W1'
    home = page.locator('#memberCompare').inner_text()
    for expected in ('MOP 20', 'MOP 60', 'MOP 40', 'MOP 100', 'MOP 70', 'MOP 30', '部分交易未記錄'):
        assert expected in home, expected
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
    assert 'mom-one' not in page.locator('body').inner_text()
    assert 'dadGov' not in page.locator('body').inner_text()

    # Both calculation modes use the same per-wallet coupon stock.
    page.locator('[data-nav="calc"]').click()
    page.locator('#modeUseCoupons').click()
    assert page.locator('#shoppingAmountField').is_hidden()
    assert '爸爸 · MPay' in page.locator('#useCouponsResults').inner_text()
    assert 'MOP 60' in page.locator('#useCouponsResults').inner_text()
    page.locator('#modeShopping').click()
    page.locator('#totalSpend').fill('100')
    page.locator('#merchantAvailable').check()
    page.locator('#calcForm button[type="submit"]').click()
    assert 'MOP 68' in page.locator('.plan-amount-hero').inner_text()
    assert '第 1 單 · 爸爸 · MPay' in page.locator('.plan-transaction-summary').inner_text()
    page.locator('[data-use-plan]').click()
    assert page.locator('#walletRedeemDialog').is_visible()
    assert page.locator('#walletRedeemChoices [data-wallet-coupon]:checked').count() == 2
    page.locator('#continueWalletRedeem').click()
    assert page.locator('#redeemDialog').is_visible()
    assert page.locator('#redeemSpend-0').input_value() == ''
    assert page.locator('#redeemAmount-0').input_value() == ''
    assert not page.locator('#confirmRedemption').is_enabled()
    page.locator('#redeemSpend-0').fill('100')
    page.locator('#redeemAmount-0').fill('68')
    page.locator('#redeemDate').fill('2026-10-11')
    assert not page.locator('#confirmRedemption').is_enabled()
    page.locator('#redeemDate').fill('2026-10-10')
    assert page.locator('#confirmRedemption').is_enabled()
    page.locator('#cancelRedemption').click()
    assert write_count(page) == 0
    page.locator('[data-nav="home"]').click()
    page.locator('#couponList [data-action="redeem"][data-id="dadGov"]').click()
    assert page.locator('#walletRedeemDialog').is_visible()
    page.locator('#cancelWalletRedeem').click()
    assert write_count(page) == 0

    # All three draw results are required and existing wallet results cannot be overwritten.
    page.locator('[data-nav="record"]').click()
    page.locator('#recordMember').select_option('媽媽')
    page.locator('#recordWallet').select_option('工銀')
    page.locator('[data-slot-index="0"][data-result="10"]').click()
    page.locator('#saveDraw').click()
    assert write_count(page) == 0
    page.locator('[data-slot-index="1"][data-result="merchant"]').click()
    page.locator('[data-slot-index="2"][data-result="zero"]').click()
    page.locator('#saveDraw').click()
    assert write_count(page) == 1
    assert page.evaluate('window.__fake.writes[0].path === window.__fake.week')
    page.wait_for_function("document.querySelector('#recordStatus').textContent.includes('已完成')")
    assert page.locator('#saveDraw').is_disabled()

    # Home quick redemption is a two-step review, with no write before final confirmation.
    page.locator('[data-nav="overview"]').click()
    page.locator('[data-expand-wallet][data-member="爸爸"][data-payment="MPay"]').click()
    page.locator('#walletRedemptionCards [data-wallet-redemption][data-member="爸爸"]').click()
    assert page.locator('#walletRedeemDialog').is_visible()
    page.locator('#cancelWalletRedeem').click()
    assert write_count(page) == 1
    page.locator('#walletRedemptionCards [data-wallet-redemption][data-member="爸爸"]').click()
    page.locator('#continueWalletRedeem').click()
    page.locator('#redeemSpend-0').fill('60')
    page.locator('#redeemAmount-0').fill('40')
    assert page.locator('#confirmRedemption').is_enabled()
    page.locator('#confirmRedemption').click()
    assert write_count(page) == 2
    assert 'MOP 110' in page.locator('#memberCompare').inner_text()

    # Correction replaces the transaction amount; undo removes that transaction once.
    open_dad_history(page)
    page.locator('#wallet-panel-0-0 [data-correct-transaction]').click()
    page.locator('#correctionSpend').fill('70')
    page.locator('#correctionPaid').fill('50')
    page.locator('#saveCorrection').click()
    assert 'MOP 120' in page.locator('#memberCompare').inner_text()
    open_dad_history(page)
    page.locator('#wallet-panel-0-0 [data-undo-transaction]').click()
    page.wait_for_function("document.querySelector('#toast').textContent.includes('還原為未使用')")
    assert 'MOP 70' in page.locator('#memberCompare').inner_text()
    assert 'MOP 30' in page.locator('#memberCompare').inner_text()
    page.locator('[data-nav="home"]').click()
    with page.expect_download() as download_info:
        page.locator('#export').click()
    backup = download_info.value.path()
    content = json.loads(Path(backup).read_text())
    assert content['campaign'] == '2026R2'
    assert content['week'] == '2026R2-W1'
    assert 'dadGov' in content['coupons']
    page.once('dialog', lambda dialog: dialog.accept())
    page.locator('#import').set_input_files(backup)
    page.wait_for_function("document.querySelector('#toast').textContent.includes('匯入並同步')")
    assert 'MOP 70' in page.locator('#actualSpendSummary').inner_text()
    assert not errors, errors
    print('mobile browser: dashboard, calculators, registration, redemption, correction, undo and JSON backup PASS')
    page.close()

    desktop, errors = page_for(browser, width=1280, time_zone='America/New_York')
    assert desktop.locator('#week').input_value() == '2026R2-W1'
    assert desktop.evaluate('document.documentElement.scrollWidth <= innerWidth')
    assert 'MOP 70' in desktop.locator('#memberCompare').inner_text()
    desktop.locator('[data-nav="home"]').click()
    desktop.locator('.fun-details > summary').click()
    assert desktop.locator('.draw-bar-row').count() == 5
    assert not errors, errors
    print('desktop browser: Macau week boundary, coupon vault comparison and layout PASS')
    desktop.close()

    failed, errors = page_for(browser)
    failed.locator('[data-expand-wallet][data-member="爸爸"][data-payment="MPay"]').click()
    failed.locator('#walletRedemptionCards [data-wallet-redemption][data-member="爸爸"]').click()
    failed.locator('#continueWalletRedeem').click()
    failed.locator('#redeemSpend-0').fill('60')
    failed.locator('#redeemAmount-0').fill('40')
    failed.evaluate('window.__fake.failNext = true')
    failed.locator('#confirmRedemption').click()
    failed.wait_for_function("document.querySelector('#toast').textContent.includes('雲端核銷記錄失敗')")
    assert write_count(failed) == 0
    assert failed.locator('#redeemDialog').is_visible()
    assert 'MOP 70' in failed.locator('#memberCompare').inner_text()
    failed.evaluate('window.__fake.goOffline()')
    assert failed.locator('#connection').inner_text() == '離線（本機）'
    failed.locator('#confirmRedemption').click()
    failed.wait_for_function("document.querySelector('#toast').textContent.includes('尚未同步雲端')")
    assert write_count(failed) == 0
    assert 'MOP 110' in failed.locator('#memberCompare').inner_text()
    assert not errors, errors
    print('write failure and offline local-only status PASS')
    failed.close()

    flow, errors = page_for(browser)
    # Registration progress, jump-to-register and one-step re-registration.
    badge = flow.locator('#recordNavBadge')
    assert badge.is_visible() and int(badge.inner_text()) > 0
    flow.locator('[data-member-group="媽媽"] > summary').click()
    flow.locator('[data-expand-wallet][data-member="媽媽"][data-payment="工銀"]').click()
    flow.locator('#walletRedemptionCards [data-open-registration][data-member="媽媽"][data-payment="工銀"]').click()
    assert flow.locator('#record').is_visible()
    assert flow.locator('#recordMember').input_value() == '媽媽'
    assert flow.locator('#recordWallet').input_value() == '工銀'
    assert '已選 0/3' in flow.locator('#saveDraw').inner_text()
    flow.locator('[data-record-target][data-member="爸爸"][data-payment="MPay"]').first.click()
    assert flow.locator('#recordWallet').input_value() == 'MPay'
    assert flow.locator('#slots').is_hidden()
    assert '電子 MOP 20' in flow.locator('#recordExisting').inner_text()
    assert flow.locator('#saveDraw').is_disabled()
    before = int(badge.inner_text())
    flow.once('dialog', lambda dialog: dialog.dismiss())
    flow.locator('#recordExisting [data-reregister]').click()
    assert write_count(flow) == 0
    flow.once('dialog', lambda dialog: dialog.accept())
    flow.locator('#recordExisting [data-reregister]').click()
    flow.wait_for_function("document.querySelector('#toast').textContent.includes('重新選三次結果')")
    assert write_count(flow) == 1
    assert flow.evaluate("Object.values(window.__fake.writes[0].changes).every(value => value === null)")
    assert len(flow.evaluate("Object.keys(window.__fake.writes[0].changes)")) == 3
    assert flow.locator('#slots').is_visible()
    assert not flow.locator('#saveDraw').is_disabled()
    assert int(badge.inner_text()) == before + 1
    for index, result in enumerate(('50', 'gift', 'zero')):
        flow.locator(f'[data-slot-index="{index}"][data-result="{result}"]').click()
    assert flow.locator('#saveDraw').inner_text() == '儲存三個結果'
    flow.locator('#saveDraw').click()
    assert write_count(flow) == 2
    assert int(badge.inner_text()) == before
    assert '下一個未登記' in flow.locator('#recordExisting').inner_text()
    # Wallets with a redeemed coupon cannot be wiped in one step.
    flow.locator('[data-nav="home"]').click()
    assert flow.locator('#couponList [data-reregister][data-member="媽媽"]').count() == 0
    assert flow.evaluate('document.documentElement.scrollWidth <= innerWidth')
    assert not errors, errors
    print('registration progress, jump-to-register and re-registration PASS')
    flow.close()

    expired, errors = page_for(browser, now=datetime(2026, 10, 30, 12, tzinfo=timezone.utc))
    expired.locator('#week').select_option('2026R2-W1')
    expired.locator('[data-nav="record"]').click()
    assert expired.locator('#saveDraw').is_disabled()
    assert expired.locator('#recordNavBadge').is_hidden()
    assert expired.locator('[data-reregister]').count() == 0
    expired.locator('[data-nav="overview"]').click()
    assert expired.locator('#walletRedemptionCards [data-wallet-redemption]').count() == 0
    assert 'MOP 0' in expired.locator('#memberCompare').inner_text()
    assert not errors, errors
    print('expired week: read-only controls and zero available government vouchers PASS')
    expired.close()
    browser.close()
