"""Walks every user flow in a real browser against tests/mock-firebase.js.  Run: python3 tests/flows.py"""
import functools, http.server, json, re, threading
from datetime import datetime, timezone
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args): pass
server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Quiet, directory=str(ROOT)))
threading.Thread(target=server.serve_forever, daemon=True).start()
URL = f'http://127.0.0.1:{server.server_port}/'

def coupon(member, payment, kind, amount=0, used=False, **extra):
    return {'member': member, 'payment': payment, 'type': kind, 'amount': amount, 'used': used, 'createdAt': 1, **extra}

SEED = {'campaigns': {'2026R2': {'weeks': {'2026R2-W1': {'coupons': {
    'a1': coupon('爸爸', 'MPay', 'gov', 20), 'a2': coupon('爸爸', 'MPay', 'zero'), 'a3': coupon('爸爸', 'MPay', 'zero'),
    'b1': coupon('媽媽', '工銀', 'gov', 50), 'b2': coupon('媽媽', '工銀', 'gov', 10), 'b3': coupon('媽媽', '工銀', 'zero'),
    'd1': coupon('媽媽', '大豐', 'gov', 20), 'd2': coupon('媽媽', '大豐', 'merchant', 12), 'd3': coupon('媽媽', '大豐', 'zero'),
    'e1': coupon('姐姐', '中銀', 'gov', 100), 'e2': coupon('姐姐', '中銀', 'gov', 10), 'e3': coupon('姐姐', '中銀', 'gift'),
    'u1': coupon('昌哥', 'MPay', 'gov', 50, True, usedAt=5, redemption={'transactionId': 't1'}),
    'u2': coupon('昌哥', 'MPay', 'zero'), 'u3': coupon('昌哥', 'MPay', 'zero'),
}}}}}}

OUTSIDE = re.compile(r'^https?://(?!127\.0\.0\.1[:/])')  # everything but this test server: the real Firebase must never load

def open_page(browser, now, width=375):
    page = browser.new_page(viewport={'width': width, 'height': 780}, timezone_id='America/New_York')  # phone zone must not matter
    page.clock.install(time=now)
    page.add_init_script(f'window.__seed = {json.dumps(SEED)};')
    page.add_init_script(path=str(ROOT / 'tests' / 'mock-firebase.js'))
    page.route(OUTSIDE, lambda route: route.fulfill(status=200, content_type='application/javascript', body=''))
    page.errors = []
    page.on('pageerror', lambda error: page.errors.append(str(error)))
    page.goto(URL)
    assert page.evaluate('typeof firebase.SDK_VERSION') == 'undefined', 'the real Firebase SDK loaded: stop before touching family data'
    return page

text = lambda page, selector: ' '.join(page.locator(selector).inner_text().split())
writes = lambda page: page.evaluate('window.__db.writes.length')
fits = lambda page: page.evaluate('document.documentElement.scrollWidth <= innerWidth')
SAT = datetime(2026, 10, 10, 4, tzinfo=timezone.utc)

with sync_playwright() as p:
    browser = p.chromium.launch(args=['--no-sandbox'])

    # 1. First screen: what is left, per person and wallet.
    page = open_page(browser, SAT)
    assert text(page, '#caption') == '本週未用電子券 · 週四到期'
    assert text(page, '#hero') == 'MOP 210'
    listing = text(page, '#useList')
    for expected in ('給商家 自付', '全家 630 420', '爸爸 MPay 券 20 60 40', '媽媽 240 160', '工銀 券 50 + 10 180 120', '大豐 券 20 60 40', '姐姐 中銀 券 100 + 10 330 220'):
        assert expected in listing, (expected, listing)
    assert '昌哥' not in listing and '商戶' not in page.locator('#use').inner_text() and '禮遇' not in page.locator('#use').inner_text()
    assert text(page, '#usedSummary') == '已用電子券 MOP 50'
    assert text(page, '#badge') == '18'
    assert page.locator('#verdict').is_hidden() and page.locator('#markPlan').is_hidden()
    assert fits(page)
    print('1 first screen PASS')

    # 2. Planning a purchase, and going back by clearing the price.
    page.locator('#price').fill('25')
    assert text(page, '#verdict') == '未滿 MOP 30，用不到券' and page.locator('#markPlan').is_hidden()
    page.locator('#price').fill('700')
    assert text(page, '#verdict') == '券減 MOP 210，電子券全部用完' and '合計 700 490' in text(page, '#useList')
    page.locator('#price').fill('400')
    assert text(page, '#verdict') == '券減 MOP 130，電子券還剩 MOP 80 再買 MOP 20，多減 MOP 10'
    assert text(page, '#useList') == '給商家 自付 合計 400 270 爸爸 MPay 券 20 60 40 姐姐 中銀 券 110 340 230'
    assert page.locator('#useList button').count() == 0
    # Merchant coupons join the plan only when the shop takes them.
    assert page.locator('#merchantBox').is_visible() and '商戶券' not in text(page, '#useList')
    page.locator('#merchantOk').check()
    assert text(page, '#verdict').startswith('券減 MOP 132，') and '商戶券 12' in text(page, '#useList') and '合計 400 268' in text(page, '#useList')
    page.locator('#merchantOk').uncheck()
    assert '合計 400 270' in text(page, '#useList')
    page.locator('#price').fill('390')
    assert text(page, '#verdict') == '券減 MOP 130，電子券還剩 MOP 80 剛剛好'
    # Only some of the family's coupons: untick a person and the plan leaves theirs alone.
    page.locator('#price').fill('400')
    assert text(page, '#who') == '爸爸 媽媽 姐姐' and page.locator('#who input:checked').count() == 3
    page.locator('#who [data-member="姐姐"]').uncheck(force=True)
    assert text(page, '#verdict') == '券減 MOP 100，電子券還剩 MOP 110' and '姐姐' not in text(page, '#useList') and '合計 400 300' in text(page, '#useList')
    assert '媽媽 340 260 工銀 券 60 280 220 大豐 券 20 60 40' in text(page, '#useList')  # a subtotal for a person paying twice
    page.locator('#who [data-member="媽媽"]').uncheck(force=True)
    assert text(page, '#verdict') == '券減 MOP 20，電子券還剩 MOP 190' and '爸爸 MPay 券 20 400 380' in text(page, '#useList')
    page.locator('#who [data-member="爸爸"]').uncheck(force=True)
    assert text(page, '#verdict') == '沒有可用的券' and page.locator('#markPlan').is_hidden()
    for member in ('爸爸', '媽媽'):
        page.locator(f'#who [data-member="{member}"]').check(force=True)
    assert text(page, '#verdict') == '券減 MOP 100，電子券還剩 MOP 110'
    page.locator('#clearPrice').click()
    assert page.locator('#merchantBox').is_hidden() and page.locator('#who').is_hidden()
    assert page.locator('#verdict').is_hidden() and '全家 630 420' in text(page, '#useList') and page.locator('#clearPrice').is_hidden()
    print('2 plan a purchase PASS')

    # 3. Submit the plan, then undo from the toast.
    page.locator('#price').fill('400')  # 姐姐 is still unticked
    page.locator('#markPlan').click()
    assert text(page, '#hero') == 'MOP 110' and '已記為已用：券 MOP 100' in text(page, '#toast')
    assert page.evaluate("window.__db.root.campaigns['2026R2'].weeks['2026R2-W1'].coupons.e1.used") is False
    page.locator('#toast button').click()
    assert text(page, '#hero') == 'MOP 210' and writes(page) == 2
    page.evaluate('window.__db.writes.length = 0')
    page.locator('#price').fill('400')
    page.locator('#who [data-member="姐姐"]').check(force=True)
    page.locator('#markPlan').click()
    assert text(page, '#hero') == 'MOP 80' and writes(page) == 1
    assert page.locator('#price').input_value() == '' and page.locator('#verdict').is_hidden()
    assert '已記為已用：券 MOP 130' in text(page, '#toast')
    saved = page.evaluate("window.__db.root.campaigns['2026R2'].weeks['2026R2-W1'].coupons.e1")
    assert saved['used'] is True and saved['redemption']['actualSpendCents'] - saved['redemption']['actualPaidCents'] == 11000
    page.locator('#toast button').click()
    assert text(page, '#hero') == 'MOP 210' and writes(page) == 2
    page.locator('#price').fill('400'); page.locator('#merchantOk').check()
    page.locator('#markPlan').click()
    assert page.evaluate("window.__db.root.campaigns['2026R2'].weeks['2026R2-W1'].coupons.d2.used") is True
    assert '已記為已用：券 MOP 132' in text(page, '#toast') and not page.locator('#merchantBox').is_visible()
    page.locator('#usedBox summary').click()
    assert '大豐 券 20 + 商戶券' in text(page, '#usedList')
    page.locator('#usedBox summary').click()
    page.locator('#toast button').click()
    assert page.evaluate("window.__db.root.campaigns['2026R2'].weeks['2026R2-W1'].coupons.d2.used") is False
    assert text(page, '#hero') == 'MOP 210' and writes(page) == 4
    print('3 submit plan and undo PASS')

    # 4. One wallet: open, back out three ways, then confirm and undo from the used list.
    row = page.locator('[data-use="媽媽|工銀"]')
    row.click()
    assert page.locator('#sheet').is_visible()
    assert text(page, '#sheetBody') == '給商家 MOP 180 券減 MOP 60 自付 MOP 120'
    page.go_back()
    page.wait_for_function("!document.querySelector('#sheet').open")
    assert page.locator('#use').is_visible() and writes(page) == 4
    row.click(); page.keyboard.press('Escape'); page.wait_for_function("!document.querySelector('#sheet').open")
    row.click(); page.locator('#sheetCancel').click(); page.wait_for_function("!document.querySelector('#sheet').open")
    assert writes(page) == 4
    row.click(); page.locator('#sheetOk').click()
    assert text(page, '#hero') == 'MOP 150' and text(page, '#usedSummary') == '已用電子券 MOP 110'
    page.wait_for_function("!history.state")
    # Used coupons: what the shops got and what was paid; open one, back out, then take it back.
    page.locator('#usedBox summary').click()
    assert text(page, '#usedList') == '給商家 自付 全家 330 220 媽媽 工銀 券 60 180 120 昌哥 MPay 券 50 150 100'
    before = writes(page)
    page.locator('#usedList [data-used]', has_text='工銀').click()
    assert text(page, '#sheetTitle') == '媽媽 · 工銀' and text(page, '#sheetBody') == '給商家 MOP 180 券減 MOP 60 自付 MOP 120'
    page.go_back()
    page.wait_for_function("!document.querySelector('#sheet').open")
    assert writes(page) == before and text(page, '#hero') == 'MOP 150'
    page.locator('#usedList [data-used]', has_text='工銀').click(); page.locator('#sheetOk').click()
    assert text(page, '#hero') == 'MOP 210' and '已復原' in text(page, '#toast') and text(page, '#usedSummary') == '已用電子券 MOP 50'
    page.wait_for_function("!history.state")
    page.locator('#usedBox summary').click()
    print('4 one wallet: back, cancel, confirm, undo PASS')

    # 5. Tabs and the browser back button.
    page.locator('.tabs [data-tab="register"]').click()
    assert page.locator('#register').is_visible() and page.locator('#use').is_hidden()
    assert text(page, '#regCaption') == '已登記 5 / 23'
    assert '工銀 50 · 10 · —' in text(page, '#regList') and '大豐 20 · 商戶 · —' in text(page, '#regList') and '中銀 100 · 10 · 禮遇' in text(page, '#regList')
    assert page.locator('#weekList').is_hidden()  # folded away until asked for
    page.locator('#weeksBox summary').click()
    assert text(page, '#weekList') == '抽中 已用 全期 260 50 本週 10/9 – 10/15 260 50'
    page.locator('#weeksBox summary').click()
    page.go_back()
    assert page.locator('#use').is_visible()
    page.go_forward()
    assert page.locator('#register').is_visible()
    print('5 tabs and back PASS')

    # 6. Register a wallet, edit it, and see a used wallet locked.
    before = writes(page)
    page.locator('[data-reg="媽媽|MPay"]').click()
    assert page.locator('#sheetOk').is_disabled()
    page.locator('input[name="draw0"][value="20"]').check(force=True)
    page.locator('input[name="draw1"][value="zero"]').check(force=True)
    assert page.locator('#sheetOk').is_disabled()
    page.go_back()  # leaving without saving writes nothing
    page.wait_for_function("!document.querySelector('#sheet').open")
    assert writes(page) == before and page.locator('#register').is_visible()
    page.locator('[data-reg="媽媽|MPay"]').click()
    for index, value in enumerate(('20', 'merchant', '100')):
        page.locator(f'input[name="draw{index}"][value="{value}"]').check(force=True)
    page.locator('#sheetOk').click()
    assert '已儲存：媽媽 · MPay' in text(page, '#toast')
    assert 'MPay 20 · 商戶 · 100' in text(page, '#regList') and text(page, '#regCaption') == '已登記 6 / 23' and text(page, '#badge') == '17'
    assert writes(page) == before + 1
    page.wait_for_function("!history.state")
    page.locator('[data-reg="媽媽|MPay"]').click()
    assert page.locator('input[name="draw2"]:checked').get_attribute('value') == '100'
    page.locator('input[name="draw2"][value="10"]').check(force=True)
    page.locator('#sheetOk').click()
    change = page.evaluate('Object.values(window.__db.writes.at(-1).changes)')
    assert len(change) == 6 and change.count(None) == 3
    assert 'MPay 20 · 商戶 · 10' in text(page, '#regList')
    page.wait_for_function("!history.state")
    page.locator('[data-reg="昌哥|MPay"]').click()
    assert page.locator('#sheetOk').is_hidden() and text(page, '#sheetCancel') == '關閉'
    assert page.locator('#sheetBody fieldset:disabled').count() == 3
    page.locator('#sheetCancel').click()
    page.wait_for_function("!history.state")
    page.locator('.tabs [data-tab="use"]').click()
    assert text(page, '#hero') == 'MOP 240' and '媽媽 330 220' in text(page, '#useList')
    print('6 register, edit, locked PASS')

    # 7. Wallet settings.
    page.locator('.tabs [data-tab="register"]').click()
    page.locator('#walletBox summary').click()
    page.locator('[data-wallet="妹妹|MPay"]').uncheck(force=True)
    assert text(page, '#regCaption') == '已登記 6 / 22'
    assert page.evaluate("window.__db.root.campaigns['2026R2'].settings.wallets['妹妹'].MPay") is False
    page.locator('[data-wallet="妹妹|MPay"]').check(force=True)
    assert text(page, '#regCaption') == '已登記 6 / 23'
    print('7 wallet settings PASS')

    # 8. A failed save says so and changes nothing.
    page.locator('.tabs [data-tab="use"]').click()
    page.evaluate('window.__db.failNext = true')
    page.locator('[data-use="爸爸|MPay"]').click(); page.locator('#sheetOk').click()
    page.wait_for_function("document.querySelector('#toast').textContent.includes('儲存失敗')")
    assert text(page, '#hero') == 'MOP 240'
    assert fits(page) and not page.errors, page.errors
    page.close()

    # Offline: the SDK never loaded, so nothing can be saved, and the page says so.
    page = browser.new_page(viewport={'width': 375, 'height': 780})
    page.route(OUTSIDE, lambda route: route.abort())
    page.goto(URL)
    assert page.locator('#caption').inner_text() != ''
    page.close()
    print('8 failed save and offline load PASS')

    # 9. Days: last day, new week on Friday, weekday badge, campaign over.
    page = open_page(browser, datetime(2026, 10, 15, 4, tzinfo=timezone.utc))
    assert text(page, '#caption') == '本週未用電子券 · 今晚到期'
    assert 'urgent' in page.locator('#hero').get_attribute('class') and page.locator('#badge').is_hidden()
    page.clock.set_fixed_time(datetime(2026, 10, 15, 16, 1, tzinfo=timezone.utc))  # Friday 00:01 in Macau
    page.clock.run_for(61000)
    assert text(page, '#hero') == 'MOP 0' and text(page, '#caption') == '本週未用電子券 · 週四到期'
    assert page.locator('.price').is_hidden() and text(page, '#badge') == '23'
    page.locator('#useList a').click()
    assert page.locator('#register').is_visible() and text(page, '#regCaption') == '已登記 0 / 23'
    # Earlier weeks: open one, read it, and leave by back and by the button. Nothing is written.
    page.locator('#weeksBox summary').click()
    assert text(page, '#weekList') == '抽中 已用 全期 260 50 本週 10/16 – 10/22 0 0 第 1 週 10/9 – 10/15 260 50'
    page.locator('[data-week="2026R2-W1"]').click()
    assert text(page, '#sheetTitle') == '第 1 週 · 10/9 – 10/15' and page.locator('#sheetOk').is_hidden() and text(page, '#sheetCancel') == '關閉'
    sheet = text(page, '#sheetBody')
    for expected in ('抽中 MOP 260 已用 MOP 50 給商家 MOP 150 自付 MOP 100 手氣王 姐姐 · MOP 110 最旺錢包 中銀 · MOP 110 商戶券 1 張 禮遇券 1 張 抽中 已用', '爸爸 MPay 20 · — · — 20 0', '媽媽 80 0', '工銀 50 · 10 · — 60 0', '大豐 20 · 商戶 · — 20 0', '姐姐 中銀 100 · 10 · 禮遇 110 0', '昌哥 MPay 50 · — · — 50 50'):
        assert expected in sheet, (expected, sheet)
    assert page.locator('#sheetBody button, #sheetBody input').count() == 0
    page.go_back()
    page.wait_for_function("!document.querySelector('#sheet').open")
    assert page.locator('#register').is_visible() and page.locator('#weekList').is_visible()
    page.locator('[data-week="2026R2-W2"]').click()
    assert text(page, '#sheetTitle') == '本週 · 10/16 – 10/22' and text(page, '#sheetBody') == '沒有登記'
    page.locator('#sheetCancel').click()
    page.wait_for_function("!history.state")
    page.locator('[data-week="all"]').click()  # the whole campaign
    assert text(page, '#sheetTitle') == '全期' and '手氣王 姐姐 · MOP 110' in text(page, '#sheetBody') and '媽媽 80 0 工銀 60 0 大豐 20 0' in text(page, '#sheetBody')
    page.keyboard.press('Escape')
    page.wait_for_function("!history.state")
    with page.expect_download() as download:
        page.locator('#export').click()
    assert download.value.suggested_filename == '消費券備份-2026-10-16.json' and '已匯出備份' in text(page, '#toast')
    backup = json.loads(Path(download.value.path()).read_text(encoding='utf-8'))
    assert backup['weeks']['2026R2-W1']['coupons']['e1']['amount'] == 100 and backup['settings']['wallets']['爸爸']['MPay'] is True
    assert writes(page) == 0 and fits(page)
    page.close()
    page = open_page(browser, datetime(2026, 10, 14, 4, tzinfo=timezone.utc))
    assert text(page, '#caption') == '本週未用電子券 · 明晚到期'
    page.close()
    page = open_page(browser, datetime(2026, 12, 20, 4, tzinfo=timezone.utc))
    assert text(page, '#caption') == '活動已結束' and text(page, '#hero') == '' and page.locator('.price').is_hidden()
    page.locator('.tabs [data-tab="register"]').click()
    page.locator('#weeksBox summary').click()
    assert page.locator('[data-week]').count() == 11 and '本週' not in text(page, '#weekList') and '第 10 週 12/11 – 12/17 0 0' in text(page, '#weekList')
    page.locator('[data-week="2026R2-W1"]').click()
    assert '工銀 50 · 10 · — 60 0' in text(page, '#sheetBody')
    page.keyboard.press('Escape')
    assert not page.errors, page.errors
    page.close()
    print('9 last day, new week, campaign over PASS')

    # 10. Small and large screens.
    for width in (320, 1280):
        page = open_page(browser, SAT, width)
        page.locator('#price').fill('700')
        assert fits(page), width
        page.locator('.tabs [data-tab="register"]').click()
        page.locator('#weeksBox summary').click()
        page.locator('[data-week="2026R2-W1"]').click()
        assert fits(page), width
        page.close()
    print('10 320px and 1280px PASS')
    browser.close()
