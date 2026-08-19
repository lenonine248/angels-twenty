// 地上・水上ユニットのデータ。仕様書 §8。
//
// radar.emits が true のユニットは電波を出しているため、
// 相手の電波逆探知(RWR)に約60kmから捕捉される。
// 沈黙(radarActive=false)させれば隠れられるが、その間はミサイルを誘導できない。

export const GROUND_TYPES = {
  RADAR: {
    id: 'RADAR',
    name: 'レーダーサイト',
    category: 'radar',
    hp: 120,
    static: true,
    radar: { range: 70000, emits: true, canSilence: true },
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
    weapon: { kind: 'aaa', range: 3000, maxAlt: 1500, dps: 11 },
    color: 0x6b6455,
    size: 150,
  },

  AIRBASE: {
    id: 'AIRBASE',
    name: '飛行場',
    category: 'airbase',
    hp: 400,
    static: true,
    radar: { range: 60000, emits: true, canSilence: false },
    // 飛行場自体も近接防空を持つ。無防備だと低空侵入が一方的になる。
    weapon: { kind: 'aaa', range: 3500, maxAlt: 1800, dps: 12 },
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
    radar: { range: 45000, emits: true, canSilence: true },
    weapon: { kind: 'aaa', range: 4500, maxAlt: 2500, dps: 14 },   // 近接防空
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
