// 大気モデル。高度による性能変化を一箇所に集約する。
//
// 設計意図（仕様書 §2.1）:
//   ジェットエンジンは高度が上がるほど吸い込む空気が薄くなり推力が落ちる。
//   翼も薄い空気では揚力を得にくく、旋回率が落ちる。
//   一方でロケットモーターは空気を必要としないため推力は落ちず、
//   むしろ空気抵抗が減って射程が伸びる。
//
//   → 高空は「遠くまで撃てるが鈍重」、低空は「機敏だが近距離戦」になる。
//     どちらが強いかではなく、どちらの戦い方を選ぶかの問題にする。

/** 大気の尺度高さ(m)。密度が 1/e になる高度。 */
const SCALE_HEIGHT = 9000;

/** 海面を1とした空気密度比 */
export function densityRatio(alt) {
  return Math.exp(-Math.max(0, alt) / SCALE_HEIGHT);
}

/**
 * ジェットエンジンの推力係数。
 * 密度のほぼ比例で落ちる（0m:100% / 6,000m:56% / 12,000m:32%）。
 */
export function thrustFactor(alt) {
  return Math.pow(densityRatio(alt), 0.85);
}

/**
 * 旋回率の係数。
 * 揚力は動圧に比例するため、推力ほどではないが確実に落ちる
 * （0m:100% / 6,000m:71% / 12,000m:51%）。
 */
export function turnFactor(alt) {
  return Math.sqrt(densityRatio(alt));
}

/**
 * 水平飛行時の最大速度の係数。
 * 高空は抵抗が減るぶん真対気速度の上限はわずかに上がる（最大+11%）。
 * 「高空が鈍い」のは最高速ではなく、そこへ到達する加速と旋回の話。
 */
export function maxSpeedFactor(alt) {
  return 1 + 0.15 * (1 - densityRatio(alt));
}

/**
 * ミサイルの空気抵抗の係数。
 * 完全に密度比例にすると高空の射程が伸びすぎるので下限を残す
 * （0m:100% / 6,000m:68% / 12,000m:52%）。
 */
export function missileDragFactor(alt) {
  return 0.35 + 0.65 * densityRatio(alt);
}

/**
 * ミサイルの実効射程(m)。
 *
 * 慣性飛行の距離は抵抗に反比例する。表記射程は海面基準なので、
 * 抵抗係数 f のとき range * (0.25 + 0.75/f) が実効射程になる
 * （f=1 で表記どおり、12,000m で約1.7倍）。
 *
 * @param {number} avgAlt 発射点と目標の平均高度。撃ち下ろしでは
 *   終末が濃い空気になるため、この平均を使うと実挙動とよく一致する。
 */
export function effectiveMissileRange(weapon, avgAlt) {
  const mult = 0.25 + 0.75 / missileDragFactor(avgAlt);   // 海面で 1.0
  // altGain は「高度による射程の伸びをどれだけ受けるか」。
  // 1 なら理論どおり、0 なら高度に関係なく表記射程のまま。
  // 兵装ごとに運用高度の役割を分けるための係数（AGM は低め）。
  const gain = weapon.altGain ?? 1;
  return weapon.range * (1 + (mult - 1) * gain);
}

/** UI表示用: 高度の性能サマリ */
export function altitudeProfile(alt) {
  return {
    thrust: thrustFactor(alt),
    turn: turnFactor(alt),
    missileRange: 0.25 + 0.75 / missileDragFactor(alt),   // altGain=1 のときの倍率
  };
}
