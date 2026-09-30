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
import { CLOUD_COVER, CLOUD_SHAPE } from '../world/clouds.js';
import { TRIGGER_CONDITIONS, TRIGGER_ACTIONS } from '../sim/triggers.js';
import { GROUND_MODES } from '../sim/ground.js';

const KEY = 'at_custom_stages_v1';

/** 保存できるステージ数の上限。localStorage を埋め尽くさないため */
const MAX_STAGES = 40;

/** 目標の型（§13） */
export const OBJECTIVE_TYPES = ['destroyAll', 'protect', 'hold', 'reach', 'survive'];

/** 敵機に選べる型 */
export const ENEMY_AIR_TYPES = [...Object.keys(ENEMY_TYPES), ...Object.keys(SUPPORT_TYPES)];
/** 自軍機に選べる型 */
export const FRIENDLY_AIR_TYPES = [...Object.keys(AIRCRAFT_TYPES), ...Object.keys(SUPPORT_TYPES)];
/** 支援機に選べる型（武装しない・指揮下に置かない機体・§80.4） */
export const SUPPORT_AIR_TYPES = [...Object.keys(SUPPORT_TYPES), ...Object.keys(AIRCRAFT_TYPES)];
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

/**
 * **欠けている節を埋める**（§66.10）。
 *
 * `fromJSON()` は `friendly` があれば通すので、手書きの JSON や他人からもらった
 * 断片が**節ごと欠けたまま**エディタに入ってくる。エディタは `terrain` や `enemy`
 * があることを前提に画面を組むので、**開いた瞬間に例外で止まっていた**
 * （実測: `terrain` 無しで「Cannot read properties of undefined (reading 'coast')」）。
 *
 * **値は上書きしない。** 無いものだけを白紙の既定で埋める。
 */
export function normalize(stage) {
  const b = blankStage();
  const s = stage || {};
  if (s.name == null) s.name = b.name;
  if (s.title == null) s.title = b.title;
  if (s.brief == null) s.brief = '';
  if (s.hint == null) s.hint = '';
  if (s.weaponPoints == null) s.weaponPoints = b.weaponPoints;
  s.terrain = { ...b.terrain, ...(s.terrain || {}) };
  s.friendly = s.friendly || {};
  s.friendly.aircraft = s.friendly.aircraft || [];
  s.enemy = s.enemy || {};
  s.enemy.aircraft = s.enemy.aircraft || [];
  s.enemy.ground = s.enemy.ground || [];
  // **練度は埋めない**（§91.1）。白紙の既定（0.6）を入れていたので、
  // **組み込み面を複製すると敵の練度が 1 → 0.6 に落ちて、元より易しくなっていた。**
  // 本体は `skill` が無ければ 1 と読む（`main.js` の `enemySkill`）。
  // ここの役目は「節ごと欠けた定義でも開けるようにする」ことで、
  // **遊びを変えることではない。** 白紙から作る面は `blankStage()` が 0.6 を書く。
  s.objectives = s.objectives || [];
  const r = s.rating || {};
  s.rating = { time: r.time || b.rating.time.slice(),
    points: r.points || b.rating.points.slice(),
    losses: r.losses || b.rating.losses.slice() };
  return s;
}

/** 既存ステージを下敷きにして複製する（§66.2）。**元の定義には触らない。** */
export function duplicate(stage) {
  const copy = structuredClone(stage);
  copy.id = nextId();
  copy.custom = true;
  // **下敷きにした面を覚える**（§91）。差分で書き出すときの比較先になる。
  // 複製の複製でも**いちばん元**を指したままにする（`c2` ではなく `s7`）——
  // 読む側が見たいのは「組み込みの面から何を変えたか」なので。
  copy.basedOn = stage.basedOn || stage.id;
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
  // **支援機は `friendly.support`**（`stage.support` ではない）。
  // ここを取り違えていたので、**ESCORT を複製すると保存も試遊もできなかった** ——
  // 輸送機のタグ `transport` を持つ味方が「いない」と判定されていた。
  // 本体が読んでいる場所（`main.js` の `spawnStage`）と揃える。
  const friendlyTags = new Set(['home']);          // 自軍飛行場は暗黙に home
  // 友軍（§102）も同じ陣営なので、protect・hold の受け皿になる
  const al = stage.ally || {};
  const allyAir = al.aircraft || [];
  if (al.base) friendlyTags.add('ally-home');
  for (const u of [...air, ...(f.ground || []), ...(f.support || []), ...allyAir]) {
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

  // 友軍（§102）。**任務が無ければ友軍の司令官は動かない**（Q5）—— 置いただけで止まっている機体になる
  const allyObjs = al.objectives || [];
  if (allyAir.length && !allyObjs.length) warn.push('友軍機がいるのに友軍の任務がありません（友軍は動きません）');
  for (const a of allyAir) {
    if (!FRIENDLY_AIR_TYPES.includes(a.type)) fatal.push(`友軍機「${a.name}」の機種「${a.type}」は使えません`);
    if (a.x == null && !f.base && !al.base) fatal.push(`友軍機「${a.name}」は待機する飛行場がありません`);
  }
  for (const o of allyObjs) {
    if (!OBJECTIVE_TYPES.includes(o.type)) { fatal.push(`友軍の任務「${o.label || o.id}」の型が不正です`); continue; }
    if (o.type === 'destroyAll' && !enemyTags.has(o.tag)) {
      warn.push(`友軍の任務「${o.label || o.id}」の tag「${o.tag}」を持つ敵がいません`);
    }
    if (o.type === 'protect' && !friendlyTags.has(o.tag)) {
      warn.push(`友軍の任務「${o.label || o.id}」の tag「${o.tag}」を持つ味方がいません`);
    }
  }

  // トリガー（§12.3）。**書き間違いは黙って何もしない形で現れる**ので、ここで全部拾う
  const eBases = ['base', 'base2'].filter((k) => e[k]);
  const enemyOwn = new Set(enemyTags);
  // **増援とトリガーの出撃が付けるタグも数える。** 配置した敵だけを見ると、
  // 「増援の編隊が n 機以下になったら」が書けない
  for (const k of eBases) for (const tg of (e[k].reinforce && e[k].reinforce.tags) || []) enemyOwn.add(tg);
  for (const t of e.triggers || []) for (const a of t.do || []) if (a.type === 'launch' && a.tag) enemyOwn.add(a.tag);
  // トリガーで出す地上部隊（§107）のタグも同じ
  const spawnedGround = (e.triggers || []).flatMap((t) => (t.do || []).filter((a) => a.type === 'spawn')
    .flatMap((a) => a.units || []));
  for (const g of spawnedGround) for (const tg of g.tags || []) enemyOwn.add(tg);
  // 地上の行動（§103）が動かせるのは**動く地上ユニット**だけ
  const movableTags = (list) => {
    const out = new Set();
    for (const g of list) if (GROUND_TYPES[g.type] && !GROUND_TYPES[g.type].static) for (const t of g.tags || []) out.add(t);
    return out;
  };
  validateTriggers({
    list: e.triggers, side: '敵', bases: eBases, condTags: enemyOwn, actTags: enemyOwn,
    groundTags: movableTags([...(e.ground || []), ...spawnedGround]),
    baseName: (k) => `敵飛行場「${k}」`, reinforceOf: (k) => e[k] && e[k].reinforce,
    airTypes: ENEMY_AIR_TYPES,
  }, fatal, warn);
  // 友軍側（§102 A2）。**条件はどちらの陣営のタグも読み、行動は友軍機だけを動かす**
  // 友軍を書いた面では、トリガーが無くても「トリガーで開始」の増援を拾うために通す
  if (stage.ally) {
    const allyOwn = new Set();
    for (const u of allyAir) for (const t of u.tags || []) allyOwn.add(t);
    const allyRf = al.reinforce || (al.base && al.base.reinforce);
    for (const t of (allyRf && allyRf.tags) || []) allyOwn.add(t);
    for (const t of al.triggers || []) for (const a of t.do || []) if (a.type === 'launch' && a.tag) allyOwn.add(a.tag);
    // 友軍の増援は専用の飛行場があればそこ、無ければ共用の飛行場から出る（`main.js` の `spawnStage`）
    const rfKey = al.base ? 'base' : 'home';
    validateTriggers({
      list: al.triggers, side: '友軍', bases: [...(al.base ? ['base'] : []), ...(f.base ? ['home'] : [])],
      condTags: new Set([...allyOwn, ...friendlyTags, ...enemyOwn]), actTags: allyOwn,
      groundTags: movableTags((f.ground || []).filter((g) => g.owner === 'ally')),
      baseName: (k) => (k === 'home' ? '自軍飛行場（home）' : `友軍飛行場「${k}」`),
      reinforceOf: (k) => (k === rfKey ? allyRf : null),
      airTypes: FRIENDLY_AIR_TYPES,
    }, fatal, warn);
  }

  // 座標。**地図の外に置くと出撃した瞬間に迷子になる**
  //
  // **座標を持つものは全部見る。** 以前は敵と自軍飛行場しか見ておらず、
  // 自軍機・自軍地上・支援機・到達地点は素通りだった —— エディタは置くときに
  // 丸めるが、**数値欄に打ち込む経路と、読み込んだ JSON には効かない。**
  const okNum = (v) => typeof v === 'number' && Number.isFinite(v);
  const spots = [];
  if (f.base) spots.push(['自軍飛行場', f.base]);
  if (al.base) spots.push(['友軍飛行場', al.base]);
  for (const u of allyAir) spots.push([u.name || '友軍', u]);
  for (const u of [...air, ...(f.ground || []), ...(f.support || [])]) spots.push([u.name || '味方', u]);
  for (const u of [...(e.aircraft || []), ...(e.ground || [])]) spots.push([u.name || '敵', u]);
  for (const key of ['base', 'base2']) if (e[key]) spots.push([`敵飛行場(${key})`, e[key]]);
  for (const o of objs) if (o.type === 'reach') spots.push([`到達地点「${o.label || o.id}」`, o]);
  for (const t of e.triggers || []) {
    for (const c of t.when || []) if (c.type === 'enter') spots.push([`トリガー「${t.label || t.id}」の区域`, c]);
    for (const a of t.do || []) if (a.type === 'guard') spots.push([`トリガー「${t.label || t.id}」の地点`, a]);
  }
  for (const [label, p] of spots) {
    if (p.x == null && p.z == null) continue;            // 位置は本体まかせ（自動配置）
    // **片方だけ入っているのも弾く。** `null >= 0` は真なので、
    // 素朴に比べると「Z が空」が通ってしまっていた。
    if (!okNum(p.x) || !okNum(p.z)) { fatal.push(`${label} の座標が欠けています`); continue; }
    if (p.x < 0 || p.x > MAP_SIZE || p.z < 0 || p.z > MAP_SIZE) {
      fatal.push(`${label} が地図の外にあります`);
    }
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

  // 天候（§88）。**書かなければ雲なし**なので、書いてあるときだけ見る
  const w = stage.weather;
  if (w && w.cloud && w.cloud !== 'none') {
    if (CLOUD_COVER[w.cloud] == null) fatal.push(`雲量「${w.cloud}」は使えません`);
    if (w.shape && CLOUD_SHAPE[w.shape] == null) fatal.push(`塊の形「${w.shape}」は使えません`);
    const base = w.base ?? 2500;
    const top = w.top ?? (base + 1700);
    // 上下が逆でも本体は 200m の厚みに丸めるので落ちない。**遊びとして意図と違う**だけ
    if (top <= base) warn.push(`雲頂(${top}m)が雲底(${base}m)より下にあります`);
    if (base < 0) warn.push('雲底が地面より下にあります');
    if (w.wind && w.wind.speed != null && w.wind.speed < 0) warn.push('風速が負の値です');
  }

  if (!e.aircraft?.length && !e.ground?.length && !e.base) warn.push('敵が1つも置かれていません');

  return { fatal, warn, ok: fatal.length === 0 };
}

/**
 * トリガーの検証（§12.3・友軍側は §102 A2）。敵側と友軍側で同じ関数を使い、違いは引数で渡す。
 *
 * | 拾うもの | 重さ | 理由 |
 * |---|---|---|
 * | 存在しない条件・行動の型 | 致命 | 本体は黙って無視する |
 * | 持ち主の無いタグ | 致命 | 条件は永久に成立せず、行動は誰にも効かない |
 * | 無い飛行場・無いトリガーID | 致命 | 同上 |
 * | ID の重複 | 致命 | `fired` がどちらを指すか決まらない |
 * | 「トリガーで開始」なのに `reinforce on` が無い増援 | 警告 | 一度も湧かない |
 *
 * @param {object} o
 * @param {object[]} o.list        トリガーの並び
 * @param {string} o.side          文言の頭（'敵' / '友軍'）
 * @param {string[]} o.bases       行動が指せる飛行場の名前
 * @param {Set} o.condTags         条件（destroyed・below）が数えられるタグ
 * @param {Set} o.actTags          行動（guard・defend・restore）が動かせるタグ
 * @param {Function} o.baseName    飛行場の名前 → 文言
 * @param {Function} o.reinforceOf 飛行場の名前 → その飛行場の増援（無ければ null）
 * @param {string[]} o.airTypes    出撃させられる機種
 */
function validateTriggers(o, fatal, warn) {
  const list = o.list || [];
  const ids = new Set();
  const bases = o.bases;
  const turnedOn = new Set();
  const pre = o.side === '敵' ? '' : `${o.side}の`;
  for (const t of list) {
    const name = `${pre}トリガー「${t.label || t.id}」`;
    if (!t.id) fatal.push(`${name} に ID がありません`);
    else if (ids.has(t.id)) fatal.push(`${pre}トリガーの ID「${t.id}」が重複しています`);
    ids.add(t.id);
    if (!(t.when || []).length) warn.push(`${name} に条件がありません（成立しません）`);
    if (!(t.do || []).length) warn.push(`${name} に行動がありません`);
  }
  for (const t of list) {
    const name = `${pre}トリガー「${t.label || t.id}」`;
    for (const c of t.when || []) {
      if (!TRIGGER_CONDITIONS.includes(c.type)) { fatal.push(`${name} の条件「${c.type}」は使えません`); continue; }
      if ((c.type === 'destroyed' || c.type === 'reach' || (c.type === 'below' && c.tag)) && !o.condTags.has(c.tag)) {
        fatal.push(`${name} の条件のタグ「${c.tag}」を持つ${o.side === '敵' ? '敵' : 'ユニット'}がいません`);
      }
      if (c.type === 'fired' && !ids.has(c.id)) fatal.push(`${name} の条件が指すトリガー「${c.id}」がありません`);
      if (c.type === 'fired' && c.id === t.id) fatal.push(`${name} が自分自身を待っています`);
    }
    for (const a of t.do || []) {
      if (!TRIGGER_ACTIONS.includes(a.type)) { fatal.push(`${name} の行動「${a.type}」は使えません`); continue; }
      if (['guard', 'defend', 'restore'].includes(a.type) && !o.actTags.has(a.tag)) {
        fatal.push(`${name} の行動のタグ「${a.tag}」を持つ${o.side}機がいません`);
      }
      if (['defend', 'launch', 'reinforce'].includes(a.type) && !bases.includes(a.base)) {
        fatal.push(`${name} の行動が指す${o.baseName(a.base)}がありません`);
      }
      if (a.type === 'reinforce' && a.base && bases.includes(a.base) && !o.reinforceOf(a.base)) {
        warn.push(`${name} が増援を持たない${o.baseName(a.base)}の増援を切り替えています`);
      }
      if (a.type === 'reinforce' && a.on) turnedOn.add(a.base);
      if (a.type === 'ground') {
        if (!GROUND_MODES.includes(a.mode)) fatal.push(`${name} の地上の行動「${a.mode}」は使えません`);
        if (!o.groundTags.has(a.tag)) {
          fatal.push(`${name} の行動のタグ「${a.tag}」を持つ${o.side === '敵' ? '敵の' : '友軍の'}動く地上部隊がいません`);
        }
      }
      if (a.type === 'spawn') {
        // 地上部隊を出す（§107）。書き方はステージの `ground` と同じ
        if (!(a.units || []).length) warn.push(`${name} の「地上部隊を出す」に部隊がありません`);
        for (const g of a.units || []) {
          if (!GROUND_PLACEABLE.includes(g.type)) fatal.push(`${name} の出す地上部隊「${g.type}」は使えません`);
          if (!Number.isFinite(g.x) || !Number.isFinite(g.z)) fatal.push(`${name} の出す地上部隊に位置がありません`);
        }
      }
      if (a.type === 'launch' && !o.airTypes.includes(a.aircraft)) {
        fatal.push(`${name} の出撃機種「${a.aircraft}」は使えません`);
      }
    }
  }
  for (const k of bases) {
    const r = o.reinforceOf(k);
    if (r && r.after === 'trigger' && !turnedOn.has(k)) {
      warn.push(`${o.baseName(k)} の増援は「トリガーで開始」ですが、開始させるトリガーがありません（一度も湧きません）`);
    }
  }
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
    normalize(s);                   // 節ごと欠けた断片でも開けるように（§66.10）
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
  delete s.basedOn;               // 下敷きの控え（§91）は本編の定義には要らない
  return JSON.stringify(s, null, 2)
    // キーの引用符だけ外して JS の書き方に寄せる（そのまま貼れるように）。
    //
    // **値の引用符は触らない。** 以前は `"` を丸ごと `'` に置き換えていたので、
    // 本文にアポストロフィがあると出力が壊れていた ——
    // 実測: `name: 'DON'T PANIC',` / `label: 'Don't lose the 'CARGO''`。
    // `stages.js` は単引用符で書くが、**貼って動くこと**のほうが先。
    .replace(/^(\s*)"([A-Za-z_][A-Za-z0-9_]*)":/gm, '$1$2:');
}
