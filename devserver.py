"""ANGELS TWENTY 開発用の静的サーバ。

python -m http.server だとブラウザが ES モジュールをキャッシュしてしまい、
ソースを直しても古いモジュールが読み込まれ続けることがある。
毎回必ず取り直させるため no-store を付けて返すだけのサーバ。

もう二つ役目がある。

1. ミッションが終わるたびにゲームから送られてくるプレイ記録を
   playlog.jsonl へ追記する。記録はブラウザの localStorage にも入るが、
   そちらは開発側から読めないため、難易度調整の材料にするには
   ファイルに落ちている必要がある。
2. 戦闘のリプレイ（仕様 §23）を replays/ へ保存する。
   ブラウザからのダウンロードは環境によって止められるので、
   検証で回した戦闘をそのまま残せるようにしておく。

127.0.0.1 にだけ bind した開発用サーバなので、書き込み口はローカル専用。

    python devserver.py [port]
"""

import functools
import http.server
import json
import os
import sys

PLAYLOG = "playlog.jsonl"
REPLAY_DIR = "replays"
MAX_BODY = 512 * 1024
# リプレイは1戦 85〜400KB（仕様 §23.5）。取りこぼさない余裕を持たせる。
MAX_REPLAY = 8 * 1024 * 1024

# ファイル名に許す文字。パスを外へ出させない。
SAFE_NAME = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.")


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def _root(self):
        return os.path.dirname(os.path.abspath(__file__))

    def _read_body(self, limit):
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return None
        if length <= 0 or length > limit:
            return None
        return self.rfile.read(length)

    def do_GET(self):
        """`/replays/index.json` だけ横取りして、その場で一覧を組み立てる。"""
        if self.path.split("?")[0] == "/replays/index.json":
            self._replay_index()
            return
        super().do_GET()

    def _replay_index(self):
        """replays/ にある記録の一覧を返す（タイトルの「リプレイ」がこれを読む）。

        **静的なマニフェストは置かない。** リプレイを足したり消したりしたときに
        古くなり、「一覧に出ているのに開けない」が起きる。
        記録そのものに面・結果・種が入っている（`recorder.toJSON`）ので、
        毎回ここから読み直せば**ずれようがない。**
        """
        out = []
        d = os.path.join(self._root(), REPLAY_DIR)
        for name in sorted(os.listdir(d)) if os.path.isdir(d) else []:
            if not name.endswith(".json") or name == "index.json":
                continue
            try:
                with open(os.path.join(d, name), encoding="utf-8") as f:
                    rec = json.load(f)
            except (OSError, UnicodeDecodeError, json.JSONDecodeError):
                continue                       # 壊れた記録は黙って飛ばす
            stage = rec.get("stage") or {}
            stats = rec.get("stats") or {}
            # **結末の書き方が2通りある。**
            # ゲーム本体は文字列（"clear"/"fail"）、ベンチは
            # {state, reason, sec} の入れ物で書く（`tools/bench.js`）。
            # どちらも開けるように、ここで1つの形へ均す。
            res = rec.get("result")
            if isinstance(res, dict):
                state, reason = res.get("state") or "", res.get("reason") or ""
                sec = res.get("sec")
            else:
                state, reason, sec = res or "", "", None
            out.append({
                "file": name,
                "stage": stage.get("name") or name,
                "title": stage.get("title") or "",
                "result": "clear" if state == "clear" else "fail",
                "reason": reason,
                "seed": rec.get("seed"),
                "version": rec.get("version") or "",
                "sec": stats.get("sec") if stats.get("sec") is not None else sec,
                "kills": stats.get("kills"),
                "losses": stats.get("losses"),
            })
        body = json.dumps(out, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        """/replay/ はリプレイの保存、/telemetry はプレイ記録の追記。"""
        if self.path.startswith("/replay/"):
            self._save_replay()
            return
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

    def _save_replay(self):
        """POST /replay/<name>.json で戦闘の記録を replays/ に置く。"""
        name = self.path[len("/replay/"):]
        if not name or not all(c in SAFE_NAME for c in name) or ".." in name:
            self.send_error(400, "bad name")
            return
        if not name.endswith(".json"):
            name += ".json"
        raw = self._read_body(MAX_REPLAY)
        if raw is None:
            self.send_error(400, "bad body")
            return
        try:
            json.loads(raw.decode("utf-8"))          # 壊れたものは置かない
        except (UnicodeDecodeError, json.JSONDecodeError):
            self.send_error(400, "not json")
            return
        out = os.path.join(self._root(), REPLAY_DIR)
        os.makedirs(out, exist_ok=True)
        with open(os.path.join(out, name), "wb") as f:
            f.write(raw)
        self.send_response(204)
        self.end_headers()

    def log_message(self, fmt, *args):
        # 404 だけ出す（通常のアクセスログはうるさいので抑制）
        if args and str(args[1]).startswith("4"):
            super().log_message(fmt, *args)


def main():
    # ポートの決め方（優先順）:
    #   1. 引数        … 人が手で立てるとき `python devserver.py 9000`
    #   2. 環境変数 PORT … ツール側が空きポートを割り当てて渡してくる
    #   3. 既定 8187
    #
    # **2 を足したのは、8187 を決め打ちにしていたせい。**
    # 前のサーバーが残っているとポートが埋まって起動できず、
    # そのたびに「誰が掴んでいるか」を調べることになっていた。
    # このサーバーは静的ファイルを配るだけで、
    # **特定のポートである必要がどこにも無い**（OAuth の戻り先も webhook も無い）。
    if len(sys.argv) > 1:
        port = int(sys.argv[1])
    else:
        port = int(os.environ.get("PORT") or 8187)
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
