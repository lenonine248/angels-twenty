// 地上・水上ユニット。
// P3時点では「探知される側」としての振る舞い（レーダー放射・沈黙・移動）だけを持つ。
// 交戦処理（SAM発射・AAA弾幕）は P6 で追加する。

import { Unit, headingOf } from './unit.js';
import { getGroundType } from '../data/ground.js';
import { WEAPONS } from '../data/weapons.js';
import { effectiveMissileRange } from '../core/atmosphere.js';
import { clamp } from '../core/rng.js';

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
    this.speed = this.spec.speed;
    this.pos.x += (dx / dist) * this.speed * dt;
    this.pos.z += (dz / dist) * this.speed * dt;
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
   * 対空砲・艦艇の近接防空。
   * 弾幕なので命中判定はせず、圏内にいる間ダメージが入り続ける。
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

    const falloff = 1 - (bestD / w.range) * 0.6;
    const rng = world.rng ? world.rng() : Math.random();
    target.damage(w.dps * falloff * dt * (0.5 + rng), this);
    this.firing = true;
    if (rng < 0.06) world.effects?.tracer(this.pos, target.pos, this.side);
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
