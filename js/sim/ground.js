// 地上・水上ユニット。
// P3時点では「探知される側」としての振る舞い（レーダー放射・沈黙・移動）だけを持つ。
// 交戦処理（SAM発射・AAA弾幕）は P6 で追加する。

import * as THREE from 'three';
import { Unit, headingOf, RWR_SIGNATURE_FACTOR } from './unit.js';
import { getGroundType, weaponsOf } from '../data/ground.js';
import { WEAPONS } from '../data/weapons.js';
import { opticalSight, groundSight, GROUND_EYE } from './sight.js';
import { effectiveMissileRange } from '../core/atmosphere.js';
import { clamp } from '../core/rng.js';
import { Bullet, aimPointOf } from './bullet.js';
import { LEVEL, GROUND_VISUAL_RANGE } from './detection.js';

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
export const ARM_NOTICE_RANGE = 4500;
export const ARM_REACTION = 2.5;
/** ARM を回避したあと沈黙を続ける時間(秒) */
export const SILENCE_DURATION = 25;
/**
 * 艦船が必要とする水深(m)。これより浅くなったら進まない。
 *
 * 艦船の高さは海面(y=0)固定なので、陸へ乗り上げると**地面にめり込む**。
 * 埋まった目標は見えないうえ、地形に遮られて攻撃もできない
 * （ミッション5の揚陸艦が、標高900mの丘の中まで進んでいた）。
 * 経路の指定を間違えても座礁しないよう、ここで止める。
 */
const SHIP_MIN_DEPTH = 40;

/**
 * 目標へ寄っていくときに止まる距離（射程に対する割合・§67.3）。
 * 射程ぎりぎりで止めると、地形の起伏で視線が切れたときに撃てなくなる。
 */
const ADVANCE_STOP = 0.75;

/** 見えない相手へ寄るときに、これより内へは詰めない距離(m)（§103） */
const ADVANCE_MIN = 300;

/** 持ち場・下がる先に着いたとみなす距離(m) */
const ARRIVE_RADIUS = 150;

/**
 * 地上の行動（§103・A3）。ステージ定義の `groundMode` とトリガーの `ground` で切り替える。
 *
 * | | |
 * |---|---|
 * | `advance` | `attackTag` の敵へ寄り、射程の内側で止まる（相手が尽きたら `route` があればそれをたどる） |
 * | `hold` | 持ち場（`holdAt`・無ければその場）に留まり、射程に入った敵を撃つ |
 * | `route` | 経路をたどる（巡回） |
 * | `retreat` | 下がる先（`retreatTo`・無ければ出現した位置）へ下がって留まる |
 *
 * 書かなければ今までと同じ振る舞い: `attackTag` があれば `advance`、`route` があれば `route`、どちらも無ければ `hold`。
 * **どの行動でも撃つのはやめない**（射撃は移動と別に回る）。
 */
export const GROUND_MODES = ['advance', 'hold', 'route', 'retreat'];

/** その兵装がその目標を狙うか（§67.1） */
function aims(w, unit) {
  const t = w.targets || 'air';
  const air = unit.kind === 'aircraft' && !unit.onGround;
  if (t === 'air') return air;
  if (t === 'ground') return !air;
  return true;
}

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

    /**
     * 交戦用の砲座（§67.2）。**兵装ごとに弾数と再装填を分けて持つ。**
     * まとめて1つにすると、SAM を撃ったせいで機銃が止まる。
     */
    // `unarmed: true` を付けた個体は武装を積まない（§67.3）。
    // 機銃のチュートリアル(w1)は「車両部隊は撃ち返してこない」を前提にしている。
    // ステージ側で無害な個体を置けるようにしておく。
    this.mounts = (o.unarmed ? [] : weaponsOf(spec)).map((w) => ({
      w, reload: 0, ammo: w.ammo ?? Infinity, accum: 0,
    }));

    /**
     * 進んで壊しに行く相手のタグ（§67.3）。
     * これがあると巡回をやめ、そのタグを持つ敵へ寄って射程で止まる。
     */
    this.attackTag = o.attackTag || null;

    /** 出現した位置。`retreat` の下がる先の既定（§103） */
    this.home = { x: this.pos.x, z: this.pos.z };
    /** 地上の行動（§103）。無ければ今までの振る舞いから決める */
    this.groundMode = GROUND_MODES.includes(o.groundMode) ? o.groundMode
      : this.attackTag ? 'advance' : this.route ? 'route' : 'hold';
    this.holdAt = o.holdAt || null;
    this.retreatTo = o.retreatTo || null;

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
    if (this.spec.static) return;

    // 行く先を決める（§103）。`goal` は着いたら止まる点、無ければ経路をたどる
    const mode = this.groundMode;
    let goal = null;
    if (mode === 'hold' || mode === 'retreat') {
      const p = mode === 'hold' ? this.holdAt : (this.retreatTo || this.home);
      if (!p) { this.speed = 0; return; }                // その場で持つ
      goal = { x: p.x, z: p.z, stop: ARRIVE_RADIUS, keepHeading: true };
    } else if (mode === 'advance') {
      // **壊しに行く相手がいれば、巡回より優先する**（§67.3）。
      // 射程まで詰めたら止まって撃つ。
      goal = this._advanceGoal(world);
    }
    let wp = goal;
    if (!wp) {
      if (mode === 'hold' || mode === 'retreat') return;
      if (!this.route || this.route.length === 0) { this.speed = 0; return; }
      wp = this.route[this.routeIndex];
    }
    const dx = wp.x - this.pos.x, dz = wp.z - this.pos.z;
    const dist = Math.hypot(dx, dz);
    if (goal) {
      // 止まる距離は射程の内側。撃てるところまで来たら足を止める
      if (dist <= goal.stop) {
        this.speed = 0;
        if (!goal.keepHeading) this.heading = headingOf(dx, dz);
        return;
      }
    } else if (dist < 200) {
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
    if (!world.combat || !this.mounts.length) return;
    this.firing = false;
    for (const m of this.mounts) {
      m.reload = Math.max(0, m.reload - dt);
      if (m.w.kind === 'howitzer') this._updateHowitzer(dt, world, m);
      else if (m.w.kind === 'cannon') this._updateCannon(dt, world, m);
      else if (m.w.kind === 'sam') this._updateSam(dt, world, m);
      else if (m.w.kind === 'irsam') this._updateIrSam(dt, world, m);
      else if (m.w.kind === 'aaa') this._updateAaa(dt, world, m);
    }
  }

  /**
   * 寄っていく先（§67.3）。`attackTag` を持つ生きている敵のうち最も近いもの。
   *
   * **探知は通さない。** 地上部隊はレーダーを持たないので、
   * 探知に通すと何も見つけられず一歩も動けない。
   * 「どこを攻めるか」はステージが与える情報として扱う。
   */
  _advanceGoal(world) {
    if (!this.attackTag) return null;
    const reach = this.mounts.reduce(
      (n, m) => (m.w.targets && m.w.targets !== 'air' ? Math.max(n, m.w.range || 0) : n), 0);
    if (reach <= 0) return null;
    let best = null; let bestD = Infinity;
    for (const u of world.units) {
      if (!u.alive || u.side === this.side || u === this) continue;
      if (!u.tags || !u.tags.includes(this.attackTag)) continue;
      const d = this.pos.distanceTo(u.pos);
      if (d < bestD) { bestD = d; best = u; }
    }
    if (!best) return null;
    // **撃てないうちは止まらない**（§103）。射程の内側でも、見えていない（直射）・
    // 陣営が位置を知らない（榴弾）なら寄り続ける。重ならないよう ADVANCE_MIN までは詰めない
    const stop = this._canEngage(world, best) ? reach * ADVANCE_STOP : ADVANCE_MIN;
    return { x: best.pos.x, z: best.pos.z, stop };
  }

  /** その相手をいま撃てるか（§103）。榴弾は陣営のコンタクト、ほかは自分の目（見える距離の内で地上の視線が通る） */
  _canEngage(world, u) {
    const sight = this.spec.sight || GROUND_VISUAL_RANGE;
    for (const m of this.mounts) {
      if (!m.w.targets || m.w.targets === 'air') continue;
      if (m.w.kind === 'howitzer') {
        const c = world.detection && world.detection.contactsFor(this.side).get(u.id);
        if (c && c.level >= LEVEL.IDENTIFIED) return true;
      } else if (this.pos.distanceTo(u.pos) <= sight && groundSight(world, this.pos, u.pos)) return true;
    }
    return false;
  }

  /**
   * SAM。レーダーで捉えた空中目標へ撃ち上げる。
   *
   * 対レーダーミサイル(ARM)の飛来に気づくと反応時間ののち沈黙する。
   * 沈黙すれば ARM の誘導は切れるが、その間は自分も撃てない。
   * 気づくのが遅れれば（＝ARM が既に近い）そのまま食らう。
   */
  _updateSam(dt, world, m) {
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

    if (!this.radarActive || m.reload > 0 || m.ammo <= 0) return;

    const target = this._pickAirTarget(world, m.w);
    if (!target) return;
    world.combat.fireGround(this, target, WEAPONS['SAM-M']);
    m.ammo--;
    m.reload = m.w.reloadSeconds;
  }

  /**
   * 榴弾砲（§69.2）。**山なりの弾で地上目標を叩く。**
   *
   * 発射角は放物線の式をそのまま解く。距離 d・初速 v・重力 g に対して
   *
   *     sin(2θ) = g·d / v²
   *
   * 解は2つあり、**低いほう（θ が小さい側）を使う**。
   * 高いほうは見た目こそ榴弾砲らしいが、飛翔時間が70秒を超えて
   * **撃ったことがプレイヤーに分からない兵器**になる。
   *
   * 高低差は「水平距離だけで角を決めて、あとは弾に任せる」で足りる ——
   * 数百mの差なら拡散の中に埋もれる。
   */
  _updateHowitzer(dt, world, m) {
    if (m.reload > 0) return;
    const w = m.w;
    const g = 9.81;

    // **着弾観測（§103）。陣営のコンタクトにある相手だけを撃つ。**
    // 見ているのは車両部隊でも戦車でも航空機でもよい。狙うのは**コンタクトの位置**（真の位置ではない）——
    // 見続けていれば当たり、見失えば推定の誤差がそのまま着弾のずれになる。
    // 識別済み（Lv1）より下は撃たない（敵味方が分からない）
    let target = null; let aim = null; let bestD = Infinity;
    const contacts = world.detection ? world.detection.contactsFor(this.side) : null;
    if (contacts) {
      for (const c of contacts.values()) {
        const u = c.unit;
        if (!u || !u.alive || u.side === this.side) continue;
        if (c.level < LEVEL.IDENTIFIED || !aims(w, u)) continue;
        // **水平距離で見る。** 3次元で測ると、坂の上の目標が射程の外に落ちる
        const d = Math.hypot(c.pos.x - this.pos.x, c.pos.z - this.pos.z);
        // 最短射程（§103）。寄られると山なりの弾は撃てない
        if (d > w.range || d < (w.minRange || 0) || d >= bestD) continue;
        bestD = d; target = u; aim = c;
      }
    }
    if (!target) return;

    const v = w.muzzle;
    const muzzleY = this.pos.y + MUZZLE_HEIGHT;

    // **高低差を入れて解く。**
    //
    // 平地の式（sin2θ = g·d/v²）は「撃った高さに落ちてくる」前提なので、
    // 高いところから撃つと落下が伸びて奥へ外れる。
    // 実測では砲が的より 128m 高いだけで、**一律 550m 奥に落ちていた**。
    //
    // 落下点 (d, -h) を通る条件を tanθ = u について解く:
    //   k·u² − d·u + (k − h) = 0     ただし k = g·d² / (2v²)
    // 低いほうの解（マイナス側）を使う。
    const solve = (ax, az) => {
      const dx = ax - this.pos.x;
      const dz = az - this.pos.z;
      const flat = Math.hypot(dx, dz);
      // 着弾点の高さは推定位置の地表（コンタクトの y は見たときのもの）
      const aimY = world.terrain ? Math.max(0, world.terrain.heightAt(ax, az)) : target.pos.y;
      const h = muzzleY - aimY;                // 撃つ側がどれだけ高いか
      const k = (g * flat * flat) / (2 * v * v);
      const disc = flat * flat - 4 * k * (k - h);
      if (disc < 0) return null;               // 届かない（射程の外）
      const theta = Math.atan((flat - Math.sqrt(disc)) / (2 * k));
      return { dx, dz, flat, theta, t: flat / (v * Math.cos(theta)) };
    };
    let sol = solve(aim.pos.x, aim.pos.z);
    if (!sol) return;
    // **遅い相手には偏差を取る**（§103・プレイヤーの決め）。コンタクトの速さが `leadBelow` 以下なら、
    // 飛翔時間ぶん先（コンタクトの向きと速さ）を狙う。速い相手（車両部隊 12m/s）は取らない ——
    // 「走っている車両には当たらない・遅い戦車は詰めるあいだに削られる」を分ける線
    if (w.leadBelow && aim.speed > 0.5 && aim.speed <= w.leadBelow) {
      const vx = Math.sin(aim.heading) * aim.speed;
      const vz = -Math.cos(aim.heading) * aim.speed;
      for (let i = 0; i < 2 && sol; i++) sol = solve(aim.pos.x + vx * sol.t, aim.pos.z + vz * sol.t);
      if (!sol) return;
    }
    const { dx, dz, flat, theta } = sol;

    _muzzle.set(this.pos.x, muzzleY, this.pos.z);
    _dir.set((dx / flat) * Math.cos(theta), Math.sin(theta), (dz / flat) * Math.cos(theta))
      .normalize();
    const rng = world.rng ? world.rng : Math.random;
    scatter(_dir, w.spread, rng, _shot);
    world.bullets.push(new Bullet({
      pos: _muzzle,
      dir: _shot,
      speed: v,
      damage: w.dmg[0] + rng() * (w.dmg[1] - w.dmg[0]),
      shooter: this,
      life: w.life,
      gravity: g,
      pierce: true,                            // 砲弾は装甲に引かれない（§103）
      impactOnly: !!w.impactOnly,              // 着弾した地点でだけ当たるか（§103）
    }));
    m.reload = w.reloadSeconds;
    this.firing = true;
    world.onGunFire?.(this, target, 1, v);
  }

  /**
   * 戦車の主砲（§103）。**直射 —— 自分の目で見えている相手だけを撃つ。**
   *
   * 射程（2.5km）は目視（3km）より短いので、見えているかは視線（地形・雲）だけで決まる。
   * 偏差を取った狙点へ、重力で落ちるぶんを低いほうの解で上へ向ける（榴弾砲と同じ式）。
   * 砲弾なので装甲には引かれない。
   */
  _updateCannon(dt, world, m) {
    if (m.reload > 0) return;
    const w = m.w;
    const g = 9.81;
    let target = null; let bestD = Infinity;
    for (const u of world.units) {
      if (!u.alive || u.side === this.side || u === this) continue;
      if (!aims(w, u)) continue;
      const d = Math.hypot(u.pos.x - this.pos.x, u.pos.z - this.pos.z);
      if (d > w.range || d >= bestD) continue;
      if (!groundSight(world, this.pos, u.pos)) continue;
      bestD = d; target = u;
    }
    if (!target) return;

    const muzzleY = this.pos.y + MUZZLE_HEIGHT;
    _muzzle.set(this.pos.x, muzzleY, this.pos.z);
    aimPointOf({ pos: _muzzle }, target, w.muzzle, _aim);
    // **狙点は相手の地表＋目の高さ**（§103）。見える線（両端 GROUND_EYE 上）と揃える ——
    // 足元を狙うと、見えているのに弾が手前の稜線に当たって消える（実測: 止まった戦車の 28発が全部 700m 手前の稜線に）。
    // 放物線は弦より上を通るので、見える線が通れば弾も通る。当たり半径（戦車 42m）の内なので当たりは変わらない
    _aim.y += GROUND_EYE;
    const dx = _aim.x - this.pos.x;
    const dz = _aim.z - this.pos.z;
    const flat = Math.hypot(dx, dz);
    if (flat < 1) return;
    const v = w.muzzle;
    const h = muzzleY - _aim.y;
    const k = (g * flat * flat) / (2 * v * v);
    const disc = flat * flat - 4 * k * (k - h);
    if (disc < 0) return;
    const theta = Math.atan((flat - Math.sqrt(disc)) / (2 * k));
    _dir.set((dx / flat) * Math.cos(theta), Math.sin(theta), (dz / flat) * Math.cos(theta)).normalize();
    const rng = world.rng ? world.rng : Math.random;
    scatter(_dir, w.spread, rng, _shot);
    world.bullets.push(new Bullet({
      pos: _muzzle, dir: _shot, speed: v,
      damage: w.dmg[0] + rng() * (w.dmg[1] - w.dmg[0]),
      shooter: this, life: w.life, gravity: g, pierce: true,
    }));
    m.reload = w.reloadSeconds;
    this.firing = true;
    this.heading = headingOf(dx, dz);
    world.onGunFire?.(this, target, 1, v);
  }

  /**
   * 赤外線 SAM（§68.2）。**目で見て撃つ。**
   *
   * レーダーを使わないので、
   *   ・逆探知に映らない（`radar: null` なので `rwrSignature` が 0）
   *   ・ARM で黙らせられない（沈黙する電波がない）
   *   ・**探知の輪に頼らず、自分の目で捉えた相手だけを撃つ**
   * という3つが同時に成り立つ。
   *
   * 「見えている」は `detection.isVisible` ではなく**この砲からの距離と視線**で見る。
   * 探知の輪（陣営で共有される）を使うと、
   * **遠くの味方が見つけた機体へ撃ってしまう** —— それはレーダーの働きになる。
   */
  _updateIrSam(dt, world, m) {
    if (m.reload > 0 || m.ammo <= 0) return;
    const w = m.w;
    let best = null; let bestD = Infinity;
    for (const u of world.units) {
      if (!u.alive || u.side === this.side || u.kind !== 'aircraft' || u.onGround) continue;
      const agl = u.pos.y - this.pos.y;
      if (agl < w.minAlt || agl > w.maxAlt) continue;
      const d = this.pos.distanceTo(u.pos);
      if (d > w.range || d >= bestD) continue;
      // 赤外線SAM は自分の目で見る（§68.2）。**雲で切れる**（§88.3）
      if (!opticalSight(world, this.pos, u.pos, 8, 300)) continue;
      bestD = d; best = u;
    }
    if (!best) return;
    world.combat.fireGround(this, best, WEAPONS['IR-SAM']);
    m.ammo--;
    m.reload = w.reloadSeconds;
  }

  /** 交戦可能な空中目標のうち最も近いもの */
  _pickAirTarget(world, w) {
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
      // 対空砲も自分の目で見る（§8）。**雲で切れる**（§88.3）
      if (!opticalSight(world, this.pos, u.pos, 8, 300)) continue;

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
  _updateAaa(dt, world, m) {
    const w = m.w;

    // 砲座は1つにつき1目標。最も近いものを撃つ。
    let target = null, bestD = Infinity;
    for (const u of world.units) {
      if (!u.alive || u.side === this.side || u === this) continue;
      if (!aims(w, u)) continue;                       // 狙う種類か（§67.1）
      const air = u.kind === 'aircraft' && !u.onGround;
      if (air) {
        // 空中目標は**射高で切る**。ここが二値なのは §8 からの設計の柱
        const agl = u.pos.y - this.pos.y;
        if (agl < 0 || agl > w.maxAlt) continue;
        // 見えていない機体は撃てない
        if (!world.detection.isVisible(this.side, u)) continue;
      }
      const d = this.pos.distanceTo(u.pos);
      if (d > w.range || d >= bestD) continue;
      // §88.3。地上の相手は目の高さを取る（§103）
      if (!(air ? opticalSight(world, this.pos, u.pos, 8, 200) : groundSight(world, this.pos, u.pos))) continue;
      bestD = d; target = u;
    }
    if (!target) return;

    // 砲口は地面から少し上に置く。地表ちょうどから撃つと、
    // 自分の足元の起伏に当たって弾が即座に消える。
    _muzzle.set(this.pos.x, this.pos.y + MUZZLE_HEIGHT, this.pos.z);

    // 偏差射撃の狙点。**目標が曲がればその前提が崩れて外れる** —
    // それがこの変更のすべて（§22.2 と同じ理屈）。
    aimPointOf({ pos: _muzzle }, target, w.muzzle, _aim);
    // 地上の相手は地表＋目の高さを狙う（§103・主砲と同じ理由）。見える線と撃つ線を揃える
    if (!(target.kind === 'aircraft' && !target.onGround)) _aim.y += GROUND_EYE;
    _dir.set(_aim.x - _muzzle.x, _aim.y - _muzzle.y, _aim.z - _muzzle.z).normalize();

    // 発射数は端数を持ち越す。dt が小さいと毎回0発になってしまう。
    m.accum += w.rps * dt;
    const n = Math.floor(m.accum);
    if (n <= 0) return;
    m.accum -= n;

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
    // 発砲を外へ知らせる（銃口の火花と音）。機体の機銃と同じ口を使う。
    // **実体弾にした時点でここが要る** — 弾は見えるのに無音だった。
    world.onGunFire?.(this, target, n, w.muzzle);
  }

  /** 地表に接地させる（配置時に呼ぶ） */
  groundTo(terrain) {
    // 艦船と空母は海面（y=0）。それ以外は地表に置く
    this.pos.y = (this.spec.category === 'ship' || this.spec.category === 'carrier')
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
