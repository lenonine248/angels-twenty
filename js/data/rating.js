// クリア評価。仕様書 §18。
//
// クリアしたときだけ3軸を評価し、合計点で総合ランクを出す。
//
//   迅速  クリアまでの時間     早く決着をつけたか
//   節約  使用した兵装ポイント  高価な兵装に頼らず勝てたか
//   練度  機体の損失数         被害を出さずに済んだか
//
// 3軸が同時に満点になりにくい構造は既にゲーム側にある。
// AAM-A を積めば速く安全に終わるが兵装ポイントを食う。
// ここはその結果を読むだけで、評価のために何かを仕込むことはしない。
//
// 基準値はステージ定義が持つ（§18）。
//
//   rating: { time: [180, 300], points: [10, 18], losses: [0, 1] }
//
// 各軸 [◎の上限, ○の上限]。○の上限も超えたら △。
// **どの軸も「小さいほど良い」で揃えてある。** 揃えておかないと
// 基準値を書くときに向きを間違える。

/** 総合ランク。良い順。markRating() の order にそのまま渡す */
export const RANKS = ['S', 'A', 'B', 'C'];

export const MARKS = { GOOD: '◎', OK: '○', POOR: '△' };

/** ◎=2 / ○=1 / △=0 */
const MARK_SCORE = { [MARKS.GOOD]: 2, [MARKS.OK]: 1, [MARKS.POOR]: 0 };

/** 合計点 → 総合ランク。6:S ／ 4〜5:A ／ 2〜3:B ／ 0〜1:C */
function rankOf(score) {
  if (score >= 6) return 'S';
  if (score >= 4) return 'A';
  if (score >= 2) return 'B';
  return 'C';
}

/** 秒を m:ss に */
function mmss(sec) {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * 軸の定義。value は「小さいほど良い」量を返す。
 * fmt は画面に出す文字列。
 */
const AXES = [
  {
    key: 'time',
    label: '迅速',
    desc: 'クリアまでの時間',
    value: (st) => st.sec,
    fmt: (v) => mmss(v),
  },
  {
    key: 'points',
    label: '節約',
    desc: '使用した兵装ポイント',
    value: (st) => st.pointsUsed,
    fmt: (v) => `${Math.round(v)}P`,
  },
  {
    key: 'losses',
    label: '練度',
    desc: '失った機体の数',
    value: (st) => st.losses,
    fmt: (v) => `${v}機`,
  },
];

/** しきい値から ◎○△ を決める。thr = [◎の上限, ○の上限] */
function markFor(value, thr) {
  if (!thr) return MARKS.OK;              // 基準が無ければ真ん中に寄せる
  if (value <= thr[0]) return MARKS.GOOD;
  if (value <= thr[1]) return MARKS.OK;
  return MARKS.POOR;
}

/**
 * 評価を出す。
 *
 * @param {object} stage ステージ定義（stage.rating を見る）
 * @param {object} stats { sec, pointsUsed, losses }
 * @returns {?object} { axes:[{key,label,desc,value,text,mark,target}], score, rank }
 *   基準値を持たないステージでは null（＝評価を出さない）
 */
export function evaluate(stage, stats) {
  const thresholds = stage && stage.rating;
  if (!thresholds) return null;

  const axes = AXES.map((a) => {
    const thr = thresholds[a.key];
    const value = a.value(stats) ?? 0;
    return {
      key: a.key,
      label: a.label,
      desc: a.desc,
      value,
      text: a.fmt(value),
      mark: markFor(value, thr),
      // 「あと少しで◎だった」が分かるように、◎の基準も見せる
      target: thr ? a.fmt(thr[0]) : null,
    };
  });

  const score = axes.reduce((n, a) => n + MARK_SCORE[a.mark], 0);
  return { axes, score, rank: rankOf(score) };
}

/**
 * ブリーフィングで見せる基準の一覧。
 * 何を目指せばいいのか分からないままでは、評価はただの後出しになる。
 */
export function ratingTargets(stage) {
  const thresholds = stage && stage.rating;
  if (!thresholds) return null;
  return AXES.map((a) => ({
    label: a.label,
    desc: a.desc,
    good: thresholds[a.key] ? a.fmt(thresholds[a.key][0]) : '—',
    ok: thresholds[a.key] ? a.fmt(thresholds[a.key][1]) : '—',
  }));
}

/** rank が prev より良いか（prev が無ければ常に true） */
export function isBetterRank(rank, prev) {
  if (!prev) return true;
  return RANKS.indexOf(rank) < RANKS.indexOf(prev);
}
