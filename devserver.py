"""ANGELS TWENTY 開発用の静的サーバ。

python -m http.server だとブラウザが ES モジュールをキャッシュしてしまい、
ソースを直しても古いモジュールが読み込まれ続けることがある。
毎回必ず取り直させるため no-store を付けて返すだけのサーバ。

    python devserver.py [port]
"""

import functools
import http.server
import os
import sys


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, fmt, *args):
        # 404 だけ出す（通常のアクセスログはうるさいので抑制）
        if args and str(args[1]).startswith("4"):
            super().log_message(fmt, *args)


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8187
    root = os.path.dirname(os.path.abspath(__file__))
    handler = functools.partial(NoCacheHandler, directory=root)
    server = http.server.ThreadingHTTPServer(("127.0.0.1", port), handler)
    print(f"ANGELS TWENTY dev server: http://localhost:{port}/  (root={root})")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
