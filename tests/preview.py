"""試用版：在自己的電腦上開啟網站，用假資料，不會讀寫正式的 Firebase。

    python3 tests/preview.py          # 然後打開 http://localhost:8800/
    python3 tests/preview.py 9000     # 換一個埠

同一個 Wi-Fi 下的手機可以打開 http://<電腦的 IP>:8800/ 。
試用資料存在瀏覽器裡，重新整理後仍在；打開 /?reset 可還原成範例資料。
只需要 Python，不需要安裝其他東西。
"""
import functools, http.server, json, re, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8800


def coupon(member, payment, kind, amount=0, used=False, **extra):
    return {'member': member, 'payment': payment, 'type': kind, 'amount': amount, 'used': used, 'createdAt': 1, **extra}


SAMPLE = {
    'a1': coupon('爸爸', 'MPay', 'gov', 20), 'a2': coupon('爸爸', 'MPay', 'zero'), 'a3': coupon('爸爸', 'MPay', 'zero'),
    'b1': coupon('媽媽', '工銀', 'gov', 50), 'b2': coupon('媽媽', '工銀', 'gov', 10), 'b3': coupon('媽媽', '工銀', 'zero'),
    'd1': coupon('媽媽', '大豐', 'gov', 20), 'd2': coupon('媽媽', '大豐', 'merchant', 12), 'd3': coupon('媽媽', '大豐', 'zero'),
    'e1': coupon('姐姐', '中銀', 'gov', 100), 'e2': coupon('姐姐', '中銀', 'gov', 10), 'e3': coupon('姐姐', '中銀', 'gift'),
    'u1': coupon('昌哥', 'MPay', 'gov', 50, True, usedAt=5, redemption={'transactionId': 't1'}),
    'u2': coupon('昌哥', 'MPay', 'zero'), 'u3': coupon('昌哥', 'MPay', 'zero'),
}
# The same sample in every campaign week, so the preview has data whatever today's date is.
SEED = {'campaigns': {'2026R2': {'weeks': {f'2026R2-W{n}': {'coupons': SAMPLE} for n in range(1, 11)}}}}

INJECT = f"""<script>
(() => {{
  const KEY = 'previewDb';
  if (location.search.includes('reset')) {{ localStorage.clear(); location.replace(location.pathname); }}
  let saved = null;
  try {{ saved = JSON.parse(localStorage.getItem(KEY)); }} catch {{}}
  window.__seed = saved || {json.dumps(SEED, ensure_ascii=False)};
  setInterval(() => localStorage.setItem(KEY, JSON.stringify(window.__seed)), 500);
  addEventListener('DOMContentLoaded', () => document.body.insertAdjacentHTML('beforeend',
    '<div style="position:fixed;top:0;right:0;z-index:99;padding:2px 8px;font:12px sans-serif;background:#f5a623;color:#000;border-bottom-left-radius:8px">試用版・假資料</div>'));
}})();
</script>
<script src="./tests/mock-firebase.js"></script>"""


class Preview(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path.split('?')[0] not in ('/', '/index.html'):
            return super().do_GET()
        html = (ROOT / 'index.html').read_text(encoding='utf-8')
        # Swap the real Firebase SDK for the in-page stand-in.
        html, swapped = re.subn(r'\s*<script src="https://www\.gstatic\.com/firebasejs/[^"]+"></script>', '', html)
        if not swapped or '<script src="./core.js">' not in html:
            return self.send_error(500, 'preview.py could not find the Firebase script tags in index.html')
        body = html.replace('<script src="./core.js">', INJECT + '\n  <script src="./core.js">', 1).encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')  # always serve the latest edit
        super().end_headers()

    def log_message(self, *args):
        pass


if __name__ == '__main__':
    server = http.server.ThreadingHTTPServer(('0.0.0.0', PORT), functools.partial(Preview, directory=str(ROOT)))
    print(f'試用版： http://localhost:{PORT}/   （假資料，不會動到正式資料庫；Ctrl+C 結束）')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
