"""ANGELS TWENTY 開発用の静的サーバ。

python -m http.server だとブラウザが ES モジュールをキャッシュしてしまい、
ソースを直しても古いモジュールが読み込まれ続けることがある。
毎回必ず取り直させるため no-store を付けて返すだけのサーバ。

もう一つ役目がある。ミッションが終わるたびにゲームから送られてくる
プレイ記録を playlog.jsonl へ追記する。
記録はブラウザの localStorage にも入るが、そちらは開発側から読めないため、
難易度調整の材料にするにはファイルに落ちている必要がある。

127.0.0.1 にだけ bind した開発用サーバなので、書き込み口はローカル専用。

    python devserver.py [port]
"""

import functools
import http.server
import json
import os
import sys

PLAYLOG = "playlog.jsonl"
MAX_BODY = 512 * 1024


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def do_POST(self):
        """ゲームからのプレイ記録を1行1件で追記する。"""
        if self.path != "/telemetry":
            self.send_error(404)
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length <= 0 or length > MAX_BODY:
            self.send_error(400)
            return
        raw = self.rfile.read(length)
        try:
            record = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self.send_error(400)
            return

        path = os.path.join(os.path.dirname(os.path.abspath(__file__)), PLAYLOG)
        with open(path, "a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False) + chr(10))

        self.send_response(204)
        self.end_headers()

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
