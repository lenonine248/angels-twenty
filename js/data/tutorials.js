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
        // F-1 は 30km（§61.3 で 40km から縮めた）、自軍飛行場は 30km。
        // ここは進発位置から約43km なので、
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
          + '自動は、**敵機を1機も掴んでいないときと、交戦中と、'
          + '相手のレーダー圏内**で出します',
        done: 'select' },
      { text: '北東の遠方に出ている敵レーダーサイトの印を確かめる',
        note: 'この陣地は約43km 先で、**自機のレーダー（30km）でも'
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
          + 'だからチャフは相手のレーダーを騙すのではなく、視線を遮ります。\n'
          + '隣の「デコイ 自動」を押すと**停止**にできます。'
          + '撒くのをやめると残数は減りませんが、当然かわしにくくなります',
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
          + '勝てない場面から機体を持ち帰るのも指揮官の仕事です。\n'
          + '**地上の対空砲の弾も実体です。** まっすぐ突っ込めば確実に当たりますが、'
          + '横切るように抜けるか蛇行すると当たりにくくなります。'
          + 'いちばん確実なのは射高より上を通ることです',
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
        note: '連携中はレーダーの扇を左右に分担し、同じ敵に重複して撃たなくなります。'
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
          + '守る相手を追い抜かないよう速度を合わせます。'
          + '**近づく敵を迎え撃たせたいなら「護衛」モード**にします（「詳細」で扱います）',
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
        note: '機銃は搭載リストに出ません。スロットも兵装ポイントも使いません。'
          + '**自動使用の切り替えだけは「機銃 自動」という独立したボタン**で並んでいます — '
          + '弾を温存したいときや、近づかせたくないときに切ります',
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
      // 出した指示の戻し方をどこでも教えていなかった（§60.4）。
      // ここに置くのは、この時点なら**まだ射程外**で射撃指示が残り続けるから。
      // 射程内で教えようとすると、取り消す前に撃ってしまって手詰まりになる。
      { text: '敵機を右クリックして射撃指示を出し、「取消」で取り下げる',
        note: '兵装を指定した状態で敵を右クリックすると**射撃指示**になります。'
          + 'いまはまだ遠いので、射程に入るまで指示として残ります。'
          + '**気が変わったら下のパネルの「射撃指示」の行の「取消」で取り下げられます**',
        highlight: '[data-cleartask]',
        check: (ctx) => {
          const all = mine(ctx);
          if (!all.length) return false;
          if (all.some((u) => u.fireTasks && u.fireTasks.length > 0)) { ctx.mem.had = true; return false; }
          return !!ctx.mem.had;
        } },
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
    brief: '地上目標を対空砲の外から撃つためのミサイルです。射程10km、撃ちっぱなし。\n'
      + '高度を上げても射程はあまり伸びません（対レーダーミサイルとの違い）。\n'
      + 'コスト4・スロット2。対地攻撃の主力になります。',
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
        note: 'コスト4・スロット2。A-3 は6スロットなので3発積めます',
        done: 'weapon', when: (d) => d.weapon === 'AGM',
        pause: true, highlight: '[data-pick="AGM"]',
        // 指定する前に自動発射で撃ち尽くすと、押すチップが無くなる。行き止まりにしない。
        check: (ctx) => mine(ctx).length > 0
          && mine(ctx).every((u) => !u.loadout.includes('AGM')) },
      { text: 'AGM を発射する',
        note: '兵装を指定した状態で目標を右クリックすると射撃指示になります。'
          + '**対空砲（射程3km）の外から撃てる**のがこの兵装の値打ちです。'
          + '射程は10km。**表記どおり届きます** — '
          + '以前は14kmと書いてありながら実際は11kmしか飛ばず、'
          + '届かない距離から撃って目標の手前で失速していました（§55）',
        done: 'fire', when: (d) => d.weapon === 'AGM',
        check: (ctx) => mine(ctx).length > 0
          && mine(ctx).every((u) => !u.loadout.includes('AGM')) },
      { text: '目標を破壊する',
        note: '撃ちっぱなしなので、撃ったあとは離脱して構いません。'
          + '**至近弾でも効きます（爆風110m）** — '
          + '多少ずれても無駄弾にならないのが、遠射をあきらめた代わりです',
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

  // ================================================================ 詳細1
  //
  // **3つ目の群（§60.2）。** AIモードは7つあるのに、手順があるのは
  // 連携（t5）と回避優先（t8）の2つだけだった。残り5つは名前すら出てこない。
  // 基本の本に足すと1本が重くなるので、踏み込んだ仕組みを置く群を立てた。
  {
    id: 'x1',
    group: '詳細',
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
          + '任せない1つ（手動）、最後に既定の連携へ戻ります',
        done: 'select' },

      { text: 'AIモードを「哨戒」にする',
        note: '**いまいる場所を中心に旋回して索敵し、14km 以内に入った敵だけ迎え撃ちます。**'
          + '交戦距離が7つのなかでいちばん短く、深追いしません。'
          + '中心はモードを選んだ時点の位置なので、**先に置きたい場所へ動かしてから**選びます。'
          + '守りたい空域があるとき、増援を待ち受けるときに使います',
        done: 'aimode', when: (d) => d.mode === 'PATROL' },

      { text: 'AIモードを「追撃」にする',
        note: '**探知した敵へ 30km 先まで積極的に向かいます。**'
          + '哨戒との違いは踏み込む距離だけで、交戦の仕方は同じです。'
          + '逃がしたくないときに効きますが、'
          + '**深追いして燃料を使い切ることがあります** — 燃料の見張りはAIがしますが、'
          + '帰る距離まで計算はしません',
        done: 'aimode', when: (d) => d.mode === 'PURSUIT' },

      { text: 'AIモードを「回避優先」にする',
        note: '**交戦を避けて低空へ退避します。**'
          + '**逃げる先は「敵から離れる方向」ではなく自軍飛行場です** — '
          + '離れる方向へ逃がすと帰る場所の概念が無く、地図の端に張り付いて終わります。\n'
          + '動き出すのは**探知している敵が 26km 以内にいるとき**。'
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
          + '**守る相手の 26km 以内に入った敵機を、こちらから迎えに行きます。**'
          + '距離を測る基準が**自分ではなく守る相手**なのがこのモードだけの特徴です。\n'
          + '敵の中距離AAMは 14km 前後から飛んでくるので、'
          + 'それより外で動き出さないと必ず撃たれたあとになります。\n'
          + '**守る相手は「随伴している相手」です。** 随伴の指示が無いと哨戒に戻ります',
        done: 'aimode', when: (d) => d.mode === 'ESCORT' },

      { text: 'ANVIL 1 のAIモードを「対地攻撃」にする',
        note: '見えている地上目標へ進撃します。'
          + '**SAM の圏（26km）に入ると自分から低空 600m へ降りて**電波から隠れますが、'
          + '**対レーダーミサイル(ARM)を積んでいるときだけは逆に 8,500m まで上げます** — '
          + 'ARM は高いほど射程が伸びて、SAM の外から撃てるからです。\n'
          + 'ただし**対空砲は逆で、降りるほど当たります**。'
          + '射高が分かっている砲の圏に入りそうなときは、その上を通る高さまで自分で上げます',
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
          + '連携の交戦距離は追撃と同じ 30km で、違いは**編隊で仕事を分けること**です — '
          + '機首の向きを役割ごとにずらして**レーダーの扇を左右に分担**し、'
          + '**同じ敵を重複して狙いません**（1目標につき2機まで）。\n'
          + '**編隊を組んでいないと分担する相手がいない**ので、'
          + '単機では追撃に近い動きになります。編隊の組み方は「編隊とAI」で扱っています。'
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
      startAlt: 5000,
      // **標準の搭載にする。** パネルに出る燃料と枠の数字が、
      // 手順の説明に書いた実測値（9.2 / 11.5 / 13.8分）と噛み合う。
      // 自動発射は切る —— この本では撃たせない。
      aircraft: [
        { type: 'F-1', name: 'VIPER 1', loadout: ['AAM-M', 'AAM-M', 'AAM-S', 'AAM-S'],
          autoWeapons: { 'AAM-M': false, 'AAM-S': false, GUN: false } },
        { type: 'F-2', name: 'HAMMER 1', loadout: ['AAM-M', 'AAM-S', 'AAM-S', 'AGM'],
          autoWeapons: { 'AAM-M': false, 'AAM-S': false, AGM: false, GUN: false } },
        { type: 'A-3', name: 'ANVIL 1', loadout: ['AGM', 'AGM', 'AAM-S', 'AAM-S'],
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
        note: '**速さの機体。** 巡航220・最高334 m/s（AB全開）、'
          + '最良旋回 17.3°/s（5.9G）、600→7,000m の上昇に35秒。'
          + '**3機すべてで最速・最良旋回・最速上昇です。**\n'
          + '代償は**燃料と耐久** —— 標準搭載で 9.2分／122km は3機で最短、'
          + '耐久90 も最低です。**先に着いて、先に撃って、長くは居られない。**',
        // **状態ではなく操作で見る**（§64）。
        // `check` で「VIPER 1 が選ばれている」を見ていたので、
        // **開始時に選択済みだと手順1が一瞬で終わり、説明が読めなかった。**
        // 選択を外して始めるようにしたが、判定のほうも操作で取るのが正しい。
        done: 'select', when: (d) => d.units.length === 1 && d.units[0].name === 'VIPER 1' },

      { text: 'F-1 の AB を「全開」にする',
        note: '**AB は燃料を3倍消します。** 全開のままだと F-1 は **3.1分／61km** しか飛べません。'
          + '速度は +34%（250 → 334 m/s）ですが、滞空は 1/3 になります。\n'
          + '**F-1 の性格はここに出ます** —— 短時間だけ他のどれより速い、という機体です',
        pause: true, highlight: '[data-ab="max"]',
        check: (ctx) => mine(ctx).some((u) => u.name === 'VIPER 1' && u.abMode === 'max') },

      { text: 'F-1 の AB を「温存」に戻す',
        note: '温存＝**ミサイルから逃げるときだけ焚く**。巡航220のまま12分（空荷）飛べます。'
          + '標準＝敵機と交戦するときに焚く、が既定です',
        highlight: '[data-ab="save"]',
        check: (ctx) => mine(ctx).some((u) => u.name === 'VIPER 1' && u.abMode === 'save') },

      { text: 'HAMMER 1（F-2 マルチロール）を選ぶ',
        note: '**電波の機体。** レーダー 34km・扇 80° で、'
          + '**見渡す面積は F-1 の 1.9倍**。3機でいちばん広く見えます。\n'
          + '代償は**速さ** —— 巡航190 は A-3（180）とほぼ同じで、'
          + '**追いつけないし、急いで駆けつけることもできません。**'
          + 'さらに**逆探知される距離が 51km で3機中最長** —— 黙っていられない機体です',
        done: 'select', when: (d) => d.units.length === 1 && d.units[0].name === 'HAMMER 1' },

      { text: 'F-2 のレーダーを「常時ON」にして、前方に出る扇の広さを見る',
        note: 'F-1 は 30km / 55°、A-3 は 22km / 50°。**F-2 だけ明らかに広い**のが画面で分かります。\n'
          + 'ただし探知距離は**見つかる距離でもあります**（射程の1.5倍）。'
          + 'F-2 45km → **51km**、F-1 45km、A-3 33km。'
          + '**いちばん見えて、いちばん見つかる。**',
        done: 'radar', when: (d) => d.mode === 'on' },

      { text: 'F-2 のレーダーを「自動」に戻す',
        note: '自動は、**敵を1機も掴んでいないときは自分から出し**、'
          + '掴んでいるあいだは黙って詰めます。'
          + '見失えばまた出す、という往復になります',
        done: 'radar', when: (d) => d.mode === 'auto' },

      { text: 'ANVIL 1（A-3 攻撃機）を選ぶ',
        note: '**持久の機体。** 耐久160（F-1 の1.8倍）、搭載6枠、燃料18分。'
          + '**標準搭載でも 13.8分／150km** 飛べて、デコイもフレア10・チャフ28 と最多です。\n'
          + '代償は**速さと情報** —— 巡航180・最高195、'
          + 'レーダーは 22km で3機中最短。**遅く、鈍く、遠くが見えない。**',
        done: 'select', when: (d) => d.units.length === 1 && d.units[0].name === 'ANVIL 1' },

      { text: 'A-3 のパネルに「AB」の行が無いことを確かめ、高度を「超高」にする',
        note: '**A-3 はアフターバーナーを積んでいません。** 一時的に速く逃げる手段がない代わりに、'
          + '**全開にしても燃料が減らない**とも言えます。長い作戦を支えているのはここです。\n'
          + 'また上昇限度が 10,000m なので、**「限界」ボタンが出ない唯一の機体**です。'
          + '上昇率も 90 m/s で、600→7,000m に62秒（F-1 の1.8倍）かかります',
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
        note: '巡航は **220 / 190 / 180 m/s**。**同じ指示でも同じようには着きません。**\n'
          + '速度の差は思ったより小さい（1.22倍）のですが、'
          + '分かれるのは**航続**（9.2 / 11.5 / 13.8分）、**レーダー**（30 / 34 / 22km）、'
          + '**旋回**（17.3 / 15.6 / 13.8°/s）です。\n'
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

/** 終えたチュートリアルか */
export function isTutorialDone(id, done) {
  return Array.isArray(done) && done.includes(id);
}

export function getTutorial(id) {
  return TUTORIALS.find((t) => t.id === id) || null;
}
