// 課題1(t8)・課題2(w2) の不具合再現用プローブ。§98 調査用、本体コードは変更しない。
// 使い方: fetch('/tools/_tut_harness.js').then(r=>r.text()).then(eval) の後、
//         fetch('/tools/_tut98probe.js').then(r=>r.text()).then(eval) してから
//         __probeT8(mode, opts) / __probeW2(mode) を1本のasyncで回す。

window.__probeT8 = async function (mode, opts = {}) {
  // mode: 'baseline' | 'attack'
  // opts: { altBiasSteps: number(+上/-下), issueAtStart: bool }
  const DT = 1 / 30;
  const ALT_STEP = 300; // commands.js の ALT_STEP 相当を仮定せず、直接 adjustAltitude を使う
  function tick() {
    AT.loop.onFixedUpdate(DT);
    AT.loop.simTime += DT;
    if (AT.tutorial && !AT.tutorial.finished) {
      AT.tutorial.update({ world: AT.battle.world, commands: AT.commands, loop: AT.loop, rig: AT.scene.rig }, DT);
    }
  }
  await __open('t8');
  const w = AT.battle.world;
  const combat = w.combat;
  const viper1 = __u('VIPER 1'), viper2 = __u('VIPER 2'), bandit = __u('BANDIT 1');
  __sel('VIPER 1');
  // レーダーを一周させないと __rclick が拾えない（ハーネスの注記どおり）
  for (let i = 0; i < Math.round(5 / DT); i++) tick();

  if (opts.altBiasSteps) {
    AT.commands.select([viper1, viper2]);
    AT.commands.adjustAltitude(ALT_STEP * opts.altBiasSteps);
    for (let i = 0; i < Math.round(0.2 / DT); i++) tick();
  }

  let issued = false;
  if (mode === 'attack') {
    __sel('VIPER 1');
    const ok = __rclick(bandit);
    issued = ok;
    for (let i = 0; i < Math.round(0.2 / DT); i++) tick();
  }

  const samples = [];
  let firstShotT = null;
  const seenMissiles = new Set();
  const totalSec = opts.totalSec || 180;
  const sampleEvery = opts.sampleEvery || 5;
  let nextSample = 0;

  for (let t = 0; t < totalSec; t += DT) {
    tick();
    for (const m of w.missiles) {
      if (m.launcher === bandit && !seenMissiles.has(m)) {
        seenMissiles.add(m);
        if (firstShotT == null) firstShotT = +AT.loop.simTime.toFixed(1);
      }
    }
    if (t + DT >= nextSample) {
      nextSample += sampleEvery;
      // どちらの自機を狙っているか（bandit の指示先）を優先し、無ければ VIPER 1
      const tgt = (bandit.order && bandit.order.target && bandit.order.target.alive)
        ? bandit.order.target : viper1;
      const dx = tgt.pos.x - bandit.pos.x, dz = tgt.pos.z - bandit.pos.z;
      const dy = tgt.pos.y - bandit.pos.y;
      const flat = Math.hypot(dx, dz);
      const horizonElevDeg = +(Math.atan2(dy, Math.max(1, flat)) * 180 / Math.PI).toFixed(1);
      const noseElevDeg = +(( Math.atan2(dy, Math.max(1, flat)) - (bandit.pitch || 0)) * 180 / Math.PI).toFixed(1);
      const reason = combat ? combat.fireBlockReason(bandit, tgt, null, false) : '?';
      const visible = w.detection ? w.detection.isVisible(bandit.side, tgt) : null;
      samples.push({
        t: +AT.loop.simTime.toFixed(1),
        targetName: tgt.name,
        banditAlt: Math.round(bandit.pos.y),
        banditPitchDeg: +((bandit.pitch || 0) * 180 / Math.PI).toFixed(1),
        viper1Alt: Math.round(viper1.pos.y),
        viper2Alt: viper2.alive ? Math.round(viper2.pos.y) : null,
        targetAlt: Math.round(tgt.pos.y),
        flatKm: +(flat / 1000).toFixed(2),
        altDiff: Math.round(dy),
        horizonElevDeg, noseElevDeg,
        reason, visible,
        banditOrderTarget: bandit.order && bandit.order.target ? bandit.order.target.name : null,
        banditAcmMode: bandit.acmMode || null,
        shotsSoFar: seenMissiles.size,
      });
    }
    if (firstShotT != null && t > firstShotT + 5) break; // 撃った後は少し見て切る
    if (!viper1.alive && !viper2.alive) break;
    if (!bandit.alive) break;
  }

  return {
    mode, opts, issued,
    firstShotT, shotsTotal: seenMissiles.size,
    banditAlive: bandit.alive, viper1Alive: viper1.alive, viper2Alive: viper2.alive,
    simTimeEnd: +AT.loop.simTime.toFixed(1),
    samples,
  };
};

window.__probeW2 = async function (mode) {
  // mode: 'fire' (射撃指示を出す) | 'idle' (何もしない)
  const DT = 1 / 30;
  function tick() {
    AT.loop.onFixedUpdate(DT);
    AT.loop.simTime += DT;
    if (AT.tutorial && !AT.tutorial.finished) {
      AT.tutorial.update({ world: AT.battle.world, commands: AT.commands, loop: AT.loop, rig: AT.scene.rig }, DT);
    }
  }
  const { WEAPONS } = await import('/js/data/weapons.js');
  const C = await import('/js/sim/combat.js');
  await __open('w2');
  const w = AT.battle.world;
  const viper = __u('VIPER 1'), b1 = __u('BANDIT 1'), b2 = __u('BANDIT 2');
  __sel('VIPER 1');
  for (let i = 0; i < Math.round(5 / DT); i++) tick();

  // 手順1: BANDIT2 に攻撃指示 + AAM-S 指定（プレイヤーの操作どおり）
  __rclick(b2);
  __btn('[data-pick="AAM-S"]');
  for (let i = 0; i < Math.round(0.2 / DT); i++) tick();
  const idxAfterStep1 = AT.tutorial.index;

  // 手順2: BANDIT1 に射撃指示のみ（すれ違い）— ここはどちらのmodeでも同じに進める
  // BANDIT1 が正面から接近している間、射撃指示を試す
  let idxAfterStep2 = null, fireReasonAtStep2 = null;
  for (let i = 0; i < Math.round(30 / DT); i++) {
    tick();
    if (AT.tutorial.index >= 2) { idxAfterStep2 = AT.tutorial.index; break; }
  }
  if (idxAfterStep2 == null) {
    __rclick(b1); // まだ射撃指示を出していなければ出す
    for (let i = 0; i < Math.round(0.2 / DT); i++) tick();
    idxAfterStep2 = AT.tutorial.index;
  }

  const preStateB2 = {
    headingDeg: +(viper.heading * 180 / Math.PI).toFixed(1),
    viperPos: { x: Math.round(viper.pos.x), z: Math.round(viper.pos.z) },
    b2Pos: b2.alive ? { x: Math.round(b2.pos.x), z: Math.round(b2.pos.z) } : null,
    distKm: b2.alive ? +(viper.pos.distanceTo(b2.pos) / 1000).toFixed(2) : null,
  };

  if (mode === 'fire') {
    __rclick(b2); // プレイヤーがやるのと同じ: 兵装は既に AAM-S 指定済みなので射撃指示
  }
  const idxAfterAction = AT.tutorial.index;

  const timeline = [];
  let firedAt = null, firedDist = null, firedWeapon = null;
  const seenMissiles = new Set();
  const totalSec = 120;
  let nextSample = 0;
  for (let t = 0; t < totalSec; t += DT) {
    tick();
    for (const m of w.missiles) {
      if (m.launcher === viper && m.target === b2 && !seenMissiles.has(m)) {
        seenMissiles.add(m);
        if (firedAt == null) {
          firedAt = +AT.loop.simTime.toFixed(1);
          firedDist = +(viper.pos.distanceTo(b2.pos) / 1000).toFixed(2);
          firedWeapon = m.weapon.id;
        }
      }
    }
    if (t + DT >= nextSample) {
      nextSample += 5;
      const reason = C.fireReason
        ? null
        : (w.combat ? w.combat.fireBlockReason(viper, b2, WEAPONS['AAM-S'], true) : null);
      timeline.push({
        t: +AT.loop.simTime.toFixed(1),
        distKm: b2.alive ? +(viper.pos.distanceTo(b2.pos) / 1000).toFixed(2) : null,
        reason,
        tutIdx: AT.tutorial.index,
        tutFinished: AT.tutorial.finished,
        b2Alive: b2.alive,
        fireTasks: (viper.fireTasks || []).map((ft) => ft.weapon + '->' + (ft.target && ft.target.name)),
      });
    }
    if (firedAt != null && t > firedAt + 3) break;
    if (AT.tutorial.finished) break;
    if (!b2.alive) break;
  }

  return {
    mode, idxAfterStep1, idxAfterStep2, idxAfterAction,
    preStateB2,
    firedAt, firedDist, firedWeapon,
    tutFinished: AT.tutorial.finished, tutIndex: AT.tutorial.index, tutTotal: AT.tutorial.steps.length,
    simTimeEnd: +AT.loop.simTime.toFixed(1),
    timeline,
  };
};

'probe ready';
