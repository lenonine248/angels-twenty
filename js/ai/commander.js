// 司令官AI。仕様書 §27。
//
// **1機では決められないことだけを決める層。**
//
//   司令官 (ここ)        誰にどの任務を与えるか・誰が誰を護るか・どこで待つか
//   ai/pilot.js          その任務の中で、どの敵を撃つか
//   sim/acm.js           どう飛ぶか
//   sim/aircraft.js      飛ぶ
//
// **「どの敵機を撃つか」はここでは決めない。** それは pilot.js が探知を通して
// 決めており、目標の重複回避も乗り換えの粘りもすでに持っている。
// ここで攻撃指示を直接出すと、その仕組みを丸ごと迂回することになる。
// 実際 `tools/bench.js` の旧・代理プレイヤーがそれをやっていて、
// 「守る対象に近い順」で**全機に同じ目標を割り当てて**いた（Beta 2.13 で判明）。
//
// **world.units を直接読まない。** 見えているものは
// `detection.contactsFor(side)` からしか取らない。ここを破ると、
// 情報量を変える変更（電波管制・逆探知）の効きが測れなくなる。
// 旧・代理プレイヤーはここも破っていた。
//
// 両陣営に付けられる。青に付ければベンチの測定器、赤に付ければ敵が
// 陣営として動く（§27.5）。プレイヤーには付けない。

import { LEVEL } from '../sim/detection.js';

/** 考える間隔(秒)。パイロットより遅くてよい */
const THINK_INTERVAL = 2;

/** 対地兵装 */
const AG_WEAPONS = ['AGM', 'ARM', 'BOMB'];

/** 哨戒エリアの半径(m) */
const PATROL_RADIUS = 4500;

/**
 * 護衛する相手が居ないときに置く哨戒エリアの位置。
 * 本拠と目標を結ぶ線の、この割合だけ前（§59.4）。
 */
const FORWARD_FRAC = 0.5;

/**
 * 哨戒エリアを、探知している SAM にこれ以上は寄せない(m)。
 *
 * SAM の交戦距離は相手の高度で伸びる（20km 前後）。
 * 哨戒は交戦ではないので、撃たれる位置で旋回させる意味が無い。
 * COORDINATE には対地脅威の手当てが無い（`ai/pilot.js` の降下は STRIKE だけ）。
 */
const SAM_KEEPOUT = 22000;

/** 哨戒エリアを置き直す最小の移動量(m)。これ未満なら動かさない */
const PATROL_HYSTERESIS = 3000;

export class Commander {
  /**
   * @param {object} world
   * @param {string} side  'blue' | 'red'
   * @param {object} mission 目標の一覧を持つもの（sim/mission.js）
   */
  constructor(world, side, mission) {
    this.world = world;
    this.side = side;
    this.mission = mission;
    this.time = 0;
    this._next = 0;
  }

  update(dt) {
    this.time += dt;
    if (this.time < this._next) return;
    this._next = this.time + THINK_INTERVAL;

    this._launch();
    this._assign();
  }

  // ------------------------------------------------------------ 発進

  /**
   * 地上で待機している機体を出す。
   *
   * 撃つものが無い機体は出さない。出すと、空の機体が戦域に居座って
   * 落とされるだけになる（難易度の目安として読めなくなる）。
   */
  _launch() {
    for (const u of this._myAircraft()) {
      if (u.state !== 'ready' || !u.airbase || !u.airbase.alive) continue;
      if (u.spec.hardpoints > 0 && !this._armed(u)) continue;
      u.airbase.launch(u, this.world);
    }
  }

  // ------------------------------------------------------------ 任務

  /**
   * 任務を割り当てる。
   *
   * 決めるのは**モードと、対地の目標**まで。空中目標は pilot.js に任せる。
   */
  _assign() {
    const ward = this._ward();
    const ground = this._groundTargets();
    const wards = this._strikeWards();

    for (const u of this._myAircraft()) {
      if (!u.alive || u.onGround || u.state === 'takeoff' || u.state === 'landing') continue;
      // 手動・帰投・経路飛行には触らない。人が選んだ状態と、
      // 弾切れ／燃料で機体側が決めた帰投を上書きしない。
      if (u.aiMode === 'MANUAL' || u.aiMode === 'RTB' || u.aiMode === 'TRANSIT') continue;
      if (u.order && u.order.player) continue;          // プレイヤーの直接指示が優先
      if (u.spec.hardpoints === 0) continue;            // 非武装の支援機は経路のまま

      // 1. 対地兵装を持たない機体は護衛に付く。
      //    攻撃目標より先に見る（護衛ステージには destroyAll 目標が無い）。
      //
      //    守る相手は2種類ある。**protect 目標の機体が最優先**で、
      //    それが無ければ**進出する味方の攻撃機**に付く（§59.4）。
      //    後者を入れるまで、後半4面の空戦機は一度も護衛にならなかった ——
      //    protect 目標が自軍飛行場（＝機体ではない）なので 1 が成立せず、
      //    全機が 3 に落ちて発進地点で旋回していた（§59.2）。
      if (!this._hasAg(u)) {
        const w = (ward && ward !== u) ? ward : this._pickWard(u, wards);
        if (w) {
          this._setMode(u, 'ESCORT');
          u.escortTarget = w;
          continue;
        }
      }

      // 2. 対地兵装を持っていて、狙える地上目標が見えているなら対地攻撃。
      if (this._hasAg(u)) {
        const t = this._pickGround(u, ground);
        if (t) {
          this._setMode(u, 'STRIKE');
          u.strikeTarget = t;
          u.escortTarget = null;
          continue;
        }
      }

      // 3. それ以外は連携（編隊で扇を分担し、目標の重複を避ける）。
      //    どの敵機を撃つかは pilot.js が探知から決める。
      this._setMode(u, 'COORDINATE');
      this._placePatrol(u);
      u.strikeTarget = null;
      u.escortTarget = null;
    }
  }

  /**
   * モードを変える。**同じなら触らない。**
   * 毎回入れ直すと、pilot.js 側の哨戒エリアや乗り換えの粘りが
   * そのたびに組み直されて、判断が落ち着かない。
   */
  _setMode(u, mode) {
    if (u.aiMode === mode) return;
    u.aiMode = mode;
    if (mode === 'COORDINATE') this._placePatrol(u);
  }

  /**
   * 護衛に付く値打ちのある味方機 —— **対地兵装を持って進出する機体**。
   *
   * 地上に居るあいだと帰投中は外す。駐機中の機体に編隊を組ませても仕方がないし、
   * 帰る機体に付いていくと護衛まで一緒に戦域を離れる。
   */
  _strikeWards() {
    const out = [];
    for (const u of this._myAircraft()) {
      if (!u.alive || u.onGround) continue;
      if (u.state === 'takeoff' || u.state === 'landing') continue;
      if (u.aiMode === 'RTB' || u.aiMode === 'MANUAL') continue;
      if (!this._hasAg(u)) continue;
      out.push(u);
    }
    return out;
  }

  /**
   * 護衛に付く相手を選ぶ。
   *
   * **護衛の付いていない機体から埋める。** 近い順だけで選ぶと、
   * 護衛が全員おなじ1機に群がる（`_pickGround` と同じ事故）。
   */
  _pickWard(u, wards) {
    if (!wards.length) return null;
    // いま付いている相手がまだ対象なら変えない。乗り換えるたびに編隊が組み直しになる
    if (u.escortTarget && wards.includes(u.escortTarget)) return u.escortTarget;

    const assigned = new Map();
    for (const o of this._myAircraft()) {
      if (o === u || !o.alive || o.aiMode !== 'ESCORT' || !o.escortTarget) continue;
      assigned.set(o.escortTarget, (assigned.get(o.escortTarget) || 0) + 1);
    }

    let best = null;
    let bestScore = Infinity;
    for (const w of wards) {
      if (w === u) continue;
      const score = (assigned.get(w) || 0) * 1e6 + u.pos.distanceTo(w.pos);
      if (score < bestScore) { bestScore = score; best = w; }
    }
    return best;
  }

  // ------------------------------------------------------------ 哨戒エリア

  /**
   * 護衛する相手が居ない機体の哨戒エリアを置く。**目標側へ寄せる。**
   *
   * 従来は「COORDINATE に落ちた時点の現在地」だった。最初の割り当ては
   * 発進直後なので、**飛行場の真上に固定される。**
   * COORDINATE の交戦距離(30km)は自機からの距離で測るので、
   * そこに居るかぎり遠くの敵は永久に見えない（§59.2）。
   *
   * **人が置いたエリアは動かさない。** プレイヤーが指定した哨戒地点や、
   * ステージ定義が敵の CAP に与えた配置を上書きすると指揮が効かなくなる。
   */
  _placePatrol(u) {
    const a = u.patrolArea;
    if (a && !a.byCommander) return;

    const front = this._frontPoint();

    // 進出先が分からない（空戦だけの面・まだ何も見えていない）。
    // **すでに置いてあるものは動かさない。** 現在地で置き直すと、
    // 哨戒エリアが機体にくっついて流れていき、哨戒が哨戒でなくなる。
    if (!front) {
      if (a) return;
      u.patrolArea = { x: u.pos.x, z: u.pos.z, alt: u.desiredAlt,
        radius: PATROL_RADIUS, byCommander: true };
      return;
    }

    const home = u.airbase && u.airbase.alive ? u.airbase.pos : u.pos;
    const t = this._forwardFraction(home, front);
    const x = home.x + (front.x - home.x) * t;
    const z = home.z + (front.z - home.z) * t;

    if (a && Math.hypot(a.x - x, a.z - z) < PATROL_HYSTERESIS) return;
    u.patrolArea = { x, z, alt: u.desiredAlt, radius: PATROL_RADIUS, byCommander: true };
  }

  /**
   * 進出先。**未達の destroyAll 目標のうち、いま分かっている位置の重心。**
   *
   * 地上目標が無いステージ（空戦だけの面）では null を返す ——
   * 「どこへ攻めるか」が与えられていないのに前に出しても、出る先が無い。
   * おかげでこの変更は**後半4面にしか掛からない**。
   */
  _frontPoint() {
    const contacts = this.world.detection.contactsFor(this.side);
    let x = 0;
    let z = 0;
    let n = 0;
    for (const t of this._groundTargets()) {
      const c = contacts.get(t.id);
      if (!c) continue;                 // 真の位置は読まない。記憶の位置だけを使う
      x += c.pos.x; z += c.pos.z; n++;
    }
    return n ? { x: x / n, z: z / n } : null;
  }

  /**
   * どこまで前に出すか。中間(0.5)を基本に、**探知している SAM の圏には入れない。**
   *
   * 手前から刻んで、**最初に圏へ触れた一歩前で止める。**
   * 方程式を解くと「SAM を跨いだ向こう側」も解に出てしまい、
   * 圏を突っ切った先に哨戒エリアを置きかねない。
   */
  _forwardFraction(from, front) {
    const sams = [];
    for (const [, c] of this.world.detection.contactsFor(this.side)) {
      const s = c.unit;
      if (s && s.alive && s.side !== this.side && s.kind === 'sam') sams.push(c.pos);
    }
    let best = 0;
    for (let t = 0; t <= FORWARD_FRAC + 1e-9; t += 0.05) {
      const x = from.x + (front.x - from.x) * t;
      const z = from.z + (front.z - from.z) * t;
      if (sams.some((s) => Math.hypot(x - s.x, z - s.z) < SAM_KEEPOUT)) break;
      best = t;
    }
    return best;
  }

  /**
   * 対地目標を選ぶ。
   *
   * **近い順ではなく、目標の並び順を尊重する。** 近い順にすると、
   * 全機が同じ（いちばん近い）目標へ殺到する。目標ごとに向かっている機数を数え、
   * 割り振られていないものから埋める。
   */
  _pickGround(u, ground) {
    if (!ground.length) return null;

    // すでに向かっている先が生きていて、まだ目標に含まれるなら変えない
    if (u.strikeTarget && u.strikeTarget.alive && ground.includes(u.strikeTarget)) {
      return u.strikeTarget;
    }

    const assigned = new Map();
    for (const o of this._myAircraft()) {
      if (o === u || !o.alive || !o.strikeTarget) continue;
      assigned.set(o.strikeTarget, (assigned.get(o.strikeTarget) || 0) + 1);
    }

    let best = null;
    let bestScore = Infinity;
    for (const t of ground) {
      if (!this._canHurt(u, t)) continue;
      // 誰も向かっていない目標を優先し、同数なら近い方
      const score = (assigned.get(t) || 0) * 1e6 + u.pos.distanceTo(t.pos);
      if (score < bestScore) { bestScore = score; best = t; }
    }
    return best;
  }

  // ------------------------------------------------------------ 見えているもの

  /**
   * 未達の destroyAll 目標に含まれる、**探知できている**地上・水上目標。
   *
   * 目標の一覧そのものはブリーフィングで渡されているので知っていてよい。
   * 知らないのは**どこに居るか**なので、そこを探知に通す。
   * ブリーフィングで判明していた敵（`known: true`）は開始時から記憶にある。
   */
  _groundTargets() {
    const tags = this._openTags();
    if (!tags.size) return [];

    const out = [];
    for (const [, c] of this.world.detection.contactsFor(this.side)) {
      const t = c.unit;
      if (!t || !t.alive || t.side === this.side) continue;
      if (t.kind === 'aircraft') continue;                 // 空中目標は pilot.js の担当
      if (c.level < LEVEL.IDENTIFIED) continue;            // 何か分からないものは狙えない
      if (!t.tags || !t.tags.some((g) => tags.has(g))) continue;
      out.push(t);
    }
    return out;
  }

  /** 未達の destroyAll 目標のタグ */
  _openTags() {
    const tags = new Set();
    for (const o of this.mission.objectives) {
      if (o.type !== 'destroyAll' || o.done) continue;
      if (o.tag) tags.add(o.tag);
    }
    return tags;
  }

  /**
   * 護衛対象。未失敗の protect 目標に指定された**自軍の機体**。
   *
   * 自軍のことなので探知は要らない。飛行場のような地上資産は
   * 付いて回るものではないので、ここでは機体だけを見る。
   */
  _ward() {
    for (const o of this.mission.objectives) {
      if (o.type !== 'protect' || o.failed || o.done) continue;
      for (const u of this._myAircraft()) {
        if (u.alive && u.tags && u.tags.includes(o.tag)) return u;
      }
    }
    return null;
  }

  // ------------------------------------------------------------ 補助

  /**
   * 自軍のユニット。
   *
   * **ここだけは world.units を読む。** 自分の部隊は把握しているので
   * 探知を通す必要が無い。敵を見るときは必ず detection を通すこと。
   */
  _myAircraft() {
    const out = [];
    for (const u of this.world.units) {
      if (u.side === this.side && u.kind === 'aircraft') out.push(u);
    }
    return out;
  }

  _hasAg(u) { return u.loadout.some((id) => AG_WEAPONS.includes(id)); }

  _armed(u) {
    return u.loadout.length > 0 || u.gun > 40;
  }

  /** その機体の兵装で、その目標を傷つけられるか */
  _canHurt(u, t) {
    if (t.kind === 'aircraft') return u.loadout.some((id) => id.startsWith('AAM'));
    return this._hasAg(u);
  }
}
