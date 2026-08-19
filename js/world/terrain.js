// 地形。ステージ固定シードからハイトマップを生成し、
//  - 3Dメッシュ（ローポリ・フラットシェーディング）
//  - 高度問い合わせ（飛行・地形回避・爆撃判定用）
//  - 視線判定（レーダー／目視／シーカーの地形遮蔽）
//  - ミニマップ画像
// を提供する。
//
// 座標系: X=東 / Z=南 / Y=高度。単位はすべてメートル。原点はマップ北西角。

import * as THREE from 'three';
import { makeRng, makeValueNoise2D, fbm, ridge, clamp, smoothstep, lerp } from '../core/rng.js';

export const CELLS = 256;            // セル数（片辺）
export const CELL_SIZE = 200;        // 1セル = 200m
export const MAP_SIZE = CELLS * CELL_SIZE;  // 51,200m
export const VERTS = CELLS + 1;      // 頂点数（片辺）
export const SEA_LEVEL = 0;

/** 地形の見た目の配色（標高・傾斜で決定） */
const PALETTE = {
  deep:    [0.03, 0.10, 0.20],
  shallow: [0.07, 0.22, 0.34],
  sand:    [0.62, 0.57, 0.38],
  grass:   [0.24, 0.35, 0.19],
  forest:  [0.15, 0.26, 0.15],
  rock:    [0.34, 0.32, 0.29],
  scree:   [0.45, 0.42, 0.38],
  snow:    [0.86, 0.88, 0.90],
};

const DEFAULT_PARAMS = {
  seed: 12345,
  mountainAmount: 1.0,   // 0..1.5 山岳の量
  coast: 'none',         // 'none' | 'n' | 'e' | 's' | 'w'
  valleyDepth: 1.0,      // 0..1.5 谷の深さ
  rivers: 2,             // 河川の本数
  baseAltitude: 400,     // 全体標高オフセット(m)
};

export class Terrain {
  constructor(params = {}) {
    this.params = { ...DEFAULT_PARAMS, ...params };
    this.height = new Float32Array(VERTS * VERTS);
    this.riverSurface = new Float32Array(CELLS * CELLS).fill(NaN);
    this._generate();
  }

  // ---------------------------------------------------------------- 生成

  _generate() {
    const p = this.params;
    const rng = makeRng(p.seed);
    const nBase = makeValueNoise2D(rng);
    const nMount = makeValueNoise2D(rng);
    const nMask = makeValueNoise2D(rng);
    const nDetail = makeValueNoise2D(rng);
    const nCoast = makeValueNoise2D(rng);

    const H = this.height;

    for (let j = 0; j < VERTS; j++) {
      for (let i = 0; i < VERTS; i++) {
        const u = i / CELLS, v = j / CELLS;   // 0..1
        const wx = u * 7.0, wy = v * 7.0;     // マップ全体で約7周期

        // 基調となる大きな起伏
        let h = p.baseAltitude + fbm(nBase, wx, wy, 5) * 650;

        // 山岳域マスク（山が固まって存在するように）
        const maskRaw = (fbm(nMask, wx * 0.42 + 31.7, wy * 0.42 + 17.3, 3) + 1) * 0.5;
        const mountainMask = smoothstep(0.34, 0.64, maskRaw);
        h += ridge(nMount, wx * 1.35 + 7.1, wy * 1.35 + 3.9, 5)
             * mountainMask * p.mountainAmount * 3800;

        // 谷（負のfBmを強調して掘る）。
        // 内陸が海面下まで抉れないよう、掘れる深さを標高に応じて制限する。
        const vRaw = fbm(nDetail, wx * 2.1 + 59.2, wy * 2.1 + 13.4, 3);
        if (vRaw < 0) {
          const cut = Math.pow(-vRaw, 1.4) * p.valleyDepth * 950;
          h -= Math.min(cut, Math.max(0, h - 60) * 0.85);
        }

        // 細かいざらつき
        h += fbm(nDetail, wx * 6.0 + 101.0, wy * 6.0 + 202.0, 3) * 55;

        // 内陸は海面下へ行きにくくする（窪地は湖として少しだけ残す）
        if (h < 40) h = 40 - (40 - h) * 0.18;

        // 海岸線
        if (p.coast !== 'none') {
          const wobble = fbm(nCoast, wx * 1.1 + 5.0, wy * 1.1 + 9.0, 3) * 0.07;
          let t = 0;
          if (p.coast === 'e') t = smoothstep(0.60, 0.97, u + wobble);
          else if (p.coast === 'w') t = smoothstep(0.60, 0.97, (1 - u) + wobble);
          else if (p.coast === 's') t = smoothstep(0.60, 0.97, v + wobble);
          else if (p.coast === 'n') t = smoothstep(0.60, 0.97, (1 - v) + wobble);
          h = lerp(h, -450, t);
        }

        H[j * VERTS + i] = h;
      }
    }

    if (p.rivers > 0) {
      this._carveRivers(rng, p.rivers);
      this._connectRiverDiagonals();
      this._smoothRiverSurface();
    }
  }

  /**
   * 斜めに流れる区間は、セル単位だと角でしか繋がらず隙間が見える。
   * 対角に並んだ河川セルの間を埋めて、帯として連続させる。
   */
  _connectRiverDiagonals() {
    const S = this.riverSurface;
    const at = (i, j) => (i < 0 || j < 0 || i >= CELLS || j >= CELLS ? NaN : S[j * CELLS + i]);
    const add = [];
    for (let j = 0; j < CELLS - 1; j++) {
      for (let i = 0; i < CELLS - 1; i++) {
        const a = at(i, j), b = at(i + 1, j + 1);
        const c = at(i + 1, j), d = at(i, j + 1);
        if (!isNaN(a) && !isNaN(b) && isNaN(c) && isNaN(d)) add.push([i + 1, j, (a + b) * 0.5]);
        else if (!isNaN(c) && !isNaN(d) && isNaN(a) && isNaN(b)) add.push([i, j, (c + d) * 0.5]);
      }
    }
    for (const [i, j, v] of add) S[j * CELLS + i] = v;
  }

  /** 隣接する河川セルの水面高さを均して、段差を目立たなくする */
  _smoothRiverSurface(passes = 2) {
    const S = this.riverSurface;
    for (let p = 0; p < passes; p++) {
      const out = S.slice();
      for (let j = 0; j < CELLS; j++) {
        for (let i = 0; i < CELLS; i++) {
          const k = j * CELLS + i;
          if (isNaN(S[k])) continue;
          let sum = 0, n = 0;
          for (let dj = -1; dj <= 1; dj++) {
            for (let di = -1; di <= 1; di++) {
              const ni = i + di, nj = j + dj;
              if (ni < 0 || nj < 0 || ni >= CELLS || nj >= CELLS) continue;
              const v = S[nj * CELLS + ni];
              if (!isNaN(v)) { sum += v; n++; }
            }
          }
          out[k] = sum / n;
        }
      }
      S.set(out);
    }
  }

  /**
   * 窪地を埋めた「排水可能な高度場」を作る（優先度フラッド法）。
   *
   * ノイズ地形をそのまま貪欲に下ると、数ステップで局所窪地に落ちて
   * 川が伸びない。外周から低い順に内側へ広げ、各点の高度を
   * 「元の高度」と「隣接する既処理点＋ε」の大きい方に決めると、
   * すべての点から外周へ下り続ける経路が存在する高度場になる。
   */
  _fillDepressions() {
    const H = this.height;
    const n = VERTS;
    const filled = new Float32Array(H.length).fill(Infinity);
    const heap = new MinHeap(H.length + n * 4);

    // 外周を種にする
    for (let i = 0; i < n; i++) {
      const border = [i, (n - 1) * n + i, i * n, i * n + (n - 1)];
      for (const idx of border) {
        if (filled[idx] === Infinity) {
          filled[idx] = H[idx];
          heap.push(H[idx], idx);
        }
      }
    }

    const EPS = 0.08;                 // 平坦部でも必ず下れるようにする微小勾配
    const DI = [1, -1, 0, 0];
    const DJ = [0, 0, 1, -1];
    while (heap.size > 0) {
      const idx = heap.pop();
      const h = filled[idx];
      const i = idx % n, j = (idx / n) | 0;
      for (let k = 0; k < 4; k++) {
        const ni = i + DI[k], nj = j + DJ[k];
        if (ni < 0 || nj < 0 || ni >= n || nj >= n) continue;
        const nidx = nj * n + ni;
        if (filled[nidx] !== Infinity) continue;
        filled[nidx] = Math.max(H[nidx], h + EPS);
        heap.push(filled[nidx], nidx);
      }
    }
    return filled;
  }

  /**
   * 河川を掘る。窪地を埋めた高度場の上を下り、経路を溝にして水面を張る。
   * 経路は必ずマップ外周か海に到達するので、途中で途切れない。
   */
  _carveRivers(rng, count) {
    const H = this.height;
    const filled = this._fillDepressions();
    const at = (i, j) => filled[j * VERTS + i];

    for (let r = 0; r < count; r++) {
      // 開始点: 標高が高めの頂点を探す
      let si = -1, sj = -1;
      for (let tries = 0; tries < 200; tries++) {
        const i = rng.int(10, VERTS - 11), j = rng.int(10, VERTS - 11);
        const h = at(i, j);
        if (h > 600 && h < 2800) { si = i; sj = j; break; }
      }
      if (si < 0) continue;

      // 下り方向へ歩く。
      // 窪地を埋めた高度場は平坦部が微小勾配(EPS)になるため、素直に最小値を
      // 選ぶと川が定規で引いたような直線になる。降下する隣接点の中から
      // 「高度＋位置ハッシュによるゆらぎ」が最小のものを選び、蛇行させる。
      const JITTER = 0.9;                   // ゆらぎの大きさ(m)。EPSより十分大きく。
      const path = [];
      let ci = si, cj = sj, waterH = at(si, sj);
      for (let step = 0; step < 4000; step++) {
        path.push([ci, cj, waterH]);
        if (ci <= 1 || cj <= 1 || ci >= VERTS - 2 || cj >= VERTS - 2) break;
        let bi = -1, bj = -1, bh = waterH, bestCost = Infinity;
        for (let dj = -1; dj <= 1; dj++) {
          for (let di = -1; di <= 1; di++) {
            if (di === 0 && dj === 0) continue;
            const ni = ci + di, nj = cj + dj;
            const nh = at(ni, nj);
            if (nh >= waterH) continue;     // 必ず降下する（ループ防止）
            const cost = nh + hash2(ni, nj) * JITTER;
            if (cost < bestCost) { bestCost = cost; bh = nh; bi = ni; bj = nj; }
          }
        }
        if (bi < 0) break;
        ci = bi; cj = bj; waterH = bh;
        if (waterH <= SEA_LEVEL) break;    // 海に到達
      }
      if (path.length < 20) continue;

      // 1) 経路に沿って溝を掘る
      const R = 2;                          // 掘る半径（頂点単位 = 400m）
      for (const [pi, pj, ph] of path) {
        for (let dj = -R; dj <= R; dj++) {
          for (let di = -R; di <= R; di++) {
            const ni = pi + di, nj = pj + dj;
            if (ni < 0 || nj < 0 || ni >= VERTS || nj >= VERTS) continue;
            const d = Math.hypot(di, dj);
            if (d > R) continue;
            const fall = 1 - d / (R + 0.001);
            const target = ph - 55 * fall * fall;
            const idx = nj * VERTS + ni;
            if (H[idx] > target) H[idx] = target;
          }
        }
      }

      // 2) 掘り終わってから水面を張る（河床より上のセルにだけ）
      for (const [pi, pj, ph] of path) {
        const surf = ph - 24;
        for (let dj = -1; dj <= 0; dj++) {
          for (let di = -1; di <= 0; di++) {
            const ci2 = clamp(pi + di, 0, CELLS - 1);
            const cj2 = clamp(pj + dj, 0, CELLS - 1);
            const bed = Math.min(
              H[cj2 * VERTS + ci2], H[cj2 * VERTS + ci2 + 1],
              H[(cj2 + 1) * VERTS + ci2], H[(cj2 + 1) * VERTS + ci2 + 1],
            );
            if (bed >= surf) continue;
            const k = cj2 * CELLS + ci2;
            if (isNaN(this.riverSurface[k]) || this.riverSurface[k] > surf) {
              this.riverSurface[k] = surf;
            }
          }
        }
      }
    }
  }

  // ---------------------------------------------------------------- 問い合わせ

  /** 頂点の標高（格子インデックス、範囲外はクランプ） */
  vertexHeight(i, j) {
    const ci = clamp(i, 0, VERTS - 1) | 0;
    const cj = clamp(j, 0, VERTS - 1) | 0;
    return this.height[cj * VERTS + ci];
  }

  /** ワールド座標(m)の地表標高。バイリニア補間。 */
  heightAt(x, z) {
    const fx = clamp(x / CELL_SIZE, 0, CELLS);
    const fz = clamp(z / CELL_SIZE, 0, CELLS);
    const i = Math.floor(fx), j = Math.floor(fz);
    const tx = fx - i, tz = fz - j;
    const h00 = this.vertexHeight(i, j);
    const h10 = this.vertexHeight(i + 1, j);
    const h01 = this.vertexHeight(i, j + 1);
    const h11 = this.vertexHeight(i + 1, j + 1);
    return lerp(lerp(h00, h10, tx), lerp(h01, h11, tx), tz);
  }

  /** 地表からの相対高度（AGL）。負なら地面より下 = 衝突。 */
  aglAt(x, y, z) {
    return y - Math.max(this.heightAt(x, z), SEA_LEVEL);
  }

  /** 傾斜（0=平ら, 1に近いほど急）。配色と着陸可否判定に使う。 */
  slopeAt(x, z) {
    const d = CELL_SIZE;
    const hx = this.heightAt(x + d, z) - this.heightAt(x - d, z);
    const hz = this.heightAt(x, z + d) - this.heightAt(x, z - d);
    return Math.min(1, Math.hypot(hx, hz) / (2 * d) * 2.2);
  }

  /**
   * 視線判定。a から b が地形に遮られずに見えるか。
   * レーダー・目視・ミサイルシーカーすべてがこれを通る。
   * @param {{x,y,z}} a センサー位置
   * @param {{x,y,z}} b 目標位置
   * @param {number} clearance 地形から確保するマージン(m)
   * @param {number} step サンプル間隔(m)。探知判定は粗く、ミサイルは細かく。
   */
  hasLineOfSight(a, b, clearance = 8, step = CELL_SIZE) {
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 1) return true;
    const steps = Math.min(320, Math.max(6, Math.ceil(dist / step)));
    for (let k = 1; k < steps; k++) {
      const t = k / steps;
      const gx = a.x + dx * t;
      const gz = a.z + dz * t;
      const gy = a.y + dy * t;
      if (this.heightAt(gx, gz) > gy - clearance) return false;
    }
    return true;
  }

  /** マップ内かどうか */
  contains(x, z) {
    return x >= 0 && z >= 0 && x <= MAP_SIZE && z <= MAP_SIZE;
  }

  /**
   * 線分に沿った帯状の地形を指定高度へ均す（整地）。
   *
   * 飛行場を置くときに滑走路と進入路を平らにするために使う。
   * これをしないと、滑走路脇の起伏に降着してしまい着陸できない。
   * メッシュ生成より前に呼ぶこと。
   */
  flattenStrip(ax, az, bx, bz, halfWidth, height, blend = 700) {
    const H = this.height;
    const reach = halfWidth + blend;
    const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - reach) / CELL_SIZE));
    const i1 = Math.min(VERTS - 1, Math.ceil((Math.max(ax, bx) + reach) / CELL_SIZE));
    const j0 = Math.max(0, Math.floor((Math.min(az, bz) - reach) / CELL_SIZE));
    const j1 = Math.min(VERTS - 1, Math.ceil((Math.max(az, bz) + reach) / CELL_SIZE));

    const dx = bx - ax, dz = bz - az;
    const len2 = dx * dx + dz * dz;

    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const px = i * CELL_SIZE, pz = j * CELL_SIZE;
        let t = 0;
        if (len2 > 1e-6) t = clamp(((px - ax) * dx + (pz - az) * dz) / len2, 0, 1);
        const d = Math.hypot(px - (ax + dx * t), pz - (az + dz * t));
        if (d > reach) continue;
        const w = d <= halfWidth ? 1 : smoothstep(reach, halfWidth, d);
        const idx = j * VERTS + i;
        H[idx] += (height - H[idx]) * w;
        // 整地した所は河川の水面も消す
        const ci = Math.min(CELLS - 1, i), cj = Math.min(CELLS - 1, j);
        if (w > 0.6) this.riverSurface[cj * CELLS + ci] = NaN;
      }
    }
  }

  // ---------------------------------------------------------------- 配色

  /** 標高と傾斜から地表色を返す（0..1 のRGB配列） */
  colorFor(h, slope) {
    let c;
    if (h < -160)      c = PALETTE.deep;
    else if (h < 0)    c = mix(PALETTE.deep, PALETTE.shallow, (h + 160) / 160);
    else if (h < 30)   c = mix(PALETTE.shallow, PALETTE.sand, h / 30);
    else if (h < 90)   c = mix(PALETTE.sand, PALETTE.grass, (h - 30) / 60);
    else if (h < 700)  c = mix(PALETTE.grass, PALETTE.forest, (h - 90) / 610);
    else if (h < 1500) c = mix(PALETTE.forest, PALETTE.rock, (h - 700) / 800);
    else if (h < 2300) c = mix(PALETTE.rock, PALETTE.scree, (h - 1500) / 800);
    else               c = mix(PALETTE.scree, PALETTE.snow, Math.min(1, (h - 2300) / 700));

    // 急斜面は岩肌に寄せる（草木が付かない表現）
    if (h > 40 && slope > 0.35) {
      c = mix(c, PALETTE.rock, Math.min(1, (slope - 0.35) / 0.45));
    }
    return c;
  }

  // ---------------------------------------------------------------- メッシュ

  /**
   * 地形メッシュ（フラットシェーディング・面ごとの色）と水面をまとめた Group を返す。
   */
  buildMesh() {
    const group = new THREE.Group();
    group.name = 'terrain';

    const quads = CELLS * CELLS;
    const triCount = quads * 2;
    const positions = new Float32Array(triCount * 3 * 3);
    const colors = new Float32Array(triCount * 3 * 3);

    const rng = makeRng(this.params.seed ^ 0x5f3a);
    let po = 0, co = 0;

    const pushTri = (ax, ay, az, bx, by, bz, cx, cy, cz, col) => {
      positions[po++] = ax; positions[po++] = ay; positions[po++] = az;
      positions[po++] = bx; positions[po++] = by; positions[po++] = bz;
      positions[po++] = cx; positions[po++] = cy; positions[po++] = cz;
      for (let k = 0; k < 3; k++) {
        colors[co++] = col[0]; colors[co++] = col[1]; colors[co++] = col[2];
      }
    };

    for (let j = 0; j < CELLS; j++) {
      for (let i = 0; i < CELLS; i++) {
        const x0 = i * CELL_SIZE, x1 = x0 + CELL_SIZE;
        const z0 = j * CELL_SIZE, z1 = z0 + CELL_SIZE;
        const h00 = this.vertexHeight(i, j);
        const h10 = this.vertexHeight(i + 1, j);
        const h01 = this.vertexHeight(i, j + 1);
        const h11 = this.vertexHeight(i + 1, j + 1);

        const avg = (h00 + h10 + h01 + h11) * 0.25;
        const dh = Math.max(Math.abs(h00 - h11), Math.abs(h10 - h01));
        const slope = Math.min(1, dh / CELL_SIZE * 2.2);

        // 面ごとにわずかな明度ゆらぎを入れてローポリ感を出す
        const base = this.colorFor(avg, slope);
        const t1 = 0.92 + rng() * 0.16;
        const t2 = 0.92 + rng() * 0.16;
        const cA = [base[0] * t1, base[1] * t1, base[2] * t1];
        const cB = [base[0] * t2, base[1] * t2, base[2] * t2];

        pushTri(x0, h00, z0, x0, h01, z1, x1, h11, z1, cA);
        pushTri(x0, h00, z0, x1, h11, z1, x1, h10, z0, cB);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    geo.computeBoundingSphere();

    const mat = new THREE.MeshLambertMaterial({
      vertexColors: true,
      flatShading: true,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'terrainSurface';
    mesh.userData.pickable = true;
    group.add(mesh);

    group.add(this._buildSkirt());
    group.add(this._buildSea());
    const rivers = this._buildRivers();
    if (rivers) group.add(rivers);

    this.mesh = mesh;
    return group;
  }

  /**
   * マップ外周の壁（スカート）。
   * これがないと遠景でマップが板のように浮いて見える。
   */
  _buildSkirt() {
    const BOTTOM = -1400;
    const quads = [];
    const edge = (i0, j0, i1, j1) => {
      const x0 = i0 * CELL_SIZE, z0 = j0 * CELL_SIZE;
      const x1 = i1 * CELL_SIZE, z1 = j1 * CELL_SIZE;
      const h0 = this.vertexHeight(i0, j0), h1 = this.vertexHeight(i1, j1);
      quads.push(
        x0, h0, z0, x0, BOTTOM, z0, x1, BOTTOM, z1,
        x0, h0, z0, x1, BOTTOM, z1, x1, h1, z1,
      );
    };
    for (let i = 0; i < CELLS; i++) {
      edge(i, 0, i + 1, 0);                 // 北
      edge(i, CELLS, i + 1, CELLS);         // 南
      edge(0, i, 0, i + 1);                 // 西
      edge(CELLS, i, CELLS, i + 1);         // 東
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(quads), 3));
    geo.computeVertexNormals();
    const mat = new THREE.MeshLambertMaterial({
      color: 0x2b2723, flatShading: true, side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'skirt';
    return mesh;
  }

  _buildSea() {
    const geo = new THREE.PlaneGeometry(MAP_SIZE * 1.6, MAP_SIZE * 1.6);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshLambertMaterial({
      color: 0x123a52,
      transparent: true,
      opacity: 0.86,
    });
    const sea = new THREE.Mesh(geo, mat);
    sea.position.set(MAP_SIZE / 2, SEA_LEVEL, MAP_SIZE / 2);
    sea.name = 'sea';
    return sea;
  }

  /**
   * 河川の水面。
   * セルごとの平板を並べると、斜めの区間で段差と隙間が出る。
   * 頂点ごとの水面高さ（周囲の河川セルの平均）を求め、隣接する面が
   * 角の高さを共有するようにして連続した帯にする。
   */
  _buildRivers() {
    const S = this.riverSurface;
    const cells = [];
    for (let j = 0; j < CELLS; j++) {
      for (let i = 0; i < CELLS; i++) {
        if (!isNaN(S[j * CELLS + i])) cells.push([i, j]);
      }
    }
    if (cells.length === 0) return null;

    // 頂点ごとの水面高さ
    const vh = new Float32Array(VERTS * VERTS).fill(NaN);
    for (let j = 0; j <= CELLS; j++) {
      for (let i = 0; i <= CELLS; i++) {
        let sum = 0, n = 0;
        for (let dj = -1; dj <= 0; dj++) {
          for (let di = -1; di <= 0; di++) {
            const ci = i + di, cj = j + dj;
            if (ci < 0 || cj < 0 || ci >= CELLS || cj >= CELLS) continue;
            const v = S[cj * CELLS + ci];
            if (!isNaN(v)) { sum += v; n++; }
          }
        }
        if (n > 0) vh[j * VERTS + i] = sum / n;
      }
    }

    const positions = new Float32Array(cells.length * 6 * 3);
    let po = 0;
    for (const [i, j] of cells) {
      const s = S[j * CELLS + i];
      const x0 = i * CELL_SIZE, x1 = x0 + CELL_SIZE;
      const z0 = j * CELL_SIZE, z1 = z0 + CELL_SIZE;
      const h00 = vh[j * VERTS + i], h10 = vh[j * VERTS + i + 1];
      const h01 = vh[(j + 1) * VERTS + i], h11 = vh[(j + 1) * VERTS + i + 1];
      const a = isNaN(h00) ? s : h00, b = isNaN(h10) ? s : h10;
      const c = isNaN(h01) ? s : h01, d = isNaN(h11) ? s : h11;
      const quad = [
        x0, a, z0, x0, c, z1, x1, d, z1,
        x0, a, z0, x1, d, z1, x1, b, z0,
      ];
      for (const v of quad) positions[po++] = v;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.computeVertexNormals();
    const mat = new THREE.MeshLambertMaterial({
      color: 0x2a6a84, transparent: true, opacity: 0.85,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'rivers';
    return mesh;
  }

  // ---------------------------------------------------------------- ミニマップ

  /** ミニマップ用の ImageData（CELLS x CELLS）を生成 */
  buildMinimapImage(ctx) {
    const img = ctx.createImageData(CELLS, CELLS);
    const d = img.data;
    // 斜光でレリーフを付ける（北西からの光）
    for (let j = 0; j < CELLS; j++) {
      for (let i = 0; i < CELLS; i++) {
        const h = this.vertexHeight(i, j);
        const hx = this.vertexHeight(i + 1, j) - this.vertexHeight(i - 1, j);
        const hz = this.vertexHeight(i, j + 1) - this.vertexHeight(i, j - 1);
        const slope = Math.min(1, Math.hypot(hx, hz) / (2 * CELL_SIZE) * 2.2);
        let c = this.colorFor(h, slope);

        if (!isNaN(this.riverSurface[j * CELLS + i])) c = [0.16, 0.42, 0.52];

        // 陰影
        const shade = clamp(1 + (-hx - hz) / 900, 0.55, 1.45);
        const k = (j * CELLS + i) * 4;
        d[k]     = clamp(c[0] * shade, 0, 1) * 255;
        d[k + 1] = clamp(c[1] * shade, 0, 1) * 255;
        d[k + 2] = clamp(c[2] * shade, 0, 1) * 255;
        d[k + 3] = 255;
      }
    }
    return img;
  }
}

/** 優先度フラッド用の最小ヒープ（型付き配列・要素は int32 のインデックス） */
class MinHeap {
  constructor(capacity) {
    this.keys = new Float64Array(capacity);
    this.vals = new Int32Array(capacity);
    this.size = 0;
  }
  push(key, val) {
    const K = this.keys, V = this.vals;
    let i = this.size++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (K[p] <= key) break;
      K[i] = K[p]; V[i] = V[p];
      i = p;
    }
    K[i] = key; V[i] = val;
  }
  pop() {
    const K = this.keys, V = this.vals;
    const top = V[0];
    const n = --this.size;
    if (n > 0) {
      const key = K[n], val = V[n];
      let i = 0;
      for (;;) {
        let c = i * 2 + 1;
        if (c >= n) break;
        if (c + 1 < n && K[c + 1] < K[c]) c++;
        if (K[c] >= key) break;
        K[i] = K[c]; V[i] = V[c];
        i = c;
      }
      K[i] = key; V[i] = val;
    }
    return top;
  }
}

/** 座標から 0..1 の決定的な擬似乱数を返す（河川の蛇行用） */
function hash2(i, j) {
  let h = Math.imul(i, 0x27d4eb2d) ^ Math.imul(j, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

function mix(a, b, t) {
  t = clamp(t, 0, 1);
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}
