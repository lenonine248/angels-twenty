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
import { isArmed, WEAPONS } from '../data/weapons.js';
import { samRangeOf } from '../data/ground.js';

/** 考える間隔(秒)。パイロットより遅くてよい */
const THINK_INTERVAL = 2;

/** 対地兵装 */
const AG_WEAPONS = ['AGM', 'ARM', 'BOMB'];

/** 哨戒エリアの半径(m) */
const PATROL_RADIUS = 4500;

/**
 * 見失った目標を探すときの旋回半径(m)（§72.5）。哨戒より広く取る ——
 * 待つのではなく**掃くため**の輪なので、狭いと同じ空をなぞるだけになる。
 */
const SEARCH_RADIUS = 7000;

/**
 * 見失った目標の**司令部の記録**を捨てるまで(秒)（§72.5）。
 *
 * 航跡（`sim/detection.js`）は 150秒で忘れる —— 一度見ただけの印が
 * 終盤まで残るのは情報の駆け引きとして緩い、という判断（§54）。**それは正しい。**
 * だが「印が消える」ことと「そこに居たことを司令部が忘れる」ことは別で、
 * **忘れていたのは後者**だった。
 *
 * 艦船は 9m/s なので、600秒後でも推測点からのずれは 5.4km ——
 * `SEARCH_RADIUS` と機体のレーダー（22〜34km）で十分に拾える。
 */
const PLOT_LIFE = 600;

/** 探索点を置き直す最小の移動量(m)。これ未満なら動かさない */
const SEARCH_HYSTERESIS = 4000;

/**
 * 護衛する相手が居ないときに置く哨戒エリアの位置。
 * 本拠と目標を結ぶ線の、この割合だけ前（§59.4）。
 */
const FORWARD_FRAC = 0.5;

// 哨戒エリアを SAM に寄せない距離は、**その SAM の射程から出す**（§72.3）。
// 以前は 22km の一律だった（`SAM_KEEPOUT`）。`_knownSams()` を参照。
//
// 哨戒は交戦ではないので、撃たれる位置で旋回させる意味が無い。
// COORDINATE には対地脅威の手当てが無い（`ai/pilot.js` の降下は STRIKE だけ）。

/** 哨戒エリアを置き直す最小の移動量(m)。これ未満なら動かさない */
const PATROL_HYSTERESIS = 3000;

/**
 * SAM の射程に足すゆとり(m)（§72.3）。
 * 実効射程は目標高度で伸びるので、公称 19km に対して実測は最大 20.1km。
 */
const SAM_MARGIN = 3000;


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
    /**
     * **司令部の記録**（§72.5）。目標を最後にどこで見たか。
     * 航跡が消えても、ここには残る。`{ x, z, heading, speed, t, watched }`
     */
    this._plots = new Map();
  }

  update(dt) {
    this.time += dt;
    if (this.time < this._next) return;
    this._next = this.time + THINK_INTERVAL;

    this._rememberPlots();
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
      if (isArmed(u.spec) && !this._armed(u)) continue;
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
      if (!isArmed(u.spec)) continue;                   // 非武装の支援機は経路のまま

      // 1. **本来の戦闘機**は護衛に付く。
      //    攻撃目標より先に見る（護衛ステージには destroyAll 目標が無い）。
      //
      //    守る相手は2種類ある。**protect 目標の機体が最優先**で、
      //    それが無ければ**進出する味方の攻撃機**に付く（§59.4）。
      //    後者を入れるまで、後半4面の空戦機は一度も護衛にならなかった ——
      //    protect 目標が自軍飛行場（＝機体ではない）なので 1 が成立せず、
      //    全機が 3 に落ちて発進地点で旋回していた（§59.2）。
      //
      //    **判定は「いま積んでいるか」ではなく「離陸時に積んでいたか」**（§72.1）。
      //    ここが `!this._hasAg(u)` だったせいで、**任務を終えた攻撃機が
      //    そのまま護衛に化けて**いた（§72 の測定を参照）。
      if (!this._isStriker(u)) {
        const w = (ward && ward !== u) ? ward : this._pickWard(u, wards);
        // **SAM の圏でも護衛は離れない**（§72.3・測って取り消した）。
        // 「護衛は SAM を壊せないのだから圏の外で待つべき」と考えて入れたが、
        // 測ったら **DAWN BLADE が 5/6 → 2/6**、IRON UMBRELLA の損失が
        // 1.3 → 2.5 に増えた。**護衛の値打ちのほうが SAM の危険より大きい** ——
        // 離した護衛のぶん、攻撃機が敵戦闘機に落とされるようになった。
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
          u.searchPlot = null;
          continue;
        }
        // **見えていないなら、最後に分かっていた場所へ探しに行く**（§72.5）。
        // 弾を積んで戻ってきたのに行き先が無い、という状態を無くす。
        const spot = this._pickSearch(u);
        if (spot) { this._sendSearch(u, spot); continue; }
      }

      // 3. **撃ち尽くした攻撃機は積み直しに帰る**（§72.2）。
      //    着陸 → 整備 → `_launch()` が次に考えたときに送り出す、までは
      //    既にある仕組みが動く。**足りなかったのは「帰れ」と言う一言だけ。**
      if (this._isStriker(u) && this._needsRearm(u)) {
        this._setMode(u, 'RTB');
        u.strikeTarget = null;
        u.escortTarget = null;
        this.world.log?.(`${u.name} 対地兵装を撃ち尽くしました — 積み直しに帰投`, u);
        continue;
      }

      // 4. それ以外は連携（編隊で扇を分担し、目標の重複を避ける）。
      //    どの敵機を撃つかは pilot.js が探知から決める。
      //
      //    積み直せない攻撃機もここへ落ちる。**護衛には回さない** ——
      //    哨戒エリアは SAM の圏を避けて置かれる（`_forwardFraction`）が、
      //    護衛は護る相手の後ろに付くので、圏の中まで一緒に入っていく。
      //    武器の無い機体にとっては、その差がそのまま生死になる。
      this._setMode(u, 'COORDINATE');
      this._placePatrol(u);
      u.strikeTarget = null;
      u.escortTarget = null;
      u.searchPlot = null;
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
    if (n) return { x: x / n, z: z / n };

    // **航跡が全部消えていても、司令部の記録があれば前へ出る**（§72.5）。
    // これが無いと、目標を見失った瞬間に護衛機まで発進地点へ戻ってしまう。
    for (const [, p] of this._plots) {
      const age = this.time - p.t;
      x += p.x + Math.sin(p.heading) * p.speed * age;
      z += p.z - Math.cos(p.heading) * p.speed * age;
      n++;
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
    const sams = this._knownSams();
    let best = 0;
    for (let t = 0; t <= FORWARD_FRAC + 1e-9; t += 0.05) {
      const x = from.x + (front.x - from.x) * t;
      const z = from.z + (front.z - from.z) * t;
      if (sams.some((s) => Math.hypot(x - s.x, z - s.z) < s.r)) break;
      best = t;
    }
    return best;
  }

  /**
   * 探知している対空ミサイル座と、**その射程**（§72.3）。
   *
   * 以前は `s.kind === 'sam'` で拾って、危険の大きさは
   * `SAM_KEEPOUT = 22km` の**一律**だった。これだと
   *
   * - **ミサイル艦が漏れる**（`kind` は 'ship' だが SAM を持つ）
   * - **赤外線SAM（6km）を 22km の脅威として扱う** —— 近づけない場所が広がりすぎる
   *
   * 「どの種別か」ではなく「何を積んでいるか」で見る
   * （`samRangeOf` ・ §42〜§44 と同じ切り口）。
   *
   * 位置は**記憶の座標**を使う。真の位置を読むと、見えていない SAM まで避けてしまう。
   */
  _knownSams() {
    const out = [];
    for (const [, c] of this.world.detection.contactsFor(this.side)) {
      const s = c.unit;
      if (!s || !s.alive || s.side === this.side || s.kind === 'aircraft') continue;
      const r = samRangeOf(s.spec);
      if (r > 0) out.push({ x: c.pos.x, z: c.pos.z, r: r + SAM_MARGIN });
    }
    return out;
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
      // 誰も向かっていない目標を優先し、同数なら近い方。
      //
      // **「防空を先に剥がす」順位は入れて、測って取り消した**（§72.4）。
      // 3通り試してどれも悪化した:
      //
      // | 試したこと | DAWN BLADE |
      // |---|---|
      // | 何もしない（再出撃だけ）| **5/6** |
      // | 防空を先に、という順位だけ | 5/6（**何も動かない**）|
      // | 任務外の防空も候補に足す | **0/6** |
      // | ＋ 外から撃てる機体だけに絞る | 2/6 |
      //
      // 順位だけでは動かなかったのは、後半4面の SAM陣地が
      // **どれも `tags: []` で候補に入っていなかった**から（§72.4）。
      // 候補に足すと、今度は限られた機数と弾を邪魔者に使ってしまう。
      // **邪魔者は `ai/pilot.js` が近づいたときに撃つ**（実測で ARM は出ている）。
      // 司令官が名指しで送り込む価値は、この規模の任務では出なかった。
      const score = (assigned.get(t) || 0) * 1e6 + u.pos.distanceTo(t.pos);
      if (score < bestScore) { bestScore = score; best = t; }
    }
    return best;
  }

  // ------------------------------------------------------------ 見えているもの

  /**
   * 未達の destroyAll 目標に含まれる、**探知できている**地上・水上目標。
   *
   * > **任務が名指ししていない防空も候補に足す案は、測って取り消した**（§72.4）。
   * > 後半4面の SAM陣地は**どれも `tags: []`** なので候補に入らない ——
   * > だから「防空を先に」という順位を付けても何も動かなかった。
   * > 足してみると、限られた機数と弾を邪魔者に使って DAWN BLADE が 5/6 → 0/6。
   * > 邪魔者は `ai/pilot.js` が近づいたときに撃つ（実測で ARM は出ている）。
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


  /**
   * 目標を最後にどこで見たかを控える（§72.5）。
   *
   * **航跡が消えても、司令部の記録は残る。**
   * 探知（`sim/detection.js`）が 150秒で忘れるのは正しい —— 一度見ただけの印が
   * 終盤まで残るのは緩い（§54）。だが「印が消える」ことと
   * 「そこに居たことを忘れる」ことは別で、後者まで一緒に消えていた。
   *
   * COASTAL WALL では、揚陸艦2の航跡が t430 に、車両部隊が t330 に消える。
   * 攻撃機は t500 ごろ積み直して戻ってくるが、**そのとき行き先が無かった**。
   *
   * ##### 片付いた相手の記録は残さない
   *
   * 航跡が消える直前まで**見えていた**なら、その結末もこちらは見ている
   * （`detection.js` は目視下で壊れた目標の航跡をその場で消す）。
   * 逆に、**見失ってから消えた**記録は「まだそこに居るかもしれない」の意味を持つ。
   * この2つを `watched` で分ける —— 真の生死を読まずに、**見ていたかどうか**で切る。
   */
  _rememberPlots() {
    const tags = this._openTags();
    if (!tags.size) { this._plots.clear(); return; }

    const alive = new Set();
    for (const [id, c] of this.world.detection.contactsFor(this.side)) {
      const t = c.unit;
      if (!t || t.side === this.side || t.kind === 'aircraft') continue;
      if (!t.tags || !t.tags.some((g) => tags.has(g))) continue;
      alive.add(id);
      this._plots.set(id, { x: c.pos.x, z: c.pos.z, heading: c.heading || 0,
        speed: c.speed || 0, t: this.time, watched: c.detected });
    }
    for (const [id, p] of this._plots) {
      if (alive.has(id)) continue;
      // 見ている前で航跡が消えた ＝ 結末を見た。探しに行く理由が無い
      if (p.watched) { this._plots.delete(id); continue; }
      if (this.time - p.t > PLOT_LIFE) this._plots.delete(id);
    }
  }

  /**
   * 探しに行く先（§72.5）。**最後に見た点を、推測進路へ延ばした場所。**
   *
   * 航跡がまだ生きている目標は `_groundTargets()` が返すので、ここには来ない ——
   * 呼ばれるのは「目標が1つも見えていないが、任務はまだ終わっていない」ときだけ。
   *
   * 誰も向かっていない記録から埋める（`_pickGround` と同じ理由 ——
   * 近い順だけだと全機が同じ場所へ殺到する）。
   */
  _pickSearch(u) {
    if (!this._plots.size) return null;

    const assigned = new Map();
    for (const o of this._myAircraft()) {
      if (o === u || !o.alive || o.searchPlot == null) continue;
      assigned.set(o.searchPlot, (assigned.get(o.searchPlot) || 0) + 1);
    }

    let best = null;
    let bestScore = Infinity;
    for (const [id, p] of this._plots) {
      const age = this.time - p.t;
      const x = p.x + Math.sin(p.heading) * p.speed * age;
      const z = p.z - Math.cos(p.heading) * p.speed * age;
      const score = (assigned.get(id) || 0) * 1e6 + Math.hypot(u.pos.x - x, u.pos.z - z);
      if (score < bestScore) { bestScore = score; best = { id, x, z }; }
    }
    return best;
  }

  /**
   * 探索へ送る。**STRIKE のまま哨戒エリアだけを置き換える。**
   *
   * `ai/pilot.js` の `_strike` は目標が無ければ哨戒に落ちる作りなので、
   * モードを変えずに輪の場所だけ動かせば「そこへ行って探す」になる。
   * 見つかれば次に考えたときに `_pickGround` が拾って、いつもの打撃に戻る。
   */
  _sendSearch(u, spot) {
    this._setMode(u, 'STRIKE');
    u.strikeTarget = null;
    u.escortTarget = null;
    u.searchPlot = spot.id;
    const a = u.patrolArea;
    if (a && a.byCommander && Math.hypot(a.x - spot.x, a.z - spot.z) < SEARCH_HYSTERESIS) return;
    u.patrolArea = { x: spot.x, z: spot.z, alt: u.desiredAlt,
      radius: SEARCH_RADIUS, byCommander: true };
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

  /**
   * **その機体の役**（§72.1）。いま積んでいるものではなく、
   * **離陸時に積んでいたもの**で決める。
   *
   * `_hasAg()` は「いま対地を撃てるか」を答える。役はそれとは別のことで、
   * 混ぜると**任務を終えた攻撃機が戦闘機に化ける**。
   * 実際そうなっていて、ARM を撃ち尽くした HAMMER 1 は AAM-S 1発のまま
   * 護衛に付き、119秒かけて SAM陣地へ詰めて落とされていた（§72）。
   *
   * 積み直しの予定（`plannedLoadout`）があればそちらを見る ——
   * これから何を積む機体かのほうが、役としては正しい。
   */
  _isStriker(u) {
    const base = u.plannedLoadout || u.baseLoadout || u.loadout;
    return base.some((id) => AG_WEAPONS.includes(id));
  }

  /**
   * 帰って積み直す値打ちがあるか（§72.2）。
   *
   * 「対地兵装が空だから帰る」ではない。**帰ったら積めるのか**を見る ——
   * 積めないのに帰ると、降りて上がってまた空、という往復になる。
   *
   * 見るのは4つ:
   *
   * | | なぜ |
   * |---|---|
   * | まだ壊すべき地上目標がある | 目標が片付いていれば帰る理由が無い |
   * | 生きている自軍飛行場がある | 帰る先 |
   * | 誘導中の弾が無い | 機首を振ると自分の弾の誘導が切れる |
   * | **1発でも買い直せる** | 兵装ポイントは有限（§18 の「節約」の原資）|
   *
   * 兵装ポイントは**単調に減るだけ**なので、この判定でぐるぐる回ることはない。
   * 無誘導爆弾は 0P なので、爆装機はいつでも積み直せる ——
   * そのぶん時間を払う（「迅速」の評価が下がる）という取引になっている。
   */
  _needsRearm(u) {
    if (!this._openTags().size) return false;
    const base = u.airbase;
    if (!base || !base.alive) return false;
    if (u._guidingSarh && u._guidingSarh(this.world)) return false;

    // 兵装ポイントはブリーフィングで配られる**プレイヤー側の**原資。
    // 敵側の司令官（§27.6）にはこの縛りが無い。
    const budget = this.side === this.world.playerSide
      ? (this.world.weaponPoints ?? 0) : Infinity;

    const have = u.loadout.slice();
    for (const id of (u.plannedLoadout || u.baseLoadout || [])) {
      if (!AG_WEAPONS.includes(id)) continue;
      const i = have.indexOf(id);
      if (i >= 0) { have.splice(i, 1); continue; }   // それはまだ積んでいる
      const cost = (WEAPONS[id] || {}).cost || 0;
      if (cost <= budget) return true;
    }
    return false;
  }

  _armed(u) {
    return u.loadout.length > 0 || u.gun > 40;
  }



  /** その機体の兵装で、その目標を傷つけられるか */
  _canHurt(u, t) {
    if (t.kind === 'aircraft') return u.loadout.some((id) => id.startsWith('AAM'));
    return this._hasAg(u);
  }
}
