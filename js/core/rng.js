// シード付き乱数とノイズ。
// ステージ地形は「固定シード＋パラメータ」で毎回同じ形になる必要があるため、
// Math.random() は一切使わずここを経由する。

/** mulberry32: 高速・十分な質のシード付きPRNG */
export function makeRng(seed) {
  let a = seed >>> 0;
  const rng = function () {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  rng.range = (min, max) => min + rng() * (max - min);
  rng.int = (min, max) => Math.floor(min + rng() * (max - min + 1));
  rng.pick = (arr) => arr[Math.floor(rng() * arr.length)];
  return rng;
}

/** 5次のスムーズステップ (Perlin改良版と同じ) */
function fade(t) {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/**
 * 値ノイズ（2D）。
 * 256x256 の格子に乱数を敷き、格子間を補間する。
 * Perlinより安価で、ローポリ地形には十分。
 */
export function makeValueNoise2D(rng) {
  const SIZE = 256;
  const MASK = SIZE - 1;
  const table = new Float32Array(SIZE * SIZE);
  for (let i = 0; i < table.length; i++) table[i] = rng() * 2 - 1;

  return function noise(x, y) {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const u = fade(xf), v = fade(yf);

    const x0 = xi & MASK, x1 = (xi + 1) & MASK;
    const y0 = (yi & MASK) * SIZE, y1 = ((yi + 1) & MASK) * SIZE;

    const n00 = table[y0 + x0], n10 = table[y0 + x1];
    const n01 = table[y1 + x0], n11 = table[y1 + x1];

    const a = n00 + u * (n10 - n00);
    const b = n01 + u * (n11 - n01);
    return a + v * (b - a);
  };
}

/** fBm: オクターブを重ねた分数ブラウン運動。緩やかな起伏を作る。 */
export function fbm(noise, x, y, octaves = 5, lacunarity = 2.0, gain = 0.5) {
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * noise(x * freq, y * freq);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

/** リッジノイズ: 尾根の立った山岳地形を作る。0..1 を返す。 */
export function ridge(noise, x, y, octaves = 5, lacunarity = 2.0, gain = 0.5) {
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < octaves; i++) {
    const n = 1 - Math.abs(noise(x * freq, y * freq));
    sum += amp * n * n;
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;
/** smoothstep: edge0..edge1 を 0..1 に滑らかにマップ */
export function smoothstep(edge0, edge1, x) {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}
