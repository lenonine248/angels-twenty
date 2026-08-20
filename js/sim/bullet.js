// 機銃の弾。仕様書 §22.2。
//
// 命中率という数値は持たない。弾を実体として飛ばし、当たり判定で決める。
// 当てにくさは2つに分けて表現する:
//
//   拡散角   遠いほど散る                → 距離による当てにくさ
//   弾速     飛翔時間 → 偏差(リード)の誤差 → **動く目標**への当てにくさ
//
// この分け方で、狙っていた差が仕掛けなしに出る。
//   ・旋回中の敵には当たらない／直進している敵には当たる … 弾速が効く
//   ・地上目標には当たる … 静止しているので偏差が0。拡散だけが効く
//   ・後ろに付くと当たる … 相対的な角速度が小さく、偏差の誤差が小さい
//
// **射程を宣言しない**（§22.2.1）。弾は全機共通の秒数で消え、
// 射程は「初速 × 寿命」で決まる。対空・対地で分けない。
// 対空の実効射程が短いのは、拡散と偏差の誤差が距離とともに増える**結果**。
// 撃つのをやめる判断は sim/combat.js のしきい値が担う。

import * as THREE from 'three';
import { clamp } from '../core/rng.js';

/**
 * 弾の寿命(秒)。**全機共通**。
 * 減速は入れない。速度に比例した減速を入れると寿命が同じでも射程が初速に比例し、
 * いちばん対地をやる A-3（弾速700）の射程がいちばん短くなる（§22.2.1）。
 */
export const BULLET_LIFE = 3.0;

/** 毎秒発射数（全機共通） */
export const GUN_RPS = 25;

/**
 * 航空機の当たり半径(m)。
 *
 * 機体の実寸は全長15m前後だが、**画面上の機影は誇張表示している**（§10.3）。
 * 判定を見た目に合わせると、引きの画では数百mの当たり判定になってしまう。
 * ここは実寸側に寄せて固定値にする。曳光弾の見た目と厳密には一致しないが、
 * 一致させるほうの代償が大きい。
 */
export const AIR_HIT_RADIUS = 10;

/**
 * 地上目標の当たり半径は `spec.size` から作る。
 * 爆風の判定（missile.js の SIZE_FOOTPRINT）と同じ 0.25 倍を使い、
 * 「この目標はどれくらいの的か」の基準をゲーム内で1つに保つ。
 */
export const GROUND_FOOTPRINT = 0.25;

/** 当たり半径 */
export function hitRadiusOf(unit) {
  if (unit.kind === 'aircraft' && !unit.onGround) return AIR_HIT_RADIUS;
  return Math.max(AIR_HIT_RADIUS, (unit.spec?.size || 120) * GROUND_FOOTPRINT);
}

const _v = new THREE.Vector3();
const _seg = new THREE.Vector3();
const _rel = new THREE.Vector3();

export class Bullet {
  /**
   * @param {object} o
   * @param {THREE.Vector3} o.pos 発射位置
   * @param {THREE.Vector3} o.dir 進行方向（単位ベクトル・拡散適用済み）
   * @param {number} o.speed 初速(m/s)
   * @param {number} o.damage 命中1発あたりのダメージ
   * @param {object} o.shooter 撃った機体
   */
  constructor(o) {
    this.pos = o.pos.clone();
    this.prev = this.pos.clone();
    this.vel = o.dir.clone().multiplyScalar(o.speed);
    this.speed = o.speed;
    this.damage = o.damage;
    this.shooter = o.shooter;
    this.side = o.shooter.side;
    this.life = BULLET_LIFE;
    this.alive = true;
    /** 当たった相手（演出用。命中の瞬間だけ入る） */
    this.hit = null;
  }

  update(dt, world) {
    if (!this.alive) return;
    this.life -= dt;
    if (this.life <= 0) { this.alive = false; return; }

    this.prev.copy(this.pos);
    this.pos.addScaledVector(this.vel, dt);

    // 地面に当たったら消える。対地掃射の外れ弾がどこへ行ったか分かる。
    const ground = Math.max(0, world.terrain.heightAt(this.pos.x, this.pos.z));
    if (this.pos.y <= ground) {
      this.pos.y = ground;
      this.alive = false;
      this.hitGround = true;
      world.onBulletGround?.(this);
      return;
    }

    // 通り過ぎた区間で当たっていないかを見る。
    // 1ステップで最大 33m 進むので、点で判定すると小さい目標をすり抜ける。
    for (const u of world.units) {
      if (!u.alive || u.side === this.side) continue;
      if (u === this.shooter) continue;
      const r = hitRadiusOf(u);
      if (segmentDistanceTo(this.prev, this.pos, u.pos, r) > r) continue;
      u.damage(this.damage, this.shooter);
      this.alive = false;
      this.hit = u;
      world.onBulletHit?.(this, u);
      return;
    }
  }
}

/**
 * 線分と点の最短距離。
 * bail を超えることが早い段階で分かれば打ち切る（弾は多いので効く）。
 */
function segmentDistanceTo(a, b, p, bail) {
  _seg.subVectors(b, a);
  _rel.subVectors(p, a);
  const len2 = _seg.lengthSq();
  if (len2 < 1e-6) return _rel.length();
  // 粗いふるい: 線分の中点から遠ければ当たりようがない
  const t = clamp(_rel.dot(_seg) / len2, 0, 1);
  _v.copy(a).addScaledVector(_seg, t);
  return _v.distanceTo(p);
}

/**
 * 目標の速度ベクトル。偏差（リード）の計算に使う。
 * 航空機はピッチぶんの上下成分も持たせる。
 */
export function velocityOf(unit, out = new THREE.Vector3()) {
  const s = unit.speed || 0;
  if (!s) return out.set(0, 0, 0);
  const p = unit.pitch || 0;
  const cp = Math.cos(p);
  return out.set(
    Math.sin(unit.heading) * cp * s,
    Math.sin(p) * s,
    -Math.cos(unit.heading) * cp * s,
  );
}

const _tv = new THREE.Vector3();
const _aim = new THREE.Vector3();

/**
 * 偏差射撃の狙点。
 *
 * 「目標がまっすぐ飛び続ける」前提で、弾と目標が出会う点を求める。
 * 目標が曲がればその前提が崩れ、飛翔時間の2乗に比例して外れる。
 * **その外れこそが弾速の差** なので、ここで曲がりを織り込んではいけない。
 */
export function aimPointOf(shooter, target, bulletSpeed, out = new THREE.Vector3()) {
  velocityOf(target, _tv);
  let t = shooter.pos.distanceTo(target.pos) / bulletSpeed;
  // 2回まわせば十分収束する（弾は目標よりずっと速い）
  for (let i = 0; i < 2; i++) {
    _aim.copy(target.pos).addScaledVector(_tv, t);
    t = shooter.pos.distanceTo(_aim) / bulletSpeed;
  }
  return out.copy(target.pos).addScaledVector(_tv, t);
}
