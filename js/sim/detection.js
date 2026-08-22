// 探知システム（フォグ・オブ・ウォー）。仕様書 §4。
//
// 探知の骨格:
//   ・機体レーダー … 機首方向の扇形・長距離・空中目標のみ・地形遮蔽あり・ルックダウン減衰
//   ・目視         … 全方位・短距離・すべての目標・地形遮蔽あり
//   ・地上レーダー … 全方位・固定・空中目標のみ（レーダーサイト/SAM/飛行場）
//   ・電波逆探知   … レーダーを放射中の地上目標を約60kmから捕捉。位置は粗い
//
// 探知結果は Contact として陣営ごとに保持し、陣営内で即時共有される。
// 静止目標は一度探知すれば恒久的に記憶され、破壊確認には再視認が必要になる。

import * as THREE from 'three';
import { angleDiff, headingOf, DEG } from './unit.js';
import { clamp } from '../core/rng.js';

/** 全走査の間隔(秒)。毎フレーム回すには重いので5Hzに落とす。 */
const SCAN_INTERVAL = 0.2;
/**
 * 探知が切れた目標が消えるまでの時間(秒)。
 * 速い目標ほど推測位置がすぐ当てにならなくなるので、種類で変える。
 */
export const LOST_LIFETIME = 10;          // 航空機
export const LOST_LIFETIME_GROUND = 20;   // 地上・水上（低速なので推測が長持ちする）

export function lostLifetimeOf(unit) {
  return unit.kind === 'aircraft' ? LOST_LIFETIME : LOST_LIFETIME_GROUND;
}
/** 電波逆探知の距離(m) */
const RWR_RANGE = 60000;
/**
 * 逆探知の位置誤差(m)。**最大距離のときの値**で、近づくほど縮む（§25.2）。
 *
 *     誤差 = RWR_POS_ERROR × (距離 / RWR_RANGE)
 *
 * 60km で 1,000m、30km で 500m、14km（AGM射程）で 233m。
 * 目視(8km)まで詰めれば 0 になる。
 */
export const RWR_POS_ERROR = 1000;
/** ルックダウン減衰: 目標が自機より低く、地表からこの高度以下なら探知距離が半減 */
const LOOKDOWN_AGL = 1000;
const LOOKDOWN_FACTOR = 0.5;
/** 探知距離のこの割合以内なら即座に識別できる */
const IDENT_RANGE_RATIO = 0.5;
/** 継続追尾でこの秒数を超えたら識別できる */
const IDENT_TRACK_TIME = 10;
/** 地上ユニットが目視で空を見張れる距離(m) */
const GROUND_VISUAL_RANGE = 5000;
/** 探知の視線判定のサンプル間隔(m)。ミサイルより粗くてよい。 */
const LOS_STEP = 400;
/** 地上レーダーが満額の探知距離を出せる対地高度(m) */
const GROUND_RADAR_FULL_ALT = 3000;
/** 地上レーダーの最低倍率（地表すれすれでもこれだけは見える） */
const GROUND_RADAR_FLOOR = 0.4;

export const LEVEL = { UNKNOWN: 0, IDENTIFIED: 1, DETAILED: 2 };

/** 陣営が保持する目標1件の認識。実体(unit)への参照は内部処理専用。 */
export class Contact {
  constructor(unit, time) {
    this.unit = unit;
    this.id = unit.id;
    this.pos = new THREE.Vector3().copy(unit.pos);
    this.heading = unit.heading;
    this.speed = unit.speed || 0;

    this.level = LEVEL.UNKNOWN;
    this.detected = false;
    this.exactNow = false;
    /**
     * いま持っている座標が逆探知由来（±RWR_POS_ERROR ぶれている）か。
     * `exactNow` は「今この瞬間に精密に見えているか」なので、
     * 「見えていないが座標は正確」（ブリーフィングで判明していた目標や、
     * 一度目視した静止目標の記憶）と区別できない。表示を分けるにはこれが要る。
     */
    this.approx = false;
    /**
     * いま持っている座標の誤差(m)。0 なら正確。
     *
     * **いちばん良かった測定値を残す**（§25.3）。一度詰めて掴んだ精度は、
     * 離れても保つ。これで「一度詰めて測り、離れて撃つ」が成立する。
     * ただし**静止目標だけ**。動くものの位置は覚えていても古くなるだけなので、
     * そのつどの測定で置き換える。
     */
    this.err = Infinity;
    this.ever = false;
    this.firstSeen = time;
    this.trackStart = time;
    this.lastSeen = time;
    /** 記憶目標へ攻撃を加えたが着弾を誰も見ていない状態 */
    this.attacked = false;
    this._offset = null;
  }

  /** 現在の状態: contact(探知中) / memory(記憶) / lost(ロスト中) */
  get state() {
    if (this.detected) return 'contact';
    if (this.unit.static && this.ever) return 'memory';
    return 'lost';
  }

  /** 記憶目標で、攻撃したが生死を確認できていない */
  get unconfirmed() {
    return !this.detected && this.attacked && this.unit.static;
  }

  observe(unit, time, level, exact, dist = 0) {
    if (!this.detected) this.trackStart = time;      // 追尾開始
    this.detected = true;
    this.ever = true;
    this.lastSeen = time;

    let lv = level;
    if (time - this.trackStart >= IDENT_TRACK_TIME) lv = Math.max(lv, LEVEL.IDENTIFIED);
    this.level = Math.max(this.level, lv);

    this.exactNow = exact;
    if (exact) {
      this.pos.copy(unit.pos);
      this.err = 0;
    } else {
      // 逆探知だけの間は位置がぶれる。ズレの向きは機体IDから決まる固定値で、
      // 大きさだけが距離で縮む。向きまで揺らすと印がふらついて読めない。
      if (!this._offset) this._offset = deterministicOffset(unit.id, 1);
      const mag = RWR_POS_ERROR * clamp(dist / RWR_RANGE, 0, 1);
      if (!unit.static) {
        // 動く目標は覚えても古くなる。そのつど置き換える
        this._place(unit, mag);
      } else if (mag < this.err) {
        // 静止目標は「これまででいちばん良い測定」を残す
        this._place(unit, mag);
      }
    }
    this.approx = this.err > 0;
    this.heading = unit.heading;
    this.speed = unit.speed || 0;
    this.attacked = false;      // 見えている＝状態は確定している
  }

  /** 誤差 mag で座標を置く */
  _place(unit, mag) {
    this.err = mag;
    this.pos.set(
      unit.pos.x + this._offset.x * mag,
      unit.pos.y,
      unit.pos.z + this._offset.z * mag,
    );
  }

  /** ロスト中の推測進路（デッドレコニング） */
  extrapolate(dt) {
    if (this.detected || this.unit.static) return;
    this.pos.x += Math.sin(this.heading) * this.speed * dt;
    this.pos.z += -Math.cos(this.heading) * this.speed * dt;
  }
}

export class DetectionSystem {
  constructor(world) {
    this.world = world;
    this.time = 0;
    this._accum = SCAN_INTERVAL;      // 初回は即座に走査する
    this.contacts = { blue: new Map(), red: new Map() };
    this.stats = { scans: 0, losChecks: 0, lastScanMs: 0 };
  }

  update(dt) {
    this.time += dt;
    this._accum += dt;
    if (this._accum >= SCAN_INTERVAL) {
      this._scan();
      this._accum = 0;
    }
    this._age(dt);
  }

  contactsFor(side) { return this.contacts[side]; }

  /**
   * その陣営が、その飛来ミサイルを画面に出せるか（§28.3）。
   *
   * **自軍の弾は常に見える。** 撃った弾がどう飛んだかは、
   * 命中期待度を学ぶ唯一の手がかりなので隠さない。
   *
   * 敵の弾は「気づける範囲」に入ったときだけ。判定の基準は
   * `sim/combat.js` の `WARN_RANGE`（レーダー弾14km／赤外線弾5km）と同じで、
   * **AI が反応できる範囲とプレイヤーに見える範囲を一致させる**。
   * ここがずれていると「なぜ AI は避けないのか」が説明できない。
   *
   * 目視（8km）でも見える。近くを通り過ぎる弾は、狙われていなくても見えるべき。
   */
  missileVisible(side, m, warnRange) {
    if (!m || !m.alive) return false;
    if (m.side === side) return true;
    // アクティブレーダー弾は、シーカーを入れるまで存在を知られない（§28.2）
    const silent = m.active === false;
    const warn = m.guidance === 'ir' ? warnRange.ir : warnRange.radar;
    for (const u of this.world.units) {
      if (u.side !== side || !u.alive) continue;
      if (u.kind !== 'aircraft') continue;
      const d = m.pos.distanceTo(u.pos);
      if (!silent && m.target === u && d <= warn) return true;      // 自分が狙われている
      const vis = u.spec && u.spec.visualRange ? u.spec.visualRange : 0;
      if (vis > 0 && d <= vis) return true;                          // 目視
    }
    return false;
  }

  /** その陣営がこのユニットを画面に出せるか */
  isVisible(side, unit) {
    if (unit.side === side) return unit.alive;
    return this.contacts[side].has(unit.id);
  }

  /**
   * 攻撃を加えたことを記録する。
   * 目標が見えていれば次の走査(observe)で即座に打ち消されるので、
   * 「着弾を誰も見ていない攻撃」だけが状態不明として残る。
   */
  markAttacked(side, unit) {
    const c = this.contacts[side].get(unit.id);
    if (c) c.attacked = true;
  }

  // -------------------------------------------------------------- 走査

  _scan() {
    const t0 = performance.now();
    const { units, terrain } = this.world;

    for (const side of ['blue', 'red']) {
      const map = this.contacts[side];
      const sensors = units.filter((u) => u.side === side && u.alive);

      for (const target of units) {
        if (target.side === side) continue;
        // 死んだ静止目標も走査対象に残す（見に行けば破壊を確認できる）
        const trackable = target.alive || (target.static && map.has(target.id));
        if (!trackable) continue;

        let best = -1, exact = false, near = Infinity;
        for (const s of sensors) {
          const r = evaluate(s, target, terrain, this.stats);
          if (r.level < 0) continue;
          // 誤差は距離で決まるので、**捉えているうちで最も近い**センサーを使う
          const d = s.pos.distanceTo(target.pos);
          if (d < near) near = d;
          if (r.level > best) { best = r.level; exact = r.exact; }
          else if (r.level === best && r.exact) exact = true;
          // DETAILED は目視でしか出ず、目視は必ず exact なのでここで打ち切ってよい
          if (best === LEVEL.DETAILED) break;
        }

        const c = map.get(target.id);
        if (best >= 0) {
          if (!target.alive) { map.delete(target.id); continue; }   // 破壊を確認した
          if (c) c.observe(target, this.time, best, exact, near);
          else {
            const nc = new Contact(target, this.time);
            nc.observe(target, this.time, best, exact, near);
            map.set(target.id, nc);
          }
        } else if (c) {
          c.detected = false;
        }
      }
    }
    this.stats.scans++;
    this.stats.lastScanMs = performance.now() - t0;
  }

  _age(dt) {
    for (const side of ['blue', 'red']) {
      const map = this.contacts[side];
      for (const [id, c] of map) {
        // 見ている前で撃破された目標はその場で消す（撃破の瞬間を見ているので確定）
        if (!c.unit.alive && c.detected) { map.delete(id); continue; }
        if (c.detected) continue;
        if (c.state === 'memory') continue;                 // 静止目標は消えない
        c.extrapolate(dt);
        if (this.time - c.lastSeen > lostLifetimeOf(c.unit)) map.delete(id);
      }
    }
  }
}

// -------------------------------------------------------------- センサー判定

/** センサー1基が目標をどこまで見えているか。level=-1 は未探知。 */
function evaluate(sensor, target, terrain, stats) {
  let best = -1, exact = false;

  const visual = byVisual(sensor, target, terrain, stats);
  if (visual > best) { best = visual; exact = true; }

  if (best < LEVEL.DETAILED) {
    const radar = byRadar(sensor, target, terrain, stats);
    if (radar > best) { best = radar; exact = true; }
  }

  if (best < LEVEL.IDENTIFIED) {
    const rwr = byRwr(sensor, target, terrain, stats);
    if (rwr > best) { best = rwr; exact = false; }
  }

  return { level: best, exact };
}

/** 目視: 全方位・短距離・地形遮蔽あり。見えれば機種まで分かる。 */
function byVisual(sensor, target, terrain, stats) {
  const range = sensor.kind === 'aircraft'
    ? (sensor.spec.visualRange || 0)
    : GROUND_VISUAL_RANGE;
  if (range <= 0) return -1;
  if (sensor.pos.distanceTo(target.pos) > range) return -1;
  stats.losChecks++;
  if (!terrain.hasLineOfSight(sensor.pos, target.pos, 8, LOS_STEP)) return -1;
  return LEVEL.DETAILED;
}

/**
 * レーダー: 空中目標のみ。
 * 機体レーダーは機首方向の扇形、地上レーダー／AWACSは全方位。
 */
function byRadar(sensor, target, terrain, stats) {
  if (target.kind !== 'aircraft') return -1;      // 地上目標はレーダーに映らない
  if (target.onGround) return -1;                 // 駐機・滑走中の機体も地上物扱い

  let range, fovH = null, fovV = null;
  if (sensor.kind === 'aircraft') {
    // 切っていれば 0（§26.4）。地上ユニットと同じく実際の値を見る
    range = sensor.radarRange || 0;
    if (!sensor.spec.omniRadar) {
      fovH = (sensor.spec.radarFovH || 60) * DEG;
      fovV = (sensor.spec.radarFovV || 30) * DEG;
    }
  } else {
    range = sensor.radarRange || 0;               // 沈黙中は 0
    // 地上レーダーは低空目標を地面反射に紛れて捉えにくい。
    // 低空侵入の見返りをここで作る（対地3,000mで満額、500mで約4割）。
    if (range > 0 && target.kind === 'aircraft') {
      const agl = target.pos.y - Math.max(0, terrain.heightAt(target.pos.x, target.pos.z));
      const f = Math.pow(clamp(agl / GROUND_RADAR_FULL_ALT, 0, 1), 1.7);
      range *= GROUND_RADAR_FLOOR + (1 - GROUND_RADAR_FLOOR) * f;
    }
  }
  if (range <= 0) return -1;

  const dx = target.pos.x - sensor.pos.x;
  const dz = target.pos.z - sensor.pos.z;
  const dy = target.pos.y - sensor.pos.y;
  const flat = Math.hypot(dx, dz);

  // ルックダウン減衰: 低空の目標は地面反射に紛れて探知距離が落ちる
  const targetAgl = target.pos.y - Math.max(0, terrain.heightAt(target.pos.x, target.pos.z));
  if (dy < 0 && targetAgl < LOOKDOWN_AGL) range *= LOOKDOWN_FACTOR;

  const dist = Math.hypot(flat, dy);
  if (dist > range) return -1;

  if (fovH !== null) {
    if (Math.abs(angleDiff(headingOf(dx, dz), sensor.heading)) > fovH) return -1;
    if (Math.abs(Math.atan2(dy, Math.max(1, flat))) > fovV) return -1;
  }

  stats.losChecks++;
  if (!terrain.hasLineOfSight(sensor.pos, target.pos, 8, LOS_STEP)) return -1;

  return dist < range * IDENT_RANGE_RATIO ? LEVEL.IDENTIFIED : LEVEL.UNKNOWN;
}

/**
 * 電波逆探知(RWR): レーダーを放射中の地上・水上目標を遠距離から捕捉する。
 * 種別は分かるが位置は粗い。沈黙されれば消える。
 */
function byRwr(sensor, target, terrain, stats) {
  if (sensor.kind !== 'aircraft') return -1;       // 逆探知装置は機体側
  if (!target.emitting) return -1;

  // 航空機は**そのレーダーの強さで見つかる距離が変わる**（§26.3）。
  // 地上の放射源は据え付けの大出力なので、従来どおり一律 60km。
  const range = target.kind === 'aircraft' ? target.rwrSignature : RWR_RANGE;
  if (range <= 0) return -1;
  if (sensor.pos.distanceTo(target.pos) > range) return -1;
  stats.losChecks++;
  if (!terrain.hasLineOfSight(sensor.pos, target.pos, 8, LOS_STEP)) return -1;

  // 航空機は「そこで何かが電波を出している」までしか分からない（§26.7）。
  // 逆探知は全方位なので、ここで機種まで分かると**機首を向けて探す**という
  // 探知の骨格（§3）が丸ごと要らなくなる。撃つには結局レーダーを向ける必要がある
  // （AI の目標選択は IDENTIFIED 以上を要求する）。
  return target.kind === 'aircraft' ? LEVEL.UNKNOWN : LEVEL.IDENTIFIED;
}

/**
 * ユニットIDから決まる固定のズレの**向き**（長さは 0.45〜1.0 の係数）。
 * 逆探知の位置がふらつかないようにするため、向きは最後まで変えない。
 * 大きさは呼ぶ側が距離から決める（§25.2）。
 */
function deterministicOffset(id, magnitude) {
  let h = Math.imul(id ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13;
  const a = ((h >>> 0) / 4294967296) * Math.PI * 2;
  const r = magnitude * (0.45 + ((Math.imul(h, 0xc2b2ae35) >>> 0) / 4294967296) * 0.55);
  return { x: Math.cos(a) * r, z: Math.sin(a) * r };
}
