// ANGELS TWENTY — w3 / w4 チュートリアル通しの自動プレイスクリプト。
// 使い方（ブラウザのコンソール、または javascript_tool で1本のasyncとして）:
//   await fetch('/tools/_tut_harness.js').then(r=>r.text()).then(eval);
//   // 以下を貼り付けて __runW3 / __runW4 を定義してから
//   const out=[]; for (let i=0;i<3;i++) out.push(await __runW3()); JSON.stringify(out);
//   const out=[]; for (let i=0;i<3;i++) out.push(await __runW4()); JSON.stringify(out);
//
// 1回の通しを1回の呼び出しで回す（`_tut_harness.js` の先頭）。JOURNAL §94.5 で使った。
//
// 同じページで続けて回すと w3 は3回とも完全一致、w4 もほぼ一致（hitChance/minD に 0.001 / 数m の差）。
// **ページを開き直すと w3 の2発目が 61.7s・18.44km と 62.1s・18.33km の2通りに分かれた**
// （1発目の発射距離から違うので、的のチャフより前 —— `__open` の実時間の待ちのぶんとみられる）。
//
// 手動機の旗を固定して「§94 より前」を同じページで再現するには、`__open` を包んで
//   Object.defineProperty(__u('BANDIT 1'), 'running', { get: () => false, set: () => {} })
// （`beaming` も同じ）とする。旗を読むのはチャフの門と HUD だけなので、これで旧挙動と同じになる。

window.__runW3 = async function () {
  const DT = 1 / 30;
  function tickOnce(sample) {
    AT.loop.onFixedUpdate(DT);
    AT.loop.simTime += DT;
    if (AT.tutorial && !AT.tutorial.finished) {
      AT.tutorial.update({ world: AT.battle.world, commands: AT.commands, loop: AT.loop, rig: AT.scene.rig }, DT);
    }
    if (sample) sample();
  }
  function runFor(seconds, sample, stopIf) {
    const n = Math.round(seconds / DT);
    for (let i = 0; i < n; i++) {
      tickOnce(sample);
      if (AT.tutorial && AT.tutorial.finished) return 'finished';
      if (stopIf && stopIf()) return 'stopped';
    }
    return 'timeout';
  }

  await __open('w3');
  const { WEAPONS } = await import('/js/data/weapons.js');
  const C = await import('/js/sim/combat.js');
  const w = AT.battle.world;
  const me = __u('VIPER 1'), bandit = __u('BANDIT 1');
  const chaff0 = bandit.chaff, flare0 = bandit.flares;
  let threatSec = 0, flagSec = 0;
  const seenMissiles = new Set();
  const shots = [];
  const sample = () => {
    if (bandit.threats && bandit.threats.length > 0) {
      threatSec += DT;
      if (bandit.running || bandit.beaming) flagSec += DT;
    }
    for (const m of w.missiles) {
      if (m.side === w.playerSide && m.weapon && m.weapon.id === 'AAM-M' && !seenMissiles.has(m)) {
        seenMissiles.add(m);
        shots.push({
          seq: shots.length + 1,
          tLaunch: +AT.loop.simTime.toFixed(2),
          rangeKm: +(me.pos.distanceTo(bandit.pos) / 1000).toFixed(2),
          hitChance: +C.estimateHitChance(me, bandit, WEAPONS['AAM-M']).toFixed(3),
          m, minD: Infinity,
        });
      }
    }
    for (const rec of shots) {
      if (rec.m.alive) rec.minD = Math.min(rec.minD, rec.m.pos.distanceTo(bandit.pos));
    }
  };

  const diag = {};
  __sel('VIPER 1');
  runFor(8, sample);
  __rclick(bandit);
  __btn('[data-pick="AAM-M"]');
  runFor(0.2, sample);
  diag.idxAfterPick1 = AT.tutorial.index;

  __rclick(bandit); // 兵装指定済みなので射撃指示（fireTask）→ 1発目
  runFor(90, sample, () => AT.tutorial.index >= 2);
  diag.idxAfterFire1 = AT.tutorial.index;

  const dx = me.pos.x - bandit.pos.x, dz = me.pos.z - bandit.pos.z;
  const dist = Math.hypot(dx, dz) || 1;
  const tFaceAway = AT.loop.simTime;
  __moveTo(me.pos.x + dx / dist * 20000, me.pos.z + dz / dist * 20000);
  runFor(0.2, sample);
  diag.idxAfterMove = AT.tutorial.index;

  runFor(90, sample, () => AT.tutorial.index >= 4);
  diag.idxAfterLost = AT.tutorial.index;
  const secToLoseGuidance = (shots[0] && shots[0].m.lost) ? +(AT.loop.simTime - tFaceAway).toFixed(1) : null;

  __btn('[data-pick="AAM-M"]'); // 指定を外す
  __rclick(bandit);             // 攻撃指示を出し直す
  __btn('[data-pick="AAM-M"]'); // 指定し直す
  runFor(0.2, sample);
  diag.idxAfterRepick = AT.tutorial.index;

  let waited = 0;
  while (waited < 60 && C.estimateHitChance(me, bandit, WEAPONS['AAM-M']) < 0.40) {
    runFor(0.5, sample); waited += 0.5;
  }
  diag.waitedForHigh2 = waited;
  __rclick(bandit); // 射撃指示 → 2発目
  runFor(90, sample, () => AT.tutorial.index >= 5);
  diag.idxAfterFire2 = AT.tutorial.index;

  __btn('[data-guard]');
  runFor(0.2, sample);
  diag.idxAfterGuard = AT.tutorial.index;

  // 撃墜手順: 弾が残っていて外れていたら、最後の1発で撃ち直す
  let refired = false;
  for (let guard = 0; guard < 400 && !AT.tutorial.finished && bandit.alive; guard++) {
    const last = shots[shots.length - 1];
    const lastDone = !last || !last.m.alive;
    if (lastDone && !refired && me.loadout.includes('AAM-M')) {
      refired = true;
      __btn('[data-pick="AAM-M"]');
      __rclick(bandit);
      __btn('[data-pick="AAM-M"]');
      runFor(0.2, sample);
      let w2 = 0;
      while (w2 < 60 && C.estimateHitChance(me, bandit, WEAPONS['AAM-M']) < 0.40) { runFor(0.5, sample); w2 += 0.5; }
      __rclick(bandit);
    }
    runFor(3, sample, () => AT.tutorial.finished || !bandit.alive);
    if (lastDone && refired && !me.loadout.includes('AAM-M') &&
      !w.missiles.some((m) => m.alive && m.side === w.playerSide && m.weapon.id === 'AAM-M')) break;
  }
  diag.refired = refired;

  function outcomeOf(m) {
    if (!m) return null;
    if (m.endReason === 'hit') return 'hit';
    if (m.lost) return 'lost';
    return m.alive ? 'flying' : (m.endReason || 'unknown');
  }

  return {
    finished: AT.tutorial.finished, index: AT.tutorial.index, total: AT.tutorial.steps.length,
    simTime: +AT.loop.simTime.toFixed(1),
    banditAlive: bandit.alive, banditHp: +bandit.hp.toFixed(1), banditMaxHp: bandit.maxHp,
    chaffUsed: chaff0 - bandit.chaff, flaresUsed: flare0 - bandit.flares,
    threatSec: +threatSec.toFixed(1), flagSec: +flagSec.toFixed(1),
    secToLoseGuidance,
    shots: shots.map((s) => ({ seq: s.seq, tLaunch: s.tLaunch, rangeKm: s.rangeKm,
      hitChance: s.hitChance, outcome: outcomeOf(s.m), minD: isFinite(s.minD) ? Math.round(s.minD) : null })),
    diag,
  };
};

window.__runW4 = async function () {
  const DT = 1 / 30;
  function tickOnce(sample) {
    AT.loop.onFixedUpdate(DT);
    AT.loop.simTime += DT;
    if (AT.tutorial && !AT.tutorial.finished) {
      AT.tutorial.update({ world: AT.battle.world, commands: AT.commands, loop: AT.loop, rig: AT.scene.rig }, DT);
    }
    if (sample) sample();
  }
  function runFor(seconds, sample, stopIf) {
    const n = Math.round(seconds / DT);
    for (let i = 0; i < n; i++) {
      tickOnce(sample);
      if (AT.tutorial && AT.tutorial.finished) return 'finished';
      if (stopIf && stopIf()) return 'stopped';
    }
    return 'timeout';
  }

  await __open('w4');
  const { WEAPONS } = await import('/js/data/weapons.js');
  const C = await import('/js/sim/combat.js');
  const w = AT.battle.world;
  const me = __u('VIPER 1'), bandit = __u('BANDIT 1');
  const chaff0 = bandit.chaff, flare0 = bandit.flares;
  let threatSec = 0, flagSec = 0;
  const seenMissiles = new Set();
  const shots = [];
  const sample = () => {
    if (bandit.threats && bandit.threats.length > 0) {
      threatSec += DT;
      if (bandit.running || bandit.beaming) flagSec += DT;
    }
    for (const m of w.missiles) {
      if (m.side === w.playerSide && m.weapon && m.weapon.id === 'AAM-A' && !seenMissiles.has(m)) {
        seenMissiles.add(m);
        shots.push({
          seq: shots.length + 1,
          tLaunch: +AT.loop.simTime.toFixed(2),
          rangeKm: +(me.pos.distanceTo(bandit.pos) / 1000).toFixed(2),
          hitChance: +C.estimateHitChance(me, bandit, WEAPONS['AAM-A']).toFixed(3),
          radarModeAtFire: me.radarMode,
          m, minD: Infinity,
        });
      }
    }
    for (const rec of shots) {
      if (rec.m.alive) rec.minD = Math.min(rec.minD, rec.m.pos.distanceTo(bandit.pos));
    }
  };

  const diag = {};
  __sel('VIPER 1');
  diag.radarModeInitial = me.radarMode;
  runFor(10, sample);
  __rclick(bandit);
  __btn('[data-pick="AAM-A"]');
  runFor(0.2, sample);
  diag.idxAfterPick = AT.tutorial.index;

  let waited = 0;
  while (waited < 60 && C.estimateHitChance(me, bandit, WEAPONS['AAM-A']) < 0.40) {
    runFor(0.5, sample); waited += 0.5;
  }
  diag.waitedForHigh1 = waited;
  __rclick(bandit); // レーダーOFFのまま射撃指示 → 1発目
  runFor(90, sample, () => AT.tutorial.index >= 3);
  diag.idxAfterFire1 = AT.tutorial.index;

  const dx = me.pos.x - bandit.pos.x, dz = me.pos.z - bandit.pos.z;
  const dist = Math.hypot(dx, dz) || 1;
  __moveTo(me.pos.x + dx / dist * 20000, me.pos.z + dz / dist * 20000);
  runFor(0.2, sample);
  diag.idxAfterMove = AT.tutorial.index;

  // 当たるのを見届ける。外れて弾が残っていれば撃ち直す（§93.12 の実測どおり3回に1回は外れうる）
  let refired = false;
  for (let guard = 0; guard < 400 && !AT.tutorial.finished && bandit.alive; guard++) {
    const last = shots[shots.length - 1];
    const lastDone = last && !last.m.alive;
    if (lastDone && !refired && me.loadout.includes('AAM-A') && bandit.hp >= bandit.maxHp) {
      refired = true;
      let w2 = 0;
      while (w2 < 60 && C.estimateHitChance(me, bandit, WEAPONS['AAM-A']) < 0.40) { runFor(0.5, sample); w2 += 0.5; }
      __rclick(bandit);
    }
    runFor(3, sample, () => AT.tutorial.finished || !bandit.alive || bandit.hp < bandit.maxHp);
    if (!me.loadout.includes('AAM-A') &&
      !w.missiles.some((m) => m.alive && m.side === w.playerSide && m.weapon.id === 'AAM-A')) break;
  }
  diag.refired = refired;

  function outcomeOf(m) {
    if (!m) return null;
    if (m.endReason === 'hit') return 'hit';
    if (m.lost) return 'lost';
    return m.alive ? 'flying' : (m.endReason || 'unknown');
  }

  return {
    finished: AT.tutorial.finished, index: AT.tutorial.index, total: AT.tutorial.steps.length,
    simTime: +AT.loop.simTime.toFixed(1),
    banditAlive: bandit.alive, banditHp: +bandit.hp.toFixed(1), banditMaxHp: bandit.maxHp,
    chaffUsed: chaff0 - bandit.chaff, flaresUsed: flare0 - bandit.flares,
    threatSec: +threatSec.toFixed(1), flagSec: +flagSec.toFixed(1),
    shots: shots.map((s) => ({ seq: s.seq, tLaunch: s.tLaunch, rangeKm: s.rangeKm,
      hitChance: s.hitChance, radarModeAtFire: s.radarModeAtFire, outcome: outcomeOf(s.m),
      minD: isFinite(s.minD) ? Math.round(s.minD) : null })),
    diag,
  };
};

'ready';
