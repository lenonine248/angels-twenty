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
  if (flat > 4000 && above > 0 && above < PERCH_ALT) {
    // 少し上に付けて入る。降下ぶんが速度になる
    return target.pos.y + PERCH_ALT;
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
 * @returns {{heading:number, phase:'in'|'out', flat:number}}
 */
export function groundAttackRun(self, target) {
  const dx = target.pos.x - self.pos.x;
  const dz = target.pos.z - self.pos.z;
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
