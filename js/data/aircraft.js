// 機体データ。すべてメートル・秒・度が基準。
// 数値は仕様書 §5.1 の値。バランス調整はここだけを触れば済むようにしてある。

const DEG = Math.PI / 180;

export const AIRCRAFT_TYPES = {
  'F-1': {
    id: 'F-1',
    name: 'F-1 制空戦闘機',
    role: '制空',
    maxSpeed: 320,        // m/s
    cruiseSpeed: 220,
    minSpeed: 120,
    accel: 14,            // m/s^2
    // 旋回率は**巡航速度での値**。ここから実効Gが決まる（G = ω·V/g）。
    // §34.2 でミサイルを実機のGに合わせたので、機体も実機寄りに上げた
    // （F-1 で 5.5G → 8.0G）。**速度は変えていない**ので、
    // 進出距離や到達時間といったステージの寸法には影響しない。
    turnRate: 20,         // deg/s（巡航速度時）＝ 7.8G
    climbRate: 180,       // m/s
    ceiling: 13500,
    hp: 90,
    hardpoints: 4,
    // §61.3 で 40km → 30km。地図が 51.2km 四方なので、40km は
    // **中心に立てば1機で全図を覆っていた**（四隅まで36.2km）。
    // 逆探知は射程×1.5 なので 60km ＝ どこに居ても見つかる状態で、
    // 電波管制が位置取りの判断になっていなかった。
    radarRange: 30000,
    radarFovH: 55,        // 索敵: 機首から左右±55°。細く遠く
    radarFovV: 30,
    // ロック（AAM-M誘導中）の扇。索敵より狭い（§28.7）。
    // クランク角が 48° → 24° になり、掴んだまま逃げる余地が減る。
    //
    // 仕様では ±25° としたが、測ったら**扇の幅はほとんど効かなかった**
    // （±25/±40/±60 で AAM-M の命中率が 0.09/0.15/0.13、誘導喪失は全部18%）。
    // 効いていたのは扇ではなく、**発射の可否を索敵の扇で見ていたこと**だった。
    // ロックの扇の外へ撃てるので、発射した瞬間に誘導が切れていた。
    // そちらを直したうえで、クランクを浅くする効果だけを残す値にしてある。
    radarLockFovH: 40,
    radarLockFovV: 20,
    visualRange: 8000,
    fuelSeconds: 720,     // 巡航12分
    // 機銃: 弾数は少ないが**弾が速い**。動く目標に当てられる（一撃離脱向き）
    gunRounds: 380,
    gunSpec: {
      muzzleSpeed: 1000, dispersion: 1.3 * DEG,
      airDmg: [1.4, 3.0], groundDmg: [1.0, 2.2],
    },
    // 対抗手段はミサイル搭載量に対して多すぎたので半減（A-3のみ据え置き）
    flares: 4,
    // **チャフは束で撒くもの**（§46）。実機は数十発を積む。
    // 1枚あたりの効きは下げてある（`SCREEN_CHANCE_PER_CLOUD`）ので、
    // 枚数を増やしても「1機あたりミサイル1発ぶん」という総量は変えていない。
    chaff: 14,
    // 見た目
    color: 0x8fa4bb,
    shape: { length: 1.0, span: 0.62, sweep: 0.30, fatness: 0.85, twinTail: true },
  },

  'F-2': {
    id: 'F-2',
    name: 'F-2 マルチロール',
    role: '万能',
    // **代償は速さ**（§61.4）。A-3 に近いところまで落とす —— 追いつけないし、
    // 離脱もできない。その代わり目視外では3機で一番強い、という形にする。
    maxSpeed: 260,
    cruiseSpeed: 190,
    minSpeed: 110,
    accel: 11,
    // **旋回は削らない。** 一度 16 まで落として測ったら、護衛で
    // 被撃墜 83%・損失 0.50 → 1.67 になった（§61.5）。
    // **このゲームでは旋回がそのまま生存**で、クランク（目視外の話）では
    // 埋め合わせにならない。実際、落としていたのは6回中5回が AAM-S ——
    // 近距離の赤外線弾で、電波の強みが一切届かない場面だった。
    turnRate: 18,
    climbRate: 140,
    ceiling: 12500,
    // hp は 110 のまま。100 にして測ったが**数字が1つも動かなかった**
    // （§61.5）—— 当たれば 100 でも 110 でも落ちる。
    hp: 110,
    hardpoints: 5,
    // **3機でいちばん広く見て、いちばん遠くから見つかる**（§61.3）。
    // 掃引面積は F-1 の 1.9倍。逆探知される距離は 51km で最長。
    // 「見つける役だが黙っていられない」という形にしてある。
    radarRange: 34000,
    radarFovH: 80,        // 広く浅く。捜索の面積で稼ぐ
    radarFovV: 30,
    // **ここは 40 のまま。60 にする案は測って捨てた**（§61.5）。
    // クランク角が 24° → 36° に広がれば目視外で有利になるはず、と考えたが、
    // 実際には**本来なら誘導を諦めて離脱する角度でも粘り続ける**ようになり、
    // 護衛で F-2 の被撃墜が 17% → 83%、損失が 0.50 → 1.89 に悪化した。
    // **扇を広げることは「安全に撃てる」ではなく「抜けられない」だった。**
    radarLockFovH: 40,
    radarLockFovV: 20,
    visualRange: 8000,
    fuelSeconds: 900,     // 15分
    // 機銃: すべて中庸。弾速も拡散も両者の間で、一発が軽い
    gunRounds: 550,
    gunSpec: {
      muzzleSpeed: 850, dispersion: 1.7 * DEG,
      airDmg: [1.0, 2.2], groundDmg: [1.0, 2.2],
    },
    // **チャフを 14 → 30 にしてみたが、数字が1つも動かなかった**（§61.5）。
    // 実測の消費は最大 7.0発で、14 でも余っている。**枚数は縛りではない。**
    // 増やしても効かない値を「個性」として置かない。
    flares: 4,
    chaff: 14,
    color: 0x93a08c,
    shape: { length: 0.96, span: 0.70, sweep: 0.22, fatness: 1.0, twinTail: false },
  },

  'A-3': {
    id: 'A-3',
    name: 'A-3 攻撃機',
    role: '対地',
    maxSpeed: 240,
    cruiseSpeed: 180,
    minSpeed: 95,
    accel: 8,
    turnRate: 16,         // ＝ 5.7G
    climbRate: 90,
    ceiling: 10000,
    // **アフターバーナーを持たない**（§39）。
    //
    // 「速度は出ないが、対抗手段が多く燃費が良い」という役割にする。
    // AB は燃料を3倍消すので、無いこと自体が長時間の作戦を支える
    // （対地任務は交戦より進出と待機に時間がかかる）。
    // 巡航速度は変わらない。失うのは**一時的に速く逃げる手段**だけ。
    noAfterburner: true,
    hp: 160,
    hardpoints: 6,
    radarRange: 22000,    // §61.3
    radarFovH: 50,
    radarFovV: 30,
    radarLockFovH: 38,
    radarLockFovV: 20,
    visualRange: 8000,
    fuelSeconds: 1080,    // 18分
    // 機銃: 弾は遅いが拡散が細かく、弾数が多い。対地掃射に向く。
    // 弾が遅い＝飛翔時間が長い＝旋回する敵への偏差が破綻するので、対空は苦手。
    // 「対地らしさ」は弾数(900発=36秒)と低速による滞空で作る（§22.2.3 の注記）。
    gunRounds: 900,
    gunSpec: {
      muzzleSpeed: 700, dispersion: 1.0 * DEG,
      airDmg: [1.2, 2.6], groundDmg: [1.2, 2.6],
    },
    flares: 10,
    chaff: 28,
    color: 0x7d7b63,
    shape: { length: 0.92, span: 0.86, sweep: 0.06, fatness: 1.25, twinTail: true },
  },
};

/** 早期警戒機。全方位の強力なレーダーを持つ非武装機。両陣営に登場しうる。 */
export const SUPPORT_TYPES = {
  'E-8': {
    id: 'E-8',
    name: 'E-8 早期警戒機',
    role: '早期警戒',
    maxSpeed: 200, cruiseSpeed: 160, minSpeed: 90,
    accel: 5, turnRate: 4, climbRate: 50, ceiling: 11000,
    hp: 220, hardpoints: 0,
    // **アフターバーナーを持たない**（§39）。
    //
    // 陣地の奥を飛ぶうえに逃げ足まで速いと、狙う手段が実質的に無くなる。
    // 見つけて詰めれば落とせる、という関係にする。
    noAfterburner: true,
    // 全域制圧はやめた（§30.2）。地図は 51.2km 四方なので、90km では
    // どこに居ても全部見えていた。逆探知される距離も 135 → 90km に落ちる。
    radarRange: 60000,
    omniRadar: true,          // 前方扇形ではなく全方位
    radarFovH: 180, radarFovV: 60,
    visualRange: 8000,
    fuelSeconds: 3600,
    gunRounds: 0, flares: 12, chaff: 30,
    color: 0xb9bec4,
    shape: { length: 1.5, span: 1.45, sweep: 0.06, fatness: 1.7, twinTail: false },
  },
};

/** 敵側の機体（性能はほぼ同等。見た目と名前だけ変える） */
export const ENEMY_TYPES = {
  'J-7': {
    ...AIRCRAFT_TYPES['F-1'],
    id: 'J-7', name: 'J-7 迎撃機', turnRate: 17, maxSpeed: 300,
    color: 0xa87a5a,
    shape: { length: 0.94, span: 0.58, sweep: 0.34, fatness: 0.9, twinTail: false },
  },
  'B-9': {
    ...AIRCRAFT_TYPES['A-3'],
    id: 'B-9', name: 'B-9 爆撃機', role: '爆撃',
    maxSpeed: 210, cruiseSpeed: 165, minSpeed: 90,
    turnRate: 5, climbRate: 60, hp: 260, hardpoints: 8,
    radarRange: 18000, fuelSeconds: 1500,
    color: 0x8a6f5c,
    shape: { length: 1.35, span: 1.25, sweep: 0.10, fatness: 1.5, twinTail: false },
  },
};

export const ALL_TYPES = { ...AIRCRAFT_TYPES, ...SUPPORT_TYPES, ...ENEMY_TYPES };

/** 識別段階1で表示する種別 */
export function categoryOf(typeId) {
  if (typeId === 'B-9') return 'bomber';
  if (typeId === 'E-8') return 'awacs';
  return 'fighter';
}

export function getType(id) {
  const t = ALL_TYPES[id];
  if (!t) throw new Error(`unknown aircraft type: ${id}`);
  return t;
}

/**
 * 敵機の既定搭載。ステージ定義で `loadout` を書かなかった機体に使う。
 *
 * **データ側に置いてある**（§47）。調整パネルが「いま何を積んでいるか」を
 * 出すために要るので、`main.js` に持たせると entry を import する形になる。
 */
export function defaultEnemyLoadout(type) {
  const spec = getType(type);
  if (!spec || spec.hardpoints === 0) return [];
  if (spec.role === '爆撃') return ['BOMB', 'BOMB', 'BOMB', 'BOMB', 'BOMB', 'BOMB', 'AAM-S'];
  if (spec.role === '対地') return ['AGM', 'AGM', 'AAM-S'];
  return ['AAM-M', 'AAM-S', 'AAM-S'];
}

