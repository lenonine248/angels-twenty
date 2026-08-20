// 交戦処理。兵装の選択と発射、機銃、デコイ、脅威（飛来ミサイル）の割り当て。
//
// 方針:
//   ・撃つ条件（射程・シーカーの視野・レーダー照射・視線）はここで一元管理する
//   ・同じ条件を満たすなら安い兵装から使う（兵装コストは有限のプールから引かれるため）
//   ・撃てるのは「自軍が探知している目標」だけ。見えない敵は撃てない

import * as THREE from 'three';
import { WEAPONS } from '../data/weapons.js';
import { Missile, Decoy, decoyMatches } from './missile.js';
import { Bullet, GUN_RPS, BULLET_LIFE, hitRadiusOf, aimPointOf } from './bullet.js';
import { headingOf, angleDiff, DEG } from './unit.js';
import { clamp } from '../core/rng.js';
import { effectiveMissileRange, turnFactor } from '../core/atmosphere.js';

// 機銃は実体弾（sim/bullet.js）。拡散・弾速・弾数は機種ごと（data/aircraft.js の gunSpec）。
//
// **射程も後方コーンも持たない**（§22.2.1 / §22.2.5）。
// 弾は全機共通の秒数で消え、当たるかどうかは拡散と偏差が決める。
// 正面からのすれ違いで当たらないのは、交差速度が大きく偏差が破綻するため。
//
/**
 * 機首をこの範囲まで向けていないと撃てない（機銃は機体に固定されている）。
 *
 * **対地は広く取る。** 地上目標のそばでは最低対地高度(220m)が効いて、
 * どうしても見下ろす角度が付く。622m まで詰めても俯角は 19度 になり、
 * 対空と同じ 14度 では永久に撃てない（実体弾にしたとき、対地用の
 * 広いコーンを落としてしまい、実際に掃射できなくなっていた）。
 */
const GUN_AIM_CONE = 14 * DEG;
const GUN_AIM_CONE_GROUND = 26 * DEG;
/** 撃つ気になる上限距離。弾が届く範囲より広く取り、実際の可否はしきい値に任せる */
const GUN_MAX_ENGAGE = 3200;
/** 拡散を広げる要因の効き */
const GUN_SPREAD_ROLL = 1.6;     // 旋回中（バンク角に比例）
const GUN_SPREAD_DAMAGE = 0.5;   // 損傷
/** 目標の旋回による偏差の外れやすさ（見積り用の係数） */
const GUN_LEAD_PENALTY = 1.0;

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
 * 機銃のしきい値はミサイルより低く取る。
 * ミサイルは1発が高価なので「当たりそうなときだけ」でよいが、
 * 機銃は連射する前提で、1発あたりの期待値はもともと小さい。
 * ミサイルと同じ刻みを使うと、機銃はほぼ一生撃たない。
 */
export const GUN_THRESHOLD = { low: 0.05, mid: 0.14, high: 0.30 };

/**
 * 機銃1発あたりの命中期待度（0..1）。
 *
 * 拡散と偏差の2つから作る。§22.2.2 / §22.2.3 の試算式そのもの。
 *   拡散: 横のばらつきが σ×距離 のとき、半径 r に入る割合は 1-exp(-r²/2(σd)²)
 *   偏差: 目標が旋回していると 0.5×(速度×旋回率)×飛翔時間² だけ狙点からずれる
 */
export function estimateGunHit(shooter, target) {
  const g = shooter.spec && shooter.spec.gunSpec;
  if (!g || !target || !target.alive || shooter.gun <= 0) return 0;

  const dist = shooter.pos.distanceTo(target.pos);
  if (dist < 1) return 0;
  const flight = dist / g.muzzleSpeed;
  if (flight > BULLET_LIFE) return 0;            // 弾が届かない

  const r = hitRadiusOf(target);
  const sigma = gunSpread(shooter, g);
  const spread = Math.max(1, sigma * dist);

  // 偏差の誤差。狙点は「目標がまっすぐ飛ぶ前提」で作るので、
  // 曲がっている目標には飛翔時間の2乗に比例して外れる。
  // 旋回率は実測値（aircraft.js が毎ステップ入れる）を使う。
  // バンク角から推し量ると、緩い定常旋回でバンクが寝ているときに
  // 「曲がっていない」と誤って読む。
  let lead = 0;
  if (target.kind === 'aircraft' && !target.onGround) {
    const omega = Math.abs(target.turnRate || 0);
    lead = 0.5 * (target.speed || 0) * omega * flight * flight * GUN_LEAD_PENALTY;
  }

  // ばらつきと偏差を合成して、半径 r に入る割合を出す
  const off2 = lead * lead;
  const s2 = spread * spread;
  return clamp(Math.exp(-off2 / (2 * s2)) * (1 - Math.exp(-(r * r) / (2 * s2))), 0, 1);
}

/** 実際に使う拡散角(ラジアン)。旋回・損傷・練度で広がる。 */
function gunSpread(shooter, g) {
  const roll = Math.abs(shooter.roll || 0) / 0.6;          // 0..1（最大バンク=0.6rad）
  const hurt = 1 - (shooter.hp / Math.max(1, shooter.maxHp));
  const skill = 0.6 + 0.4 * (shooter.skill ?? 1);
  return g.dispersion
    * (1 + roll * GUN_SPREAD_ROLL + hurt * GUN_SPREAD_DAMAGE)
    / skill;
}

/** 方向 dir を拡散角 sigma でばらつかせる（2次元の正規分布） */
function scatter(dir, sigma, rng, out) {
  // Box-Muller。左右と上下に独立した正規分布の角度を与える。
  const u1 = Math.max(1e-6, rng());
  const rad = Math.sqrt(-2 * Math.log(u1)) * sigma;
  const ang = rng() * Math.PI * 2;
  // dir に垂直な基底を作る
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
    world.bullets = [];
    world.combat = this;
  }

  update(dt) {
    const w = this.world;

    for (const m of w.missiles) m.update(dt, w);
    for (const d of w.decoys) d.update(dt);
    for (const b of w.bullets) b.update(dt, w);
    w.missiles = w.missiles.filter((m) => m.alive);
    w.decoys = w.decoys.filter((d) => d.alive);
    w.bullets = w.bullets.filter((b) => b.alive);

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

    const weapon = this.selectWeapon(shooter, target);
    if (!weapon) return;

    // 同一目標への同時発射数の制限。
    // これは「高価な誘導ミサイルを1つの目標に浪費しない」ための規則なので、
    // 爆弾には掛けない。掛けると一連（スティック）で落とせず、
    // 2発だけ落として通り過ぎることになり、爆撃機が目標を壊せなくなる。
    if (weapon.kind !== 'bomb') {
      const inFlight = this.world.missiles.filter(
        (m) => m.alive && m.target === target && m.side === shooter.side).length;
      if (inFlight >= MAX_IN_FLIGHT_PER_TARGET) return;
    }

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

  /**
   * いま撃てない理由を1つ返す（撃てるなら null）。
   *
   * 命中期待度が「高」と出ているのに撃たない、ということが起きる。
   * 期待度は**当たるかどうか**の見積りで、**撃ってよいかどうか**は別の条件。
   * 同一目標への同時誘導数と再装填はどちらも画面に出ていなかったため、
   * プレイヤーからは「撃てるはずなのに撃たない」としか見えなかった。
   *
   * @param {?object} weapon 省略時は自動選択と同じ規則で選ぶ
   */
  fireBlockReason(shooter, target, weapon = null) {
    if (!shooter || !shooter.alive || !target || !target.alive) return null;
    if (shooter.onGround) return '地上';
    if (!this.world.detection.isVisible(shooter.side, target)) return '未探知';

    const isAir = target.kind === 'aircraft' && !target.onGround;
    let w = weapon;
    if (!w) {
      // 自動で使える兵装があるか。無ければ理由を分ける。
      const usable = shooter.loadout.filter((id) => {
        const x = WEAPONS[id];
        if (!x) return false;
        return isAir ? x.kind === 'aam' : (x.kind === 'agm' || x.kind === 'bomb');
      });
      if (!usable.length) return '兵装なし';
      const allowed = usable.filter((id) => !(shooter.autoWeapons && shooter.autoWeapons[id] === false));
      if (!allowed.length) return '自動使用オフ';
      // 条件を満たすものがあればそれを使う。無ければ最初のもので理由を出す。
      w = WEAPONS[allowed.find((id) => this.inEnvelope(shooter, target, WEAPONS[id])) || allowed[0]];
    }

    if (!this.inEnvelope(shooter, target, w)) return this._envelopeReason(shooter, target, w);

    if (w.kind !== 'bomb') {
      const inFlight = this.world.missiles.filter(
        (m) => m.alive && m.target === target && m.side === shooter.side).length;
      if (inFlight >= MAX_IN_FLIGHT_PER_TARGET) {
        return `誘導中${inFlight}発`;
      }
    }
    if (shooter.fireCooldown > 0) return `再装填 ${shooter.fireCooldown.toFixed(1)}秒`;

    if (w.kind !== 'bomb') {
      const need = FIRE_THRESHOLD[shooter.fireThreshold || 'mid'] ?? FIRE_THRESHOLD.mid;
      if (estimateHitChance(shooter, target, w) < need) return '期待度不足';
    }
    return null;
  }

  /** エンベロープのどこで落ちたかを言葉にする */
  _envelopeReason(shooter, target, w) {
    const dx = target.pos.x - shooter.pos.x;
    const dz = target.pos.z - shooter.pos.z;
    const dy = target.pos.y - shooter.pos.y;
    const flat = Math.hypot(dx, dz);
    const dist = Math.hypot(flat, dy);

    if (w.maxLaunchAlt != null && shooter.pos.y > w.maxLaunchAlt) return '高度が高い';
    if (w.minLaunchAlt != null && shooter.pos.y < w.minLaunchAlt) return '高度が低い';
    if (w.kind !== 'bomb') {
      const minR = MIN_RANGE[w.id] ?? MIN_RANGE.default;
      const eff = effectiveMissileRange(w, (shooter.pos.y + target.pos.y) * 0.5);
      if (dist < minR) return '近すぎ';
      if (dist > eff * 0.85) return '射程外';
    }
    if (w.guidance === 'arm' && !target.emitting) return '電波なし';
    const off = offBoresight(shooter, dx, dz, dy) / DEG;
    if (w.guidance === 'sarh' || w.guidance === 'arh') {
      if (!inRadarFan(shooter, dx, dz, dy, flat)) return `扇の外 ${Math.round(off)}度`;
    } else if (off > 45) {
      return `射角外 ${Math.round(off)}度`;
    }
    return '視線なし';
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
   * 機銃。実体弾を撒く（§22.2）。
   *
   * ここでやるのは「狙点を作って、拡散をかけて弾を出す」ことだけ。
   * 当たるかどうかは弾の側（sim/bullet.js）が決める。
   */
  _tryGun(shooter, target, dt) {
    if (shooter.gun <= 0) return;
    const g = shooter.spec.gunSpec;
    if (!g) return;
    if (shooter.autoWeapons && shooter.autoWeapons.GUN === false) return;

    const dist = shooter.pos.distanceTo(target.pos);
    if (dist > GUN_MAX_ENGAGE) return;
    // 弾が届かない距離では撃たない（寿命×初速が実射程）
    if (dist > g.muzzleSpeed * BULLET_LIFE * 0.95) return;

    // 偏差射撃の狙点。機首をそこへ向けられていなければ撃てない。
    aimPointOf(shooter, target, g.muzzleSpeed, _aimPt);
    const ax = _aimPt.x - shooter.pos.x;
    const az = _aimPt.z - shooter.pos.z;
    const ay = _aimPt.y - shooter.pos.y;
    const air = target.kind === 'aircraft' && !target.onGround;
    if (offBoresight(shooter, ax, az, ay) > (air ? GUN_AIM_CONE : GUN_AIM_CONE_GROUND)) return;

    // 当たりそうにないなら撃たない。
    // **射程制限を捨てた代わりがこれ**（§22.2.4）。これが無いと、
    // 弾の届く3km手前から乱射して弾倉を空にする。
    const need = GUN_THRESHOLD[shooter.fireThreshold || 'mid'] ?? GUN_THRESHOLD.mid;
    if (estimateGunHit(shooter, target) < need) return;

    // 視線が通っていること（山越しには撃てない）
    const losPoint = target.kind === 'aircraft'
      ? target.pos : _v4.set(target.pos.x, target.pos.y + 40, target.pos.z);
    if (!this.world.terrain.hasLineOfSight(shooter.pos, losPoint, 8, 300)) return;

    // 発射数は端数を持ち越す。dt が小さいと毎回0発になってしまう。
    shooter._gunAccum = (shooter._gunAccum || 0) + GUN_RPS * dt;
    let n = Math.floor(shooter._gunAccum);
    if (n <= 0) return;
    shooter._gunAccum -= n;
    n = Math.min(n, Math.floor(shooter.gun));
    if (n <= 0) return;
    shooter.gun -= n;

    const spread = gunSpread(shooter, g);
    const dmg = air ? g.airDmg : g.groundDmg;
    const rng = this.world.rng;

    _aimDir.set(ax, ay, az).normalize();
    for (let i = 0; i < n; i++) {
      scatter(_aimDir, spread, rng, _shotDir);
      this.world.bullets.push(new Bullet({
        pos: shooter.pos,
        dir: _shotDir,
        speed: g.muzzleSpeed,
        damage: dmg[0] + rng() * (dmg[1] - dmg[0]),
        shooter,
      }));
    }
    this.world.onGunFire?.(shooter, target, n);
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
// 機銃用（狙点・射線・拡散の基底）
const _aimPt = new THREE.Vector3();
const _aimDir = new THREE.Vector3();
const _shotDir = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();

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
