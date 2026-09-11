// 「何が何を通すか」を1か所で決める。仕様書 §88.3。
//
// 視線の判定は、これまで地形しか見ていなかったので
// `terrain.hasLineOfSight` を各所から直接呼んでいた。**雲が入ると分岐が増える**
// —— 光は遮られ、電波は弱るだけ、逆探知は素通し。
// 呼び出し側ごとに書くと、§80.3 の扇のように**同じ規則が3か所へ散る。**
//
// ここを通す。呼ぶ側は「どのチャンネルで見ているか」だけ言えばよい。

/**
 * 光学・赤外線の視線（§88.3）。**地形でも雲でも切れる。**
 *
 * 使うのは、目視・対空砲の照準・赤外線SAMの捕捉・赤外線シーカーの追尾。
 * どれも「自分の目で見る」もので、探知の輪には頼っていない（§68.2）。
 */
export function opticalSight(world, a, b, clearance = 8, step = 300) {
  if (!world.terrain.hasLineOfSight(a, b, clearance, step)) return false;
  return !(world.clouds && world.clouds.blocks(a, b));
}

/**
 * 電波の視線（§88.3）。**地形では切れるが、雲では切れない。**
 *
 * 弱るだけなので、通るかどうかは地形だけで決まる。
 * どれだけ弱ったかは `radarReach` で別に見る。
 */
export function radarSight(world, a, b, clearance = 8, step = 300) {
  return world.terrain.hasLineOfSight(a, b, clearance, step);
}

/**
 * 雲を通ったぶんだけ縮めた実効射程（§88.3.1）。
 *
 * 探知にも、セミアクティブの照射継続にも同じものを使う ——
 * **「見つけられる距離」と「誘導し続けられる距離」がずれると、
 * 掴んだのに誘導できない（またはその逆）が起きる。**
 */
export function radarReach(world, range, a, b) {
  if (!range || !world.clouds || !world.clouds.active) return range;
  return range * world.clouds.radarFactor(a, b);
}
