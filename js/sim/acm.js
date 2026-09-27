// 空戦機動。仕様書 §22.3。
//
// 「何を狙うか」は ai/pilot.js が決める。ここが決めるのは **どう飛んで狙うか**。
// 攻撃指示を受けた機体が、空中目標に対して取る針路・高度・速度を返す。
//
// 設計の方針:
//
//   **機動はモードとして持たせない。幾何から選ぶ。**
//   プレイヤーは既に AI モード（哨戒／追撃／連携…）を選んでいる。
//   そこへ「機動の種類」という二つ目の軸を足すと、操作が増えるだけで
//   指揮官の判断としては細かすぎる。実際のパイロットが距離・角度・
//   エネルギーから機動を選ぶのと同じで、ここは状況から自動で選ぶ。
//
//   **機銃が実体弾になったことで、機動が結果に直結するようになった**（§22.2）。
//   旋回すれば相手の偏差が狂って当たらなくなる。追い抜けば撃てる位置を失う。
//   以前の「後方420mを保つ」という速度制御は、その場しのぎでこれを代用していた。
//   ここではラグパーシュート（後方を狙う追尾曲線）で正しく解く。

import { headingOf, angleDiff, DEG } from './unit.js';
import { clamp } from '../core/rng.js';
import { WEAPONS } from '../data/weapons.js';

/** 追尾曲線の種類 */
export const PURSUIT = {
  LEAD: 'lead',       // 未来位置を狙う。角度を素早く詰める
  PURE: 'pure',       // 目標そのものを狙う
  LAG: 'lag',         // 後方を狙う。行き過ぎを防ぎ、位置を保つ
  TRACK: 'track',     // 射撃姿勢。機首を狙点へ向け、距離を保って撃つ
  EXTEND: 'extend',   // いったん離れて速度を回復し、態勢を立て直す
  BREAK: 'break',     // 防御。後ろに付かれたら全力で旋回して照準を外す
};

/** ラグに移る距離(m)。機銃の当たる距離より外から構え始める */
const LAG_RANGE = 2200;
/** これ以上詰めたら行き過ぎる、という距離(m) */
const MIN_RANGE = 260;
/** ここまで近づいたら速度を緩める(m)。通り抜けと衝突を防ぐぶんだけ */
const MERGE_RANGE = 700;
/** 保ちたい距離(m)。機銃が当たり、かつ追い抜かない位置 */
const HOLD_RANGE = 450;
/**
 * 射撃姿勢に移る距離(m)。
 * ラグは機首を目標から外して飛ぶ機動なので、そのままでは機銃を撃てない
 * （機首から14°以内でないと撃てない）。**位置に付いたら狙いに切り替える**。
 */
const TRACK_RANGE = 950;
/** ラグの最大オフセット角。大きすぎると目標を扇から外す */
const LAG_MAX = 32 * DEG;
/**
 * ラグを使ってよい速度優位(m/s)。
 *
 * ラグは**追い越しそうなときに外側を回る**機動なので、
 * 速度が同じ相手にやると、機首を外したぶんだけ接近が遅れて永久に詰められない
 * （実測で同速の相手に 1,270m で止まったまま2分粘った）。
 */
const LAG_MIN_ADVANTAGE = 25;
/** 追い越さないための余剰速度の上限(m/s)。物理の逆算にかぶせる蓋 */
const CLOSURE_CAP = 70;
/**
 * 実効的な減速力。`spec.accel` そのものではない。
 * 飛行モデル側は `decelLimit = thrust * 0.6`（降下中は 0.15）で頭打ちにしており、
 * さらに高空では推力自体が落ちる。指令と実速度の差に 0.6 を掛ける制御でもあるので、
 * 額面の加速度で逆算すると**1.7倍ほど速く突っ込む**ことになる（実際に追い越した）。
 */
const DECEL_FRACTION = 0.30;
/** リードに使う先読み時間の上限(秒) */
const LEAD_MAX_TIME = 4;

/** 態勢を立て直す（エクステンド）に入る速度の下限。巡航に対する比 */
const LOW_ENERGY = 0.62;
/** エクステンドを打ち切る速度。巡航に対する比 */
const RECOVER_ENERGY = 0.95;

/** 上から入るときに使う高度差(m)。これ以上高ければ降下して速度に変える */
const PERCH_ALT = 900;

/**
 * プレイヤーが指定した高度を、目標の高度へ合わせ始めるまで保つ距離(m)。
 * **持っている兵装で変える**（§6.2.5）。
 *
 * `sarh`（AAM-M）は**着弾まで**目標をレーダーの扇（上下±30°）に入れ続ける
 * 必要がある。高度差を抱えたまま近づくと飛翔中に扇から外れて誘導が切れるので、
 * 発射したあとすぐ合わせ始める必要がある。実測の発射距離は 13〜16km。
 *
 * 撃ちっぱなしの兵装（AAM-S の赤外線 / AAM-A のアクティブ）は、
 * 発射の瞬間にシーカーへ入っていればよい。実測の発射距離は 2〜4km なので、
 * 指定高度をずっと近くまで保てる。
 */
const ALT_HANDOFF_GUIDED = 12000;
const ALT_HANDOFF_FREE = 6000;

/**
 * 防御機動に入る、後ろの敵との距離(m)。**練度で縮む**。
 *
 * 機銃が当たり始めるのは 800m 前後。ここを 1,600m まで広げると
 * 「撃たれてもいないのに延々と回避する」ことになり、950m まで詰めると
 * 実戦ではほとんど発動しなくなる（測ったところ、交戦の 95% は 950m 以遠で
 * 起きていた）。撃たれうる距離のすぐ外を取る。
 *
 * `skill` は「判断の速さ・撃つ判断・機銃の当たりやすさ・**回避の質**に
 * まとめて効く」ダイヤルだが（sim/aircraft.js）、ブレイクだけがこれを見て
 * いなかった。結果、**練度0.2の相手も満点の相手とまったく同じ精度で振り切る**。
 * ブレイクされた相手には機銃がほぼ当たらないので（実測で被弾 285 → 4）、
 * 練度を下げても機銃で落とせないままだった。
 * 未熟な相手は気づくのが遅い、という形で効かせる。満点なら従来どおり。
 */
const BREAK_RANGE = 1200;
/** 練度が最低のときに残る割合 */
const BREAK_SKILL_FLOOR = 0.35;
/** 後ろと見なす角度 */
const BREAK_CONE = 45 * DEG;

/**
 * 空中目標への攻撃機動。
 *
 * @returns {{heading:number, alt:number, speed:number, mode:string}}
 */
export function attackManeuver(self, target, world) {
  const dx = target.pos.x - self.pos.x;
  const dz = target.pos.z - self.pos.z;
  const flat = Math.hypot(dx, dz);
  const bearing = headingOf(dx, dz);

  // 目標の尾部からの角度。**0 = 真後ろ、PI = 正面**。
  // 「目標から自分への方位」と「目標の進行方向の逆」を比べる。
  // 進行方向そのものと比べると真後ろが PI になり、判定が裏返る（実際に裏返っていた）。
  const tailAspect = Math.abs(angleDiff(headingOf(-dx, -dz), target.heading + Math.PI));
  // 自分から見て目標がどれだけ機首から外れているか
  const angleOff = Math.abs(angleDiff(bearing, self.heading));

  const mode = choosePursuit(self, target, flat, tailAspect, angleOff);

  switch (mode) {
    case PURSUIT.EXTEND: return extend(self, target, world, bearing, flat);
    case PURSUIT.TRACK:  return track(self, target, bearing, flat);
    case PURSUIT.LAG:    return lag(self, target, bearing, flat);
    case PURSUIT.LEAD:   return lead(self, target, bearing, flat);
    default:             return pure(self, target, bearing, flat);
  }
}

/**
 * 保ってよい速度。
 *
 * **減速には距離が要る**。900m 手前から全速で突っ込むと、
 * 保ちたい距離に着くまでに減速が間に合わず、必ず追い越す
 * （実測で 950m から入って 112m まで詰めてしまった）。
 * 「その距離で止まれる速度」を逆算して上限にする。
 *   余剰速度 = sqrt(2 × 加速度 × 詰めてよい距離)
 */
function closureLimit(self, target, flat) {
  const room = Math.max(0, flat - HOLD_RANGE);
  const decel = self.spec.accel * DECEL_FRACTION;
  const excess = Math.min(CLOSURE_CAP, Math.sqrt(2 * decel * room));
  return (target.speed || 0) + excess;
}

/**
 * どの追尾曲線を使うか。
 *
 * 判断材料は「距離」「相手のどちら側にいるか」「自分に速度が残っているか」の3つ。
 * ここに乱数は入れない。同じ状況で同じ動きをしないと、
 * プレイヤーが挙動を読めず「なんとなく動いている」ようにしか見えない。
 */
/**
 * まだ空対空ミサイルを使えるか。
 *
 * ラグは**機銃のための機動**で、機首を目標から外して飛ぶ。
 * ミサイルが残っているのにこれをやると、撃てるはずの間合いで
 * 機首を外して撃たないままになる（実戦の 95% は銃の間合いの外で起きる）。
 */
function hasMissile(self) {
  for (const id of self.loadout) {
    const w = WEAPONS[id];
    if (!w || w.kind !== 'aam') continue;
    if (self.autoWeapons && self.autoWeapons[id] === false) continue;
    return true;
  }
  return false;
}

function choosePursuit(self, target, flat, tailAspect, angleOff) {
  // 速度を失っていたら、まず立て直す。曲がり続けても当てられない。
  if (self.speed < self.spec.cruiseSpeed * LOW_ENERGY && flat < 6000) return PURSUIT.EXTEND;
  // 立て直し中は、速度が戻るまで続ける（毎tickで行き来させない）
  if (self._acmExtending && self.speed < self.spec.cruiseSpeed * RECOVER_ENERGY) return PURSUIT.EXTEND;

  // 本当に通り過ぎてしまったときだけ、離れて態勢を作り直す。
  // 距離を広く取ると、旋回中の一瞬の角度で立て直しに入ってしまい、
  // 撃てる位置に居るのに40秒かけて往復することになる（実際にそうなった）。
  if (angleOff > 120 * DEG && flat < 1200) return PURSUIT.EXTEND;

  // 遠いうちは未来位置を狙って角度ごと詰める
  if (flat > LAG_RANGE) return PURSUIT.LEAD;

  // ミサイルが残っているなら、機首を目標に向けたまま戦う。
  // ここで距離を保ちにいってはいけない。逃げる相手に速度を合わせてしまい、
  // 追い付けないまま終わる（実測で撃墜が 2.0 → 1.5 に落ちた）。
  // ぶつかる寸前だけ緩める。
  if (hasMissile(self)) return PURSUIT.PURE;

  // ここから先は機銃で仕留める場合。
  // 後ろに付けていないなら素直に狙う（正面でラグを使っても意味がない）。
  if (tailAspect >= 70 * DEG) return PURSUIT.PURE;

  // 後方に付けている。まだ遠ければラグで詰める（行き過ぎを防ぐ）。
  // ただし速度優位が無いならラグにしない。詰められなくなる。
  if (flat > TRACK_RANGE) {
    return self.speed > (target.speed || 0) + LAG_MIN_ADVANTAGE
      ? PURSUIT.LAG : PURSUIT.PURE;
  }

  // 撃てる位置に入った。狙いに切り替える。
  return PURSUIT.TRACK;
}

/** リード: 未来位置を狙う */
function lead(self, target, bearing, flat) {
  const t = clamp(flat / Math.max(60, self.speed), 0, LEAD_MAX_TIME);
  const tx = target.pos.x + Math.sin(target.heading) * target.speed * t;
  const tz = target.pos.z - Math.cos(target.heading) * target.speed * t;
  return {
    heading: headingOf(tx - self.pos.x, tz - self.pos.z),
    alt: approachAlt(self, target, flat),
    speed: self.altitudeMaxSpeed * 0.95,
    mode: PURSUIT.LEAD,
  };
}

/**
 * ピュア: 目標そのものを狙う。
 * 速度は落とさない。**ぶつかる寸前だけ**緩めて、通り抜けを防ぐ。
 */
function pure(self, target, bearing, flat) {
  let speed = self.altitudeMaxSpeed * 0.92;
  if (flat < MERGE_RANGE) speed = Math.min(speed, closureLimit(self, target, flat));
  return {
    heading: bearing,
    alt: approachAlt(self, target, flat),
    speed,
    mode: PURSUIT.PURE,
  };
}

/**
 * ラグ: 目標の**後方**を狙う。
 *
 * 目標へ真っ直ぐ向かうと、速度差のぶんだけ必ず追い越す。
 * 後ろへずらして飛ぶと、相手の旋回に対して外側を回ることになり、
 * 追い越さずに後方の位置を保てる。距離が開いたらずらし量を減らして詰める。
 */
function lag(self, target, bearing, flat) {
  // 近いほど強くずらす。射撃姿勢に移る距離で最大になり、そこで滑らかに繋がる。
  const closeness = clamp((LAG_RANGE - flat) / (LAG_RANGE - TRACK_RANGE), 0, 1);
  // 目標の後方側へずらす（目標の進行方向と逆へ回り込む）
  const side = angleDiff(bearing, target.heading) >= 0 ? 1 : -1;
  const offset = LAG_MAX * closeness * side;

  return {
    heading: bearing + offset,
    alt: target.pos.y,
    // ラグの段階から減速を始める。ここで詰めすぎると射撃姿勢に入れない。
    speed: Math.min(self.altitudeMaxSpeed * 0.92, closureLimit(self, target, flat)),
    mode: PURSUIT.LAG,
  };
}

/**
 * トラック（射撃姿勢）: 機銃の狙点へ機首を向け、距離を保つ。
 *
 * ラグで位置を作ったあとの仕上げ。狙点は弾速から出す偏差なので、
 * 弾の遅い機体ほど大きく前を狙うことになり、目標が曲がると外れる。
 * 距離は保つが、速度差はミサイル回避のように急がない（撃つ時間を作る）。
 */
function track(self, target, bearing, flat) {
  const muzzle = (self.spec.gunSpec && self.spec.gunSpec.muzzleSpeed) || 900;
  const t = clamp(flat / muzzle, 0, 1.5);
  const tx = target.pos.x + Math.sin(target.heading) * target.speed * t;
  const tz = target.pos.z - Math.cos(target.heading) * target.speed * t;

  // 距離を保つ。近すぎれば緩め、離れれば詰める。
  let speed = closureLimit(self, target, flat);
  if (flat < HOLD_RANGE) speed = target.speed + clamp((flat - HOLD_RANGE) * 0.08, -24, 0);
  if (flat < MIN_RANGE) speed = Math.min(speed, target.speed * 0.88);
  speed = Math.min(speed, self.altitudeMaxSpeed * 0.92);

  return {
    heading: headingOf(tx - self.pos.x, tz - self.pos.z),
    alt: target.pos.y,
    speed,
    mode: PURSUIT.TRACK,
  };
}

/**
 * エクステンド: 離れて速度を取り戻す。
 *
 * 曲がり続けると誘導抗力で速度を失い（§5.2.1）、
 * やがて曲がることも撃つこともできなくなる。
 * いったん直線で離れ、降下して速度に変えてから入り直す。
 */
function extend(self, target, world, bearing, flat) {
  self._acmExtending = true;
  const floor = self._terrainFloor ? self._terrainFloor(world, bearing + Math.PI) + 250 : 400;
  return {
    heading: bearing + Math.PI,                    // 目標から離れる
    alt: Math.max(floor, self.pos.y - 1200),       // 降下して速度に変える
    speed: self.altitudeMaxSpeed,
    mode: PURSUIT.EXTEND,
  };
}

/**
 * 誘導を保ち続ける必要のある兵装（セミアクティブ）を持っているか。
 * 持っているなら、早めに高度を合わせないと誘導が切れる。
 */
function needsGuidedHandoff(self) {
  for (const id of self.loadout) {
    const w = WEAPONS[id];
    if (!w || w.kind !== 'aam') continue;
    if (self.autoWeapons && self.autoWeapons[id] === false) continue;
    if (w.fireAndForget === false) return true;
  }
  return false;
}

/**
 * 接近中の高度。
 *
 * **プレイヤーが高度を指定していれば、交戦の間合いに入るまでそれを保つ。**
 * 高度は速度に変えられる資産で（§5.2.1）、高く置くか低く置くかは
 * 指揮官の判断そのもの。遠いうちから目標に合わせて捨ててしまうと、
 * 指定した意味が無くなる。
 *
 * 指定が無ければ従来どおり、目標の高度に合わせて近づく。
 */
function approachAlt(self, target, flat) {
  const hold = self.commandedAlt;
  if (hold != null) {
    const handoff = needsGuidedHandoff(self) ? ALT_HANDOFF_GUIDED : ALT_HANDOFF_FREE;
    if (flat > handoff) return hold;
  }
  const above = self.pos.y - target.pos.y;
  if (flat > 4000 && above > 0) {
    // 少し上に付けて入る。降下ぶんが速度になる。
    //
    // **段差にしない。** 以前は `above < PERCH_ALT` の内側でだけ
    // 「目標＋900m」を指令していたので、登ってしきい値を越えた瞬間に
    // 指令が目標と同高度へ落ち、降りるとまた上がった。
    // 実測で**毎秒ほぼ1回**上下の向きが反転していた（接近中にだけ起きる）。
    //
    // 上に行くほど上乗せを減らす形にすると、ちょうど PERCH_ALT で釣り合って
    // **そこに落ち着く**。狙い（少し上に付ける）はそのままで、輪だけが消える。
    // 上限を単に外すと、高いところから降りてこなくなって別の問題が出た
    // （実測でミッション1のクリアが 5/6 → 3/6）。
    const taper = clamp(1 - (above - PERCH_ALT) / PERCH_ALT, 0, 1);
    // **上へは追わない**（§98.3）。上に付けるために登ると、下の側は
    // 「相手の高度」へ登ってくるので、追いつかれるたびに +900m を付け直して
    // **撃ち合いが始まるまで両機とも天井まで上がり続けた**（SCRAMBLE で
    // 18戦に22機が 11,000m 超）。上にいるならその高度を保ち、
    // 高すぎるぶんだけ上の式どおり降りる。
    return Math.min(self.pos.y, target.pos.y + PERCH_ALT * taper);
  }
  return target.pos.y;
}

/**
 * 防御機動。後ろに付かれていたら、全力で旋回して相手の照準を外す。
 *
 * 機銃が実体弾になったので、これは演出ではなく効く（§22.2）。
 * 旋回すると相手の偏差の見積りが崩れ、命中期待度がしきい値を割って
 * 撃つのをやめる。曲がらずに逃げるのがいちばん撃たれる。
 *
 * @returns {?{heading:number, alt:number, speed:number, mode:string}}
 */
export function defensiveManeuver(self, world) {
  const threat = gunThreatBehind(self, world);
  if (!threat) { self._acmBreak = null; return null; }

  const dx = threat.pos.x - self.pos.x;
  const dz = threat.pos.z - self.pos.z;
  const bearing = headingOf(dx, dz);

  // 旋回方向は一度決めたら保つ。毎tick選び直すと左右にばたついて、
  // 旋回率が上がらず「曲がっているのに当たる」ことになる。
  if (self._acmBreak == null) {
    self._acmBreak = angleDiff(bearing + Math.PI / 2, self.heading) > 0 ? 1 : -1;
  }
  return {
    heading: bearing + self._acmBreak * (Math.PI / 2),   // 脅威を真横に置く
    alt: Math.max(300, self.pos.y - 700),                // 降下して旋回率を稼ぐ
    speed: self.altitudeMaxSpeed,
    mode: PURSUIT.BREAK,
  };
}

/** 自分の後方で、機銃を当てられる位置に付いている敵機 */
function gunThreatBehind(self, world) {
  const skill = self.skill != null ? self.skill : 1;
  let best = null, bestD = BREAK_RANGE * (BREAK_SKILL_FLOOR + (1 - BREAK_SKILL_FLOOR) * skill);
  for (const u of world.units) {
    if (!u.alive || u.kind !== 'aircraft' || u.side === self.side || u.onGround) continue;
    if (u.gun <= 0) continue;
    const dx = u.pos.x - self.pos.x, dz = u.pos.z - self.pos.z;
    const d = Math.hypot(dx, dz);
    if (d > bestD) continue;
    // 自分の後方にいるか（自分から相手への方位が、自分の尾部方向に近いか）
    if (Math.abs(angleDiff(headingOf(dx, dz), self.heading + Math.PI)) > BREAK_CONE) continue;
    // 相手がこちらへ機首を向けているか（向いていなければ撃てない）
    if (Math.abs(angleDiff(headingOf(-dx, -dz), u.heading)) > 30 * DEG) continue;
    best = u; bestD = d;
  }
  return best;
}

// ---------------------------------------------------------------- 対地

/**
 * 通り抜けたと見なす距離(m)と角度。
 * 遠くで機首が振れただけで「通り過ぎた」と誤判定しないよう、近いときだけ見る。
 */
const PASS_RANGE = 2500;
const PASS_ANGLE = 80 * DEG;
/**
 * 入り直すまでに取る距離(m)。
 *
 * 180度の反転に要る直径ぶんは、進入区間として使えない。
 * 200m/s・旋回率9°/s なら直径 2.5km 前後なので、これを引いてもなお
 * 機銃の間合い(3.2km)の外から真っ直ぐ入れる距離を取る。
 */
const REATTACK_RANGE = 3500;

/**
 * 対地の攻撃パス。仕様書 §22.5。
 *
 * 目標へ真っ直ぐ向かうだけだと、上を通り過ぎた瞬間に方位が反転して
 * 引き返し、また通り過ぎる。結果として**目標を中心に回り続ける**。
 * 旋回しっぱなしなので機銃は拡散が広がって撃てず（§22.2）、
 * 爆弾も投下点に乗らない。実測では17ダメージを与えたあと、
 * **150秒かけて5周し、一発も撃たないまま燃料切れで帰投**した。
 *
 * 通り抜けたら**いったん真っ直ぐ離れ、距離を取ってから入り直す**。
 * 直線の進入区間ができるので、機銃も爆弾も狙いが安定する。
 *
 * `aimPos` は「そこに居ると思っている位置」（§25.4）。掴み違えていれば
 * そこへ向かう。真の位置へ飛びながら別の座標へ投下する、という食い違いを避ける。
 *
 * @returns {{heading:number, phase:'in'|'out', flat:number}}
 */
/** 重力加速度(m/s^2)。無誘導爆弾の弾道解に使う */
export const G = 9.8;

/**
 * 偏差の掛け率。1 で「落下時間ぶんきっちり先」（§32.5）。
 * 下げると手前に落ちる —— 実装の都合ではなく味の調整用に残してある。
 */
const BOMB_LEAD = 1;

/**
 * 無誘導爆弾の弾道解（§71.6）。
 *
 * 落下時間は**高度だけ**で決まり、水平距離には依らないので一度で解ける。
 * 母機の上下速度を含めた `h = -vy·t + g·t²/2` を t について解く。
 *
 * 爆弾の初速はこの式と同じ `speed·(cos p, sin p)`（`missile.js`・§95）。
 *
 * @param {object} shooter 投下する機体
 * @param {number} aimY    狙点の標高(m)
 * @param {number} [pitch] 上昇角。省けば今の上昇角 —— トスの「いま上げたら届く距離」を
 *                         仮の角で解くときだけ渡す（§95）
 * @returns {{h:number, fallTime:number, throwRange:number}}
 *   h … 狙点からの高度差 / throwRange … 投下点から着弾点までの水平距離
 */
export function bombSolution(shooter, aimY, pitch = shooter.pitch || 0) {
  const h = shooter.pos.y - aimY;
  const vy = shooter.speed * Math.sin(pitch);
  const vh = shooter.speed * Math.cos(pitch);
  const fallTime = (vy + Math.sqrt(Math.max(0, vy * vy + 2 * G * h))) / G;
  return { h, fallTime, throwRange: vh * fallTime };
}

/**
 * 無誘導爆弾で狙うべき点 —— **目標がそこへ来るまでの先**（§71.6）。
 *
 * §32.5 でこの計算自体は入っていたが、**投下の判定側が受け取っていなかった**。
 * 判定は「機首方位±16°の円錐」だったので、偏差が針路の横へ出る
 * **真横からの進入では、ずらした点と現在位置が同じ窓に入って**しまい、
 * 偏差が結果に一切届かなかった。正面から入ったときだけ効いていた
 * （そのときは偏差が距離の差になり、距離の窓が拾っていた）。
 *
 * 進入の狙点にも、投下の判定にも**同じこの点**を使う。
 * 進入がここを向いていないと、正しい判定を入れても窓に入れない。
 */
export function bombAimPoint(shooter, target, aimPos) {
  const sol = bombSolution(shooter, aimPos.y);
  let x = aimPos.x, z = aimPos.z;
  if (target.speed > 0 && target.heading != null) {
    const lead = target.speed * sol.fallTime * BOMB_LEAD;
    x += Math.sin(target.heading) * lead;
    z -= Math.cos(target.heading) * lead;
  }
  return { x, y: aimPos.y, z, fallTime: sol.fallTime, throwRange: sol.throwRange, h: sol.h };
}

/**
 * その機体・その瞬間に爆弾が落ちる地点（§71.6）。
 *
 * 爆弾は**機首方向へ**投げ出される。狙点への方位ではない ——
 * ここを取り違えていたのが偏差が効かなかった原因なので、式として分けて置く。
 */
export function bombImpactPoint(shooter, throwRange) {
  return {
    x: shooter.pos.x + Math.sin(shooter.heading) * throwRange,
    z: shooter.pos.z - Math.cos(shooter.heading) * throwRange,
  };
}

export function groundAttackRun(self, target, aimPos = target.pos) {
  const dx = aimPos.x - self.pos.x;
  const dz = aimPos.z - self.pos.z;
  const flat = Math.hypot(dx, dz);
  const bearing = headingOf(dx, dz);

  // 目標が変わったら仕切り直す
  if (self._runTarget !== target) {
    self._runTarget = target;
    self._runPhase = 'in';
  }

  const angleOff = Math.abs(angleDiff(bearing, self.heading));
  if (self._runPhase === 'out') {
    if (flat > REATTACK_RANGE) self._runPhase = 'in';
  } else if (flat < PASS_RANGE && angleOff > PASS_ANGLE) {
    self._runPhase = 'out';
    // 抜けた向きへそのまま離れる。方位の反対を狙うと、
    // 通り抜けざまに向きを変えることになって直線にならない。
    self._runHeading = self.heading;
  }

  return {
    heading: self._runPhase === 'out' ? self._runHeading : bearing,
    phase: self._runPhase,
    flat,
  };
}

/**
 * トス爆撃の定数（§95）。**書き換えられるように1つの入れ物にしてある** ——
 * 計測の道具（`tools/_tossai.js`）が値を差し替えて比べるため。本体は書き換えない。
 */
export const TOSS = {
  /** 離脱は、投げられる距離よりこれだけ離れてから入り直す(m) */
  reentry: 3000,
  /**
   * 機首上げを窓の手前へずらす量（爆風半径に掛ける）。
   *
   * 機首を上げた瞬間に落下点が**この量だけ手前へ跳び、そこで1発目が出る**（§95.5）。
   * 初めは 0.8（窓の手前の縁から入れて一連投下で目標を挟む）にしたが、上昇中は落下点が
   * 速く走るので2発目は奥へ離れ、挟むにならなかった。0.1 にすると1発目が目標の上に落ち、
   * A-3 は平均 1.0 発で 6/6 撃破（0.8 では 2.0 発）。0 にしないのは、刻みの遅れで
   * 跳んだ先が窓の奥へ出ると一発も放さないため（§95.1）。
   */
  pullLead: 0.1,
  /** 機首を上げてよい、目標への方位のずれ(rad)。4倍を超えたら上げるのをやめる */
  align: 10 * DEG,
  /**
   * 機首上げ中の爆弾の投下間隔(秒)。水平の一連投下（`combat.js` の `BOMB_COOLDOWN`）と
   * 同じ値から始める。上昇中は落下点が速く前へ走るので、間隔が同じでも着弾は散る
   */
  releaseInterval: 0.5,
  /**
   * 進入 `in`・離脱 `out` の床に見込む上昇の余地（§95.9）。先読みした地形のうち、
   * **そこへ着くまでに `この値 × climbRate` で登れるぶん**を差し引く。0 で見込まない（今までの床）。
   *
   * 今までの床は「先読み 4〜11km の最高点＋220m」で、稜線のずっと手前から稜線の上を飛び、
   * 高所の SAM から見えていた。c3 で 0.6／0.8／1.0 を測り、1.0 で初めて地形に衝突した
   * （15本中1件）。0.8 は 45本で衝突 0・最低の地上高 88m
   */
  climbCredit: 0.8,
  /** 機首上げは「投射の床」（`tossClearAlt`）のこれだけ下まで来てから(m) */
  clearTol: 30,
  /** 弾道が地形からこれだけ離れていれば「越えた」とみなす(m) */
  pathClearance: 15,
};

/**
 * 爆弾の弾道が、落下点に着くまでに地形へ当たらないか（§95.9）。
 *
 * **弾道解（`bombSolution`）は地形を見ない**。低く入ったトスは、落下点が窓に入っていても
 * 目標を囲む谷の縁に当たっていた（c3 で放した弾の 45%・目標から中央値 1.2km）。
 * 放物線を刻んで地形と比べる。落下点の手前 `skipNear` は見ない —— 目標のそばの地面に
 * 落ちるのは外れではない。
 *
 * @param {object} terrain  `world.terrain`
 * @param {{x:number,y:number,z:number}} from 放す位置
 * @param {number} heading  投げる向き
 * @param {number} speed    初速の大きさ（機体の速さ）
 * @param {number} pitch    初速の上昇角
 * @param {number} throwRange 放す位置から落下点までの水平距離
 * @param {number} skipNear 落下点の手前、見ない距離(m)
 * @returns {boolean} 途中で地形に当たらなければ true
 */
export function bombPathClear(terrain, from, heading, speed, pitch, throwRange, skipNear) {
  const vh = Math.max(1, speed * Math.cos(pitch));
  const vy = speed * Math.sin(pitch);
  const sx = Math.sin(heading), sz = -Math.cos(heading);
  const end = throwRange - skipNear;
  for (let s = BOMB_PATH_STEP; s < end; s += BOMB_PATH_STEP) {
    const t = s / vh;
    const y = from.y + vy * t - 0.5 * G * t * t;
    if (y < terrain.heightAt(from.x + sx * s, from.z + sz * s) + TOSS.pathClearance) return false;
  }
  return true;
}

/** `bombPathClear` の刻み(m)。地形の格子より細かくする */
const BOMB_PATH_STEP = 100;

/**
 * トスで投げた弾が目標までの地形を越えられる、いちばん低い投下高度（§95.9）＝**投射の床**。
 *
 * 投げる位置は高さで決まる（高いほど遠くから届く）ので、高さを二分探索する。
 * 投げる向きは今の機体から目標への方位、上昇角は `tossRange` と同じ仮の角。
 * 高いほど投げる位置が遠くなり、弾道が越える地形も変わるので厳密には単調でないが、
 * 探すのは「このくらいまで上がれば越える」の目安で足りる。
 *
 * @returns {{alt:number, range:number}} alt … 絶対高度(m)（上限まで上げても越えなければ上限）、
 *   range … その高さから投げたときの投射距離(m)。呼ぶ側が「どこから上がり始めるか」に使う
 */
export function tossClearAlt(self, aimPos, terrain, blastRadius) {
  const bearing = headingOf(aimPos.x - self.pos.x, aimPos.z - self.pos.z);
  const speed = Math.max(40, self.speed);
  const pitch = Math.atan2(self.climbCap, speed);
  const bx = -Math.sin(bearing), bz = Math.cos(bearing);   // 目標から機体の側へ
  const rangeAt = (y) => bombSolution({ pos: { y }, speed }, aimPos.y, pitch).throwRange;
  const clears = (y) => {
    const range = rangeAt(y);
    const from = { x: aimPos.x + bx * range, y, z: aimPos.z + bz * range };
    return bombPathClear(terrain, from, bearing, speed, pitch, range, blastRadius);
  };
  let lo = aimPos.y, hi = aimPos.y + TOSS_CLEAR_SEARCH;
  if (clears(lo)) hi = lo;
  else if (clears(hi)) {
    while (hi - lo > 25) {
      const mid = (lo + hi) / 2;
      if (clears(mid)) hi = mid; else lo = mid;
    }
  }
  return { alt: hi, range: rangeAt(hi) };
}

/** 投射の床を探す上限（目標からの高さ, m） */
const TOSS_CLEAR_SEARCH = 4000;

/**
 * いま最大上昇に入ったら爆弾が届く水平距離（§95）。
 *
 * 上昇率は `_integrate` で `altErr × 0.9` から即座に上限へ張り付くので、
 * 機首上げは一瞬で入る。その角を仮に渡して弾道解を解く ——
 * 投下の判定と**同じ式**なので、ここで届くと出れば判定もそこで放す。
 */
export function tossRange(self, aimY) {
  const pitch = Math.atan2(self.climbCap, Math.max(40, self.speed));
  return bombSolution(self, aimY, pitch).throwRange;
}

/**
 * トス爆撃の攻撃パス（§95）。進入 `in` → 機首上げ `pull` → 離脱 `out`。
 *
 * 放す瞬間は決めない。投下の判定（`combat.js`）が実落下点で見ているので、
 * 機首を上げれば落下点が前へ伸び、窓に掛かったところで放される。
 * ここが決めるのは**いつ上げるか**と**投げたあとどう離れるか**だけ。
 *
 * **`tossRange` より近くで上げてはいけない**（§95.1）。上げた瞬間に投射距離が
 * 水平投下ぶんからトスの距離へ跳ぶので、跳んだ先が窓の奥なら、落下点は
 * 前へ進むだけで二度と窓へ戻らない（測ったら 20 条件中 6 条件で1発も放さなかった）。
 * 近すぎたら上げずに離れて入り直す。
 *
 * 離脱中は `self._tossEgress` を立てる。爆弾が尽きても離れきるまではこの飛び方を続け、
 * 投げた直後に目標へ向き直らないようにする（呼ぶ側 `aircraft.js` が見る）。
 *
 * `clearAlt`（投射の床・§95.9）を渡すと、**その高さまで来るまでは上げない**。
 * 低く入って谷の縁より下から投げると、弾が縁に当たる。上がりきる前に近づきすぎたら、
 * ほかの「近すぎる」と同じく離れて入り直す。
 *
 * @returns {{heading:number, phase:'in'|'pull'|'out', flat:number}}
 */
export function tossAttackRun(self, target, aimPos, blastRadius, clearAlt = null) {
  const dx = aimPos.x - self.pos.x;
  const dz = aimPos.z - self.pos.z;
  const flat = Math.hypot(dx, dz);
  const bearing = headingOf(dx, dz);

  if (self._runTarget !== target) {
    self._runTarget = target;
    self._runPhase = 'in';
    self._tossEgress = false;
  }

  const reach = tossRange(self, aimPos.y);
  const angleOff = Math.abs(angleDiff(bearing, self.heading));
  if (self._runPhase === 'in') {
    // 上げるのは**目標へ向いてから**。向き直りの途中で上げると、落下点が
    // 針路の横へ出て窓に掛からないまま登り続ける。
    const high = clearAlt == null || self.pos.y >= clearAlt - TOSS.clearTol;
    if (flat < reach - blastRadius) self._runPhase = 'out';
    else if (flat <= reach + TOSS.pullLead * blastRadius && angleOff < TOSS.align && high) {
      self._runPhase = 'pull';
    }
  } else if (self._runPhase === 'pull') {
    // 落下点が窓の奥の縁を越えたら、もう放せない
    const sol = bombSolution(self, aimPos.y);
    const hit = bombImpactPoint(self, sol.throwRange);
    const ahead = ((hit.x - self.pos.x) * dx + (hit.z - self.pos.z) * dz) / Math.max(1, flat);
    if (ahead > flat + blastRadius || angleOff > 4 * TOSS.align) self._runPhase = 'out';
  } else if (flat > reach + TOSS.reentry) {
    self._runPhase = 'in';
  }
  // 以前の `groundAttackRun` の離脱と取り違えないよう、ここで毎回決め直す
  self._tossEgress = self._runPhase === 'out';
  // 途中で水平へ切り替えられたとき、`groundAttackRun` の離脱がこの向きを読む
  if (self._tossEgress) self._runHeading = bearing + Math.PI;

  return {
    heading: self._runPhase === 'out' ? bearing + Math.PI : bearing,
    phase: self._runPhase,
    flat,
  };
}
