// 飛行場。仕様書 §7。
//
// 役割は3つ。
//   1. レーダー（全方位60km）… GroundUnit から継承
//   2. 滑走路 … 着陸・離陸の経路を提供する。進入から停止までは低速・低高度で無防備
//   3. 整備 … 整備スロット制（既定2機）。補充量に応じて時間がかかり、
//             兵装の再装備はステージ共通の兵装ポイントを消費する
//
// 部分補給を成立させるため、整備は「作業の列」として持ち、
// 完了した分から順に反映する。途中で発進させれば、そこまでの補給で飛べる。

import * as THREE from 'three';
import { GroundUnit } from './ground.js';
import { getWeapon } from '../data/weapons.js';

/** 進入開始点（滑走路手前）までの距離(m) */
export const APPROACH_DISTANCE = 7000;
/** 進入開始点の対地高度(m) */
export const APPROACH_ALT = 600;
/** 接地点は滑走路始端からこの距離(m) */
const TOUCHDOWN_OFFSET = 250;

/**
 * 進入路が最も開けている滑走路方位を選ぶ。
 *
 * 飛行場を平坦地に置いても、進入路（手前7km）に丘があると
 * 降下経路が地形を貫通してしまう。16方位を試して、
 * 理想の降下線からの地形のはみ出しが最小になる向きを返す。
 */
export function pickRunwayHeading(terrain, x, z, distance = APPROACH_DISTANCE) {
  const fieldAlt = Math.max(0, terrain.heightAt(x, z));
  let best = 0, bestScore = Infinity;
  for (let i = 0; i < 16; i++) {
    const h = (i / 16) * Math.PI * 2;
    // 進入は離陸方向の逆側から来る
    const dx = -Math.sin(h), dz = Math.cos(h);
    let score = 0;
    for (let d = 500; d <= distance; d += 500) {
      const g = Math.max(0, terrain.heightAt(x + dx * d, z + dz * d));
      const ideal = fieldAlt + d * 0.065;
      score += Math.max(0, g + 130 - ideal);
    }
    if (score < bestScore) { bestScore = score; best = h; }
  }
  return best;
}

/** 整備作業の所要時間（仕様 §7.1） */
const SERVICE_TIME = {
  fuelFull: 60,       // 空から満タンまで
  gunFull: 15,
  decoy: 10,
  repairPer10Hp: 8,
  weaponSlot: 20,     // 兵装1発（getWeapon().rearmSeconds があればそちら）
  swap: 30,           // 兵装構成を変える場合の追加
};

export class Airbase extends GroundUnit {
  constructor(o) {
    super({ ...o, type: 'AIRBASE' });

    this.runwayHeading = o.runwayHeading ?? 0;   // 離陸方向（0=北）
    this.runwayLength = o.runwayLength ?? 2200;
    this.serviceSlots = o.serviceSlots ?? 2;
    this.heading = this.runwayHeading;           // 3D表示の向きを滑走路に合わせる

    this.queue = [];      // 整備待ちの機体
    this.slots = [];      // {ac, tasks, elapsed}
    this.parked = [];     // 着陸済み（整備待ち・整備中・発進待ちすべて）
  }

  // -------------------------------------------------------------- 滑走路

  get runwayDir() {
    return new THREE.Vector3(Math.sin(this.runwayHeading), 0, -Math.cos(this.runwayHeading));
  }

  /** 滑走路始端（離陸開始位置／着陸接地側） */
  get runwayStart() {
    return this.pos.clone().addScaledVector(this.runwayDir, -this.runwayLength / 2);
  }

  get runwayEnd() {
    return this.pos.clone().addScaledVector(this.runwayDir, this.runwayLength / 2);
  }

  get touchdownPoint() {
    return this.runwayStart.clone().addScaledVector(this.runwayDir, TOUCHDOWN_OFFSET);
  }

  /** 進入開始点（ここへ向かってから最終進入に入る） */
  approachFix(terrain) {
    const p = this.runwayStart.clone().addScaledVector(this.runwayDir, -APPROACH_DISTANCE);
    p.y = Math.max(0, terrain.heightAt(p.x, p.z)) + APPROACH_ALT;
    return p;
  }

  /** 滑走路面の高度 */
  get fieldAlt() { return this.pos.y; }

  // -------------------------------------------------------------- 整備

  /** 着陸して停止した機体を受け入れる */
  onArrive(ac) {
    if (this.parked.includes(ac)) return;
    this.parked.push(ac);
    this.queue.push(ac);
    ac.airbase = this;
    ac.state = 'parked';
    ac.speed = 0;
    // 駐機位置（エプロンに並べる）
    const i = this.parked.length - 1;
    const side = this.runwayDir;
    const right = new THREE.Vector3(-side.z, 0, side.x);
    ac.pos.copy(this.pos)
      .addScaledVector(right, 260)
      .addScaledVector(side, -400 + i * 220);
    ac.pos.y = this.fieldAlt;
    ac.heading = this.runwayHeading;
  }

  update(dt, world) {
    super.update(dt, world);
    if (!this.alive) {
      // 破壊された飛行場では整備できない
      this.slots.length = 0;
      return;
    }

    // 空きスロットへ順番待ちを入れる
    while (this.slots.length < this.serviceSlots && this.queue.length > 0) {
      const ac = this.queue.shift();
      if (!ac.alive || ac.state === 'takeoff' || ac.state === 'flying') continue;
      this.slots.push({ ac, tasks: buildServicePlan(ac, world), elapsed: 0 });
      ac.state = 'servicing';
    }

    for (let i = this.slots.length - 1; i >= 0; i--) {
      const slot = this.slots[i];
      if (!slot.ac.alive || slot.ac.state === 'takeoff') { this.slots.splice(i, 1); continue; }
      this._advanceService(slot, dt, world);
      if (slot.tasks.length === 0) {
        slot.ac.state = 'ready';
        this.slots.splice(i, 1);
      }
    }
  }

  _advanceService(slot, dt, world) {
    let remaining = dt;
    while (remaining > 0 && slot.tasks.length > 0) {
      const task = slot.tasks[0];
      const step = Math.min(remaining, task.time - task.done);
      task.done += step;
      remaining -= step;
      applyContinuous(slot.ac, task, step);
      if (task.done >= task.time - 1e-6) {
        applyComplete(slot.ac, task, world);
        slot.tasks.shift();
      }
    }
  }

  /** 搭載内容の変更を受けて整備計画を組み直す */
  replan(ac, world) {
    const slot = this.slots.find((s) => s.ac === ac);
    if (slot) slot.tasks = buildServicePlan(ac, world);
    else if (ac.state === 'ready') {
      // 整備完了後に積み替えを指示された → 再度スロットに戻す
      ac.state = 'parked';
      if (!this.queue.includes(ac)) this.queue.push(ac);
    }
  }

  /** 整備の進捗 0..1（UI表示用） */
  serviceProgress(ac) {
    const slot = this.slots.find((s) => s.ac === ac);
    if (!slot) return null;
    const total = slot.tasks.reduce((n, t) => n + t.time, 0);
    const done = slot.tasks.reduce((n, t) => n + t.done, 0);
    return { remainingSec: total - done, current: slot.tasks[0]?.label ?? '' };
  }

  /** 機体を発進させる（整備途中でも可＝部分補給） */
  launch(ac, world) {
    if (!this.alive) return false;
    if (ac.state !== 'parked' && ac.state !== 'servicing' && ac.state !== 'ready') return false;

    const si = this.slots.findIndex((s) => s.ac === ac);
    if (si >= 0) this.slots.splice(si, 1);
    const qi = this.queue.indexOf(ac);
    if (qi >= 0) this.queue.splice(qi, 1);
    const pi = this.parked.indexOf(ac);
    if (pi >= 0) this.parked.splice(pi, 1);

    ac.state = 'takeoff';
    ac._rotated = false;
    ac.pos.copy(this.runwayStart);
    ac.pos.y = this.fieldAlt;
    ac.heading = this.runwayHeading;
    ac.speed = 0;
    ac.roll = 0;
    ac.pitch = 0;
    ac.baseLoadout = ac.loadout.slice();
    world.log?.(`${ac.name} 発進`);
    return true;
  }
}

// ---------------------------------------------------------------- 整備計画

/**
 * 整備作業の列を作る。
 * 順序は「燃料 → 兵装 → 機銃/デコイ → 機体修理」。
 * 途中で発進させたときに、最も困る燃料から埋まっているようにするため。
 */
export function buildServicePlan(ac, world) {
  const tasks = [];

  const fuelMissing = 1 - ac.fuelRatio;
  if (fuelMissing > 0.01) {
    tasks.push(task('fuel', '燃料補給', SERVICE_TIME.fuelFull * fuelMissing,
      { amount: ac.fuelMax - ac.fuel }));
  }

  const want = (ac.plannedLoadout ?? ac.baseLoadout ?? []).slice();
  const have = ac.loadout.slice();
  const { add, remove } = loadoutDiff(have, want);

  if (remove.length > 0) {
    tasks.push(task('swap', '兵装積み替え', SERVICE_TIME.swap, { remove }));
  }
  for (const id of add) {
    const w = getWeapon(id);
    tasks.push(task('weapon', `${id} 搭載`, w.rearmSeconds ?? SERVICE_TIME.weaponSlot, { weaponId: id }));
  }

  const gunMissing = 1 - ac.gun / Math.max(1, ac.spec.gunRounds);
  if (gunMissing > 0.02) {
    tasks.push(task('gun', '機銃補充', SERVICE_TIME.gunFull * gunMissing,
      { amount: ac.spec.gunRounds - ac.gun }));
  }
  if (ac.flares < ac.spec.flares || ac.chaff < ac.spec.chaff) {
    tasks.push(task('decoy', 'フレア/チャフ補充', SERVICE_TIME.decoy));
  }

  const hpMissing = ac.maxHp - ac.hp;
  if (hpMissing > 1) {
    tasks.push(task('repair', '機体修理', SERVICE_TIME.repairPer10Hp * (hpMissing / 10),
      { amount: hpMissing }));
  }

  return tasks;
}

function task(type, label, time, extra = {}) {
  return { type, label, time: Math.max(0.1, time), done: 0, ...extra };
}

/**
 * 連続的に効く作業（燃料・機銃・修理）を進捗ぶんだけ反映する。
 * 途中で発進させても、そこまでの補給が残るようにするための仕組み。
 */
function applyContinuous(ac, task, step) {
  if (!task.amount) return;
  const delta = task.amount * (step / task.time);
  switch (task.type) {
    case 'fuel':   ac.fuel = Math.min(ac.fuelMax, ac.fuel + delta); break;
    case 'gun':    ac.gun = Math.min(ac.spec.gunRounds, ac.gun + delta); break;
    case 'repair': ac.hp = Math.min(ac.maxHp, ac.hp + delta); break;
    default: break;
  }
}

/** 完了時に一度だけ効く作業 */
function applyComplete(ac, task, world) {
  switch (task.type) {
    case 'fuel':
      ac.fuel = ac.fuelMax;
      break;
    case 'gun':
      ac.gun = ac.spec.gunRounds;
      break;
    case 'repair':
      ac.hp = ac.maxHp;
      break;
    case 'decoy':
      ac.flares = ac.spec.flares;
      ac.chaff = ac.spec.chaff;
      break;
    case 'swap':
      // 降ろした兵装のコストは戻す（積み替えで無駄に消費しないように）
      for (const id of task.remove) {
        const i = ac.loadout.indexOf(id);
        if (i < 0) continue;
        ac.loadout.splice(i, 1);
        const w = getWeapon(id);
        if (w.cost > 0 && world) {
          world.weaponPoints = Math.min(world.weaponPointsMax ?? Infinity,
            (world.weaponPoints ?? 0) + w.cost);
        }
      }
      break;
    case 'weapon': {
      const w = getWeapon(task.weaponId);
      if (w.cost > 0) {
        if ((world.weaponPoints ?? 0) < w.cost) {
          world.log?.(`兵装ポイント不足: ${task.weaponId} を搭載できません`);
          break;
        }
        world.weaponPoints -= w.cost;
      }
      ac.loadout.push(task.weaponId);
      break;
    }
    default:
      break;
  }
}

/** 多重集合の差分。have から want にするには何を降ろして何を積むか。 */
export function loadoutDiff(have, want) {
  const pool = have.slice();
  const add = [];
  for (const id of want) {
    const i = pool.indexOf(id);
    if (i >= 0) pool.splice(i, 1);
    else add.push(id);
  }
  return { add, remove: pool };
}
