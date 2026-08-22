// 戦闘機の飛行モデルと指示処理。
//
// プレイヤーは操縦しない（完全指揮型RTS）ため、飛行モデルは
// 「指示 → 目標方位・目標高度・目標速度 → 物理的に到達可能な範囲で追従」
// という素直な構造にしてある。厳密な空力ではなく、
//   ・旋回半径が速度に依存する
//   ・上昇すると減速し、降下すると加速する（エネルギー交換）
//   ・地形に突っ込まない
// という「戦術判断に効く挙動」だけを再現する。

import * as THREE from 'three';
import { Unit, headingOf, angleDiff, DEG, RWR_SIGNATURE_FACTOR } from './unit.js';
import { getType } from '../data/aircraft.js';
import { loadoutSlots, loadoutFuelBonus } from '../data/weapons.js';
import { attackManeuver, defensiveManeuver, groundAttackRun } from './acm.js';
import { SHAPE as FORMATION_SHAPE } from '../ai/formation.js';
import { clamp } from '../core/rng.js';
import { thrustFactor, turnFactor, maxSpeedFactor } from '../core/atmosphere.js';
import { APPROACH_DISTANCE } from './airbase.js';

/** 地表から確保する最低高度(m) */
const MIN_AGL = 220;
/** 地形先読みのサンプル間隔(m)。地形グリッド(200m)より細かくして尾根の見落としを防ぐ。 */
const LOOK_STEP = 150;
/** 細かく見る距離。これより先は粗いサンプルで足りる。 */
const LOOK_NEAR = 3000;
/** 先読み距離の設計根拠。これだけの高度差を登り切れる時間ぶん先まで見る。 */
const RIDGE_CLIMB = 2200;
/** 指令高度を下げるときの平滑化（1秒あたりの残存率）。小さいほど機敏。 */
const ALT_SMOOTH = 0.02;
/** 爆撃機の進入高度（目標からの相対）。軽対空砲の射高1800mより上に置く。 */
const BOMBER_RUN_ALT = 2100;
/**
 * 登り切れないときに試す針路のずらし幅（ラジアン）。左右交互に、浅い角度から試す。
 * 引き返す角度まで含めないと、袋小路の谷に入ったときに出口が見つからない。
 */
const ESCAPE_TURNS = [0.5, -0.5, 1.0, -1.0, 1.6, -1.6, 2.3, -2.3, Math.PI];
/**
 * この値を超えたら「登り切れない」と判断して針路を変える。
 * 1.0（＝ぎりぎり間に合う）で判断すると、気づいた時にはもう避けられない。
 */
const CLIMB_DEMAND_LIMIT = 0.65;
/** 巡航速度・最大舵時の減速(m/s^2)。旋回はエネルギーを消費する。 */
const TURN_DRAG = 5.5;
/** 到達判定の基準を旋回半径の何倍にするか */
const ARRIVE_FACTOR = 0.9;
/**
 * 逆探知される距離を、そのレーダーの射程の何倍にするか（§26.3）。
 *
 * 1.0 では「見つけたときには相手も見えている」ので駆け引きが消える。
 * 1.5 なら**相手のレーダー射程の外側 0.5 倍ぶんの帯**ができ、
 * そこではこちらだけが相手を知っている。これが電波管制の報酬になる。
 */
export const RWR_AIR_FACTOR = RWR_SIGNATURE_FACTOR;

/**
 * デコイを撒き始める残り秒数（§28.4.1）。練度で変わる。
 *
 * 練度1で 11秒 ＝ レーダー弾の警戒範囲(14km)に入った直後。
 * デコイは遠いほど効く（§28.4）ので、これが最良の撒き方になる。
 */
const DECOY_TTI_EARLY = 11;
const DECOY_TTI_LATE = 3.5;
/** 連続投射の間隔(秒) */
const DECOY_INTERVAL = 1.2;

/**
 * ここから終末の切り返しに寄せ始める残り秒数（§28.5）。
 * 真横を向いたまま待つと最後は追いつかれるので、突っ込む向きへ寄せて
 * ミサイルに大きな先行角を取らせる。
 */
const BREAK_TTI = 2.5;

/** クランクで振る角度を、ロックの扇の何割までにするか（§28.7） */
const CRANK_FRACTION = 0.6;

/** コーナー速度の既定値（巡航速度に対する割合・§29.2） */
const CORNER_FRACTION = 0.85;

/** ミリタリー推力（AB無し）の上限。最大速度・加速度に対する割合（§29.3） */
const MIL_SPEED_FRACTION = 0.78;
const MIL_ACCEL_FRACTION = 0.55;

/** 帰投中の巡航高度と、上げてよい条件（§29.5） */
const RTB_CRUISE_ALT = 8000;
const RTB_CLIMB_MIN_DIST = 15000;
const RTB_CLEAR_RANGE = 30000;

const _tmp = new THREE.Vector3();

export class Aircraft extends Unit {
  constructor(o) {
    const spec = getType(o.type);
    super({ ...o, kind: 'aircraft', hp: spec.hp, name: o.name || spec.id });

    this.spec = spec;
    this.typeId = spec.id;
    this.loadout = (o.loadout || []).slice();

    this.speed = o.speed ?? spec.cruiseSpeed;
    this.pos.y = o.alt ?? 3000;
    this.desiredAlt = this.pos.y;
    this.desiredSpeed = spec.cruiseSpeed;
    /**
     * アフターバーナーの方針（§29.3）。'save' | 'normal' | 'max'
     * 指揮官が指定するのは**意図**で、いつ点火するかは機体が決める。
     */
    this.abMode = 'normal';
    this.abActive = false;
    /** 標準方針で「いま焚きたい」状況か（攻撃指示・空戦中）。毎ステップ決める */
    this._abWanted = false;

    this.fuelMax = spec.fuelSeconds * loadoutFuelBonus(this.loadout);
    this.fuel = this.fuelMax;
    this.gun = spec.gunRounds;
    this.flares = spec.flares;
    this.chaff = spec.chaff;

    // 見た目用（描画側が参照する）
    this.roll = 0;
    this.pitch = 0;
    /** 実際の旋回率(rad/s)。毎ステップ更新する */
    this.turnRate = 0;
    /**
     * プレイヤーが指定した高度(m)。指定が無ければ null。
     * 指示(order)ではなく機体が持つ。攻撃指示を出し直しても消えないようにするため。
     */
    this.commandedAlt = null;

    /** 指示。order が現在の指示、queue が Shift+右クリックで積んだ待ち行列 */
    this.order = { type: 'orbit', x: this.pos.x, z: this.pos.z, radius: 2500 };
    this.queue = [];

    /**
     * 'flying' 飛行中 / 'landing' 最終進入・滑走 / 'parked' 駐機 /
     * 'servicing' 整備中 / 'ready' 整備完了・発進待ち / 'takeoff' 離陸滑走
     */
    this.state = 'flying';
    this.deathCause = null;
    this.rolling = false;          // 滑走路上を転がっているか
    this.airbase = null;

    /** 離陸時の搭載。帰投後の既定の再装備内容になる。 */
    this.baseLoadout = this.loadout.slice();
    /** プレイヤーが指定した次回の搭載（未指定なら baseLoadout） */
    this.plannedLoadout = null;

    /** AIモード（ai/pilot.js が解釈する）。プレイヤーがユニット単位で切り替える。 */
    this.aiMode = o.aiMode || 'PATROL';
    /** 索敵のための機首の振り。レーダーが前方扇形なので、これが死角を減らす。 */
    this.headingBias = 0;
    this.patrolArea = null;
    this.escortTarget = null;
    this.strikeTarget = null;
    this.formationSlot = 0;
    this.formation = null;

    /** 自分を狙って飛来中で、かつ気づけているミサイル（sim/combat.js が毎tick更新） */
    this.threats = [];

    /**
     * 練度 0..1。難易度を「機数」ではなく「腕」で調整するためのダイヤル。
     * 判断の速さ・撃つ判断・機銃の当たりやすさ・回避の質にまとめて効く。
     * 1 が満点で、既定。ステージ側から敵に低い値を与えて難易度を下げる。
     */
    this.skill = o.skill != null ? clamp(o.skill, 0.2, 1) : 1;
    this.fireCooldown = 0;
    this._decoyTimer = 0;
    /** デコイを自動で撒くか（§9.5）。兵装の自動使用と同じ扱いの独立トグル */
    this.autoDecoy = true;
    /** いまビーム機動中か（§28.6 の低空ノッチ判定が読む） */
    this.beaming = false;
    this.evading = false;
    this.cranking = false;

    /** ミサイル誘導中でも回避機動を取るか（false なら誘導を優先して耐える） */
    this.evadeWhileGuiding = true;
    /** プレイヤーが指定した使用兵装。null ならAIが選ぶ。 */
    this.selectedWeapon = null;
    /** プレイヤーの射撃指示 [{weapon, target}]。攻撃目標は変えずに撃つ。 */
    this.fireTasks = [];
    /** AIが自動発射に踏み切る命中期待度 'low' | 'mid' | 'high' */
    this.fireThreshold = 'mid';
    /** 兵装種別ごとの自動使用可否。false にするとAIが勝手に使わない。 */
    this.autoWeapons = {};

    /**
     * レーダーの扱い（§26.5）。'auto' | 'on' | 'off'
     *
     * 既定を自動にしておく。§22.3.1 で「軸を増やすと指揮官の判断としては
     * 細かすぎる」と決めた経緯があるので、**普段は意識せずに済む**ようにして、
     * 必要なときだけ固定できる形にする。
     */
    this.radarMode = 'auto';
    /** いまレーダーを出しているか。探知・レーダー誘導・逆探知のすべてに効く */
    this.radarActive = true;
  }

  /**
   * いま届くレーダー距離。切っていれば 0。
   * 地上ユニット（sim/ground.js）と同じ形にして、沈黙の扱いを1つに保つ。
   */
  get radarRange() {
    if (!this.radarActive || !this.alive || this.onGround) return 0;
    return this.spec.radarRange || 0;
  }

  /** 逆探知に映るか（§26.3） */
  get emitting() {
    return this.radarRange > 0;
  }

  /** 逆探知される距離。強いレーダーほど遠くから見つかる（§26.3） */
  get rwrSignature() {
    return this.radarRange * RWR_SIGNATURE_FACTOR;
  }

  // ------------------------------------------------------------- 指示

  /** 指示を設定。append=true なら待ち行列に積む */
  setOrder(order, append = false) {
    if (append && this.order && this.order.type !== 'orbit') {
      this.queue.push(order);
    } else {
      this.order = order;
      this.queue.length = 0;
    }
  }

  clearOrders() {
    this.order = { type: 'orbit', x: this.pos.x, z: this.pos.z, radius: 2500 };
    this.queue.length = 0;
  }

  /** 経路表示用: 現在地から順に辿る目標地点のリスト */
  waypoints() {
    const pts = [];
    const push = (o) => {
      if (!o) return;
      if (o.type === 'move' || o.type === 'orbit') pts.push({ x: o.x, z: o.z, alt: o.alt ?? this.desiredAlt });
      else if (o.type === 'rtb' && o.airbase) {
        pts.push({ x: o.airbase.pos.x, z: o.airbase.pos.z, alt: o.airbase.pos.y + 400 });
      }
      else if ((o.type === 'follow' || o.type === 'attack') && o.target && o.target.alive) {
        pts.push({ x: o.target.pos.x, z: o.target.pos.z, alt: o.target.pos.y, hostile: o.type === 'attack' });
      }
    };
    push(this.order);
    for (const o of this.queue) push(o);
    return pts;
  }

  // ------------------------------------------------------------- 更新

  /** 地上にいる（レーダーに映らず、飛行処理も行わない） */
  get onGround() {
    return this.state === 'parked' || this.state === 'servicing' || this.state === 'ready'
      || this.state === 'takeoff' || (this.state === 'landing' && this.rolling);
  }

  update(dt, world) {
    if (!this.alive) return;

    switch (this.state) {
      case 'parked':
      case 'servicing':
      case 'ready':
        return;                                  // 整備中。時間は飛行場側が進める
      case 'takeoff':
        this._updateTakeoff(dt, world);
        return;
      case 'landing':
        this._updateLanding(dt, world);
        return;
      default:
        break;
    }

    this._updateRadar(world);
    this._steer(dt, world);
    this._integrate(dt, world);
    this._consumeFuel(dt, world);
    this._checkBingoFuel(world);
  }

  // ------------------------------------------------------------- 離着陸

  /**
   * 最終進入と着陸滑走。
   * 通常の飛行処理は最低対地高度を確保してしまうので、着陸だけは別経路にする。
   */
  _updateLanding(dt, world) {
    const ab = this.airbase;
    if (!ab || !ab.alive) {                      // 着陸先を失った
      this.state = 'flying';
      this.rolling = false;
      this.clearOrders();
      return;
    }

    const dir = ab.runwayDir;
    const start = ab.runwayStart;
    const along = _tmp.copy(this.pos).sub(start).dot(dir);   // 滑走路始端からの距離
    const toTouchdown = 250 - along;                          // 接地点まで（正=手前）

    if (!this.rolling) {
      // 滑走路軸上の少し先を狙う。横ズレが自然に収束する。
      const lead = clamp(Math.abs(toTouchdown) * 0.7, 600, 3000);
      const aim = start.clone().addScaledVector(dir, Math.min(250, along + lead));
      const desiredHeading = headingOf(aim.x - this.pos.x, aim.z - this.pos.z);

      const maxTurn = this.effectiveTurnRate * dt;
      this.heading += clamp(angleDiff(desiredHeading, this.heading), -maxTurn, maxTurn);
      this.roll += ((clamp(angleDiff(desiredHeading, this.heading), -0.3, 0.3) * 2) - this.roll) * dt * 2;

      // 接地点へ向かう降下角（約3.7度）。
      // ただし進入路の地形より下を通らないよう、接地直前以外はクリアランスを確保する。
      // これが無いと丘を突き抜けて進入してしまう。
      // 接地直前はフレア（機首上げ）に相当する分だけ余裕を無くし、確実に接地させる
      let glideAlt = ab.fieldAlt + Math.max(0, toTouchdown) * 0.065
        + (toTouchdown > 300 ? 6 : 0);
      if (toTouchdown > 700) {
        const f = this.forward();
        const ahead = Math.max(
          world.terrain.heightAt(this.pos.x, this.pos.z),
          world.terrain.heightAt(this.pos.x + f.x * 400, this.pos.z + f.z * 400),
          world.terrain.heightAt(this.pos.x + f.x * 900, this.pos.z + f.z * 900),
        );
        glideAlt = Math.max(glideAlt, Math.max(0, ahead) + 150);
      }
      const vs = clamp((glideAlt - this.pos.y) * 0.8, -55, 45);
      this.pos.y += vs * dt;
      this.pitch = Math.atan2(vs, Math.max(40, this.speed));

      // 進入中でも地面に当たれば墜落する（整地の誤差ぶんは許容）
      if (this.pos.y < Math.max(0, world.terrain.heightAt(this.pos.x, this.pos.z)) - 25) {
        this.deathCause = 'terrain';
        this.destroy();
        return;
      }

      // 進入速度まで減速
      const approachSpeed = this.spec.minSpeed * 1.12;
      this.speed += clamp(approachSpeed - this.speed, -8 * dt, 8 * dt) ;

      // 接地。滑走路上を浮いたまま通り過ぎないよう、行き過ぎたら強制的に降ろす。
      if ((this.pos.y <= ab.fieldAlt + 10 && toTouchdown < 500) || toTouchdown < -150) {
        this.rolling = true;
        this.pos.y = ab.fieldAlt;
        this.pitch = 0;
        this.roll = 0;
      }
    } else {
      // 接地後の滑走
      this.pos.y = ab.fieldAlt;
      this.heading += clamp(angleDiff(ab.runwayHeading, this.heading), -0.8 * dt, 0.8 * dt);
      this.speed = Math.max(0, this.speed - 9 * dt);
      if (this.speed <= 12) {
        this.rolling = false;
        ab.onArrive(this);
        world.log?.(`${this.name} 着陸`);
        return;
      }
    }

    const f = this.forward();
    this.pos.x += f.x * this.speed * dt;
    this.pos.z += f.z * this.speed * dt;
    this._consumeFuel(dt * 0.4);
  }

  /**
   * 離陸滑走から上昇まで。
   * 通常飛行へ渡すのは地面から十分離れてから。すぐ渡すと、
   * 通常飛行側の地形衝突判定（地表+20m）に引っかかって滑走路上で墜落する。
   */
  _updateTakeoff(dt, world) {
    const ab = this.airbase;
    if (!ab) { this.state = 'flying'; return; }

    this.heading = ab.runwayHeading;
    const ground = Math.max(0, world.terrain.heightAt(this.pos.x, this.pos.z));

    if (!this._rotated) {
      // 滑走
      this.pos.y = ab.fieldAlt;
      this.speed += 9 * dt;
      if (this.speed >= this.spec.minSpeed * 1.05) this._rotated = true;
    } else {
      // 引き起こして上昇
      this.speed += 6 * dt;
      const climb = this.spec.climbRate * 0.55;
      this.pos.y += climb * dt;
      this.pitch = Math.atan2(climb, Math.max(40, this.speed));
      if (this.pos.y - ground > 180) {
        this.state = 'flying';
        this.rolling = false;
        this._rotated = false;
        this._rtbTriggered = false;
        this.desiredAlt = ab.fieldAlt + 1500;
        if (!this.order || this.order.type === 'rtb') {
          this.order = { type: 'orbit', x: ab.pos.x, z: ab.pos.z, alt: ab.fieldAlt + 3000, radius: 4500 };
        }
      }
    }

    const f = this.forward();
    this.pos.x += f.x * this.speed * dt;
    this.pos.z += f.z * this.speed * dt;
    this._consumeFuel(dt * 0.6);
  }

  /** 手動モード（§9.5）。自発的な判断を一切しない */
  get manual() { return this.aiMode === 'MANUAL'; }

  /**
   * 燃料監視（仕様 §9.2）。
   * 最寄りの自軍飛行場まで戻れなくなる前に自動で帰投へ切り替える。
   *
   * 手動モードでは切り替えない。**代わりに一度だけ警告を出す。**
   * 黙って落ちるのと、言われたうえで落ちるのは別なので、
   * 「自分で判断する」を選んだ人にも折り返し点だけは知らせる。
   */
  _checkBingoFuel(world) {
    if (this._rtbTriggered || !this.order || this.order.type === 'rtb') return;
    if (this.manual) {
      if (!this._bingoWarned && this.fuel < this._bingoFuel(world)) {
        this._bingoWarned = true;
        world.log?.(`${this.name} 燃料残少 — 手動のため自動帰投しません`);
      }
      return;
    }
    const ab = this.nearestBase(world);
    if (!ab) { this._noHomeBase = true; return; }
    this._noHomeBase = false;
    const needed = this._bingoFuel(world, ab);
    if (this.fuel < needed) {
      this._rtbTriggered = true;
      // 指示だけでなく AI モードも帰投にする。
      // 指示しか変えないと、次のtickで AI（PURSUIT等）が目標を見つけて
      // 攻撃指示で上書きし、帰投が無かったことになる。
      // しかも _rtbTriggered が立っているので二度と燃料監視が働かず、
      // そのまま燃料切れで落ちる（実際にミッション4で多発していた）。
      this.aiMode = 'RTB';
      this.setOrder({ type: 'rtb', airbase: ab });
      world.log?.(`${this.name} 燃料残少 — 帰投`);
    }
  }

  /** 帰投に要る燃料(秒)。余裕を厚めに取る（ぎりぎりだと進入待ちや迂回で間に合わない） */
  _bingoFuel(world, base = null) {
    const ab = base || this.nearestBase(world);
    if (!ab) return 0;
    const dist = this.distanceTo(ab) + APPROACH_DISTANCE;
    return (dist / Math.max(80, this.spec.cruiseSpeed)) * 1.6 + 110;
  }

  /** 最寄りの自軍飛行場 */
  nearestBase(world) {
    let best = null, bestD = Infinity;
    for (const u of world.units) {
      // approachFix を持つ＝滑走路として運用できる飛行場だけを対象にする
      if (u.kind !== 'airbase' || !u.alive || u.side !== this.side) continue;
      if (typeof u.approachFix !== 'function') continue;
      const d = this.distanceTo(u);
      if (d < bestD) { bestD = d; best = u; }
    }
    return best;
  }

  /** 旋回半径(m)。速度が上がるほど大きくなる。 */
  get turnRadius() {
    return this.speed / Math.max(0.01, this.effectiveTurnRate);
  }

  /**
   * 実効旋回率(rad/s)。**構造の限界と揚力の限界の、低いほうを取る**（§29.2）。
   *
   *   構造限界 ω_s(V) = ω_ref × 巡航速度 / V     定G。速いほど鈍い
   *   揚力限界 ω_l(V) = K × σ(高度) × V          遅いほど鈍い
   *
   * 両者が交わる速度が**コーナー速度**で、そこが旋回率の頂点になる。
   *
   * 以前は構造側だけを持っていたので、**遅いほど良く曲がる**一方向だった
   * （`clamp` の上限 1.5 が偶然その代わりをしていた）。
   * つまり遅く飛ぶ理由が無い代わりに、**速く飛ぶ理由も無かった**。
   *
   * `σ` は揚力側だけに掛ける。構造の限界は空気の濃さと関係が無い。
   * こうすると**高度が上がるほどコーナー速度が上がる**という関係が自然に出て、
   * 高空では最大速度でも揚力制限に当たる ＝ どの速度でも曲がれなくなる。
   */
  get effectiveTurnRate() {
    const base = this.spec.turnRate * DEG;
    const cruise = this.spec.cruiseSpeed;
    const v = Math.max(60, this.speed);
    const vc = this.cornerSpeed;

    const structural = base * (cruise / v);
    const lift = base * (cruise / (vc * vc)) * turnFactor(this.pos.y) * v;

    const hpFactor = 0.6 + 0.4 * (this.hp / this.maxHp);
    // ハードポイント0の機体（早期警戒機）でゼロ除算しないよう下限を置く
    const loadFactor = 1 - 0.25 * (loadoutSlots(this.loadout) / Math.max(1, this.spec.hardpoints));
    return Math.min(structural, lift) * hpFactor * loadFactor;
  }

  /**
   * 帰投中、高度を上げてよいほど周りが静かか（§29.5）。
   *
   * 飛来ミサイルが無く、探知している敵機・SAM が近くにいないこと。
   * 見えていない脅威までは考えない — こちらも知らないものは避けられない。
   */
  _rtbClear(world) {
    if (this.threats.length > 0) return false;
    const det = world.detection;
    if (!det) return true;
    for (const [, c] of det.contactsFor(this.side)) {
      const t = c.unit;
      if (!t || !t.alive || t.side === this.side) continue;
      const air = t.kind === 'aircraft' && !t.onGround;
      if (!air && t.kind !== 'sam') continue;
      if (this.pos.distanceTo(t.pos) < RTB_CLEAR_RANGE) return false;
    }
    return true;
  }

  /** 海面でのコーナー速度(m/s)。高度が上がると実効的にはこれより上がる */
  get cornerSpeed() {
    return this.spec.cornerSpeed || this.spec.cruiseSpeed * CORNER_FRACTION;
  }

  /**
   * その高度で出せる水平最大速度(m/s)。**アフターバーナー全開の値**（§29.3）。
   *
   * `spec.maxSpeed` は AB を焚いた状態の数字として読む。データは書き換えない。
   * 中距離ミサイルの射程も、この状態で撃つことを前提にしている。
   */
  get altitudeMaxSpeed() {
    return this.spec.maxSpeed * maxSpeedFactor(this.pos.y);
  }

  /** ミリタリー推力（AB無し）で出せる水平最大速度(m/s) */
  get milSpeed() {
    return this.altitudeMaxSpeed * MIL_SPEED_FRACTION;
  }

  /**
   * いま AB を焚いているか（§29.3）。
   *
   * **操作は「意図」を選ばせる**（温存 / 標準 / 全力）。常時ON/OFF にしないのは、
   * 常時ON なら燃料が4分で尽き、常時OFF ならミサイルから逃げられないので、
   * **どちらの端も選ばれない**から。いつ点火するかは機体が決める。
   */
  get afterburner() {
    if (this.onGround || !this.alive) return false;
    // 出したい速度がミリタリーで届かないときだけ意味がある
    if (this.desiredSpeed <= this.milSpeed) return false;
    switch (this.abMode) {
      case 'max':  return true;
      case 'save': return this.threats.length > 0;       // 逃げるときだけ
      default:     return this.threats.length > 0 || this._abWanted;
    }
  }

  /** 比エネルギー(m)。高度と速度を足し合わせた「戦う余力」（§29.4） */
  get specificEnergy() {
    return this.pos.y + (this.speed * this.speed) / (2 * 9.81);
  }

  /** 現在高度での推力の割合（UI表示用） */
  get thrustRatio() { return thrustFactor(this.pos.y); }

  _steer(dt, world) {
    const o = this.order;
    let desiredHeading = this.heading;
    let desiredAlt = this.desiredAlt;
    let desiredSpeed = this.spec.cruiseSpeed;

    switch (o.type) {
      case 'move': {
        const dx = o.x - this.pos.x, dz = o.z - this.pos.z;
        const dist = Math.hypot(dx, dz);
        desiredHeading = headingOf(dx, dz);
        if (o.alt != null) desiredAlt = o.alt;
        if (o.speed != null) desiredSpeed = o.speed;
        const arrive = Math.max(500, this.turnRadius * ARRIVE_FACTOR);
        if (dist < arrive) this._advanceOrder();
        break;
      }

      case 'orbit': {
        const dx = o.x - this.pos.x, dz = o.z - this.pos.z;
        const dist = Math.hypot(dx, dz);
        const R = o.radius || Math.max(2000, this.turnRadius * 1.6);
        if (o.alt != null) desiredAlt = o.alt;
        if (dist > R * 2.2) {
          desiredHeading = headingOf(dx, dz);      // まだ遠い → 直進
        } else {
          // 中心を左に見ながら旋回。半径のズレを方位に足して収束させる。
          const toCenter = headingOf(dx, dz);
          const err = clamp((dist - R) / R, -0.7, 0.7);
          desiredHeading = toCenter - Math.PI / 2 + err;
        }
        desiredSpeed = this.spec.cruiseSpeed * 0.9;
        break;
      }

      case 'attack': {
        const t = o.target;
        if (!t || !t.alive) { this._advanceOrder(); break; }
        const dx = t.pos.x - this.pos.x, dz = t.pos.z - this.pos.z;
        desiredHeading = headingOf(dx, dz);

        // 空中目標は空戦機動へ委ねる（§22.3）。
        // 「どう飛んで狙うか」は幾何で決まるので、ここでは結果を受け取るだけ。
        if (t.kind === 'aircraft' && !t.onGround) {
          const m = attackManeuver(this, t, world);
          this.acmMode = m.mode;
          if (m.mode !== 'extend') this._acmExtending = false;
          desiredHeading = m.heading;
          desiredAlt = m.alt;
          desiredSpeed = m.speed;
          // クランク機動だけは機動より優先する。
          // AAM-M を誘導している間は照射を切らさないほうが得。
          if (this._guidingSarhAt(t, world)) {
            // クランクの角度は**ロックの扇**から決める（§28.7）。
            // 索敵の扇（±60°）で計算していたので 48° まで振れて、
            // 掴んだまま逃げる代償がほとんど無かった。
            // クランクは**扇の6割**まで。残りは余裕として空ける。
            //
            // 「扇いっぱいまで振る」にしたら、誘導が切れた 26 件のうち 18 件が
            // **自分の機首が扇の縁に届いた**ことによる自滅だった。
            // 目標が少し動くだけで切れるので、クランクが自分の首を絞めていた。
            const lockFov = this.spec.radarLockFovH ?? this.spec.radarFovH ?? 60;
            const crank = Math.max(8, lockFov * CRANK_FRACTION) * DEG;
            const off = angleDiff(headingOf(dx, dz), this.heading);
            desiredHeading = headingOf(dx, dz) + (off >= 0 ? -crank : crank);
            this.cranking = true;
          } else {
            this.cranking = false;
          }
          break;
        }
        this.acmMode = null;

        this.cranking = false;

        // ここから先は地上目標。
        // 進入と離脱を分ける（§22.5）。真っ直ぐ向かうだけだと、通り過ぎた瞬間に
        // 方位が反転して引き返し、目標の周りを回り続けることになる。
        // 地上目標は**そこに居ると思っている位置**へ向かう（§25.4）。
        // 逆探知だけで掴んでいる相手なら、そのぶんずれた場所へ入っていく。
        const aim = (world.believedPosOf && world.believedPosOf(this.side, t)) || t.pos;
        const run = groundAttackRun(this, t, aim);
        desiredHeading = run.heading;
        this.attackRun = run.phase;
        const egress = run.phase === 'out';
        const flat = run.flat;

        // 「爆弾を積んでいれば投下高度を保つ」「そうでなければ降りて掃射する」。
        if (o.alt != null || this.commandedAlt != null) {
          // プレイヤーが高度を指定していればそれに従う
          // （高高度からの爆撃など、意図した高度で攻撃させるため）
          desiredAlt = o.alt ?? this.commandedAlt;
        } else if (this.loadout.includes('BOMB')) {
          // 爆撃機は軽対空砲の射高より上から入る。攻撃機は低く入って正確に落とす。
          // 目標+900m だと対空砲(射高1800m)の内側で、1回投下したら落とされて終わる。
          // 高く入るぶん散布界が広がるので、そのぶん多く積ませて釣り合いを取る。
          const bombRun = this.spec.role === '爆撃' ? BOMBER_RUN_ALT : 900;
          desiredAlt = Math.max(t.pos.y + bombRun, this._terrainFloor(world, desiredHeading) + 300);
        } else {
          // 機銃掃射: 目標へ向かう緩い降下角を保つ。
          // 水平飛行のまま近づくと、目標が真下に来て機首が向かず撃てない。
          desiredAlt = flat < 6000
            ? t.pos.y + clamp(flat * 0.18, 120, 900)
            : Math.max(t.pos.y + 900, this._terrainFloor(world, desiredHeading) + 300);
        }
        // 離脱中は目標ではなく**進む先**の地面を見る。
        // 掃射の高度は目標からの距離で決まるので、離れる向きに山があると
        // そのまま突っ込む（進入中は地面すれすれに降りるのが正しいので、ここだけ）。
        if (egress) {
          desiredAlt = Math.max(desiredAlt, this._terrainFloor(world, desiredHeading) + 300);
        }
        // 遠いうちは巡航で進出し、交戦距離に入ってから加速する（燃料は3倍消費する）。
        // 爆撃進入だけは速度を落とす。速いほど投下点の窓が短くなって当たらない。
        desiredSpeed = this.loadout.includes('BOMB') && !egress
          ? this.spec.cruiseSpeed * 0.85
          : (flat > 15000
            ? this.spec.cruiseSpeed * 1.05
            : this.altitudeMaxSpeed * 0.92);
        break;
      }

      case 'follow': {
        const t = o.target;
        if (!t || !t.alive) { this._advanceOrder(); break; }
        // リーダーの後方・側方にオフセットした位置を狙う
        const slot = o.slot ?? 1;
        const side = slot % 2 === 0 ? 1 : -1;
        const rank = Math.ceil(slot / 2);
        const f = t.forward();
        const rx = -f.z, rz = f.x;                 // 右手方向
        // 隊形で間隔が変わる（§22.4）。密集は護衛向き、横隊は相互支援向き。
        const shape = FORMATION_SHAPE[this.formationShape] || FORMATION_SHAPE.SPREAD;
        const back = shape.back * rank, lat = shape.lateral * rank * side;
        const tx = t.pos.x - f.x * back + rx * lat;
        const tz = t.pos.z - f.z * back + rz * lat;
        const dx = tx - this.pos.x, dz = tz - this.pos.z;
        const dist = Math.hypot(dx, dz);

        // ズレはリーダーの進行方向に沿って符号付きで見る。
        //   along > 0 … スロットはまだ前。追いつく必要がある
        //   along < 0 … 行き過ぎている。減速して戻る
        // 符号なしの距離で速度を決めると、追い越したあとも「離れている」と判断して
        // さらに加速し、いつまでも前に出続ける（護衛が被護衛機を追い越す原因だった）。
        const along = dx * f.x + dz * f.z;
        const lateral = dx * rx + dz * rz;

        // 前に出すぎたときは向きを変えずに減速だけで戻す。
        // 旋回で戻そうとすると編隊が蛇行する。
        const overshot = along < 0 && Math.abs(lateral) < 400;
        desiredHeading = overshot ? t.heading
          : (dist > 250 ? headingOf(dx, dz) : t.heading);
        desiredAlt = t.pos.y;

        // 追いつくのは速く、行き過ぎたら確実に落とす（非対称にする）
        const corr = along > 0
          ? Math.min(along * 0.30, 140)
          : Math.max(along * 0.40, -90);
        desiredSpeed = clamp(t.speed + corr, this.spec.minSpeed, this.spec.maxSpeed);
        break;
      }

      case 'rtb': {
        // 帰投。進入開始点へ向かい、到達したら最終進入へ引き継ぐ。
        const ab = o.airbase && o.airbase.alive ? o.airbase : this.nearestBase(world);
        if (!ab) { this._advanceOrder(); break; }
        o.airbase = ab;
        const fix = ab.approachFix(world.terrain);
        const dx = fix.x - this.pos.x, dz = fix.z - this.pos.z;
        const dist = Math.hypot(dx, dz);
        desiredHeading = headingOf(dx, dz);
        desiredAlt = fix.y;
        desiredSpeed = dist > 12000 ? this.spec.cruiseSpeed : this.spec.minSpeed * 1.35;

        // 周りが静かなら燃費のいい高度まで上げる（§29.5）。
        // 燃料消費は 6,000m 超で 0.7倍、1,000m 未満で 1.4倍。帰るだけなら高いほうが得。
        // 脅威があれば低空のまま帰る — 燃費より生き延びるほうが先。
        if (dist > RTB_CLIMB_MIN_DIST && this._rtbClear(world)) {
          desiredAlt = Math.max(desiredAlt, Math.min(RTB_CRUISE_ALT, this.spec.ceiling - 800));
        }

        if (dist < 2200) {
          this.state = 'landing';
          this.airbase = ab;
          this.rolling = false;
        }
        break;
      }

      case 'hold':
      default:
        desiredHeading = this.heading;
        break;
    }

    // 待機旋回中はAIが指示した角度だけ機首を振り、レーダーの扇で広く探る
    if (o.type === 'orbit' && this.headingBias) desiredHeading += this.headingBias;

    // --- 防御機動（§22.3） ---
    //
    // 後ろに付かれて機銃を向けられていたら、指示より優先して旋回する。
    // 機銃が実体弾になったので、曲がれば相手の偏差が崩れて当たらなくなる。
    // 撃たれているのに真っ直ぐ飛び続けるのがいちばん悪い。
    // ミサイル回避のほうが上位（そちらは当たれば即死ぶんが大きい）。
    const brk = !this.manual && this.threats.length === 0 && !this.onGround
      ? defensiveManeuver(this, world) : null;
    this.breaking = !!brk;
    if (brk) {
      this.acmMode = brk.mode;
      desiredHeading = brk.heading;
      desiredAlt = brk.alt;
      desiredSpeed = brk.speed;
    }

    // --- ミサイル回避（どの指示よりも優先して割り込む） ---
    //
    // 手動モードは機動しない。ただし**デコイは撒く**（自動使用の設定に従う）。
    // 「機動するかどうか」と「対抗手段を使うかどうか」は別の判断なので分けてある。
    if (this.threats.length === 0) { this._evadeSide = null; this.beaming = false; }
    if (this.manual) {
      const m = this.threats[0];
      if (m && m.alive) {
        const d = Math.hypot(m.pos.x - this.pos.x, m.pos.z - this.pos.z);
        this._maybeDeployDecoy(world, dt, m, d / Math.max(60, m.speed));
      }
    }
    const evade = !this.manual && this.threats.length > 0 ? this._evade(world, dt) : null;
    this.evading = !!evade;
    if (evade) {
      desiredHeading = evade.heading;
      desiredAlt = evade.alt;
      desiredSpeed = evade.speed;
    }

    // --- 地形回避（さらに優先） ---
    //
    // 高度を上げるだけでは足りない場合がある。上昇率の低い機体が急峻な尾根へ
    // 向かうと、機首を上げても物理的に間に合わず山肌に突っ込む。
    // 登り切れないと分かったら、登れる方角へ逃がす。
    let scan = this._terrainScan(world, desiredHeading);
    const demand = this._climbDemand(scan);
    if (demand > CLIMB_DEMAND_LIMIT) {
      let best = null;
      for (const off of ESCAPE_TURNS) {
        const h = desiredHeading + off;
        const s2 = this._terrainScan(world, h);
        const d = this._climbDemand(s2);
        if (!best || d < best.d) best = { d, h, scan: s2 };
        if (d < CLIMB_DEMAND_LIMIT * 0.6) break;   // 十分に楽な方角が見つかったら打ち切る
      }
      if (best && best.d < demand) {
        desiredHeading = best.h;
        scan = best.scan;
      }
      this.terrainAvoiding = true;
      // 速度を落として時間を稼ぐ。上昇率は変わらないが、
      // 壁に着くまでの時間が延びるぶん高度を稼げる。
      desiredSpeed = Math.min(desiredSpeed, this.spec.minSpeed * 1.15);
    } else {
      this.terrainAvoiding = false;
    }
    const floor = scan.floor;
    if (desiredAlt < floor) desiredAlt = floor;
    desiredAlt = clamp(desiredAlt, 100, this.spec.ceiling);

    this._desiredHeading = desiredHeading;

    // 指令高度は毎フレームそのまま渡さない。
    //
    // 地形先読みの結果は針路が変わるたびに動くし、回避の目標高度も状況で揺れる。
    // 生の値を渡すと機首が上下に振動し、上昇率の大きい機種ほど激しく振れる。
    // 爆弾の投下条件（弾道解の窓）が揃わなくなるのはこれが原因。
    //
    // ただし**上げる方向は即座に反映する**。地形回避は遅らせてはいけない。
    if (desiredAlt >= this.desiredAlt) {
      this.desiredAlt = desiredAlt;
    } else {
      const k = 1 - Math.pow(ALT_SMOOTH, dt);
      this.desiredAlt += (desiredAlt - this.desiredAlt) * k;
      if (this.desiredAlt < floor) this.desiredAlt = floor;
    }
    desiredAlt = this.desiredAlt;
    // 「全力」は**移動中も速く飛ぶ**（§29.3）。
    //
    // これが無いと「標準」と区別が付かない。巡航速度はミリタリー推力の
    // 内側なので、交戦していないあいだは AB を焚く理由がそもそも生まれない。
    // 早く着くことに価値がある場面（迎撃の間に合わせ）で選ぶ意味を持たせる。
    if (this.abMode === 'max' && this.state === 'flying'
        && o && o.type !== 'rtb' && o.type !== 'orbit') {
      desiredSpeed = Math.max(desiredSpeed, this.altitudeMaxSpeed * 0.9);
    }

    // **コーナー速度を下回らない**（§29.2）。
    //
    // 下回ると曲がれなくなり、曲がれないから逃げられず、さらに速度を失う。
    // 実機の操縦者が最初に覚えることで、AI にも同じことをさせる。
    // これが無いと、コーナー速度を入れた瞬間に**AIが自分で罠にはまる**
    // （実測: 空戦中に 111m/s まで落ちて、旋回率が半分以下になっていた）。
    //
    // 掛けるのは戦っているあいだだけ。着陸進入や待機旋回では遅くてよい。
    const fighting = !this.onGround && this.state === 'flying'
      && (this.acmMode || this.threats.length > 0 || this.breaking);
    if (fighting) desiredSpeed = Math.max(desiredSpeed, this.cornerSpeed);

    // 「標準」方針で AB を焚きたい状況（§29.3）。
    // 敵機への攻撃指示が出ている、または空戦機動に入っているとき。
    // 対地攻撃や移動では焚かない — そこは燃料のほうが大事。
    const o2 = this.order;
    this._abWanted = !!(o2 && o2.type === 'attack' && o2.target && o2.target.alive
      && o2.target.kind === 'aircraft' && !o2.target.onGround);

    this.desiredSpeed = clamp(desiredSpeed, this.spec.minSpeed, this.altitudeMaxSpeed);
  }

  /**
   * ミサイル回避。
   *
   * ビーム機動（ミサイルを真横に置く）でシーカーの追従を難しくし、
   * 終末段階では降下して地面近くへ逃げる。同時にデコイを投射する。
   * 仕様 §9.2「ミサイル警戒」に相当し、AIモードを問わず割り込む。
   */
  /** セミアクティブ誘導のミサイルを、この目標に対して誘導中か */
  /**
   * レーダーを出すかどうか（§26.5）。
   *
   * 自動のときだけ考える。固定しているなら言われたとおりにする。
   */
  _updateRadar(world) {
    if (this.radarMode !== 'auto') {
      this.radarActive = this.radarMode === 'on';
      return;
    }
    this.radarActive = this._radarWanted(world);
  }

  _radarWanted(world) {
    // 1. AAM-M を誘導中は切れない。切ると自分の撃った弾が外れる
    if (this._guidingAnySarh(world)) return true;

    // 2. 空中目標へ攻撃指示が出ている。レーダー誘導兵装を使うため
    const t = this.order && this.order.type === 'attack' ? this.order.target : null;
    if (t && t.alive && t.kind === 'aircraft' && !t.onGround) return true;

    // 3. 相手のレーダー射程の内側に入った。**もう見られているので黙る意味がない**。
    //
    //    「逆探知で反応を拾ったら点ける」ではない。拾っただけの段階では、
    //    相手はまだこちらを見つけていないかもしれない（§26.3 の帯）。
    //    そこで点けると、黙っていれば取れたはずの優位を自分から捨てることになる。
    //    見つかっているかどうかは、相手のレーダー射程と距離から分かる。
    //
    //    見るのは**敵の航空機だけ**。地上レーダーまで数えると、敵地の上空では
    //    常に出しっぱなしになり、低く入って隠れる意味（§3）が消える。
    for (const u of world.units) {
      if (u.side === this.side || !u.alive) continue;
      if (u.kind !== 'aircraft' || u.onGround) continue;
      const r = u.radarRange;
      if (r > 0 && this.pos.distanceTo(u.pos) <= r) return true;
    }
    return false;
  }

  /** AAM-M を1発でも誘導中か */
  _guidingAnySarh(world) {
    if (!world.missiles) return false;
    for (const m of world.missiles) {
      if (m.alive && !m.lost && m.launcher === this && m.guidance === 'sarh') return true;
    }
    return false;
  }

  _guidingSarhAt(target, world) {
    if (!world.missiles) return false;
    return world.missiles.some((m) => m.alive && !m.lost
      && m.launcher === this && m.target === target && m.guidance === 'sarh');
  }

  /**
   * 自分が誘導し続けているセミアクティブ弾があるか（目標は問わない）。
   *
   * 「誘導を優先」の判定を指示の種類に結び付けてはいけない。
   * 最後の1発を撃った瞬間に「兵装を撃ち尽くした」判定で帰投指示へ切り替わり、
   * order.type が attack でなくなった途端に回避を始めて、
   * まさに今誘導している弾を自分で外してしまう。
   */
  _guidingSarh(world) {
    if (!world.missiles) return false;
    return world.missiles.some((m) => m.alive && !m.lost
      && m.launcher === this && m.guidance === 'sarh');
  }

  /**
   * デコイ投射（誘導方式に合わせてフレア／チャフを選ぶ）。
   *
   * **練度は「どれだけ早く撒くか」に効く**（§28.4.1）。
   * デコイは遠いほど効くので、警報を受けてすぐ撒くのが最良。
   * 引きつけてから撒くのはほとんど無駄になる。
   *
   * これ以前は逆で、着弾4.5秒前（約5km）に撒いていた。
   * 新しい効き方では**そこが最も効かない瞬間**になる。
   *
   * 練度が初めて「見て分かる軸」になる。発射間隔や照準精度に散らばっていた
   * ときは、プレイヤーから何が違うのか分からなかった。
   *
   * 回避機動から切り出してある。手動モードは機動しないがデコイは撒くため。
   *
   * @param {number} tti 着弾までの概算秒数
   */
  _maybeDeployDecoy(world, dt, m, tti) {
    this._decoyTimer -= dt;
    if (!this.autoDecoy || !world.combat) return;
    if (tti >= this._decoyStartTti() || this._decoyTimer > 0) return;
    const kind = m.guidance === 'ir' ? 'flare' : 'chaff';
    if (world.combat.deployDecoy(this, kind)) this._decoyTimer = DECOY_INTERVAL;
  }

  /**
   * その弾を「照らしている」もの（§28.5）。
   *
   * これに対して真横を向くのがノッチ。誘導方式で違う。
   *
   * | 兵装 | 照射源 |
   * |---|---|
   * | AAM-M（セミアクティブ）| 発射機 |
   * | AAM-A（中途）| 発射機の索敵レーダー |
   * | AAM-A（終末）| ミサイル自身 |
   * | AAM-S（赤外線）| 無し（ビームは効かない。フレアと機動と地形で対処） |
   */
  _illuminatorOf(m) {
    if (m.guidance === 'sarh') return m.launcher && m.launcher.alive ? m.launcher : null;
    if (m.guidance === 'arh' && m.active === false) {
      return m.launcher && m.launcher.alive ? m.launcher : null;
    }
    return null;                                  // 弾自身、または効かない
  }

  /** 撒き始める残り秒数。練度が高いほど早い（§28.4.1） */
  _decoyStartTti() {
    const k = clamp(this.skill ?? 1, 0, 1);
    return DECOY_TTI_LATE + (DECOY_TTI_EARLY - DECOY_TTI_LATE) * k;
  }

  _evade(world, dt) {
    const m = this.threats[0];
    if (!m || !m.alive) return null;

    // 誘導優先の設定なら、自分のミサイルを誘導している間は回避機動を取らない。
    // （デコイだけは撒く。撃ち勝つために被弾リスクを受け入れる選択）
    if (!this.evadeWhileGuiding && this._guidingSarh(world)) {
      const d = Math.hypot(m.pos.x - this.pos.x, m.pos.z - this.pos.z);
      this._maybeDeployDecoy(world, dt, m, d / Math.max(60, m.speed));
      return null;
    }

    const dx = m.pos.x - this.pos.x, dz = m.pos.z - this.pos.z;
    const dist = Math.hypot(dx, dz);
    const tti = dist / Math.max(60, m.speed);      // 到達までの概算秒数

    this._maybeDeployDecoy(world, dt, m, tti);

    // ビームは**照射しているもの**に対して取る（§28.5）。
    //
    // セミアクティブ（AAM-M）を照らしているのは発射機であって、飛んでくる弾ではない。
    // 弾に対して真横を向いても、発射機から見た速度成分は消えないので何も起きない。
    // 以前は誘導方式を問わず弾に対して取っていたので、
    // **AAM-M へのノッチが物理的に成立していなかった**。
    const src = this._illuminatorOf(m) || m;
    const bx = src.pos.x - this.pos.x, bz = src.pos.z - this.pos.z;
    const bearing = headingOf(bx, bz);

    // ミサイルを真横に置く向きのうち、旋回量が少ない方を選ぶ
    const left = bearing - Math.PI / 2;
    const right = bearing + Math.PI / 2;
    // 一度決めた回避方向は、その脅威が消えるまで保つ。
    // 毎フレーム選び直すと、ミサイルが真後ろ／真正面に来たときに
    // 左右がばたついて機動にならない（振動して見える）。
    if (this._evadeSide == null) {
      this._evadeSide = Math.abs(angleDiff(left, this.heading))
        < Math.abs(angleDiff(right, this.heading)) ? -1 : 1;
    }
    let heading = this._evadeSide < 0 ? left : right;
    this.beaming = true;

    // 終末は**ミサイルへ舵を切る**（§28.5）。
    //
    // 真横を向いたまま待つと、最後は必ず追いつかれる。突っ込む向きへ寄せると
    // ミサイルは短時間で大きな先行角を取らされ、曲がり切れなくなる。
    // しきい値で切り替えず、tti で連続的に寄せる — 段差にすると
    // ミサイルの機動で tti が前後するたびに機首が暴れる（§22 の教訓）。
    const missileBearing = headingOf(dx, dz);
    const breakMix = clamp((BREAK_TTI - tti) / BREAK_TTI, 0, 1);
    if (breakMix > 0) {
      heading += angleDiff(missileBearing, heading) * breakMix;
      this.beaming = breakMix < 0.5;
    }

    // 終末に近いほど深く降ろす。
    // 「tti<8 なら地面すれすれ、そうでなければ現在高度」のような段差にすると、
    // ミサイルの機動で tti がそのしきい値をまたぐたびに
    // 全力降下と維持が切り替わり、機首が上下に暴れる。
    // 終末に近いほど深く降ろす。
    // 浅い降下では振り切れない（実測で生存率がはっきり落ちた）。
    // 段差にしないことだけが要点で、深さそのものは元の設計どおり深く取る。
    const dive = clamp(1 - tti / 9, 0, 1);
    const alt = this.pos.y - dive * 4000;

    return { heading, alt, speed: this.spec.maxSpeed };
  }

  /**
   * これから通る経路の地形を先読みし、確保すべき最低高度を返す。
   *
   * 直線で数点だけ見ると、サンプルの隙間にある尾根を跨いでしまって山に突っ込む。
   * 旋回を織り込んだ予測経路に沿って一定距離ごと（LOOK_STEP）に見る。
   */
  _terrainFloor(world, desiredHeading = this.heading) {
    return this._terrainScan(world, desiredHeading).floor;
  }

  /**
   * 先読みの結果。floor は確保すべき高度、dist はその最高点までの距離。
   * dist が要る理由は「登り切れるか」を判断するため。
   */
  _terrainScan(world, desiredHeading = this.heading) {
    const terrain = world.terrain;

    // 先読みの距離は「登り切れるか」で決まる。
    //
    // 上昇率の低い機体（A-3 は 90m/s）が高い尾根に向かうとき、
    // 短い先読みだと尾根が見えた時点で必要な上昇量が上昇率を超えていて、
    // どれだけ機首を上げても間に合わず山肌に突っ込む（実際に起きた）。
    // 想定する最大の登り(RIDGE_CLIMB)を上昇率で割った時間ぶん先まで見る。
    const climbTime = RIDGE_CLIMB / Math.max(20, this.spec.climbRate);
    const lookAhead = clamp(this.speed * climbTime, 4000, 11000);

    const dtNear = LOOK_STEP / Math.max(50, this.speed);
    const turnNear = this.effectiveTurnRate * dtNear;

    let h = this.heading;
    let remaining = angleDiff(desiredHeading, this.heading);
    let x = this.pos.x, z = this.pos.z;
    let ground = terrain.heightAt(x, z);
    let travelled = 0;
    let peakAt = 0;

    // 近くは細かく、遠くは粗く見る。遠方は「そこに高い所があるか」だけ分かればよく、
    // 全区間を細かく見るとサンプル数が増えすぎる。
    while (travelled < lookAhead) {
      const step = travelled < LOOK_NEAR ? LOOK_STEP : LOOK_STEP * 3;
      const turnPerStep = turnNear * (step / LOOK_STEP);
      const turn = clamp(remaining, -turnPerStep, turnPerStep);
      h += turn;
      remaining -= turn;
      x += Math.sin(h) * step;
      z += -Math.cos(h) * step;
      travelled += step;
      const g = terrain.heightAt(x, z);
      if (g > ground) { ground = g; peakAt = travelled; }
    }
    return { floor: Math.max(ground, 0) + MIN_AGL, dist: peakAt };
  }

  /**
   * その針路の地形を、上昇率で登り切れるか。
   * 1 を超えると間に合わない（＝機首を上げても山肌に当たる）。
   */
  _climbDemand(scan) {
    const need = scan.floor - this.pos.y;
    if (need <= 0) return 0;
    const seconds = Math.max(1, scan.dist / Math.max(50, this.speed));
    return (need / seconds) / Math.max(20, this.spec.climbRate);
  }

  _advanceOrder() {
    if (this.queue.length > 0) {
      this.order = this.queue.shift();
    } else if (this.order.type === 'move') {
      // 到達したらその場で待機旋回に移る
      this.order = { type: 'orbit', x: this.order.x, z: this.order.z, alt: this.order.alt, radius: 2500 };
    }
  }

  _integrate(dt, world) {
    // --- 旋回 ---
    const maxTurn = this.effectiveTurnRate * dt;
    const diff = angleDiff(this._desiredHeading, this.heading);
    const turn = clamp(diff, -maxTurn, maxTurn);
    this.heading += turn;
    // 実際の旋回率(rad/s)。機銃の偏差の見積り（sim/combat.js）が使う。
    // バンク角から推し量ると、緩い定常旋回でバンクが寝ているときに
    // 「曲がっていない」と誤って読んでしまう。
    this.turnRate = dt > 0 ? turn / dt : 0;

    // バンク角（見た目）: 旋回の強さに比例
    const bankTarget = clamp(turn / Math.max(1e-6, maxTurn), -1, 1) * 1.05
                       * clamp(Math.abs(diff) / (12 * DEG), 0, 1);
    this.roll += (bankTarget - this.roll) * Math.min(1, dt * 3.5);

    // --- 上昇・降下 ---
    const altErr = this.desiredAlt - this.pos.y;
    const climbCap = this.spec.climbRate * clamp(this.speed / this.spec.cruiseSpeed, 0.35, 1.2);
    // 上昇は素早く（地形回避が間に合うように）、降下は緩やかに
    const vs = clamp(altErr > 0 ? altErr * 0.9 : altErr * 0.35, -climbCap * 1.4, climbCap);
    this.pos.y += vs * dt;
    this.pitch = Math.atan2(vs, Math.max(40, this.speed));

    // --- 速度（高度による推力低下とエネルギー交換） ---
    //
    // 高空では推力が落ちるため、失った速度を取り戻すのに時間がかかる。
    // 逆に降下すれば位置エネルギーを速度に変換でき、水平最大速度を
    // 数割超えて突っ込める（一撃離脱の根拠になる）。
    // ミリタリー推力と AB 推力を分ける（§29.3）。
    // spec.accel は AB 側の値。AB を焚いていなければ落として使う。
    const ab = this.afterburner;
    this.abActive = ab;
    const thrust = this.spec.accel * thrustFactor(this.pos.y)
      * (ab ? 1 : MIL_ACCEL_FRACTION);
    // 降下中は速度を捨てにくい（絞っても位置エネルギーが速度に変わり続ける）。
    // これが無いと降下しても巡航速度まで減速してしまい、一撃離脱が成立しない。
    const decelLimit = thrust * (vs < 0 ? 0.15 : 0.6);
    let accel = clamp((this.desiredSpeed - this.speed) * 0.6, -decelLimit, thrust);
    accel -= vs * 0.030;                       // 上昇=減速 / 降下=加速

    // 旋回による誘導抗力。曲がり続ける機体は速度を失い、追いつかれる。
    // 速度に比例させる（低速では減速も小さい。そうしないと低速機が止まってしまう）。
    const turnRatio = Math.abs(turn) / Math.max(1e-6, maxTurn);
    const speedFrac = clamp(this.speed / this.spec.cruiseSpeed, 0.25, 1.4);
    accel -= turnRatio * TURN_DRAG * speedFrac;

    const diveBonus = 1 + 0.35 * clamp(-vs / this.spec.climbRate, 0, 1);
    const speedCap = (ab ? this.altitudeMaxSpeed : this.milSpeed) * diveBonus;
    this.speed = clamp(this.speed + accel * dt, this.spec.minSpeed, speedCap);

    // --- 位置 ---
    const f = this.forward();
    this.pos.x += f.x * this.speed * dt;
    this.pos.z += f.z * this.speed * dt;

    // --- 地表衝突（回避に失敗した場合の最終判定） ---
    const ground = Math.max(0, world.terrain.heightAt(this.pos.x, this.pos.z));
    if (this.pos.y < ground + 20) {
      this.pos.y = ground + 20;
      this.deathCause = 'terrain';
      this.destroy();
    }

    if (this._checkWithdraw(world)) return;

    // マップ外へ出ないよう緩やかに引き戻す
    const M = world.mapSize;
    if (this.pos.x < 0 || this.pos.x > M || this.pos.z < 0 || this.pos.z > M) {
      const cx = clamp(this.pos.x, 0, M), cz = clamp(this.pos.z, 0, M);
      this._desiredHeading = headingOf(cx - this.pos.x || 1, cz - this.pos.z);
    }
  }

  /**
   * 戦域離脱。
   *
   * 帰投先の無い機体（マップ外を拠点とする敵編隊）が帰投判断をしたり燃料が尽きたりすると、
   * 行き先が無いままマップの縁で延々と飛び続ける。
   * この状態の敵が1機でも残ると destroyAll 系の目標が永久に達成できない。
   * そこで一番近い縁へ向かわせ、外に出たところで戦域から取り除く。
   * 判定上は撃墜ではなく「撃退」の扱いにする（handleDeaths が戦果に数えない）。
   *
   * @returns {boolean} 離脱行動を取ったか（true ならマップ外への引き戻しはしない）
   */
  _checkWithdraw(world) {
    if (!this.withdrawing) {
      const leaving = this.fuel <= 0 || this.aiMode === 'RTB'
        || (this.order && this.order.type === 'rtb');
      if (!leaving) return false;
      if (this.nearestBase(world)) return false;      // 帰れる飛行場があるなら離脱しない
      this.withdrawing = true;
      this._noHomeBase = true;
      // ここではログを出さない。離脱を「決めた」だけで、まだ戦域にいる。
      // 実際にマップ外へ出た時点で handleDeaths がログを出す。
    }

    // 一番近い縁の外側へ向かう
    const M = world.mapSize;
    let tx = this.pos.x;
    let tz = this.pos.z;
    if (Math.min(this.pos.x, M - this.pos.x) < Math.min(this.pos.z, M - this.pos.z)) {
      tx = this.pos.x < M / 2 ? -9000 : M + 9000;
    } else {
      tz = this.pos.z < M / 2 ? -9000 : M + 9000;
    }
    this._desiredHeading = headingOf(tx - this.pos.x || 1, tz - this.pos.z);

    const OUT = 3000;
    if (this.pos.x < -OUT || this.pos.x > M + OUT
        || this.pos.z < -OUT || this.pos.z > M + OUT) {
      this.deathCause = 'withdraw';
      this.destroy();
    }
    return true;
  }

  _consumeFuel(dt, world) {
    let rate = 1;
    // アフターバーナー（§29.3）。以前は速度で推し量っていたが、
    // 焚いているかどうかそのもので決める。降下で速度が乗っただけの機体が
    // 燃料を3倍で消していた。
    if (this.abActive) rate *= 3;
    if (this.pos.y > 6000) rate *= 0.7;
    else if (this.pos.y < 1000) rate *= 1.4;
    rate *= 1 + 0.3 * (loadoutSlots(this.loadout) / Math.max(1, this.spec.hardpoints));

    this.fuel -= rate * dt;
    if (this.fuel <= 0) {
      this.fuel = 0;
      // 帰る場所が無い機体（マップ外を拠点とする敵編隊など）は燃料切れで落とさない。
      // 帰投先が無いのに勝手に落ちると、戦果が転がり込むだけで面白くない。
      //
      // 判定はフラグではなく、その場で確かめる。帰投を始めたあとに飛行場を壊されると
      // 「帰る場所がある前提」のフラグが古いまま残り、落ちなくてよい機体が落ちる。
      const homeless = world ? !this.nearestBase(world) : this._noHomeBase;
      if (homeless) { this._noHomeBase = true; return; }
      this.deathCause = 'fuel';
      this.destroy();
    }
  }

  /** 燃料残量の割合 0..1 */
  get fuelRatio() { return this.fuel / this.fuelMax; }

  /**
   * 搭載が変わったら燃料容量を計算し直す。
   *
   * 生成時にしか計算していなかったため、**整備で増槽を積んでも
   * 燃料が増えなかった**。ブリーフィングで積んだぶんだけが効いていた。
   * 降ろしたときは、増えていた燃料も上限まで切り詰める。
   */
  refreshFuelCapacity() {
    this.fuelMax = this.spec.fuelSeconds * loadoutFuelBonus(this.loadout);
    // 容量を増やすだけ。実際の給油は整備の「燃料補給」が行う
    this.fuel = Math.min(this.fuel, this.fuelMax);
  }
  /** HP割合 0..1 */
  get hpRatio() { return this.hp / this.maxHp; }
}
