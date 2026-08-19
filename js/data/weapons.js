// 兵装データ。仕様書 §6.2 / §6.3。
//
// コストは「ステージ全体の共通プール」から引かれる。
// ブリーフィングの初期搭載も、戦闘中の帰投再装備も同じプールを消費する。
//
// range は「海面高度で撃った場合」の射程。
// ロケットモーターは高空ほど空気抵抗が減るため実効射程が伸びる
// （core/atmosphere.js の effectiveMissileRange 参照。12,000m で約1.7倍）。
// 高度そのものが射程を買う手段になるよう、表記射程は低めに設定してある。

export const WEAPONS = {
  'AAM-S': {
    id: 'AAM-S',
    name: '短距離AAM',
    kind: 'aam',              // 空対空
    guidance: 'ir',           // 赤外線 → フレアに弱い
    slots: 1,
    cost: 0,
    range: 7000,
    speed: 850,               // m/s
    turnRate: 55,             // deg/s シーカーの追従機動
    fireAndForget: true,
    decoyResist: 0.25,        // 0=騙されやすい 1=騙されない
    damage: 200,
    rearmSeconds: 20,
    desc: '高機動・撃ちっぱなし。フレアに弱い',
  },

  'AAM-M': {
    id: 'AAM-M',
    name: '中距離AAM',
    kind: 'aam',
    guidance: 'sarh',         // セミアクティブ → 発射機がレーダー扇内に目標を保持し続ける必要
    slots: 1,
    cost: 2,
    range: 20000,
    speed: 1100,
    turnRate: 28,
    fireAndForget: false,     // ここが AAM-A との決定的な差
    decoyResist: 0.35,
    damage: 200,
    rearmSeconds: 20,
    desc: '命中まで目標をレーダー扇内に保持し続ける必要がある。その間こちらも逃げられない',
  },

  'AAM-A': {
    id: 'AAM-A',
    name: 'アクティブAAM',
    kind: 'aam',
    guidance: 'arh',          // アクティブレーダー → 撃ちっぱなし
    slots: 2,
    cost: 6,
    range: 20000,
    speed: 1100,
    turnRate: 34,
    fireAndForget: true,
    decoyResist: 0.85,        // デコイに騙されにくい
    damage: 200,
    rearmSeconds: 30,
    desc: '撃った瞬間に離脱できる。デコイに騙されにくい信頼の一発',
  },

  'AGM': {
    id: 'AGM',
    name: '空対地ミサイル',
    kind: 'agm',
    guidance: 'command',
    slots: 2,
    cost: 5,
    range: 14000,
    // 速度は「表記射程まで実際に届くか」で決まる。320m/s では慣性飛行で失速し、
    // 低空だと 11.7km しか飛べず、発射エンベロープ(12.7km)に届かなかった。
    speed: 420,
    turnRate: 20,
    fireAndForget: true,
    decoyResist: 1,
    damage: 180,
    blastRadius: 60,          // 至近に落ちても効く
    maxLaunchAlt: 6000,       // 低・中高度向け。高空からは撃てない
    rearmSeconds: 25,
    desc: '低〜中高度向けの対地ミサイル。高度6,000mより上からは撃てない',
  },

  'ARM': {
    id: 'ARM',
    name: '対レーダーミサイル',
    kind: 'agm',
    guidance: 'arm',          // 稼働中のレーダーにのみ誘導。沈黙されると外れる
    slots: 2,
    cost: 6,
    range: 22000,
    // 同上。520m/s では高度5,000mからの実飛翔が 22.2km しかなく、
    // SAM の外から撃つと目標に届く前に失速していた。
    speed: 700,
    turnRate: 18,
    fireAndForget: true,
    decoyResist: 1,
    damage: 160,
    // 沈黙されると慣性で最後の座標へ飛ぶため、当たり方は「至近弾」が基本になる。
    // 弾頭半径が小さいと、外した ARM が何の役にも立たない高価な兵装になってしまう。
    blastRadius: 120,
    minLaunchAlt: 2500,       // 高高度向け。低空からでは電波を捉えきれない
    rearmSeconds: 25,
    desc: '高高度向け。稼働中のレーダーに誘導。沈黙されると外れる',
  },

  'BOMB': {
    id: 'BOMB',
    name: '無誘導爆弾',
    kind: 'bomb',
    guidance: 'none',
    slots: 1,
    cost: 0,
    range: 0,                 // 投下。低空・低速が必要
    speed: 0,
    // 高高度からでも投下できるが、高いほど散布界が広がって当たらなくなる
    dropAltMax: 8000,
    dispersionPerKm: 1.4,     // 投下高度1kmあたりの初速のばらつき(m/s)
    damage: 260,
    blastRadius: 130,
    rearmSeconds: 15,
    desc: '低空からの投下が必要。安価で威力大',
  },

  'TANK': {
    id: 'TANK',
    name: '増槽',
    kind: 'support',
    guidance: 'none',
    slots: 1,
    cost: 0,
    fuelBonus: 0.40,          // 燃料 +40%
    droppable: true,
    rearmSeconds: 15,
    desc: '燃料+40%。投棄すると機動性が戻る',
  },
};

/**
 * SAMの弾。地上発射専用（プレイヤーの搭載リストには載らない）。
 *
 * 地表の濃い空気から撃ち上げるため低空目標には不利だが、
 * 強力なブースターで一気に加速し、上昇するほど抵抗が減って有利になる。
 * → 高空にいる機体がSAM圏内に入ると非常に危険、という関係を作る。
 */
WEAPONS['SAM-M'] = {
  id: 'SAM-M',
  name: 'SAMミサイル',
  kind: 'sam',
  guidance: 'sarh',           // 発射母体のレーダーが照射し続ける必要がある
  slots: 0,
  cost: 0,
  range: 19000,
  speed: 1250,                // 強力なブースター
  turnRate: 24,
  fireAndForget: false,
  decoyResist: 0.55,
  damage: 220,
  minAlt: 200,
  maxAlt: Infinity,           // 射高の上限なし（高空ほど遠くから狙われる）
  reloadSeconds: 20,
  desc: '地上発射。高空の目標ほど有利になる',
};

export function getWeapon(id) {
  const w = WEAPONS[id];
  if (!w) throw new Error(`unknown weapon: ${id}`);
  return w;
}

/** 搭載リスト（兵装IDの配列）が占めるスロット数 */
export function loadoutSlots(loadout) {
  return loadout.reduce((n, id) => n + getWeapon(id).slots, 0);
}

/** 搭載リストの合計コスト */
export function loadoutCost(loadout) {
  return loadout.reduce((n, id) => n + getWeapon(id).cost, 0);
}

/** 増槽による燃料ボーナス倍率 */
export function loadoutFuelBonus(loadout) {
  return 1 + loadout.reduce((n, id) => n + (getWeapon(id).fuelBonus || 0), 0);
}

/** 標準搭載パターン（ブリーフィング初期値／P8で使う） */
export const PRESETS = {
  'F-1': {
    '制空':     ['AAM-M', 'AAM-M', 'AAM-S', 'AAM-S'],
    '制空(高)': ['AAM-A', 'AAM-A'],
    '長距離':   ['AAM-M', 'AAM-S', 'AAM-S', 'TANK'],
  },
  'F-2': {
    '万能':   ['AAM-M', 'AAM-S', 'AAM-S', 'AGM'],
    '対地':   ['AGM', 'AGM', 'AAM-S'],
    'SEAD':   ['ARM', 'ARM', 'AAM-S'],
  },
  'A-3': {
    '爆装':   ['BOMB', 'BOMB', 'BOMB', 'BOMB', 'AAM-S', 'AAM-S'],
    '対地':   ['AGM', 'AGM', 'AGM', 'AAM-S'],
    'SEAD':   ['ARM', 'ARM', 'AGM', 'AAM-S'],
  },
};
