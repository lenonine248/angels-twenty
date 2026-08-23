// 交戦処理。兵装の選択と発射、機銃、デコイ、脅威（飛来ミサイル）の割り当て。
//
// 方針:
//   ・撃つ条件（射程・シーカーの視野・レーダー照射・視線）はここで一元管理する
//   ・同じ条件を満たすなら安い兵装から使う（兵装コストは有限のプールから引かれるため）
//   ・撃てるのは「自軍が探知している目標」だけ。見えない敵は撃てない

import * as THREE from 'three';
import { WEAPONS } from '../data/weapons.js';
import { Missile, Decoy, decoyMatches, NOTCH_TOLERANCE } from './missile.js';
import { Bullet, GUN_RPS, BULLET_LIFE, hitRadiusOf, aimPointOf } from './bullet.js';
import { headingOf, angleDiff, DEG } from './unit.js';
import { clamp } from '../core/rng.js';
import { effectiveMissileRange } from '../core/atmosphere.js';

// 機銃は実体弾（sim/bullet.js）。拡散・弾速・弾数は機種ごと（data/aircraft.js の gunSpec）。
//
// **射程も後方コーンも持たない**（§22.2.1 / §22.2.5）。
// 弾は全機共通の秒数で消え、当たるかどうかは拡散と偏差が決める。
// 正面からのすれ違いで当たらないのは、交差速度が大きく偏差が破綻するため。
//
/**
 * 機首をこの範囲まで向けていないと撃てない（機銃は機体に固定されている）。
 *
 * **対地は広く取る。** 地上目標のそばでは最低対地高度(220m)が効いて、
 * どうしても見下ろす角度が付く。622m まで詰めても俯角は 19度 になり、
 * 対空と同じ 14度 では永久に撃てない（実体弾にしたとき、対地用の
 * 広いコーンを落としてしまい、実際に掃射できなくなっていた）。
 */
const GUN_AIM_CONE = 14 * DEG;
const GUN_AIM_CONE_GROUND = 26 * DEG;
/** 撃つ気になる上限距離。弾が届く範囲より広く取り、実際の可否はしきい値に任せる */
const GUN_MAX_ENGAGE = 3200;
/** 拡散を広げる要因の効き */
const GUN_SPREAD_ROLL = 1.6;     // 旋回中（バンク角に比例）
const GUN_SPREAD_DAMAGE = 0.5;   // 損傷
/** 目標の旋回による偏差の外れやすさ（見積り用の係数） */
const GUN_LEAD_PENALTY = 1.0;

/**
 * 同じ目標へ、同じ空対空兵装を同時に何発まで飛ばすか。
 *
 * 数えるのは**自分が撃った弾だけ**で、**誘導を保っている弾だけ**。
 *
 * 以前は「陣営全体で、目標ごとに、兵装を問わず2発」だった。3つ問題があった。
 *
 * 1. **僚機の弾が自分の枠を食う。** 4機編隊だと3番機・4番機が永久に撃てない。
 *    目標の重複回避（§7）が別にあるので、陣営側で数える必要は無い
 * 2. **兵装を区別しない。** AAM-M が飛んでいると AAM-S も撃てなかった。
 *    射程帯の違う弾は同時に使えたほうが自然
 * 3. **外した弾も数えていた。** 誘導を失って明後日へ飛ぶ弾が枠を占め続け、
 *    AAM-M なら約32秒のあいだ発射が止まっていた。「撃ってほしいのに撃たない」の正体
 *
 * 対地（AGM・ARM・爆弾）には掛けない。同じ目標へ2発叩き込みたい場面が多い。
 */
const MAX_AAM_PER_TARGET = 1;
/** 連続発射の間隔(秒)。爆弾は一連射（スティック投下）できるよう短くする。 */
const FIRE_COOLDOWN = 3.5;
const BOMB_COOLDOWN = 0.5;

/**
 * 無誘導爆弾の偏差の取り方（§32.5）。1 で落下時間ぶん完全に先を狙う。
 * 0 にすると「いまの位置を狙う」＝ §32.5 以前の挙動に戻る（A/B 用）。
 */
const BOMB_LEAD = 1;

/**
 * ミサイル警報が出る距離。レーダー誘導は逆探知で早く分かるが、赤外線は目視まで気づけない。
 *
 * **セミアクティブ（AAM-M / SAM-M）はこの距離を使わない**（§37.2）。
 * 照らされている間はずっと警報が出る。ここに残るのは
 * アクティブ弾の終末（`radar`）と赤外線（`ir`）。
 */
const WARN_RANGE = { radar: 14000, ir: 5000 };

/**
 * デコイの効き方（§28.4）。**遠いほど騙されやすい。**
 *
 * 以前は逆だった（3km以内でしか効かず、近いほど効きやすい）。
 * 実機は遠距離ほどレーダーの分解能セルが大きく、チャフの雲と機体が
 * 同じセルに入るのでシーカーを引き剥がせる。近づくほど分離して見えるので騙せない。
 * 赤外線も同じ理屈。
 *
 * これが3つを同時に解く。
 * 1. **AAM-M と AAM-A に差が付く。** AAM-M は発射直後から誘導するので
 *    騙されやすい帯を長く通る。AAM-A は 10km でアクティブになるので飛ばせる
 * 2. **ノーエスケープゾーンが生まれる。** 遠くから撃った弾は撒かれ、
 *    詰めてから撃った弾は当たる。「掴んだまま近づく」が最適解になる
 * 3. **命中期待度に幅ができる**（§28.8）。距離で命中率が大きく変わるので、
 *    式がそれを写せば「高」「低」が出るようになる
 *
 * 上限を 0.85 で止めるのは、**チャフ1発で AAM-M が確実に死ぬ**のを避けるため。
 * 搭載数は据え置き（実測で外れの半分が既にデコイなので、増やすと当たらなくなる）。
 */
/**
 * 期待度の見積りで、何発ぶん撒かれると見るか（§28.8）。
 *
 * 2発ぶんで見積もったら**8km より遠くへ一発も撃たなくなった**（実測）。
 * 実際には撒くたびにミサイルが近づいて効きが落ちるし、弾数も尽きる。
 * 「遠いうちに撒いた1発ぶんが効く」と見るのが実測に近い。
 */
const DECOY_SHOTS = 1;

/**
 * 飛翔時間の見積り（§28.8）。設計速度に対する平均速度。飛翔中に減速するので 1 未満。
 */
const TOF_SPEED_FRAC = 0.8;

/**
 * 素の当たりやすさ（§38.3）。ここから各項が削っていく。
 * 実測の平らな帯（AAM-M の 8〜16km）が 0.30〜0.40 になるように置いた。
 */
const BASE_HIT = 0.82;

/**
 * **近すぎる射点**（§38.1）。飛翔時間がこれだけ無いと、弾は曲がり切れない。
 *
 * 実測で **AAM-S を 2km で撃つと命中 0.20**（134発中93が外れ）。
 * 3km なら 0.66 なので、1km の差で3倍違う。
 * 旧式には最小射程の概念がまったく無く、2km を 0.65 と見積もっていた。
 *
 * 距離ではなく飛翔時間で見るのは、速い弾ほど必要な距離が伸びるため。
 */
const NEAR_MIN = 2.2;
const NEAR_FULL = 4.6;

/**
 * **運動で届くか**（§38.3）。実効射程に対する割合で見る。
 *
 * **「距離の罰」はこの1本に集約する。** 旧式は距離で3回罰していて
 * （飛翔時間・デコイ・照射保持）、掛け算なので遠距離で 0 に潰れていた。
 * 実測で 14〜18km は 0.02 ではなく 0.4 前後当たる。
 *
 * 0.62 までは満額、0.85 で 0。発射上限（実効射程×0.85）と揃えてある。
 */
const KIN_START = 0.62;
const KIN_END = 0.85;

/**
 * **レーダー誘導が欺瞞をすり抜ける見込み**（§38.3）。
 *
 * §35.2 以降、チャフは**引き付けない**。効くのはビーム欺瞞（`_deceived`）と
 * チャフの壁（`_screened`）で、どちらも**飛翔時間が長いほど機会が増える**。
 * 実測でも、チャフ遮蔽は 12km までは0件、20km では外れの41%を占めた。
 *
 * **デコイの項（引き付け）はレーダー弾には掛けない。** それは赤外線だけの話。
 */
const DECEPT_SEC = 45;
const DECEPT_FLOOR = 0.30;

/**
 * **セミアクティブが照射を保てる見込み**（§38.2）。
 *
 * 旧式は飛翔時間の関数だった（`1 − tof/20`）が、**実測では距離を通してほぼ一定**
 * — 照射切れ率は 8km で26%、20km で28%。切れる原因は時間ではなく**機動**で、
 * 自分が向きを変えると目標がロックの扇から滑り出る。
 */
const SARH_HOLD = 0.77;
/**
 * ただし**目視距離の乱戦では話が別**（§38.1）。
 * 実測の照射切れ率は 6km で **61%**（8km 以遠の約2.5倍）。
 * 近いほど目標の視線角速度が大きく、扇を横切る速さが上がる。
 */
const HOLD_FAN_MIN = 4000;
const HOLD_FAN_FULL = 8000;
const HOLD_FAN_FLOOR = 0.40;
/**
 * **自分も撃たれているなら、照射は保てない**（§38.1）。
 *
 * 実測: 撃たれている状態で撃った AAM-M は **0/12 命中**。
 * 撃たれていなければ同じ距離で 0.44。回避に入れば扇から出るので当然だが、
 * 式に入っていなかったので AI は「回避しながら中距離弾を撃つ」を選べていた。
 */
const SARH_HOLD_UNDER_FIRE = 0.25;
/**
 * これだけ飛翔時間があれば、相手はデコイを撒き切れるとみる(秒)。
 *
 * 較正して 7 にした。4 だと近距離を過小に見ていた（予測0.48／実測0.85）。
 * 実際には、詰めてから撃った弾に対して相手が撒ける回数は少ない。
 * 遠くから撃たれたときに早めに撒いてしまい、**手元に残っていない**のもある。
 */
const DECOY_REACT_SEC = 7;

/**
 * 見積りの側で使う「よくある幾何」の係数（§28.13）。
 *
 * 実際のデコイは、ノッチに入っているかで効きが変わり（`decoyNotchFactor`）、
 * 2発目以降は落ちる（`decoyRepeatFactor`）。撃つ瞬間には相手がどう機動するか
 * 分からないので、見積りでは**平均的な値**を1つ掛ける。
 *
 * §28.13 の前は掛けていなかったので、6〜10km で **予測0.17 対 実測0.47** と
 * 4倍近く外れていた。表示の「中」が実態を表さなくなる。
 *
 * **1（補正なし）だと強すぎた**（§38.1）。5km の AAM-S で「42%が撒かれる」と
 * 見ていたが、実測のデコイ結末は 13〜20%。`flareFactor`（機体の温度と後方角・§35.3）と
 * `decoyRepeatFactor`（2発目以降は落ちる）が入っていないぶん、丸ごと過大だった。
 * 較正して **0.35**。これで 2〜8km の予測が実測と ±0.06 に収まる。
 *
 * **この項は赤外線にしか掛けない。** §35.2 以降チャフは引き付けないので、
 * レーダー弾に「デコイで逸らされる確率」を掛けるのは二重の誤り
 * （起きない事象を、しかも距離で罰していた）。
 */
const DECOY_GEOM_TYPICAL = 0.35;

export function decoyFactor(dist) {
  return clamp(0.15 + dist / 12000, 0.15, 0.85);
}

/**
 * 2発目以降のデコイの効き（§28.13）。
 *
 * **回数を重ねれば必ず効く、という作りが不具合だった。**
 * チャフ4発を1.2秒間隔で撒くと、8km では1回あたり 0.62 でも累積 95% になる。
 * 実測でも 6〜10km 帯だけが崩れていた（109発中68発がデコイ、命中は26%）。
 *
 * 実機のシーカーは、一度はねのけた束には掛かりにくい。追尾ゲートが
 * その目標を既に分離できているので、同じ機体が同じ幾何から撒く次の束は
 * 同じ判別を通ることになる。**独立な振り直しにはならない。**
 *
 * 「撒く量」ではなく「撒き始めの一発」で決まるので、
 * 練度＝どれだけ早く撒くか（§28.4.1）の意味も強まる。
 */
const DECOY_REPEAT = 0.45;

export function decoyRepeatFactor(tries) {
  return Math.pow(DECOY_REPEAT, tries);
}

/**
 * **§28.13 の `decoyNotchFactor` は撤去した**（§35.2）。
 *
 * 「チャフとノッチは同じ機動なので二重には効かない」として、
 * ノッチ中はチャフを弱くしていた。釣り合いの理屈としては通っていたが、
 * **物理としては逆だった。**
 *
 * チャフは電波を通さない雲＝壁で、レーダーが追いかける偽の目標ではない。
 * そして真横を向いた機体が紛れる先は「動かない背景」なので、
 * **チャフが効くのはむしろノッチのときだけ**（と、背を向けて逃げるとき）。
 *
 * いまは `Missile._deceived` / `_screened` がその役を持つ。
 * 二重計上の心配は、確率を1つにまとめたことで消えている。
 */

/**
 * 赤外線シーカーがロックできる距離（§34）。**アスペクトで大きく変わる。**
 *
 * 後方からは**排気**が見えるので遠くから掴める。
 * 側方や正面では排気が見えず、機体そのものの空力加熱しか手掛かりが無い。
 * 背景との温度差が排気ほど無いので、掴める距離は一気に落ちる。
 *
 * **旋回性能はアスペクトで変えない。** 変わるのは「掴めるかどうか」だけ。
 * 正面撃ちが当てにくいのは、飛翔時間が短くて相手に振られたときの誤差が
 * 大きくなるからで、そちらは §28.8 の飛翔時間の項に既に入っている。
 *
 * @param {number} aspect 0=正面から撃つ / 1=真後ろから撃つ
 */
/**
 * 排気が見え始めるアスペクトと、満額になるまでの幅（§34）。
 *
 * 実機の値をそのまま入れると**正面会敵のミッションが崩れる**
 * （正面3km・立ち上がり0.5幅0.35で SCRAMBLE が 15/18 → 3/18）。
 * 交戦の86%が正面（§22.3.6.1）なうえ、この地図は実際の戦域より縮尺が小さいので、
 * 立ち上がりを早めにして釣り合いを取る。
 */
/** 温度が分からない相手を見積もるときの既定値（§35.3） */
const HEAT_TYPICAL = 0.5;
/**
 * 温度がロック距離に効く度合い（§35.3）。基準は巡航の温度。
 * 絞れば 0.65倍まで縮み、AB を焚けば 1.3倍まで伸びる。
 */
const HEAT_CRUISE_REF = 0.45;
const HEAT_RANGE_SLOPE = 1.0;
const HEAT_RANGE_FLOOR = 0.65;
const HEAT_RANGE_CEIL = 1.30;

/**
 * フレアの競り合い（§35.3）。機体の明るさ = 基礎 + 後方 + 温度。
 * 明るいほどフレアは競り負ける。
 */
const SIG_BASE = 0.25;
const SIG_REAR = 0.45;
const SIG_HEAT = 0.30;
const FLARE_FLOOR = 0.12;

const IR_ASPECT_START = 0.3;
const IR_ASPECT_WIDTH = 0.45;

export function irLockRange(weapon, aspect, heat = HEAT_TYPICAL) {
  const tail = weapon.range;
  const head = weapon.irHeadRange;
  if (head == null) return tail;
  // 排気が見え始める角度から伸びる。
  // `IR_ASPECT_START` までは機体の熱だけ、そこから満額まで滑らかに上がる。
  const f = clamp((aspect - IR_ASPECT_START) / IR_ASPECT_WIDTH, 0, 1);
  // **推力を絞れば掴まれにくい**（§35.3）。冷えた機体は背景との差が小さい。
  // 基準は**巡航の温度**に置く — §34.1 で決めた 4000/5778/8000 は
  // 「普通に飛んでいるとき」の数字であって、AB を焚いた状態のものではない。
  const byHeat = clamp(1 + HEAT_RANGE_SLOPE * (clamp(heat, 0, 1) - HEAT_CRUISE_REF),
    HEAT_RANGE_FLOOR, HEAT_RANGE_CEIL);
  return Math.min(tail, (head + (tail - head) * f) * byHeat);
}

/**
 * フレアが競り勝てるか（§35.3）。
 *
 * 赤外線シーカーは**より明るいもの**を追う。だから相手の見え方で決まる。
 *
 * | 機体が明るく見える条件 | |
 * |---|---|
 * | 後ろから見られている | 排気そのものが見える。**紛れの無い熱源**と競うことになる |
 * | 温度が高い | アフターバーナーを焚いていれば、なおさら競り負ける |
 *
 * 逆に、正面から見られていて推力を絞っていれば機体は暗く、フレアがよく効く。
 * **推力を切れば隠れられるが、そのぶん速度で負ける** — そこが選択になる。
 */
export function flareFactor(unit, missile) {
  // 弾から見て機体の後ろ側にいる割合（1=真後ろ）
  const dx = unit.pos.x - missile.pos.x, dz = unit.pos.z - missile.pos.z;
  const rear = 1 - Math.abs(angleDiff(headingOf(dx, dz), unit.heading)) / Math.PI;
  const heat = unit.heat ?? HEAT_TYPICAL;
  // 機体自身の明るさ
  const sig = clamp(SIG_BASE + SIG_REAR * rear + SIG_HEAT * heat, 0, 1);
  return clamp(1 - sig, FLARE_FLOOR, 1);
}

/** 撃つ側から見た目標のアスペクト。0=正面から / 1=真後ろから */
export function aspectOf(shooter, target) {
  const dx = target.pos.x - shooter.pos.x, dz = target.pos.z - shooter.pos.z;
  return Math.abs(angleDiff(headingOf(-dx, -dz), target.heading)) / Math.PI;
}

/** ミサイルの最小射程（近すぎると誘導が間に合わない） */
const MIN_RANGE = { 'AAM-S': 400, default: 1500 };

/**
 * AIが自動発射に踏み切る命中期待度のしきい値。
 *
 * **§38 で式を置き直したので、ここも同じ回で置き直す。**
 * 目盛りを動かして読む側を置いていくと必ず壊れる — §28.4・§28.8・§28.13 で
 * 3回踏んだ。今回の式は**実測の確率そのもの**を返すので、
 * しきい値も「何割当たるなら撃つか」として読める。
 *
 * | | 値 | 意味 |
 * |---|---|---|
 * | `low` | 0.12 | 当たれば儲け。弾を余らせるより撃つ |
 * | `mid` | **0.20** | 既定。**5発に1発当たるなら撃つ** |
 * | `high` | 0.40 | 良い射点でだけ撃つ |
 *
 * `mid` を 0.20 に置くと、AAM-M は **18km で撃ち、20km では撃たない**
 * （実測 0.42 対 0.13）。旧値 0.15 では 7.8km まで詰めていた（§37.5）。
 *
 * `hitLabel` の 低／中／高 もこの目盛りを共有する。
 */
export const FIRE_THRESHOLD = { low: 0.12, mid: 0.20, high: 0.40 };

/**
 * 機銃のしきい値はミサイルより低く取る。
 * ミサイルは1発が高価なので「当たりそうなときだけ」でよいが、
 * 機銃は連射する前提で、1発あたりの期待値はもともと小さい。
 * ミサイルと同じ刻みを使うと、機銃はほぼ一生撃たない。
 */
export const GUN_THRESHOLD = { low: 0.05, mid: 0.14, high: 0.30 };

/**
 * 機銃1発あたりの命中期待度（0..1）。
 *
 * 拡散と偏差の2つから作る。§22.2.2 / §22.2.3 の試算式そのもの。
 *   拡散: 横のばらつきが σ×距離 のとき、半径 r に入る割合は 1-exp(-r²/2(σd)²)
 *   偏差: 目標が旋回していると 0.5×(速度×旋回率)×飛翔時間² だけ狙点からずれる
 */
export function estimateGunHit(shooter, target) {
  const g = shooter.spec && shooter.spec.gunSpec;
  if (!g || !target || !target.alive || shooter.gun <= 0) return 0;

  const dist = shooter.pos.distanceTo(target.pos);
  if (dist < 1) return 0;
  const flight = dist / g.muzzleSpeed;
  if (flight > BULLET_LIFE) return 0;            // 弾が届かない

  const r = hitRadiusOf(target);
  const sigma = gunSpread(shooter, g);
  const spread = Math.max(1, sigma * dist);

  // 偏差の誤差。狙点は「目標がまっすぐ飛ぶ前提」で作るので、
  // 曲がっている目標には飛翔時間の2乗に比例して外れる。
  // 旋回率は実測値（aircraft.js が毎ステップ入れる）を使う。
  // バンク角から推し量ると、緩い定常旋回でバンクが寝ているときに
  // 「曲がっていない」と誤って読む。
  let lead = 0;
  if (target.kind === 'aircraft' && !target.onGround) {
    const omega = Math.abs(target.turnRate || 0);
    lead = 0.5 * (target.speed || 0) * omega * flight * flight * GUN_LEAD_PENALTY;
  }

  // ばらつきと偏差を合成して、半径 r に入る割合を出す
  const off2 = lead * lead;
  const s2 = spread * spread;
  return clamp(Math.exp(-off2 / (2 * s2)) * (1 - Math.exp(-(r * r) / (2 * s2))), 0, 1);
}

/** 実際に使う拡散角(ラジアン)。旋回・損傷・練度で広がる。 */
function gunSpread(shooter, g) {
  const roll = Math.abs(shooter.roll || 0) / 0.6;          // 0..1（最大バンク=0.6rad）
  const hurt = 1 - (shooter.hp / Math.max(1, shooter.maxHp));
  const skill = 0.6 + 0.4 * (shooter.skill ?? 1);
  return g.dispersion
    * (1 + roll * GUN_SPREAD_ROLL + hurt * GUN_SPREAD_DAMAGE)
    / skill;
}

/** 方向 dir を拡散角 sigma でばらつかせる（2次元の正規分布） */
function scatter(dir, sigma, rng, out) {
  // Box-Muller。左右と上下に独立した正規分布の角度を与える。
  const u1 = Math.max(1e-6, rng());
  const rad = Math.sqrt(-2 * Math.log(u1)) * sigma;
  const ang = rng() * Math.PI * 2;
  // dir に垂直な基底を作る
  _right.set(-dir.z, 0, dir.x);
  if (_right.lengthSq() < 1e-8) _right.set(1, 0, 0);
  _right.normalize();
  _up.crossVectors(dir, _right).normalize();
  return out.copy(dir)
    .addScaledVector(_right, Math.cos(ang) * rad)
    .addScaledVector(_up, Math.sin(ang) * rad)
    .normalize();
}

/**
 * 命中期待度の見積り（0..1）。
 *
 * 「撃てるか」と「当たるか」は別問題。射程の縁で撃ったミサイルは
 * 終末でエネルギーを失い、逃げる目標には届かない。
 * プレイヤーの判断材料と、AIの乱射抑制の両方に使う。
 */
/**
 * @param {number} aimError 狙点のずれ(m)。掴めていない相手を撃つときに効く（§25.4）
 */
export function estimateHitChance(shooter, target, weapon, aimError = 0) {
  if (!weapon || !target || !target.alive) return 0;
  if (weapon.kind === 'bomb') return 0.5;      // 投下点まで行けるかどうかの話なので固定

  const dist = shooter.pos.distanceTo(target.pos);
  const eff = effectiveMissileRange(weapon, (shooter.pos.y + target.pos.y) * 0.5);
  const frac = dist / Math.max(1, eff);
  let p = clamp(1.18 - frac * 1.35, 0.03, 0.95);

  if (target.kind === 'aircraft' && !target.onGround) {
    // **外れ方ごとに項を1つずつ持たせ、二重に罰しない**（§38.3）。
    //
    // 旧式は距離（＝飛翔時間）で3回罰していた ─ 飛翔時間・デコイ・照射保持。
    // 掛け算なので遠距離では 0 に潰れ、**実測で4割当たる 14〜18km を
    // 0.02 と見積もっていた**。その結果 AI は 7.8km まで詰めてからしか撃たず、
    // 目視外の戦いが丸ごと存在しなくなっていた（§37.5）。
    //
    // 飛翔中に減速するので、平均速度は設計速度の 8 割で見る。
    const tof = dist / Math.max(1, weapon.speed * TOF_SPEED_FRAC);
    p = BASE_HIT;

    // **近すぎ**（§38.1）。弾の旋回半径が間に合わない。
    // 実測: AAM-S を 2km で撃つと 0.20、3km なら 0.66。
    p *= clamp((tof - NEAR_MIN) / (NEAR_FULL - NEAR_MIN), 0, 1);

    // **遠すぎ**（§38.3）。距離の罰はここ1本だけ。
    p *= clamp((KIN_END - frac) / (KIN_END - KIN_START), 0, 1);

    // アスペクト。誘導方式で得意な角度が逆になる。
    //   赤外線: 排気を見るので後方から撃つほど当たる
    //   レーダー: 接近速度が乗る正面ほど当たる
    const dx = target.pos.x - shooter.pos.x, dz = target.pos.z - shooter.pos.z;
    const aspect = Math.abs(angleDiff(headingOf(-dx, -dz), target.heading)) / Math.PI;
    p *= weapon.guidance === 'ir' ? (0.7 + 0.3 * aspect) : (1 - 0.4 * aspect);

    if (weapon.guidance === 'ir') {
      // 赤外線は掴めない距離なら 0（§34）。ここを入れないと、
      // **撃てない相手に「中」と表示される**
      if (dist > irLockRange(weapon, aspect, target.heat)) return 0;

      // **フレアだけが「引き付ける」対抗手段**（§35.2）。
      // 遠いほど効き（§28.4）、撒く暇があるかも見る（至近では撒けない）。
      const chanceToUse = clamp(tof / DECOY_REACT_SEC, 0, 1);
      const per = (1 - (weapon.decoyResist ?? 0.5)) * decoyFactor(dist) * chanceToUse
        * DECOY_GEOM_TYPICAL;
      p *= Math.pow(1 - per, DECOY_SHOTS);
    } else {
      // **レーダー弾はチャフに引き付けられない**（§35.2）。
      // 効くのはビーム欺瞞とチャフの壁で、どちらも**飛翔時間が長いほど機会が増える**。
      // 実測: チャフ遮蔽は 12km まで0件、20km では外れの41%。
      p *= clamp(1 - tof / DECEPT_SEC, DECEPT_FLOOR, 1);
    }

    // **セミアクティブは、着弾まで照射を保てるかを見る**（§38.2）。
    //
    // 旧式は飛翔時間の関数だったが、実測の照射切れ率は距離を通してほぼ一定
    // （8km 26% / 20km 28%）。切れる原因は時間ではなく**機動**。
    if (weapon.guidance === 'sarh') {
      p *= SARH_HOLD;
      // 目視距離の乱戦では話が別。視線角速度が大きく、扇を横切る速さが上がる
      // （実測の照射切れ率は 6km で 61%）。
      p *= clamp((dist - HOLD_FAN_MIN) / (HOLD_FAN_FULL - HOLD_FAN_MIN),
        HOLD_FAN_FLOOR, 1);
      // 自分も撃たれているなら保てない（実測 0/12 命中）。
      if (shooter.threats && shooter.threats.length) p *= SARH_HOLD_UNDER_FIRE;
    }

    // 高度による回避余力は**足さない**。運動の項に既に含まれている。
    // 相手の対抗手段の残量は見ない（残弾を数えるのは過剰な情報なので）
  } else {
    // 動かない目標は回避しない。射程の縁でなければまず当たる。
    //
    // ここに空対空と同じ距離減点をかけると、SAM の射程外から撃つための
    // ARM が「命中期待度が低い」と判断されて永久に撃てず、
    // SAM の交戦距離まで近づいてから撃つことになって存在意義が消える。
    // 静止目標では「当たるか」ではなく「弾が届くか」だけを見る。
    p = clamp(1.15 - frac * 0.85, 0.05, 0.95);
  }

  // 掴みの甘さ。**撃ちっぱなしは撃ったあと修正できない**ので、
  // 座標がずれていればそのぶん外れる（§25.4）。
  //
  // これを入れないと、AI は掴めていない相手にも射程いっぱいで撃ってしまう。
  // 実測（ミッション5・同じ種で4回）: 上陸部隊へのダメージが 332 → 163、
  // 撃破 1 → 0 に落ちた。当たらない弾を撃ち尽くしていただけだった。
  // 期待度に織り込めば「詰めてから撃つ」を自分で選ぶ。
  //
  // ARM は除く。電波そのものを追うので座標のずれを受けない。
  if (aimError > 0 && weapon.fireAndForget && weapon.guidance !== 'arm') {
    const reach = (weapon.blastRadius || 40)
      + (target.spec && target.spec.size ? target.spec.size * 0.25 : 0);
    p *= clamp(1 - (aimError * 0.7) / Math.max(30, reach), 0.05, 1);
  }
  return clamp(p, 0.02, 0.97);
}

/**
 * 命中期待度の表示ラベル。
 *
 * しきい値と同じ目盛りに揃える（§28.8）。この game では 35% が「良い射点」で、
 * 60% は近距離の一部でしか出ない。以前の 0.6/0.32 は、
 * 見積りが 0.35〜0.49 しか出ていなかったので**全部「中」**になっていた。
 */
export function hitLabel(p) {
  if (p >= FIRE_THRESHOLD.high) return { text: '高', cls: 'good' };
  if (p >= FIRE_THRESHOLD.mid) return { text: '中', cls: 'mid' };
  return { text: '低', cls: 'bad' };
}

export class CombatSystem {
  /**
   * その機体が、その目標へ、その兵装を**いま何発誘導中か**。
   *
   * 空対空以外は常に 0（対地は重ねて撃ってよい）。
   * `m.lost` を外すのが肝で、これを数に入れていたのが
   * 「撃ってほしいのに撃たない」の原因だった（MAX_AAM_PER_TARGET を参照）。
   */
  guidingCount(shooter, target, weapon) {
    if (!weapon || weapon.kind !== 'aam') return 0;
    let n = 0;
    for (const m of this.world.missiles) {
      if (!m.alive || m.lost) continue;
      if (m.launcher !== shooter || m.target !== target) continue;
      if (m.weapon && m.weapon.id === weapon.id) n++;
    }
    return n;
  }

  /**
   * その陣営がこの目標を狙うときの、狙点のずれ(m)。
   * 正確に見えていれば 0（§25.4）。
   */
  aimErrorOf(shooter, target) {
    const c = this.world.detection
      && this.world.detection.contactsFor(shooter.side).get(target.id);
    if (!c) return 0;
    if (c.detected && !c.approx) return 0;
    return Number.isFinite(c.err) ? c.err : 0;
  }

  constructor(world) {
    this.world = world;
    world.missiles = [];
    world.decoys = [];
    world.bullets = [];
    world.combat = this;
  }

  update(dt) {
    const w = this.world;

    for (const m of w.missiles) m.update(dt, w);
    for (const d of w.decoys) d.update(dt);
    for (const b of w.bullets) b.update(dt, w);
    w.missiles = w.missiles.filter((m) => m.alive);
    w.decoys = w.decoys.filter((d) => d.alive);
    w.bullets = w.bullets.filter((b) => b.alive);

    this._assignThreats();

    for (const u of w.units) {
      if (u.kind !== 'aircraft' || !u.alive) continue;
      this._engage(u, dt);
    }
  }

  // ------------------------------------------------------------ 脅威

  /** 各機に「自分を狙って飛来中で、かつ気づけているミサイル」を持たせる */
  _assignThreats() {
    const w = this.world;
    for (const u of w.units) {
      if (u.threats) u.threats.length = 0;
    }
    for (const m of w.missiles) {
      const t = m.target;
      if (!t || !t.threats || !t.alive) continue;
      if (m.lost) continue;
      // アクティブレーダー弾は、シーカーを入れるまで気づかれない（§28.2）。
      // 中途は母機の索敵レーダーで導かれているだけなので、
      // 「自分に向かって何かが飛んで来ている」という情報が相手に無い。
      if (m.active === false) continue;
      // セミアクティブは**発射機が照らし続けている**（§37.2）。
      // 逆探知が聞いているのは弾ではなく、その追尾波。
      // だから**距離に関係なく気づく**し、照射が切れれば警報も消える。
      //
      // これで AAM-M（コスト2）と AAM-A（コスト6）の差が説明できる。
      // 安いほうは撃った瞬間に知られ、照らし続けねばならない。
      // 高いほうは終末までシーカーを入れないので黙っていられる（§28.2）。
      //
      // 発射前のロックは警報に出さない — 出すと撃つ前に逃げられ、
      // セミアクティブが成立しなくなる。**飛んでいる弾の照射だけ**を聞く。
      if (!(m.guidance === 'sarh' && m.painting)) {
        const dist = m.pos.distanceTo(t.pos);
        const warn = m.guidance === 'ir' ? WARN_RANGE.ir : WARN_RANGE.radar;
        if (dist > warn) continue;
      }
      t.threats.push(m);
    }
    for (const u of w.units) {
      if (u.threats && u.threats.length > 1) {
        u.threats.sort((a, b) => a.pos.distanceTo(u.pos) - b.pos.distanceTo(u.pos));
      }
    }
  }

  // ------------------------------------------------------------ 交戦

  _engage(shooter, dt) {
    shooter.fireCooldown = Math.max(0, (shooter.fireCooldown || 0) - dt);

    // プレイヤーが指定した射撃指示を先に処理する。
    // 攻撃目標は変えず、条件が整ったときだけ撃つ（指定した兵装で1発）。
    if (this._runFireTasks(shooter)) return;

    const o = shooter.order;
    if (!o || o.type !== 'attack') return;
    const target = o.target;
    if (!target || !target.alive) return;

    // 自軍が探知していない目標は撃てない
    if (!this.world.detection.isVisible(shooter.side, target)) return;

    this._tryGun(shooter, target, dt);

    if (shooter.fireCooldown > 0) return;

    const weapon = this.selectWeapon(shooter, target);
    if (!weapon) return;

    // 同じ空対空兵装を同じ目標へ重ねて撃たない（MAX_AAM_PER_TARGET）
    if (this.guidingCount(shooter, target, weapon) >= MAX_AAM_PER_TARGET) return;

    // 命中が見込めないうちは撃たない（乱射してミサイルを空にしないため）。
    //
    // ここに練度を効かせてはいけない。ミサイルが実体で飛ぶこのゲームでは、
    // しきい値を下げれば「手数が増えて」強くなり、上げれば「良い射点でだけ撃つ」
    // ので強くなる。どちらへ動かしても強くなるため、難易度の軸として使えない。
    // 練度は発射間隔・照準精度・反応速度・回避の質で効かせる（単調に効く軸だけ使う）。
    const need = FIRE_THRESHOLD[shooter.fireThreshold || 'mid'] ?? FIRE_THRESHOLD.mid;
    if (weapon.kind !== 'bomb'
      && estimateHitChance(shooter, target, weapon, this.aimErrorOf(shooter, target)) < need) return;

    this.fire(shooter, target, weapon);
    // 練度が低いほど次弾までが遅い。手数そのものを減らす、副作用の少ない効かせ方。
    const cd = weapon.kind === 'bomb' ? BOMB_COOLDOWN : FIRE_COOLDOWN;
    shooter.fireCooldown = cd / (0.5 + 0.5 * (shooter.skill ?? 1));
  }

  /** プレイヤーが指定した射撃指示（兵装＋目標）を条件が整った順に消化する */
  _runFireTasks(shooter) {
    const tasks = shooter.fireTasks;
    if (!tasks || !tasks.length) return false;
    if (shooter.fireCooldown > 0) return false;

    for (let i = 0; i < tasks.length; i++) {
      const t = tasks[i];
      if (!t.target || !t.target.alive || !shooter.loadout.includes(t.weapon)) {
        tasks.splice(i, 1); i--; continue;
      }
      const w = WEAPONS[t.weapon];
      if (!this.world.detection.isVisible(shooter.side, t.target)) continue;
      if (!this.inEnvelope(shooter, t.target, w)) continue;
      this.fire(shooter, t.target, w);
      shooter.fireCooldown = w.kind === 'bomb' ? BOMB_COOLDOWN : FIRE_COOLDOWN;
      tasks.splice(i, 1);
      return true;
    }
    return false;
  }

  /**
   * 使用する兵装を選ぶ。
   * プレイヤーが指定していればそれだけを使い、指定が無ければ
   * 「自動使用が許可されていて、発射条件を満たす中で最も安いもの」を選ぶ。
   */
  selectWeapon(shooter, target) {
    // 駐機・滑走中の機体は地上目標として扱う（空対空ミサイルは撃てない）
    const isAir = target.kind === 'aircraft' && !target.onGround;
    const forced = shooter.order && shooter.order.weapon;
    let best = null;
    for (const id of shooter.loadout) {
      const w = WEAPONS[id];
      if (!w) continue;
      if (forced) { if (id !== forced) continue; }
      else if (shooter.autoWeapons && shooter.autoWeapons[id] === false) continue;
      if (isAir ? w.kind !== 'aam' : (w.kind !== 'agm' && w.kind !== 'bomb')) continue;
      if (!this.inEnvelope(shooter, target, w)) continue;
      if (!best || w.cost < best.cost) best = w;
    }
    return best;
  }

  /**
   * いま撃てない理由を1つ返す（撃てるなら null）。
   *
   * 命中期待度が「高」と出ているのに撃たない、ということが起きる。
   * 期待度は**当たるかどうか**の見積りで、**撃ってよいかどうか**は別の条件。
   * 同一目標への同時誘導数と再装填はどちらも画面に出ていなかったため、
   * プレイヤーからは「撃てるはずなのに撃たない」としか見えなかった。
   *
   * @param {?object} weapon 省略時は自動選択と同じ規則で選ぶ
   */
  fireBlockReason(shooter, target, weapon = null) {
    if (!shooter || !shooter.alive || !target || !target.alive) return null;
    if (shooter.onGround) return '地上';
    if (!this.world.detection.isVisible(shooter.side, target)) return '未探知';

    const isAir = target.kind === 'aircraft' && !target.onGround;
    let w = weapon;
    if (!w) {
      // 自動で使える兵装があるか。無ければ理由を分ける。
      const usable = shooter.loadout.filter((id) => {
        const x = WEAPONS[id];
        if (!x) return false;
        return isAir ? x.kind === 'aam' : (x.kind === 'agm' || x.kind === 'bomb');
      });
      if (!usable.length) return '兵装なし';
      const allowed = usable.filter((id) => !(shooter.autoWeapons && shooter.autoWeapons[id] === false));
      if (!allowed.length) return '自動使用オフ';
      // 条件を満たすものがあればそれを使う。無ければ最初のもので理由を出す。
      w = WEAPONS[allowed.find((id) => this.inEnvelope(shooter, target, WEAPONS[id])) || allowed[0]];
    }

    if (!this.inEnvelope(shooter, target, w)) return this._envelopeReason(shooter, target, w);

    if (this.guidingCount(shooter, target, w) >= MAX_AAM_PER_TARGET) return `${w.id} 誘導中`;
    if (shooter.fireCooldown > 0) return `再装填 ${shooter.fireCooldown.toFixed(1)}秒`;

    if (w.kind !== 'bomb') {
      const need = FIRE_THRESHOLD[shooter.fireThreshold || 'mid'] ?? FIRE_THRESHOLD.mid;
      if (estimateHitChance(shooter, target, w, this.aimErrorOf(shooter, target)) < need) {
        return '期待度不足';
      }
    }
    return null;
  }

  /** エンベロープのどこで落ちたかを言葉にする */
  _envelopeReason(shooter, target, w) {
    const dx = target.pos.x - shooter.pos.x;
    const dz = target.pos.z - shooter.pos.z;
    const dy = target.pos.y - shooter.pos.y;
    const flat = Math.hypot(dx, dz);
    const dist = Math.hypot(flat, dy);

    if (w.maxLaunchAlt != null && shooter.pos.y > w.maxLaunchAlt) return '高度が高い';
    if (w.minLaunchAlt != null && shooter.pos.y < w.minLaunchAlt) return '高度が低い';
    if (w.kind !== 'bomb') {
      const minR = MIN_RANGE[w.id] ?? MIN_RANGE.default;
      const eff = effectiveMissileRange(w, (shooter.pos.y + target.pos.y) * 0.5);
      if (dist < minR) return '近すぎ';
      if (dist > eff * 0.85) return '射程外';
    }
    if (w.guidance === 'arm' && !target.emitting) return '電波なし';
    const off = offBoresight(shooter, dx, dz, dy) / DEG;
    if (w.guidance === 'sarh' || w.guidance === 'arh') {
      if (!inRadarFan(shooter, dx, dz, dy, flat, w.guidance === 'sarh')) {
        return `${w.guidance === 'sarh' ? 'ロックの扇' : '扇'}の外 ${Math.round(off)}度`;
      }
    } else if (off > 45) {
      return `射角外 ${Math.round(off)}度`;
    }
    return '視線なし';
  }

  /** 発射エンベロープの判定 */
  inEnvelope(shooter, target, w) {
    const dx = target.pos.x - shooter.pos.x;
    const dz = target.pos.z - shooter.pos.z;
    const dy = target.pos.y - shooter.pos.y;
    const flat = Math.hypot(dx, dz);
    const dist = Math.hypot(flat, dy);
    const terrain = this.world.terrain;

    // 地上目標は地表にいるので、視線判定は少し持ち上げた点で行う
    const losPoint = target.kind === 'aircraft'
      ? target.pos
      : _v4.set(target.pos.x, target.pos.y + 40, target.pos.z);
    const los = () => terrain.hasLineOfSight(shooter.pos, losPoint, 8, 300);

    if (w.kind === 'bomb') {
      // 無誘導爆弾は弾道解で投下点を決める。
      // 機首角度で判定すると、水平飛行では目標が常に下方にあって永久に投下できない。
      //
      // **狙うのは「信じている位置」**（§25.4）。誘導しないので、
      // 投下点は掴んでいる座標から計算するほかない。逆探知だけで掴んでいる
      // 目標なら、そのぶんずれたところへ落ちる。
      const aim = this.world.believedPosOf(shooter.side, target) || target.pos;
      const h = shooter.pos.y - aim.y;
      if (h < 60 || h > w.dropAltMax) return false;
      // 母機の上下速度を含めた落下時間 h = -vy*t + g*t^2/2 を解く
      const pitch = shooter.pitch || 0;
      const vy = shooter.speed * Math.sin(pitch);
      const vh = shooter.speed * Math.cos(pitch);
      const fallTime = (vy + Math.sqrt(vy * vy + 2 * 9.8 * h)) / 9.8;
      const throwRange = vh * fallTime;               // 投下点から着弾点までの水平距離

      // **動く目標には落下時間ぶん先を狙う**（§32.5）。
      //
      // 落下時間は高度だけで決まり、水平距離には依らないので一度で解ける。
      // 4000m から 200m/s で落とすと落下は約28秒。時速50kmの車両でも
      // 400m 進むので、いまの位置を狙うと**必ず手前に落ちる**。
      //
      // これは高度を上げるほど大きくなる**系統誤差**で、
      // プレイヤーには「対空砲の射程外から落とすと当たらない」としか見えない。
      // 手前へずれると分かっていても手の打ちようがない ─ 学習できない罰なので取り除く。
      // 散布界（`bombDispersion`・高度に比例）はそのまま残すので、
      // **高く入るほど散る**という高度の駆け引きは変わらない。
      let ax = aim.x, az = aim.z;
      if (target.speed > 0 && target.heading != null) {
        const lead = target.speed * fallTime * BOMB_LEAD;
        ax += Math.sin(target.heading) * lead;
        az -= Math.cos(target.heading) * lead;
      }
      const bdx = ax - shooter.pos.x, bdz = az - shooter.pos.z;
      const bflat = Math.hypot(bdx, bdz);
      if (Math.abs(angleDiff(headingOf(bdx, bdz), shooter.heading)) > 16 * DEG) return false;
      // 爆風半径と同程度の窓で投下する。狭すぎると投下機会を逃し続ける。
      //
      // **「解を跨いだ瞬間に放す」に変えてみたが、測ったら悪化した**
      // （高度3000mで撃破 4/4 → 0/4）。窓に入っている間ずっと投下条件が成立し、
      // 詰めながら1本ずつ落とすぶんが軒並み late になるため。
      // 窓の中心で放つ形（いまの式）のほうが、結果として散らばりが小さい。
      return Math.abs(bflat - throwRange) < 130;
    }

    // 実効射程は高度で変わる。撃ち下ろしは終末が濃い空気になるので、
    // 発射点と目標の平均高度で見積もる。
    // 兵装ごとの運用高度（AGMは低・中高度向け、ARMは高高度向け）
    if (w.maxLaunchAlt != null && shooter.pos.y > w.maxLaunchAlt) return false;
    if (w.minLaunchAlt != null && shooter.pos.y < w.minLaunchAlt) return false;

    const minR = MIN_RANGE[w.id] ?? MIN_RANGE.default;
    const effRange = effectiveMissileRange(w, (shooter.pos.y + target.pos.y) * 0.5);
    if (dist < minR || dist > effRange * 0.85) return false;

    switch (w.guidance) {
      case 'ir': {
        // 赤外線シーカーはある程度の首振りができる
        if (offBoresight(shooter, dx, dz, dy) > 50 * DEG) return false;
        // **掴める距離はアスペクトで変わる**（§34）。
        // 排気が見えない正面・側方からは、ずっと近づかないと掴めない
        if (target.kind === 'aircraft'
            && dist > irLockRange(w, aspectOf(shooter, target), target.heat)) return false;
        return los();
      }

      case 'sarh':
      case 'arh':
        // レーダー誘導は自機のレーダー扇に入っていることが条件。
        // セミアクティブは**着弾まで**保持する必要があるので、
        // 発射の可否も狭いロックの扇で判定する（§28.7）。
        if (!inRadarFan(shooter, dx, dz, dy, flat, w.guidance === 'sarh')) return false;
        return los();

      case 'arm':
        if (!target.emitting) return false;
        return los();

      case 'command':
      default:
        if (offBoresight(shooter, dx, dz, dy) > 45 * DEG) return false;
        return los();
    }
  }

  /** 兵装を1発消費して発射する */
  fire(shooter, target, weapon) {
    const idx = shooter.loadout.indexOf(weapon.id);
    if (idx < 0) return null;
    shooter.loadout.splice(idx, 1);

    const m = new Missile({ weapon, launcher: shooter, target, world: this.world });

    // 照準の甘さ。練度が低いほど初期の向きがずれ、ミサイルは修正にエネルギーを使う。
    // 「撃つかどうか」ではなく「どれだけ正確に撃てるか」に効かせるのが、
    // 難易度の軸として素直に効く（外すほど当たらなくなる）。
    const skill = shooter.skill ?? 1;
    if (skill < 1) {
      const err = (1 - skill) * 0.11;                   // 練度0.2で約5度
      const a = (this.world.rng() - 0.5) * 2 * err;
      const c = Math.cos(a), sn = Math.sin(a);
      const dx0 = m.dir.x, dz0 = m.dir.z;
      m.dir.set(dx0 * c - dz0 * sn, m.dir.y, dx0 * sn + dz0 * c).normalize();
    }

    // 無誘導爆弾は投下高度に応じて散布界が広がる
    if (weapon.kind === 'bomb' && weapon.dispersionPerKm) {
      const h = Math.max(0, shooter.pos.y - target.pos.y);
      m.bombDispersion = weapon.dispersionPerKm * (h / 1000);
    }

    // 撃ちっぱなしの対地兵装は**信じている座標**へ向かう（§25.4）。
    // 撃ったあとに修正できないので、掴み違えていればそのぶん外れる。
    //
    // ARM は例外。電波そのものを追う兵装なので、放射源を外したら意味が消える。
    // 「電波を出している目標には ARM、黙っている目標には詰めてから AGM」
    // という使い分けは、この例外があって初めて生まれる。
    if (weapon.kind === 'agm' && weapon.guidance !== 'arm' && weapon.fireAndForget) {
      const believed = this.world.believedPosOf(shooter.side, target);
      if (believed) m.seekTarget = { pos: believed.clone(), alive: true, speed: 0, isPoint: true };
    }
    this.world.missiles.push(m);

    // 「攻撃したが着弾を見ていない」判定のため記録しておく
    this.world.detection?.markAttacked(shooter.side, target);
    this.world.onFire?.(shooter, target, weapon, m);
    return m;
  }

  /**
   * 地上発射（SAM）。搭載リストを消費せず、弾数とリロードは発射側が管理する。
   * launcher は静止しているので、目標方向へロフトして撃ち上げる。
   */
  fireGround(launcher, target, weapon) {
    const m = new Missile({ weapon, launcher, target, world: this.world });

    const dx = target.pos.x - launcher.pos.x;
    const dz = target.pos.z - launcher.pos.z;
    const flat = Math.max(1, Math.hypot(dx, dz));
    const loft = 40 * DEG;                       // 撃ち上げ角
    m.dir.set(
      (dx / flat) * Math.cos(loft),
      Math.sin(loft),
      (dz / flat) * Math.cos(loft),
    ).normalize();
    m.speed = 80;                                 // 発射直後は低速
    m.accel = (weapon.speed - m.speed) / Math.max(0.5, m.boostTime * 0.6);

    this.world.missiles.push(m);
    this.world.detection?.markAttacked(launcher.side, target);
    this.world.onFire?.(launcher, target, weapon, m);
    return m;
  }

  // ------------------------------------------------------------ 機銃

  /**
   * 機銃。実体弾を撒く（§22.2）。
   *
   * ここでやるのは「狙点を作って、拡散をかけて弾を出す」ことだけ。
   * 当たるかどうかは弾の側（sim/bullet.js）が決める。
   */
  _tryGun(shooter, target, dt) {
    if (shooter.gun <= 0) return;
    const g = shooter.spec.gunSpec;
    if (!g) return;
    if (shooter.autoWeapons && shooter.autoWeapons.GUN === false) return;

    const dist = shooter.pos.distanceTo(target.pos);
    if (dist > GUN_MAX_ENGAGE) return;
    // 弾が届かない距離では撃たない（寿命×初速が実射程）
    if (dist > g.muzzleSpeed * BULLET_LIFE * 0.95) return;

    // 偏差射撃の狙点。機首をそこへ向けられていなければ撃てない。
    aimPointOf(shooter, target, g.muzzleSpeed, _aimPt);
    const ax = _aimPt.x - shooter.pos.x;
    const az = _aimPt.z - shooter.pos.z;
    const ay = _aimPt.y - shooter.pos.y;
    const air = target.kind === 'aircraft' && !target.onGround;
    if (offBoresight(shooter, ax, az, ay) > (air ? GUN_AIM_CONE : GUN_AIM_CONE_GROUND)) return;

    // 当たりそうにないなら撃たない。
    // **射程制限を捨てた代わりがこれ**（§22.2.4）。これが無いと、
    // 弾の届く3km手前から乱射して弾倉を空にする。
    const need = GUN_THRESHOLD[shooter.fireThreshold || 'mid'] ?? GUN_THRESHOLD.mid;
    if (estimateGunHit(shooter, target) < need) return;

    // 視線が通っていること（山越しには撃てない）
    const losPoint = target.kind === 'aircraft'
      ? target.pos : _v4.set(target.pos.x, target.pos.y + 40, target.pos.z);
    if (!this.world.terrain.hasLineOfSight(shooter.pos, losPoint, 8, 300)) return;

    // 発射数は端数を持ち越す。dt が小さいと毎回0発になってしまう。
    shooter._gunAccum = (shooter._gunAccum || 0) + GUN_RPS * dt;
    let n = Math.floor(shooter._gunAccum);
    if (n <= 0) return;
    shooter._gunAccum -= n;
    n = Math.min(n, Math.floor(shooter.gun));
    if (n <= 0) return;
    shooter.gun -= n;

    const spread = gunSpread(shooter, g);
    const dmg = air ? g.airDmg : g.groundDmg;
    const rng = this.world.rng;

    _aimDir.set(ax, ay, az).normalize();
    for (let i = 0; i < n; i++) {
      scatter(_aimDir, spread, rng, _shotDir);
      this.world.bullets.push(new Bullet({
        pos: shooter.pos,
        dir: _shotDir,
        speed: g.muzzleSpeed,
        damage: dmg[0] + rng() * (dmg[1] - dmg[0]),
        shooter,
      }));
    }
    this.world.onGunFire?.(shooter, target, n);
  }

  // ------------------------------------------------------------ デコイ

  /**
   * フレア／チャフを投射する。
   * 飛来中のミサイルは、誘導方式が噛み合えば一定確率でデコイへ移る。
   */
  deployDecoy(unit, kind) {
    if (kind === 'flare' && unit.flares <= 0) return false;
    if (kind === 'chaff' && unit.chaff <= 0) return false;
    if (kind === 'flare') unit.flares--; else unit.chaff--;

    const f = unit.forward(_v1);
    const vel = new THREE.Vector3(
      -f.x * unit.speed * 0.25 + (this.world.rng() - 0.5) * 30,
      -25,
      -f.z * unit.speed * 0.25 + (this.world.rng() - 0.5) * 30,
    );
    const decoy = new Decoy({ kind, pos: unit.pos, vel, side: unit.side });
    this.world.decoys.push(decoy);
    this.world.onDecoy?.(unit, kind);

    // 飛来中のミサイルを引き付ける。
    //
    // **これはフレアだけの仕組み**（§35.2）。赤外線シーカーは
    // 「より明るいもの」を追うので、囮に乗り換えるという形になる。
    //
    // チャフは引き付けない。**電波を通さない雲＝壁**であって、
    // レーダーが追いかける偽の目標ではない。
    // その働きは `Missile._deceived`（真横を向いた機体が紛れる背景）と
    // `Missile._screened`（背を向けて逃げる機体と追う側の間に立つ壁）にある。
    if (kind === 'flare') {
      for (const m of this.world.missiles) {
        if (!m.alive || m.target !== unit || m.lost) continue;
        if (!decoyMatches(m.guidance, kind)) continue;
        const chance = (1 - m.weapon.decoyResist)
          * decoyFactor(m.pos.distanceTo(unit.pos))
          * flareFactor(unit, m)
          * decoyRepeatFactor(m._decoyTries);
        m._decoyTries++;
        if (this.world.rng() < chance) {
          m.seekTarget = decoy;
          this.world.onDecoyed?.(m, decoy);
        }
      }
    }
    return true;
  }
}

// ---------------------------------------------------------------- 幾何

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
// 機銃用（狙点・射線・拡散の基底）
const _aimPt = new THREE.Vector3();
const _aimDir = new THREE.Vector3();
const _shotDir = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();

/** 機首方向と目標方向のなす角(rad) */
function offBoresight(shooter, dx, dz, dy) {
  const flat = Math.hypot(dx, dz);
  const bearing = headingOf(dx, dz);
  const yaw = Math.abs(angleDiff(bearing, shooter.heading));
  const pitch = Math.abs(Math.atan2(dy, Math.max(1, flat)) - (shooter.pitch || 0));
  return Math.hypot(yaw, pitch);
}

/**
 * 自機のレーダー扇に入っているか。
 *
 * @param {boolean} lock ロック（STT）の扇で見るか（§28.7）。
 *   **セミアクティブ（AAM-M）は必ずこちら。** 索敵の扇で発射を許すと、
 *   ロックの扇の外にいる目標へ撃ててしまい、**発射した瞬間に誘導が切れる**。
 *   実際そうなっていて、誘導喪失26件のうち18件が「機首から25度ちょうど」だった。
 */
function inRadarFan(shooter, dx, dz, dy, flat, lock = false) {
  const spec = shooter.spec;
  // レーダーを切っていれば扇そのものが無い（§26.4）。
  // AAM-M も AAM-A も、ここを通れないので撃てなくなる。
  const range = shooter.radarRange != null ? shooter.radarRange : (spec && spec.radarRange) || 0;
  if (!spec || range <= 0) return false;
  if (Math.hypot(flat, dy) > range) return false;
  if (spec.omniRadar) return true;
  const fovH = lock ? (spec.radarLockFovH ?? spec.radarFovH ?? 60) : (spec.radarFovH || 60);
  const fovV = lock ? (spec.radarLockFovV ?? spec.radarFovV ?? 30) : (spec.radarFovV || 30);
  if (Math.abs(angleDiff(headingOf(dx, dz), shooter.heading)) > fovH * DEG) return false;
  if (Math.abs(Math.atan2(dy, Math.max(1, flat))) > fovV * DEG) return false;
  return true;
}
