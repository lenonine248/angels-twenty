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
/**
 * 地上から地上を見る目の高さ(m)（§103）。**両端をこれだけ持ち上げて視線を引く。**
 *
 * 地上ユニットの位置は地表ちょうどなので、そのまま `opticalSight` に渡すと
 * 両端が地面に接した線になり、**わずかな起伏でも切れる**（実測: 600m 先でも 3% しか見えない）。
 * 砲口の高さ（`sim/ground.js` の MUZZLE_HEIGHT）と同じ 25m を取る —— 撃てる線と見える線を揃える。
 * 25m で 600m 先 94%・2.5km 44%・8km 18%（丘陵の地形・ランダムな300組）。
 */
export const GROUND_EYE = 25;

const _ga = { x: 0, y: 0, z: 0 };
const _gb = { x: 0, y: 0, z: 0 };

/** 地上から地上への視線（§103）。両端を GROUND_EYE だけ上げ、あとは `opticalSight` と同じ（雲でも切れる） */
export function groundSight(world, a, b, clearance = 8, step = 200) {
  _ga.x = a.x; _ga.y = a.y + GROUND_EYE; _ga.z = a.z;
  _gb.x = b.x; _gb.y = b.y + GROUND_EYE; _gb.z = b.z;
  return opticalSight(world, _ga, _gb, clearance, step);
}

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
