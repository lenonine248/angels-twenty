// プレイ記録。
//
// 難易度調整のための一次資料。
// 実際に遊んでいるのは作者ひとりなので、その1回のプレイが最良のデータになる。
// 「難しすぎる」という感想より、「毎回 SAM 圏の手前で2機失っている」という
// 事実のほうが調整の役に立つ。
//
// 記録するのは結果だけでなく、**どこで何が起きたか**まで。
// 位置が分かると、地形・防空・進入経路のどれが効いているのかを切り分けられる。
//
// 保存先は2つ。
//   1. localStorage       … ゲーム内で集計を見るため
//   2. playlog.jsonl      … 開発サーバー(devserver.py)へ送って**ファイルに残す**ため
//
// 2 が要るのは、localStorage が「そのブラウザのそのオリジン」に閉じていて、
// 開発側からは読めないから。難易度調整の材料にするにはファイルに落ちている必要がある。
// 送るのはローカルで遊んでいるときだけ（公開版は送り先が無いので送らない）。
//
//   AT.telemetry.text()     直近の記録を JSON 文字列で得る（コンソールから読む用）
//   AT.telemetry.summary()  ステージごとの平均を表で見る
//   AT.telemetry.clear()    記録を消す
//
// **1行は「何が起きたか」の索引で、中身はリプレイにある**（PROPOSAL_playlog）。
// 行の `replay` が `replays/plays/` に自動で落ちたリプレイを指す。
// 理由（誰が先に見つけたか・どこで分かれたか）は `tools/report.js` がリプレイから起こす。

import { onDevServer } from './devserver.js';

const KEY = 'angels_twenty_telemetry_v1';
const MAX_RUNS = 40;          // これを超えたら古いものから捨てる

let current = null;
let runs = load();

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    return [];
  }
}

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(runs.slice(-MAX_RUNS)));
  } catch (e) { /* 容量超過などは黙って諦める */ }
}

/** ミッション開始 */
/**
 * @param {string} version その戦闘を遊んだ版（§31）
 * @param {?number} seed   その戦闘の乱数の種（§24）
 */
export function begin(stage, loadouts, version, seed) {
  const id = playId(stage.id);
  current = {
    // **その回の名前**（PROPOSAL_playlog P1）。リプレイの自動保存のファイル名と、
    // あとから足す一言（`comment`）がこの名前でこの行に結び付く
    id,
    replay: `${REPLAY_SUB}/${id}.json`,
    // **版を必ず残す。** これが無いと、調整の前後の記録が同じファイルに
    // 混ざって、どちらの数字を見ているのか分からなくなる（実際そうなった）。
    version: version || '?',
    // 種も残す。気になる回をあとから同じ条件で再現できる（AT.startStage(i, seed)）
    seed: seed ?? null,
    stage: stage.id,
    name: stage.name,
    points: stage.weaponPoints,
    loadout: (loadouts || []).map((l) => l.join('+')),
    events: [],
    shots: {},          // 兵装ごとの発射数
    hits: {},           // 兵装ごとの命中数
  };
}

/** リプレイの自動保存の置き場（`replays/` の下・devserver.py の PLAYS_DIR と同じ） */
export const REPLAY_SUB = 'plays';

/**
 * 回の名前。`20261001-161644-s5` の形 —— 名前の順が時刻の順になる（devserver の一覧が新しい順に並べる）。
 * 手元の時刻で付ける。読むのは人なので UTC より分かりやすい
 */
function playId(stageId) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const safe = String(stageId).replace(/[^A-Za-z0-9_-]/g, '_');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
    + `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${safe}`;
}

/** 進行中の回の名前（無ければ null） */
export function currentId() { return current ? current.id : null; }

/**
 * 出撃前に書いた作戦（PROPOSAL_playlog P4）。空なら残さない
 */
export function setPlan(text) {
  if (!current) return;
  const t = String(text || '').trim();
  if (t) current.plan = t; else delete current.plan;
}

/**
 * 戦闘中のメモ（PROPOSAL_playlog P4・L4）。`units` は選んでいた機体の名前
 */
export function note(time, text, units) {
  if (!current) return;
  const t = String(text || '').trim();
  if (!t) return;
  (current.notes ||= []).push({ t: Math.round(time), text: t, ...(units && units.length ? { units } : {}) });
}

/**
 * 終わったあとの一言（PROPOSAL_playlog P3）。行はもう送ってあるので、
 * **別の行として足す**（`type: 'comment'`）。読む側が `id` で結び付ける
 */
export function comment(id, text) {
  const t = String(text || '').trim();
  if (!id || !t) return;
  const r = runs.find((x) => x.id === id);
  if (r) { r.comment = t; save(); }
  post({ type: 'comment', id, text: t });
}

/** ミッション中の出来事。pos は {x,z} だけ丸めて持つ。 */
export function mark(type, time, unit, extra) {
  if (!current) return;
  current.events.push({
    t: Math.round(time),
    type,
    name: unit ? unit.name : '',
    side: unit ? unit.side : '',
    x: unit ? Math.round(unit.pos.x) : 0,
    z: unit ? Math.round(unit.pos.z) : 0,
    alt: unit ? Math.round(unit.pos.y) : 0,
    ...(extra || {}),
  });
}

export function markShot(weaponId) {
  if (!current || !weaponId) return;
  current.shots[weaponId] = (current.shots[weaponId] || 0) + 1;
}

export function markHit(weaponId) {
  if (!current || !weaponId) return;
  current.hits[weaponId] = (current.hits[weaponId] || 0) + 1;
}

/** ミッション終了 */
export function end(result, stats) {
  if (!current) return;
  current.result = result;                 // 'clear' | 'fail' | 'abort'
  current.sec = Math.round(stats.sec || 0);
  current.kills = stats.kills || 0;
  current.losses = stats.losses || 0;
  current.pointsLeft = stats.pointsLeft ?? null;
  current.rank = stats.rank ?? null;        // クリア評価（§18）。失敗時は null
  runs.push(current);
  if (runs.length > MAX_RUNS) runs = runs.slice(-MAX_RUNS);
  const finished = current;
  current = null;
  save();
  post(finished);
  return finished.id;
}

/** 開発サーバーへ送ってファイルに残す。失敗しても黙って諦める（遊びを止めない）。 */
function post(record) {
  if (!onDevServer()) return;
  try {
    fetch('/telemetry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ at: new Date().toISOString(), ...record }),
      keepalive: true,
    }).catch(() => {});
  } catch (e) { /* noop */ }
}

export function all() { return runs; }

export function text() { return JSON.stringify(runs, null, 1); }

export function clear() { runs = []; save(); return '記録を消しました'; }

/** ステージごとの傾向。難易度カーブを見るのはこれ。 */
export function summary() {
  const byStage = new Map();
  for (const r of runs) {
    if (!byStage.has(r.stage)) byStage.set(r.stage, []);
    byStage.get(r.stage).push(r);
  }
  const rows = [];
  for (const [id, list] of byStage) {
    const cleared = list.filter((r) => r.result === 'clear');
    const avg = (a, f) => (a.length ? +(a.reduce((s, r) => s + f(r), 0) / a.length).toFixed(1) : null);
    // どこで失ったかの重心（自軍の損失位置）
    const lost = list.flatMap((r) => r.events.filter((e) => e.type === 'loss' && e.side === 'blue'));
    rows.push({
      stage: id,
      name: list[0].name,
      回数: list.length,
      クリア率: `${cleared.length}/${list.length}`,
      平均秒: avg(cleared, (r) => r.sec),
      平均撃墜: avg(list, (r) => r.kills),
      平均損失: avg(list, (r) => r.losses),
      使用P: avg(cleared, (r) => r.points - (r.pointsLeft ?? r.points)),
      損失地点: lost.length
        ? `${Math.round(lost.reduce((s, e) => s + e.x, 0) / lost.length)},`
          + `${Math.round(lost.reduce((s, e) => s + e.z, 0) / lost.length)}`
        : '—',
      損失の主因: mode(lost.map((e) => e.cause || '被弾')),
      // クリア評価の分布（§18）。基準値が甘すぎ／辛すぎを見るのはここ
      評価: cleared.length
        ? ['S', 'A', 'B', 'C']
          .map((k) => [k, cleared.filter((r) => r.rank === k).length])
          .filter(([, n]) => n > 0).map(([k, n]) => `${k}${n}`).join(' ') || '—'
        : '—',
    });
  }
  return rows;
}

function mode(arr) {
  if (!arr.length) return '—';
  const c = new Map();
  for (const v of arr) c.set(v, (c.get(v) || 0) + 1);
  return [...c.entries()].sort((a, b) => b[1] - a[1])[0][0];
}
