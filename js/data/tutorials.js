// チュートリアルの定義。仕様書 §19。
//
// 1本のチュートリアルは **ステージ定義とまったく同じ形** に steps を足したもの。
// 戦闘の組み立て（main.js の buildBattle）はそのまま使い回せる。
//
// 通常のステージと違う点:
//   ・objectives ではなく steps で進む
//   ・noFail: true（敗北条件を置かない。機体を失っても手順をやり直せる）
//   ・評価は付けない
//
// 手順の形（§19.1）:
//
//   { text: '説明', note: '補足（任意）', done: 'select' }        操作で達成
//   { text: '説明', check: (ctx) => boolean }                     状態で達成
//
// **状態で判定できるものは check を使う。**
// done を増やすほど本編のコードにチュートリアル都合の通知が増える。
// check なら ui/tutorial.js が毎フレーム見るだけで済み、
// sim/ には一行も手を入れずにいられる。
//
// ctx = { world, commands, loop, rig, mem, elapsed }
//   mem は手順ごとの覚え書き（次の手順へ進むと空になる）

import { LEVEL, RWR_POS_ERROR } from '../sim/detection.js';
import { estimateHitChance, FIRE_THRESHOLD, GUN_AIM_CONE, GUN_AIM_CONE_GROUND, aspectOf } from '../sim/combat.js';
import { ARM_NOTICE_RANGE } from '../sim/ground.js';
import { WEAPONS, hardpointsOf } from './weapons.js';
import { AIRCRAFT_TYPES } from './aircraft.js';
import { GROUND_TYPES } from './ground.js';
import { ENGAGE_RANGE, EVADE_RANGE, SAM_AVOID_RANGE, STRIKE_LOW_AGL, ARM_STANDOFF_ALT } from '../ai/pilot.js';
import { RWR_SIGNATURE_FACTOR, headingOf } from '../sim/unit.js';
import { CORNER_FRACTION, FUEL_AB_RATE } from '../sim/aircraft.js';
import { perfOf, PERF_ALT } from './perf.js';

// ---------------------------------------------------------------- 小道具

/**
 * 文中に出す諸元は**データから引く**（SPEC §79.5）。
 *
 * 数字を手で書くと、釣り合いを取り直すたびに説明だけが古くなる。
 * 実際 §71 でデコイを配り直したとき（F-1 フレア4→6・チャフ14→10、
 * A-3 フレア10→12・チャフ28→20）、**動いたのはデータだけで、
 * それを読み上げているチュートリアルの文は 4/14 のまま残っていた。**
 *
 *   AC('F-1').flares   機種の諸元
 *   W('AAM-A').cost    兵装の諸元
 */
const AC = (id) => AIRCRAFT_TYPES[id];
const W = (id) => WEAPONS[id];
/** その機種がレーダーを出したとき、相手の逆探知に映る距離(km)（§30.3） */
const rwrKm = (id) => Math.round(AC(id).radarRange * RWR_SIGNATURE_FACTOR / 1000);
/** その機種のコーナー速度(m/s)。海面の値を10刻みに丸める（高度が上がると実効値は上がる）（§29.2） */
const cornerMs = (id) => Math.round((AC(id).cornerSpeed || AC(id).cruiseSpeed * CORNER_FRACTION) / 10) * 10;
/** 文中の単位の書き方。m → km（小数1桁まで・8000 → "8"・4500 → "4.5"）／ラジアン → 度／割合 → % */
const km = (m) => String(Math.round(m / 100) / 10);
const deg = (rad) => Math.round(rad * 180 / Math.PI);
const pct = (v) => Math.round(v * 100);

/** 自軍の生きている機体 */
const mine = (ctx) => ctx.world.units.filter(
  (u) => u.kind === 'aircraft' && u.side === ctx.world.playerSide && u.alive);

/** 名前でユニットを引く（死んでいても返す） */
const unit = (ctx, name) => ctx.world.units.find((u) => u.name === name);

/** 自軍が持っているそのユニットのコンタクト */
const contactOf = (ctx, u) =>
  u && ctx.world.detection.contactsFor(ctx.world.playerSide).get(u.id);

/** 対地高度 */
const agl = (ctx, u) =>
  u.pos.y - Math.max(0, ctx.world.terrain.heightAt(u.pos.x, u.pos.z));

/** カメラが動かされたか（初回呼び出し時の位置を覚えて比べる） */
function cameraMoved(ctx) {
  const r = ctx.rig;
  const now = { x: r.target.x, z: r.target.z, a: r.azimuth, d: r.distance };
  if (!ctx.mem.cam) { ctx.mem.cam = now; return false; }
  const c = ctx.mem.cam;
  return Math.hypot(now.x - c.x, now.z - c.z) > 3000
    || Math.abs(now.a - c.a) > 0.35
    || Math.abs(now.d - c.d) / c.d > 0.25;
}

/** その兵装を積んでいるか */
const carrying = (ctx, id) => mine(ctx).some((u) => u.loadout.includes(id));

/**
 * 兵装ごとのチュートリアルで使う、無害な的（撃ち返してこない敵機）。
 *
 * **機銃も切る。** 機銃は搭載リストに載らない固定装備なので、
 * `loadout: []` にしただけでは無害にならない — 実測では、こちらが
 * 手を止めているあいだに的のほうが接敵して撃墜してきた（w3 で 128秒）。
 * ブリーフィングに「敵機は武装していません」と書いてある以上、
 * 本当に武装していない状態にする。
 */
function dummyFighter(name, x, z, agl2, extra = {}) {
  return {
    type: 'J-7', name, x, z, agl: agl2,
    aiMode: 'PATROL', loadout: [], autoWeapons: { GUN: false },
    tags: ['target'], ...extra,
  };
}

/**
 * 教えている兵装を撃ち切ったか（自機は残っている）。
 *
 * 「撃墜する」「破壊する」は**指示すれば必ず起こせること**ではない（§19.4）。
 * 外し続けて弾が尽きるとそこで手詰まりになるので、最後の手順にも逃げ道を置く。
 * 実測: w4 は3回に1回、AAM-A 2発とも外して目標無傷のまま弾が尽きた。
 */
const spentAll = (id) => (ctx) => mine(ctx).length > 0
  && mine(ctx).every((u) => !u.loadout.includes(id))
  // **飛んでいる弾を待つ。** 撃った瞬間に搭載から消えるので、
  // これを見ないと「当たるのを見届ける」手順が発射と同時に終わってしまう。
  && !ctx.world.missiles.some((m) => m.alive
    && m.side === ctx.world.playerSide && m.weapon.id === id);

/**
 * その兵装をもう撃ったか（自軍の弾が飛んでいる・または撃ち切った）。
 *
 * 「発射する」の手順の逃げ道。発射の通知（`done: 'fire'`）は撃った瞬間に1度しか来ないので、
 * **前の手順のうちに撃ってしまうと、あとから起こし直せない。**
 */
const firedOrSpent = (id) => (ctx) => mine(ctx).length > 0 && (
  ctx.world.missiles.some((m) => m.alive && m.side === ctx.world.playerSide && m.weapon.id === id)
  || mine(ctx).every((u) => !u.loadout.includes(id)));

/**
 * t4 の最後の手順で、AAM-M を撃ち切ってから手順を終えるまでの秒（シミュレーション時間・§98）。
 * 同じ性能の的と旋回戦を続けても決着しないので、ここで打ち切る。
 */
const DOGFIGHT_CUTOFF = 60;

/** その名前のユニットが破壊されたか（居なければ false） */
const destroyed = (ctx, name) => { const u = unit(ctx, name); return !!u && !u.alive; };

/**
 * 攻撃指示を出したうえで、その兵装を指定したか（兵装の本の1手順目・§93.12）。
 *
 * 流れは基本2「空対空」で教え済みなので、兵装の本では攻撃指示と指定を1手順にまとめる。
 * **攻撃指示も見る。** 指定を先に済ませると右クリックが射撃指示になり（`commands.js`）、
 * 機体は敵へ向かわない —— 射程の外で待ち続けて先へ進めない。
 */
const attackWith = (id) => (ctx) => mine(ctx).some((u) => u.selectedWeapon === id
  && u.order && u.order.type === 'attack');

/** その兵装の射撃指示が残っているか（`name` を渡せばその相手への指示だけ） */
const hasFireTask = (ctx, id, name = null) => mine(ctx).some((u) => u.fireTasks
  && u.fireTasks.some((t) => t.weapon === id && (!name || (t.target && t.target.name === name))));

/** 射撃指示の横に出ている「撃てない理由」（`hud.js` と同じ呼び方）。指示が無ければ null */
function fireReason(ctx, id, name) {
  for (const u of mine(ctx)) {
    const t = u.fireTasks && u.fireTasks.find((x) => x.weapon === id && x.target && x.target.name === name);
    if (t) return ctx.world.combat.fireBlockReason(u, t.target, WEAPONS[id], true);
  }
  return null;
}

// ---------------------------------------------------------------- 配置

/**
 * 基本2「空対空」の配置（§93.4）。**射撃指示を出した時点で必ず射程外**にする。
 *
 * 射程内で出すと理由が出ないまま撃ってしまい、「撃てない理由を読む」手順が起きない。
 * 実測では旧配置（22km）が開いた瞬間から AAM-M の射程内だった
 * （高度5,500m で 22.4km＝`effectiveMissileRange × LAUNCH_RANGE_FRAC`）。
 *
 * 手順2〜5は時間を止めるので、距離は手順1を終えた時点のまま凍る。
 * 攻撃指示までは両機とも出現点のまわりを哨戒で回るだけ（自軍の哨戒半径 4.5km）
 * なので、**出現点どうしを 35km 離せば、どう回っていても射程の外にいる。**
 * 飛行場はその間に置く —— 敵を捉えているのは飛行場のレーダー（30km）。
 */
const T4 = { base: { x: 18000, z: 36000 }, viper: { x: 8000, z: 46000 }, bandit: { x: 34000, z: 22000 } };
const T4_KM = Math.round(Math.hypot(T4.bandit.x - T4.viper.x, T4.bandit.z - T4.viper.z) / 1000);

/**
 * 戦術2「見える・見えない」の配置（§93.4）。**3つの相手を3つの方角に分ける**。
 *
 *   low     北・低空。飛行場のレーダーから隠れている（前半）
 *   site    北東・尾根の上の敵レーダーサイト。逆探知でしか見えない
 *   silent  東・電波を出さない。扇を向けるまで見えない（後半）
 *
 * silent は**飛行場のレーダー（30km）の外**に置く。内側だと開いた時点で飛行場が捉えて、
 * 最後の手順が始まる前に済んでしまう。哨戒で半径 4.5km を回るので、中心は 34.5km より外。
 *
 * **遠すぎても詰まる。** 最初 (46000,46000)（飛行場から 36km・南東）に置いたら、
 * 手順2で待っていた通しでは追う途中で帰投の燃料（飛行場までの距離に比例）を割り、
 * 自動で帰って降りたまま止まった。真東へ寄せて、前半を終えた位置から近くした。
 */
const T3 = {
  base: { x: 10000, z: 40000 },
  low: { x: 16000, z: 6000 },
  site: { x: 44700, z: 9800 },
  silent: { x: 47000, z: 38000 },
};
const T3_SILENT_KM = Math.round(Math.hypot(T3.silent.x - T3.base.x, T3.silent.z - T3.base.z) / 1000);

/**
 * 戦術3「雲と天候」の配置（§93.4）。西の飛行場から東へ、層の上を通って SAM の真上 →
 * さらに東で層の下の敵機を探す。**雲の種（`battleSeed`）はこの位置で選んである。**
 */
const K1 = {
  base: { x: 8000, z: 26000 },
  sam: { x: 24000, z: 26000 },
  bandit: { x: 44000, z: 18000 },
  orbit: { x: 38000, z: 26000 },
};
const K1_SAM = GROUND_TYPES.IRSAM.weapon;

/**
 * 詳細2「3機の違い」の搭載と、その搭載での性能（§93.13）。
 *
 * 文の数字は**飛行モデルから引く**（`data/perf.js`）。それまでは実測値を手で書いていた
 * （9.2 / 11.5 / 13.8分・17.3°/s など）。高さは x2 の出撃高度と同じ `PERF_ALT`。
 */
const X2_LOAD = {
  'F-1': ['AAM-M', 'AAM-M', 'AAM-S', 'AAM-S'],
  'F-2': ['AAM-M', 'AAM-S', 'AAM-S', 'AGM'],
  'A-3': ['AGM', 'AGM', 'AAM-S', 'AAM-S'],
};
const X2_IDS = Object.keys(X2_LOAD);
const X2 = {};
const X2_EMPTY = {};
for (const id of X2_IDS) {
  X2[id] = perfOf(id, { loadout: X2_LOAD[id] });
  X2_EMPTY[id] = perfOf(id);
}
/** 秒 → 分（小数1桁・12.0 → "12"） */
const mins = (sec) => String(Math.round(sec / 6) / 10);
/** 飛べる距離は km の整数で */
const kmI = (m) => String(Math.round(m / 1000));
const d1 = (v) => (Math.round(v * 10) / 10).toFixed(1);
const n0 = (v) => Math.round(v).toLocaleString('en-US');

/**
 * 戦術5「守る」の配置（§93.4）。施設3つは飛行場の東 7〜11km —— 帰投と積み直しが
 * 短く済み、第1波のあいだに手順を回せる距離。爆撃機は北東 25km 前後から来る。
 */
const K2 = {
  base: { x: 9000, z: 30000 },
  depots: [
    { name: '補給施設 A', x: 16000, z: 22000 },
    { name: '補給施設 B', x: 18000, z: 30000 },
    { name: '補給施設 C', x: 16000, z: 38000 },
  ],
  raiders: [
    { name: 'RAIDER 1', x: 40000, z: 16000 },
    { name: 'RAIDER 2', x: 42000, z: 26000 },
  ],
  enemyBase: { x: 46000, z: 8000 },
};
/** 兵装ポイントの上限。AAM-M（2P）を2機が撃ち切って積み直すと 8P —— 1周は回せて、2周目で詰まる */
const K2_POINTS = 12;
/** 哨戒の中心が「施設の上」とみなす距離(m) */
const K2_NEAR = 5000;

/**
 * 兵装2「AAM-S」の配置（§93.12）。**正面から来る的と、背を向けて逃げる的を同じ線に並べる。**
 *
 *   head  北東 30km から南西へ。こちらと正面ですれ違う（射撃指示を出して理由を読み、取り下げる）
 *   tail  北東 14km から北東へ逃げる。後ろから追いつく（正面より遠くから掴める）
 *
 * **攻撃指示は tail に出す。** 機体が北東へ向かうので、head とは攻撃指示なしで正面から出会い、
 * 射撃指示だけで済む。攻撃目標を途中で替えさせると、兵装の指定を外す手間が挟まる。
 * **tail は爆撃機**（w1 と同じ理由 —— J-7 は巡航が F-1 と同じで追いつかない）。
 * head は線から横に 1.5km ずらす（同じ線だと正面衝突の位置を通る）。
 *
 * **2機とも出現時から行き先を向かせる**（`heading`）。敵機の既定の向きは真南で、最初の通しでは
 * tail が北東へ向き直るまでの旋回でこちらへ寄り、13.8km が 45秒で 3.1km になった ——
 * 射撃指示を出した瞬間に撃ったので、「後ろからは遠くで掴める」が見えなかった（3回とも 3.0〜3.3km）。
 */
const W2 = {
  base: { x: 12000, z: 40000 },
  viper: { x: 8000, z: 44000 },
  head: { x: 30300, z: 23900 }, headTo: { x: 4000, z: 50000 },
  tail: { x: 17900, z: 34100 }, tailTo: { x: 45000, z: 7000 },
};

/**
 * 兵装5「AGM」の配置（§93.12）。**目標の手前に対空砲を置く**（プレイヤーの決め）。
 * 攻撃の飛び方は、撃ったあとも目標まで 2.5km を切るまで近づく（`acm.js` の `groundAttackRun`）。
 * 対空砲は目標から 1.2km 手前なので、放っておくと射程（3km）に入る。**ただし射高の上を越えるので
 * 撃たれない**（パイロットが自分で上がる・§68.2。測った数字は w5 の注記）。
 */
const W5 = {
  base: { x: 11000, z: 40000 },
  site: { x: 30000, z: 26000 },
  aaa: { x: 29000, z: 26700 },
};
const W5_AAA = GROUND_TYPES.AAA.weapon;

// ---------------------------------------------------------------- 定義
//
// **並び＝一覧の表示順＝「次へ」の順**（§93.7）。群は §93.2 の4つ ——
// 基本（遊ぶのに最低限）・戦術（判断を体験する）・兵装（1兵装1本）・詳細。
//
// `listed: false` の本は一覧に出さず、受講済みの数にも入れない
// （§93.5: 詳細の資料の「試す」から開く専用の場）。
// **消えた本の ID が受講記録に残っていても数えない** —— 数えると
// 「20 / 17」のように分子が分母を超える（`countTutorialsDone`）。

export const TUTORIALS = [
  // ================================================================ 基本1
  {
    id: 't1',
    group: '基本',
    name: '指揮の基本',
    title: '選択・移動指示・視点・時間',
    brief: 'この作戦では、あなたは機体を直接操縦しません。\n'
      + '機体に指示を出し、パイロットがそれをこなすのを見届けるのが仕事です。\n'
      + 'まずは選択と移動指示、視点の動かし方、時間の進め方を覚えます。',
    terrain: { seed: 90001, mountainAmount: 0.5, coast: 'none', valleyDepth: 0.6, rivers: 1, baseAltitude: 340 },
    weaponPoints: 0,
    noFail: true,
    friendly: {
      base: { x: 12000, z: 38000 },
      startAirborne: true,
      startAlt: 4000,
      aircraft: [
        { type: 'F-1', name: 'VIPER 1', loadout: ['AAM-S'] },
        { type: 'F-1', name: 'VIPER 2', loadout: ['AAM-S'] },
      ],
    },
    enemy: { aircraft: [], ground: [] },
    steps: [
      { text: '自軍機をクリックして選択する',
        note: '画面左の FLIGHT ROSTER の行をクリックしても選べます',
        done: 'select' },
      { text: '地面を右クリックして移動を指示する',
        note: '指示した経路は線で表示されます',
        done: 'order:move' },
      // 経路の継ぎ足しは補足に書いてあるだけだった（§60.4）。
      // 待ち行列に入ったかどうかは状態で分かるので check で見る。
      { text: 'Shift+右クリックで、その先へ経路を継ぎ足す',
        note: '何度でも足せます。**先に指示した地点から順に回ります。**'
          + '山を避けて回り込ませたいときや、進入方向を決めたいときに使います',
        check: (ctx) => mine(ctx).some((u) => u.queue && u.queue.length > 0) },
      { text: '「指示解除」で指示を取り消す',
        note: '下のパネル右下のボタンです。**経路も指定した高度もまとめて外れ、AI任せに戻ります。**'
          + '出した指示を取り消せないと、間違えたときに上書きし続けるしかありません。\n'
          + 'Esc を押すと選択そのものを外せます（何も選んでいなければメニューが開きます）',
        highlight: '[data-cmd="clear"]',
        check: (ctx) => {
          const sel = ctx.commands.selection.filter((u) => u.alive);
          if (!sel.length) return false;
          if (sel.some((u) => u.order && u.order.type === 'move')) { ctx.mem.had = true; return false; }
          return !!ctx.mem.had && sel.every((u) => !u.queue || u.queue.length === 0);
        } },
      { text: 'Space キーで一時停止する',
        note: '一時停止中も視点を動かしたり指示を出したりできます',
        done: 'pause' },
      { text: '一時停止を解除し、] キーで倍速を上げる',
        note: '画面上部の x1 / x2 / x4 / x8 のボタンでも変えられます',
        done: 'speed' },
      { text: 'WASD キーで視点を動かして、機体を追う',
        note: 'Q E で旋回、R F で仰角、ホイールで拡大縮小。C キーで選択機に寄れます',
        check: cameraMoved },
      { text: 'Tab キーで、もう1機に選択を切り替える',
        note: 'Shift+Tab で逆順。**1機ずつ見て回るときはクリックより速い**です。'
          + '選択が移ると下のパネルもその機体のものに変わります',
        check: (ctx) => {
          const sel = ctx.commands.selection.filter((u) => u.alive);
          if (sel.length !== 1) return false;
          if (!ctx.mem.first) { ctx.mem.first = sel[0]; return false; }
          return sel[0] !== ctx.mem.first;
        } },
      { text: 'ドラッグで2機ともまとめて選択する',
        note: '空いている場所から左ボタンでドラッグすると範囲選択になります',
        check: (ctx) => ctx.commands.selection.filter((u) => u.alive).length >= 2 },
      { text: '2機まとめて移動を指示する',
        note: '複数機に同じ地点を指示すると、殺到しないよう自動で散開します',
        done: 'order:move' },
    ],
  },

  // ================================================================ 基本2
  {
    id: 't4',
    group: '基本',
    name: '空対空',
    title: 'ミサイルの撃ち方',
    brief: '敵を撃つ手順を、ひと通り通します —— 攻撃指示、兵装の指定、射撃指示。\n'
      + '撃てと言っても、条件が揃うまで機体は待ちます。なぜ待っているかは画面に出ます。\n'
      + 'ただし撃つ距離を選ぶのは指揮官です —— 遠すぎれば、弾は届く前に燃え尽きます。',
    hint: '敵は1機だけ、武装していません。撃ち返されないので、落ち着いて手順を進められます。',
    terrain: { seed: 90004, mountainAmount: 0.8, coast: 'none', valleyDepth: 0.8, rivers: 2, baseAltitude: 400 },
    weaponPoints: 0,
    noFail: true,
    friendly: {
      base: T4.base,
      startAirborne: true,
      startAlt: 5500,
      // **自動発射を切る**（§49）。ここで教えるのは「指揮官が撃つ距離を選ぶ」ことで、
      // 自動発射のしきい値は t5 が扱う。
      //
      // §38 で AI の発射距離が 7.7km → 17.8km に伸びた結果、敵を 22km に置いた
      // この面では**プレイヤーが手順3に着く前に AI が2発とも撃ち尽くしていた**
      // （実測: 攻撃指示の10秒後・18.3km で1発目）。
      // 手順「AAM-M を発射する」には逃げ道が無いので、そこで行き止まりになる。
      aircraft: [
        { type: 'F-1', name: 'VIPER 1', ...T4.viper, loadout: ['AAM-M', 'AAM-M', 'AAM-S', 'AAM-S'],
          autoWeapons: { 'AAM-M': false, 'AAM-S': false, GUN: false } },
      ],
    },
    enemy: {
      skill: 0.3,
      // **的は武装させない**（§79.3）。
      //
      // AAM-S を1発持たせていたので、**手順を読んでいるあいだに撃ち返してきた。**
      // ここは自軍が1機しかいない面なので、落とされると `mine()` が空になり、
      // 残りの手順は**どれも二度と成立しない**（撃墜も、撃ち切りの逃げ道も、
      // どちらも生きている自機を前提にしている）。
      //
      // 撃たれたときの話は「撃たれたら」（t8）が丸ごと受け持っている。
      // **ここで教えるのは撃つ距離の選び方であって、撃たれ方ではない。**
      aircraft: [dummyFighter('BANDIT 1', T4.bandit.x, T4.bandit.z, 5500)],
      ground: [],
    },
    // **射撃指示の流れを教えるのはこの本だけ**（§93.2）。兵装の本はこれを前提にする。
    //
    // 手順2〜5と7は**入った瞬間に時間を止める**。攻撃指示を出すと機体は敵へ向かうので、
    // 動いたままだと、読んでいるあいだに射程へ入って理由が出ないまま撃ってしまう
    // （配置の理由は上の `T4`）。止めても右クリックの指示は通る（§8）。
    steps: [
      // **敵が地図に出るまで次へ進めない。** 手順2は入った瞬間に止めるので、
      // まだ一度もレーダーが回っていないうちに止めると、右クリックする相手がいない。
      { text: '機体を選択し、地図で敵機の位置を確かめる',
        note: `敵はおよそ ${T4_KM}km 北東（方角は右上の方位盤で読めます）。`
          + '**地図に出ている敵は、味方のレーダーが捉えているものだけです** —— いまは飛行場のレーダーが捉えています',
        check: (ctx) => ctx.commands.selection.some((u) => u.alive)
          && !!contactOf(ctx, unit(ctx, 'BANDIT 1')) },
      { text: '敵機を右クリックして攻撃を指示する',
        note: '時間を止めてあります。止まっていても指示は出せます。'
          + 'カーソルを敵に重ねると、距離と命中期待度が出ます',
        done: 'order:attack', pause: true },
      { text: '下のパネルで使用兵装に AAM-M を指定する',
        note: 'このチュートリアルでは自動発射を切ってあります。'
          + '指定してから敵を右クリックすると、その兵装での**射撃指示**になります',
        done: 'weapon', when: (d) => d.weapon === 'AAM-M',
        pause: true, highlight: '[data-pick="AAM-M"]',
        // 指定する前に撃ち尽くすと、押すチップが無くなる。行き止まりにしない。
        check: (ctx) => mine(ctx).length > 0
          && mine(ctx).every((u) => !u.loadout.includes('AAM-M')) },
      { text: '敵機を右クリックして射撃指示を出す',
        note: '**攻撃指示が先、射撃指示があと**です。'
          + '射撃指示だけでは機体は敵へ向かわないので、先に攻撃指示で近づかせておきます',
        pause: true,
        check: (ctx) => mine(ctx).some((u) => u.fireTasks && u.fireTasks.some((t) => t.weapon === 'AAM-M'))
          || firedOrSpent('AAM-M')(ctx) },
      // 「読む」は状態で判定できないので、取消の手順と1つにする。
      //
      // **出し直さずに取り下げさせる。** 射撃指示は命中期待度を見ない（§92.3）ので、
      // 遠くから出しておくと射程に入った瞬間に撃つ —— 実測では 23.5km・期待度 0.02 で、
      // 3回とも外れた。「出しておけば待ってくれる」だけを教えると、いちばん
      // 当たらない距離で撃つ癖が付く。待つのは射程までで、距離を選ぶのは指揮官。
      { text: '射撃指示の横の理由を読み、「取消」で取り下げる',
        note: '**いま撃てない理由**が出ています —— 遠いので「射程外」。'
          + '射撃指示は条件が揃うまで残り、**揃った瞬間に撃ちます** —— 射程に入ったばかりの、いちばん当たらない距離で。'
          + 'ここではいったん取り下げます',
        pause: true, highlight: '.task-row',
        check: (ctx) => {
          const has = mine(ctx).some((u) => u.fireTasks && u.fireTasks.length > 0);
          if (has) ctx.mem.had = true;
          return (!!ctx.mem.had && !has) || firedOrSpent('AAM-M')(ctx);
        } },
      // 実測（決定論の1本）: 期待度は 21km まで 0.02、18.6km で 0.31、17km で 0.53、
      // 10km 前後で 0.63 の頭、6.5km で 0.40 に戻る。「高」の窓は 17〜6.5km。
      // 35km から「高」の 17km まで等速で2分近くかかる（§98）。「高」に入った瞬間に
      // 次の手順が時間を止めるので、倍速を上げても窓は飛び越さない。
      { text: '命中期待度が「高」になるまで近づく（倍速推奨）',
        note: 'カーソルを敵に重ねると期待度が読めます。'
          + '射程の縁で撃つと、弾は追いつく前に燃え尽きます。'
          + '「高」まで遠いので、] キーで倍速を上げて待ちましょう',
        check: (ctx) => {
          const e = unit(ctx, 'BANDIT 1');
          return (!!e && e.alive && mine(ctx).some((u) => estimateHitChance(
            u, e, W('AAM-M'), ctx.world.combat.aimErrorOf(u, e)) >= FIRE_THRESHOLD.high))
            || firedOrSpent('AAM-M')(ctx);
        } },
      // ここで止める。止めずに読ませると、読んでいるあいだに「高」の窓を抜けることがある。
      // 発射は時間が動かないと起きないので、発射そのものは次の手順に分ける。
      { text: 'いま、もう一度射撃指示を出す',
        note: 'AAM-M は指定したままです。敵を右クリックしてください',
        pause: true,
        check: (ctx) => mine(ctx).some((u) => u.fireTasks && u.fireTasks.some((t) => t.weapon === 'AAM-M'))
          || firedOrSpent('AAM-M')(ctx) },
      { text: 'AAM-M を発射する',
        note: '**射程に入っていても、機首が敵の方を向くまでは撃ちません** —— ミサイルは機首の向きに出るからです',
        done: 'fire', when: (d) => d.weapon === 'AAM-M',
        check: firedOrSpent('AAM-M') },
      // **この的に1発目はまず当たらない**（§93.10・実測 0/27）。セミアクティブは照射した瞬間から
      // 相手の警報に入り、ほかにすることの無い的は撃たれた 0.5秒後から回避に入る。
      // 17・11・7km のどこで撃っても変わらず、反応を止めると 4/4。
      // **的はかわすままにして、文で伝える**（プレイヤーの決め）。落ちるのは2発目か AAM-S。
      // **撃ち切っても撃墜できないと、旋回戦が終わらない**（§98）。F-1 と J-7 は同じ性能で、
      // どちらも後ろを取れないまま回り続ける。AAM-M を撃ち切ってから一定時間
      // （飛んでいる弾が無いこと）で手順を終える。
      { text: '敵機を撃墜する',
        note: '**撃たれた相手はかわそうとします** —— 期待度が「高」でも、1発目はかわされることのほうが多い。'
          + '外れたら、もう1発の AAM-M か AAM-S で撃ち直します（指定してから右クリック）。'
          + 'ただし**近すぎても当たりません** —— 弾が曲がり切れる距離が要ります。'
          + `AAM-M を撃ち切って ${DOGFIGHT_CUTOFF} 秒たつと、この手順は終わります —— `
          + '同じ性能の相手とは、旋回戦ではなかなか決着がつきません',
        check: (ctx) => {
          const u = unit(ctx, 'BANDIT 1');
          if (u && !u.alive) return true;
          if (spentAll('AAM-M')(ctx) && spentAll('AAM-S')(ctx)) return true;   // 撃ち切ったら次へ
          if (!spentAll('AAM-M')(ctx)) return false;
          const t = ctx.loop.simTime;
          if (ctx.mem.spentAt == null) ctx.mem.spentAt = t;
          return t - ctx.mem.spentAt >= DOGFIGHT_CUTOFF
            && !ctx.world.missiles.some((m) => m.alive && m.side === ctx.world.playerSide);
        } },
    ],
  },

  // ================================================================ 基本3
  {
    id: 't8',
    group: '基本',
    name: '撃たれたら',
    title: '警報・デコイ・回避',
    brief: 'ミサイルは避けられます。ただし避け方は1つではありません。\n'
      + '着弾まで遠ければ背を向けて逃げ、近ければ真横を向いて紛れます。\n'
      + 'フレアは引き付ける囮、チャフは電波を通さない壁です。',
    hint: '敵は1機・練度も低く、こちらは2機います。'
      + 'こちらの自動発射は切ってあるので、撃ち返して終わってしまうことはありません。'
      + '落とされても、もう1機のほうで手順を続けられます。',
    terrain: { seed: 90008, mountainAmount: 0.7, coast: 'none', valleyDepth: 0.8, rivers: 2, baseAltitude: 400 },
    weaponPoints: 0,
    noFail: true,
    friendly: {
      base: { x: 10000, z: 40000 },
      startAirborne: true,
      startAlt: 5500,
      // **2機置く。** 1機だと落とされた時点で残りの手順が起こせなくなる。
      // AAM-S だけ持たせる — ここで教えるのは撃ち方ではないので、
      // 遠距離から撃ち返して終わってしまわないようにする。
      //
      // **自動発射も切る**（§79.4）。この面で敵機は「撃ってくる相手」ではなく
      // **ミサイルの出どころ**で、しかも積んでいる4発が供給の全部（帰る飛行場が無い）。
      // 自動で撃ち返して落としてしまうと、**かわす手順が二度と起こせなくなる。**
      aircraft: [
        { type: 'F-1', name: 'VIPER 1', loadout: ['AAM-S', 'AAM-S'],
          autoWeapons: { 'AAM-S': false, GUN: false } },
        { type: 'F-1', name: 'VIPER 2', loadout: ['AAM-S', 'AAM-S'],
          autoWeapons: { 'AAM-S': false, GUN: false } },
      ],
    },
    enemy: {
      skill: 0.2,
      aircraft: [
        // **中距離AAMを多めに積ませる。** 撃たれ続ける状況を作るのが目的。
        // 練度0.2 なので、当たるまでには間がある。
        { type: 'J-7', name: 'BANDIT 1', x: 34000, z: 20000, agl: 5500,
          aiMode: 'PURSUIT', loadout: ['AAM-M', 'AAM-M', 'AAM-M', 'AAM-M'],
          tags: ['target'] },
      ],
      ground: [],
    },
    steps: [
      { text: '機体を選択する',
        note: 'まず自分の機体の残りのデコイを確かめます',
        done: 'select' },
      // 「確かめる」を選択だけで済ませると、残数がどこに出ているか知らないまま進む（§98）。
      // 欄は FLR/CHF と略しているので、光らせてカーソルを合わせてもらう
      { text: '光っている欄（FLR/CHF）にカーソルを合わせ、デコイの残数を読む',
        note: `FLR はフレア、CHF はチャフの残数です（F-1 はフレア${AC('F-1').flares}・チャフ${AC('F-1').chaff}）。`
          + 'フレアは赤外線ミサイルを**引き付ける**囮、チャフは追う側との間に立つ**電波の壁**です。'
          + '撒くのはパイロットが自分で決めます（兵装欄の「デコイ 自動」で止めることもできます）',
        pause: true, highlight: '.dt-dec', hover: true },
      { text: 'ロック警報を受ける',
        note: '中距離AAM（AAM-M）は撃った側が着弾まで照らし続けるので、'
          + '**発射と同時に警報が出ます**。'
          + 'アクティブAAM（AAM-A）は終末まで黙っているので、'
          + '気づいたときには近い、という違いがあります',
        check: (ctx) => mine(ctx).some((u) => u.threats && u.threats.length > 0) },
      // **チャフを先に見せる**（§79.4）。
      // 撒くのは回避機動に入った瞬間で、雲は6秒で消える。かわし終えたあとに
      // 「撒かれたのを確かめる」を置いていたので、**見に行ったときにはもう
      // 雲も残数も無い**ということが起きた（チャフは10枚しかない）。
      { text: 'チャフが撒かれたのを確かめる',
        note: '**チャフは背を向けて逃げるときと、真横を向くときにだけ撒きます。**'
          + '正面を向いたまま撒いても、壁は後ろへ流れて間に立たないからです',
        check: (ctx) => ctx.world.decoys.some(
          (d) => d.kind === 'chaff' && d.side === ctx.world.playerSide)
          // 雲は6秒で消える。**撒いたことがあるなら見逃していても次へ送る** ——
          // ここで足踏みさせると、残数が尽きた時点で行き止まりになる
          || mine(ctx).some((u) => u.chaff < u.spec.chaff) },
      // 「かわした」は状態で書くしかない（§19.3）。
      // **1機ずつ、脅威に入る前の耐久ごと覚えておく**（§79.4）。
      //
      // 以前は「いま誰も脅威に入っていない」で達成としていたので、
      // **脅威に入っていた機が撃墜された瞬間にも成立していた** ——
      // 死ねば脅威ごと消えるうえ、`mine()` は生きている機体しか返さないので、
      // 「まだ狙われていない僚機」だけが残って条件を満たしてしまう。
      // 落とされたことを「かわした」と数えるのは、教えている中身と正反対。
      { text: 'ミサイルをかわす',
        note: '着弾まで遠ければ**背を向けて逃げ**（追う弾の足を削る）、'
          + '近ければ**真横を向いて**接近速度を消します（ビーム機動）。'
          + 'どちらを使うかはAIが着弾までの時間で決めます。倍速を上げて見てください',
        check: (ctx) => {
          const seen = ctx.mem.seen || (ctx.mem.seen = new Map());
          for (const u of mine(ctx)) {              // 生きている機体だけが回る
            if (u.threats && u.threats.length > 0) {
              if (!seen.has(u.id)) seen.set(u.id, u.hp);
              continue;
            }
            if (!seen.has(u.id)) continue;
            // **当たって生き延びたのは「かわした」ではない。**
            // 無傷のまま脅威が消えたときだけ数え、被弾していたら覚え直す
            if (u.hp >= seen.get(u.id)) return true;
            seen.delete(u.id);
          }
          return false;
        } },
      // 「誘導中も回避／誘導を優先」は w3 へ、対空砲の話は詳細「敵の防空」へ移した（§93.4）。
      // どちらも撃たれ方の基本ではない —— 前者は AAM-M を撃っているときだけの判断。
      { text: 'AIモードを「回避優先」にして離脱する',
        note: '交戦を避けて低空へ退避します。'
          + '**勝てない場面から機体を持ち帰るのも指揮官の仕事です**',
        done: 'aimode', when: (d) => d.mode === 'EVADE' },
    ],
  },

  // ================================================================ 基本4
  {
    id: 't6',
    group: '基本',
    name: '飛行場と対地',
    title: '出して、撃って、帰す',
    brief: '飛行場は補給と積み替えの拠点です。\n'
      + '兵装ポイントは作戦全体の共有資源で、積み替えるたびに減ります。\n'
      + '地上目標への攻撃と、帰投・補給までをひと通り通します。',
    hint: '敵はレーダーサイト1つだけ。撃ってこないので落ち着いて進められます。',
    terrain: { seed: 90006, mountainAmount: 0.8, coast: 'none', valleyDepth: 0.8, rivers: 2, baseAltitude: 400 },
    weaponPoints: 20,
    noFail: true,
    friendly: {
      base: { x: 12000, z: 36000 },
      startAirborne: false,
      aircraft: [
        { type: 'A-3', name: 'ANVIL 1', loadout: ['AGM', 'AAM-S'] },
      ],
    },
    enemy: {
      aircraft: [],
      ground: [
        { type: 'RADAR', name: 'レーダーサイト', x: 26000, z: 27000, tags: ['target'], known: true },
      ],
    },
    steps: [
      { text: '機体を選択して発進させる',
        note: '下のパネルの「発進」か、目標欄の「全機発進」。滑走路を使うので少し時間がかかります',
        done: 'takeoff' },
      { text: '高度 1,000 m 以下まで降りる',
        // 見える距離の数字は詳細「探知」へ（§93.2: 補足は短く、諸元は詳細へ）
        note: '地上レーダーは、低い目標ほど遠くからは見えません。'
          + '山が視線を遮るのも、低空のほうがよく効きます',
        check: (ctx) => mine(ctx).some((u) => !u.onGround && agl(ctx, u) <= 1000) },
      { text: 'レーダーサイトを右クリックして攻撃を指示する',
        note: '地上目標はブリーフィングで判明していたので、最初から地図に出ています。'
          + '兵装を指定しなければ、パイロットが自動使用の兵装から選んで撃ちます',
        done: 'order:attack' },
      { text: 'レーダーサイトを破壊する',
        note: 'AGM は対空砲や SAM の射程の外から撃てます（ここの目標は撃ってきませんが、本編では守られています）。'
          + '無誘導爆弾なら目標の真上を通る必要があります',
        check: (ctx) => { const u = unit(ctx, 'レーダーサイト'); return !!u && !u.alive; } },
      // done と check の併用。燃料が尽きかけると AI が自分で帰投を始めるため、
      // プレイヤーが B を押す前に着いてしまうことがある。
      // 降りてしまうと B は効かない（orderRtb は地上の機体を無視する）ので、
      // その場合だけ check 側で次へ送る。行き止まりを作らないための保険。
      { text: 'B キーで帰投を指示する',
        note: '燃料が尽きる前に帰すのも指揮官の仕事です',
        done: 'order:rtb',
        check: (ctx) => mine(ctx).some((u) => u.onGround) },
      { text: '飛行場に着陸させる',
        note: '進入・接地・滑走まで自動で行います。倍速を上げて待つとよいでしょう',
        check: (ctx) => ctx.world.units.some((u) => u.kind === 'aircraft'
          && u.side === ctx.world.playerSide && u.alive
          && (u.state === 'parked' || u.state === 'servicing' || u.state === 'ready')) },
      { text: '搭載を積み替える',
        // 枠の太さの仕組みは詳細「搭載枠」へ（§93.3）。ここでは読み方だけ
        note: '下のパネルで兵装を足す／降ろす。足すと兵装ポイントが減り、降ろすと戻ります。'
          + '**枠の表示が赤くなったら載せ切れていません** —— 兵装によって載る枠が違うので、'
          + '数が足りていても積めないことがあります',
        done: 'loadout' },
      { text: '「整備後に発進」を ON にする',
        note: '整備が終わった時点で自動的に発進します。一度きりで、発進すると解除されます。'
          + '積み替えのたびに整備の終わりを見張らなくて済みます。\n'
          + 'これで基本は終わりです。**ミッションを終えたら、リザルト画面の'
          + '「戦闘を振り返る」から撃墜の瞬間まで戻れます** — '
          + '3Dで見直すこともできるので、なぜ落とされたのかはそこで分かります',
        pause: true, highlight: '[data-cmd="autolaunch"]',
        check: (ctx) => mine(ctx).some((u) => u.autoLaunch) },
    ],
  },

  // ================================================================ 戦術1
  {
    id: 't2',
    group: '戦術',
    name: '高度とエネルギー',
    title: '高度は速度と交換できる',
    brief: '高度はこのゲームでいちばん効く要素です。\n'
      + '高いほど推力と旋回率は落ちますが、ミサイルはよく飛びます。\n'
      + '高度と速度は交換できる同じ資産で、その合計が「エネルギー」です。',
    hint: '敵はいません。高度・速度・エネルギーの関係だけを見ます。'
      + `F-1 がいちばんよく曲がるのは ${cornerMs('F-1')} m/s あたり（コーナー速度）で、`
      + '速すぎても遅すぎても旋回率は落ちます。'
      + 'ただし速度を直接指示する操作はありません。'
      + '高度とアフターバーナーで結果として決まります。',
    terrain: { seed: 90002, mountainAmount: 0.7, coast: 'none', valleyDepth: 0.8, rivers: 2, baseAltitude: 380 },
    weaponPoints: 0,
    noFail: true,
    friendly: {
      base: { x: 12000, z: 38000 },
      startAirborne: true,
      startAlt: 4000,
      aircraft: [
        { type: 'F-1', name: 'VIPER 1', loadout: ['AAM-S'] },
      ],
    },
    enemy: { aircraft: [], ground: [] },
    steps: [
      { text: '機体を選択し、下の「エネルギー」の数字を覚えておく',
        note: '高度と速度を足し合わせた「まだ戦える余力」です。'
          + '9,000m を超えていれば十分、6,000m を切ると苦しい、という目安で見ます',
        done: 'select' },
      // 状態で分かるものは通知しない（§19.3）。AB モードは `abMode` を見れば足りる。
      { text: 'アフターバーナーを「全力」にする',
        note: '温存＝巡航を保ちミサイルから逃げるときだけ焚く／標準＝敵機と交戦するとき／'
          + '全力＝効くなら焚く。**燃料の減りは3倍**になります',
        pause: true, highlight: '[data-ab="max"]',
        check: (ctx) => mine(ctx).some((u) => u.abMode === 'max') },
      { text: 'X キーで指示高度を上げる',
        note: '下の SELECTED パネルの高度ボタンでも指定できます',
        done: 'alt:up' },
      // **高度ボタンの刻みに合わせる**（600/2000/4000/7000/10000）。
      // 長く 8,000m と書いてあったが、その値のボタンは無い。
      // X キーを 500m ずつ8回押すか、10,000m を選ぶしかなく、
      // 「押してほしい場所」を指し示せなかった。
      { text: '高度を「高々度」（7,000 m）まで上げる',
        note: '「高度性能」の欄を見てください。上がるほど推力と旋回率が落ち、'
          + 'そのかわりミサイルの射程が伸びます。時間がかかるので倍速を上げてください',
        highlight: '[data-alt="7000"]',
        check: (ctx) => mine(ctx).some((u) => u.pos.y >= 6800) },
      // **先に進路を与える。** 待機旋回のまま降ろしても加速しない。
      // 実測: 周回したままだと 7,000m からでも 10,000m からでも 211 m/s で頭打ち、
      // 遠くへ移動を指示してから降ろすと 309〜315 m/s まで伸びた。
      // 長く「240 m/s 以上」と書いてあったが、**周回のままでは届かない**。
      { text: '遠くの地点へ移動を指示する',
        note: '旋回しながらでは速度になりません。'
          + '**高度を速度に変えるには、まっすぐ飛ばせる進路が要ります**',
        done: 'order:move' },
      { text: '高度を「低空」（600 m）まで下げる',
        note: '降下は「高度を速度に変える」操作です。'
          + '**エネルギーの合計はほとんど変わりません** — 減るのではなく形が変わります',
        highlight: '[data-alt="600"]',
        check: (ctx) => mine(ctx).some((u) => (u.order?.alt ?? u.desiredAlt) <= 2000) },
      { text: '降下の勢いで 280 m/s 以上まで加速させる',
        note: `F-1 の巡航は ${AC('F-1').cruiseSpeed} m/s。高度を使い切ったぶんだけ速く飛べます。`
          + `いちばんよく曲がるのは ${cornerMs('F-1')} m/s あたり（コーナー速度）なので、`
          + '**速ければ有利、というわけではありません**',
        check: (ctx) => mine(ctx).some((u) => u.speed >= 280) },
      { text: 'アフターバーナーを「温存」に戻す',
        note: '巡航を保ち、ミサイルから逃げるときだけ焚きます。'
          + '進出距離の長い任務では、これが往復できるかどうかを決めます。'
          + '**低空まで降りたいまは、エネルギーがもう残っていません** — '
          + '上がり直すには時間が要ります',
        pause: true, highlight: '[data-ab="save"]',
        check: (ctx) => mine(ctx).some((u) => u.abMode === 'save') },
    ],
  },

  // ================================================================ 戦術2
  //
  // **t3「レーダーと目視」と t7「電波と逆探知」を1本に畳んだ**（§93.3）。
  // 前半は「見る」（扇・低空・識別・目視）、後半は「見られる」（逆探知・放射と沈黙）。
  // 地図と敵レーダーサイトは t7 のまま —— サイトの位置は尾根との視線で決めてある。
  {
    id: 't3',
    group: '戦術',
    name: '見える・見えない',
    title: '何が見えて、何に見られているか',
    brief: '画面に出ているのは「真の配置」ではなく「こちらが把握できている情報」です。\n'
      + '機体のレーダーは機首前方の扇しか見ていません。'
      + '味方飛行場のレーダーは全方位ですが、低い目標ほど遠くからは見えません。\n'
      + 'そしてレーダーは、出せば遠くまで見えるかわりに、出した電波が相手にも届きます。',
    hint: '敵機は2機とも武装していません。落とす必要はありません。',
    terrain: { seed: 90007, mountainAmount: 0.7, coast: 'none', valleyDepth: 0.8, rivers: 2, baseAltitude: 400 },
    weaponPoints: 0,
    noFail: true,
    friendly: {
      base: T3.base,
      startAirborne: true,
      startAlt: 5000,
      // **自動発射は切る。** 目視の手順より先に BANDIT 1 を落としてしまうと、
      // 捉える相手がいなくなって先へ進めない（AAM-M なら識別した時点で届く）。
      aircraft: [
        { type: 'F-1', name: 'VIPER 1', loadout: ['AAM-M', 'AAM-S'],
          autoWeapons: { 'AAM-M': false, 'AAM-S': false, GUN: false } },
      ],
    },
    enemy: {
      skill: 0.2,
      ground: [
        // **自機のレーダーの外に置く**（§50.3）。電波を拾う以外に見つける手が無い。
        //
        // **逆探知にも視線判定が要る**（`byRwr` が `hasLineOfSight` を見る）。
        // 最初 (44000,8000) に置いたら、あいだの尾根に遮られて
        // **高度8,000mまで上げても一度も掴めなかった**。
        // 標高2,375m の尾根の上に移して、対地3,000m から視線が通るようにした
        // （実測。レーダーサイトを高所に置くのは理屈にも合う）。
        { type: 'RADAR', name: '敵レーダーサイト', x: T3.site.x, z: T3.site.z, tags: ['emitter'] },
      ],
      // **2機とも黙らせる**（§50.3）。電波を出させると、こちらが何もしなくても
      // 逆探知で見つかってしまい、「扇を向けないと見えない相手」が作れない。
      // 実測では t7 の敵機を `radarMode: 'on'` にしていたせいで
      // **手順の半分が開始2秒で自動的に達成されていた**。
      aircraft: [
        // 前半の相手。**低空**に置く —— 飛行場のレーダーは低い目標ほど届かない
        // （対地3,000m で満額、400m では約4割）。放っておけば飛行場へ向かって飛んでくる。
        { type: 'J-7', name: 'BANDIT 1', x: T3.low.x, z: T3.low.z, agl: 400,
          aiMode: 'TRANSIT', loadout: [], autoWeapons: { GUN: false },
          radarMode: 'off', tags: ['target'],
          moveTo: { x: T3.base.x, z: T3.base.z, agl: 400 } },
        // 後半の相手。**前半の相手とも陣地とも別の方角に置く。** 同じ方角に並べると、
        // 「逆探知で見えているほう」と「レーダーで探すほう」が区別できない。
        dummyFighter('BANDIT 2', T3.silent.x, T3.silent.z, 5000, { radarMode: 'off' }),
      ],
    },
    steps: [
      { text: '機体を選択して、前方に出るレーダーの扇を確認する',
        note: '扇の中が機体のレーダーで見える範囲。内側の弧より近ければ、捉えた瞬間に機種まで分かります',
        done: 'select' },
      // 方角で指示する最初の本なので、方位盤を一度見てもらう（§98）
      { text: '右上の方位盤にカーソルを合わせ、北を確かめる',
        note: '**N の矢印が北**を指します。視点を回すと（Q/E キー）盤も一緒に回ります。'
          + '盤をクリックすると、北が画面の上に来る向きに戻ります。'
          + 'ミニマップは常に北が上です',
        pause: true, highlight: '#compass', hover: true },
      { text: '北から接近してくる敵機を捉える',
        note: '敵は低空を飛んでおり、飛行場のレーダーからも隠れています。'
          + '北へ移動を指示して、扇を向けに行ってください。'
          + '待っていても、飛行場に近づけばいずれ飛行場のレーダーが捉えます',
        check: (ctx) => !!contactOf(ctx, unit(ctx, 'BANDIT 1')) },
      { text: '追尾を続けて敵機を識別する（機種が判明する）',
        note: '捉えた直後は UNKNOWN です。追い続けるか、探知距離の半分まで詰めると識別できます。'
          + '扇から外すと探知は切れ、最後の位置と針路からの推測表示に変わります',
        check: (ctx) => { const c = contactOf(ctx, unit(ctx, 'BANDIT 1')); return !!c && c.level >= LEVEL.IDENTIFIED; } },
      { text: '目視の距離（8km 以内）まで近づく',
        note: '目視まで詰めると速度まで読めます。目視は機首の向きに縛られませんが、届くのは 8km までです',
        check: (ctx) => { const c = contactOf(ctx, unit(ctx, 'BANDIT 1')); return !!c && c.level >= LEVEL.DETAILED; } },
      // **「見る」を操作にする。** 印は開いた時点から出ているので、
      // 「確かめる」だけの手順は入った瞬間に達成して、読む前に流れていた（t7 の2手順目）。
      { text: '北東の遠方に出ている印へ視点を寄せる（ミニマップでその辺りをクリック）',
        note: `敵のレーダーサイトです。自機のレーダー（${AC('F-1').radarRange / 1000}km）でも`
          + `味方飛行場（${GROUND_TYPES.AIRBASE.radar.range / 1000}km）でも届かない距離にあります。`
          + 'それでも見えているのは、**相手が出している電波をこちらが拾っているから**です（逆探知）。'
          + `方向は正確でも距離が甘いので、遠いほど位置がぶれます（最大 ±${RWR_POS_ERROR / 1000}km）`,
        check: (ctx) => {
          const site = unit(ctx, '敵レーダーサイト');
          return !!contactOf(ctx, site)
            && Math.hypot(ctx.rig.target.x - site.pos.x, ctx.rig.target.z - site.pos.z) < 6000;
        } },
      { text: 'レーダーを「常時OFF」にする',
        note: '欄は 自動／常時ON／常時OFF の3つで、右に「放射中」か「沈黙」かが出ます。'
          + '**陣地の印が消えないことを確かめてください** — 逆探知は聞いているだけなので、こちらが黙っても働きます。'
          + 'ただし黙っているあいだ **AAM-M は撃てません**（着弾まで自分のレーダーで照らす弾です）。'
          + 'AAM-A は、僚機のレーダーが目標を捉えていれば黙ったまま撃てます（データリンク）',
        pause: true, highlight: '[data-radar="off"]',
        check: (ctx) => mine(ctx).some((u) => u.radarMode === 'off') },
      { text: 'レーダーを「常時ON」に戻す',
        note: '遠くまで見えるかわりに、**こちらも相手の逆探知に映ります** —— '
          + `届く距離はレーダーの射程の${RWR_SIGNATURE_FACTOR}倍で、F-1 なら ${rwrKm('F-1')}km 先からです。`
          + '出すか黙るかは、そのまま「見つけるか、見つからないか」の選択です',
        pause: true, highlight: '[data-radar="on"]',
        check: (ctx) => mine(ctx).some((u) => u.radarMode === 'on') },
      { text: `東の敵機（飛行場からおよそ ${T3_SILENT_KM}km）を捉えて、機種まで確かめる`,
        note: '**この敵機は電波を出していません。** だから逆探知には映らず、扇に入れるまで見つかりません。'
          + '実戦では「自動」に任せておけば、敵機を掴んでいないとき・交戦中・相手のレーダー圏内でだけ出して、'
          + 'それ以外は黙ります。手で切り替えるのは、待ち伏せたいときと、囮になりたいときです',
        check: (ctx) => {
          const c = contactOf(ctx, unit(ctx, 'BANDIT 2'));
          return !!c && c.level >= LEVEL.IDENTIFIED;
        } },
    ],
  },

  // ================================================================ 戦術3
  //
  // **新しく作った本**（§93.3）。雲の層の下・中・上を通り比べる。
  // 締めは §88.16 の「雲は見つけられたくない側に味方する」。
  //
  // **層の高さは数字で教えない**（§93.6・プレイヤーの決め）。本編でも数字は出ないので、
  // 視点を倒して**機体と層の上下を見比べる**読み方を手順にする。
  {
    id: 'k1',
    group: '戦術',
    name: '雲と天候',
    title: '雲は見つけられたくない側に味方する',
    brief: '雲は、光と赤外線を通しません。電波は通りますが、通ったぶんだけ弱ります。\n'
      + '層の上を飛べば、地上の目と赤外線からは隠れられます。'
      + '層の中にいれば誰からも見えにくくなりますが、自分も見えません。\n'
      + '層は風で流れます。',
    hint: '敵機は武装していません。赤外線SAM は撃ってきますが、この本では落とされても失敗になりません。'
      + '機体のAIモードは「手動」、レーダーは「常時ON」にしてあります —— 指示したとおりの高さと場所を飛びます。',
    // **平らな地形。** 層の底（1,200m）の下に丘が届くと、下と中の区別が付かない。
    // 最初の 90011・山岳 0.25 は通り道の最高点が 1,121m で、層の底のすぐ下だった。
    // これは通り道（東西 2〜50km・南北 12〜40km）の最高点が約 570m
    terrain: { seed: 90014, mountainAmount: 0.05, coast: 'none', valleyDepth: 0.4, rivers: 1, baseAltitude: 150 },
    // **層を高度ボタンの段のあいだに置く**（§93.4・§19.4: 手順に書ける高度は段だけ）。
    // 低空 600m＝下・中低 2,000m＝中・中高 4,000m＝上。
    //
    // **§93.4 の叩き台（層 2,600〜5,000m・7,000m で上を通る）から下げた。**
    // 7,000m は雲が無くても赤外線SAM（射高 5,000m）と対空砲（1,500m）の外で、
    // 「撃たれない」のが雲のおかげにならない。4,000m なら射高の内側で、
    // **撃たれないのは層を挟んでいるから**と言える。
    //
    // `deck` は横に広く縦に薄い塊で、並ぶと層に見える（横から読む手順に向く）。
    // `broken` は切れ目が残る量 —— 本編の雲と同じく、切れ目の上では撃たれる。
    weather: { cloud: 'broken', shape: 'deck', base: 1200, top: 3000, wind: { deg: 270 } },
    // **種を固定する**（§93.7）。塊の位置は種で決まり、切れ目が SAM の上に来ると
    // 「上を通れば撃たれない」が崩れる。293 は、SAM から 4,000m・水平 4.6km 以内への視線が
    // **全方位で20分間ずっと層に切られる**種（600種を計算して20種が満たした中で、
    // 下の敵機の上もいちばんよく覆われていた）。天候・SAM・敵機の位置を動かしたら選び直すこと
    battleSeed: 293,
    weaponPoints: 0,
    noFail: true,
    friendly: {
      base: K1.base,
      startAirborne: true,
      startAlt: 4000,
      // **手動にしておく。** 既定の哨戒のままだと、移動を終えた時点で 14km 以内の敵機へ
      // 自分から向かい、**層を抜けて降りて目視で捉えてしまう**（通しで実測 —— 4,000m 指示のまま
      // 1,000m 前後まで降り、最後の手順が DETAILED になった）。機銃は固定装備なので
      // 「武装なし」にはならない（`isArmed` は機体の諸元で見る）。
      //
      // **レーダーは常時ON にしておく。** 「自動」が索敵のために電波を出すのは、
      // 敵を探すモード（哨戒・追撃・連携・護衛・拠点防空）のときだけ（`aircraft.js` の `_radarWanted`）。
      // 手動のままだと一度も電波を出さず、最後の手順で敵機を捉えられなかった（通しで 250秒以上）
      aircraft: [
        { type: 'F-1', name: 'VIPER 1', loadout: [], autoWeapons: { GUN: false },
          aiMode: 'MANUAL', radarMode: 'on' },
      ],
    },
    enemy: {
      skill: 0.2,
      ground: [
        { type: 'IRSAM', name: '赤外線SAM', x: K1.sam.x, z: K1.sam.z, tags: [], known: true },
      ],
      aircraft: [
        // **層の下に留める。** 経路飛行は交戦も退避もしないので、層を抜けて上がってこない。
        // 着いたら到着点のまわりを回り続ける。電波は出させない（逆探知で見つかってしまう）
        { type: 'J-7', name: 'BANDIT 1', x: K1.bandit.x, z: K1.bandit.z, agl: 400,
          aiMode: 'TRANSIT', loadout: [], autoWeapons: { GUN: false },
          radarMode: 'off', tags: ['target'],
          moveTo: { x: K1.orbit.x, z: K1.orbit.z, agl: 400 } },
      ],
    },
    steps: [
      // **なぞったことを状態で見る。** 風の印をなぞると `#hoverInfo` に方位と風速が出る（§88.15）
      { text: 'ミニマップ右下の風の印にマウスを載せて、雲の流れる向きを読む',
        note: '矢印は雲が流れていく向きで、載せると方位と速さが出ます。'
          + '**雲は動くので、隠れ場所には期限があります**',
        pause: true,
        check: () => {
          const box = document.getElementById('hoverInfo');
          return !!box && box.dataset.wind === '1' && !box.classList.contains('hidden');
        } },
      { text: '機体を選択し、F キーで視点を倒して、機体と雲の層を横から見比べる',
        note: '層の高さは数字では出ません。**横から見れば、機体が層の上・中・下のどこにいるかが分かります**。'
          + 'いまは層の上です。R キーで元の角度に戻せます',
        pause: true,
        check: (ctx) => ctx.commands.selection.some((u) => u.alive) && ctx.rig.pitch <= 0.4 },
      { text: '高度を「中低」（2,000 m）へ下げて、雲の層に入る',
        note: '中にいるあいだは目視と赤外線から消え、レーダーにも映りにくくなります。'
          + '**そのかわり自分も見えません** —— 隠れるには向いていますが、戦うには向きません',
        highlight: '[data-alt="2000"]',
        check: (ctx) => {
          const cl = ctx.world.clouds;
          const inside = mine(ctx).some((u) => cl && cl.contains(u.pos));
          if (!inside) { ctx.mem.t0 = null; return false; }
          ctx.mem.t0 ??= ctx.loop.simTime;
          return ctx.loop.simTime - ctx.mem.t0 >= 3;
        } },
      { text: '高度を「中高」（4,000 m）へ上げて層の上に出てから、東の赤外線SAM の真上を通る',
        note: `赤外線SAM は ${K1_SAM.range / 1000}km・高さ ${K1_SAM.maxAlt.toLocaleString()}m まで届きますが、`
          + '**層を挟むとこちらが見えません** —— 光と赤外線は雲を通らないからです。対空砲も同じです。'
          + '切れ目の上に出れば撃たれます',
        highlight: '[data-alt="4000"]',
        check: (ctx) => {
          const sam = unit(ctx, '赤外線SAM');
          const top = ctx.world.clouds ? ctx.world.clouds.top : 0;
          return !!sam && mine(ctx).some((u) => u.pos.y > top
            && Math.hypot(u.pos.x - sam.pos.x, u.pos.z - sam.pos.z) < 1500);
        } },
      // **目視の距離まで寄らせ、そこでも速度が読めないこと（DETAILED にならない）を見せる。**
      // 本題はそちらで、「識別する」だけだと寄らずに済んでしまう。レーダーを常時ON で始めるので、
      // SAM へ向かう途中で識別すれば入った瞬間に達成する心配もあった（通し2回では起きず、
      // 識別は手順5に入って 22〜35秒後）。通し（層の上から 60秒見続けた）では、
      // 自機 → 敵機の視線は 1,800サンプルすべて雲に切られていた
      { text: 'さらに東、層の下を飛んでいる敵機の上まで行き、目視の距離（8 km 以内）に入る',
        note: '機種はレーダーで分かっていますが、**目視は層で切れる**ので、8km 以内に入っても速度までは読めません。'
          + '頼れるのはレーダーだけです（電波は層を横切るぶんには少し弱るだけ）。\n'
          + '**雲は見つけられたくない側に味方します** —— 攻める側・隠れる側には味方、探す側には敵です',
        check: (ctx) => {
          const b = unit(ctx, 'BANDIT 1');
          const c = contactOf(ctx, b);
          return !!c && c.level >= LEVEL.IDENTIFIED
            && mine(ctx).some((u) => u.distanceTo(b) < 8000);
        } },
    ],
  },

  // ================================================================ 戦術4
  {
    id: 't5',
    group: '戦術',
    name: '任せ方',
    title: '編隊を組み、動き方を任せる',
    brief: '機体は放っておいても自分で戦います。\n'
      + '指揮官が決めるのは「どこまで任せるか」です。\n'
      + '編隊を組めばレーダーの扇を分担し、AIモードで動き方が変わります。',
    terrain: { seed: 90005, mountainAmount: 0.9, coast: 'none', valleyDepth: 0.9, rivers: 2, baseAltitude: 420 },
    weaponPoints: 0,
    noFail: true,
    friendly: {
      base: { x: 11000, z: 38000 },
      startAirborne: true,
      startAlt: 5000,
      aircraft: [
        { type: 'F-1', name: 'VIPER 1', loadout: ['AAM-M', 'AAM-S'] },
        { type: 'F-1', name: 'VIPER 2', loadout: ['AAM-M', 'AAM-S'] },
        { type: 'F-2', name: 'HAMMER 1', loadout: ['AAM-M', 'AAM-S'] },
      ],
    },
    enemy: {
      skill: 0.2,
      aircraft: [
        { type: 'J-7', name: 'BANDIT 1', x: 32000, z: 22000, agl: 5500,
          aiMode: 'PATROL', loadout: [], autoWeapons: { GUN: false }, tags: ['target'] },
      ],
      ground: [],
    },
    steps: [
      { text: 'ドラッグで2機以上を選択する',
        check: (ctx) => ctx.commands.selection.filter((u) => u.alive).length >= 2 },
      { text: 'G キーで編隊を組む',
        note: '最大4機まで。編隊には番号が振られます',
        done: 'formation' },
      // 番号で呼び出す操作は操作ヘルプにしか出ていなかった（§60.4）。
      { text: 'Esc で選択を外し、数字キーで編隊を呼び出す',
        note: '編隊の番号（1〜9）を押すと、その編隊がまるごと選択されます。'
          + '**Ctrl+数字で番号を付け替えられます。**'
          + '編隊が増えたときに、探さずに呼べるのが効きます',
        check: (ctx) => {
          const sel = ctx.commands.selection.filter((u) => u.alive);
          if (!sel.length) { ctx.mem.cleared = true; return false; }
          return !!ctx.mem.cleared && sel.length >= 2 && sel.every((u) => u.formation);
        } },
      { text: 'AIモードを「連携」にする',
        note: '連携中はレーダーの扇を左右に分担して、編隊で広く探します。'
          + '狙いが同じ敵に重なっても、**すでに飛んでいる味方の弾で落とし切れる見込みなら、'
          + '次の弾は撃ちません**（どのモードでも同じ）。'
          + '**AIモードは7つあります。「詳細」のチュートリアルでまとめて扱います**',
        done: 'aimode', when: (d) => d.mode === 'COORDINATE' },
      { text: '編隊の形を「横隊」にする',
        note: '密集＝互いを近くに置く（護衛や、まとめて動かしたいとき）／'
          + '横隊＝横に開く。**探知の幅が広がり、挟み撃ちに移りやすくなります**',
        done: 'shape', pause: true, highlight: '[data-shape="SPREAD"]' },
      { text: 'Shift+G で編隊を解散する',
        note: '扇の分担も番号も外れ、1機ずつに戻ります。'
          + '**役割を変えたいときは、組み直すより解散が早い**ことがあります',
        check: (ctx) => {
          const all = mine(ctx);
          if (all.some((u) => u.formation)) { ctx.mem.had = true; return false; }
          return !!ctx.mem.had;
        } },
      { text: '1機だけを選び、別の自軍機を右クリックして随伴させる',
        note: '随伴（follow）は**付いていくだけの指示**です。'
          + '守る相手の後ろ側に付き、追い抜かないよう速度を合わせます。'
          + 'このあと護衛にするので、いまは付けるだけです',
        done: 'order:follow' },
      // x1「AIモード」から移した（§93.3）。随伴と対にしないと違いが伝わらない。
      { text: 'そのまま AIモードを「護衛」にする',
        note: '**随伴との違いは、近づく敵を迎えに行くことです。** '
          + `守る相手の ${ENGAGE_RANGE.ESCORT / 1000}km 以内に入った敵機へ、こちらから向かいます —— `
          + '距離を測る基準が自分ではなく守る相手なのは、このモードだけです。'
          + '守る相手は「随伴している相手」で、随伴の指示が無いと哨戒に戻ります',
        done: 'aimode', when: (d) => d.mode === 'ESCORT' },
      { text: '自動発射のしきい値を変える',
        note: '「高」にすると確実な機会しか撃たなくなり、ミサイルは節約できますが決め手を欠きます。\n'
          + '**複数機を選んでいれば、まとめて変えられます。** '
          + 'レーダー・AB・自動発射のしきい値・機銃・デコイ・誘導中の扱いは、'
          + '選択している全機に同じ指定が入ります。'
          + '揃っていない項目には「混在」と出るので、一度押せば揃います',
        done: 'threshold' },
      // 状態で分かるので通知は増やさない（§19.3）。
      { text: '中距離AAMの自動使用を「停止」にする',
        note: 'しきい値は全部の兵装にまとめて掛かりますが、こちらは**兵装ごと**です。'
          + '高い弾を自分の判断でだけ使いたいときに切ります。'
          + '切っても、兵装を指定して右クリックすれば撃てます',
        pause: true, highlight: '[data-auto="AAM-M"]',
        check: (ctx) => mine(ctx).some((u) => u.autoWeapons && u.autoWeapons['AAM-M'] === false) },
    ],
  },

  // ================================================================ 戦術5
  //
  // **新しく作った本**（§93.3）。防衛面の読み方 —— 「N/M 健在」・哨戒の中心・
  // 波で来る敵・積み直しも兵装ポイントの上限から引かれる（§92.7）。
  //
  // **チュートリアルは `noFail`** なので合否は出ない（`mission.js` の `_evaluate` が先頭で返る）。
  // 目標欄の「N/M 健在」は `status()` が生存数を直に読むので出る。
  // 最後の一撃（§12.2）も起きないので、文で伝える。
  {
    id: 'k2',
    group: '戦術',
    name: '守る',
    title: '守りきる面の読み方',
    brief: '防衛の任務では、敵が守る施設を狙って波で来ます。\n'
      + '施設をいくつ失えば失敗かは、目標欄の「健在」の数で分かります。\n'
      + '弾を撃てば積み直しが要り、その費用は出撃のときと同じ兵装ポイントから引かれます。',
    hint: '第1波の爆撃機は撃ち返してきません。施設を壊されても失敗にはなりません。',
    terrain: { seed: 90012, mountainAmount: 0.6, coast: 'none', valleyDepth: 0.7, rivers: 2, baseAltitude: 300 },
    weaponPoints: K2_POINTS,
    noFail: true,
    objectives: [
      { id: 'hold', type: 'hold', tag: 'depot', min: 2, label: '補給施設を2箇所以上守る', fail: true },
    ],
    friendly: {
      base: K2.base,
      startAirborne: false,
      aircraft: [
        { type: 'F-1', name: 'VIPER 1', loadout: ['AAM-M', 'AAM-M', 'AAM-S', 'AAM-S'] },
        { type: 'F-1', name: 'VIPER 2', loadout: ['AAM-M', 'AAM-M', 'AAM-S', 'AAM-S'] },
      ],
      ground: K2.depots.map((d) => ({ type: 'DEPOT', name: d.name, x: d.x, z: d.z, tags: ['depot'], known: true })),
    },
    enemy: {
      // **敵の任務**（§27.6）。司令官AIが読んで、爆撃機を施設へ差し向ける
      objectives: [
        { id: 'raid', type: 'destroyAll', tag: 'depot', label: '敵の補給施設を破壊する' },
      ],
      // 第2波。**第1波を片付けて積み直しているころに上がる**
      base: { ...K2.enemyBase, known: true,
        reinforce: { first: 300, every: 9999, max: 2, burst: 2, types: ['B-9'], tags: ['raid'] } },
      ground: [],
      // 第1波。**空対空弾は外す**（既定の搭載は爆弾6＋AAM-S）
      aircraft: K2.raiders.map((r) => ({ type: 'B-9', name: r.name, x: r.x, z: r.z, agl: 5200,
        loadout: ['BOMB', 'BOMB', 'BOMB', 'BOMB'], tags: ['raid'] })),
    },
    steps: [
      // 「読む」は状態で判定できないので、発進と1つにする（§93.10 の t4 と同じ考え）
      { text: '目標欄で守る施設の残りを読んでから、2機とも発進させる',
        note: '「（3/3 健在）」は、守る施設がいくつ残っているかです。'
          + '**本編では下限（ここでは2箇所）を割った時点で失敗**になります。'
          + '目標欄の「全機発進」で2機まとめて出せます',
        check: (ctx) => mine(ctx).length >= 2 && mine(ctx).every((u) => !u.onGround) },
      // **§93.4 の「動かしてから『哨戒』を押す」はやめた。** 自軍機は最初から哨戒で
      // （`sim/aircraft.js` の既定）、移動の指示が行き先を哨戒の中心に置く（`ui/commands.js`）。
      // 押さなくても同じことが起きていて、通しでは押す前に達成していた。
      // 落とし穴は逆向き —— **移動の途中でモードを押し直すと、その場所が中心になる**（`hud.js` の `_setMode`）
      { text: '1機を施設の上空へ移動させて、そこで待たせる',
        note: '**移動の行き先が、そのまま哨戒の中心になります**（AIモードは最初から「哨戒」です）。'
          + `中心から ${ENGAGE_RANGE.PATROL / 1000}km 以内に入った敵だけを迎え撃ち、深追いしません。`
          + '**途中で AIモードを押し直すと、その時点の位置が中心に変わります** —— 選び直すなら着いてから',
        check: (ctx) => mine(ctx).some((u) => u.aiMode === 'PATROL' && u.patrolArea
          && Math.hypot(u.pos.x - u.patrolArea.x, u.pos.z - u.patrolArea.z) < 3000
          && ctx.world.units.some((d) => d.alive && d.tags && d.tags.includes('depot')
            && Math.hypot(d.pos.x - u.patrolArea.x, d.pos.z - u.patrolArea.z) < K2_NEAR)) },
      // 逃げ道: 爆弾を落とし終えた爆撃機はもう施設を壊せないので、落とせなくても先へ進める
      { text: '北東から来る第1波の爆撃機を落とす',
        note: '爆撃機は硬く、施設の真上を通って爆弾を落とします。'
          + '**着く前に落とせば、健在の数は減りません**',
        check: (ctx) => K2.raiders.every((r) => {
          const u = unit(ctx, r.name);
          return !u || !u.alive || !u.loadout.includes('BOMB');
        }) },
      // 逃げ道: 積み直しの費用が要るのは AAM-M だけ（AAM-S と機銃は 0P）。
      // それしか撃たなかった場合は、整備が終わった時点で先へ送る
      { text: 'B キーで帰投させ、撃った弾を積み直す',
        note: '着陸すると、撃った弾は整備で積み戻されます。**そのぶん兵装ポイントの残りが減ります** —— '
          + '積み直しも、出撃の搭載と同じ上限から引かれます。長い防衛では、弾より先にポイントが尽きます',
        check: (ctx) => (ctx.world.weaponPoints ?? 0) < (ctx.world.weaponPointsMax ?? 0)
          || mine(ctx).some((u) => u.state === 'ready') },
      { text: '帰投した機体を選び、「整備後に発進」を ON にして第2波に備える',
        note: '敵は波で来ます。北東の飛行場から次の爆撃機が上がり、生き残った機体も積み直して戻ってきます。\n'
          + '**本編では全機を失っても、飛んでいる弾が残っているうちは負けになりません**（最後の一撃）。'
          + 'ただしそのあいだも敵は施設を狙い続けます',
        pause: true, highlight: '[data-cmd="autolaunch"]',
        check: (ctx) => mine(ctx).some((u) => u.autoLaunch) },
    ],
  },

  // ================================================================ 兵装1
  //
  // **兵装の本は射撃指示の流れを教え済みとして書く**（§93.2）。攻撃指示 → 兵装指定 →
  // 射撃指示 → 撃てない理由 → 取消 は基本2「空対空」（t4）で1回だけ教える。
  // ここでは攻撃指示と指定を1手順にまとめ、**その兵装でしか起きないことを1つ**体験させる。
  // 諸元の全体と搭載枠の話は詳細の資料へ回した（§93.12 の「詳細へ回した文」）。
  {
    id: 'w1',
    group: '兵装',
    name: '機銃',
    title: '拡散と弾速',
    brief: '機銃は搭載品ではなく、はじめから機体に付いている固定装備です。\n'
      + '弾は実体として飛びます。当たりにくさは「拡散」（遠いほど散る）と\n'
      + '「弾速」（動く目標への読みが外れる）の2つで決まります。',
    hint: '敵機は武装していません。落とされる心配はありません。',
    terrain: { seed: 90011, mountainAmount: 0.6, coast: 'none', valleyDepth: 0.7, rivers: 1, baseAltitude: 380 },
    weaponPoints: 0,
    noFail: true,
    friendly: {
      base: { x: 12000, z: 38000 },
      startAirborne: true,
      // **低空から始める**。掃射する的は 8km 先にあるので、4,500m から入ると
      // 降下角が30度になり、機首を突っ込ませないと届かない。1,200m なら 9度で、
      // そのまま浅く入っていける。
      startAlt: 1200,
      // ミサイルを積まない。機銃だけの戦い方を覚えてもらう
      aircraft: [{ type: 'F-1', name: 'VIPER 1', loadout: [] }],
    },
    enemy: {
      skill: 0.2,
      // **まっすぐ飛ぶ的**にする。哨戒で旋回させると機銃だけの追いかけっこが
      // 延々と続き、燃料が先に尽きる（実測で半分の試行が撃墜できずに墜落した）。
      // 「後ろに付いて撃つ」を教えるには、まっすぐ飛ぶ的のほうが素直でもある。
      // 高度も低めに置く。掃射のあと 4,500m まで登り直すと、それだけで燃料を使う。
      aircraft: [
        // 機銃も切る（`loadout: []` だけでは無害にならない。dummyFighter の注記を参照）。
        // **ここは機銃のチュートリアルなので、撃ち返されると練習にならない。**
        //
        // **戦闘機ではなく爆撃機にする**（§55）。J-7 の巡航は 220m/s で
        // F-1 とまったく同じなので、追いつくのにアフターバーナーが要り、
        // **命中まで90秒の追いかけっこ**になっていた（実測）。
        // B-9 は 165m/s。的も大きく、機銃の練習台としては素直。
        { type: 'B-9', name: 'BANDIT 1', x: 21000, z: 30000, agl: 2000,
          aiMode: 'TRANSIT', loadout: [], autoWeapons: { GUN: false }, tags: ['target'],
          moveTo: { x: 36000, z: 18000, agl: 2000 } },
      ],
      ground: [
        // 車両部隊は撃ち返してこないので掃射の練習に向く（対空砲は撃ってくる）。
        // **§67 で車両部隊に機銃が付いた**ので、ここは明示的に武装を外す ——
        // 機銃のチュートリアルで撃ち返されると練習にならない。
        { type: 'CONVOY', name: '車両部隊', x: 17000, z: 32000, tags: ['target'],
          known: true, unarmed: true },
      ],
    },
    steps: [
      { text: '機体を選択し、下のパネルに兵装が無いことを確認する',
        note: '機銃は搭載リストに出ず、枠も兵装ポイントも使いません。'
          + '**自動使用の切り替えだけは「機銃 自動」という独立したボタン**で並んでいます',
        done: 'select' },
      // 掃射を先に置く。車両部隊は動く目標なので、ブリーフィングで判明していた印は
      // 誰も見ていないと 20 秒で消える。空戦を先にやると、終わったころには
      // 地図から消えていて右クリックできない（実測でそうなった）。
      { text: '車両部隊を右クリックして攻撃を指示する',
        note: '止まっている的から始めます。地上目標は動きが読みやすく、'
          + '的も大きいので機銃がよく当たります',
        done: 'order:attack' },
      // 「破壊する」までは求めない。F-1 の弾数(380発=15秒)では、
      // 地上目標を潰し切ってから空中目標も落とすには足りない（実測）。
      // ここで教えたいのは「地上目標には当たる」ことなので、命中で足りる。
      { text: '掃射して命中させる',
        note: '当てるには 600m〜2km あたりまで降りて、浅い角度で入ること。'
          + `対地は機首から${deg(GUN_AIM_CONE_GROUND)}度まで撃てるので、多少見下ろしていても届きます`,
        check: (ctx) => { const u = unit(ctx, '車両部隊'); return !!u && u.hp < u.maxHp; } },
      { text: '敵機を右クリックして攻撃を指示する',
        note: `今度は動く的です。空の相手には機首から${deg(GUN_AIM_CONE)}度以内でしか撃てないので、`
          + '後ろに付く必要があります',
        done: 'order:attack' },
      // 地上目標と同じく、破壊までは求めない。機銃だけで対地と対空を1回ずつ
      // こなすには、戦闘出力の燃費（実測で約4倍）では F-1 の12分が足りず、
      // 撃墜寸前に「燃料残少 — 帰投」で引き返してしまう（実測で半分が未達）。
      // 教えたいのは「後ろに付けば当たる」ことなので、命中で足りる。
      { text: '敵機に命中させる',
        note: `弾は瞬時には届きません。F-1 は弾が速い（${AC('F-1').gunSpec.muzzleSpeed.toLocaleString()}m/s）ぶん`
          + '先読みの誤差が小さく、動く目標にも当たります。'
          + '当たらないときは距離を詰めてください。拡散は距離とともに広がります',
        check: (ctx) => { const u = unit(ctx, 'BANDIT 1'); return !!u && (!u.alive || u.hp < u.maxHp); } },
    ],
  },

  // ================================================================ 兵装2
  //
  // **体験させること: 向きで掴める距離が変わる**（§93.4）。正面から来る的には
  // 射程の内側でも撃てず（理由を読む）、背を向けて逃げる的には遠くから撃てる。
  // 配置は `W2`。
  {
    id: 'w2',
    group: '兵装',
    name: 'AAM-S 短距離AAM',
    title: '背中を狙う',
    brief: '赤外線で排気を追うミサイルです。コストは0で、撃ちっぱなし。\n'
      + `後ろからなら ${km(W('AAM-S').range)}km で掴めますが、排気の見えない正面からは`
      + ` ${km(W('AAM-S').irHeadRange)}km まで近づかないと掴めません。\n`
      + '同じ射程の中でも、相手の向きで撃てる距離が倍違います。',
    hint: '敵機は2機とも武装していません。',
    terrain: { seed: 90012, mountainAmount: 0.7, coast: 'none', valleyDepth: 0.8, rivers: 2, baseAltitude: 400 },
    weaponPoints: 0,
    noFail: true,
    friendly: {
      base: W2.base,
      startAirborne: true,
      startAlt: 5000,
      // 自動発射を切る（§49）。入れたままだと、プレイヤーが兵装を指定する前に
      // AI が撃って的を落としてしまい、以降の手順が起こせなくなる。
      aircraft: [{ type: 'F-1', name: 'VIPER 1', ...W2.viper, loadout: ['AAM-S', 'AAM-S', 'AAM-S'],
        autoWeapons: { 'AAM-S': false, GUN: false } }],
    },
    enemy: {
      skill: 0.2,
      aircraft: [
        dummyFighter('BANDIT 1', W2.head.x, W2.head.z, 5000,
          { aiMode: 'TRANSIT', moveTo: { ...W2.headTo, agl: 5000 },
            heading: headingOf(W2.headTo.x - W2.head.x, W2.headTo.z - W2.head.z) }),
        { type: 'B-9', name: 'BANDIT 2', ...W2.tail, agl: 5000,
          aiMode: 'TRANSIT', loadout: [], autoWeapons: { GUN: false }, tags: ['target'],
          moveTo: { ...W2.tailTo, agl: 5000 },
          heading: headingOf(W2.tailTo.x - W2.tail.x, W2.tailTo.z - W2.tail.z) },
      ],
      ground: [],
    },
    steps: [
      { text: '逃げていく BANDIT 2 に攻撃を指示し、使用兵装に AAM-S を指定する',
        note: '流れは基本2「空対空」と同じです（攻撃指示が先）。'
          + '機体は BANDIT 2 を追って北東へ向かい、正面から来る BANDIT 1 と途中ですれ違います',
        pause: true, highlight: '[data-pick="AAM-S"]',
        check: (ctx) => attackWith('AAM-S')(ctx) || firedOrSpent('AAM-S')(ctx) },
      // BANDIT 1 には攻撃指示を出さない。機体はもう北東へ向かっているので、
      // 射撃指示だけで正面から出会う（W2 の注記）。
      { text: '正面から来る BANDIT 1 を右クリックして射撃指示を出す',
        note: 'BANDIT 1 はこちらへまっすぐ向かってきます。攻撃目標は BANDIT 2 のまま、'
          + '射撃指示だけを BANDIT 1 に出しておきます',
        pause: true,
        check: (ctx) => hasFireTask(ctx, 'AAM-S', 'BANDIT 1') || firedOrSpent('AAM-S')(ctx) },
      // 射程の内側で、正面からは掴めない距離（`combat.js` の `fireBlockReason`・§93.12 で足した理由）。
      // 閉じる速さは 500m/s 近いので窓は約10秒（8.9km で変わり、放っておくと 4.0km で撃つ）——
      // 入った瞬間に次の手順で止める。
      //
      // **すれ違ったあとでも詰まらせない。** 手順1の前に長く待つと、射撃指示を出す前に BANDIT 1 が
      // 後ろへ抜ける。背後の相手への指示は「射角外」のまま撃たず、弾も減らないので、
      // こちらが BANDIT 1 の後ろ半分に入ったら（`aspectOf` が 0.5 を超えたら）先へ進める。
      { text: '射撃指示の横の理由が「射程外」から変わるのを待つ',
        note: '射程に入っても、すぐには撃ちません',
        check: (ctx) => {
          if (/^熱を掴めない/.test(fireReason(ctx, 'AAM-S', 'BANDIT 1') || '')) return true;
          const b = unit(ctx, 'BANDIT 1');
          return !b || !b.alive || mine(ctx).some((u) => aspectOf(u, b) > 0.5)
            || firedOrSpent('AAM-S')(ctx);
        } },
      { text: '理由を読み、「取消」で取り下げる',
        note: '**正面からは排気が見えないので、射程の内側でも'
          + ` ${km(W('AAM-S').irHeadRange)}km まで掴めません。**`
          + 'すれ違う相手は見送り、背中を見せている BANDIT 2 を狙います',
        pause: true, highlight: '.task-row',
        check: (ctx) => {
          const has = hasFireTask(ctx, 'AAM-S');
          if (has) ctx.mem.had = true;
          return (!!ctx.mem.had && !has) || firedOrSpent('AAM-S')(ctx);
        } },
      // **指示と発射を分ける**（§98）。1つの手順で「右クリック」と「発射」を待つと、
      // 右クリックが射撃指示にならなかったとき（兵装の指定が外れていた）に何も起きず、
      // 何を待てばよいか分からないまま止まっていた。指定は機体の選択を外すと解除される
      // （`commands.js` の select）—— 敵機を選んで「熱」を見ると外れる。
      // 自動発射は切ってあるので、攻撃指示だけでは撃たない。
      { text: 'AAM-S を指定したまま、BANDIT 2 を右クリックして射撃指示を出す',
        note: '射撃指示が出ると、機体のパネルの「射撃指示」の行に「AAM-S → BANDIT 2」が出ます。'
          + '**機体の選択を外すと兵装の指定も外れます** —— 光っていたら、自機を選んで AAM-S を押し直してください',
        highlight: '[data-pick="AAM-S"]:not(.picked)',
        check: (ctx) => hasFireTask(ctx, 'AAM-S', 'BANDIT 2') || spentAll('AAM-S')(ctx) },
      { text: 'AAM-S の発射を待ち、撃つ距離を見る',
        note: `背中からは排気が見えるので、${km(W('AAM-S').range)}km 手前から掴めます —— 正面の倍です。`
          + '掴める距離は**相手の熱**でも変わります（敵機を選ぶと下のパネルに「熱」が出ます）。'
          + 'アフターバーナーを焚いた相手は遠くから、推力を絞った相手は近くまで掴めません',
        done: 'fire', when: (d) => d.weapon === 'AAM-S' && d.target && d.target.name === 'BANDIT 2',
        check: spentAll('AAM-S') },
      { text: 'BANDIT 2 を撃墜する',
        note: '撃ちっぱなしなので、撃った瞬間に離れても当たります。'
          + 'フレアを撒かれると外れますが、コスト0なので何発でも撃てます',
        check: (ctx) => {
          const u = unit(ctx, 'BANDIT 2');
          return (!!u && !u.alive) || spentAll('AAM-S')(ctx);
        } },
    ],
  },

  // ================================================================ 兵装3
  //
  // **体験させること: 誘導中に背を向けると外れる**（§93.4）。撃ってから移動で背を向けさせ、
  // 照射が切れて外れるのを見せる → 攻撃し直して、今度は誘導を続けて落とす。
  //
  // **的は手動にして回避させない**（§93.12・プレイヤーの決め）。基本2（t4）と同じ回避する的
  // （`dummyFighter`）は AAM-M を 0/27 でかわした（§93.10）。それでは「照射を保てば当たる」と
  // 「背を向けたら外れた」の差が見えない。手動の機体は回避しない（`aircraft.js` の `_evade` を
  // 呼ばない）。**チャフは効く向きのときだけ撒く**（§46・§94 —— 照射源に背を向けるか真横のとき）。
  // この的は照射源（自機）へ向かって飛ぶので門が開かず、通し3回とも0枚（§94.5）。
  //
  // 2発目は**期待度「高」まで待たせる**。射程の縁ですぐ撃つと、回避しない的にも外れた
  // （最接近 851m・1/1）。「高」まで待った2回は2回とも当たった（最接近 38m・45m）。
  {
    id: 'w3',
    group: '兵装',
    name: 'AAM-M 中距離AAM',
    title: '誘導し続ける覚悟',
    brief: `射程${km(W('AAM-M').range)}km。遠くから撃てますが、**着弾まで自分のレーダーで目標を照らし続ける**\n`
      + '必要があります。照らしているあいだ、機体は敵を扇に入れたまま飛び続けます。\n'
      + `コストは${W('AAM-M').cost}。誘導を続けるか身を守るか —— この判断が中距離戦の中心になります。`,
    hint: '敵機は武装しておらず、回避もしません。誘導を切らさない練習に集中してください。',
    terrain: { seed: 90013, mountainAmount: 0.6, coast: 'none', valleyDepth: 0.7, rivers: 2, baseAltitude: 400 },
    weaponPoints: 12,
    noFail: true,
    friendly: {
      base: { x: 11000, z: 40000 },
      startAirborne: true,
      startAlt: 6000,
      // 自動発射を切る（§49）。§38 以降 AI は 19km から撃つので、
      // 入れたままだと指定の手順に着く前に3発とも無くなる（実測 18.7km で1発目）。
      aircraft: [{ type: 'F-1', name: 'VIPER 1', loadout: ['AAM-M', 'AAM-M', 'AAM-M'],
        autoWeapons: { 'AAM-M': false, GUN: false } }],
    },
    enemy: {
      skill: 0.2,
      aircraft: [dummyFighter('BANDIT 1', 30000, 22000, 6000, { aiMode: 'MANUAL' })],
      ground: [],
    },
    steps: [
      { text: '敵機に攻撃を指示し、使用兵装に AAM-M を指定する',
        note: '流れは基本2「空対空」と同じです（攻撃指示が先）。'
          + 'このチュートリアルでは自動発射を切ってあります',
        pause: true, highlight: '[data-pick="AAM-M"]',
        check: (ctx) => attackWith('AAM-M')(ctx) || firedOrSpent('AAM-M')(ctx) },
      { text: '射撃指示を出して AAM-M を撃つ',
        note: 'この1発は、わざと外します',
        done: 'fire', when: (d) => d.weapon === 'AAM-M',
        check: firedOrSpent('AAM-M') },
      { text: '誘導中に、敵から離れる向きへ移動を指示する',
        note: '時間を止めてあります。敵と反対側の地面を右クリックしてください',
        pause: true,
        done: 'order:move',
        check: (ctx) => destroyed(ctx, 'BANDIT 1') || spentAll('AAM-M')(ctx) },
      // 照射が切れてから2秒で誘導を失う（`missile.js` の `SARH_COAST_SEC`）。
      // 失った弾はしばらく直進してから自壊するので、`lost` の立った弾を探す。
      { text: '誘導が切れて、ミサイルが外れるのを見る',
        note: '**扇から敵が外れると、照射が切れます。** 数秒は慣性で飛びますが、戻らなければそこで終わりです。'
          + '撃ちっぱなしの AAM-S・AAM-A との違いはここです',
        check: (ctx) => destroyed(ctx, 'BANDIT 1')
          || ctx.world.missiles.some((m) => m.side === ctx.world.playerSide
            && m.weapon.id === 'AAM-M' && m.lost)
          || spentAll('AAM-M')(ctx) },
      { text: 'もう一度攻撃を指示し、期待度が「高」になってから撃つ',
        note: '**指定したままだと右クリックは射撃指示になります** —— チップをもう一度押して指定を外してから攻撃を指示し、指定し直します。'
          + '撃ったら攻撃指示のままに。機体は敵を扇に入れたまま斜めに飛びます（クランク）。左右だけでなく上下も扇の内側に保ちます',
        done: 'fire', when: (d) => d.weapon === 'AAM-M',
        check: (ctx) => destroyed(ctx, 'BANDIT 1') || spentAll('AAM-M')(ctx) },
      { text: '「誘導中も回避／誘導を優先」を切り替えてみる',
        note: '撃たれたときに、誘導を続けるか身を守るかの選択です。'
          + '回避に入れば照射は切れ、いま飛んでいる弾はさっきのように外れます',
        done: 'guard', pause: true, highlight: '[data-guard]' },
      { text: '敵機を撃墜する',
        note: '外れたら、残りの1発で撃ち直してください。本物の敵は撃たれた瞬間からかわします（基本2で見たとおり）。'
          + '**撃った機体が落とされると誘導も止まるので、全機を失ったあとの「最後の一撃」にはなれません**',
        check: (ctx) => destroyed(ctx, 'BANDIT 1') || spentAll('AAM-M')(ctx) },
    ],
  },

  // ================================================================ 兵装4
  //
  // **体験させること: 黙ったまま撃つ**（§93.4）。自機はレーダー常時OFF、敵を照らすのは
  // 前に出した僚機（常時ON・丸腰）。データリンク（§89.5）で撃って、すぐ背を向ける。
  // 撃った弾は残り `activeRange` まで陣営の誰かの照射で進路を直す（`missile.js` の
  // `_midcourseFix`）ので、**背を向けた自機ではなく僚機が導き続ける**。
  //
  // 僚機は的から 11km —— 哨戒のまま敵へ向かう距離に置く。機首が敵を向き続けるので、
  // 扇に入れっぱなしになる。武装は無く、機銃の自動使用も切ってある。
  //
  // **的は w3 と同じく手動にして回避させない**（§93.12・プレイヤーの決め）。
  // 回避する的（`dummyFighter` の哨戒）には 0/6 —— 警報は弾が自分のレーダーを入れた瞬間に出て、
  // そこからの回避で外れた（誘導を失ったもの2・失わずに外れたもの4）。
  // **AAM-M（0/27・§93.10）より避けにくいとは言えない**ので、文にも書かない（§93.9 で保留した比較）。
  // 的は警報が出てからの 10.9秒のうち 9.1秒、弾に対して効く向き（背を向けるか真横）にいて、
  // **チャフを3枚撒く**（§94.5）。
  // 撒かない場合と発射・命中・最接近（47m）まで同じなので、`autoDecoy` は切っていない。
  {
    id: 'w4',
    group: '兵装',
    name: 'AAM-A アクティブAAM',
    title: '黙って撃つ',
    brief: '自分でレーダーを持つミサイルです。撃った瞬間に離脱できます。\n'
      + '**僚機が照らしている敵なら、自分は電波を出さずに撃てます**（データリンク）。\n'
      + `ただしコスト${W('AAM-A').cost}。`
      + `中距離AAM ${W('AAM-A').cost / W('AAM-M').cost}発ぶんの値段です。`,
    hint: '敵機は武装しておらず、回避もしません。',
    terrain: { seed: 90014, mountainAmount: 0.6, coast: 'none', valleyDepth: 0.7, rivers: 2, baseAltitude: 400 },
    weaponPoints: 12,
    noFail: true,
    friendly: {
      base: { x: 11000, z: 40000 },
      startAirborne: true,
      startAlt: 6000,
      // 自動発射を切る（§49）。2発しか積めないので、AI に先に撃たれると
      // 手順「AAM-A を発射する」が二度と起こせない（実測で行き止まりを確認）。
      aircraft: [
        { type: 'F-1', name: 'VIPER 1', loadout: ['AAM-A', 'AAM-A'],
          radarMode: 'off', autoWeapons: { 'AAM-A': false, GUN: false } },
        { type: 'F-1', name: 'VIPER 2', x: 22000, z: 30000, loadout: [],
          radarMode: 'on', autoWeapons: { GUN: false } },
      ],
    },
    enemy: {
      skill: 0.2,
      aircraft: [dummyFighter('BANDIT 1', 30000, 22000, 6000, { aiMode: 'MANUAL' })],
      ground: [],
    },
    steps: [
      { text: 'VIPER 1 を選び、レーダーが「常時OFF」なのを確かめる',
        note: 'VIPER 1 は電波を出していません（下のパネルのレーダー欄）。'
          + '地図の敵を捉えているのは、前に出ている僚機 VIPER 2 のレーダーです',
        check: (ctx) => ctx.commands.selection.some((u) => u.name === 'VIPER 1') },
      { text: 'VIPER 1 で敵機に攻撃を指示し、使用兵装に AAM-A を指定する',
        note: '流れは基本2「空対空」と同じです。レーダーは切ったままにします',
        pause: true, highlight: '[data-pick="AAM-A"]',
        check: (ctx) => attackWith('AAM-A')(ctx) || firedOrSpent('AAM-A')(ctx) },
      { text: 'レーダーを切ったまま、期待度が「高」になってから撃つ',
        note: '**僚機が扇に捉えている敵には、自分が黙ったまま撃てます**（データリンク）。'
          + '僚機が捉えていなければ、理由に「レーダー沈黙」と出ます',
        done: 'fire', when: (d) => d.weapon === 'AAM-A' && d.shooter.radarMode === 'off',
        check: spentAll('AAM-A') },
      { text: '撃ったらすぐ、敵から離れる向きへ移動を指示する',
        note: '時間を止めてあります。AAM-M ならここで外れます —— 今度はどうなるかを見ます',
        pause: true,
        done: 'order:move',
        check: (ctx) => destroyed(ctx, 'BANDIT 1') || spentAll('AAM-A')(ctx) },
      // 「撃墜」までは求めない。2発しか積めない兵装なので、外れ続けると行き止まりになる。
      // ここで見せたいのは**背を向けても誘導が続いていること**なので、命中で足りる。
      { text: '離れたまま、ミサイルが当たるのを見届ける',
        note: `途中は僚機のレーダーが進路を直し、残り ${km(W('AAM-A').activeRange)}km で弾が自分のレーダーを入れます。`
          + '**相手に警報が出るのはそこから**です。この的は回避しませんが、本物の敵はそこからかわします',
        check: (ctx) => {
          const u = unit(ctx, 'BANDIT 1');
          return (!!u && (!u.alive || u.hp < u.maxHp)) || spentAll('AAM-A')(ctx);
        } },
    ],
  },

  // ================================================================ 兵装5
  //
  // **体験させること: 対空砲の外から撃って、すぐ引き返す**（§93.4・対空砲はプレイヤーの決め）。
  // 配置は `W5`。
  //
  // **対空砲は実際には撃ってこない**（§93.12 で測った）。パイロットは知っている対空砲・赤外線SAM の
  // 射程に近づくと、射高の上へ自分で上がる（`ai/pilot.js` の `_gunFloor`・§68.2）。AGM を消して
  // 外させた通しでは、攻撃指示のまま対空砲まで 1.8km に寄ったが、そのあいだ高度 1,700〜1,900m で
  // 一度も撃たれなかった。1,000m で始めても同じ（上がるのはプレイヤーが高度を指示していないときだけ ——
  // `commandedAlt` があれば上がらない）。**引き返す手順は撃ちっぱなしを見せるために残し**、
  // 文は「撃たれる」とは言わない。上がって越える動きは、どの本も教えていなかったので補足で言う。
  {
    id: 'w5',
    group: '兵装',
    name: 'AGM 空対地ミサイル',
    title: '射程の外から叩く',
    brief: `地上目標を対空砲の外から撃つためのミサイルです。射程${km(W('AGM').range)}km、撃ちっぱなし。\n`
      + '高度を上げても射程はあまり伸びません（対レーダーミサイルとの違い）。\n'
      + `コスト${W('AGM').cost}。対地攻撃の主力になります。`,
    hint: '目標の手前に対空砲がいます。',
    terrain: { seed: 90015, mountainAmount: 0.3, coast: 'none', valleyDepth: 0.5, rivers: 2, baseAltitude: 420 },
    weaponPoints: 20,
    noFail: true,
    friendly: {
      base: W5.base,
      startAirborne: true,
      startAlt: 1000,
      // 自動発射を切る（§49）。入れたままだと、指定の手順に着く前に
      // AI が2発とも撃ってしまい、手順「AGM を発射する」が起こせなくなる。
      aircraft: [{ type: 'A-3', name: 'ANVIL 1', loadout: ['AGM', 'AGM'],
        autoWeapons: { AGM: false, GUN: false } }],
    },
    enemy: {
      aircraft: [],
      ground: [
        { type: 'RADAR', name: 'レーダーサイト', ...W5.site, tags: ['target'], known: true },
        { type: 'AAA', name: '対空砲', ...W5.aaa, known: true },
      ],
    },
    steps: [
      { text: 'レーダーサイトに攻撃を指示し、使用兵装に AGM を指定する',
        note: '流れは基本2「空対空」と同じです（攻撃指示が先）。'
          + '目標も対空砲もブリーフィングで判明していたので、最初から地図に出ています',
        pause: true, highlight: '[data-pick="AGM"]',
        check: (ctx) => attackWith('AGM')(ctx) || firedOrSpent('AGM')(ctx) },
      { text: '射撃指示を出して、対空砲の射程の外で AGM を撃つ',
        note: `対空砲の射程は ${km(W5_AAA.range)}km。AGM はその外から届きます`,
        done: 'fire', when: (d) => d.weapon === 'AGM',
        check: firedOrSpent('AGM') },
      { text: '撃ったらすぐ、対空砲から離れる向きへ移動を指示する',
        note: '時間を止めてあります。撃ちっぱなしなので、背を向けても弾は当たりに行きます。'
          + `攻撃指示のままだと機体は目標へ近づき続けます。高度を指示していなければ、対空砲の上は射高（${W5_AAA.maxAlt.toLocaleString()}m）の上へ自分で上がって越えます —— `
          + '越えられても、寄る理由はありません',
        pause: true,
        done: 'order:move',
        check: (ctx) => destroyed(ctx, 'レーダーサイト') || spentAll('AGM')(ctx) },
      { text: '目標を破壊する',
        note: `**至近弾でも効きます**（爆風 ${W('AGM').blastRadius}m）。`
          + '多少ずれても無駄弾にならないのが、遠くから撃つ兵装の取り柄です',
        check: (ctx) => destroyed(ctx, 'レーダーサイト') || spentAll('AGM')(ctx) },
    ],
  },

  // ================================================================ 兵装6
  //
  // **体験させること: 高く上がって、電波を出している目標を遠くから撃つ。**
  //
  // §93.4 の叩き台は「撃つと相手が電波を止めるのを見る」だったが、**レーダーサイトは止めない**
  // （§93.12）。止める処理は SAM の発射処理（`sim/ground.js` の `_updateSam`）の中にしかなく、
  // 発射台を持たないサイトでは回らない（通し2回とも最後まで `emitting`）。
  // SAM を的にすると ARM より遠くから撃たれるので、手順を外して文で伝えることにした（プレイヤーの決め）。
  {
    id: 'w6',
    group: '兵装',
    // 選択画面のカード名。長いと2行に折り返して並びが崩れるので短く置く。
    // 正式名は title と brief にある。
    name: 'ARM 対レーダー',
    title: '電波を追う',
    brief: `稼働中のレーダーにだけ誘導します。射程${km(W('ARM').range)}kmで、高度を上げるほど伸びます。\n`
      + `低空からは撃てません（高度${W('ARM').minLaunchAlt.toLocaleString()}m以上が必要）。\n`
      + '相手がレーダーを止めると誘導が切れ、最後に掴んだ座標へ慣性で飛びます。',
    hint: '目標は撃ち返してきません。沈黙もしません。',
    terrain: { seed: 90016, mountainAmount: 0.9, coast: 'none', valleyDepth: 0.9, rivers: 2, baseAltitude: 450 },
    weaponPoints: 20,
    noFail: true,
    friendly: {
      base: { x: 10000, z: 42000 },
      startAirborne: true,
      startAlt: 3000,
      aircraft: [{ type: 'F-2', name: 'HAMMER 1', loadout: ['ARM', 'ARM'],
        autoWeapons: { ARM: false, GUN: false } }],
    },
    enemy: {
      aircraft: [],
      ground: [
        { type: 'RADAR', name: 'レーダーサイト', x: 32000, z: 24000, tags: ['target'], known: true },
      ],
    },
    steps: [
      { text: '高度を「高々度」（7,000 m）まで上げる',
        note: `${W('ARM').minLaunchAlt.toLocaleString()}m 未満では撃てません。高いほど射程が伸びるので、`
          + 'SAM の外から一方的に叩くには高度が要ります',
        highlight: '[data-alt="7000"]',
        check: (ctx) => mine(ctx).some((u) => u.pos.y >= 6500) },
      { text: 'レーダーサイトに攻撃を指示し、使用兵装に ARM を指定する',
        note: '流れは基本2「空対空」と同じです（攻撃指示が先）',
        pause: true, highlight: '[data-pick="ARM"]',
        check: (ctx) => attackWith('ARM')(ctx) || firedOrSpent('ARM')(ctx) },
      { text: '射撃指示を出して ARM を撃つ',
        note: '電波を出している目標にしか誘導しません。'
          + '黙っている相手には撃てず、理由に「電波なし」と出ます',
        done: 'fire', when: (d) => d.weapon === 'ARM',
        check: firedOrSpent('ARM') },
      { text: '目標を破壊する',
        note: `**SAM は ARM が ${km(ARM_NOTICE_RANGE)}km まで来ると電波を止めます**（このサイトは止めません）。`
          + '誘導が切れても弾は最後の座標へ飛び、止まっているあいだは SAM も撃てません —— 黙らせるだけでも戦果です',
        check: (ctx) => destroyed(ctx, 'レーダーサイト') || spentAll('ARM')(ctx) },
    ],
  },

  // ================================================================ 兵装7
  {
    id: 'w7',
    group: '兵装',
    name: 'BOMB 無誘導爆弾',
    title: '真上を通る',
    brief: `コスト0で威力は最大（${W('BOMB').damage}）。ただし誘導しません。\n`
      + '目標の真上を通って落とす必要があり、投下高度が高いほど散らばります。\n'
      + '（兵装パネルの「爆撃 トス」にすると、手前から投げ上げて上を通らずに引き返します）\n'
      + '安く数を積めるので、飛行場のような大きく硬い目標に向いています。',
    hint: '目標は撃ち返してきません。',
    terrain: { seed: 90017, mountainAmount: 0.7, coast: 'none', valleyDepth: 0.7, rivers: 2, baseAltitude: 400 },
    weaponPoints: 0,
    noFail: true,
    friendly: {
      base: { x: 11000, z: 40000 },
      startAirborne: true,
      startAlt: 3000,
      // 自動発射を切る（§49）。爆弾は目標の真上まで行かないと落ちないぶん
      // 猶予はあるが、放っておけば AI が4発とも落としてしまう。
      aircraft: [{ type: 'A-3', name: 'ANVIL 1', loadout: ['BOMB', 'BOMB', 'BOMB', 'BOMB'],
        autoWeapons: { BOMB: false, GUN: false } }],
    },
    enemy: {
      aircraft: [],
      ground: [
        { type: 'RADAR', name: 'レーダーサイト', x: 26000, z: 28000, tags: ['target'], known: true },
      ],
    },
    steps: [
      { text: '目標に攻撃を指示し、使用兵装に BOMB を指定する',
        note: '流れは基本2「空対空」と同じです（攻撃指示が先）。'
          + 'コスト0で、兵装ポイントを一切使いません',
        pause: true, highlight: '[data-pick="BOMB"]',
        check: (ctx) => attackWith('BOMB')(ctx) || firedOrSpent('BOMB')(ctx) },
      { text: '投下指示を出して、爆弾を落とす',
        note: '兵装を指定した状態で目標を右クリックすると投下指示になります。'
          + '投下点は弾道から自動で決まり、目標の手前で自然に離れます',
        done: 'fire', when: (d) => d.weapon === 'BOMB',
        check: (ctx) => mine(ctx).length > 0
          && mine(ctx).every((u) => !u.loadout.includes('BOMB')) },
      { text: '目標を破壊する',
        note: '**外れたら、もう一度投下指示を出します** —— 自動使用を切ってあるので、機体は自分では落としません。'
          + '高い所から落とすほど散らばるので、当てたければ低く入ることです',
        check: (ctx) => destroyed(ctx, 'レーダーサイト') || spentAll('BOMB')(ctx) },
    ],
  },

  // ================================================================ 兵装8
  {
    id: 'w8',
    group: '兵装',
    name: 'TANK 増槽',
    title: '足を伸ばす',
    brief: `武器ではありませんが、中型の枠を1本使う搭載品です。燃料が${pct(W('TANK').fuelBonus)}%増えます。\n`
      + 'コストは0。遠くの目標を叩くとき、往復できるかどうかを決めます。\n'
      + '対地兵装と同じ太さなので、そのぶん兵装を諦めることになります。',
    hint: '敵はいません。搭載と燃料の関係だけを見ます。',
    terrain: { seed: 90018, mountainAmount: 0.6, coast: 'none', valleyDepth: 0.7, rivers: 1, baseAltitude: 380 },
    weaponPoints: 10,
    noFail: true,
    friendly: {
      base: { x: 12000, z: 38000 },
      startAirborne: false,
      aircraft: [{ type: 'F-1', name: 'VIPER 1', loadout: ['AAM-S', 'AAM-S'] }],
    },
    enemy: { aircraft: [], ground: [] },
    steps: [
      { text: '機体を選択し、いまの燃料の持ち時間を確認する',
        note: `下のパネルに「燃料 ○分」と出ます。F-1 は無積載で${Math.round(AC('F-1').fuelSeconds / 60)}分です`,
        done: 'select' },
      { text: '搭載に TANK を足す',
        note: '下のパネルの「+TANK」。整備が終わると燃料の上限が増えます',
        done: 'loadout', pause: true, highlight: '[data-load-add="TANK"]' },
      { text: '整備を終えて、燃料の持ち時間が増えたことを確認する',
        note: `燃料 +${pct(W('TANK').fuelBonus)}%。中型の枠が1本埋まり、機動性もわずかに落ちます`,
        check: (ctx) => mine(ctx).some((u) => u.loadout.includes('TANK')
          && u.fuelMax > u.spec.fuelSeconds * 1.2) },
      { text: '発進する',
        note: '進出距離の長い任務では、増槽を積むか、途中で帰投して給油するかの'
          + '選択になります',
        done: 'takeoff', highlight: '[data-cmd="launch"]' },
      { text: '増槽を投棄する',
        note: '**「投棄」は飛んでいる機体のパネルにしか出ません。** '
          + '離陸して滑走路を離れると、兵装の欄の並びに現れます。\n'
          + '中身が残っていても、いま落とせます。**旋回率と燃費が戻ります** — '
          + '交戦に入る直前に落とすのが基本です。'
          + '「増槽 自動」にしておけば、使い切った時点で自分で落とします。'
          + '「保持」なら持ち帰るので、付け直す手間が要りません',
        pause: true, highlight: '[data-tankdrop]',
        check: (ctx) => mine(ctx).some((u) => !u.loadout.includes('TANK')) },
    ],
  },

  // ================================================================ 詳細1
  //
  // **3つ目の群（§60.2）。** AIモードは7つあるのに、手順があるのは
  // 連携（t5）と回避優先（t8）の2つだけだった。残り5つは名前すら出てこない。
  // 基本の本に足すと1本が重くなるので、踏み込んだ仕組みを置く群を立てた。
  //
  // **§93.13 で一覧から外した。** 詳細は読む資料になり、x1 は資料「AIモード」の
  // 「試す」から開く案内つきの場（`listed: false`・受講済みの数に入らない）。
  {
    id: 'x1',
    group: '詳細',
    listed: false,
    name: 'AIモード',
    title: '任せ方を七つから選ぶ',
    brief: '機体は放っておいても自分で戦います。\n'
      + 'AIモードは「何を優先するか」の指定で、7つあります。\n'
      + '守りたい空域があるのか、追い回したいのか、手放したくないのか。',
    hint: '敵機は武装していません。どのモードにしても落とされることはありません。',
    terrain: { seed: 90009, mountainAmount: 0.8, coast: 'none', valleyDepth: 0.9, rivers: 2, baseAltitude: 420 },
    weaponPoints: 0,
    noFail: true,
    friendly: {
      base: { x: 11000, z: 38000 },
      startAirborne: true,
      startAlt: 5200,
      // **2機置く。** 随伴と護衛は「守る相手」が要る。
      // 自動発射は切る（§49.1）—— 弾を撃ち尽くして手順が進まなくなるのを避ける。
      aircraft: [
        { type: 'F-1', name: 'VIPER 1', loadout: ['AAM-M', 'AAM-S'],
          autoWeapons: { 'AAM-M': false, 'AAM-S': false, GUN: false } },
        { type: 'A-3', name: 'ANVIL 1', loadout: ['AGM', 'AGM'],
          autoWeapons: { AGM: false, GUN: false } },
      ],
    },
    enemy: {
      skill: 0.2,
      // **26km 以内に置く。** 回避優先は「探知している敵が 26km 以内」で
      // 初めて退避を始める。外に置くと、押しても何も起きないまま次へ進む。
      aircraft: [dummyFighter('BANDIT 1', 30000, 26000, 5200)],
      // 対地攻撃モードの行き先。ブリーフィングで判明させておく
      ground: [
        { type: 'RADAR', name: 'レーダーサイト', x: 34000, z: 31000, tags: [], known: true },
      ],
    },
    steps: [
      { text: '機体を選択し、下のパネルの「AI」の欄を見る',
        note: '**哨戒・追撃・連携・回避優先・護衛・対地攻撃・手動** の7つ。'
          + '光っているのがいまのモードです。\n'
          + 'この本では**7つ全部を順に切り替えます**。'
          + 'まず1機で完結する3つ（哨戒・追撃・回避優先）、'
          + '次に相手が要る2つ（随伴→護衛）、役割の1つ（対地攻撃）、'
          + '任せない1つ（手動）、最後に連携へ戻ります',
        done: 'select' },

      { text: 'AIモードを「哨戒」にする',
        note: `**いまいる場所を中心に旋回して索敵し、${km(ENGAGE_RANGE.PATROL)}km 以内に入った敵だけ迎え撃ちます。**`
          + '交戦距離が7つのなかでいちばん短く、深追いしません。'
          + '中心はモードを選んだ時点の位置なので、**先に置きたい場所へ動かしてから**選びます。'
          + '守りたい空域があるとき、増援を待ち受けるときに使います',
        done: 'aimode', when: (d) => d.mode === 'PATROL' },

      { text: 'AIモードを「追撃」にする',
        note: `**探知した敵へ ${km(ENGAGE_RANGE.PURSUIT)}km 先まで積極的に向かいます。**`
          + '哨戒との違いは踏み込む距離だけで、交戦の仕方は同じです。'
          + '逃がしたくないときに効きますが、'
          + '**深追いして燃料を使い切ることがあります** — 燃料の見張りはAIがしますが、'
          + '帰る距離まで計算はしません',
        done: 'aimode', when: (d) => d.mode === 'PURSUIT' },

      { text: 'AIモードを「回避優先」にする',
        note: '**交戦を避けて低空へ退避します。**'
          + '**逃げる先は「敵から離れる方向」ではなく自軍飛行場です** — '
          + '離れる方向へ逃がすと帰る場所の概念が無く、地図の端に張り付いて終わります。\n'
          + `動き出すのは**探知している敵が ${km(EVADE_RANGE)}km 以内にいるとき**。`
          + '勝てない場面から機体を持ち帰るのも指揮官の仕事です。'
          + '早期警戒機のような、戦わせたくない機体の既定でもあります',
        done: 'aimode', when: (d) => d.mode === 'EVADE' },

      { text: 'VIPER 1 を選び、ANVIL 1 を右クリックして随伴させる',
        note: '**随伴（follow）はモードではなく指示です。** '
          + '相手の後ろ側に位置を取って付いていき、追い抜かないよう速度を合わせます。'
          + '**それだけで、敵を迎えに行くことはしません。**'
          + 'このあと護衛モードにするので、いまは付けるだけです',
        done: 'order:follow' },

      { text: 'そのまま VIPER 1 のAIモードを「護衛」にする',
        note: '**ここが随伴との違いです。** 護衛は付いていくだけでなく、'
          + `**守る相手の ${km(ENGAGE_RANGE.ESCORT)}km 以内に入った敵機を、こちらから迎えに行きます。**`
          + '距離を測る基準が**自分ではなく守る相手**なのがこのモードだけの特徴です。\n'
          + `敵の中距離AAMの射程は ${km(W('AAM-M').range)}km。`
          + 'それより外で動き出さないと必ず撃たれたあとになります。\n'
          + '**守る相手は「随伴している相手」です。** 随伴の指示が無いと哨戒に戻ります',
        done: 'aimode', when: (d) => d.mode === 'ESCORT' },

      { text: 'ANVIL 1 のAIモードを「対地攻撃」にする',
        note: '見えている地上目標へ進撃します。'
          + `**SAM の圏（${km(SAM_AVOID_RANGE)}km）に入ると自分から対地 ${STRIKE_LOW_AGL}m へ降りて**電波から隠れますが、`
          + `**対レーダーミサイル(ARM)を積んでいるときだけは逆に ${ARM_STANDOFF_ALT.toLocaleString('en-US')}m まで上げます** — `
          + 'ARM は高いほど射程が伸びて、SAM の外から撃てるからです。\n'
          + 'ただし**対空砲は逆で、降りるほど当たります**。'
          + '射高が分かっている砲の圏に入りそうなときは、その上を通る高さまで自分で上げます。\n'
          + '**降りても隠れない相手もいます** — 赤外線SAM は電波を出さないので'
          + `逆探知に映らず、ARM も誘導しません。射程${km(K1_SAM.range)}km・射高${K1_SAM.maxAlt.toLocaleString('en-US')}m と短いぶん、`
          + '避けるなら**上を通る**ことになります',
        done: 'aimode', when: (d) => d.mode === 'STRIKE' },

      { text: 'AIモードを「手動」にする',
        note: '**自分では何もしません。** 目標も選ばず、飛んでくるミサイルを避けず、'
          + '燃料が尽きても帰りません。出した指示だけで動きます。\n'
          + '**兵装とデコイの自動使用の設定には従います** — '
          + '「撃つな」「ここを飛べ」を厳密に守らせたいときのモードで、'
          + '**放っておくモードではありません**',
        done: 'aimode', when: (d) => d.mode === 'MANUAL' },

      { text: '最後に、AIモードを「連携」に戻す',
        note: '**手動のままにしないこと。** ミサイルが飛んできても避けません。\n'
          + `連携の交戦距離は追撃と同じ ${km(ENGAGE_RANGE.COORDINATE)}km で、違いは**編隊で仕事を分けること**です — `
          + '機首の向きを役割ごとにずらして**レーダーの扇を左右に分担**し、'
          + '広く探します。狙いは近い敵ほど重なってもかまわず、'
          + '**撃ちすぎは弾の側で止めます**（味方の弾で落とし切れる見込みなら次を撃たない）。\n'
          + '**編隊を組んでいないと分担する相手がいない**ので、'
          + '単機では追撃に近い動きになります。編隊の組み方は「任せ方」で扱っています。'
          + '迷ったらここに戻しておけば大きく外しません',
        done: 'aimode', when: (d) => d.mode === 'COORDINATE' },
    ],
  },

  // ================================================================ 詳細2
  //
  // **3機の違いを1本にまとめる**（§63）。速度も旋回も個別のチュートリアルで
  // 触れているが、**3機を並べて比べる場所がどこにも無かった。**
  // 詳細は「引くための本」なので、重なりを避けずに数字ごと収める。
  {
    id: 'x2',
    group: '詳細',
    // 資料「3機の違い」の「試す」から開く（§93.13）
    listed: false,
    name: '3機の違い',
    title: '何を選ぶかで何が変わるか',
    brief: 'F-1・F-2・A-3 は、速さ／電波／持久 を1つずつ受け持っています。\n'
      + 'どれかが強いのではなく、得意な場面と払う代償が違います。\n'
      + '3機を並べて、取り分と代償を1つずつ確かめます。',
    hint: '敵機は武装していません。3機とも標準的な搭載を積んでいます。',
    terrain: { seed: 90010, mountainAmount: 0.8, coast: 'none', valleyDepth: 0.9, rivers: 2, baseAltitude: 400 },
    weaponPoints: 0,
    noFail: true,
    friendly: {
      base: { x: 10000, z: 40000 },
      startAirborne: true,
      startAlt: PERF_ALT,
      // **標準の搭載にする。** 手順の説明の数字（航続・旋回）はこの搭載で
      // 飛行モデルから引いている（`X2`）。自動発射は切る —— この本では撃たせない。
      aircraft: [
        { type: 'F-1', name: 'VIPER 1', loadout: X2_LOAD['F-1'].slice(),
          autoWeapons: { 'AAM-M': false, 'AAM-S': false, GUN: false } },
        { type: 'F-2', name: 'HAMMER 1', loadout: X2_LOAD['F-2'].slice(),
          autoWeapons: { 'AAM-M': false, 'AAM-S': false, AGM: false, GUN: false } },
        { type: 'A-3', name: 'ANVIL 1', loadout: X2_LOAD['A-3'].slice(),
          autoWeapons: { AGM: false, 'AAM-S': false, GUN: false } },
      ],
    },
    enemy: {
      skill: 0.2,
      // レーダーの扇に入る位置。扇の広さを見る手順で「何か居る」ほうが分かりやすい
      aircraft: [dummyFighter('BANDIT 1', 31000, 26000, 5000)],
      ground: [],
    },
    steps: [
      { text: 'VIPER 1（F-1 制空戦闘機）を選ぶ',
        note: `**速さの機体。** 巡航${X2['F-1'].cruise}・最高${n0(X2['F-1'].abSpeed)} m/s（AB全開）、`
          + `最良旋回 ${d1(X2['F-1'].turnDeg)}°/s（${d1(X2['F-1'].turnG)}G）、上昇率 ${AC('F-1').climbRate} m/s。`
          + '**3機すべてで最速・最良旋回・最速上昇です。**\n'
          + `代償は**燃料と耐久** —— 標準搭載で ${mins(X2['F-1'].enduranceSec)}分／${kmI(X2['F-1'].rangeM)}km は3機で最短、`
          + `耐久${AC('F-1').hp} も最低です。**先に着いて、先に撃って、長くは居られない。**`,
        // **状態ではなく操作で見る**（§64）。
        // `check` で「VIPER 1 が選ばれている」を見ていたので、
        // **開始時に選択済みだと手順1が一瞬で終わり、説明が読めなかった。**
        // 選択を外して始めるようにしたが、判定のほうも操作で取るのが正しい。
        done: 'select', when: (d) => d.units.length === 1 && d.units[0].name === 'VIPER 1' },

      { text: 'F-1 の AB を「全開」にする',
        note: `**AB は燃料を${FUEL_AB_RATE}倍消します。** 全開のままだと F-1 は **${mins(X2['F-1'].abEnduranceSec)}分／${kmI(X2['F-1'].abRangeM)}km** しか飛べません。`
          + `速度は +${pct(X2['F-1'].abSpeed / X2['F-1'].milSpeed - 1)}%（${n0(X2['F-1'].milSpeed)} → ${n0(X2['F-1'].abSpeed)} m/s）ですが、滞空は 1/${FUEL_AB_RATE} になります。\n`
          + '**F-1 の性格はここに出ます** —— 短時間だけ他のどれより速い、という機体です',
        pause: true, highlight: '[data-ab="max"]',
        check: (ctx) => mine(ctx).some((u) => u.name === 'VIPER 1' && u.abMode === 'max') },

      { text: 'F-1 の AB を「温存」に戻す',
        note: `温存＝**ミサイルから逃げるときだけ焚く**。巡航${X2['F-1'].cruise}のまま${mins(X2_EMPTY['F-1'].enduranceSec)}分（空荷）飛べます。`
          + '標準＝敵機と交戦するときに焚く、が既定です',
        highlight: '[data-ab="save"]',
        check: (ctx) => mine(ctx).some((u) => u.name === 'VIPER 1' && u.abMode === 'save') },

      { text: 'HAMMER 1（F-2 マルチロール）を選ぶ',
        note: `**電波の機体。** レーダー ${km(X2['F-2'].radarRange)}km・扇は左右 ${X2['F-2'].radarFovH}° で、`
          + `**見渡す面積は F-1 の ${(X2['F-2'].sweep / X2['F-1'].sweep).toFixed(1)}倍**。3機でいちばん広く見えます。\n`
          + `代償は**速さ** —— 巡航${X2['F-2'].cruise} は A-3（${X2['A-3'].cruise}）とほぼ同じで、`
          + '**追いつけないし、急いで駆けつけることもできません。**'
          + `さらに**逆探知される距離が ${km(X2['F-2'].rwrRange)}km で3機中最長** —— 黙っていられない機体です`,
        done: 'select', when: (d) => d.units.length === 1 && d.units[0].name === 'HAMMER 1' },

      { text: 'F-2 のレーダーを「常時ON」にして、前方に出る扇の広さを見る',
        note: `F-1 は ${km(X2['F-1'].radarRange)}km / 左右 ${X2['F-1'].radarFovH}°、A-3 は ${km(X2['A-3'].radarRange)}km / 左右 ${X2['A-3'].radarFovH}°。**F-2 だけ明らかに広い**のが画面で分かります。\n`
          + `ただし探知距離は**見つかる距離でもあります**（射程の${RWR_SIGNATURE_FACTOR}倍）。`
          + `F-2 **${km(X2['F-2'].rwrRange)}km**、F-1 ${km(X2['F-1'].rwrRange)}km、A-3 ${km(X2['A-3'].rwrRange)}km。`
          + '**いちばん見えて、いちばん見つかる。**',
        done: 'radar', when: (d) => d.mode === 'on' },

      { text: 'F-2 のレーダーを「自動」に戻す',
        note: '自動は、**敵を1機も掴んでいないときは自分から出し**、'
          + '掴んでいるあいだは黙って詰めます。'
          + '見失えばまた出す、という往復になります',
        done: 'radar', when: (d) => d.mode === 'auto' },

      { text: 'ANVIL 1（A-3 攻撃機）を選ぶ',
        note: `**持久の機体。** 耐久${AC('A-3').hp}（F-1 の${d1(AC('A-3').hp / AC('F-1').hp)}倍）、`
          + `搭載${hardpointsOf(AC('A-3')).total}枠、燃料${mins(X2_EMPTY['A-3'].enduranceSec)}分（空荷）。`
          + `**標準搭載でも ${mins(X2['A-3'].enduranceSec)}分／${kmI(X2['A-3'].rangeM)}km** 飛べて、`
          + `デコイもフレア${AC('A-3').flares}・チャフ${AC('A-3').chaff} と最多です`
          + `（F-1 の${AC('A-3').flares / AC('F-1').flares}倍。ミサイル2発ぶんを受け止められます）。\n`
          + `代償は**速さと情報** —— 巡航${X2['A-3'].cruise}・最高${n0(X2['A-3'].milSpeed)}、`
          + `レーダーは ${km(X2['A-3'].radarRange)}km で3機中最短。**遅く、鈍く、遠くが見えない。**`,
        done: 'select', when: (d) => d.units.length === 1 && d.units[0].name === 'ANVIL 1' },

      { text: 'A-3 のパネルに「AB」の行が無いことを確かめ、高度を「超高」にする',
        note: '**A-3 はアフターバーナーを積んでいません。** 一時的に速く逃げる手段がない代わりに、'
          + '**全開にしても燃料が減らない**とも言えます。長い作戦を支えているのはここです。\n'
          + `また上昇限度が ${n0(AC('A-3').ceiling)}m なので、**「限界」ボタンが出ない唯一の機体**です。`
          + `上昇率も ${AC('A-3').climbRate} m/s で、F-1（${AC('F-1').climbRate} m/s）の${AC('A-3').climbRate / AC('F-1').climbRate}倍です`,
        pause: true, highlight: '[data-alt="10000"]',
        check: (ctx) => mine(ctx).some(
          (u) => u.name === 'ANVIL 1' && Math.abs(u.desiredAlt - 10000) < 300) },

      // **先に高度を揃える。** 直前の手順で A-3 だけ 10,000m へ登り始めているので、
      // そのまま走らせると **A-3 は 113 m/s まで落ちる**（高度と速度の交換・§29.4）。
      // 巡航速度の違いを見せたい場面で、別の理由の遅れが混ざる。
      { text: 'ドラッグで3機まとめて選び、高度を「中高」にしてから遠くの地点へ移動を指示する',
        note: '**先に高度を揃えるのが大事です。** 高度が違うと、'
          + '登り降りで速度を食う機体が出て、巡航の違いが見えなくなります',
        check: (ctx) => {
          const all = mine(ctx).filter((u) => !u.onGround);
          return all.length >= 3
            && all.every((u) => Math.abs(u.desiredAlt - 4000) < 300)
            && all.every((u) => u.order && (u.order.type === 'move' || u.queue.length > 0));
        } },

      { text: '隊列が伸びて、先頭と最後尾の差が 1km 以上開くのを見る（倍速推奨）',
        note: `巡航は **${X2_IDS.map((id) => X2[id].cruise).join(' / ')} m/s**。**同じ指示でも同じようには着きません。**\n`
          + `速度の差は思ったより小さい（${(X2['F-1'].cruise / X2['A-3'].cruise).toFixed(2)}倍）のですが、`
          + `分かれるのは**航続**（${X2_IDS.map((id) => mins(X2[id].enduranceSec)).join(' / ')}分）、`
          + `**レーダー**（${X2_IDS.map((id) => km(X2[id].radarRange)).join(' / ')}km）、`
          + `**旋回**（${X2_IDS.map((id) => d1(X2[id].turnDeg)).join(' / ')}°/s）です。\n`
          + '一緒に動かしたいなら**編隊（G）を組む**か、遅い機体を先に出します',
        // **「目的地までの残り」の差で見る。**
        //
        // 機体どうしの最大間隔で測ると伸びない —— 同じ地点へ向かうので、
        // 前後には開いても左右には縮み、差し引きでほとんど動かない。
        // **測るのは前後方向だけ**にする。
        // さらに開始時の差を引く（3機は飛行場の周りに並べて出るので、
        // 最初から 3km ほどばらけている）。
        check: (ctx) => {
          const all = mine(ctx).filter((u) => !u.onGround);
          if (all.length < 2) return false;
          if (ctx.mem.dest == null) {
            const o = all[0].order;
            if (!o || o.type !== 'move') return false;
            ctx.mem.dest = { x: o.x, z: o.z };
          }
          const d = ctx.mem.dest;
          let lo = Infinity; let hi = -Infinity;
          for (const u of all) {
            const r = Math.hypot(u.pos.x - d.x, u.pos.z - d.z);
            if (r < lo) lo = r;
            if (r > hi) hi = r;
          }
          // **基準は「いちばん揃った瞬間」**。
          // 3機は横に散った状態から出るので、指示直後の差は
          // *縮んでいく*（横のばらつきが縦一列に畳まれる）。
          // 開始時の値を基準にすると、伸び始めても差が負のままになる。
          // 実測: 差は 2,958 → 383（t=69）→ 2,220（t=119）と動いた。
          const gap = hi - lo;
          if (ctx.mem.gapMin == null || gap < ctx.mem.gapMin) ctx.mem.gapMin = gap;
          return gap - ctx.mem.gapMin > 1000;
        } },
    ],
  },
];

/** 一覧に出す本（表示順）。受講済みの数と「次へ」はこれで数える */
export const LISTED_TUTORIALS = TUTORIALS.filter((t) => t.listed !== false);

/** 一覧に出ている本のうち、終えたものの数（消えた本・一覧外の本の記録は数えない） */
export function countTutorialsDone(done) {
  if (!Array.isArray(done)) return 0;
  return LISTED_TUTORIALS.filter((t) => done.includes(t.id)).length;
}

/** 終えたチュートリアルか */
export function isTutorialDone(id, done) {
  return Array.isArray(done) && done.includes(id);
}

export function getTutorial(id) {
  return TUTORIALS.find((t) => t.id === id) || null;
}
