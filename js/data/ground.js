// 地上・水上ユニットのデータ。仕様書 §8。
//
// radar.emits が true のユニットは電波を出しているため、
// **そのレーダー射程の1.5倍**の距離から相手の電波逆探知(RWR)に捕捉される（§30.3）。
// 沈黙(radarActive=false)させれば隠れられるが、その間はミサイルを誘導できない。
//
// 射程は**地図の縮尺に合わせてある**（§30.2）。地図は 51.2km 四方なので、
// 以前の値（飛行場60km・レーダーサイト70km）では**戦域を丸ごと覆って**しまい、
// 「敵の位置が分からない時間」が一度も生まれなかった。

import { WEAPONS } from './weapons.js';

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
 * | `targets` | 何を狙うか。`'air'`（既定）/ `'ground'` / `'both'`（§67） |
 *
 * **1ユニットに複数の兵装を積める**（`weapons: [...]`・§67.2）。
 * `weapon:` 1つだけの書き方も従来どおり通る。
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

  /**
   * 赤外線 SAM（§68.2）。**電波を出さないので逆探知に映らない。**
   *
   * SAM陣地は 52.5km から逆探知で見つかり、ARM で黙らせられる。
   * こちらは**見つける手が目視しかない** —— 近づいて初めて分かり、
   * 分かったときにはもう射程の中にいる。
   *
   * 代わりに射程は短く（6km）、**フレアが効く**。
   * 「低く飛べば SAM から隠れられる」の一方通行を、ここで崩す。
   */
  IRSAM: {
    id: 'IRSAM',
    name: '赤外線SAM',
    category: 'sam',
    hp: 110,
    static: true,
    radar: null,                 // 電波を出さない = 目視でしか見つからない
    weapon: { kind: 'irsam', minAlt: 60, maxAlt: 5000, range: 6000,
      reloadSeconds: 14, ammo: 10 },
    color: 0x59614f,
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
    /**
     * **短射程の機銃**（§67.3）。地上も低空も撃つ。
     *
     * これが無いあいだ、車両部隊は**何もできない部隊**だった。
     * COASTAL WALL の「沿岸レーダーを守る」は失敗条件として書いてあるのに、
     * **放置しても何も起きなかった**（実測: 6戦とも沿岸レーダーは無傷）。
     *
     * 射程は数百m。**近づかないと何もできない**ので、
     * 「着く前に倒す」という時間の勝負になる。
     */
    weapon: {
      kind: 'aaa', targets: 'both', range: 800, maxAlt: 500,
      muzzle: 700, spread: 1.2 * DEG, rps: 5, dmg: [1.2, 2.4], life: 1.6,
    },
    color: 0x5d5a45,
    size: 180,
  },

  /**
   * 破壊目標（§67.4）。**攻撃力を持たない、動かない施設。**
   *
   * 格納庫・倉庫・弾薬庫のたぐい。ミッションの「これを壊せ」に使う。
   * HP は **AGM(180) か BOMB(260) の直撃1発で落ちる**大きさ。
   * 機銃で削るには何度も入り直す必要がある。
   */
  DEPOT: {
    id: 'DEPOT',
    name: '補給施設',
    category: 'depot',
    hp: 150,
    static: true,
    radar: null,
    color: 0x6b6455,
    size: 200,
  },

  /**
   * 自走榴弾砲（§69.2）。**数km先の地上目標を山なりの弾で叩く。**
   *
   * 車両部隊より固く、**放っておくと味方の施設が壊される時限爆弾**になる。
   * 対空は車両部隊と同じ短射程の機銃だけなので、上から叩くぶんには弱い。
   *
   * 榴弾は `Bullet` に重力を入れて撃つ（§69.2）。
   * 発射角は「低いほうの解」を使う —— 高いほうの解は放物線が立派になる代わりに、
   * 飛翔時間が70秒を超えて**撃ったことが分からない兵器**になる。
   */
  ARTILLERY: {
    id: 'ARTILLERY',
    name: '自走榴弾砲',
    category: 'ground',
    hp: 200,
    static: false,
    speed: 9,
    radar: null,
    weapons: [
      // **拡散は締める。** 低い発射角では、仰角のわずかな誤差が
      // 着弾距離の大きな誤差になる（0.8°で射程誤差187m・当たり半径は50m）。
      // 実測では30発中2発しか当たらなかった。
      { kind: 'howitzer', targets: 'ground', range: 4500,
        muzzle: 260, spread: 0.25 * DEG, reloadSeconds: 8, dmg: [55, 70], life: 40 },
      // 対空は車両部隊相当。近づかないと何もできない
      { kind: 'aaa', targets: 'both', range: 800, maxAlt: 500,
        muzzle: 700, spread: 1.2 * DEG, rps: 5, dmg: [1.2, 2.4], life: 1.6 },
    ],
    color: 0x54503f,
    size: 200,
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

/**
 * そのユニットが積んでいる兵装。**1つでも複数でも同じ形で返す**（§67.2）。
 *
 * `weapon:` 1つだけの書き方が既存データの全部なので、そちらを壊さない。
 * `sim/ground.js` と `ai/pilot.js`（弾幕の上を取る判断）が同じものを見るように、
 * データ側に置いてある。
 */
/**
 * SAM搭載艦船（§69.1）。**SAMと近接防空を1隻で持つ。**
 *
 * 「1ユニットに複数の兵装」（§67.2）が最初に効く相手。
 * まとめて1つの兵装にすると、**SAMを撃ったせいで機銃が止まる**。
 *
 * レーダーを出しているので **ARM で黙らせられる** ——
 * 黙らせてから近づく、という手順が成立する。
 */
GROUND_TYPES.SAMSHIP = {
  id: 'SAMSHIP',
  name: 'ミサイル艦',
  category: 'ship',
  hp: 380,
  static: false,
  speed: 8,
  radar: { range: 38000, emits: true, canSilence: true },
  weapons: [
    { kind: 'sam', minAlt: 150, maxAlt: Infinity, reloadSeconds: 16, ammo: 12 },
    { kind: 'aaa', range: 4500, maxAlt: 2500,
      muzzle: 1000, spread: 0.75 * DEG, rps: 30, dmg: [2.2, 4.0], life: 4.8 },
  ],
  color: 0x455263,
  size: 420,
};

/**
 * 空母（§69.3）。**海に浮かぶ飛行場。**
 *
 * 中身は飛行場（`sim/airbase.js`）そのままで、違うのは2つだけ ——
 * **滑走路を平坦化しない**（海面はもともと平ら）と、**高度が0**。
 * 発艦・着艦・整備・増援は陸の飛行場と同じ仕組みが動く。
 *
 * **まずは定点**（`speed: 0`）。動かすと着艦進入中の機体が
 * 動く目標を追うことになるので、必要になってから測って決める。
 */
GROUND_TYPES.CARRIER = {
  id: 'CARRIER',
  name: '空母',
  category: 'carrier',
  hp: 450,
  static: true,
  speed: 0,
  radar: { range: 32000, emits: true, canSilence: true },
  // 近接防空。艦船と同じ密度
  weapon: {
    kind: 'aaa', range: 4500, maxAlt: 2500,
    muzzle: 1000, spread: 0.75 * DEG, rps: 30, dmg: [2.2, 4.0], life: 4.8,
  },
  color: 0x4d5560,
  size: 800,
};

export function weaponsOf(spec) {
  if (!spec) return [];
  if (Array.isArray(spec.weapons)) return spec.weapons;
  return spec.weapon ? [spec.weapon] : [];
}

/**
 * そのユニットが**空へ向けて持つ、いちばん長い射程**(m)。§72.3。
 *
 * **「どの種別か」ではなく「何を積んでいるか」で見る。** 司令官AIは長らく
 * `unit.kind === 'sam'` で危険を測っていたが、それだと
 * **ミサイル艦（`category: 'ship'` だが SAM を持つ）が漏れる**し、
 * 逆に赤外線SAM（6km）を SAM陣地（19km）と同じ危険として扱ってしまう。
 * 同じ取り違えは §42〜§44 でも踏んでいる（`[[feedback-air-rules-on-ground-weapons]]`）。
 *
 * 機銃（`aaa`）は含めない —— 射程3km は交戦の距離であって、
 * 「近づく前に迂回するか」を決める距離ではない。
 */
export function samRangeOf(spec) {
  let best = 0;
  for (const w of weaponsOf(spec)) {
    const id = SAM_WEAPON_OF[w.kind];
    if (!id) continue;
    const r = (WEAPONS[id] || {}).range || 0;
    if (r > best) best = r;
  }
  return best;
}

/** 地上の対空ミサイル座の種別 → 実際に撃つ弾（`sim/ground.js` と同じ対応） */
const SAM_WEAPON_OF = { sam: 'SAM-M', irsam: 'IR-SAM' };

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
  carrier: '空母',
  ground: '地上部隊',
  depot: '施設',
  ship: '艦船',
};
