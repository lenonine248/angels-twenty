// 交戦処理。兵装の選択と発射、機銃、デコイ、脅威（飛来ミサイル）の割り当て。
//
// 方針:
//   ・撃つ条件（射程・シーカーの視野・レーダー照射・視線）はここで一元管理する
//   ・同じ条件を満たすなら安い兵装から使う（兵装コストは有限のプールから引かれるため）
//   ・撃てるのは「自軍が探知している目標」だけ。見えない敵は撃てない

import * as THREE from 'three';
import { WEAPONS } from '../data/weapons.js';
import { Missile, Decoy, decoyMatches } from './missile.js';
import { headingOf, angleDiff, DEG } from './unit.js';
import { clamp } from '../core/rng.js';
import { effectiveMissileRange, turnFactor } from '../core/atmosphere.js';

/** 機銃。命中率・威力・弾数は機種ごと（data/aircraft.js の gunSpec） */
const GUN_RANGE = 800;           // 対空
const GUN_RANGE_GROUND = 2000;   // 対地掃射（大きな目標なので遠くから撃てる）
const GUN_RPS = 25;              // 毎秒発射数
const GUN_REAR_CONE = 30 * DEG;  // 目標の後方このコーン内からのみ有効（対空）
const GUN_AIM_CONE = 12 * DEG;   // 機首をこの範囲まで向けている必要がある（対空）
const GUN_AIM_CONE_GROUND = 20 * DEG;   // 対地は大きな目標なので緩い

/** 同一目標へ同時に飛ばせるミサイル数 */
const MAX_IN_FLIGHT_PER_TARGET = 2;
/** 連続発射の間隔(秒)。爆弾は一連射（スティック投下）できるよう短くする。 */
const FIRE_COOLDOWN = 3.5;
const BOMB_COOLDOWN = 0.5;

/** ミサイル警報が出る距離。レーダー誘導は逆探知で早く分かるが、赤外線は目視まで気づけない。 */
const WARN_RANGE = { radar: 14000, ir: 5000 };

/** ミサイルの最小射程（近すぎると誘導が間に合わない） */
const MIN_RANGE = { 'AAM-S': 400, default: 1500 };

/** AIが自動発射に踏み切る命中期待度のしきい値 */
export const FIRE_THRESHOLD = { low: 0.15, mid: 0.35, high: 0.60 };

/**
 * 命中期待度の見積り（0..1）。
 *
 * 「撃てるか」と「当たるか」は別問題。射程の縁で撃ったミサイルは
 * 終末でエネルギーを失い、逃げる目標には届かない。
 * プレイヤーの判断材料と、AIの乱射抑制の両方に使う。
 */
export function estimateHitChance(shooter, target, weapon) {
  if (!weapon || !target || !target.alive) return 0;
  if (weapon.kind === 'bomb') return 0.5;      // 投下点まで行けるかどうかの話なので固定

  const dist = shooter.pos.distanceTo(target.pos);
  const eff = effectiveMissileRange(weapon, (shooter.pos.y + target.pos.y) * 0.5);
  const frac = dist / Math.max(1, eff);
  // 射程の何割で撃つか。縁で撃つほど当たらない。
  let p = clamp(1.18 - frac * 1.35, 0.03, 0.95);

  if (target.kind === 'aircraft' && !target.onGround) {
    // アスペクト。誘導方式で得意な角度が逆になる。
    //   赤外線: 排気を見るので後方から撃つほど当たる
    //   レーダー: 接近速度が乗る正面ほど当たる
    const dx = target.pos.x - shooter.pos.x, dz = target.pos.z - shooter.pos.z;
    const aspect = Math.abs(angleDiff(headingOf(-dx, -dz), target.heading)) / Math.PI;
    p *= weapon.guidance === 'ir' ? (0.7 + 0.3 * aspect) : (1 - 0.4 * aspect);
    // デコイ耐性。ここを重く見すぎると短距離AAMがいつまでも撃てない。
    p *= 0.7 + 0.3 * (weapon.decoyResist ?? 0.5);
    // 高空の目標は旋回で振り切りにくい
    p *= 0.82 + 0.18 * (1 - turnFactor(target.pos.y));
    // 相手の対抗手段の残量は見ない（残弾を数えるのは過剰な情報なので）
  } else {
    // 動かない目標は回避しない。射程の縁でなければまず当たる。
    //
    // ここに空対空と同じ距離減点をかけると、SAM の射程外から撃つための
    // ARM が「命中期待度が低い」と判断されて永久に撃てず、
    // SAM の交戦距離まで近づいてから撃つことになって存在意義が消える。
    // 静止目標では「当たるか」ではなく「弾が届くか」だけを見る。
    p = clamp(1.15 - frac * 0.85, 0.05, 0.95);
  }
  return clamp(p, 0.02, 0.97);
}

/** 命中期待度の表示ラベル */
export function hitLabel(p) {
  if (p >= 0.6) return { text: '高', cls: 'good' };
  if (p >= 0.32) return { text: '中', cls: 'mid' };
  return { text: '低', cls: 'bad' };
}

export class CombatSystem {
  constructor(world) {
    this.world = world;
    world.missiles = [];
    world.decoys = [];
    world.combat = this;
  }

  update(dt) {
    const w = this.world;

    for (const m of w.missiles) m.update(dt, w);
    for (const d of w.decoys) d.update(dt);
    w.missiles = w.missiles.filter((m) => m.alive);
    w.decoys = w.decoys.filter((d) => d.alive);

    this._assignThreats();

    for (const u of w.units) {
      if (u.kind !== 'aircraft' || !u.alive) continue;
      this._engage(u, dt);
    }
  }

  // ------------------------------------------------------------ 脅威

  /** 各機に「自分を狙って飛来中で、かつ気づけているミサイル」を持たせる */
  _assignThreats() {
    const w = this.world;
    for (const u of w.units) {
      if (u.threats) u.threats.length = 0;
    }
    for (const m of w.missiles) {
      const t = m.target;
      if (!t || !t.threats || !t.alive) continue;
      if (m.lost) continue;
      const dist = m.pos.distanceTo(t.pos);
      const warn = m.guidance === 'ir' ? WARN_RANGE.ir : WARN_RANGE.radar;
      if (dist > warn) continue;
      t.threats.push(m);
    }
    for (const u of w.units) {
      if (u.threats && u.threats.length > 1) {
        u.threats.sort((a, b) => a.pos.distanceTo(u.pos) - b.pos.distanceTo(u.pos));
      }
    }
  }

  // ------------------------------------------------------------ 交戦

  _engage(shooter, dt) {
    shooter.fireCooldown = Math.max(0, (shooter.fireCooldown || 0) - dt);

    // プレイヤーが指定した射撃指示を先に処理する。
    // 攻撃目標は変えず、条件が整ったときだけ撃つ（指定した兵装で1発）。
    if (this._runFireTasks(shooter)) return;

    const o = shooter.order;
    if (!o || o.type !== 'attack') return;
    const target = o.target;
    if (!target || !target.alive) return;

    // 自軍が探知していない目標は撃てない
    if (!this.world.detection.isVisible(shooter.side, target)) return;

    this._tryGun(shooter, target, dt);

    if (shooter.fireCooldown > 0) return;

    const inFlight = this.world.missiles.filter(
      (m) => m.alive && m.target === target && m.side === shooter.side).length;
    if (inFlight >= MAX_IN_FLIGHT_PER_TARGET) return;

    const weapon = this.selectWeapon(shooter, target);
    if (!weapon) return;

    // 命中が見込めないうちは撃たない（乱射してミサイルを空にしないため）。
    //
    // ここに練度を効かせてはいけない。ミサイルが実体で飛ぶこのゲームでは、
    // しきい値を下げれば「手数が増えて」強くなり、上げれば「良い射点でだけ撃つ」
    // ので強くなる。どちらへ動かしても強くなるため、難易度の軸として使えない。
    // 練度は発射間隔・照準精度・反応速度・回避の質で効かせる（単調に効く軸だけ使う）。
    const need = FIRE_THRESHOLD[shooter.fireThreshold || 'mid'] ?? FIRE_THRESHOLD.mid;
    if (weapon.kind !== 'bomb' && estimateHitChance(shooter, target, weapon) < need) return;

    this.fire(shooter, target, weapon);
    // 練度が低いほど次弾までが遅い。手数そのものを減らす、副作用の少ない効かせ方。
    const cd = weapon.kind === 'bomb' ? BOMB_COOLDOWN : FIRE_COOLDOWN;
    shooter.fireCooldown = cd / (0.5 + 0.5 * (shooter.skill ?? 1));
  }

  /** プレイヤーが指定した射撃指示（兵装＋目標）を条件が整った順に消化する */
  _runFireTasks(shooter) {
    const tasks = shooter.fireTasks;
    if (!tasks || !tasks.length) return false;
    if (shooter.fireCooldown > 0) return false;

    for (let i = 0; i < tasks.length; i++) {
      const t = tasks[i];
      if (!t.target || !t.target.alive || !shooter.loadout.includes(t.weapon)) {
        tasks.splice(i, 1); i--; continue;
      }
      const w = WEAPONS[t.weapon];
      if (!this.world.detection.isVisible(shooter.side, t.target)) continue;
      if (!this.inEnvelope(shooter, t.target, w)) continue;
      this.fire(shooter, t.target, w);
      shooter.fireCooldown = w.kind === 'bomb' ? BOMB_COOLDOWN : FIRE_COOLDOWN;
      tasks.splice(i, 1);
      return true;
    }
    return false;
  }

  /**
   * 使用する兵装を選ぶ。
   * プレイヤーが指定していればそれだけを使い、指定が無ければ
   * 「自動使用が許可されていて、発射条件を満たす中で最も安いもの」を選ぶ。
   */
  selectWeapon(shooter, target) {
    // 駐機・滑走中の機体は地上目標として扱う（空対空ミサイルは撃てない）
    const isAir = target.kind === 'aircraft' && !target.onGround;
    const forced = shooter.order && shooter.order.weapon;
    let best = null;
    for (const id of shooter.loadout) {
      const w = WEAPONS[id];
      if (!w) continue;
      if (forced) { if (id !== forced) continue; }
      else if (shooter.autoWeapons && shooter.autoWeapons[id] === false) continue;
      if (isAir ? w.kind !== 'aam' : (w.kind !== 'agm' && w.kind !== 'bomb')) continue;
      if (!this.inEnvelope(shooter, target, w)) continue;
      if (!best || w.cost < best.cost) best = w;
    }
    return best;
  }

  /** 発射エンベロープの判定 */
  inEnvelope(shooter, target, w) {
    const dx = target.pos.x - shooter.pos.x;
    const dz = target.pos.z - shooter.pos.z;
    const dy = target.pos.y - shooter.pos.y;
    const flat = Math.hypot(dx, dz);
    const dist = Math.hypot(flat, dy);
    const terrain = this.world.terrain;

    // 地上目標は地表にいるので、視線判定は少し持ち上げた点で行う
    const losPoint = target.kind === 'aircraft'
      ? target.pos
      : _v4.set(target.pos.x, target.pos.y + 40, target.pos.z);
    const los = () => terrain.hasLineOfSight(shooter.pos, losPoint, 8, 300);

    if (w.kind === 'bomb') {
      // 無誘導爆弾は弾道解で投下点を決める。
      // 機首角度で判定すると、水平飛行では目標が常に下方にあって永久に投下できない。
      const h = shooter.pos.y - target.pos.y;
      if (h < 60 || h > w.dropAltMax) return false;
      if (Math.abs(angleDiff(headingOf(dx, dz), shooter.heading)) > 16 * DEG) return false;
      // 母機の上下速度を含めた落下時間 h = -vy*t + g*t^2/2 を解く
      const pitch = shooter.pitch || 0;
      const vy = shooter.speed * Math.sin(pitch);
      const vh = shooter.speed * Math.cos(pitch);
      const fallTime = (vy + Math.sqrt(vy * vy + 2 * 9.8 * h)) / 9.8;
      const throwRange = vh * fallTime;               // 投下点から着弾点までの水平距離
      // 爆風半径と同程度の窓で投下する。狭すぎると投下機会を逃し続ける。
      return Math.abs(flat - throwRange) < 130;
    }

    // 実効射程は高度で変わる。撃ち下ろしは終末が濃い空気になるので、
    // 発射点と目標の平均高度で見積もる。
    // 兵装ごとの運用高度（AGMは低・中高度向け、ARMは高高度向け）
    if (w.maxLaunchAlt != null && shooter.pos.y > w.maxLaunchAlt) return false;
    if (w.minLaunchAlt != null && shooter.pos.y < w.minLaunchAlt) return false;

    const minR = MIN_RANGE[w.id] ?? MIN_RANGE.default;
    const effRange = effectiveMissileRange(w, (shooter.pos.y + target.pos.y) * 0.5);
    if (dist < minR || dist > effRange * 0.85) return false;

    switch (w.guidance) {
      case 'ir':
        // 赤外線シーカーはある程度の首振りができる
        if (offBoresight(shooter, dx, dz, dy) > 50 * DEG) return false;
        return los();

      case 'sarh':
      case 'arh':
        // レーダー誘導は自機のレーダー扇に入っていることが条件
        if (!inRadarFan(shooter, dx, dz, dy, flat)) return false;
        return los();

      case 'arm':
        if (!target.emitting) return false;
        return los();

      case 'command':
      default:
        if (offBoresight(shooter, dx, dz, dy) > 45 * DEG) return false;
        return los();
    }
  }

  /** 兵装を1発消費して発射する */
  fire(shooter, target, weapon) {
    const idx = shooter.loadout.indexOf(weapon.id);
    if (idx < 0) return null;
    shooter.loadout.splice(idx, 1);

    const m = new Missile({ weapon, launcher: shooter, target, world: this.world });

    // 照準の甘さ。練度が低いほど初期の向きがずれ、ミサイルは修正にエネルギーを使う。
    // 「撃つかどうか」ではなく「どれだけ正確に撃てるか」に効かせるのが、
    // 難易度の軸として素直に効く（外すほど当たらなくなる）。
    const skill = shooter.skill ?? 1;
    if (skill < 1) {
      const err = (1 - skill) * 0.11;                   // 練度0.2で約5度
      const a = (this.world.rng() - 0.5) * 2 * err;
      const c = Math.cos(a), sn = Math.sin(a);
      const dx0 = m.dir.x, dz0 = m.dir.z;
      m.dir.set(dx0 * c - dz0 * sn, m.dir.y, dx0 * sn + dz0 * c).normalize();
    }

    // 無誘導爆弾は投下高度に応じて散布界が広がる
    if (weapon.kind === 'bomb' && weapon.dispersionPerKm) {
      const h = Math.max(0, shooter.pos.y - target.pos.y);
      m.bombDispersion = weapon.dispersionPerKm * (h / 1000);
    }
    this.world.missiles.push(m);

    // 「攻撃したが着弾を見ていない」判定のため記録しておく
    this.world.detection?.markAttacked(shooter.side, target);
    this.world.onFire?.(shooter, target, weapon, m);
    return m;
  }

  /**
   * 地上発射（SAM）。搭載リストを消費せず、弾数とリロードは発射側が管理する。
   * launcher は静止しているので、目標方向へロフトして撃ち上げる。
   */
  fireGround(launcher, target, weapon) {
    const m = new Missile({ weapon, launcher, target, world: this.world });

    const dx = target.pos.x - launcher.pos.x;
    const dz = target.pos.z - launcher.pos.z;
    const flat = Math.max(1, Math.hypot(dx, dz));
    const loft = 40 * DEG;                       // 撃ち上げ角
    m.dir.set(
      (dx / flat) * Math.cos(loft),
      Math.sin(loft),
      (dz / flat) * Math.cos(loft),
    ).normalize();
    m.speed = 80;                                 // 発射直後は低速
    m.accel = (weapon.speed - m.speed) / Math.max(0.5, m.boostTime * 0.6);

    this.world.missiles.push(m);
    this.world.detection?.markAttacked(launcher.side, target);
    this.world.onFire?.(launcher, target, weapon, m);
    return m;
  }

  // ------------------------------------------------------------ 機銃

  /**
   * 機銃。対空と対地で条件と性能が違う。
   *
   * 対空: 目標の後方コーンに入り機首を向けている間だけ有効。
   *       命中率・威力・弾数は機種ごとに大きく異なる（運要素は残す）。
   * 対地: 目標が動かない／遅いので、機首を向けていれば当たりやすい。
   *       命中率は全機種共通で高く、弾数の多い攻撃機ほど掃射に向く。
   */
  _tryGun(shooter, target, dt) {
    if (shooter.gun <= 0) return;
    const g = shooter.spec.gunSpec;
    if (!g) return;

    const dx = target.pos.x - shooter.pos.x;
    const dz = target.pos.z - shooter.pos.z;
    const dy = target.pos.y - shooter.pos.y;
    const dist = Math.hypot(Math.hypot(dx, dz), dy);
    const air = target.kind === 'aircraft';
    const range = air ? GUN_RANGE : GUN_RANGE_GROUND;
    if (dist > range) return;

    // 機首が目標を向いているか
    if (offBoresight(shooter, dx, dz, dy) > (air ? GUN_AIM_CONE : GUN_AIM_CONE_GROUND)) return;

    if (air) {
      // 目標の後方にいるか（正面からのすれ違いでは当たらない）
      const tf = target.forward(_v1);
      const toShooter = _v2.set(-dx, 0, -dz).normalize();
      const rearAngle = Math.acos(clamp(toShooter.dot(_v3.set(-tf.x, 0, -tf.z)), -1, 1));
      if (rearAngle > GUN_REAR_CONE) return;
    }

    const rounds = Math.min(shooter.gun, GUN_RPS * dt);
    shooter.gun -= rounds;
    this.world.onGunFire?.(shooter, target, rounds);

    const rng = this.world.rng;
    const base = (air ? g.airHit : g.groundHit) * (0.5 + 0.5 * (shooter.skill ?? 1));
    const dmg = air ? g.airDmg : g.groundDmg;
    const pHit = base * (1 - (dist / range) * 0.6);
    let expected = rounds * pHit;
    while (expected > 0) {
      if (rng() < Math.min(1, expected)) {
        target.damage(dmg[0] + rng() * (dmg[1] - dmg[0]), shooter);
        this.world.onGunHit?.(shooter, target);
      }
      expected -= 1;
    }
  }

  // ------------------------------------------------------------ デコイ

  /**
   * フレア／チャフを投射する。
   * 飛来中のミサイルは、誘導方式が噛み合えば一定確率でデコイへ移る。
   */
  deployDecoy(unit, kind) {
    if (kind === 'flare' && unit.flares <= 0) return false;
    if (kind === 'chaff' && unit.chaff <= 0) return false;
    if (kind === 'flare') unit.flares--; else unit.chaff--;

    const f = unit.forward(_v1);
    const vel = new THREE.Vector3(
      -f.x * unit.speed * 0.25 + (this.world.rng() - 0.5) * 30,
      -25,
      -f.z * unit.speed * 0.25 + (this.world.rng() - 0.5) * 30,
    );
    const decoy = new Decoy({ kind, pos: unit.pos, vel, side: unit.side });
    this.world.decoys.push(decoy);
    this.world.onDecoy?.(unit, kind);

    // 飛来中のミサイルを引き付ける
    for (const m of this.world.missiles) {
      if (!m.alive || m.target !== unit || m.lost) continue;
      if (!decoyMatches(m.guidance, kind)) continue;
      const dist = m.pos.distanceTo(unit.pos);
      if (dist > 3000) continue;
      const chance = (1 - m.weapon.decoyResist) * clamp(1 - dist / 3000, 0.25, 1);
      if (this.world.rng() < chance) {
        m.seekTarget = decoy;
        this.world.onDecoyed?.(m, decoy);
      }
    }
    return true;
  }
}

// ---------------------------------------------------------------- 幾何

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();

/** 機首方向と目標方向のなす角(rad) */
function offBoresight(shooter, dx, dz, dy) {
  const flat = Math.hypot(dx, dz);
  const bearing = headingOf(dx, dz);
  const yaw = Math.abs(angleDiff(bearing, shooter.heading));
  const pitch = Math.abs(Math.atan2(dy, Math.max(1, flat)) - (shooter.pitch || 0));
  return Math.hypot(yaw, pitch);
}

/** 自機のレーダー扇に入っているか */
function inRadarFan(shooter, dx, dz, dy, flat) {
  const spec = shooter.spec;
  if (!spec || !spec.radarRange) return false;
  if (Math.hypot(flat, dy) > spec.radarRange) return false;
  if (spec.omniRadar) return true;
  if (Math.abs(angleDiff(headingOf(dx, dz), shooter.heading)) > (spec.radarFovH || 60) * DEG) return false;
  if (Math.abs(Math.atan2(dy, Math.max(1, flat))) > (spec.radarFovV || 30) * DEG) return false;
  return true;
}
