"""プレイ記録（playlog.jsonl）を読む。

ゲームはミッションが終わるたびに devserver.py へ記録を送り、
playlog.jsonl に1行1件で追記される。難易度調整の一次資料。

    python tools/playlog.py            ステージごとの傾向
    python tools/playlog.py --runs     1回ごとの結果
    python tools/playlog.py --events   損失・撃墜の起きた場所と時刻
    python tools/playlog.py --stage s2 ステージを絞る
"""

import collections
import io
import json
import os
import sys

# Windows のコンソールは既定が cp932 で、記号や一部の文字が落ちる。
# 出力側を UTF-8 に固定しておく。
try:
    sys.stdout.reconfigure(encoding="utf-8")
except (AttributeError, ValueError):
    pass

LOG = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "playlog.jsonl")


def load(stage=None):
    if not os.path.exists(LOG):
        return []
    runs = []
    with io.open(LOG, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                r = json.loads(line)
            except json.JSONDecodeError:
                continue
            if stage and r.get("stage") != stage:
                continue
            runs.append(r)
    return runs


def summary(runs):
    by = collections.OrderedDict()
    for r in runs:
        by.setdefault(r["stage"], []).append(r)

    print(f"{'ステージ':<16}{'回数':>4}{'クリア':>8}{'中央秒':>8}"
          f"{'撃墜':>6}{'損失':>6}{'使用P':>7}  損失の重心 / 主因")
    print("-" * 92)
    for sid, list_ in by.items():
        cleared = [r for r in list_ if r.get("result") == "clear"]
        secs = sorted(r["sec"] for r in cleared)
        med = secs[len(secs) // 2] if secs else None
        used = [r["points"] - (r.get("pointsLeft") or 0) for r in cleared]
        lost = [e for r in list_ for e in r["events"]
                if e["type"] == "loss" and e["side"] == "blue"]
        cx = sum(e["x"] for e in lost) // len(lost) if lost else 0
        cz = sum(e["z"] for e in lost) // len(lost) if lost else 0
        causes = collections.Counter(e.get("cause", "被弾") for e in lost)
        top = causes.most_common(1)[0][0] if causes else "-"
        print(f"{list_[0]['name']:<16}{len(list_):>4}"
              f"{f'{len(cleared)}/{len(list_)}':>8}"
              f"{(med if med is not None else '-'):>8}"
              f"{avg(list_, 'kills'):>6}{avg(list_, 'losses'):>6}"
              f"{(round(sum(used) / len(used), 1) if used else '-'):>7}"
              f"  {f'({cx},{cz})' if lost else '-':<16}{top}")


def avg(list_, key):
    if not list_:
        return "-"
    return round(sum(r.get(key, 0) for r in list_) / len(list_), 1)


def runs_table(runs):
    for r in runs:
        shots = sum(r["shots"].values())
        hits = sum(r["hits"].values())
        pk = f"{hits / shots:.0%}" if shots else "-"
        print(f"{r['at'][:16]}  {r['name']:<14}{r['result']:<6}"
              f"{r['sec']:>5}秒  撃墜{r['kills']} 損失{r['losses']}  "
              f"発射{shots}/命中{hits}({pk})  {r.get('loadout')}")


def events(runs):
    for r in runs:
        print(f"\n=== {r['at'][:16]} {r['name']} {r['result']} {r['sec']}秒 ===")
        for e in r["events"]:
            side = "自軍" if e["side"] == "blue" else "敵"
            print(f"  t{e['t']:<5}{e['type']:<9}{side} {e['name']:<12}"
                  f"({e['x']:>6},{e['z']:>6}) 高度{e['alt']:>5}  {e.get('cause', '')}")


def main():
    args = sys.argv[1:]
    stage = None
    if "--stage" in args:
        stage = args[args.index("--stage") + 1]
    runs = load(stage)
    if not runs:
        print("記録がありません。devserver.py 経由で遊ぶと playlog.jsonl に溜まります。")
        return
    if "--events" in args:
        events(runs)
    elif "--runs" in args:
        runs_table(runs)
    else:
        summary(runs)
        print(f"\n合計 {len(runs)} 件 / 詳細は --runs, --events")


if __name__ == "__main__":
    main()
