// 機体の性能を、本体の飛行モデルそのものから引く。JOURNAL §93.13。
//
// 資料画面（ui/reference.js）とチュートリアルの文（x2）が読む。
//
// **式を写さない。** 最高速・最良旋回・燃料の減りはどれも `sim/aircraft.js` の
// ゲッターが決めていて、写すと飛行モデルを直したときに説明だけが古くなる（§79.5）。
// 代わりに `Aircraft` を1機作り、戦闘中と同じゲッターに聞く。
// world には入れないので戦闘には何も残らない（ユニットIDは戦闘を組むときに
// 振り直す —— main.js の `resetUnitIds`）。

import { Aircraft } from '../sim/aircraft.js';
import { RWR_SIGNATURE_FACTOR } from '../sim/unit.js';
import { getType } from './aircraft.js';
import { loadoutSlots } from './weapons.js';

const GRAVITY = 9.81;

/** 性能を読む基準の高度(m)。x2 の3機を飛ばす高さと同じ */
export const PERF_ALT = 5000;

/**
 * 重さが機体の基準（`loadCapacity`）ちょうどになる搭載。
 * 重さは `slots` の和なので、1つぶんの兵装で埋める（載るかどうかは見ない ——
 * 旋回と燃料の代償は重さだけで決まる）。
 */
export function fullLoad(typeId) {
  return new Array(getType(typeId).loadCapacity || 0).fill('BOMB');
}

/**
 * @param {string} typeId
 * @param {object} [o]
 * @param {number}   [o.alt]      高度(m)
 * @param {string[]} [o.loadout]  搭載（重さと増槽が効く）
 */
export function perfOf(typeId, { alt = PERF_ALT, loadout = [] } = {}) {
  const a = new Aircraft({ type: typeId, loadout, alt });
  const spec = a.spec;
  const hasAb = !spec.noAfterburner;

  const milSpeed = a.milSpeed;
  const abSpeed = hasAb ? a.altitudeMaxSpeed : null;
  const topSpeed = abSpeed ?? milSpeed;

  // 最良旋回: 速度を振って、実効旋回率がいちばん高いところ（§29.2 のコーナー速度）
  let turn = 0, turnSpeed = 0;
  for (let v = spec.minSpeed || 60; v <= topSpeed; v += 1) {
    a.speed = v;
    const w = a.effectiveTurnRate;
    if (w > turn) { turn = w; turnSpeed = v; }
  }

  a.abActive = false;
  const cruiseRate = a.fuelRate;
  a.abActive = hasAb;
  const abRate = a.fuelRate;
  a.abActive = false;

  const fuel = a.fuelMax;
  const enduranceSec = fuel / cruiseRate;
  const abEnduranceSec = hasAb ? fuel / abRate : null;

  const radar = spec.radarRange || 0;
  return {
    spec,
    hasAb,
    cruise: spec.cruiseSpeed,
    milSpeed,
    abSpeed,
    turnDeg: turn * 180 / Math.PI,
    turnSpeed,
    turnG: turnSpeed * turn / GRAVITY,
    enduranceSec,
    rangeM: enduranceSec * spec.cruiseSpeed,
    abEnduranceSec,
    abRangeM: hasAb ? abEnduranceSec * abSpeed : null,
    radarRange: radar,
    radarFovH: spec.radarFovH || 0,
    // 逆探知に映る距離（§30.3）。`rcs` は掛からない —— 電波を出せば小さくても見つかる
    rwrRange: radar * RWR_SIGNATURE_FACTOR,
    // 扇の面積の目安（半径² × 左右の角度）
    sweep: radar * radar * (spec.radarFovH || 0),
    slots: loadoutSlots(loadout),
  };
}
