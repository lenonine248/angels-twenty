// 飛行場。仕様書 §7。
//
// 役割は3つ。
//   1. レーダー（全方位60km）… GroundUnit から継承
//   2. 滑走路 … 着陸・離陸の経路を提供する。進入から停止までは低速・低高度で無防備
//   3. 整備 … 整備スロット制（既定2機）。補充量に応じて時間がかかり、
//             兵装の再装備はステージ共通の兵装ポイントを消費する
//
// 部分補給を成立させるため、整備は「作業の列」として持ち、
// 完了した分から順に反映する。途中で発進させれば、そこまでの補給で飛べる。

import * as THREE from 'three';
import { GroundUnit } from './ground.js';
import { getWeapon } from '../data/weapons.js';
import { isPlayerOwned } from './unit.js';

/** 進入開始点（滑走路手前）までの距離(m) */
export const APPROACH_DISTANCE = 7000;
/** 進入開始点の対地高度(m) */
export const APPROACH_ALT = 600;
/** 接地点は滑走路始端からこの距離(m) */
const TOUCHDOWN_OFFSET = 250;

// -------------------------------------------------------------- 地上の配置（§97）

/**
 * 飛行場の地上の配置。**駐機位置（ここ）と見た目（`world/models.js`・
 * `world/airfieldview.js`）の両方がこの表を読む。**
 *
 * §97 まではばらばらだった。見た目の滑走路は 1,530m で実際の 2,200m より短く、
 * 離陸の始点も接地点も**絵の滑走路の外**にあった。駐機位置は「着いた順の番号 × 220m」で
 * 草地の上に並び、格納庫はその隣に建っているだけの飾りだった。
 *
 * 局所座標は滑走路の中心が原点。`along` は離陸方向が正（始端 = −長さ/2）、
 * `side` は離陸方向に向かって右が正。単位は m。
 * 格納庫は**始端の側**に並べる —— 発進は始端から滑り出すので、そこまでの道のりを短くする。
 */
export const FIELD = {
  runwayWidth: 180,
  padLength: 110,          // 滑走路の両端の過走帯（始端に並んだ機体の尾がはみ出さない）
  taxiSide: 225,           // 平行誘導路の中心線
  taxiWidth: 50,
  // 途中の取付誘導路（両端にも1本ずつある）。着陸滑走は機種により中心から
  // −300〜+200m で止まるので、その先に1本ずつ置いて行き過ぎの走行を短くする
  exits: [-450, -100, 250, 600],
  hangarCount: 4,
  hangarSide: 375,         // 格納庫の中心
  hangarDepth: 130,        // side 方向の奥行き。扉は誘導路の側
  hangarWidth: 140,        // along 方向の幅
  hangarHeight: 58,
  hangarFirst: 150,        // 始端から1棟目の中心まで
  hangarPitch: 165,        // 棟の間隔
};

/**
 * 空母の格納庫は甲板の下。昇降機に見立てた1か所へ降ろす。
 * 甲板は 0.34 × 1.05（全長 800m の単位空間）で、艦橋は右舷の中ほど。
 */
const CARRIER_HANGAR = { along: 180, side: 40 };

export function isCarrierBase(base) {
  return base.spec?.category === 'carrier';
}

/** 滑走路の長さ。リプレイの飛行場は長さを持っていないので、型の既定に戻す */
export function runwayLengthOf(base) {
  return base.runwayLength ?? (isCarrierBase(base) ? 900 : 2200);
}

/** 局所座標 → 世界座標。y は飛行場の標高 */
export function fieldPoint(base, along, side, out = new THREE.Vector3()) {
  const h = base.runwayHeading ?? base.heading;
  const dx = Math.sin(h), dz = -Math.cos(h);
  // 右手 = (−dz, 0, dx)
  return out.set(
    base.pos.x + dx * along - dz * side,
    base.pos.y,
    base.pos.z + dz * along + dx * side,
  );
}

/** 世界座標 → 局所座標 */
export function fieldLocal(base, p) {
  const h = base.runwayHeading ?? base.heading;
  const dx = Math.sin(h), dz = -Math.cos(h);
  const rx = p.x - base.pos.x, rz = p.z - base.pos.z;
  return { along: rx * dx + rz * dz, side: -rx * dz + rz * dx };
}

export function hangarCount(base) {
  return isCarrierBase(base) ? 1 : FIELD.hangarCount;
}

/** k 番目の格納庫の中心（局所座標） */
export function hangarLocal(base, k) {
  if (isCarrierBase(base)) return { ...CARRIER_HANGAR };
  return {
    along: -runwayLengthOf(base) / 2 + FIELD.hangarFirst + k * FIELD.hangarPitch,
    side: FIELD.hangarSide,
  };
}

/**
 * 点がどの格納庫の中にあるか（無ければ −1）。
 * リプレイは機体の状態を持たないので、位置で「しまわれている」を見分ける。
 */
export function hangarIndexAt(base, p) {
  const l = fieldLocal(base, p);
  for (let k = 0; k < hangarCount(base); k++) {
    const h = hangarLocal(base, k);
    if (Math.abs(l.along - h.along) < 30 && Math.abs(l.side - h.side) < 30) return k;
  }
  return -1;
}

/**
 * 進入路が最も開けている滑走路方位を選ぶ。
 *
 * 飛行場を平坦地に置いても、進入路（手前7km）に丘があると
 * 降下経路が地形を貫通してしまう。16方位を試して、
 * 理想の降下線からの地形のはみ出しが最小になる向きを返す。
 */
/**
 * 飛行場のまわりを均す。
 *
 * **戦闘を組むときと、記録を再生するときの両方で使う**（§23.4）。
 * 別々に書くと、片方の数値だけ変えたときに再生側で滑走路が斜面に乗り、
 * 機体が路面から浮いたり埋まったりする。出どころを1つにしておく。
 */
export function flattenRunway(terrain, x, z, heading, fieldAlt) {
  const dir = { x: Math.sin(heading), z: -Math.cos(heading) };
  terrain.flattenStrip(
    x - dir.x * 2400, z - dir.z * 2400,
    x + dir.x * 1500, z + dir.z * 1500,
    650, fieldAlt, 900,
  );
}

export function pickRunwayHeading(terrain, x, z, distance = APPROACH_DISTANCE) {
  const fieldAlt = Math.max(0, terrain.heightAt(x, z));
  let best = 0, bestScore = Infinity;
  for (let i = 0; i < 16; i++) {
    const h = (i / 16) * Math.PI * 2;
    // 進入は離陸方向の逆側から来る
    const dx = -Math.sin(h), dz = Math.cos(h);
    let score = 0;
    for (let d = 500; d <= distance; d += 500) {
      const g = Math.max(0, terrain.heightAt(x + dx * d, z + dz * d));
      const ideal = fieldAlt + d * 0.065;
      score += Math.max(0, g + 130 - ideal);
    }
    if (score < bestScore) { bestScore = score; best = h; }
  }
  return best;
}

/** 整備作業の所要時間（仕様 §7.1） */
const SERVICE_TIME = {
  fuelFull: 60,       // 空から満タンまで
  gunFull: 15,
  decoy: 10,
  repairPer10Hp: 8,
  weaponSlot: 20,     // 兵装1発（getWeapon().rearmSeconds があればそちら）
  swap: 30,           // 兵装構成を変える場合の追加
};

export class Airbase extends GroundUnit {
  constructor(o) {
    // **型を差し替えられるようにしてある**（§69.3）。
    // 空母（`CARRIER`）は海面に浮かぶ飛行場で、滑走路の平坦化が要らない。
    // 滑走路・進入点・整備の仕組みはそのまま使える —— どれも `pos` から出るので、
    // 陸か海かを区別しているのは平坦化と高度の置き方だけだった。
    super({ ...o, type: o.type || 'AIRBASE' });

    this.runwayHeading = o.runwayHeading ?? 0;   // 離陸方向（0=北）
    this.runwayLength = o.runwayLength ?? 2200;
    this.serviceSlots = o.serviceSlots ?? 2;
    this.heading = this.runwayHeading;           // 3D表示の向きを滑走路に合わせる

    this.queue = [];      // 整備待ちの機体
    this.slots = [];      // {ac, tasks, elapsed}
    /**
     * **友軍機の整備の列**（§102・Q4）。整備枠（`serviceSlots`）の外で、着いた機体を
     * すぐ並行して整備する —— **プレイヤーの積み直しが友軍に遅らされることは無い**。
     * 手順と時間は同じ `buildServicePlan`。
     */
    this.freeQueue = [];
    this.freeSlots = [];
    this.parked = [];     // 着陸済み（整備待ち・整備中・発進待ちすべて）
  }

  // -------------------------------------------------------------- 滑走路

  get runwayDir() {
    return new THREE.Vector3(Math.sin(this.runwayHeading), 0, -Math.cos(this.runwayHeading));
  }

  /** 滑走路始端（離陸開始位置／着陸接地側） */
  get runwayStart() {
    return this.pos.clone().addScaledVector(this.runwayDir, -this.runwayLength / 2);
  }

  get runwayEnd() {
    return this.pos.clone().addScaledVector(this.runwayDir, this.runwayLength / 2);
  }

  get touchdownPoint() {
    return this.runwayStart.clone().addScaledVector(this.runwayDir, TOUCHDOWN_OFFSET);
  }

  /** 進入開始点（ここへ向かってから最終進入に入る） */
  approachFix(terrain) {
    const p = this.runwayStart.clone().addScaledVector(this.runwayDir, -APPROACH_DISTANCE);
    p.y = Math.max(0, terrain.heightAt(p.x, p.z)) + APPROACH_ALT;
    return p;
  }

  /** 滑走路面の高度 */
  get fieldAlt() { return this.pos.y; }

  // -------------------------------------------------------------- 整備

  /** 着陸して停止した機体を受け入れる */
  onArrive(ac) {
    if (this.parked.includes(ac)) return;
    this.parked.push(ac);
    (ac.owner === 'ally' ? this.freeQueue : this.queue).push(ac);
    ac.airbase = this;
    ac.state = 'parked';
    ac.speed = 0;
    // 格納庫へしまう（§97）。いちばん空いている棟の、始端に近いほうから。
    //
    // 以前は「着いた順の番号 × 220m」で並べていた。先に着いた機体が発進すると
    // 番号が詰まり、**次に着いた機体がまだ止まっている機体と同じ所に重なった**。
    // 滑走路からここまでの走行は見た目だけで補う（`world/airfieldview.js`）。
    ac.hangar = this._pickHangar(ac);
    const h = hangarLocal(this, ac.hangar);
    fieldPoint(this, h.along, h.side, ac.pos);
    ac.heading = this.runwayHeading;
  }

  _pickHangar(ac) {
    const n = hangarCount(this);
    const load = new Array(n).fill(0);
    for (const a of this.parked) {
      if (a !== ac && a.alive && a.hangar >= 0 && a.hangar < n) load[a.hangar]++;
    }
    let best = 0;
    for (let k = 1; k < n; k++) if (load[k] < load[best]) best = k;
    return best;
  }

  /**
   * 破壊された瞬間に、駐機中の機体も失われる。
   *
   * `update()` の中で「死んでいたら」と見るやり方は取らない。
   * 死んだユニットの `update` を呼ぶかどうかは呼び出し側の都合で変わり
   * （`tools/bench.js` は生存中のものしか回さない）、
   * **測っている挙動と遊んでいる挙動がずれる**。死んだ瞬間に確実に効かせる。
   */
  destroy(source = null) {
    if (!this.alive) return;
    super.destroy(source);
    this._destroyParked(this._world);
  }

  update(dt, world) {
    this._world = world;
    super.update(dt, world);
    if (!this.alive) {
      // 破壊された飛行場では整備できない
      this.slots.length = 0;
      this.freeSlots.length = 0;
      return;
    }

    // 空きスロットへ順番待ちを入れる
    while (this.slots.length < this.serviceSlots && this.queue.length > 0) {
      const ac = this.queue.shift();
      if (!ac.alive || ac.state === 'takeoff' || ac.state === 'flying') continue;
      this.slots.push({ ac, tasks: buildServicePlan(ac, world), elapsed: 0 });
      ac.state = 'servicing';
    }

    this._runSlots(this.slots, dt, world);

    // 友軍機は枠を待たない（§102）。書いていない面ではどちらも空
    while (this.freeQueue.length > 0) {
      const ac = this.freeQueue.shift();
      if (!ac.alive || ac.state === 'takeoff' || ac.state === 'flying') continue;
      this.freeSlots.push({ ac, tasks: buildServicePlan(ac, world), elapsed: 0 });
      ac.state = 'servicing';
    }
    this._runSlots(this.freeSlots, dt, world);
  }

  _runSlots(slots, dt, world) {
    for (let i = slots.length - 1; i >= 0; i--) {
      const slot = slots[i];
      if (!slot.ac.alive || slot.ac.state === 'takeoff') { slots.splice(i, 1); continue; }
      this._advanceService(slot, dt, world);
      if (slot.tasks.length === 0) {
        slot.ac.state = 'ready';
        slots.splice(i, 1);
        // 整備が終わったら自動で発進する（§32.4）。
        // **操作しなければ従来どおり手動**。指示を出しに戻る手間を省くだけで、
        // 「気づいたら勝手に飛んでいた」にはしない。
        if (slot.ac.autoLaunch) this.launch(slot.ac, world);
      }
    }
  }

  /** 整備の列から外す（ブリーフィングで整備済みとして置く機体・§102 の友軍と増援） */
  dropFromService(ac) {
    this.queue = this.queue.filter((q) => q !== ac);
    this.freeQueue = this.freeQueue.filter((q) => q !== ac);
  }

  /** その機体の整備の枠（友軍の列も見る） */
  _slotOf(ac) {
    return this.slots.find((s) => s.ac === ac) || this.freeSlots.find((s) => s.ac === ac);
  }

  /**
   * 飛行場が壊れたら、そこに止まっている機体も失われる。
   *
   * 数えるのは `parked` に載っている機体だけ。離陸滑走に入った機体は
   * すでに `parked` から外れており、**発進させた判断まで巻き戻さない**。
   *
   * 効き方が大きいのは敵飛行場のほうで、潰せば増援が止まるうえに
   * 駐機中の機体もまとめて落ちる。自軍飛行場は失った時点で
   * 任務が失敗するステージがほとんどなので、こちらへの影響は小さい。
   */
  _destroyParked(world) {
    for (const ac of this.parked.slice()) {
      if (!ac.alive) continue;
      ac.deathCause = '地上撃破';
      ac.damage(ac.hp + 1, this);
      world?.log?.(`${ac.name} 地上で撃破されました`);
    }
    this.parked.length = 0;
    this.queue.length = 0;
    this.freeQueue.length = 0;
  }

  _advanceService(slot, dt, world) {
    let remaining = dt;
    while (remaining > 0 && slot.tasks.length > 0) {
      const task = slot.tasks[0];
      const step = Math.min(remaining, task.time - task.done);
      task.done += step;
      remaining -= step;
      applyContinuous(slot.ac, task, step);
      if (task.done >= task.time - 1e-6) {
        const kind = task.type;
        applyComplete(slot.ac, task, world);
        slot.tasks.shift();
        if (kind === 'weapon' || kind === 'swap') ensureFuelTask(slot);
      }
    }
  }

  /** 搭載内容の変更を受けて整備計画を組み直す */
  replan(ac, world) {
    const slot = this._slotOf(ac);
    if (slot) slot.tasks = buildServicePlan(ac, world);
    else if (ac.state === 'ready') {
      // 整備完了後に積み替えを指示された → 再度スロットに戻す
      ac.state = 'parked';
      const q = ac.owner === 'ally' ? this.freeQueue : this.queue;
      if (!q.includes(ac)) q.push(ac);
    }
  }

  /** 整備の進捗 0..1（UI表示用） */
  serviceProgress(ac) {
    const slot = this._slotOf(ac);
    if (!slot) return null;
    const total = slot.tasks.reduce((n, t) => n + t.time, 0);
    const done = slot.tasks.reduce((n, t) => n + t.done, 0);
    return { remainingSec: total - done, current: slot.tasks[0]?.label ?? '' };
  }

  /**
   * まだ終わっていない整備の内訳。UI の警告用。
   * 「今出すと何が足りないまま出るのか」が分からないと、
   * 部分補給が意図した選択なのか事故なのか区別できない。
   */
  pendingService(ac) {
    const slot = this._slotOf(ac);
    if (!slot) {
      return this.queue.includes(ac) || this.freeQueue.includes(ac)
        ? { kinds: [], remainingSec: null, waiting: true } : null;
    }
    const LABEL = { fuel: '燃料', weapon: '兵装', swap: '兵装', gun: '機銃', decoy: 'デコイ', repair: '修理' };
    const kinds = [];
    for (const t of slot.tasks) {
      const k = LABEL[t.type] || '整備';
      if (!kinds.includes(k)) kinds.push(k);
    }
    if (!kinds.length) return null;
    // これから使う兵装ポイント（§32.6）。
    //
    // 帰投すると**既定の搭載に戻すぶんが黙って引かれていた**。
    // 撃った弾を積み直すだけでも高い兵装ならポイントを食い、
    // クリア評価の「節約」を割る。使う前に見えれば、
    // 「安い兵装に積み替える／このまま出す」を選べる。
    const cost = slot.tasks.reduce(
      (n, t) => n + (t.type === 'weapon' ? (getWeapon(t.weaponId).cost || 0) : 0), 0);
    return {
      kinds,
      cost,
      remainingSec: slot.tasks.reduce((n, t) => n + (t.time - t.done), 0),
      waiting: false,
    };
  }

  /** 機体を発進させる（整備途中でも可＝部分補給） */
  launch(ac, world) {
    if (!this.alive) return false;
    if (ac.state !== 'parked' && ac.state !== 'servicing' && ac.state !== 'ready') return false;

    const si = this.slots.findIndex((s) => s.ac === ac);
    if (si >= 0) this.slots.splice(si, 1);
    const qi = this.queue.indexOf(ac);
    if (qi >= 0) this.queue.splice(qi, 1);
    const fi = this.freeSlots.findIndex((s) => s.ac === ac);
    if (fi >= 0) this.freeSlots.splice(fi, 1);
    const fq = this.freeQueue.indexOf(ac);
    if (fq >= 0) this.freeQueue.splice(fq, 1);
    const pi = this.parked.indexOf(ac);
    if (pi >= 0) this.parked.splice(pi, 1);

    // 帰投にまつわる状態をすべて解く。
    // 残したまま発進させると、AI が「帰投中」のつもりのまま
    // 離陸直後にまた飛行場へ引き返す。
    // **拠点防空の機体は拠点防空へ戻す。** 一律 `PATROL` で上げると
    // 司令官AIの指揮下に戻り、持ち場を離れて追撃に出ていく
    if (ac.aiMode === 'RTB') ac.aiMode = ac.guardHome ? 'GUARD' : 'PATROL';
    ac._winchester = false;
    ac._rtbTriggered = false;
    ac.withdrawing = false;
    const wasRtb = ac.order && ac.order.type === 'rtb';

    // 自動発進は**一度きり**（§32.4）。
    // 残したままにすると、次に帰ってきたときにプレイヤーが忘れているうちに
    // また飛び出す。押した本人がその場で意図した1回だけに効かせる。
    ac.autoLaunch = false;

    ac.state = 'takeoff';
    ac.hangar = -1;
    ac._rotated = false;
    ac.pos.copy(this.runwayStart);
    ac.pos.y = this.fieldAlt;
    ac.heading = this.runwayHeading;
    // 帰投の指示は、**始端へ移してから**その場の待機旋回に戻す（§97.2）。
    // `clearOrders` は現在地で旋回を置くので、移す前に呼ぶと駐機位置が指示の座標になる ——
    // 駐機位置を草地から格納庫へ移しただけで、ベンチの7戦（LONG WATCH 6・COASTAL WALL 1）の結果が動いた
    if (wasRtb) ac.clearOrders();
    ac.speed = 0;
    ac.roll = 0;
    ac.pitch = 0;
    ac.baseLoadout = ac.loadout.slice();
    world.log?.(`${ac.name} 発進`, ac);
    return true;
  }
}

// ---------------------------------------------------------------- 整備計画

/**
 * 整備作業の列を作る。
 * 順序は「燃料 → 兵装 → 機銃/デコイ → 機体修理」。
 * 途中で発進させたときに、最も困る燃料から埋まっているようにするため。
 */
export function buildServicePlan(ac, world) {
  const tasks = [];

  const fuelMissing = 1 - ac.fuelRatio;
  if (fuelMissing > 0.01) {
    tasks.push(task('fuel', '燃料補給', SERVICE_TIME.fuelFull * fuelMissing,
      { amount: ac.fuelMax - ac.fuel }));
  }

  const want = (ac.plannedLoadout ?? ac.baseLoadout ?? []).slice();
  const have = ac.loadout.slice();
  const { add, remove } = loadoutDiff(have, want);

  if (remove.length > 0) {
    tasks.push(task('swap', '兵装積み替え', SERVICE_TIME.swap, { remove }));
  }
  for (const id of add) {
    const w = getWeapon(id);
    tasks.push(task('weapon', `${id} 搭載`, w.rearmSeconds ?? SERVICE_TIME.weaponSlot, { weaponId: id }));
  }

  const gunMissing = 1 - ac.gun / Math.max(1, ac.spec.gunRounds);
  if (gunMissing > 0.02) {
    tasks.push(task('gun', '機銃補充', SERVICE_TIME.gunFull * gunMissing,
      { amount: ac.spec.gunRounds - ac.gun }));
  }
  if (ac.flares < ac.spec.flares || ac.chaff < ac.spec.chaff) {
    tasks.push(task('decoy', 'フレア/チャフ補充', SERVICE_TIME.decoy));
  }

  const hpMissing = ac.maxHp - ac.hp;
  if (hpMissing > 1) {
    tasks.push(task('repair', '機体修理', SERVICE_TIME.repairPer10Hp * (hpMissing / 10),
      { amount: hpMissing }));
  }

  return tasks;
}

function task(type, label, time, extra = {}) {
  return { type, label, time: Math.max(0.1, time), done: 0, ...extra };
}

/**
 * 兵装の積み替えで燃料容量が増えたぶんを、給油作業として足す。
 *
 * 計画は「燃料 → 兵装」の順に組む（途中で発進させたときに、
 * 最も困る燃料から埋まっているようにするため）。そのため
 * **満タンで着陸して増槽を積む**と、計画を立てた時点では `fuelRatio` が 1 なので
 * 給油作業が1つも入らず、そのあと増槽で容量だけが増えて終わっていた。
 * 増槽を積んだのに燃料が増えない、という症状はこれ。
 *
 * 順序は変えない。増槽ぶんの給油は兵装のあとに回る。
 */
function ensureFuelTask(slot) {
  const ac = slot.ac;
  if (ac.fuelRatio >= 0.99) return;
  if (slot.tasks.some((t) => t.type === 'fuel')) return;
  const missing = ac.fuelMax - ac.fuel;
  slot.tasks.push(task('fuel', '燃料補給', SERVICE_TIME.fuelFull * (1 - ac.fuelRatio),
    { amount: missing }));
}

/**
 * 連続的に効く作業（燃料・機銃・修理）を進捗ぶんだけ反映する。
 * 途中で発進させても、そこまでの補給が残るようにするための仕組み。
 */
function applyContinuous(ac, task, step) {
  if (!task.amount) return;
  const delta = task.amount * (step / task.time);
  switch (task.type) {
    case 'fuel':   ac.fuel = Math.min(ac.fuelMax, ac.fuel + delta); break;
    case 'gun':    ac.gun = Math.min(ac.spec.gunRounds, ac.gun + delta); break;
    case 'repair': ac.hp = Math.min(ac.maxHp, ac.hp + delta); break;
    default: break;
  }
}

/** 完了時に一度だけ効く作業 */
function applyComplete(ac, task, world) {
  switch (task.type) {
    case 'fuel':
      ac.fuel = ac.fuelMax;
      break;
    case 'gun':
      ac.gun = ac.spec.gunRounds;
      break;
    case 'repair':
      ac.hp = ac.maxHp;
      break;
    case 'decoy':
      ac.flares = ac.spec.flares;
      ac.chaff = ac.spec.chaff;
      break;
    case 'swap':
      // 降ろした兵装のコストは戻す（積み替えで無駄に消費しないように）
      for (const id of task.remove) {
        const i = ac.loadout.indexOf(id);
        if (i < 0) continue;
        ac.loadout.splice(i, 1);
        const w = getWeapon(id);
        // 財布はプレイヤーの指揮下の機体だけのもの。敵・友軍は引かない・戻さない（§102・§102.4）
        if (w.cost > 0 && world && isPlayerOwned(ac, world)) {
          world.weaponPoints = Math.min(world.weaponPointsMax ?? Infinity,
            (world.weaponPoints ?? 0) + w.cost);
        }
      }
      // 増槽を降ろしたぶん、燃料容量を戻す
      ac.refreshFuelCapacity?.();
      // 降ろした兵装が指定されたままなら外す（§70.3）
      ac.clearSpentSelection?.();
      break;
    case 'weapon': {
      const w = getWeapon(task.weaponId);
      // 敵・友軍の積み直しはプレイヤーの財布から引かない（§102.4。司令官の `_needsRearm` も
      // 予算を無限と見ている）。以前は陣営を見ずに引き、敵が足りないと積めなかった
      if (w.cost > 0 && isPlayerOwned(ac, world)) {
        if ((world.weaponPoints ?? 0) < w.cost) {
          world.log?.(`兵装ポイント不足: ${task.weaponId} を搭載できません`, ac);
          break;
        }
        world.weaponPoints -= w.cost;
      }
      ac.loadout.push(task.weaponId);
      // 増槽を積んだら燃料容量が増える。ここで計算し直さないと反映されない
      ac.refreshFuelCapacity?.();
      break;
    }
    default:
      break;
  }
}

/** 多重集合の差分。have から want にするには何を降ろして何を積むか。 */
export function loadoutDiff(have, want) {
  const pool = have.slice();
  const add = [];
  for (const id of want) {
    const i = pool.indexOf(id);
    if (i >= 0) pool.splice(i, 1);
    else add.push(id);
  }
  return { add, remove: pool };
}
