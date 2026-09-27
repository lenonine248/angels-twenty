// 飛行場での地上走行の見せ方（§97）。**描画だけ** —— sim の位置にも時間にも触らない。
//
// sim は着陸滑走が止まった瞬間に機体を格納庫の中へ移し（`Airbase.onArrive`）、
// 発進の瞬間に滑走路の始端へ移す（`Airbase.launch`）。どちらも瞬間移動なので、
// そのあいだの走行を描画の側で補う。
//
//   着陸 … 止まった所から先の出口 → 平行誘導路 → 格納庫の扉 → 中へ（縮みながら入って消える）
//   駐機 … 描かない（格納庫の中）
//   発進 … 格納庫 → 誘導路 → 始端。sim はもう滑走を始めているので、数秒で sim の位置へ寄せる
//
// 発進の走行に sim の時間を使わせないのは、**出撃が遅れると遊びが変わる**から。
// 見た目のために整備・発進の時間を動かさない。
//
// 時計は sim の経過秒。一時停止すれば止まり、倍速なら速く進む。
// リプレイは機体の状態を記録していないので、ここは通らない（位置で隠すだけ・`replay.js`）。

import * as THREE from 'three';
import {
  FIELD, fieldPoint, fieldLocal, hangarLocal, isCarrierBase, runwayLengthOf,
} from '../sim/airbase.js';

/**
 * 着陸後の走行の速さ(m/s)。実機（10m/s 前後）よりずっと速い ——
 * 機影は引きの画で 300m 前後に誇張されるので、実機の速さでは止まって見える。
 * 止まった所から格納庫まではおよそ 1〜2km で、20 秒前後
 */
const TAXI_SPEED = 70;
/** 格納庫に入りきったときの機影の大きさ(m)。誇張した機影を棟の幅に収める */
const STOWED_LENGTH = FIELD.hangarWidth * 0.7;
/** 向きは経路の前後この距離(m)を結んで決める。角が丸くなる */
const HEADING_LOOK = 30;

const PARKED = new Set(['parked', 'servicing', 'ready']);

/**
 * 飛行場の上にいる機体の、見た目の姿勢を返す。sim の位置のままでよければ null。
 * @returns {{pos: THREE.Vector3, heading: number, scale: number, hidden: boolean} | null}
 */
export function airfieldPose(ac, now, size) {
  const ud = ac.view?.userData;
  if (!ud) return null;
  const prev = ud.fieldState;
  const state = ac.state;
  ud.fieldState = state;
  const ab = ac.airbase;
  if (!ac.alive || !ab) { ud.taxi = null; return null; }

  let pose = null;
  if (PARKED.has(state)) {
    if (prev === 'landing' && ud.stopPos) {
      ud.taxi = { kind: 'in', path: makePath(taxiInPoints(ab, ud.stopPos, ac.pos)), t0: now };
    }
    const taxi = ud.taxi?.kind === 'in' ? ud.taxi : null;
    if (taxi) {
      const s = (now - taxi.t0) * TAXI_SPEED;
      if (s < taxi.path.length) pose = taxiPose(taxi.path, s, size, 'in');
      else ud.taxi = null;
    }
    if (!pose) pose = { pos: ac.pos, heading: ac.heading, scale: 1, hidden: true };
  } else if (state === 'takeoff') {
    if (PARKED.has(prev) && ud.shownPos) {
      const path = makePath(taxiOutPoints(ab, ud.shownPos));
      // 格納庫の中から出るときだけ、最初の区間で機影を大きくしていく
      path.stowedStart = !!ud.shownHidden;
      // 始端までの道のりに応じて 4〜9 秒。sim はそのあいだも滑走を続けていて
      // （9 秒で始端から 360m 先）、後半で追いつく。短くすると格納庫から始端まで
      // 秒速 300m で飛んでいくように見える
      ud.taxi = { kind: 'out', path, t0: now, dur: THREE.MathUtils.clamp(path.length / 100, 4, 9) };
    }
    const taxi = ud.taxi?.kind === 'out' ? ud.taxi : null;
    if (taxi) {
      const t = (now - taxi.t0) / taxi.dur;
      if (t < 1) pose = launchPose(taxi, t, ac, size);
      else ud.taxi = null;
    }
  } else {
    ud.taxi = null;
  }

  // 着陸滑走の止まった所を覚えておく（次のフレームで格納庫へ移されている）
  if (state === 'landing') ud.stopPos = (ud.stopPos || new THREE.Vector3()).copy(ac.pos);
  ud.shownPos = (ud.shownPos || new THREE.Vector3()).copy(pose ? pose.pos : ac.pos);
  ud.shownHidden = !!pose?.hidden;
  return pose;
}

// ---------------------------------------------------------------- 経路

/** 着陸滑走が止まった所 → 格納庫の中 */
function taxiInPoints(ab, from, hangarPos) {
  const a = fieldLocal(ab, from);
  const h = fieldLocal(ab, hangarPos);
  const y = ab.pos.y;
  const P = (along, side) => fieldPoint(ab, along, side);
  if (isCarrierBase(ab)) return [from.clone().setY(y), P(h.along, h.side)];

  const half = runwayLengthOf(ab) / 2;
  // 止まった所より先にある最初の出口。行き過ぎていたら滑走路の終端から出る
  const exits = [...FIELD.exits, half - 30].filter((e) => e >= a.along - 5);
  const ex = exits.length ? Math.min(...exits) : half - 30;
  const door = FIELD.hangarSide - FIELD.hangarDepth / 2;
  return [
    from.clone().setY(y),
    P(ex, 0),
    P(ex, FIELD.taxiSide),
    P(h.along, FIELD.taxiSide),
    P(h.along, door - 25),
    P(h.along, h.side),
  ];
}

/** いま見えている所（ふつうは格納庫の中）→ 滑走路の始端 */
function taxiOutPoints(ab, from) {
  const a = fieldLocal(ab, from);
  const y = ab.pos.y;
  const P = (along, side) => fieldPoint(ab, along, side);
  const half = runwayLengthOf(ab) / 2;
  if (isCarrierBase(ab)) return [from.clone().setY(y), P(-half, 0)];

  const pts = [from.clone().setY(y)];
  if (a.side > FIELD.taxiSide + 5) {
    pts.push(P(a.along, FIELD.hangarSide - FIELD.hangarDepth / 2 - 25));   // 扉の前
    pts.push(P(a.along, FIELD.taxiSide));
  }
  pts.push(P(-half + 30, FIELD.taxiSide));
  pts.push(P(-half + 30, 0));
  pts.push(P(-half, 0));
  return pts;
}

function makePath(points) {
  const cum = [0];
  for (let i = 1; i < points.length; i++) {
    cum.push(cum[i - 1] + points[i].distanceTo(points[i - 1]));
  }
  return { points, cum, length: cum[cum.length - 1] };
}

function pointAt(path, s, out = new THREE.Vector3()) {
  const { points, cum } = path;
  if (s <= 0) return out.copy(points[0]);
  for (let i = 1; i < points.length; i++) {
    if (s <= cum[i]) {
      const seg = cum[i] - cum[i - 1];
      return out.lerpVectors(points[i - 1], points[i], seg > 0 ? (s - cum[i - 1]) / seg : 1);
    }
  }
  return out.copy(points[points.length - 1]);
}

const _a = new THREE.Vector3(), _b = new THREE.Vector3();
function headingAt(path, s) {
  pointAt(path, s - HEADING_LOOK, _a);
  pointAt(path, s + HEADING_LOOK, _b);
  // 0=北（-Z）。`headingOf` と同じ向きの取り方
  return Math.atan2(_b.x - _a.x, -(_b.z - _a.z));
}

/**
 * 経路の上の姿勢。最後の区間（扉 → 中）で縮めて棟に収め、
 * 発進では最初の区間（中 → 扉）で元の大きさに戻す。
 */
function taxiPose(path, s, size, kind) {
  const n = path.points.length;
  const fit = Math.min(1, STOWED_LENGTH / Math.max(1, size));
  let scale = 1;
  if (kind === 'in') {
    const s0 = path.cum[n - 2];
    const u = THREE.MathUtils.clamp((s - s0) / Math.max(1, path.length - s0), 0, 1);
    scale = THREE.MathUtils.lerp(1, fit, THREE.MathUtils.smoothstep(u, 0, 1));
  } else if (path.stowedStart) {
    const u = THREE.MathUtils.clamp(s / Math.max(1, path.cum[1]), 0, 1);
    scale = THREE.MathUtils.lerp(fit, 1, THREE.MathUtils.smoothstep(u, 0, 1));
  }
  return { pos: pointAt(path, s), heading: headingAt(path, s), scale, hidden: false };
}

/**
 * 発進の寄せ。経路を `dur` 秒でたどり、後半で sim の位置（もう滑走している）へ溶かす。
 * 最後は sim の位置そのものになるので、切り替えで跳ばない。
 */
function launchPose(taxi, t, ac, size) {
  const path = taxi.path;
  const s = path.length * THREE.MathUtils.smoothstep(t, 0, 0.85);
  const p = taxiPose(path, s, size, 'out');
  const w = THREE.MathUtils.smoothstep(t, 0.55, 1);
  p.pos.lerp(ac.pos, w);
  p.heading = p.heading + angleDelta(p.heading, ac.heading) * w;
  return p;
}

function angleDelta(from, to) {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}
