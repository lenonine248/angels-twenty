// 地上・水上ユニット。
// P3時点では「探知される側」としての振る舞い（レーダー放射・沈黙・移動）だけを持つ。
// 交戦処理（SAM発射・AAA弾幕）は P6 で追加する。

import * as THREE from 'three';
import { Unit, headingOf, RWR_SIGNATURE_FACTOR } from './unit.js';
import { getGroundType } from '../data/ground.js';
import { WEAPONS } from '../data/weapons.js';
import { effectiveMissileRange } from '../core/atmosphere.js';
import { clamp } from '../core/rng.js';
import { Bullet, aimPointOf } from './bullet.js';

/** 弾幕の計算用（毎tick確保しない） */
const _aim = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _shot = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _muzzle = new THREE.Vector3();

/** 砲口の高さ(m)。地面から撃つと自分の足元の起伏に当たって消える */
const MUZZLE_HEIGHT = 25;

/**
 * 方向 dir を拡散角 sigma でばらつかせる（combat.js の `scatter` と同じ）。
 * あちらは module-private なので、ここに同じものを置く。
 */
function scatter(dir, sigma, rng, out) {
  const u1 = Math.max(1e-6, rng());
  const rad = Math.sqrt(-2 * Math.log(u1)) * sigma;
  const ang = rng() * Math.PI * 2;
  _right.set(-dir.z, 0, dir.x);
  if (_right.lengthSq() < 1e-8) _right.set(1, 0, 0);
  _right.normalize();
  _up.crossVectors(dir, _right).normalize();
  return out.copy(dir)
    .addScaledVector(_right, Math.cos(ang) * rad)
    .addScaledVector(_up, Math.sin(ang) * rad)
    .normalize();
}

/**
 * ARM の飛来に気づく距離(m) と、沈黙するまでの反応時間(秒)。
 *
 * この2つが ARM の当たりやすさをほぼ決める。
 * 気づく距離を大きく取ると、ARM は必ず遠方で誘導を切られてしまい
 * （残距離に比例した誤差で飛ぶため）一度も当たらない兵装になる。
 * 「気づくのが遅れればそのまま食らう」が成立する距離にしてある。
 */
const ARM_NOTICE_RANGE = 4500;
const ARM_REACTION = 2.5;
/** ARM を回避したあと沈黙を続ける時間(秒) */
const SILENCE_DURATION = 25;
/**
 * 艦船が必要とする水深(m)。これより浅くなったら進まない。
 *
 * 艦船の高さは海面(y=0)固定なので、陸へ乗り上げると**地面にめり込む**。
 * 埋まった目標は見えないうえ、地形に遮られて攻撃もできない
 * （ミッション5の揚陸艦が、標高900mの丘の中まで進んでいた）。
 * 経路の指定を間違えても座礁しないよう、ここで止める。
 */
const SHIP_MIN_DEPTH = 40;

export class GroundUnit extends Unit {
  constructor(o) {
    const spec = getGroundType(o.type);
    super({
      ...o,
      kind: spec.category,
      hp: spec.hp,
      name: o.name || spec.name,
      static: spec.static,
    });

    this.spec = spec;
    this.typeId = spec.id;

    /** レーダーを放射しているか。沈黙させるとRWRに映らないが誘導もできない。 */
    this.radarActive = !!(spec.radar && spec.radar.emits);

    /** 移動ユニットの巡回経路（[{x,z}, ...]）。静止ユニットでは未使用。 */
    this.route = o.route || null;
    this.routeIndex = 0;
    this.speed = 0;

    // 交戦用
    this.reload = 0;
    this.ammo = spec.weapon?.ammo ?? Infinity;
    this._silence = 0;        // 沈黙の残り時間
    this._armTimer = 0;       // ARM を認識してから沈黙するまでの反応時間
    this.firing = false;      // AAA が撃っているか（描画用）
  }

  get emitting() {
    return this.alive && this.radarActive && !!(this.spec.radar && this.spec.radar.emits);
  }

  /** レーダーの探知半径。沈黙中は自軍の探知能力も失う。 */
  /** 逆探知される距離（§30.3）。航空機と同じ規則で、射程の1.5倍 */
  get rwrSignature() {
    return this.radarRange * RWR_SIGNATURE_FACTOR;
  }

  get radarRange() {
    if (!this.spec.radar || !this.radarActive || !this.alive) return 0;
    return this.spec.radar.range;
  }

  setRadarActive(on) {
    if (this.spec.radar && this.spec.radar.canSilence) this.radarActive = on;
  }

  update(dt, world) {
    if (!this.alive) return;
    this._updateCombat(dt, world);
    if (!this.route || this.route.length === 0) return;

    // 巡回経路を辿る（車両・艦船）
    const wp = this.route[this.routeIndex];
    const dx = wp.x - this.pos.x, dz = wp.z - this.pos.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 200) {
      this.routeIndex = (this.routeIndex + 1) % this.route.length;
      return;
    }
    this.heading = headingOf(dx, dz);
    const nx = this.pos.x + (dx / dist) * this.spec.speed * dt;
    const nz = this.pos.z + (dz / dist) * this.spec.speed * dt;

    // 艦船は浅瀬に入らない。岸で止まり、そこから先へは進まない。
    if (this.spec.category === 'ship'
        && world.terrain.heightAt(nx, nz) > -SHIP_MIN_DEPTH) {
      this.speed = 0;
      return;
    }

    this.speed = this.spec.speed;
    this.pos.x = nx;
    this.pos.z = nz;
    this.pos.y = this.spec.category === 'ship'
      ? 0
      : Math.max(0, world.terrain.heightAt(this.pos.x, this.pos.z));
  }

  // -------------------------------------------------------------- 交戦

  _updateCombat(dt, world) {
    const w = this.spec.weapon;
    if (!w || !world.combat) return;
    this.reload = Math.max(0, this.reload - dt);
    if (w.kind === 'sam') this._updateSam(dt, world);
    else if (w.kind === 'aaa') this._updateAaa(dt, world);
  }

  /**
   * SAM。レーダーで捉えた空中目標へ撃ち上げる。
   *
   * 対レーダーミサイル(ARM)の飛来に気づくと反応時間ののち沈黙する。
   * 沈黙すれば ARM の誘導は切れるが、その間は自分も撃てない。
   * 気づくのが遅れれば（＝ARM が既に近い）そのまま食らう。
   */
  _updateSam(dt, world) {
    const armIncoming = world.missiles.some(
      (m) => m.alive && m.target === this && m.guidance === 'arm'
        && !m.lost && m.pos.distanceTo(this.pos) < ARM_NOTICE_RANGE);

    if (armIncoming) {
      this._armTimer += dt;
      if (this._armTimer >= ARM_REACTION) {
        this.radarActive = false;
        this._silence = SILENCE_DURATION;
      }
    } else {
      this._armTimer = 0;
    }

    if (this._silence > 0) {
      this._silence -= dt;
      if (this._silence <= 0) this.radarActive = true;
      return;                                  // 沈黙中は撃てない
    }

    if (!this.radarActive || this.reload > 0 || this.ammo <= 0) return;

    const target = this._pickAirTarget(world);
    if (!target) return;
    world.combat.fireGround(this, target, WEAPONS['SAM-M']);
    this.ammo--;
    this.reload = this.spec.weapon.reloadSeconds;
  }

  /** 交戦可能な空中目標のうち最も近いもの */
  _pickAirTarget(world) {
    const w = this.spec.weapon;
    const sam = WEAPONS['SAM-M'];
    let best = null, bestD = Infinity;
    for (const u of world.units) {
      if (!u.alive || u.side === this.side || u.kind !== 'aircraft' || u.onGround) continue;
      if (!world.detection.isVisible(this.side, u)) continue;

      const agl = u.pos.y - this.pos.y;
      if (agl < w.minAlt || agl > w.maxAlt) continue;      // 射高外

      const d = this.pos.distanceTo(u.pos);
      // 実効射程は目標高度で伸びる（高空にいる機体ほど遠くから狙われる）。
      // 地上発射は飛翔のほとんどが上空なので、目標高度を重めに見る。
      const eff = effectiveMissileRange(sam, this.pos.y * 0.3 + u.pos.y * 0.7);
      if (d > eff * 0.8) continue;
      if (!world.terrain.hasLineOfSight(this.pos, u.pos, 8, 300)) continue;

      if (d < bestD) { bestD = d; best = u; }
    }
    return best;
  }

  /**
   * 対空砲・艦艇の近接防空。**実体弾を撒く**（§51・§22.2 と同じ作り）。
   *
   * ここでやるのは「偏差の狙点を作って、拡散をかけて弾を出す」ことだけ。
   * 当たるかどうかは弾の側（`sim/bullet.js`）が決める。
   *
   * 以前は圏内にいる間ダメージが入り続ける形だった。距離しか見ていないので、
   * **真横を高速で横切る機体と砲口へまっすぐ突っ込む機体が同じだけ削られた**。
   * 実体弾にすると、偏差の誤差（＝目標の横速度と飛翔時間）が効くようになる。
   *
   * `range` と `maxAlt` は交戦の判断として残す。射高が二値なのは意図的で、
   * 「射高より上へ逃げる」は §8 からの設計の柱（`data/ground.js` の注記）。
   */
  _updateAaa(dt, world) {
    const w = this.spec.weapon;
    this.firing = false;

    // 砲は1基しかないので、同時に狙えるのは1目標だけ。最も近い機体を撃つ。
    let target = null, bestD = Infinity;
    for (const u of world.units) {
      if (!u.alive || u.side === this.side || u.kind !== 'aircraft' || u.onGround) continue;
      const agl = u.pos.y - this.pos.y;
      if (agl < 0 || agl > w.maxAlt) continue;
      const d = this.pos.distanceTo(u.pos);
      if (d > w.range || d >= bestD) continue;
      if (!world.detection.isVisible(this.side, u)) continue;
      if (!world.terrain.hasLineOfSight(this.pos, u.pos, 8, 200)) continue;
      bestD = d; target = u;
    }
    if (!target) return;

    // 砲口は地面から少し上に置く。地表ちょうどから撃つと、
    // 自分の足元の起伏に当たって弾が即座に消える。
    _muzzle.set(this.pos.x, this.pos.y + MUZZLE_HEIGHT, this.pos.z);

    // 偏差射撃の狙点。**目標が曲がればその前提が崩れて外れる** —
    // それがこの変更のすべて（§22.2 と同じ理屈）。
    aimPointOf({ pos: _muzzle }, target, w.muzzle, _aim);
    _dir.set(_aim.x - _muzzle.x, _aim.y - _muzzle.y, _aim.z - _muzzle.z).normalize();

    // 発射数は端数を持ち越す。dt が小さいと毎回0発になってしまう。
    this._gunAccum = (this._gunAccum || 0) + w.rps * dt;
    const n = Math.floor(this._gunAccum);
    if (n <= 0) return;
    this._gunAccum -= n;

    const rng = world.rng ? world.rng : Math.random;
    for (let i = 0; i < n; i++) {
      scatter(_dir, w.spread, rng, _shot);
      world.bullets.push(new Bullet({
        pos: _muzzle,
        dir: _shot,
        speed: w.muzzle,
        damage: w.dmg[0] + rng() * (w.dmg[1] - w.dmg[0]),
        shooter: this,
        life: w.life,
      }));
    }
    this.firing = true;
  }

  /** 地表に接地させる（配置時に呼ぶ） */
  groundTo(terrain) {
    this.pos.y = this.spec.category === 'ship'
      ? 0
      : Math.max(0, terrain.heightAt(this.pos.x, this.pos.z));
    return this;
  }
}

/** 陣地を平坦な場所へ寄せる（急斜面に置かないためのヘルパ） */
export function findFlatSpot(terrain, x, z, searchRadius = 1200) {
  let best = { x, z, slope: terrain.slopeAt(x, z) };
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    const r = searchRadius * (0.4 + (i % 3) * 0.3);
    const nx = clamp(x + Math.cos(a) * r, 0, 51200);
    const nz = clamp(z + Math.sin(a) * r, 0, 51200);
    if (terrain.heightAt(nx, nz) < 20) continue;      // 水没地は避ける
    const s = terrain.slopeAt(nx, nz);
    if (s < best.slope) best = { x: nx, z: nz, slope: s };
  }
  return best;
}
