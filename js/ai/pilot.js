// ユニットのAIモード。仕様書 §9。
//
// 設計の要点:
//   AIは「飛び方」を直接いじらず、**指示(order)を出す**ことで振る舞いを変える。
//   飛行モデル・回避・地形回避は sim/aircraft.js が一貫して面倒を見るので、
//   ここは「今なにを狙うか／どこへ行くか」だけを決める。
//
//   これにより、プレイヤーが手で出した指示とAIが出した指示が同じ仕組みに乗り、
//   「AIに任せる／手で介入する」の切り替えが自然になる。

import { headingOf, angleDiff, DEG } from '../sim/unit.js';
import { LEVEL } from '../sim/detection.js';

/** AIの思考間隔(秒)。毎フレーム考える必要はない。 */
const AI_INTERVAL = 0.5;

export const AI_MODES = {
  PATROL:     { id: 'PATROL',     label: '哨戒',     desc: '指定エリアを旋回しつつ索敵。近づいた敵だけ迎撃する' },
  PURSUIT:    { id: 'PURSUIT',    label: '追撃',     desc: '探知した敵へ積極的に向かい交戦する' },
  EVADE:      { id: 'EVADE',      label: '回避優先', desc: '交戦を避け、低空へ退避する' },
  COORDINATE: { id: 'COORDINATE', label: '連携',     desc: '編隊でレーダーの扇を分担し、目標を重複させない' },
  ESCORT:     { id: 'ESCORT',     label: '護衛',     desc: '護衛対象の周囲を確保し、近づく敵を排除する' },
  STRIKE:     { id: 'STRIKE',     label: '対地攻撃', desc: '地上目標へ進撃。SAM圏内では低空へ降りる' },
  RTB:        { id: 'RTB',        label: '帰投',     desc: '最寄りの自軍飛行場へ戻る' },
  TRANSIT:    { id: 'TRANSIT',    label: '経路飛行', desc: '与えられた経路を飛ぶだけ。交戦も退避もしない（輸送機など）' },
  MANUAL:     { id: 'MANUAL',     label: '手動',     desc: '自分では何もしない。目標選択・ミサイル回避・燃料切れの帰投もしない。兵装とデコイは自動使用の設定に従う' },
};

/** モードごとの交戦距離(m) */
const ENGAGE_RANGE = {
  PATROL: 14000,
  PURSUIT: 30000,
  COORDINATE: 30000,
  // 護衛は「被護衛機に脅威が届く前に叩く」のが仕事。
  // 敵機は 14km 前後から中射程AAMを撃ってくるので、そこで初めて動き出すと
  // 必ず撃たれたあとになる。自機のミサイル射程(20km)より外で迎えに行く。
  ESCORT: 26000,
};

/** 哨戒中のレーダー掃引（機首を左右に振って扇の死角を減らす） */
const SWEEP_PERIOD = 26;
const SWEEP_AMPLITUDE = 42 * DEG;

/** 同じ目標に群がらないための上限 */
const MAX_ATTACKERS_PER_TARGET = 2;

/**
 * 目標の乗り換え抑制。
 * 敵が固まっていると距離の僅差で最適目標が入れ替わり、
 * AIが毎tick目標を変えて機首を振り回してしまう。
 */
const TARGET_STICKINESS = 9000;   // 現在の目標に与える下駄(m相当)
const RETARGET_COOLDOWN = 5;      // 乗り換えを許す最短間隔(秒)

/** SAM圏を警戒して低空へ降りる距離(m) */
const SAM_AVOID_RANGE = 26000;

/**
 * 対空砲（弾幕）の圏に入る前に上を取るための余裕(m)。
 *
 * 弾幕は**避けられない**。実測（§51・検証用ステージ d1）:
 * 圏内に入れば F-1 は 11.5〜13.9 秒で全損し、射高を 1m 超えていれば完全に無傷。
 * 距離も高度も二値なので、「どれだけ食らうか」ではなく
 * **入るか入らないか**しか判断の余地が無い。
 */
const GUN_CLEAR_MARGIN = 300;      // 射高にこれだけ足した高さを保つ
const GUN_APPROACH_PAD = 1800;     // 射程にこれだけ足した距離から上がり始める

/** ARM を撃つときに取る高度(m)。高いほど射程が伸びる。 */
const ARM_STANDOFF_ALT = 8500;

export class PilotAI {
  constructor(world) {
    this.world = world;
    this._accum = 0;
    this.time = 0;
  }

  update(dt) {
    this.time += dt;
    this._accum += dt;
    if (this._accum < AI_INTERVAL) return;
    this._accum = 0;

    const attackers = this._countAttackers();
    for (const u of this.world.units) {
      if (u.kind !== 'aircraft' || !u.alive || u.onGround) continue;
      if (u.state === 'landing') continue;
      // 練度が低いほど判断が遅い（状況の変化に気づくのが遅れる）
      const interval = AI_INTERVAL / (0.6 + 0.4 * (u.skill ?? 1));
      if (u._nextThink != null && this.time < u._nextThink) continue;
      u._nextThink = this.time + interval;
      this._think(u, attackers);
    }
  }

  /** 目標ごとの攻撃機数（重複攻撃を避けるため） */
  _countAttackers() {
    const map = new Map();
    for (const u of this.world.units) {
      if (u.kind !== 'aircraft' || !u.alive) continue;
      const o = u.order;
      if (o && o.type === 'attack' && o.target) {
        map.set(o.target.id, (map.get(o.target.id) || 0) + 1);
      }
    }
    return map;
  }

  _think(u, attackers) {
    // 手動: 何もしない。目標も選ばず、帰投もせず、指示だけで動く。
    // 一番上に置く。弾切れの申告すら出さない（指示を上書きしないため）。
    if (u.aiMode === 'MANUAL') { u.headingBias = 0; return; }

    // ミサイル回避中は割り込まない（機体側が回避機動を優先している）
    if (u.threats.length > 0) return;

    // 弾切れの申告（燃料監視は機体側が持っている）
    this._checkWinchester(u);

    // プレイヤーが直接出した指示は守る。
    // 割り込むのはミサイル回避（機体側）と燃料切れの帰投だけ。
    //
    // **弾幕の上を取るのはここでも掛ける**（§51）。
    // 「あの目標を攻撃しろ」という指示は「600mで砲の上を通れ」という意味ではない。
    // 実測では、プレイヤーが対地目標に攻撃を指示しただけで
    // 12秒後に確実に落ちていた（`_playerLocked` が先に return するため、
    // モードごとの判断が一度も走らない）。
    if (this._playerLocked(u)) { u.headingBias = 0; this._clearGuns(u); return; }

    const mode = u.aiMode || 'PATROL';
    switch (mode) {
      case 'PURSUIT':    this._pursuit(u, attackers, ENGAGE_RANGE.PURSUIT); break;
      case 'COORDINATE': this._coordinate(u, attackers, true); break;
      case 'EVADE':      this._evadeMode(u); break;
      case 'ESCORT':     this._escort(u, attackers); break;
      case 'STRIKE':     this._strike(u, attackers); break;
      case 'RTB':        this._rtb(u); break;
      // 経路飛行: 指示に一切割り込まない。ミサイル回避だけは機体側が行う。
      // （手動 MANUAL はその回避もしない。上で先に返している）
      case 'TRANSIT':    u.headingBias = 0; break;
      case 'PATROL':
      default:           this._patrol(u, attackers); break;
    }

    // **最後に置く。** SAM を避けるための降下（`_strike`）より後でないと、
    // せっかく上げた高度をそのまま 600m へ戻されてしまう。
    this._clearGuns(u);
  }

  // -------------------------------------------------------------- 各モード

  _patrol(u, attackers) {
    const area = this._patrolArea(u);

    // 近づいてきた敵だけ迎撃する
    const target = this._pickAirTarget(u, ENGAGE_RANGE.PATROL, attackers);
    if (target) { this._attack(u, target, attackers); return; }

    // 交戦していなければ哨戒に戻り、機首を左右に振って索敵する
    if (this._isIdleOrStaleAttack(u)) {
      u.setOrder({ type: 'orbit', x: area.x, z: area.z, alt: area.alt, radius: area.radius });
    }
    u.headingBias = Math.sin((this.time / SWEEP_PERIOD) * Math.PI * 2 + u.id) * SWEEP_AMPLITUDE;
  }

  _pursuit(u, attackers, range) {
    const target = this._pickAirTarget(u, range, attackers);
    if (target) { this._attack(u, target, attackers); u.headingBias = 0; return true; }
    if (this._isIdleOrStaleAttack(u)) {
      const area = this._patrolArea(u);
      u.setOrder({ type: 'orbit', x: area.x, z: area.z, alt: area.alt, radius: area.radius });
    }
    u.headingBias = Math.sin((this.time / SWEEP_PERIOD) * Math.PI * 2 + u.id) * SWEEP_AMPLITUDE;
    return false;
  }

  /**
   * 連携。編隊内でレーダーの扇を分担し、同じ目標を重複して狙わない。
   * 扇の分担は「機首の向きを役割ごとにずらす」ことで実現している。
   */
  _coordinate(u, attackers) {
    const engaged = this._pursuit(u, attackers, ENGAGE_RANGE.COORDINATE);
    if (engaged) return;
    // 役割ごとに固定の角度をずらして、編隊全体で広い扇を張る
    const slot = u.formationSlot ?? 0;
    const base = [0, 1, -1, 2][slot % 4] * 32 * DEG;
    u.headingBias = base
      + Math.sin((this.time / SWEEP_PERIOD) * Math.PI * 2 + slot * 1.7) * (18 * DEG);
  }

  _evadeMode(u) {
    u.headingBias = 0;
    const enemy = this._nearestKnownEnemy(u, 26000);
    if (!enemy) {
      if (this._isIdleOrStaleAttack(u)) {
        const area = this._patrolArea(u);
        u.setOrder({ type: 'orbit', x: area.x, z: area.z, alt: area.alt, radius: area.radius });
      }
      return;
    }
    // **自陣側へ後退する**（§28.9）。敵から離れる方向ではない。
    //
    // 「敵から離れる」だけだと帰る場所の概念が無いので、
    // 早期警戒機はマップの端まで逃げて、そこに張り付いて攻撃できなくなる。
    // **地図を広げても直らない**（より遠くまで逃げるだけ）。
    //
    // 退避先は自軍飛行場、無ければ哨戒エリア。そのどちらも無い機体
    // （マップ外を拠点とする編隊）だけは、従来どおり敵から離れる方向へ。
    const home = u.nearestBase(this.world) || this._patrolArea(u);
    let tx; let tz;
    if (home) {
      tx = home.pos ? home.pos.x : home.x;
      tz = home.pos ? home.pos.z : home.z;
    } else {
      const away = headingOf(u.pos.x - enemy.pos.x, u.pos.z - enemy.pos.z);
      tx = u.pos.x + Math.sin(away) * 22000;
      tz = u.pos.z - Math.cos(away) * 22000;
    }
    u.setOrder({
      type: 'move',
      x: tx,
      z: tz,
      alt: Math.max(0, this.world.terrain.heightAt(u.pos.x, u.pos.z)) + 700,
      speed: u.altitudeMaxSpeed * 0.95,
    });
  }

  /**
   * 護衛。
   *
   * **守る相手は「随伴している相手」から拾う**（§60.3）。
   * `escortTarget` を書いていたのは司令官AI（`ai/commander.js`）だけで、
   * プレイヤーには書く手段が無かった。つまり
   * **パネルの「護衛」ボタンは押しても必ず哨戒に落ちていた** ——
   * 押せるのに一度も働かないボタンが1つ並んでいたことになる。
   */
  _escort(u, attackers) {
    let ward = u.escortTarget;
    if ((!ward || !ward.alive)
      && u.order && u.order.type === 'follow' && u.order.target && u.order.target.alive) {
      ward = u.escortTarget = u.order.target;
    }
    if (!ward || !ward.alive) {
      u.aiMode = 'PATROL';
      // 一度だけ知らせる。押しても何も起きない、という状態にはしない
      if (!u._escortWarned && u.side === this.world.playerSide) {
        u._escortWarned = true;
        this.world.log?.(`${u.name} 護衛する相手がいません — 哨戒に戻ります`);
      }
      return;
    }
    u._escortWarned = false;

    // 護衛対象に近づく敵を排除する
    const threat = this._pickAirTarget(u, ENGAGE_RANGE.ESCORT, attackers, ward);
    if (threat) { this._attack(u, threat, attackers); return; }

    const dist = u.distanceTo(ward);
    if (u.order.type !== 'follow' || u.order.target !== ward || dist > 6000) {
      u.setOrder({ type: 'follow', target: ward, slot: (u.formationSlot ?? 0) + 1 });
    }
    u.headingBias = Math.sin((this.time / SWEEP_PERIOD) * Math.PI * 2 + u.id) * (30 * DEG);
  }

  _strike(u, attackers) {
    u.headingBias = 0;

    // 目標が無ければ、探知している地上目標から選び直す。
    //
    // ここで帰投にしてはいけない。ステージ側で目標を仕込まれた機体しか
    // strikeTarget を持たないので、プレイヤーが対地攻撃モードにしただけで
    // 勝手に帰ってしまう（実際そうなっていた）。
    // 兵装を撃ち尽くしたときの帰投は _checkWinchester が別に見ている。
    let target = u.strikeTarget;
    if (!target || !target.alive) target = this._nearestGroundTarget(u);
    if (!target) {
      u.strikeTarget = null;
      this._patrol(u, attackers);       // 目標が見つかるまでは哨戒
      return;
    }
    u.strikeTarget = target;
    if (u.order.type !== 'attack' || u.order.target !== target) {
      u.setOrder({ type: 'attack', target });
    }
    // SAM圏に入ったら低空へ降りて探知を切る。
    //
    // ただし対レーダーミサイル(ARM)を積んでいる機体は例外。
    // ARM は最低発射高度(2500m)があり、高度が上がるほど射程が伸びて
    // SAM の交戦距離を上回る（高度9000mで28.5km 対 SAM 20.9km）。
    // 一律に降ろすと ARM を一度も撃てないまま SAM 圏へ突っ込むことになり、
    // SEAD 機の持ち味を自分で潰してしまう。
    const sam = this._nearestThreatSite(u, SAM_AVOID_RANGE);
    if (sam && u.order.type === 'attack') {
      if (this._canUseArm(u, target)) {
        u.order.alt = Math.max(u.order.alt || 0, ARM_STANDOFF_ALT);
      } else {
        u.order.alt = Math.max(0, this.world.terrain.heightAt(u.pos.x, u.pos.z)) + 600;
      }
    }
  }

  /**
   * 探知している対空砲（対空砲・飛行場・艦船の近接防空）の圏に入りそうなら、
   * その射高より上へ指示高度を上げる。
   *
   * **SAM とは逆向きの手当て。** SAM はレーダーで捉えるので低く降りれば隠れるが、
   * 弾幕は**降りるほど当たる**。同じ「地上の脅威」でも取るべき高度が逆になる。
   *
   * 圏に入る前に上げ切りたいので、射程に余裕を足した距離で判断する。
   * 上げるのは弾幕を避けるためだけなので、**必要な高さより上げない** —
   * 高く飛べばそのぶん地上レーダーに映る（§30.2 の低空減衰）。
   *
   * 見えていない砲は避けられない。対空砲はレーダーを持たないので目視でしか
   * 見つからず（§8）、**知らずに踏むことがある**。それはそういう設計で、
   * ここで全部避けられるようにはしない。
   */
  _clearGuns(u) {
    const prev = u._gunFloor || 0;
    u._gunFloor = 0;
    if (!u.order || u.order.type === 'rtb') return;

    // **プレイヤーが高度を指定していたら従う。**
    // 低く入るのが分かっていて選んだ場合まで上げ直すと、指揮が効かなくなる。
    if (u.commandedAlt != null) {
      if (prev > 0 && u.order.alt === prev) u.order.alt = null;
      return;
    }

    const contacts = this.world.detection.contactsFor(u.side);
    let floor = 0;
    for (const [, c] of contacts) {
      const g = c.unit;
      if (!g.alive || g.side === u.side) continue;
      const w = g.spec && g.spec.weapon;
      if (!w || w.kind !== 'aaa') continue;
      const flat = Math.hypot(u.pos.x - c.pos.x, u.pos.z - c.pos.z);
      if (flat > w.range + GUN_APPROACH_PAD) continue;
      const need = Math.max(0, this.world.terrain.heightAt(c.pos.x, c.pos.z))
        + w.maxAlt + GUN_CLEAR_MARGIN;
      if (need > floor) floor = need;
    }

    u._gunFloor = floor;
    if (floor > 0) {
      u.order.alt = Math.max(u.order.alt || 0, floor);
    } else if (prev > 0 && u.order.alt === prev) {
      // **自分が上げたぶんだけ戻す。** 圏を出たあとも高いままだと、
      // 地上レーダーに映り続けて低空侵入の意味が消える（§30.2）。
      u.order.alt = null;
    }
  }

  /** 探知している敵の地上・水上目標のうち最も近いもの */
  _nearestGroundTarget(u) {
    const contacts = this.world.detection.contactsFor(u.side);
    let best = null;
    let bestD = Infinity;
    for (const c of contacts.values()) {
      const t = c.unit;
      if (!t.alive || t.kind === 'aircraft' || t.side === u.side) continue;
      const d = u.pos.distanceTo(t.pos);
      if (d < bestD) { bestD = d; best = t; }
    }
    return best;
  }

  /** ARM を積んでいて、目標が電波を出しているか（＝撃てるか） */
  _canUseArm(u, target) {
    if (!target || !u.loadout.includes('ARM')) return false;
    return !!(target.emitting || (target.spec && target.spec.radar && target.spec.radar.emits));
  }

  _rtb(u) {
    u.headingBias = 0;
    if (u.order.type === 'rtb') return;
    const ab = u.nearestBase(this.world);
    if (ab) u.setOrder({ type: 'rtb', airbase: ab });
  }

  // -------------------------------------------------------------- 補助

  /**
   * 攻撃指示を出し、この tick 内の攻撃機数にも反映する。
   * 反映しないと、同じtickで判断する僚機が全員「まだ誰も向かっていない」と
   * 見なして同一目標に殺到する。
   */
  _attack(u, target, attackers) {
    const prev = u.order.type === 'attack' ? u.order.target : null;
    if (prev === target) return;
    if (prev && attackers) attackers.set(prev.id, Math.max(0, (attackers.get(prev.id) || 1) - 1));
    if (attackers) attackers.set(target.id, (attackers.get(target.id) || 0) + 1);
    u.setOrder({ type: 'attack', target });
  }

  /** プレイヤーの直接指示が有効なあいだか */
  _playerLocked(u) {
    const o = u.order;
    if (!o || !o.player) return false;
    if (o.type === 'attack') return !!(o.target && o.target.alive);
    // **護衛モードのときの随伴指示は「誰を護るか」の指定**であって、
    // 「そこに張り付いていろ」ではない（§60.3）。
    // ここで止めてしまうと `_escort` が一度も走らず、
    // **パネルの「護衛」ボタンは押しても何も起きないまま**になる。
    if (o.type === 'follow' && u.aiMode === 'ESCORT') return false;
    return o.type === 'move' || o.type === 'follow' || o.type === 'rtb';
  }

  /** 指示が空いている（待機旋回中／目標を失った攻撃指示）か */
  _isIdleOrStaleAttack(u) {
    const o = u.order;
    if (!o) return true;
    if (o.type === 'orbit') return true;
    if (o.type === 'attack' && (!o.target || !o.target.alive)) return true;
    return false;
  }

  /** 哨戒エリア。指定が無ければ現在地を使う。 */
  _patrolArea(u) {
    if (!u.patrolArea) {
      u.patrolArea = {
        x: u.pos.x, z: u.pos.z,
        alt: u.pos.y,
        radius: 4500,
      };
    }
    return u.patrolArea;
  }

  /**
   * 交戦する空中目標を選ぶ。
   * @param {Aircraft} u
   * @param {number} range 交戦距離
   * @param {Map} attackers 目標ごとの攻撃機数
   * @param {Unit} [near] 指定するとこのユニットの近くにいる敵を優先する（護衛用）
   */
  _pickAirTarget(u, range, attackers, near = null) {
    if (!u.loadout.some((id) => id.startsWith('AAM')) && u.gun <= 0) return null;

    const current = u.order.type === 'attack' ? u.order.target : null;
    const currentValid = current && current.alive && current.kind === 'aircraft' && !current.onGround
      && (near || u).pos.distanceTo(current.pos) <= range;

    // 乗り換えたばかりなら、目標が有効なうちは変えない
    if (currentValid && this.time - (u._lastRetarget || -99) < RETARGET_COOLDOWN) return current;

    const contacts = this.world.detection.contactsFor(u.side);
    let best = null, bestScore = Infinity;
    for (const [, c] of contacts) {
      if (!c.detected || c.level < LEVEL.IDENTIFIED) continue;
      const t = c.unit;
      if (!t.alive || t.kind !== 'aircraft' || t.onGround) continue;

      const from = near || u;
      const d = from.pos.distanceTo(t.pos);
      if (d > range) continue;

      // 既に十分な数が向かっている目標は避ける
      const n = attackers.get(t.id) || 0;
      const already = t === current;
      if (!already && n >= MAX_ATTACKERS_PER_TARGET) continue;

      // 近い目標を優先し、群がっている目標にはペナルティ。
      // 今狙っている目標には下駄を履かせて、僅差での乗り換えを防ぐ。
      const score = d + n * 8000 - (already ? TARGET_STICKINESS : 0);
      if (score < bestScore) { bestScore = score; best = t; }
    }
    if (best && best !== current) u._lastRetarget = this.time;
    return best;
  }

  /** 探知済みの最寄りの敵（種別問わず） */
  _nearestKnownEnemy(u, range) {
    const contacts = this.world.detection.contactsFor(u.side);
    let best = null, bestD = range;
    for (const [, c] of contacts) {
      if (!c.detected) continue;
      const d = u.pos.distanceTo(c.unit.pos);
      if (d < bestD) { bestD = d; best = c.unit; }
    }
    return best;
  }

  /** 探知済み（記憶を含む）の最寄りのSAM陣地 */
  _nearestThreatSite(u, range) {
    const contacts = this.world.detection.contactsFor(u.side);
    let best = null, bestD = range;
    for (const [, c] of contacts) {
      if (c.unit.kind !== 'sam' || !c.unit.alive) continue;
      const d = u.pos.distanceTo(c.pos);
      if (d < bestD) { bestD = d; best = c.unit; }
    }
    return best;
  }

  /** 有効な兵装を失ったら帰投する */
  _checkWinchester(u) {
    if (u.aiMode === 'RTB' || u.order.type === 'rtb') return;
    if (u._winchester) return;
    if (u.spec.hardpoints === 0) return;     // 非武装の支援機（早期警戒機）は対象外
    // 最後の1発がまだ飛んでいる間は帰投へ切り替えない。
    // ここで指示を差し替えると、機首が目標から外れて自分の弾の誘導を切ってしまう。
    if (u._guidingSarh(this.world)) return;
    const hasAam = u.loadout.some((id) => id.startsWith('AAM'));
    const hasAg = u.loadout.some((id) => ['AGM', 'ARM', 'BOMB'].includes(id));
    if (hasAam || hasAg) return;
    if (u.gun > 40) return;                 // 機銃が残っていればまだ戦える
    u._winchester = true;
    u.aiMode = 'RTB';
    this.world.log?.(`${u.name} 兵装を撃ち尽くしました — 帰投`);
  }
}
