// ミサイルとデコイ。仕様書 §5.0 / §5.4 / §6.2。
//
// ミサイルは実体としてシミュレートする。確率で当否を決めないので、
//   ・急旋回で振り切れる（シーカーの旋回率に上限がある）
//   ・射程ギリギリでは失速して失推する（推進終了後は減速し続ける）
//   ・山陰に入るとシーカーが見失う
//   ・セミアクティブ(AAM-M)は発射機がレーダーで照射し続けないと誘導が切れる
// といった挙動が自然に出る。回避AIもこの実体に対して機動する。

import * as THREE from 'three';
import { clamp } from '../core/rng.js';
import { missileDragFactor } from '../core/atmosphere.js';

/**
 * 直撃と判定する距離(m)。**目標の大きさを足して使う**（`hitRadii`）。
 *
 * 航空機なら全長15m前後なので、この値そのままでよい。
 * だが地上目標は桁が違う（レーダーサイト220m・飛行場900m）。
 * 中心から25mでしか直撃にしないと、220mの施設のど真ん中に落ちた弾が
 * 「至近弾」に化ける。実測で ARM 2発が命中して 97 ダメージしか出ず、
 * 120HP のレーダーサイトが生き残っていた（直撃なら1発160で落ちる）。
 *
 * 目標の大きさの扱いは、爆風(`_blast`)も機銃(`sim/bullet.js`)も
 * `spec.size * 0.25` で揃えている。ここだけ無視していた。
 */
const DIRECT_HIT = 25;
/** 近接信管の作動半径(m)。同じく目標の大きさを足して使う。 */
const PROXIMITY = 90;
/**
 * 推進終了後の慣性飛行時間(秒)の目安。
 * 減速量はこれを使って設計速度から決める。固定値にすると、
 * 低速な対地ミサイル(320m/s)が数秒で失速して射程の半分も飛べなくなる。
 */
const COAST_TIME = 50;
/** この速度を下回ると失推 */
const MIN_SPEED_RATIO = 0.35;
/** 誘導に必要な視線を確認する間隔(秒) */
const LOS_INTERVAL = 0.25;
/** ARM が電波を失ったときの慣性誘導の誤差（残距離に対する割合） */
const ARM_MEMORY_ERROR = 0.018;
/** 目標の大きさのうち、爆風判定で「当たり」とみなす割合 */
const SIZE_FOOTPRINT = 0.25;
/**
 * 地上目標へ向かうときに、目標の真上を飛ぶ高さ(m)と、そこから降ろし始める距離(m)。
 *
 * 地上目標は地表そのものにいるので、そこへ真っ直ぐ狙うと**着弾までの数kmを
 * 地面すれすれで飛ぶ**ことになる。目標が斜面の下にあると、あいだの尾根が
 * ちょうど照準線まで迫り上がってきて、途中の起伏に必ず引っかかる。
 * 実測では AGM が目標の 214m 手前で接地し、爆風の届かない距離で消えていた
 * （レーダーサイト 120HP に対し、2発撃って 77 ダメージ）。
 *
 * 終末までは目標の上を狙い、近づいてから落とす。実際の対地ミサイルと同じ挙動で、
 * 途中の地形から離れられるうえ、突っ込む角度も急になって命中が安定する。
 */
const GROUND_APPROACH_ALT = 220;
/** 上を狙うのをやめる距離。ここから内側は目標そのものを狙う */
const GROUND_DIVE_END = 150;
/** ここより遠いあいだは目標の上を飛ぶ */
const GROUND_DIVE_START = 1200;

let nextId = 1;

/** ID を振り直す（`sim/unit.js` の `resetUnitIds` と同じ理由） */
export function resetMissileIds() { nextId = 1; }

export class Missile {
  constructor({ weapon, launcher, target, world }) {
    this.id = nextId++;
    this.weapon = weapon;
    this.side = launcher.side;
    this.launcher = launcher;
    this.target = target;        // 本来の目標
    this.seekTarget = target;    // シーカーが今追っているもの（デコイに移ることがある）

    this.pos = launcher.pos.clone();
    this.prevPos = this.pos.clone();

    // 発射時は母機の速度と向きを引き継ぐ
    const f = launcher.forward();
    this.dir = new THREE.Vector3(f.x, Math.sin(launcher.pitch || 0), f.z).normalize();
    this.speed = launcher.speed || 200;

    this.age = 0;
    this.alive = true;
    this.lost = false;            // 誘導喪失（以後は直進）
    this.lastKnown = target ? target.pos.clone() : this.pos.clone();

    // ロケットモーターは短時間で燃え尽き、以後は慣性で飛ぶ。
    // 射程の限界は「燃焼後にどこまで速度を保てるか」で自然に決まる。
    this.boostTime = clamp((weapon.range * 0.35) / Math.max(1, weapon.speed), 1.5, 20);
    // 高空では抵抗が減って慣性飛行が伸びるため、寿命は余裕をもって取る
    this.lifetime = (weapon.range / Math.max(1, weapon.speed)) * 4 + 30;
    this.accel = (weapon.speed - this.speed) / Math.max(0.5, this.boostTime * 0.6);
    this.drag = weapon.speed / COAST_TIME;

    this._losTimer = 0;
    this._losOk = true;
    this.trail = [this.pos.clone()];
  }

  get guidance() { return this.weapon.guidance; }
  get isBomb() { return this.weapon.kind === 'bomb'; }

  update(dt, world) {
    if (!this.alive) return;
    this.age += dt;
    this.prevPos.copy(this.pos);

    if (this.isBomb) this._updateBomb(dt, world);
    else this._updateMissile(dt, world);

    if (!this.alive) return;

    // 軌跡（描画用）
    if (this.trail.length === 0 || this.trail[this.trail.length - 1].distanceTo(this.pos) > 120) {
      this.trail.push(this.pos.clone());
      if (this.trail.length > 40) this.trail.shift();
    }

    this._checkImpact(world);
  }

  // ------------------------------------------------------------ 飛翔

  _updateMissile(dt, world) {
    // 推進 → 慣性
    if (this.age < this.boostTime) {
      this.speed = Math.min(this.weapon.speed, this.speed + this.accel * dt);
    } else {
      // ロケットモーターは空気を必要としないので推力は高度で落ちないが、
      // 慣性飛行中の減速は空気密度に比例する。高空ほど遠くまで届く。
      this.speed = Math.max(0, this.speed - this.drag * missileDragFactor(this.pos.y) * dt);
    }

    // 失推・寿命切れ。
    // 発射時は母機の速度しか無いので、燃焼が終わるまでは失推判定をしない。
    const spent = this.age > this.boostTime
      && this.speed < this.weapon.speed * MIN_SPEED_RATIO;
    if (spent || this.age > this.lifetime) {
      this.destroy(world, 'spent');
      return;
    }

    this._updateGuidance(dt, world);

    if (!this.lost && this.seekTarget) {
      const aim = this._leadPoint();
      this._steerTowards(aim, dt);
    }

    this.pos.addScaledVector(this.dir, this.speed * dt);
  }

  _updateBomb(dt, world) {
    // 無誘導。速度ベクトルを素直に積分して放物線を描く。
    // 空気抵抗は入れない。投下点の計算（sim/combat.js）が解析的な弾道解なので、
    // ここに抵抗を足すと必ず手前に落ちる。
    if (!this.vel) {
      this.vel = this.dir.clone().multiplyScalar(this.speed);
      // 投下高度に比例した散布界。低空ならほぼ命中、高空ではまず当たらない。
      const r = this.bombDispersion || 0;
      if (r > 0) {
        const rnd = () => (world.rng ? world.rng() : Math.random()) - 0.5;
        this.vel.x += rnd() * 2 * r;
        this.vel.z += rnd() * 2 * r;
        this.vel.y += rnd() * r;
      }
    }
    this.vel.y -= 9.8 * dt;
    this.pos.addScaledVector(this.vel, dt);
    this.speed = this.vel.length();
    this.dir.copy(this.vel).normalize();
    if (this.age > 60) this.destroy(world, 'spent');
  }

  /**
   * 視線判定に使う目標点。
   * 地上目標は地表にいるため、その一点を狙うと着弾直前に必ず
   * 「地形に遮られている」と判定されてしまう。少し持ち上げて判定する。
   */
  _losPoint(t) {
    if (t.kind && t.kind !== 'aircraft') return _v6.set(t.pos.x, t.pos.y + 40, t.pos.z);
    return t.pos;
  }

  /** 誘導が成立しているかを判定し、切れたら lost にする */
  _updateGuidance(dt, world) {
    const t = this.seekTarget;
    if (!t || t.alive === false) {
      // 静止目標なら最後に分かっていた場所へ突っ込む（実体ではなく座標を狙う）
      if (this.target && this.target.static) {
        this.seekTarget = { pos: this.lastKnown, alive: true, speed: 0, isPoint: true };
      }
      else this._goStupid();
      return;
    }
    this.lastKnown.copy(t.pos);

    switch (this.guidance) {
      case 'sarh': {
        // 発射機がレーダーで照射し続けている必要がある
        const l = this.launcher;
        if (!l || !l.alive) { this._goStupid(); return; }
        if (!illuminates(l, this.target, world)) { this._goStupid(); return; }
        break;
      }
      case 'arm': {
        // 目標が電波を止めたら誘導が切れる。ただし完全に諦めるのではなく、
        // 最後に捉えた放射源の位置へ慣性で向かう（_armMemory）。
        if (!this.target.emitting) { this._armMemory(world); return; }
        break;
      }
      default: break;
    }

    // シーカーの視線（地形に遮られたら見失う）
    this._losTimer -= dt;
    if (this._losTimer <= 0) {
      this._losTimer = LOS_INTERVAL;
      this._losOk = world.terrain.hasLineOfSight(this.pos, this._losPoint(t), 6, 200);
    }
    if (!this._losOk) this._goStupid();
  }

  _goStupid() {
    if (this.lost) return;
    this.lost = true;
    this.seekTarget = null;
  }

  /**
   * ARM の慣性記憶。
   *
   * 「沈黙されたら必ず外れる」にすると、SAM は ARM に気づいてから
   * 2.5秒で沈黙できるので、ARM は理屈のうえで一度も当たらない兵装になる。
   * 逆に「最後の座標へ必ず当たる」にすると相手は静止目標なので沈黙が無意味になる。
   *
   * そこで、電波が消えた時点の残距離に比例した誤差を持つ座標へ向かわせる。
   * 早く沈黙すれば外れ、気づくのが遅れれば食らう——という駆け引きになる。
   */
  _armMemory(world) {
    if (this.seekTarget && this.seekTarget.isPoint) return;    // すでに記憶飛行中
    const dist = this.pos.distanceTo(this.lastKnown);
    const err = clamp(dist * ARM_MEMORY_ERROR, 12, 500);
    const rnd = () => ((world.rng ? world.rng() : Math.random()) - 0.5) * 2;
    this.seekTarget = {
      pos: new THREE.Vector3(
        this.lastKnown.x + rnd() * err,
        this.lastKnown.y,
        this.lastKnown.z + rnd() * err,
      ),
      alive: true, speed: 0, isPoint: true,
    };
  }

  /**
   * 会合点（目標の未来位置）を反復して求める。
   * 一回だけの見積もりだと終末で毎回ずれて至近弾ばかりになるため、
   * 「予測位置までの飛翔時間」を3回収束させる。
   */
  _leadPoint() {
    const t = this.seekTarget;
    this._targetDist = this.pos.distanceTo(t.pos);

    const aim = _v2.copy(t.pos);

    // 地上目標は上から降ろす（GROUND_APPROACH_ALT）。
    // 命中判定は本物の座標(t.pos)で行うので、狙点をずらしても当たり判定は変わらない。
    if (isGroundTarget(t)) {
      // 終末は狙点を目標そのものへ戻す。最後まで上を狙い続けると、
      // 追尾の遅れのぶんだけ高いまま通り過ぎて至近弾になる（実測で 42m 上を通過）。
      aim.y += GROUND_APPROACH_ALT * clamp(
        (this._targetDist - GROUND_DIVE_END) / (GROUND_DIVE_START - GROUND_DIVE_END), 0, 1);
    }

    if (!t.forward || !t.speed) return aim;

    const f = t.forward(_v3);
    let tof = this._targetDist / Math.max(50, this.speed);
    for (let i = 0; i < 3; i++) {
      aim.set(t.pos.x + f.x * t.speed * tof, t.pos.y, t.pos.z + f.z * t.speed * tof);
      tof = this.pos.distanceTo(aim) / Math.max(50, this.speed);
    }
    return aim;
  }

  /** 旋回率の上限内で目標方向へ向きを寄せる */
  _steerTowards(aim, dt) {
    const desired = _v4.copy(aim).sub(this.pos).normalize();
    const angle = this.dir.angleTo(desired);
    if (angle < 1e-4) return;

    // 速度が落ちるほど曲がれなくなる（エネルギーを失うと振り切られる）
    const energy = clamp(this.speed / this.weapon.speed, 0.2, 1);
    // 終末では舵が効く（近距離ほど大きな修正が可能）
    const terminal = this._targetDist < 2500 ? 2.4 : 1;
    const maxTurn = this.weapon.turnRate * (Math.PI / 180) * energy * terminal * dt;

    if (angle <= maxTurn) {
      this.dir.copy(desired);
    } else {
      const axis = _v5.crossVectors(this.dir, desired).normalize();
      this.dir.applyAxisAngle(axis, maxTurn).normalize();
    }
  }

  // ------------------------------------------------------------ 命中判定

  _checkImpact(world) {
    // 目標判定を地形判定より先に行う。
    // 地上目標は地表にいるため、順序が逆だと着弾直前に必ず地面と判定されてしまう。
    if (this._checkTargetImpact(world)) return;

    // 地形
    const ground = Math.max(0, world.terrain.heightAt(this.pos.x, this.pos.z));
    if (this.pos.y <= ground) {
      this.pos.y = ground;
      this._blast(world);
      this.destroy(world, 'ground');
    }
  }

  _checkTargetImpact(world) {
    // 移動区間と目標の最接近で判定する（1フレーム29m進むのですり抜け防止が要る）。
    //
    // 注意: 単に「近接信管圏に入ったら起爆」にすると、接近中の最初のフレーム
    // （＝ちょうど信管半径の距離）で必ず起爆してしまい、永遠に至近弾になる。
    // 最接近点を通過した(seg.t < 1)ときに、その最接近距離で判定する。
    const t = this.seekTarget && this.seekTarget.pos ? this.seekTarget : this.target;
    if (!t || t.alive === false) return false;
    const seg = closestApproach(t.pos, this.prevPos, this.pos);
    const d = seg.dist;
    const [direct, prox] = hitRadii(t);
    if (d > prox) return false;
    const passed = seg.t < 0.999;
    if (!passed && d > direct) return false;          // まだ近づいている最中

    // デコイに当たった場合は消えるだけ
    if (t.isDecoy) { this.destroy(world, 'decoy'); return true; }

    // 実体ではなく「最後に分かっていた座標」を狙っている場合は爆発だけ起こす
    if (t.isPoint) {
      this._blast(world);
      this.destroy(world, 'hit');
      return true;
    }

    const rng = world.rng;
    if (d <= direct) {
      t.damage(this.weapon.damage, this);
    } else {
      // かすり被弾。生き残ることがある。
      t.damage(40 + rng() * 30, this);
    }
    world.onMissileHit?.(this, t, d);
    this.destroy(world, 'hit');
    return true;
  }

  /**
   * 爆弾・対地ミサイルの爆風（範囲ダメージ）。
   *
   * 距離は目標の大きさを差し引いて測る。中心からの距離だけで減衰させると、
   * 全長900mの飛行場に100m外れただけの爆弾がほとんど効かない、という
   * 実態と合わない結果になる（爆撃機が飛行場を壊せない原因だった）。
   */
  _blast(world) {
    const radius = this.weapon.blastRadius;
    if (!radius) return;
    for (const u of world.units) {
      if (!u.alive || u.side === this.side) continue;
      if (u.kind === 'aircraft') continue;
      const footprint = (u.spec && u.spec.size ? u.spec.size : 0) * SIZE_FOOTPRINT;
      const d = Math.max(0, u.pos.distanceTo(this.pos) - footprint);
      if (d > radius) continue;
      u.damage(this.weapon.damage * (1 - d / radius), this);
    }
  }

  destroy(world, reason) {
    if (!this.alive) return;
    this.alive = false;
    this.endReason = reason;
    // 地表付近での炸裂は衝撃波と土煙を伴う演出にする
    const ground = world.terrain
      && this.pos.y - Math.max(0, world.terrain.heightAt(this.pos.x, this.pos.z)) < 70;
    world.effects?.explosion(this.pos, reason === 'hit' ? 260 : 140, ground ? 'ground' : 'air');
  }
}

/**
 * その目標の [直撃半径, 近接信管半径]。
 * 大きな施設ほど「当たった」と言える範囲が広い。
 */
function hitRadii(t) {
  const size = t.spec && t.spec.size ? t.spec.size : 0;
  const footprint = t.kind === 'aircraft' ? 0 : size * SIZE_FOOTPRINT;
  return [DIRECT_HIT + footprint, PROXIMITY + footprint];
}

/**
 * 地表にいる目標か。
 * 「最後に分かっていた座標」(isPoint) は静止した地上目標のためだけに作られるので、
 * これも地上として扱う。
 */
function isGroundTarget(t) {
  if (t.isPoint) return true;
  return !!t.kind && t.kind !== 'aircraft';
}

/** 発射機が目標をレーダーで照射し続けているか（セミアクティブ誘導の条件） */
function illuminates(launcher, target, world) {
  if (!launcher.spec || !target) return false;

  // 地上発射（SAM）は全方位レーダー。沈黙すれば誘導が切れる。
  if (launcher.kind !== 'aircraft') {
    if (!launcher.radarRange) return false;
    if (launcher.pos.distanceTo(target.pos) > launcher.radarRange) return false;
    return world.terrain.hasLineOfSight(launcher.pos, target.pos, 8, 400);
  }

  const dx = target.pos.x - launcher.pos.x;
  const dz = target.pos.z - launcher.pos.z;
  const dy = target.pos.y - launcher.pos.y;
  const flat = Math.hypot(dx, dz);
  const dist = Math.hypot(flat, dy);
  if (dist > (launcher.spec.radarRange || 0)) return false;

  if (!launcher.spec.omniRadar) {
    const bearing = Math.atan2(dx, -dz);
    let diff = bearing - launcher.heading;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    if (Math.abs(diff) > (launcher.spec.radarFovH || 60) * (Math.PI / 180)) return false;
    if (Math.abs(Math.atan2(dy, Math.max(1, flat))) > (launcher.spec.radarFovV || 30) * (Math.PI / 180)) return false;
  }
  return world.terrain.hasLineOfSight(launcher.pos, target.pos, 8, 400);
}

// ---------------------------------------------------------------- デコイ

let decoyId = 1;

/** フレア／チャフ。ミサイルのシーカーを引き付ける囮。 */
export class Decoy {
  constructor({ kind, pos, vel, side }) {
    this.id = decoyId++;
    this.isDecoy = true;
    this.kind = kind;             // 'flare' | 'chaff'
    this.side = side;
    this.pos = pos.clone();
    this.vel = vel.clone();
    this.life = 6;
    this.alive = true;
    this.speed = 0;
  }

  update(dt) {
    this.pos.addScaledVector(this.vel, dt);
    this.vel.multiplyScalar(1 - 1.2 * dt);
    this.vel.y -= 6 * dt;
    this.life -= dt;
    if (this.life <= 0) this.alive = false;
  }

  damage() { /* デコイは撃破されない */ }
}

/** 誘導方式とデコイ種別の相性 */
export function decoyMatches(guidance, kind) {
  if (kind === 'flare') return guidance === 'ir';
  if (kind === 'chaff') return guidance === 'sarh' || guidance === 'arh';
  return false;
}

// ---------------------------------------------------------------- 補助

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _v5 = new THREE.Vector3();
const _v6 = new THREE.Vector3();
const _sa = new THREE.Vector3();
const _sb = new THREE.Vector3();

/** 点と線分の最接近。dist=距離, t=線分上の位置(0..1) */
function closestApproach(p, a, b) {
  _sa.copy(b).sub(a);
  const len2 = _sa.lengthSq();
  if (len2 < 1e-6) return { dist: p.distanceTo(a), t: 1 };
  _sb.copy(p).sub(a);
  const t = clamp(_sb.dot(_sa) / len2, 0, 1);
  _sa.multiplyScalar(t).add(a);
  return { dist: p.distanceTo(_sa), t };
}
