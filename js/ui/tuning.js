// ステージの調整パネル。仕様書 §47。
//
// **作るための道具ではなく、詰めるための道具。**
// 地形やユニットの配置を組む（authoring）のではなく、
// 既にあるステージの難易度を触って（tuning）すぐ遊び直すためのもの。
//
// 目的は**手戻りを短くすること**。これまでは
//   `stages.js` を編集 → 再読み込み → 遊ぶ
// という往復が要ったので、値を1つ試すのに数分かかっていた。
//
// 触った値は localStorage に残り、**ステージ選択とブリーフィングに印が出る**。
// 印を出すのは、調整中であることを忘れてベンチの数字を読むのを防ぐため
// （`tools/bench.js` も読み込み時に警告する）。

import { STAGES } from '../data/stages.js';
import { ENEMY_TYPES, SUPPORT_TYPES, defaultEnemyLoadout } from '../data/aircraft.js';
import { isDebug } from '../core/debug.js';
import { loadoutRow, removeOne, LOADOUT_HINT } from './loadout.js';

const KEY = 'at_stage_tuning_v1';

/** 敵に積める兵装 */
const ENEMY_LOADABLE = ['AAM-S', 'AAM-M', 'AAM-A', 'AGM', 'ARM', 'BOMB'];

/**
 * 手を入れていない定義の控え。
 *
 * **上書きは必ずここから作り直す。** 触った値の上にさらに触ると、
 * 「既定に戻す」で戻せなくなる（元がどこにも残らない）。
 */
const PRISTINE = new Map(STAGES.map((s) => [s.id, structuredClone(s)]));

/** ステージIDごとの上書き */
let overrides = load();

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function persist() {
  try { localStorage.setItem(KEY, JSON.stringify(overrides)); } catch { /* 保存できなくても続ける */ }
}

/** 手が入っているステージのID一覧 */
export function tunedIds() {
  if (!isDebug()) return [];              // 効いていないものを「調整中」とは言わない
  return Object.keys(overrides).filter((id) => overrides[id] && Object.keys(overrides[id]).length);
}

export function isTuned(id) { return tunedIds().includes(id); }

/**
 * 上書きを実際の `STAGES` に反映する。
 *
 * **`STAGES` の要素を差し替える。** ブリーフィング・出撃・評価・ベンチが
 * すべて同じ配列を見ているので、ここで揃えれば下流に手を入れずに済む。
 */
export function apply(id) {
  const idx = STAGES.findIndex((s) => s.id === id);
  if (idx < 0) return null;
  const base = structuredClone(PRISTINE.get(id));
  // **デバッグモードが切れていれば、保存された調整値は読まない**（§47.2）。
  // 入り口を隠すだけだと、以前入れた調整が公開版に効いたままになる。
  const o = isDebug() ? overrides[id] : null;

  if (o) {
    if (o.weaponPoints != null) base.weaponPoints = o.weaponPoints;
    if (o.skill != null) { base.enemy = base.enemy || {}; base.enemy.skill = o.skill; }
    if (o.rating) base.rating = { ...base.rating, ...o.rating };

    const list = (base.enemy && base.enemy.aircraft) || [];
    const kept = [];
    list.forEach((a, i) => {
      const e = o.enemy && o.enemy[i];
      if (e && e.off) return;                       // 出さない敵
      if (e && e.loadout) a.loadout = e.loadout.slice();
      kept.push(a);
    });
    // 足した敵。**配置は触らない方針**なので、最後の1機からずらして置くだけ
    for (const add of o.extra || []) {
      const src = list[list.length - 1] || kept[kept.length - 1];
      if (!src) break;
      const clone = structuredClone(src);
      clone.name = add.name;
      clone.type = add.type;
      clone.x = (src.x || 0) + add.dx;
      clone.z = (src.z || 0) + add.dz;
      kept.push(clone);
    }
    if (base.enemy) base.enemy.aircraft = kept;
  }

  STAGES[idx] = base;
  return base;
}

/** すべての上書きを反映し直す */
export function applyAll() { for (const id of PRISTINE.keys()) apply(id); }

export function reset(id) { delete overrides[id]; persist(); apply(id); }

export function resetAll() { overrides = {}; persist(); applyAll(); }

/** いまの内容を `stages.js` に写せる形で書き出す */
export function snippet(id) {
  const s = STAGES.find((x) => x.id === id);
  if (!s) return '';
  const o = overrides[id];
  if (!o || !Object.keys(o).length) return `// ${id} は調整していません`;
  const r = s.rating;
  const q = (v) => JSON.stringify(v);
  const lines = [
    `// ${s.name}（${s.title}）の調整結果 — stages.js に写す`,
    `weaponPoints: ${s.weaponPoints},`,
    `rating: { time: [${r.time}], points: [${r.points}], losses: [${r.losses}] },`,
  ];
  if (s.enemy && s.enemy.skill != null) lines.push(`enemy.skill: ${s.enemy.skill},`);
  lines.push('enemy.aircraft: [');
  for (const a of (s.enemy && s.enemy.aircraft) || []) {
    lines.push(`  { type: ${q(a.type)}, name: ${q(a.name)}, x: ${a.x}, z: ${a.z}, agl: ${a.agl},`
      + ` aiMode: ${q(a.aiMode)}, tags: ${q(a.tags || [])}`
      + (a.loadout ? `, loadout: ${q(a.loadout)}` : '')
      + (a.strikeTargetTag ? `, strikeTargetTag: ${q(a.strikeTargetTag)}` : '')
      + ' },');
  }
  lines.push('],');
  return lines.join('\n');
}

// ---------------------------------------------------------------- パネル

function ov(id) {
  if (!overrides[id]) overrides[id] = {};
  return overrides[id];
}

/**
 * パネルの中身。
 *
 * 触れるのは**数と強さ**だけにしてある（配置・地形・目標は触らない）。
 * 位置を動かしたくなったらエディタの話になるので、そこは切ってある。
 */
export function render(id) {
  const s = STAGES.find((x) => x.id === id);
  if (!s) return '';
  const o = overrides[id] || {};
  const base = PRISTINE.get(id);
  const r = s.rating;

  const num = (label, key, val, min, max, step, note) =>
    `<div class="tn-row"><label>${label}</label>`
    + `<input type="number" data-tn="${key}" value="${val}" min="${min}" max="${max}" step="${step}">`
    + `<span class="tn-note">${note || ''}</span></div>`;

  const foes = ((base.enemy && base.enemy.aircraft) || []).map((a, i) => {
    const e = (o.enemy && o.enemy[i]) || {};
    // 既定搭載（ステージ定義に書かれていない機体）もそのまま出す。
    // 「既定」とだけ表示すると、何を積んでいるのか分からないまま触ることになる。
    const load = e.loadout || a.loadout || defaultEnemyLoadout(a.type);
    // 敵の搭載はスロットもポイントも見ない（難易度を試すための欄なので）
    const row = loadoutRow({
      loadout: load, list: ENEMY_LOADABLE,
      add: (id) => `data-tna="${i}:${id}"`,
      del: (id) => `data-tnd="${i}:${id}"`,
    });
    return `<div class="tn-foe${e.off ? ' off' : ''}">
      <div class="tn-foe-head">
        <button class="autow${e.off ? ' off' : ''}" data-tnoff="${i}">${e.off ? '出さない' : '出す'}</button>
        <b>${a.name}</b><span>${a.type}</span>
        <span class="ld-hint">${LOADOUT_HINT}</span>
      </div>
      <div class="bf-add">${row}</div>
    </div>`;
  }).join('');

  const extra = (o.extra || []).map((x, i) =>
    `<div class="tn-foe"><div class="tn-foe-head">
      <button class="autow" data-tnrem="${i}">外す</button>
      <b>${x.name}</b><span>${x.type}（追加）</span></div></div>`).join('');

  const types = [...Object.keys(ENEMY_TYPES), ...Object.keys(SUPPORT_TYPES)];
  const addFoe = types.map((t) => `<button class="addw" data-tnadd="${t}">+${t}</button>`).join('');

  return `<div class="tn-panel">
    <div class="tn-head">
      <span class="tn-title">難易度調整 — ${s.name}</span>
      <button class="autow" data-act="tuneReset">既定に戻す</button>
      <button class="autow" data-act="tuneCopy">コピー用に出力</button>
      <button class="cl-close" data-act="tuneClose">閉じる</button>
    </div>
    <div class="tn-warn">値はこのブラウザに保存され、ベンチにもそのまま効きます。
      釣り合いを測るときは「既定に戻す」を押してください。</div>
    <div class="tn-body">
      <div class="tn-col">
        <div class="bf-section">全体</div>
        ${num('兵装ポイント上限', 'weaponPoints', s.weaponPoints, 0, 200, 2, `既定 ${base.weaponPoints}`)}
        ${num('敵の練度', 'skill', (s.enemy && s.enemy.skill) != null ? s.enemy.skill : 1, 0.4, 1.4, 0.05, '下げると消極的に')}
        <div class="bf-section">評価の基準</div>
        ${num('迅速 ◎(秒)', 'time0', r.time[0], 10, 900, 10, '')}
        ${num('迅速 ○(秒)', 'time1', r.time[1], 10, 900, 10, '')}
        ${num('節約 ◎(P)', 'points0', r.points[0], 0, 120, 1, '')}
        ${num('節約 ○(P)', 'points1', r.points[1], 0, 120, 1, '')}
        ${num('練度 ◎(損失)', 'losses0', r.losses[0], 0, 10, 1, '')}
        ${num('練度 ○(損失)', 'losses1', r.losses[1], 0, 10, 1, '')}
      </div>
      <div class="tn-col wide">
        <div class="bf-section">敵編成</div>
        ${foes}${extra}
        <div class="tn-add-foe"><span class="tn-note">敵を足す</span>${addFoe}</div>
      </div>
    </div>
    <pre class="tn-out hidden" id="tnOut"></pre>
  </div>`;
}

/**
 * パネル内のクリックを処理する。
 * @returns {boolean} 何か変えたら true（呼び出し側が描き直す）
 */
export function handle(id, e) {
  const off = e.target.closest('[data-tnoff]');
  if (off) {
    const o = ov(id);
    const i = Number(off.dataset.tnoff);
    o.enemy = o.enemy || {};
    o.enemy[i] = o.enemy[i] || {};
    o.enemy[i].off = !o.enemy[i].off;
    return commit(id);
  }
  const add = e.target.closest('[data-tna]');
  if (add) {
    const o = ov(id);
    const parts = add.dataset.tna.split(':');
    const k = Number(parts[0]);
    o.enemy = o.enemy || {};
    o.enemy[k] = o.enemy[k] || {};
    const src = PRISTINE.get(id).enemy.aircraft[k];
    const cur = o.enemy[k].loadout || (src.loadout || defaultEnemyLoadout(src.type)).slice();
    cur.push(parts[1]);
    o.enemy[k].loadout = cur;
    return commit(id);
  }
  const del = e.target.closest('[data-tnd]');
  if (del && !del.classList.contains('disabled')) {
    const o = ov(id);
    const parts = del.dataset.tnd.split(':');
    const i = Number(parts[0]);
    o.enemy = o.enemy || {};
    o.enemy[i] = o.enemy[i] || {};
    const src = PRISTINE.get(id).enemy.aircraft[i];
    const cur = o.enemy[i].loadout || (src.loadout || defaultEnemyLoadout(src.type)).slice();
    o.enemy[i].loadout = removeOne(cur, parts[1]);
    return commit(id);
  }
  const newFoe = e.target.closest('[data-tnadd]');
  if (newFoe) {
    const o = ov(id);
    o.extra = o.extra || [];
    const n = o.extra.length + 1;
    o.extra.push({ type: newFoe.dataset.tnadd, name: `追加 ${n}`, dx: -1500 * n, dz: 1200 * n });
    return commit(id);
  }
  const rem = e.target.closest('[data-tnrem]');
  if (rem) {
    const o = ov(id);
    o.extra.splice(Number(rem.dataset.tnrem), 1);
    return commit(id);
  }
  return false;
}

/** 数値入力の反映 */
export function handleInput(id, el) {
  const key = el.dataset.tn;
  if (!key) return false;
  const v = Number(el.value);
  if (!Number.isFinite(v)) return false;
  const o = ov(id);
  const s = STAGES.find((x) => x.id === id);
  if (key === 'weaponPoints') { o.weaponPoints = v; return commit(id); }
  if (key === 'skill') { o.skill = v; return commit(id); }
  const m = key.match(/^(time|points|losses)([01])$/);
  if (!m) return false;
  const cur = (o.rating && o.rating[m[1]]) ? o.rating[m[1]].slice() : s.rating[m[1]].slice();
  cur[Number(m[2])] = v;
  o.rating = o.rating || {};
  o.rating[m[1]] = cur;
  return commit(id);
}

function commit(id) { persist(); apply(id); return true; }

applyAll();
