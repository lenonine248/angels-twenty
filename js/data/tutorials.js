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

import { LEVEL } from '../sim/detection.js';
import { estimateHitChance, FIRE_THRESHOLD } from '../sim/combat.js';
import { WEAPONS } from './weapons.js';

// ---------------------------------------------------------------- 小道具

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

// ---------------------------------------------------------------- 定義

export const TUTORIALS = [
  // ================================================================ 1
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
        note: '指示した経路は線で表示されます。Shift+右クリックで経路を継ぎ足せます',
        done: 'order:move' },
      { text: 'Space キーで一時停止する',
        note: '一時停止中も視点を動かしたり指示を出したりできます',
        done: 'pause' },
      { text: '一時停止を解除し、] キーで倍速を上げる',
        note: '画面上部の x1 / x2 / x4 / x8 のボタンでも変えられます',
        done: 'speed' },
      { text: 'WASD キーで視点を動かして、機体を追う',
        note: 'Q E で旋回、R F で仰角、ホイールで拡大縮小。C キーで選択機に寄れます',
        check: cameraMoved },
      { text: 'ドラッグで2機ともまとめて選択する',
        note: '空いている場所から左ボタンでドラッグすると範囲選択になります',
        check: (ctx) => ctx.commands.selection.filter((u) => u.alive).length >= 2 },
      { text: '2機まとめて移動を指示する',
        note: '複数機に同じ地点を指示すると、殺到しないよう自動で散開します',
        done: 'order:move' },
    ],
  },

  // ================================================================ 2
  {
    id: 't2',
    group: '基本',
    name: '高度とエネルギー',
    title: '高度は速度と交換できる',
    brief: '高度はこのゲームでいちばん効く要素です。\n'
      + '高いほど推力と旋回率は落ちますが、ミサイルはよく飛びます。\n'
      + '高度と速度は交換できる同じ資産で、その合計が「エネルギー」です。',
    hint: '敵はいません。高度・速度・エネルギーの関係だけを見ます。'
      + 'F-1 がいちばんよく曲がるのは 180 m/s あたり（コーナー速度）で、'
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
        note: '高度と速度を足し合わせた「まだ戦える余力」です（§29.4）。'
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
        note: 'F-1 の巡航は 220 m/s。高度を使い切ったぶんだけ速く飛べます。'
          + 'いちばんよく曲がるのは 180 m/s あたり（コーナー速度）なので、'
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

  // ================================================================ 3
  {
    id: 't3',
    group: '基本',
    // **隣の「電波と逆探知」と対にする。** 単に「探知」だと、
    // 選択画面で2枚並んだときに何が違うのか読み取れない。
    name: 'レーダーと目視',
    title: '見えているもの・見えていないもの',
    brief: '画面に出ているのは「真の配置」ではなく「こちらが把握できている情報」です。\n'
      + '機体のレーダーは機首前方の扇しか見ていません。\n'
      + '味方飛行場のレーダーは全方位30kmですが、低い目標ほど遠くからは見えません。\n'
      + '敵がどこにいて、それが何なのかを掴むのは指揮官の仕事です。',
    hint: '敵機は武装していません。落とす必要はありません。',
    terrain: { seed: 90003, mountainAmount: 1.0, coast: 'none', valleyDepth: 1.0, rivers: 2, baseAltitude: 420 },
    weaponPoints: 0,
    noFail: true,
    friendly: {
      base: { x: 11000, z: 38000 },
      startAirborne: true,
      startAlt: 5000,
      aircraft: [
        { type: 'F-1', name: 'VIPER 1', loadout: ['AAM-S'] },
      ],
    },
    enemy: {
      skill: 0.2,
      aircraft: [
        // **低空・遠方**に置いてある。自軍飛行場のレーダーは全方位30km
        // （`GROUND_TYPES.AIRBASE.radar.range`。§30.2 で 60km から下げた）だが、
        // 低い目標ほど探知距離が落ちる（対地3,000mで満額、400mでは約42%＝12.6km）。
        // 37km 先にいるこの機体は、開始時点では飛行場からも見えていない。
        // 自軍飛行場へ向かって飛んでくるので、放っておけばいずれ飛行場が捉える。
        { type: 'J-7', name: 'BANDIT 1', x: 38000, z: 12000, agl: 400,
          aiMode: 'TRANSIT', loadout: [], autoWeapons: { GUN: false }, tags: ['target'],
          moveTo: { x: 11000, z: 38000, agl: 400 } },
      ],
      ground: [],
    },
    // 対空の探知だけを扱う。低空侵入と地上レーダーの回避は「飛行場と対地」に置いた。
    steps: [
      { text: '機体を選択して、前方に出るレーダーの扇を確認する',
        note: '扇の中が機体のレーダーで見える範囲。内側の弧より近ければ、捉えた瞬間に機種まで分かります',
        done: 'select' },
      { text: '北東から接近してくる敵機を捉える',
        note: '敵は低空を飛んでおり、飛行場のレーダーからも隠れています。'
          + '北東へ移動を指示して迎えに行ってください。待っていても、'
          + '飛行場に近づけばいずれ飛行場のレーダーが捉えます',
        check: (ctx) => { const c = contactOf(ctx, unit(ctx, 'BANDIT 1')); return !!c; } },
      { text: '追尾を続けて敵機を識別する（機種が判明する）',
        note: '捉えた直後は UNKNOWN です。追い続けるか、探知距離の半分まで詰めると識別できます。'
          + '扇から外すと探知は切れ、最後の位置と針路からの推測表示に変わります',
        check: (ctx) => { const c = contactOf(ctx, unit(ctx, 'BANDIT 1')); return !!c && c.level >= LEVEL.IDENTIFIED; } },
      { text: '目視の距離（8km 以内）まで近づく',
        note: '目視まで詰めると速度まで読めます。目視は機首の向きに縛られませんが、届くのは 8km までです',
        check: (ctx) => { const c = contactOf(ctx, unit(ctx, 'BANDIT 1')); return !!c && c.level >= LEVEL.DETAILED; } },
    ],
  },


  // ================================================================ 4
  {
    id: 't7',
    group: '基本',
    name: '電波と逆探知',
    title: '出せば見える、出せば見つかる',
    brief: 'レーダーは出せば遠くまで見えますが、出した電波は相手にも届きます。\n'
      + '黙れば見つかりませんが、そのあいだ中距離AAMは撃てません。\n'
      + 'どちらを選ぶかが、目視外の戦いの入口になります。',
    hint: '敵は撃ってきません。レーダーの入り切りだけを試します。',
    terrain: { seed: 90007, mountainAmount: 0.7, coast: 'none', valleyDepth: 0.8, rivers: 2, baseAltitude: 400 },
    weaponPoints: 0,
    noFail: true,
    friendly: {
      base: { x: 10000, z: 40000 },
      startAirborne: true,
      startAlt: 5000,
      aircraft: [
        { type: 'F-1', name: 'VIPER 1', loadout: ['AAM-M', 'AAM-S'] },
      ],
    },
    enemy: {
      ground: [
        // **自機のレーダー射程の外に置く**（§50.3）。
        // F-1 は 40km、自軍飛行場は 30km。ここは進発位置から約43km なので、
        // **電波を拾う以外に見つける手が無い**。
        // 逆探知は 60km まで届き、レーダーサイト（射程45km）は
        // その1.5倍＝67.5km から映るので、距離のほうは足りている（§30.3）。
        //
        // **逆探知にも視線判定が要る**（`byRwr` が `hasLineOfSight` を見る）。
        // 最初 (44000,8000) に置いたら、あいだの尾根に遮られて
        // **高度8,000mまで上げても一度も掴めなかった**。
        // 標高2,375m の尾根の上に移して、対地3,000m から視線が通るようにした
        // （実測。レーダーサイトを高所に置くのは理屈にも合う）。
        { type: 'RADAR', name: '敵レーダーサイト', x: 44700, z: 9800, tags: ['emitter'] },
      ],
      aircraft: [
        // **こちらは黙らせる**（§50.3）。電波を出させると、こちらが沈黙していても
        // 逆探知で勝手に見つかってしまい、「出さないと見えない相手」が作れない。
        // 実測では、この機体を `radarMode: 'on'` にしていたせいで
        // **手順の半分が開始2秒で自動的に達成されていた**。
        // **陣地とは別の方角に置く。** 同じ北東に並べると、
        // 「逆探知で見えているほう」と「レーダーで探すほう」が区別できない。
        { type: 'J-7', name: 'BANDIT 1', x: 36000, z: 33000, agl: 5000,
          aiMode: 'PATROL', loadout: [], autoWeapons: { GUN: false },
          radarMode: 'off', tags: ['target'] },
      ],
    },
    // **並びは「受信で分かるもの → 出さないと分からないもの」。**
    // 逆探知は受信だけなので、最初から掴んでいる。それを先に見せてから
    // レーダーを切り、「黙っても消えない」ことで受信専用だと分からせる。
    steps: [
      { text: '機体を選択し、下のパネルの「レーダー」の欄を見る',
        note: '自動／常時ON／常時OFF の3つ。右に「発信中」か「沈黙」かが出ます。'
          + '自動は、交戦中と相手のレーダー圏内でだけ出します',
        done: 'select' },
      { text: '北東の遠方に出ている敵レーダーサイトの印を確かめる',
        note: 'この陣地は約43km 先で、**自機のレーダー（40km）でも'
          + '味方飛行場（30km）でも届きません**。それでも見えているのは、'
          + '相手が出している電波をこちらが拾っているからです（逆探知）。'
          + '**位置は ±1km ぶれます** — 方向は正確でも距離が甘いためで、'
          + '印も概算であることが分かる形で出ます',
        check: (ctx) => !!contactOf(ctx, unit(ctx, '敵レーダーサイト')) },
      { text: 'レーダーを「常時OFF」にする',
        note: '**陣地の印が消えないことを確かめてください。** '
          + '逆探知は聞いているだけなので、こちらが黙っても働きます。'
          + 'ただし**この状態では AAM-M と AAM-A が撃てません** — '
          + 'どちらも自分のレーダーで目標を照らす必要があるからです',
        pause: true, highlight: '[data-radar="off"]',
        check: (ctx) => mine(ctx).some((u) => u.radarMode === 'off') },
      { text: 'レーダーを「常時ON」に戻す',
        note: '遠くまで見えるようになりますが、**こちらもレーダー射程の1.5倍の'
          + '距離から相手の逆探知に映ります**（F-1 なら 60km）。'
          + '出すか黙るかは、そのまま「見つけるか、見つからないか」の選択です',
        pause: true, highlight: '[data-radar="on"]',
        check: (ctx) => mine(ctx).some((u) => u.radarMode === 'on') },
      { text: '東 27km の敵機を捉えて、機種まで確かめる',
        note: '**この敵機は電波を出していません。** '
          + 'だから逆探知には映らず、こちらがレーダーを向けるまで見つかりません。'
          + '機首を向けて扇に入れてください。'
          + '実戦では「自動」に任せておけば、必要なときだけ出して不要なときは黙ります。'
          + '手で切り替えるのは、待ち伏せたいときと、逆に囮になりたいときです',
        check: (ctx) => {
          const c = contactOf(ctx, unit(ctx, 'BANDIT 1'));
          return !!c && c.level >= LEVEL.IDENTIFIED;
        } },
    ],
  },

  // ================================================================ 5
  {
    id: 't4',
    group: '基本',
    name: '空対空',
    title: 'ミサイルの撃ち方',
    brief: 'ミサイルは実体として飛びます。撃てば当たるものではありません。\n'
      + '射程の内側でも、遠すぎれば燃え尽きて届かず、回避されれば外れます。\n'
      + '命中期待度を見て、撃つ距離を選ぶのが指揮官の仕事です。',
    hint: '敵は1機だけ、練度も低く設定してあります。落ち着いて手順を進めてください。',
    terrain: { seed: 90004, mountainAmount: 0.8, coast: 'none', valleyDepth: 0.8, rivers: 2, baseAltitude: 400 },
    weaponPoints: 0,
    noFail: true,
    friendly: {
      base: { x: 12000, z: 38000 },
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
        { type: 'F-1', name: 'VIPER 1', loadout: ['AAM-M', 'AAM-M', 'AAM-S', 'AAM-S'],
          autoWeapons: { 'AAM-M': false, 'AAM-S': false, GUN: false } },
      ],
    },
    enemy: {
      skill: 0.3,
      aircraft: [
        { type: 'J-7', name: 'BANDIT 1', x: 30000, z: 24000, agl: 5500,
          aiMode: 'PATROL', loadout: ['AAM-S'], tags: ['target'] },
      ],
      ground: [],
    },
    steps: [
      { text: '機体を選択し、地図で敵機の位置を確かめる',
        note: '敵はおよそ 22km 北東。味方飛行場のレーダーが捉えているので位置は分かります',
        done: 'select' },
      { text: '敵機を右クリックして攻撃を指示する',
        note: 'カーソルを敵に重ねると距離と命中期待度が出ます',
        done: 'order:attack' },
      { text: '下のパネルで使用兵装に AAM-M を指定する',
        note: 'このチュートリアルでは自動発射を切ってあります。'
          + '指定してから敵を右クリックすると、その兵装での射撃指示になります',
        done: 'weapon', when: (d) => d.weapon === 'AAM-M',
        pause: true, highlight: '[data-pick="AAM-M"]',
        // 指定する前に撃ち尽くすと、押すチップが無くなる。行き止まりにしない。
        check: (ctx) => mine(ctx).length > 0
          && mine(ctx).every((u) => !u.loadout.includes('AAM-M')) },
      { text: '「誘導中も回避／誘導を優先」を切り替えてみる',
        note: '誘導を続ければ当たりやすく、回避を選べば自分が助かりやすい。その場で選びます',
        done: 'guard' },
      { text: 'AAM-M を発射する',
        note: '敵を右クリックすると、指定した兵装での射撃指示になります。'
          + 'AAM-M は撃った側が誘導を続ける必要があり、逃げると誘導が切れます',
        done: 'fire', when: (d) => d.weapon === 'AAM-M',
        // 撃ち尽くした状態で来たら次へ送る（発射の通知はもう起こせない）
        check: (ctx) => mine(ctx).length > 0
          && mine(ctx).every((u) => !u.loadout.includes('AAM-M')) },
      { text: '敵機を撃墜する',
        note: '外れたら距離を詰めて撃ち直せます。短距離の AAM-S に持ち替えるときも、'
          + '同じように指定してから右クリックします。'
          + 'ただし**近すぎても当たりません** — 弾が曲がり切れる距離が要ります',
        check: (ctx) => {
          const u = unit(ctx, 'BANDIT 1');
          if (u && !u.alive) return true;
          return spentAll('AAM-M')(ctx) && spentAll('AAM-S')(ctx);   // 撃ち切ったら次へ
        } },
    ],
  },


  // ================================================================ 6
  {
    id: 't8',
    group: '基本',
    name: '回避とデコイ',
    title: '撃たれたらどうするか',
    brief: 'ミサイルは避けられます。ただし避け方は1つではありません。\n'
      + '着弾まで遠ければ背を向けて逃げ、近ければ真横を向いて紛れます。\n'
      + 'フレアは引き付ける囮、チャフは電波を通さない壁です。',
    hint: '敵は1機・練度も低く、こちらは2機います。落とされても手順は続けられます。',
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
      aircraft: [
        { type: 'F-1', name: 'VIPER 1', loadout: ['AAM-S', 'AAM-S'] },
        { type: 'F-1', name: 'VIPER 2', loadout: ['AAM-S', 'AAM-S'] },
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
      { text: '機体を選択し、デコイの残数を確かめる',
        note: 'F-1 はフレア4・チャフ14。**働きが違います** — '
          + 'フレアは赤外線ミサイルを**引き付ける**囮、'
          + 'チャフは電波を通さない雲で、追う側との間に立つ**壁**です。'
          + 'だからチャフは相手のレーダーを騙すのではなく、視線を遮ります',
        done: 'select' },
      { text: 'ロック警報を受ける',
        note: '中距離AAM（AAM-M）は撃った側が着弾まで照らし続けるので、'
          + '**発射と同時に警報が出ます**。'
          + 'アクティブAAM（AAM-A）は終末まで黙っているので、'
          + '気づいたときには近い、という違いがあります',
        check: (ctx) => mine(ctx).some((u) => u.threats && u.threats.length > 0) },
      // 「かわした」は状態で書くしかない（§19.3）。
      // 一度でも脅威に入り、生きたまま脅威が消えたら達成、という形にする。
      { text: 'ミサイルをかわす',
        note: '着弾まで遠ければ**背を向けて逃げ**（追う弾の足を削る）、'
          + '近ければ**真横を向いて**接近速度を消します（ビーム機動）。'
          + 'どちらを使うかはAIが着弾までの時間で決めます。倍速を上げて見てください',
        check: (ctx) => {
          const alive = mine(ctx);
          if (!alive.length) return false;
          if (alive.some((u) => u.threats && u.threats.length > 0)) {
            ctx.mem.threatened = true;
            return false;
          }
          return !!ctx.mem.threatened;
        } },
      { text: 'チャフが撒かれたのを確かめる',
        note: '**チャフは逃げるときとビームのときにしか撒きません**（§46）。'
          + '正面から向かっているあいだに撒いても、壁は後ろに流れるだけで'
          + '間に立たないからです。フレアのほうは向きに関係なく効きます',
        check: (ctx) => ctx.world.decoys.some(
          (d) => d.kind === 'chaff' && d.side === ctx.world.playerSide) },
      { text: '「誘導中も回避／誘導を優先」を切り替えてみる',
        note: '自分が中距離AAMを誘導している最中に撃たれたときの選択です。'
          + '誘導を続ければ当てられますが、避けないぶん自分が危ない。'
          + '**この判断は毎回発生します**',
        done: 'guard', pause: true, highlight: '[data-guard]' },
      { text: 'AIモードを「回避優先」にして離脱する',
        note: '交戦を避けて低空へ退避します。'
          + '勝てない場面から機体を持ち帰るのも指揮官の仕事です',
        done: 'aimode', when: (d) => d.mode === 'EVADE' },
    ],
  },

  // ================================================================ 7
  {
    id: 't5',
    group: '基本',
    name: '編隊とAI',
    title: '任せ方を決める',
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
        note: '最大4機まで。Shift+G で解散します',
        done: 'formation' },
      { text: 'AIモードを「連携」にする',
        note: '連携中はレーダーの扇を左右に分担し、同じ敵に重複して撃たなくなります',
        done: 'aimode', when: (d) => d.mode === 'COORDINATE' },
      { text: '編隊の形を「横隊」にする',
        note: '密集＝互いを近くに置く（護衛や、まとめて動かしたいとき）／'
          + '横隊＝横に開く。**探知の幅が広がり、挟み撃ちに移りやすくなります**',
        done: 'shape', pause: true, highlight: '[data-shape="SPREAD"]' },
      { text: '1機だけを選び、別の自軍機を右クリックして随伴させる',
        note: '護衛につけた機体は、守る相手を追い抜かないよう速度を合わせます',
        done: 'order:follow' },
      { text: '自動発射のしきい値を変える',
        note: '「高」にすると確実な機会しか撃たなくなり、ミサイルは節約できますが決め手を欠きます',
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

  // ================================================================ 8
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
        note: '地上レーダーは低い目標ほど遠くからは見えません（対地3,000mで満額、'
          + '地表すれすれでは4割まで落ちます）。山が視線を遮るのも低空のほうがよく効きます',
        check: (ctx) => mine(ctx).some((u) => !u.onGround && agl(ctx, u) <= 1000) },
      { text: 'レーダーサイトを右クリックして攻撃を指示する',
        note: '地上目標はブリーフィングで判明していたので、最初から地図に出ています。'
          + '電波を出している地上目標は、逆探知でも掴めます（位置は ±1km ぶれます）',
        done: 'order:attack' },
      { text: 'レーダーサイトを破壊する',
        note: 'AGM は射程外から撃てます。無誘導爆弾なら目標の真上を通る必要があります',
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
        note: '下のパネルで兵装を足す／降ろす。足すと兵装ポイントが減り、降ろすと戻ります',
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
  // ================================================================ 兵装1
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
        { type: 'J-7', name: 'BANDIT 1', x: 21000, z: 30000, agl: 2000,
          aiMode: 'TRANSIT', loadout: [], autoWeapons: { GUN: false }, tags: ['target'],
          moveTo: { x: 36000, z: 18000, agl: 2000 } },
      ],
      ground: [
        // 車両部隊は撃ち返してこないので掃射の練習に向く（対空砲は撃ってくる）
        { type: 'CONVOY', name: '車両部隊', x: 17000, z: 32000, tags: ['target'], known: true },
      ],
    },
    steps: [
      { text: '機体を選択し、下のパネルに兵装が無いことを確認する',
        note: '機銃は搭載リストに出ません。スロットも兵装ポイントも使いません',
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
          + '対地は機首から26度まで撃てるので、多少見下ろしていても届きます',
        check: (ctx) => { const u = unit(ctx, '車両部隊'); return !!u && u.hp < u.maxHp; } },
      { text: '敵機を右クリックして攻撃を指示する',
        note: '今度は動く的です。機銃は機首から14度以内にしか撃てないので、'
          + '後ろに付く必要があります',
        done: 'order:attack' },
      // 地上目標と同じく、破壊までは求めない。機銃だけで対地と対空を1回ずつ
      // こなすには、戦闘出力の燃費（実測で約4倍）では F-1 の12分が足りず、
      // 撃墜寸前に「燃料残少 — 帰投」で引き返してしまう（実測で半分が未達）。
      // 教えたいのは「後ろに付けば当たる」ことなので、命中で足りる。
      { text: '敵機に命中させる',
        note: '弾は瞬時には届きません。F-1 は弾が速い（1,000m/s）ぶん先読みの'
          + '誤差が小さく、動く目標にも当たります。'
          + '当たらないときは距離を詰めてください。拡散は距離とともに広がります',
        check: (ctx) => { const u = unit(ctx, 'BANDIT 1'); return !!u && (!u.alive || u.hp < u.maxHp); } },
    ],
  },

  // ================================================================ 兵装2
  {
    id: 'w2',
    group: '兵装',
    name: 'AAM-S 短距離AAM',
    title: '安い・速い・近い',
    brief: '赤外線で排気を追うミサイルです。コストは0で、いくらでも積めます。\n'
      + '撃ちっぱなしなので、発射したらすぐ次の行動に移れます。\n'
      + '後方から8km・正面からは4kmまでしか掴めず、フレアに弱いのが弱点です。',
    hint: '敵機は武装していません。',
    terrain: { seed: 90012, mountainAmount: 0.7, coast: 'none', valleyDepth: 0.8, rivers: 2, baseAltitude: 400 },
    weaponPoints: 0,
    noFail: true,
    friendly: {
      base: { x: 12000, z: 38000 },
      startAirborne: true,
      startAlt: 5000,
      // 自動発射を切る（§49）。入れたままだと、プレイヤーが兵装を指定する前に
      // AI が撃って的を落としてしまい、以降の手順が起こせなくなる。
      aircraft: [{ type: 'F-1', name: 'VIPER 1', loadout: ['AAM-S', 'AAM-S', 'AAM-S'],
        autoWeapons: { 'AAM-S': false, GUN: false } }],
    },
    enemy: {
      skill: 0.2,
      aircraft: [dummyFighter('BANDIT 1', 24000, 26000, 5000)],
      ground: [],
    },
    steps: [
      { text: '敵機を右クリックして攻撃を指示する',
        note: '**攻撃指示が先**。兵装を指定してから右クリックすると射撃指示になり、'
          + '機体はその場から動きません',
        done: 'order:attack' },
      { text: '下のパネルで使用兵装に AAM-S を指定する',
        note: 'コスト0。スロット1つ。積めるだけ積んでも兵装ポイントは減りません。'
          + 'このチュートリアルでは自動発射を切ってあります',
        done: 'weapon', when: (d) => d.weapon === 'AAM-S',
        pause: true, highlight: '[data-pick="AAM-S"]',
        // 指定する前に撃ち尽くすと、押すチップが無くなる。行き止まりにしない。
        check: (ctx) => mine(ctx).length > 0
          && mine(ctx).every((u) => !u.loadout.includes('AAM-S')) },
      // 正面から出会う配置なので「後方に回り込め」とは言えない。
      // 後ろから撃つほど当たる、という**性質のほうは別に伝える**。
      // **敷居は定数から引く。** ここに数字を直接書くと、`hitLabel` を動かしたときに
      // 手順の文（「中」以上）と食い違う。実際 Beta 2.4 当時の 0.32 が
      // §38 で「中」が 0.20 に下がったあとも残っていた。
      { text: '命中期待度が「中」以上になるまで近づく',
        note: 'カーソルを敵に重ねると期待度が読めます。'
          + '赤外線シーカーは排気を追うので、本当は**後ろから撃つほどよく当たります**。'
          + '正面から入るこの状況では、そのぶん近づいて補う必要があります',
        check: (ctx) => {
          const e = unit(ctx, 'BANDIT 1');
          return !!e && mine(ctx).some(
            (u) => estimateHitChance(u, e, WEAPONS['AAM-S']) >= FIRE_THRESHOLD.mid);
        } },
      { text: 'AAM-S を発射する',
        note: '兵装を指定した状態で敵を右クリックすると射撃指示になります。'
          + '撃ちっぱなしなので、撃った瞬間に離脱しても当たります',
        done: 'fire', when: (d) => d.weapon === 'AAM-S',
        check: (ctx) => mine(ctx).length > 0
          && mine(ctx).every((u) => !u.loadout.includes('AAM-S')) },
      { text: '敵機を撃墜する',
        note: '外れても構いません。安いので何発でも撃てます。'
          + 'ただし**近すぎると当たりません** — 弾が曲がり切れるだけの飛翔時間が要るので、'
          + '2km を切ると急に当たらなくなります。\n'
          + 'なお、掴まれる距離は**相手の温度**でも変わります（下のパネルの「熱」）。'
          + 'アフターバーナーを焚いている機体は遠くから掴まれ、'
          + '推力を絞った機体は近づかないと掴めません',
        check: (ctx) => {
          const u = unit(ctx, 'BANDIT 1');
          return (!!u && !u.alive) || spentAll('AAM-S')(ctx);
        } },
    ],
  },

  // ================================================================ 兵装3
  {
    id: 'w3',
    group: '兵装',
    name: 'AAM-M 中距離AAM',
    title: '誘導し続ける覚悟',
    brief: '射程20km。遠くから撃てますが、**着弾まで自分のレーダーで目標を照らし続ける**\n'
      + '必要があります。その間こちらは自由に動けません。\n'
      + 'コストは2。この判断が中距離戦の中心になります。',
    hint: '敵機は武装していません。誘導を切らさない練習に集中してください。',
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
      aircraft: [dummyFighter('BANDIT 1', 30000, 22000, 6000)],
      ground: [],
    },
    steps: [
      { text: '敵機を右クリックして攻撃を指示する',
        note: '**攻撃指示が先**。兵装の指定はそのあとで行います',
        done: 'order:attack' },
      { text: '下のパネルで使用兵装に AAM-M を指定する',
        note: '射程20km。高度が高いほど実効射程は伸びます。'
          + 'このチュートリアルでは自動発射を切ってあります',
        done: 'weapon', when: (d) => d.weapon === 'AAM-M',
        pause: true, highlight: '[data-pick="AAM-M"]',
        check: (ctx) => mine(ctx).length > 0
          && mine(ctx).every((u) => !u.loadout.includes('AAM-M')) },
      { text: 'AAM-M を発射する',
        note: '兵装を指定した状態で敵を右クリックすると射撃指示になります。'
          + '射程(20km)の内側に入っていないと撃ちません',
        done: 'fire', when: (d) => d.weapon === 'AAM-M',
        check: (ctx) => mine(ctx).length > 0
          && mine(ctx).every((u) => !u.loadout.includes('AAM-M')) },
      { text: '誘導が続いているあいだ、機体の動きを見る',
        note: '目標をレーダーの扇に入れたまま斜めに飛ぶ「クランク」をします。'
          + '照射を切らさずに接近速度を落とす動きです。'
          + '**扇から外すと誘導が切れて外れます**（数秒は慣性で飛びますが、'
          + '扇に戻さなければそこで終わりです）',
        check: (ctx) => ctx.world.missiles.some((m) => m.alive
          && m.side === ctx.world.playerSide && m.guidance === 'sarh') },
      { text: '「誘導中も回避／誘導を優先」を切り替えてみる',
        note: '撃たれたときに、誘導を続けるか自分の身を守るかの選択です。'
          + '中距離AAMを使うということは、この判断を毎回することになります',
        done: 'guard', pause: true, highlight: '[data-guard]' },
      { text: '敵機を撃墜する',
        check: (ctx) => {
          const u = unit(ctx, 'BANDIT 1');
          return (!!u && !u.alive) || spentAll('AAM-M')(ctx);
        } },
    ],
  },
  // ================================================================ 兵装4
  {
    id: 'w4',
    group: '兵装',
    name: 'AAM-A アクティブAAM',
    title: '撃って、すぐ帰る',
    brief: '自分でレーダーを持つミサイルです。撃った瞬間に離脱できます。\n'
      + '照射しないので、相手に警報が出るのは終末になってから。\n'
      + 'ただしコスト6・スロット2。中距離AAM 3発ぶんの値段です。',
    hint: '敵機は武装していません。',
    terrain: { seed: 90014, mountainAmount: 0.6, coast: 'none', valleyDepth: 0.7, rivers: 2, baseAltitude: 400 },
    weaponPoints: 12,
    noFail: true,
    friendly: {
      base: { x: 11000, z: 40000 },
      startAirborne: true,
      startAlt: 6000,
      // 自動発射を切る（§49）。2発しか積めないので、AI に先に撃たれると
      // 手順「AAM-A を発射する」が二度と起こせない（実測で行き止まりを確認）。
      aircraft: [{ type: 'F-1', name: 'VIPER 1', loadout: ['AAM-A', 'AAM-A'],
        autoWeapons: { 'AAM-A': false, GUN: false } }],
    },
    enemy: {
      skill: 0.2,
      aircraft: [dummyFighter('BANDIT 1', 30000, 22000, 6000)],
      ground: [],
    },
    steps: [
      { text: '敵機を右クリックして攻撃を指示する',
        note: '**攻撃指示が先**。兵装の指定はそのあとで行います',
        done: 'order:attack' },
      { text: '下のパネルで使用兵装に AAM-A を指定する',
        note: 'スロット2つを使います。4スロットのF-1には2発しか積めません',
        done: 'weapon', when: (d) => d.weapon === 'AAM-A',
        pause: true, highlight: '[data-pick="AAM-A"]',
        // 指定する前に自動発射で撃ち尽くすと、押すチップが無くなる。行き止まりにしない。
        check: (ctx) => mine(ctx).length > 0
          && mine(ctx).every((u) => !u.loadout.includes('AAM-A')) },
      { text: 'AAM-A を発射する',
        note: '射程は中距離AAMと同じ20km。撃ち方も同じです。'
          + 'このチュートリアルでは自動発射を切ってあります',
        done: 'fire', when: (d) => d.weapon === 'AAM-A',
        check: (ctx) => mine(ctx).length > 0
          && mine(ctx).every((u) => !u.loadout.includes('AAM-A')) },
      { text: '発射したら、目標から離れる向きへ移動を指示する',
        note: 'ここが中距離AAMとの決定的な差。誘導が要らないので、'
          + '撃った瞬間に背を向けて構いません。ミサイルは自分で当たりに行きます',
        done: 'order:move' },
      // 「撃墜」までは求めない。相手はフレアを撒き、回避もする。
      // 2発しか積めない兵装（スロット2×2）なので、外れ続けると行き止まりになる。
      // ここで見せたいのは**背を向けても誘導が続いていること**なので、命中で足りる。
      { text: '離れたまま、ミサイルが当たるのを見届ける',
        note: '中距離AAMなら、ここで背を向けた時点で外れています。'
          + '**チャフやビーム機動には中距離AAMと同じように騙されます** — '
          + 'この兵装の値打ちは、避けにくさではなく「撃ったら自由に動ける」ことです。'
          + '外れたらもう1発撃ってください',
        check: (ctx) => {
          const u = unit(ctx, 'BANDIT 1');
          return (!!u && (!u.alive || u.hp < u.maxHp)) || spentAll('AAM-A')(ctx);
        } },
    ],
  },

  // ================================================================ 兵装5
  {
    id: 'w5',
    group: '兵装',
    name: 'AGM 空対地ミサイル',
    title: '射程の外から叩く',
    brief: '地上目標を遠くから撃つためのミサイルです。射程14km、撃ちっぱなし。\n'
      + '高度を上げても射程はあまり伸びません（対レーダーミサイルとの違い）。\n'
      + 'コスト5・スロット2。対地攻撃の主力になります。',
    hint: '目標は撃ち返してきません。',
    terrain: { seed: 90015, mountainAmount: 0.8, coast: 'none', valleyDepth: 0.8, rivers: 2, baseAltitude: 420 },
    weaponPoints: 20,
    noFail: true,
    friendly: {
      base: { x: 11000, z: 40000 },
      startAirborne: true,
      startAlt: 4000,
      // 自動発射を切る（§49）。入れたままだと、指定の手順に着く前に
      // AI が2発とも撃ってしまい、手順「AGM を発射する」が起こせなくなる。
      aircraft: [{ type: 'A-3', name: 'ANVIL 1', loadout: ['AGM', 'AGM'],
        autoWeapons: { AGM: false, GUN: false } }],
    },
    enemy: {
      aircraft: [],
      ground: [
        { type: 'RADAR', name: 'レーダーサイト', x: 30000, z: 26000, tags: ['target'], known: true },
      ],
    },
    steps: [
      { text: '目標へ攻撃を指示する',
        note: '地上目標はブリーフィングで判明していたので、最初から地図に出ています。'
          + '**攻撃指示が先**。兵装を指定してから右クリックすると射撃指示になり、'
          + '機体はその場から動きません',
        done: 'order:attack' },
      { text: '下のパネルで使用兵装に AGM を指定する',
        note: 'コスト5・スロット2。A-3 は6スロットなので3発積めます',
        done: 'weapon', when: (d) => d.weapon === 'AGM',
        pause: true, highlight: '[data-pick="AGM"]',
        // 指定する前に自動発射で撃ち尽くすと、押すチップが無くなる。行き止まりにしない。
        check: (ctx) => mine(ctx).length > 0
          && mine(ctx).every((u) => !u.loadout.includes('AGM')) },
      { text: 'AGM を発射する',
        note: '兵装を指定した状態で目標を右クリックすると射撃指示になります。'
          + '目標の対空砲（射程3km）の外から撃てます。'
          + 'ただし**低いところから遠射すると途中で失速して届きません** — '
          + '低空なら7〜8km、中高度なら9km あたりが実際に届く距離です',
        done: 'fire', when: (d) => d.weapon === 'AGM',
        check: (ctx) => mine(ctx).length > 0
          && mine(ctx).every((u) => !u.loadout.includes('AGM')) },
      { text: '目標を破壊する',
        note: '撃ちっぱなしなので、撃ったあとは離脱して構いません。'
          + '至近弾でも効きます（爆風60m）',
        check: (ctx) => {
          const u = unit(ctx, 'レーダーサイト');
          return (!!u && !u.alive) || spentAll('AGM')(ctx);
        } },
    ],
  },

  // ================================================================ 兵装6
  {
    id: 'w6',
    group: '兵装',
    // 選択画面のカード名。長いと2行に折り返して並びが崩れるので短く置く。
    // 正式名は title と brief にある。
    name: 'ARM 対レーダー',
    title: '電波を追う',
    brief: '稼働中のレーダーにだけ誘導します。射程22kmで、高度を上げるほど伸びます。\n'
      + '低空からは撃てません（高度2,500m以上が必要）。\n'
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
        note: '2,500m 未満では撃てません。高いほど射程が伸びるので、'
          + 'SAM の外から一方的に叩くには高度が要ります',
        highlight: '[data-alt="7000"]',
        check: (ctx) => mine(ctx).some((u) => u.pos.y >= 6500) },
      { text: 'レーダーサイトへ攻撃を指示する',
        note: '**攻撃指示が先**。兵装の指定はそのあとで行います',
        done: 'order:attack' },
      { text: '下のパネルで使用兵装に ARM を指定する',
        note: 'コスト6・スロット2。高価なので外したくない兵装です',
        done: 'weapon', when: (d) => d.weapon === 'ARM',
        pause: true, highlight: '[data-pick="ARM"]' },
      { text: 'レーダーサイトを右クリックして ARM を撃つ',
        note: '兵装を指定した状態で目標を右クリックすると射撃指示になります。'
          + '電波を出している目標にしか誘導しません。'
          + '電波を出していない対空砲などには使えません',
        done: 'fire', when: (d) => d.weapon === 'ARM',
        check: (ctx) => mine(ctx).length > 0
          && mine(ctx).every((u) => !u.loadout.includes('ARM')) },
      { text: '目標を破壊する',
        note: '相手が電波を止めると誘導が切れます。'
          + 'その場合は最後の座標へ飛ぶので、当たるとしても至近弾になります',
        check: (ctx) => {
          const u = unit(ctx, 'レーダーサイト');
          return (!!u && !u.alive) || spentAll('ARM')(ctx);
        } },
    ],
  },

  // ================================================================ 兵装7
  {
    id: 'w7',
    group: '兵装',
    name: 'BOMB 無誘導爆弾',
    title: '真上を通る',
    brief: 'コスト0で威力は最大（260）。ただし誘導しません。\n'
      + '目標の真上を通って落とす必要があり、投下高度が高いほど散らばります。\n'
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
      { text: '目標へ攻撃を指示する',
        note: '攻撃機は低く入って正確に落とします。'
          + '爆撃機は対空砲の射高より上（2,100m）から入ります。'
          + '**攻撃指示が先**。兵装を指定してから右クリックすると射撃指示になります',
        done: 'order:attack' },
      { text: '下のパネルで使用兵装に BOMB を指定する',
        note: 'コスト0・スロット1。兵装ポイントを一切使いません',
        done: 'weapon', when: (d) => d.weapon === 'BOMB',
        pause: true, highlight: '[data-pick="BOMB"]',
        // 指定する前に自動発射で撃ち尽くすと、押すチップが無くなる。行き止まりにしない。
        check: (ctx) => mine(ctx).length > 0
          && mine(ctx).every((u) => !u.loadout.includes('BOMB')) },
      { text: '爆弾を投下する',
        note: '兵装を指定した状態で目標を右クリックすると投下指示になります。'
          + '投下点は弾道から自動で決まります。'
          + '機首を向けるだけでは落ちません。目標の手前で自然に離れます',
        done: 'fire', when: (d) => d.weapon === 'BOMB',
        check: (ctx) => mine(ctx).length > 0
          && mine(ctx).every((u) => !u.loadout.includes('BOMB')) },
      { text: '目標を破壊する',
        note: '外れたら旋回してもう一度入り直します。'
          + '高い所から落とすほど散らばるので、当てたければ低く入ることです',
        check: (ctx) => {
          const u = unit(ctx, 'レーダーサイト');
          return (!!u && !u.alive) || spentAll('BOMB')(ctx);
        } },
    ],
  },

  // ================================================================ 兵装8
  {
    id: 'w8',
    group: '兵装',
    name: 'TANK 増槽',
    title: '足を伸ばす',
    brief: '武器ではありませんが、スロットを1つ使う搭載品です。燃料が40%増えます。\n'
      + 'コストは0。遠くの目標を叩くとき、往復できるかどうかを決めます。\n'
      + 'スロットを1つ食うので、そのぶん兵装を諦めることになります。',
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
        note: '下のパネルに「燃料 ○分」と出ます。F-1 は無積載で12分です',
        done: 'select' },
      { text: '搭載に TANK を足す',
        note: '下のパネルの「+TANK」。整備が終わると燃料の上限が増えます',
        done: 'loadout', pause: true, highlight: '[data-load-add="TANK"]' },
      { text: '整備を終えて、燃料の持ち時間が増えたことを確認する',
        note: '燃料 +40%。積んだぶんスロットが減り、機動性もわずかに落ちます',
        check: (ctx) => mine(ctx).some((u) => u.loadout.includes('TANK')
          && u.fuelMax > u.spec.fuelSeconds * 1.2) },
      { text: '発進する',
        note: '進出距離の長い任務では、増槽を積むか、途中で帰投して給油するかの'
          + '選択になります',
        done: 'takeoff', highlight: '[data-cmd="launch"]' },
      { text: '増槽を投棄する',
        note: '中身が残っていても、いま落とせます。**旋回率と燃費が戻ります** — '
          + '交戦に入る直前に落とすのが基本です。'
          + '「増槽 自動」にしておけば、使い切った時点で自分で落とします。'
          + '「保持」なら持ち帰るので、付け直す手間が要りません',
        pause: true, highlight: '[data-tankdrop]',
        check: (ctx) => mine(ctx).some((u) => !u.loadout.includes('TANK')) },
    ],
  },
];

/** 終えたチュートリアルか */
export function isTutorialDone(id, done) {
  return Array.isArray(done) && done.includes(id);
}

export function getTutorial(id) {
  return TUTORIALS.find((t) => t.id === id) || null;
}
