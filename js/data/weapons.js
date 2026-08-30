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
    pylon: 'small',            // 細い空対空弾。小型パイロンに載る
    name: '短距離AAM',
    kind: 'aam',              // 空対空
    guidance: 'ir',           // 赤外線 → フレアに弱い
    slots: 1,
    cost: 0,
    // **射程はアスペクトで変わる**（§34）。ここは後方（排気が見える）の値
    range: 8000,
    irHeadRange: 4000,        // 正面〜側方（機体の熱しか見えない）のロック距離
    speed: 850,               // m/s
    turnRate: 55,             // deg/s （表示・見積り用の目安。操舵は maxG から決まる）
    maxG: 30,                 // 最大G（§34.2）。実機の短射程弾は身軽
    fireAndForget: true,
    decoyResist: 0.25,        // 0=騙されやすい 1=騙されない
    damage: 200,
    rearmSeconds: 20,
    desc: '高機動・撃ちっぱなし。後方から8km／正面は4km。フレアに弱い',
  },

  'AAM-M': {
    id: 'AAM-M',
    pylon: 'small',            // 同上。**ここまでが小型**（プレイヤーの決め）
    name: '中距離AAM',
    kind: 'aam',
    guidance: 'sarh',         // セミアクティブ → 発射機がレーダー扇内に目標を保持し続ける必要
    slots: 1,
    cost: 2,
    range: 20000,
    speed: 1100,
    turnRate: 28,             // 表示・見積り用の目安
    maxG: 22,                 // 最大G（§34.2）。実機の中距離弾は 20〜30G
    fireAndForget: false,     // ここが AAM-A との決定的な差
    decoyResist: 0.35,
    damage: 200,
    rearmSeconds: 20,
    // シーカーのジンバル限界（±deg・§70.4.2）。ここから外れると
    // 反射波を拾えず、位置を測り直せなくなる。
    // **ロックの扇が ±40度なので、それより広く取らないと
    // 扇の縁で撃った弾が発射直後に死ぬ**（実測: 発射時のずれは中央値34.9度）
    seekerGimbal: 60,
    desc: '命中まで目標をレーダー扇内に保持し続ける必要がある。その間こちらも逃げられない',
  },

  'AAM-A': {
    id: 'AAM-A',
    pylon: 'medium',            // 大型のアクティブ弾
    name: 'アクティブAAM',
    kind: 'aam',
    guidance: 'arh',          // アクティブレーダー
    slots: 2,
    // **6 → 4**（§77）。6P は AAM-M 3発ぶんで、その値打ちが無かった。
    //
    // `[実測]` CLEAN SWEEP・同じ種18・**同じ6ポイント**で比べる:
    //
    // | 搭載 | コスト | クリア | 損失 | 1発の命中率 |
    // |---|---|---|---|---|
    // | AAM-M×2 + AAM-S×2 | 4P | 17/18 | 0.6 | 0.394 |
    // | **AAM-A×1 + AAM-S×2** | **6P** | **16/18** | **1.3** | **0.443** |
    // | AAM-M×3 + AAM-S×1 | 6P | **18/18** | **0.1** | 0.315 |
    //
    // **1発あたりは AAM-A が上なのに、手数が勝つ。** しかも 6P では
    // 現行の 4P 構成にすら負けていた —— 選ぶ理由が無い値段だった。
    //
    // 4P にすると AAM-M×2 と同値で並ぶ（16/18 対 17/18）。
    // **中型パイロンを1本使う**ぶんは残るので、対地兵装との取り合いは続く。
    cost: 4,
    range: 20000,
    speed: 1100,
    turnRate: 34,             // 表示・見積り用の目安
    maxG: 25,                 // 最大G（§34.2）
    fireAndForget: true,
    // **いま何もしていない**（SPEC §38.3）。`decoyResist` を読むのは
    // フレア（`deployDecoy` の `kind === 'flare'`）と、命中期待度の
    // 赤外線の枝だけ。レーダー弾はチャフの壁とビーム欺瞞で外れる仕組みで、
    // そちらは耐性を見ない。**AAM-A は AAM-M と同じだけ騙される。**
    decoyResist: 0.85,
    damage: 200,
    rearmSeconds: 30,
    // 終末誘導（§28.2）。ここまでは発射機の索敵レーダーから位置をもらう。
    // **中途のあいだ相手に警報は出ない**のが、この兵装の値打ち。
    activeRange: 10000,       // 予測位置までこの距離でシーカーを入れる
    seekerFov: 30,            // シーカー視界(±deg)。外れていれば捕捉できない
    seekerRange: 12000,
    midcourseInterval: 2,     // 位置をもらい直す間隔(秒)。あえて粗くする
    desc: '中途は母機のレーダーで導き、終末で自ら探す。気づかれるのが遅い',
  },

  'AGM': {
    id: 'AGM',
    pylon: 'medium',            // 対地。中型が要る
    name: '空対地ミサイル',
    kind: 'agm',
    guidance: 'command',
    slots: 2,
    // **表記射程を実際に届く距離へ下げた**（§55）。
    //
    // 14,000 と書いてあったが、減速は線形（`drag = speed / coastTime`）なので
    // 低空での到達は約 11km。AI の発射上限は 0.85×実効射程＝約 12km で、
    // **届かない距離から撃っていた**（実測: 目標の 377m 手前で失速）。
    // しかも対地の命中期待度は「表記射程に対する割合」しか見ないので、
    // その距離で必ず「高」と出る。**しきい値では止められない。**
    //
    // 届かせる手（ARM に与えた `coastTime`・§44）は採らない。
    // AGM の役どころは「どの高度からでも撃てる代わりに遠くない」で、
    // 遠射は ARM の仕事（§6.2.1）。**表記のほうを本当のことにする。**
    range: 10000,
    // 速度は「表記射程まで実際に届くか」で決まる。320m/s では慣性飛行で失速した。
    speed: 420,
    // 高度による射程の伸びは小さい。高高度からでも撃てるが、
    // ARM のように SAM の外から一方的に叩くことはできない（§6.2.1）
    altGain: 0.35,
    turnRate: 20,
    fireAndForget: true,
    decoyResist: 1,
    damage: 180,
    // 射程を詰めたぶん、値段と当たり方をプレイヤーの案に合わせて緩める（§55）。
    // 爆風 110m は「至近弾でも効く」を実際に成立させる大きさ ——
    // 60m のままだと、377m 手前で落ちた弾が何の役にも立たなかったのと同じで、
    // 少しのずれが全部無駄弾になる。
    cost: 4,
    blastRadius: 110,
    rearmSeconds: 25,
    desc: '対地ミサイル。射程10km。どの高度からでも撃てるが、高度を上げても伸びない',
  },

  'ARM': {
    id: 'ARM',
    pylon: 'medium',            // 同上
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
    // **慣性飛行が長い**（§44）。既定は 35 秒相当。
    //
    // §43 では発射上限を絞って飛翔距離に合わせたが、それだと
    // 発射 20.9km に対して SAM の射程が 19km で、**余裕が 1.9km しか残らない**。
    // 「SAM の射程外から安全に撃てる代わりに、遠いぶん外れることもある」
    // という駆け引きが成り立たなくなる。
    // **絞るのではなく、届くようにする。**
    coastTime: 55,
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
    pylon: 'medium',            // **`slots` は1だが太い。** 重さと太さは別（§70.7）
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
    pylon: 'medium',            // 増槽。中型が要る
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
/**
 * 赤外線 SAM の弾（§68.2）。**AAM-S とは別に持つ。**
 *
 * 見た目は短距離AAM と同じ働きだが、**混ぜると調整できなくなる** ——
 * AAM-S はプレイヤーが積む兵装で、こちらは地上の脅威。
 * 片方を触ると必ずもう片方が動く関係にしたくない。
 *
 * 地上発射なので上へ撃つぶんだけ AAM-S より強めにしてある
 * （射程6km・速度900・威力210）。**フレアは同じように効く。**
 */
WEAPONS['IR-SAM'] = {
  id: 'IR-SAM',
  pylon: 'medium',            // 地上発射なので機体には積まない（既定と揃えるだけ）
  name: '赤外線SAM',
  kind: 'sam',
  guidance: 'ir',             // 赤外線 → フレアに弱い。照射は要らない
  slots: 0,
  cost: 0,
  range: 6000,
  irHeadRange: 3200,          // 正面〜側方（排気が見えない）のロック距離
  speed: 900,
  turnRate: 45,
  maxG: 26,
  fireAndForget: true,
  decoyResist: 0.3,
  damage: 210,
  minAlt: 60,
  maxAlt: 5000,
  reloadSeconds: 14,
  desc: '地上発射の赤外線ミサイル。電波を出さないので逆探知に映らない',
};

WEAPONS['SAM-M'] = {
  id: 'SAM-M',
  pylon: 'medium',            // 同上
  name: 'SAMミサイル',
  kind: 'sam',
  guidance: 'sarh',           // 発射母体のレーダーが照射し続ける必要がある
  slots: 0,
  cost: 0,
  range: 19000,
  speed: 1250,                // 強力なブースター
  turnRate: 24,
  maxG: 20,                   // 最大G（§34.2）。地上発射で大型
  fireAndForget: false,
  decoyResist: 0.55,
  seekerGimbal: 60,           // ジンバル限界（§70.4.2）。空対空弾と同じ扱い
  damage: 220,
  minAlt: 200,
  maxAlt: Infinity,           // 射高の上限なし（高空ほど遠くから狙われる）
  reloadSeconds: 20,
  desc: '地上発射。高空の目標ほど有利になる',
};


/**
 * **パイロンの区分**（§70.7）。`small` は空対空の細い弾だけ、`medium` は何でも。
 *
 * プレイヤーの案どおり ——「小型はAAM-SとM、中型は全ての兵装」。
 * これで**搭載量ではなく搭載の中身**で機種を differentiate できる。
 * F-1 は中型が2本しかないので対地兵装を2つまでしか積めない、という書き方になる。
 *
 * **`slots` は残す。** あちらは重さ（抗力と上昇率に効く・`sim/aircraft.js`）で、
 * こちらは太さ。**同じ数字で2つのことを表さない。**
 */
export function pylonOf(id) {
  const w = getWeapon(id);
  return w.pylon || 'medium';
}

/** 機体のパイロン構成を `{ medium, small, total }` に正規化する */
export function hardpointsOf(spec) {
  const h = spec && spec.hardpoints;
  if (h == null) return { medium: 0, small: 0, total: 0 };
  if (typeof h === 'number') return { medium: h, small: 0, total: h };
  const m = h.medium || 0, s = h.small || 0;
  return { medium: m, small: s, total: m + s };
}

/** 武装を積める機体か（早期警戒機のような非武装を弾く） */
export function isArmed(spec) {
  return hardpointsOf(spec).total > 0;
}

/**
 * その搭載が機体のパイロンに**収まるか**（§70.7.1）。
 *
 * **プレイヤーにどのパイロンへ載せるかは選ばせない。**
 * 「有効な割り当てが存在するか」だけを見る ——
 * 大きいものから中型へ詰め、小型の弾は余った中型にも載せられる。
 * 貪欲で最適解になる（区分が2つで包含関係にあるため）。
 */
export function loadoutFits(loadout, spec) {
  const cap = hardpointsOf(spec);
  let med = 0;
  for (const id of loadout) if (pylonOf(id) === 'medium') med++;
  if (med > cap.medium) return false;
  const small = loadout.length - med;
  return small <= cap.small + (cap.medium - med);
}

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

/**
 * **標準搭載パターン（`PRESETS`）は削除した**（§70.7.2）。
 *
 * どこからも import されていない死にデータだった。しかも A-3 の
 * `対地` と `SEAD` は合計7スロットで、**A-3 のハードポイント6を超えていた** ——
 * 読まれていなかったので誰も気づかなかった。
 *
 * §70.7 でパイロンを小/中に分けたので、**制約そのものが変わった**。
 * 古い前提のまま残しておくと、次に読んだ人が信じてしまう。
 * 実際に使っている初期搭載は、各ステージ定義の `friendly.aircraft[].loadout`。
 */

