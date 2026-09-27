// ユニット基底クラス。
// 戦闘機・SAM・飛行場・地上部隊など、フィールド上のすべての戦力の共通部分。

import * as THREE from 'three';

/**
 * 逆探知される距離 ÷ レーダー射程（§26.3 / §30.3）。
 *
 * **航空機も地上も同じ規則**。強いレーダーほど遠くから見つかる。
 * 以前は地上だけ一律60kmという別の規則だったが、一本化した。
 * これで射程が両刃になり、1つのノブが「見える距離」と
 * 「見つかる距離」の2つの意味を持つ。
 */
export const RWR_SIGNATURE_FACTOR = 1.5;

let nextId = 1;

/**
 * ID を振り直す。**戦闘を組むたびに呼ぶ**。
 *
 * ID は見分けのためだけの数字ではない。レーダーの扇の分担や逆探知の位置誤差が
 * ID から決まるので、通し番号のままだと**同じステージを同じシードで始めても、
 * その回までに何戦したかで経過が変わる**（`tools/bench.js` の注意書きはこれ）。
 * 記録した戦闘をあとから追う土台として、ここは毎回同じところから始める。
 */
export function resetUnitIds() { nextId = 1; }

export const SIDE = { BLUE: 'blue', RED: 'red' };

/**
 * **指揮系統**（§102）。陣営（`side`）とは別の軸。
 *
 * 自軍の中に「プレイヤーが動かすもの」と「友軍の司令官AIが動かすもの」が並ぶ。
 * 友軍は `owner: 'ally'`、それ以外（プレイヤーの機体・敵のすべて）は持たない。
 *
 * **`side === playerSide` と書く前に、それが陣営の意味か指揮の意味かを決める。**
 * 探知・霧・撃墜の記録は陣営、選択・一覧・敗北・評価・兵装ポイントは指揮
 * （仕分けの表は JOURNAL §102）。指揮の意味なら `isPlayerOwned` を使う。
 */
export const OWNER = { ALLY: 'ally' };

/** 友軍の司令官AIの指揮下か（§102） */
export function isAlly(u) { return !!u && u.owner === OWNER.ALLY; }

/** **プレイヤーの指揮下か**（§102）。自軍で、友軍ではないもの */
export function isPlayerOwned(u, world) {
  return !!u && u.side === world.playerSide && u.owner !== OWNER.ALLY;
}

/**
 * 印の色の鍵（§102）。**友軍の航空機だけ `'ally'`（緑）**、ほかは陣営のまま。
 * 友軍の地上部隊は自軍と同じ青（プレイヤーの決め・Q7）。
 */
export function colorKeyOf(u) {
  return u && u.owner === OWNER.ALLY && u.kind === 'aircraft' ? 'ally' : (u ? u.side : 'red');
}

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

    /** 指揮系統（§102）。友軍なら 'ally'、それ以外は null */
    this.owner = o.owner === OWNER.ALLY ? OWNER.ALLY : null;

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
    // **最後に当てたものを残す**（§12.3 の P0）。`destroy()` は受け取った相手を捨てるので、
    // ここで取らないと「誰に落とされたか」がどこにも残らない
    if (source) this.lastHit = hitOf(source, this) || this.lastHit;
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

/**
 * 当てたものを `{ by, weapon }` にする（§12.3 の P0）。
 *
 * | 渡ってくるもの | by | weapon |
 * |---|---|---|
 * | ミサイル・爆弾（`missile.js`） | 発射した機体・陣地（`launcher`） | 兵装ID |
 * | 弾（`bullet.js` は撃った機体をそのまま渡す） | 撃った機体・陣地 | `GUN` |
 * | 自分の飛行場（駐機中に飛行場ごと壊された） | 飛行場を壊したもの | その兵装 |
 */
function hitOf(source, victim) {
  if (source.launcher) return { by: source.launcher, weapon: source.weapon ? source.weapon.id : null };
  if (source.kind === 'airbase' && source.side === victim.side) return source.lastHit || null;
  if (source.kind) return { by: source, weapon: 'GUN' };
  return null;
}

/**
 * 落とした相手（§12.3 の P0）。**地形・燃料・撤退で死んだものは null** ——
 * 直前に被弾していても、死因はそちらではない。攻撃者が分からないことを「地形」と混ぜない。
 */
export function killedBy(u) {
  if (u.deathCause && u.deathCause !== '地上撃破') return null;
  return u.lastHit && u.lastHit.by ? u.lastHit : null;
}

/** 方位ベクトル(dx,dz) → 方位角ラジアン（0=北, 時計回り） */
export function headingOf(dx, dz) {
  return Math.atan2(dx, -dz);
}

/** 角度差を -PI..PI に正規化 */
/**
 * レーダーの扇の**上下**の角度。**機首から測る**（§83）。
 *
 * 左右は `heading` から、上下は `pitch` から —— **走査は機体に付いている。**
 *
 * ここは一度入れて（§80.3）、一度取り消して（§82）、また入れた。
 * 取り消したときの理由は「上昇・降下しているあいだ正面の目標を見失う」で、
 * **症状はそのとおりだったが、原因の読み方が違っていた** ——
 *
 * > 誘導中に機首を扇の内側へ保つ仕掛けが、**左右にしか無かった**。
 *
 * クランク（§28.7）は方位だけを扇の6割に抑えていて、**上下は誰も見ていない。**
 * 空戦機動が高度を大きく振ると、そのぶん機首が上下を向いて目標が縦に出る。
 * **足りないのは扇のほうではなく、扇の中に目標を置き続ける操縦だった。**
 * 縦のクランクは `sim/aircraft.js` の `attack` の枝にある。
 *
 * 回避中は掛からない（回避が高度を上書きする）。そこは §70.4.6 の領分で、
 * **弾を捨ててでも生き延びる**という判断がすでに入っている。
 */
export function radarElevation(sensor, dy, flat) {
  return Math.atan2(dy, Math.max(1, flat)) - (sensor.pitch || 0);
}

export function angleDiff(a, b) {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

export const DEG = Math.PI / 180;
