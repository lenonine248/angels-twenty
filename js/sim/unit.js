// ユニット基底クラス。
// 戦闘機・SAM・飛行場・地上部隊など、フィールド上のすべての戦力の共通部分。

import * as THREE from 'three';

let nextId = 1;

export const SIDE = { BLUE: 'blue', RED: 'red' };

export class Unit {
  /**
   * @param {object} o
   * @param {string} o.side   'blue' | 'red'
   * @param {string} o.kind   'aircraft' | 'sam' | 'aaa' | 'radar' | 'airbase' | 'ground' | 'ship'
   */
  constructor(o) {
    this.id = nextId++;
    this.side = o.side;
    this.kind = o.kind;
    this.name = o.name || `${o.kind}-${this.id}`;

    this.pos = new THREE.Vector3(o.x || 0, o.y || 0, o.z || 0);
    this.heading = o.heading || 0;      // 0=北, 時計回り(ラジアン)

    this.maxHp = o.hp || 100;
    this.hp = this.maxHp;
    this.alive = true;

    /** 移動しない目標か（true なら一度探知した位置が恒久的に記憶される） */
    this.static = o.static ?? false;

    /** ミッション目標の判定に使うタグ（data/stages.js が付ける） */
    this.tags = o.tags ? o.tags.slice() : [];

    /** 3D表示オブジェクト（world/models.js が設定する） */
    this.view = null;
  }

  get x() { return this.pos.x; }
  get z() { return this.pos.z; }
  get alt() { return this.pos.y; }

  /** 水平距離(m) */
  distanceTo(other) {
    return Math.hypot(other.pos.x - this.pos.x, other.pos.z - this.pos.z);
  }

  /** 3D距離(m) */
  distance3To(other) {
    return this.pos.distanceTo(other.pos);
  }

  /** 進行方向の単位ベクトル（水平） */
  forward(out = new THREE.Vector3()) {
    return out.set(Math.sin(this.heading), 0, -Math.cos(this.heading));
  }

  damage(amount, source = null) {
    if (!this.alive) return;
    this.hp -= amount;
    if (this.hp <= 0) {
      this.hp = 0;
      this.destroy(source);
    }
  }

  destroy(_source = null) {
    this.alive = false;
  }
}

/** 方位ベクトル(dx,dz) → 方位角ラジアン（0=北, 時計回り） */
export function headingOf(dx, dz) {
  return Math.atan2(dx, -dz);
}

/** 角度差を -PI..PI に正規化 */
export function angleDiff(a, b) {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

export const DEG = Math.PI / 180;
