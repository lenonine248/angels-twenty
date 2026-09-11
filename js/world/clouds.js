// 雲。仕様書 §88。
//
// **光と赤外線は通さない。電波は通るが、通ったぶんだけ弱る。**
//
// 遮断（二値）と減衰（連続）を分けてあるのが要点。
// 層は、光にとっては壁、電波にとっては霞になる:
//
// | | 層の外（上／下）| 層を横切る | 層の中にいる |
// |---|---|---|---|
// | 目視・赤外線 | 効く | **切れる** | **切れる** |
// | 電波 | 効く | 少し弱る | **大きく弱る** |
//
// **横切るのは安い、住むのは高い** —— これを式で持つので、
// 場面ごとの規則を書かなくてよい（§88.3.1）。
//
// 形は**平たい楕円体のリスト**。濃度の場は持たない。
// 判定は線分と楕円体の解析交差で、地形の高さ補間より桁違いに軽い（§88.6）。

import { MAP_SIZE } from './terrain.js';

/** 風のぶんずらした問い合わせ点の置き場（`_shift`）。入れ子で使わない */
const _qa = { x: 0, y: 0, z: 0 };
const _qb = { x: 0, y: 0, z: 0 };

/**
 * 雲量の指定（§88.5）。**覆う割合**で持つ。
 * 名前は実際の航空気象の言い方に合わせてある。
 */
export const CLOUD_COVER = {
  none: 0,
  few: 0.25,
  scattered: 0.5,
  broken: 0.75,
  overcast: 1.0,
};

/**
 * 塊の形の型（§88.12）。**見た目と当たり判定は同じ形**を使うので、
 * ここを変えると遊びも変わる（覆い方が変わる）。
 *
 * | 型 | 見え方 |
 * |---|---|
 * | `puffy` | ふっくらした塊。層というより雲の群れ |
 * | `deck` | 横に広く縦に薄い板。**繋がって「層」に見える** |
 * | `broad` | 少数の巨大な塊。なめらかだが大味 |
 *
 * 数は雲量から出す（`rAvg` が大きい型ほど少なくなる）ので、
 * **型を変えても覆う割合はおおよそ保たれる。**
 */
export const CLOUD_SHAPE = {
  puffy: { rMin: 1800, rMax: 4200, yLo: 0.25, ySpan: 0.50, ryLo: 0.35, rySpan: 0.25 },
  deck: { rMin: 2800, rMax: 5600, yLo: 0.42, ySpan: 0.16, ryLo: 0.16, rySpan: 0.10 },
  broad: { rMin: 7000, rMax: 11000, yLo: 0.40, ySpan: 0.20, ryLo: 0.50, rySpan: 0.15 },
};
const DEFAULT_SHAPE = 'puffy';

/**
 * 風（§88.15）。**既定でも吹く。**
 *
 * 静止した層は地形と同じ「そこにある物」だが、流れると
 * **隠れ場所に期限が付く** ——「雲の切れ目が目標の上に来るまで40秒」が読める。
 *
 * 速さは**塊いくつぶん動くか**で選んだ。`puffy` の塊は直径 3.6〜8.4km、
 * 15分の任務で 12m/s なら 10.8km ＝ **塊1.8個ぶん**。
 * ある地点が1〜2回だけ覆われ直す速さで、これ以上速いと移り変わりが読めない
 * （20m/s だと3個ぶん）。現実の高度4kmの風はもっと速いが、遊びを採る。
 */
export const CLOUD_WIND_SPEED = 12;

/**
 * 塊を撒く範囲を**風上へ広げる長さ**(秒)。
 *
 * 流れれば風上の空が空く。折り返し（トーラス）は当たり判定に剰余が入って
 * `_span` が汚れるうえ地図の端に継ぎ目が出るので、**広げるほうを採った。**
 * 塊が3〜4割増えるだけで、剰余も継ぎ目もない。
 */
export const CLOUD_WIND_SPAN = 1200;

/**
 * 電波の減衰（§88.3.1）。**視線が雲の中を通った距離で決まる。**
 *
 * | | |
 * |---|---|
 * | `PER_KM` | 雲の中 1km あたりに残る割合 |
 * | `FLOOR` | ここより下げない。**電波は最後まで通る** |
 *
 * 層（厚さ1.7km）を縦に横切れば 88% 残り、
 * 層の中を 10km 飛べば 48% まで落ちる。
 */
export const CLOUD_RADAR_PER_KM = 0.93;
export const CLOUD_RADAR_FLOOR = 0.35;

/**
 * 雲の中にいる目標が持つ「紛れる背景」の厚み（§88.3.2）。
 *
 * チャフ（`CHAFF_AS_BACKGROUND = 0.4`）と同じ式に乗る ——
 * **もともと同じものを表していた**（電波を通さない雲）。
 * 撒くのではなくそこにある代わりに、少し濃い。
 */
export const CLOUD_AS_BACKGROUND = 0.5;

export class CloudField {
  /**
   * @param {object} weather `{ cloud, base, top }`。無ければ雲なし
   * @param {() => number} rng **戦闘の種から作った乱数**。
   *   同じ種なら同じ雲になる —— これが無いと前後比較が成立しない
   *   （`[[feedback-fix-seed-for-ab]]`）
   */
  constructor(weather, rng) {
    this.blobs = [];
    this.base = 0;
    this.top = 0;
    if (!weather) return;
    const cover = CLOUD_COVER[weather.cloud] ?? 0;
    if (cover <= 0) return;

    // ---- 風（§88.15）。**乱数は向きを指定しても必ず引く** ——
    // 引いたり引かなかったりすると、`deg` を書いた面と書かない面で
    // **塊の並びまで変わって**前後比較が成立しない（`[[feedback-fix-seed-for-ab]]`）。
    const wind = weather.wind ?? {};
    const spun = Math.floor(rng() * 360);
    /** 風速(m/s)。0 なら流れない */
    this.windSpeed = Math.max(0, wind.speed ?? CLOUD_WIND_SPEED);
    /** **吹いてくる**方位(度)。航空気象と同じ向きの数え方 */
    this.windDeg = ((wind.deg ?? spun) % 360 + 360) % 360;
    const to = (this.windDeg + 180) * Math.PI / 180;    // 流れていく向き
    this.vx = Math.sin(to) * this.windSpeed;
    this.vz = -Math.cos(to) * this.windSpeed;
    /** 開始からの流れた量(m)。**塊は動かさない**（`_shift`）*/
    this.offset = { x: 0, z: 0 };

    this.base = weather.base ?? 2500;
    this.top = weather.top ?? (this.base + 1700);
    const thickness = Math.max(200, this.top - this.base);
    const sh = CLOUD_SHAPE[weather.shape] || CLOUD_SHAPE[DEFAULT_SHAPE];
    this.shape = weather.shape && CLOUD_SHAPE[weather.shape] ? weather.shape : DEFAULT_SHAPE;

    // 覆う割合から個数を決める。塊は重なるので、面積の単純な割り算より多めに要る。
    // 1.6 倍は「重なりぶんの取り返し」で、実際の覆いを数えて合わせた係数ではない ——
    // **雲量は見た目の目安**であって、ここで精度を出しても読み手に伝わらない。
    const rAvg = (sh.rMin + sh.rMax) / 2;

    // 撒く範囲を**風上へ広げる**（§88.15）。任務のあいだ地図が空かないように。
    // **個数も面積に合わせて増やす** —— 広げただけだと雲量が薄まり、
    // `scattered` と書いたのに `few` になる。
    const mx = Math.abs(this.vx) * CLOUD_WIND_SPAN;
    const mz = Math.abs(this.vz) * CLOUD_WIND_SPAN;
    const x0 = this.vx > 0 ? -mx : 0;
    const z0 = this.vz > 0 ? -mz : 0;
    const spanX = MAP_SIZE + mx, spanZ = MAP_SIZE + mz;
    const n = Math.round((cover * spanX * spanZ) / (Math.PI * rAvg * rAvg) * 1.6);

    for (let i = 0; i < n; i++) {
      const rx = sh.rMin + rng() * (sh.rMax - sh.rMin);
      this.blobs.push({
        x: x0 + rng() * spanX,
        z: z0 + rng() * spanZ,
        // 層の中に収める
        y: this.base + thickness * (sh.yLo + rng() * sh.ySpan),
        rx,
        // 平たくする。横に伸びた塊のほうが「層」に見える
        rz: rx * (0.7 + rng() * 0.6),
        ry: thickness * (sh.ryLo + rng() * sh.rySpan),
      });
    }
  }

  get active() { return this.blobs.length > 0; }

  /**
   * 風で流す（§88.15）。**固定刻みの中から呼ぶこと。**
   *
   * `offset = 風 × 経過時間` なので、**種が同じなら同じように流れる。**
   * 描画側は `group.position` にこれを入れるだけ ——
   * **見た目と当たり判定が同じ量だけずれる**ので、§88.12 の約束は保たれる。
   */
  advance(dt) {
    if (!this.windSpeed || !this.blobs.length) return;
    this.offset.x += this.vx * dt;
    this.offset.z += this.vz * dt;
  }

  /**
   * 風のぶん**問い合わせの点を戻す**（§88.15）。
   *
   * 塊111個に足し算するのではなく、**引き算2回**で済ませる。
   * `_span` は無変更、費用は実質ゼロ。
   */
  _shift(p, out) {
    out.x = p.x - this.offset.x;
    out.y = p.y;
    out.z = p.z - this.offset.z;
    return out;
  }

  /**
   * 線分が雲を通るか（§88.3）。**光と赤外線の遮断はこれで見る。**
   *
   * 中にいるか後ろにいるかを区別しない —— 雲の中の機体は、
   * そのままどの向きにも見えず、見えなくなる。特別扱いを書かずに済む。
   */
  blocks(a, b) {
    if (!this.blobs.length) return false;
    // 線分が層の外を通るだけなら、雲には当たりようがない。
    // **直線なので端点が両方とも層の上（下）なら、途中も層の外**
    if ((a.y >= this.top && b.y >= this.top) || (a.y <= this.base && b.y <= this.base)) return false;
    const p = this._shift(a, _qa), q = this._shift(b, _qb);
    for (const c of this.blobs) {
      if (this._hit(c, p, q)) return true;
    }
    return false;
  }

  /**
   * 線分のうち雲の中を通る長さ(m)（§88.3.1）。**電波の減衰はこれで決まる。**
   *
   * **重なりは足さない。** 区間を集めて併合してから測る ——
   * 二重に数えると、雲量を上げたときに減衰が跳ね上がって読めなくなる。
   */
  pathLength(a, b) {
    if (!this.blobs.length) return 0;
    if ((a.y >= this.top && b.y >= this.top) || (a.y <= this.base && b.y <= this.base)) return 0;
    const p = this._shift(a, _qa), q = this._shift(b, _qb);
    const spans = [];
    for (const c of this.blobs) {
      const s = this._span(c, p, q);
      if (s) spans.push(s);
    }
    if (!spans.length) return 0;
    spans.sort((p, q) => p[0] - q[0]);
    let total = 0;
    let [lo, hi] = spans[0];
    for (let i = 1; i < spans.length; i++) {
      const [s0, s1] = spans[i];
      if (s0 > hi) { total += hi - lo; lo = s0; hi = s1; }
      else if (s1 > hi) hi = s1;
    }
    total += hi - lo;
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
    return total * Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  /** 電波の実効射程に掛ける割合（§88.3.1） */
  radarFactor(a, b) {
    if (!this.blobs.length) return 1;
    const km = this.pathLength(a, b) / 1000;
    if (km <= 0) return 1;
    return Math.max(CLOUD_RADAR_FLOOR, CLOUD_RADAR_PER_KM ** km);
  }

  /** その点が雲の中か（§88.3.2 の「紛れる背景」） */
  contains(p) {
    if (!this.blobs.length) return false;
    if (p.y > this.top || p.y < this.base) return false;
    const w = this._shift(p, _qa);
    for (const c of this.blobs) {
      const dx = (w.x - c.x) / c.rx;
      const dy = (w.y - c.y) / c.ry;
      const dz = (w.z - c.z) / c.rz;
      if (dx * dx + dy * dy + dz * dz <= 1) return true;
    }
    return false;
  }

  // -------------------------------------------------------------- 内部

  /**
   * 線分と楕円体の交差区間 `[t0, t1]`（0..1）。当たらなければ null。
   *
   * 半径で割って**単位球に直してから**解く。楕円体のままだと式が長くなるだけで、
   * 割り算3回のほうが安い。
   */
  _span(c, a, b) {
    const ax = (a.x - c.x) / c.rx, ay = (a.y - c.y) / c.ry, az = (a.z - c.z) / c.rz;
    const bx = (b.x - c.x) / c.rx, by = (b.y - c.y) / c.ry, bz = (b.z - c.z) / c.rz;
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    const A = dx * dx + dy * dy + dz * dz;
    if (A < 1e-12) return null;
    const B = 2 * (ax * dx + ay * dy + az * dz);
    const C = ax * ax + ay * ay + az * az - 1;
    const disc = B * B - 4 * A * C;
    if (disc < 0) return null;
    const sq = Math.sqrt(disc);
    let t0 = (-B - sq) / (2 * A);
    let t1 = (-B + sq) / (2 * A);
    if (t1 <= 0 || t0 >= 1) return null;          // 線分の外だけで交差している
    if (t0 < 0) t0 = 0;
    if (t1 > 1) t1 = 1;
    return [t0, t1];
  }

  _hit(c, a, b) { return this._span(c, a, b) !== null; }
}
