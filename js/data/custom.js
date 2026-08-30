// 自作ステージの保管庫。仕様書 §66。
//
// **保存するのはステージ定義そのまま**（`stages.js` の要素と同じ形）。
// 中間表現を挟まない —— 挟むと「エディタでは動くが本編では動かない」が起きる。
// 遊ぶ側（`buildBattle` / ブリーフィング / 評価）はどれも
// ステージ**オブジェクト**を受け取る作りなので、配列に居なくても動く。
//
// デバッグモード（§47.2）のときだけ `stageList()` に混ざる。
// 切っていれば読み込みもしない ── 隠すだけだと、
// 作りかけの面が公開版のステージ一覧に出てしまう。

import { AIRCRAFT_TYPES, ENEMY_TYPES, SUPPORT_TYPES } from './aircraft.js';
import { GROUND_TYPES } from './ground.js';
import { loadoutCost, loadoutFits, hardpointsOf } from './weapons.js';
import { MAP_SIZE } from '../world/terrain.js';

const KEY = 'at_custom_stages_v1';

/** 保存できるステージ数の上限。localStorage を埋め尽くさないため */
const MAX_STAGES = 40;

/** 目標の型（§13） */
export const OBJECTIVE_TYPES = ['destroyAll', 'protect', 'hold', 'reach', 'survive'];

/** 敵機に選べる型 */
export const ENEMY_AIR_TYPES = [...Object.keys(ENEMY_TYPES), ...Object.keys(SUPPORT_TYPES)];
/** 自軍機に選べる型 */
export const FRIENDLY_AIR_TYPES = [...Object.keys(AIRCRAFT_TYPES), ...Object.keys(SUPPORT_TYPES)];
/** 地上に置ける型 */
export const GROUND_PLACEABLE = Object.keys(GROUND_TYPES).filter((k) => k !== 'AIRBASE');

let cache = null;

function read() {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(KEY);
    const data = raw ? JSON.parse(raw) : null;
    cache = Array.isArray(data && data.stages) ? data.stages : [];
  } catch { cache = []; }
  return cache;
}

function write() {
  try { localStorage.setItem(KEY, JSON.stringify({ v: 1, stages: cache })); return true; }
  catch { return false; }
}

/** 保存されている自作ステージ（順序は作った順） */
export function customStages() { return read(); }

export function getCustom(id) { return read().find((s) => s.id === id) || null; }

/** 次に使える id。`c1`, `c2`, … */
function nextId() {
  const used = new Set(read().map((s) => s.id));
  for (let i = 1; i <= MAX_STAGES + 5; i++) {
    const id = 'c' + i;
    if (!used.has(id)) return id;
  }
  return 'c' + (Date.now() % 100000);
}

/**
 * 白紙のステージ。
 *
 * **そのまま試遊できる形にしておく。** 空の定義から始めると、
 * 最初の1回が必ず「遊べません」で跳ね返される。
 */
export function blankStage() {
  return {
    id: nextId(),
    custom: true,
    name: 'NEW MISSION',
    title: '新しい任務',
    brief: '任務の説明をここに書く。',
    hint: '',
    terrain: { seed: 10000 + Math.floor(Math.random() * 89999), mountainAmount: 0.8,
      coast: 'none', valleyDepth: 0.9, rivers: 2, baseAltitude: 400 },
    weaponPoints: 24,
    friendly: {
      base: { x: 10000, z: 40000 },
      startAirborne: true,
      startAlt: 4500,
      aircraft: [
        { type: 'F-1', name: 'VIPER 1', loadout: ['AAM-M', 'AAM-M', 'AAM-S', 'AAM-S'] },
      ],
    },
    enemy: {
      skill: 0.6,
      aircraft: [
        { type: 'J-7', name: 'BANDIT 1', x: 34000, z: 20000, agl: 5000,
          aiMode: 'PATROL', tags: ['cap'] },
      ],
      ground: [],
    },
    rating: { time: [300, 600], points: [10, 18], losses: [0, 1] },
    objectives: [
      { id: 'kill', type: 'destroyAll', tag: 'cap', label: '敵機を全機撃墜する' },
    ],
  };
}

/** 既存ステージを下敷きにして複製する（§66.2）。**元の定義には触らない。** */
export function duplicate(stage) {
  const copy = structuredClone(stage);
  copy.id = nextId();
  copy.custom = true;
  copy.name = (stage.name || 'STAGE') + ' COPY';
  delete copy.debug;
  return copy;
}

/** 保存（新規なら足す、既にあれば差し替える） */
export function save(stage) {
  const list = read();
  if (!stage.id) stage.id = nextId();
  stage.custom = true;
  const i = list.findIndex((s) => s.id === stage.id);
  if (i >= 0) list[i] = structuredClone(stage);
  else {
    if (list.length >= MAX_STAGES) return { ok: false, why: `保存できるのは ${MAX_STAGES} 件までです` };
    list.push(structuredClone(stage));
  }
  return write() ? { ok: true } : { ok: false, why: '保存できませんでした（localStorage が一杯かもしれません）' };
}

export function remove(id) {
  const list = read();
  const i = list.findIndex((s) => s.id === id);
  if (i >= 0) { list.splice(i, 1); write(); }
}

// ---------------------------------------------------------------- 検証

/**
 * 遊べる形になっているかを見る（§66.5）。
 *
 * **`fatal` と `warn` を分ける。** 作りかけを保存できないと作業にならないので、
 * **止めるのは「そもそも遊べない」ものだけ**にする。
 */
export function validate(stage) {
  const fatal = [];
  const warn = [];
  const f = stage.friendly || {};
  const e = stage.enemy || {};
  const air = f.aircraft || [];
  const objs = stage.objectives || [];

  if (!air.length) fatal.push('自軍機が1機もいません');
  if (!f.startAirborne && !f.base) fatal.push('地上発進なのに自軍飛行場がありません');
  if (!objs.length) fatal.push('目標が1つもありません');

  // タグの受け皿があるか。**無い目標は永久に達成できない**
  const enemyTags = new Set();
  for (const u of [...(e.aircraft || []), ...(e.ground || [])]) {
    for (const t of u.tags || []) enemyTags.add(t);
  }
  for (const key of ['base', 'base2']) {
    for (const t of (e[key] && e[key].tags) || []) enemyTags.add(t);
  }
  const friendlyTags = new Set(['home']);          // 自軍飛行場は暗黙に home
  for (const u of [...air, ...(f.ground || []), ...(stage.support || [])]) {
    for (const t of u.tags || []) friendlyTags.add(t);
  }

  for (const o of objs) {
    if (!OBJECTIVE_TYPES.includes(o.type)) { fatal.push(`目標「${o.label || o.id}」の型が不正です`); continue; }
    if (o.type === 'destroyAll' && !enemyTags.has(o.tag)) {
      fatal.push(`目標「${o.label || o.id}」の tag「${o.tag}」を持つ敵がいません`);
    }
    if ((o.type === 'protect' || o.type === 'hold' || o.type === 'reach') && !friendlyTags.has(o.tag)) {
      fatal.push(`目標「${o.label || o.id}」の tag「${o.tag}」を持つ味方がいません`);
    }
    if (o.type === 'reach' && (o.x == null || o.z == null)) {
      fatal.push(`到達目標「${o.label || o.id}」に地点が設定されていません`);
    }
    if (o.type === 'survive' && !(o.seconds > 0)) {
      fatal.push(`耐久目標「${o.label || o.id}」の秒数が設定されていません`);
    }
  }

  // 座標。**地図の外に置くと出撃した瞬間に迷子になる**
  const inside = (x, z) => x >= 0 && x <= MAP_SIZE && z >= 0 && z <= MAP_SIZE;
  const spots = [];
  if (f.base) spots.push(['自軍飛行場', f.base]);
  for (const u of [...(e.aircraft || []), ...(e.ground || [])]) spots.push([u.name || '敵', u]);
  for (const key of ['base', 'base2']) if (e[key]) spots.push([`敵飛行場(${key})`, e[key]]);
  for (const [label, p] of spots) {
    if (p.x != null && !inside(p.x, p.z)) fatal.push(`${label} が地図の外にあります`);
  }

  // 評価の順序（◎ が ○ より厳しい側）
  const r = stage.rating;
  if (r) {
    if (r.time && r.time[0] > r.time[1]) warn.push('評価「迅速」の ◎ が ○ より緩くなっています');
    if (r.points && r.points[0] > r.points[1]) warn.push('評価「節約」の ◎ が ○ より緩くなっています');
    if (r.losses && r.losses[0] > r.losses[1]) warn.push('評価「損失」の ◎ が ○ より緩くなっています');
  }

  // 兵装ポイント（§41.2）
  const preset = air.reduce((n, a) => n + loadoutCost(a.loadout || []), 0);
  if (stage.weaponPoints != null && preset > stage.weaponPoints) {
    fatal.push(`プリセットの搭載 ${preset}P が上限 ${stage.weaponPoints}P を超えています`);
  } else if (r && r.points && preset > r.points[1]) {
    warn.push(`プリセットの搭載 ${preset}P が ○ の帯（${r.points[1]}P）を超えています（§41.2）`);
  }

  // パイロン（§71.5）。**エディタは積み過ぎを止めない**（置きたい物を置く場所なので）
  // 代わりにここで拾う。§70.7 でパイロンが小/中に分かれたのに、
  // 検証はポイントしか見ていなかった —— `_loadoutRow` の注記だけが
  // 「validate が警告として拾う」と言っていて、実際には誰も見ていなかった。
  for (const a of air) {
    const spec = AIRCRAFT_TYPES[a.type];
    if (!spec || !a.loadout) continue;
    if (!loadoutFits(a.loadout, spec)) {
      const cap = hardpointsOf(spec);
      warn.push(`${a.name || a.type} の搭載 ${a.loadout.length}本 が`
        + ` ${a.type} のパイロン（中${cap.medium}・小${cap.small}）に収まりません`);
    }
  }

  if (!e.aircraft?.length && !e.ground?.length && !e.base) warn.push('敵が1つも置かれていません');

  return { fatal, warn, ok: fatal.length === 0 };
}

// ---------------------------------------------------------------- 出口

/** JSON 文字列にする（ファイル書き出し用） */
export function toJSON(stage) { return JSON.stringify(stage, null, 2); }

/**
 * JSON を読み込む。**id は必ず振り直す** ——
 * 他人からもらった面が手元のものを上書きしないように。
 */
export function fromJSON(text) {
  let data;
  try { data = JSON.parse(text); } catch (err) { return { ok: false, why: 'JSON として読めません' }; }
  const list = Array.isArray(data) ? data : (Array.isArray(data.stages) ? data.stages : [data]);
  const added = [];
  for (const s of list) {
    if (!s || typeof s !== 'object' || !s.friendly) continue;
    s.id = nextId();
    s.custom = true;
    const res = save(s);
    if (!res.ok) return { ok: false, why: res.why, added };
    added.push(s.id);
  }
  if (!added.length) return { ok: false, why: 'ステージが1つも入っていません' };
  return { ok: true, added };
}

/**
 * `stages.js` へ貼るコード片（§66.2）。
 * 本編に載せるときは、これを `STAGES` に足して `id` を `s7` などに直す。
 */
export function snippet(stage) {
  const s = structuredClone(stage);
  delete s.custom;
  return JSON.stringify(s, null, 2)
    // キーの引用符を外して JS の書き方に寄せる（そのまま貼れるように）
    .replace(/^(\s*)"([A-Za-z_][A-Za-z0-9_]*)":/gm, '$1$2:')
    .replace(/"/g, "'");
}
