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
//   AT.telemetry.text()     直近の記録を JSON 文字列で得る（コンソールから読む用）
//   AT.telemetry.summary()  ステージごとの平均を表で見る
//   AT.telemetry.clear()    記録を消す

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
export function begin(stage, loadouts) {
  current = {
    stage: stage.id,
    name: stage.name,
    points: stage.weaponPoints,
    loadout: (loadouts || []).map((l) => l.join('+')),
    events: [],
    shots: {},          // 兵装ごとの発射数
    hits: {},           // 兵装ごとの命中数
  };
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
  runs.push(current);
  if (runs.length > MAX_RUNS) runs = runs.slice(-MAX_RUNS);
  current = null;
  save();
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
