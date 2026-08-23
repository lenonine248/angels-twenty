// 地上・水上ユニットのデータ。仕様書 §8。
//
// radar.emits が true のユニットは電波を出しているため、
// **そのレーダー射程の1.5倍**の距離から相手の電波逆探知(RWR)に捕捉される（§30.3）。
// 沈黙(radarActive=false)させれば隠れられるが、その間はミサイルを誘導できない。
//
// 射程は**地図の縮尺に合わせてある**（§30.2）。地図は 51.2km 四方なので、
// 以前の値（飛行場60km・レーダーサイト70km）では**戦域を丸ごと覆って**しまい、
// 「敵の位置が分からない時間」が一度も生まれなかった。

/**
 * 弾幕の砲（§51）。**実体弾を撃つ**（`sim/bullet.js` の Bullet を流用）。
 *
 * `range` と `maxAlt` は**交戦の判断**であって当たり判定ではない。
 * 機銃が `GUN_MAX_ENGAGE` と発射しきい値で「撃つかどうか」を決めるのと同じ位置づけ。
 * 当たるかどうかは弾の側が決める。
 *
 * **射高だけは二値のまま残す。** 弾に重力を入れていないので、
 * 高度で当たらなくなる仕組みが物理から出てこない。
 * それに「射高より上へ逃げる」は §8 からの設計の柱で、
 * チュートリアルでもステージの進入高度でもそこを前提にしている。
 * **境界は二値、中は幾何** ── これが実体化で変えたことの全部。
 *
 * | | 意味 |
 * |---|---|
 * | `muzzle` | 初速(m/s)。飛翔時間が伸びるほど偏差の誤差が効く |
 * | `spread` | 拡散角(rad)。据え付けの砲なので機体の機銃より締まっている |
 * | `rps` | 毎秒発射数 |
 * | `dmg` | 1発あたり [下限, 上限] |
 * | `life` | 弾の寿命(秒)。`初速 × 寿命` が実際に届く距離になる |
 */
const DEG = Math.PI / 180;

export const GROUND_TYPES = {
  RADAR: {
    id: 'RADAR',
    name: 'レーダーサイト',
    category: 'radar',
    hp: 120,
    static: true,
    radar: { range: 45000, emits: true, canSilence: true },
    color: 0x8b8578,
    size: 220,
  },

  SAM: {
    id: 'SAM',
    name: 'SAM陣地',
    category: 'sam',
    hp: 150,
    static: true,
    radar: { range: 35000, emits: true, canSilence: true },
    // 弾は WEAPONS['SAM-M']。射程は高度で伸びるので、ここでは交戦を許可する上限だけ持つ
    // 射高の上限は設けない。高空にいれば遠くから狙われるが、
    // 逆に射程ぎりぎりから速度を乗せて撃ち下ろす戦い方も成立する。
    weapon: { kind: 'sam', minAlt: 200, maxAlt: Infinity, reloadSeconds: 20, ammo: 8 },
    color: 0x6f7358,
    size: 200,
  },

  AAA: {
    id: 'AAA',
    name: '対空砲',
    category: 'aaa',
    hp: 90,
    static: true,
    radar: null,                 // 電波を出さない = 目視でしか見つからない
    // 軽対空砲。数は撃つが1発は軽い
    weapon: {
      kind: 'aaa', range: 3000, maxAlt: 1500,
      muzzle: 900, spread: 0.9 * DEG, rps: 22, dmg: [2.2, 4.0], life: 3.6,
    },
    color: 0x6b6455,
    size: 150,
  },

  AIRBASE: {
    id: 'AIRBASE',
    name: '飛行場',
    category: 'airbase',
    hp: 400,
    static: true,
    radar: { range: 30000, emits: true, canSilence: false },
    // 飛行場自体も近接防空を持つ。無防備だと低空侵入が一方的になる。
    weapon: {
      kind: 'aaa', range: 3500, maxAlt: 1800,
      muzzle: 950, spread: 0.85 * DEG, rps: 24, dmg: [2.2, 4.0], life: 3.9,
    },
    color: 0x5a5a52,
    size: 900,
  },

  CONVOY: {
    id: 'CONVOY',
    name: '車両部隊',
    category: 'ground',
    hp: 110,
    static: false,               // 移動するため記憶の対象外
    speed: 12,                   // m/s
    radar: null,
    color: 0x5d5a45,
    size: 180,
  },

  SHIP: {
    id: 'SHIP',
    name: '艦船',
    category: 'ship',
    hp: 320,
    static: false,
    speed: 9,
    radar: { range: 35000, emits: true, canSilence: true },
    // 近接防空。いちばん密で、射程も射高も広い
    weapon: {
      kind: 'aaa', range: 4500, maxAlt: 2500,
      muzzle: 1000, spread: 0.75 * DEG, rps: 30, dmg: [2.2, 4.0], life: 4.8,
    },
    color: 0x4a5560,
    size: 400,
  },
};

export function getGroundType(id) {
  const t = GROUND_TYPES[id];
  if (!t) throw new Error(`unknown ground type: ${id}`);
  return t;
}

/** 識別段階1（種別まで判明）で表示するラベル */
export const CATEGORY_LABEL = {
  fighter: '戦闘機',
  bomber: '爆撃機',
  awacs: '早期警戒機',
  radar: 'レーダー',
  sam: 'SAM',
  aaa: '対空砲',
  airbase: '飛行場',
  ground: '地上部隊',
  ship: '艦船',
};
