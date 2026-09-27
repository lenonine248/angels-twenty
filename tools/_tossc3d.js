// c3 で「SAMから隠れられるか」の4回目。tools/_tossc3b.js / _tossc3c.js の構造
// (loadStage/openScenario/低い床パッチ)を必要な分だけ写して使う。
// ゲーム本体(js/)は一切変更しない。
//
// 問い: A-3の飛行性能で、実際にどこまで低く飛べて、それでSAMから隠れられるか。
//
// 測定A: T0(今のトス)の15本(5か所×出発方位0/±15°)の航跡(x,z,速さ,段階)から、
//        「その機体が実際に飛べる最低の高度の道のり」を後ろ向き(登り切れる)・
//        前向き(降下し過ぎない)の二方向緩和で計算し、実際にSAMから見えていた
//        瞬間について、220m一律の高さで隠れるか／この最低の道のりで隠れるかを比べる。
// 測定B: T0 / T1a(margin0.6) / T1b(margin0.8) / T1c(margin1.0) を同じ15本で比較する。
//
// 上昇率: spec.climbRate * clamp(speed/spec.cruiseSpeed, 0.35, 1.2)
//         → js/sim/aircraft.js:802-804 (climbCap getter)
// 降下の上限: 同じ climbCap の1.4倍。vs = clamp(altErr>0? altErr*0.9 : altErr*0.35,
//         -climbCap*1.4, climbCap) → js/sim/aircraft.js:1785 (_integrate)
//
// 読み込み:
//   await fetch('/tools/_tossc3d.js').then(r => r.text()).then(eval);
// 実行(重いので直接awaitせず、fire-and-forgetしてポーリングで回収する):
//   window.__tc3dResult = null;
//   window.__tossC3dRun().then(r => window.__tc3dResult = r)
//     .catch(e => window.__tc3dResult = { error: String((e && e.stack) || e) });
// 回収:
//   window.__tc3dResult   // nullなら未完了
//
// 生ログ(各runの生の集計)は window.__tossC3dLast に積む。航跡そのものは重いので積まない。
(() => {
  const DT = 1 / 30;
  const DEG = Math.PI / 180;
  const MAX_T = 260;
  const SAM_CLEARANCE = 8, SAM_STEP = 400;
  const RIDGE_CLIMB = 2200, LOOK_STEP = 150, LOOK_NEAR = 3000, MIN_AGL = 220;
  const DESCENT_FACTOR = 1.4; // js/sim/aircraft.js:1785 の -climbCap*1.4

  const FALLBACK_STAGE = {
    id: 'c3', custom: true, name: 'NEW MISSION',
    terrain: { seed: 17878, mountainAmount: 0.8, coast: 'none', valleyDepth: 0.9, rivers: 2, baseAltitude: 400 },
    weaponPoints: 24,
    friendly: {
      base: { x: 10000, z: 40000 }, startAirborne: true, startAlt: 4500,
      aircraft: [{ type: 'A-3', name: 'test1', loadout: ['BOMB', 'BOMB', 'BOMB', 'BOMB'] }],
    },
    enemy: {
      skill: 0.6, aircraft: [],
      ground: [{ type: 'RADAR', name: '目標 1', x: 27393, z: 22711, tags: ['cap'], known: true }],
    },
  };

  function round(x, d = 0) { const k = 10 ** d; return x == null ? null : Math.round(x * k) / k; }
  function headingOf(dx, dz) { return Math.atan2(dx, -dz); }
  function offset(p, d, angle) { return { x: p.x + d * Math.sin(angle), z: p.z - d * Math.cos(angle) }; }
  function mean(arr) { const a = arr.filter((x) => x != null); return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null; }
  function sum(arr) { return arr.reduce((s, x) => s + (x || 0), 0); }

  async function loadStage() {
    try {
      const r = await fetch('/stages_out/new-mission-c3.json');
      if (r.ok) return await r.json();
    } catch (e) { /* fall through */ }
    return FALLBACK_STAGE;
  }

  function buildScenario(id, stage, base, extraGround) {
    const ground = (stage.enemy.ground || []).map((g) => ({ ...g }));
    if (extraGround) ground.push(...extraGround);
    return {
      id, group: '計測', name: 'TOSS C3D PROBE', title: '計測用（非表示）',
      battleSeed: 0xC30004,
      brief: '計測用の内部ステージ（c3の地形・配置を写す・SAM隠れ4回目）。', hint: '',
      terrain: { ...stage.terrain },
      weaponPoints: stage.weaponPoints || 24,
      noFail: true,
      friendly: {
        base: { ...base },
        startAirborne: true,
        startAlt: stage.friendly.startAlt,
        aircraft: stage.friendly.aircraft.map((a) => ({ ...a, autoWeapons: { BOMB: true } })),
      },
      enemy: { skill: stage.enemy.skill, aircraft: [], ground },
      steps: [{ text: '(計測用ダミー手順)', check: () => false }],
    };
  }

  async function openScenario(id, stage, base, extraGround) {
    if (!AT.tutorials.find((t) => t.id === id)) AT.tutorials.push(buildScenario(id, stage, base, extraGround));
    await __open(id);
    const b = AT.battle;
    const world = b.world;
    const u = world.units.find((x) => x.kind === 'aircraft' && x.side === world.playerSide);
    const target = world.units.find((x) => x.typeId === 'RADAR');
    const sam = world.units.find((x) => x.typeId === 'SAM');
    return { world, u, target, sam };
  }

  // ---------------------------------------------------------------- 低い床パッチ（T1a/b/c・係数だけ違う）
  function installLowFloorPatch(u, clamp, angleDiff, margin) {
    const orig = u._terrainScan.bind(u);
    u._terrainScan = function (world, desiredHeading = u.heading) {
      if (u.bombProfile === 'toss' && (u.attackRun === 'in' || u.attackRun === 'out')) {
        const terrain = world.terrain;
        const climbRate = u.spec.climbRate;
        const speed = u.speed;
        const climbTime = RIDGE_CLIMB / Math.max(20, climbRate);
        const lookAhead = clamp(speed * climbTime, 4000, 11000);
        const dtNear = LOOK_STEP / Math.max(50, speed);
        const turnNear = u.effectiveTurnRate * dtNear;
        let h = u.heading;
        let remaining = angleDiff(desiredHeading, u.heading);
        let x = u.pos.x, z = u.pos.z;
        let ground = terrain.heightAt(x, z);
        let travelled = 0, peakAt = 0;
        let lowFloor = ground + MIN_AGL;
        while (travelled < lookAhead) {
          const step = travelled < LOOK_NEAR ? LOOK_STEP : LOOK_STEP * 3;
          const turnPerStep = turnNear * (step / LOOK_STEP);
          const turn = clamp(remaining, -turnPerStep, turnPerStep);
          h += turn; remaining -= turn;
          x += Math.sin(h) * step; z += -Math.cos(h) * step;
          travelled += step;
          const g = terrain.heightAt(x, z);
          if (g > ground) { ground = g; peakAt = travelled; }
          const req = g + MIN_AGL - margin * climbRate * (travelled / Math.max(50, speed));
          if (req > lowFloor) lowFloor = req;
        }
        return { floor: Math.max(lowFloor, 0), dist: peakAt };
      }
      return orig(world, desiredHeading);
    };
  }

  // ---------------------------------------------------------------- 飛べる最低の道のり（測定A）
  // 床(floor) = pull以外は地形+220m、pullは実際の高度のまま固定。
  // 後ろ向き: h[i] >= h[i+1] - climbCap(i)*DT （i→i+1を登り切れる）
  // 前向き:   h[i] >= h[i-1] - climbCap(i-1)*DT*1.4 （i-1→iの降下がclimbCapの1.4倍を超えない）
  function computeMinFlyable(traj, climbRateBase, cruiseSpeedBase, clamp) {
    const n = traj.length;
    const h = new Array(n);
    for (let i = 0; i < n; i++) h[i] = traj[i].phase === 'pull' ? traj[i].y : (traj[i].ground + MIN_AGL);
    for (let i = n - 2; i >= 0; i--) {
      if (traj[i].phase === 'pull') continue;
      const climbCap = climbRateBase * clamp(traj[i].speed / cruiseSpeedBase, 0.35, 1.2);
      const allowed = h[i + 1] - climbCap * DT;
      if (allowed > h[i]) h[i] = allowed;
    }
    for (let i = 1; i < n; i++) {
      if (traj[i].phase === 'pull') continue;
      const climbCapPrev = climbRateBase * clamp(traj[i - 1].speed / cruiseSpeedBase, 0.35, 1.2);
      const descentCap = climbCapPrev * DESCENT_FACTOR;
      const allowed = h[i - 1] - descentCap * DT;
      if (allowed > h[i]) h[i] = allowed;
    }
    return h;
  }

  function evaluateHidden(traj, hMin, samPos, terrain) {
    const stageKeys = ['farIn', 'nearIn', 'pull', 'out', 'evading', 'other'];
    const seenSec = {}, hidden220Sec = {}, hiddenMinSec = {};
    for (const k of stageKeys) { seenSec[k] = 0; hidden220Sec[k] = 0; hiddenMinSec[k] = 0; }
    for (let i = 0; i < traj.length; i++) {
      const stage = traj[i].seenStage;
      if (!stage) continue;
      seenSec[stage] += DT;
      const raised = { x: traj[i].x, y: traj[i].ground + MIN_AGL, z: traj[i].z };
      if (!terrain.hasLineOfSight(samPos, raised, SAM_CLEARANCE, SAM_STEP)) hidden220Sec[stage] += DT;
      const flyable = { x: traj[i].x, y: hMin[i], z: traj[i].z };
      if (!terrain.hasLineOfSight(samPos, flyable, SAM_CLEARANCE, SAM_STEP)) hiddenMinSec[stage] += DT;
    }
    return { seenSec, hidden220Sec, hiddenMinSec };
  }

  // ---------------------------------------------------------------- 1試行

  function runTrialD(ctx, cfg, recordTraj) {
    const { world, u, target, sam } = ctx;
    const terrain = world.terrain;
    const targetXZ = { x: target.pos.x, z: target.pos.z };

    u.bombProfile = 'toss';
    u.setPlayerOrder({ type: 'attack', target });

    let samFired = 0, samHits = 0;
    world.onFire = (shooter, tgt, weapon) => {
      if (sam && shooter === sam && weapon.kind === 'sam') samFired++;
    };
    world.onMissileHit = (m, tgt) => { if (tgt === u && m.weapon && m.weapon.kind === 'sam') samHits++; };

    const stageKeys = ['farIn', 'nearIn', 'pull', 'out', 'evading', 'other'];
    const samBuckets = {}; for (const k of stageKeys) samBuckets[k] = 0;
    let minAGL = Infinity, terrainCollision = false;
    let inAGLSum = 0, inAGLCount = 0, outAGLSum = 0, outAGLCount = 0;
    let terrainAvoidingSec = 0;
    let bombsUsed = 0, hits = 0;
    const bombEvents = [];
    const origOnFire = world.onFire;
    world.onFire = (shooter, tgt, weapon, m) => {
      if (shooter === u && weapon.kind === 'bomb') bombEvents.push(m);
      else origOnFire(shooter, tgt, weapon, m);
    };

    const traj = recordTraj ? [] : null;
    let destroyedAt = null;
    let tick = 0;
    const maxTicks = Math.round(MAX_T / DT);

    for (; tick < maxTicks; tick++) {
      AT.loop.onFixedUpdate(DT);
      AT.loop.simTime += DT;
      const t = (tick + 1) * DT;
      const flat = Math.hypot(targetXZ.x - u.pos.x, targetXZ.z - u.pos.z);
      const phase = u.attackRun;
      const ground = terrain.heightAt(u.pos.x, u.pos.z);

      let stage = null;
      if (sam && sam.alive) {
        const samFlat = Math.hypot(sam.pos.x - u.pos.x, sam.pos.z - u.pos.z);
        if (samFlat <= cfg.samRange && terrain.hasLineOfSight(sam.pos, u.pos, SAM_CLEARANCE, SAM_STEP)) {
          if (u.evading) stage = 'evading';
          else if (phase === 'in' && flat > 8000) stage = 'farIn';
          else if (phase === 'in' && flat <= 8000) stage = 'nearIn';
          else if (phase === 'pull') stage = 'pull';
          else if (phase === 'out') stage = 'out';
          else stage = 'other';
          samBuckets[stage] += DT;
        }
      }

      if (u.alive) {
        const agl = u.pos.y - ground;
        if (agl < minAGL) minAGL = agl;
        if (phase === 'in') { inAGLSum += agl; inAGLCount++; }
        else if (phase === 'out') { outAGLSum += agl; outAGLCount++; }
        if (u.terrainAvoiding) terrainAvoidingSec += DT;
      }

      if (traj) traj.push({ t, x: u.pos.x, z: u.pos.z, y: u.pos.y, speed: u.speed, phase, ground, seenStage: stage });

      if (!target.alive && destroyedAt == null) destroyedAt = t;
      if (!u.alive) { if (u.deathCause === 'terrain') terrainCollision = true; break; }
      if (destroyedAt != null && t - destroyedAt > 20) break;
    }

    world.onFire = null;
    world.onMissileHit = null;

    bombsUsed = bombEvents.length;
    hits = bombEvents.filter((m) => m.endReason === 'hit').length;

    const result = {
      destroyed: !target.alive, destroyedAt: round(destroyedAt, 1),
      loss: !u.alive, terrainCollision,
      bombsUsed, hits,
      samFired, samHits,
      samBuckets: { ...samBuckets },
      minAGL: Number.isFinite(minAGL) ? round(minAGL) : null,
      inAGLAvg: inAGLCount ? round(inAGLSum / inAGLCount) : null,
      outAGLAvg: outAGLCount ? round(outAGLSum / outAGLCount) : null,
      terrainAvoidingSec: round(terrainAvoidingSec, 1),
      endT: round(tick * DT, 1),
    };
    if (traj) result.traj = traj;
    return result;
  }

  // ---------------------------------------------------------------- 実行本体

  window.__tossC3dRun = async () => {
    const stage = await loadStage();
    const target0 = stage.enemy.ground.find((g) => g.type === 'RADAR');
    const base0 = stage.friendly.base;
    const bearing0 = headingOf(target0.x - base0.x, target0.z - base0.z);
    const distBaseTarget = Math.hypot(base0.x - target0.x, base0.z - target0.z);

    const rngMod = await import('/js/core/rng.js');
    const unitMod = await import('/js/sim/unit.js');
    const clamp = rngMod.clamp, angleDiff = unitMod.angleDiff;
    const weaponsMod = await import('/js/data/weapons.js');
    const samRange = weaponsMod.WEAPONS['SAM-M'].range;

    const perp = bearing0 + Math.PI / 2;
    const samDefs = {
      S0: offset(target0, 300, perp),
      S1: offset(target0, 1000, perp),
      S2: offset(target0, 1000, perp + Math.PI),
      S3: offset(target0, 1500, bearing0),
      S4: offset(target0, 1500, bearing0 + Math.PI),
    };
    const headingDefs = { h0: 0, hp15: 15 * DEG, hm15: -15 * DEG };
    function rotatedBase(offsetRad) {
      const brg = bearing0 + offsetRad;
      return { x: target0.x - distBaseTarget * Math.sin(brg), z: target0.z + distBaseTarget * Math.cos(brg) };
    }

    const samLabels = ['S0', 'S1', 'S2', 'S3', 'S4'];
    const headingLabels = ['h0', 'hp15', 'hm15'];
    const variants = { T0: null, T1a: 0.6, T1b: 0.8, T1c: 1.0 };

    const allRuns = {};
    let a3Spec = null;

    // --- 測定A用の集計器（T0のみ） ---
    const aSum = { seenSec: {}, hidden220Sec: {}, hiddenMinSec: {} };
    const stageKeysA = ['farIn', 'nearIn', 'pull', 'out', 'evading', 'other'];
    for (const k of stageKeysA) { aSum.seenSec[k] = 0; aSum.hidden220Sec[k] = 0; aSum.hiddenMinSec[k] = 0; }

    async function runOne(variantLabel, margin, samLabel, headingLabel) {
      const id = `tc3d_${variantLabel}_${samLabel}_${headingLabel}`;
      const base = rotatedBase(headingDefs[headingLabel]);
      const samXZ = samDefs[samLabel];
      const extraGround = [{ type: 'SAM', name: `SAM ${samLabel}`, x: round(samXZ.x), z: round(samXZ.z), known: true }];
      const ctx = await openScenario(id, stage, base, extraGround);
      if (!a3Spec) a3Spec = { climbRate: ctx.u.spec.climbRate, cruiseSpeed: ctx.u.spec.cruiseSpeed };
      if (margin != null) installLowFloorPatch(ctx.u, clamp, angleDiff, margin);

      const recordTraj = variantLabel === 'T0';
      const res = runTrialD(ctx, { samRange }, recordTraj);

      if (recordTraj && res.traj) {
        const hMin = computeMinFlyable(res.traj, a3Spec.climbRate, a3Spec.cruiseSpeed, clamp);
        const h = evaluateHidden(res.traj, hMin, ctx.sam.pos, ctx.world.terrain);
        for (const k of stageKeysA) {
          aSum.seenSec[k] += h.seenSec[k];
          aSum.hidden220Sec[k] += h.hidden220Sec[k];
          aSum.hiddenMinSec[k] += h.hiddenMinSec[k];
        }
        delete res.traj; // 生の航跡は返り値に残さない
      }
      allRuns[`${variantLabel}_${samLabel}_${headingLabel}`] = res;
      return res;
    }

    for (const [variantLabel, margin] of Object.entries(variants)) {
      for (const samLabel of samLabels) {
        for (const headingLabel of headingLabels) {
          await runOne(variantLabel, margin, samLabel, headingLabel);
        }
      }
    }

    // ---------------------------------------------------------------- 集計B
    function aggregateVariant(variantLabel) {
      const runs = [];
      for (const samLabel of samLabels) for (const h of headingLabels) runs.push(allRuns[`${variantLabel}_${samLabel}_${h}`]);
      const n = runs.length;
      const destroyedCount = runs.filter((r) => r.destroyed).length;
      const lossCount = runs.filter((r) => r.loss).length;
      const collisionCount = runs.filter((r) => r.terrainCollision).length;
      const timeVals = runs.map((r) => r.destroyedAt != null ? r.destroyedAt : r.endT);
      const samSeen = {};
      for (const k of stageKeysA) samSeen[k] = round(sum(runs.map((r) => r.samBuckets[k])), 1);
      return {
        variant: variantLabel, n,
        destroyedCount, avgTime: round(mean(timeVals), 1),
        avgBombs: round(mean(runs.map((r) => r.bombsUsed)), 2),
        lossCount, collisionCount,
        samFiredSum: sum(runs.map((r) => r.samFired)),
        samHitsSum: sum(runs.map((r) => r.samHits)),
        samSeen,
        inAGLAvg: round(mean(runs.map((r) => r.inAGLAvg)), 0),
        outAGLAvg: round(mean(runs.map((r) => r.outAGLAvg)), 0),
        minAGL: round(Math.min(...runs.map((r) => r.minAGL != null ? r.minAGL : Infinity)), 1),
        terrainAvoidingSecAvg: round(mean(runs.map((r) => r.terrainAvoidingSec)), 1),
      };
    }

    const tableB = Object.keys(variants).map(aggregateVariant);

    // ---------------------------------------------------------------- 集計A(表)
    const tableA = stageKeysA.map((k) => ({
      stage: k,
      seenSec: round(aSum.seenSec[k], 1),
      hidden220Sec: round(aSum.hidden220Sec[k], 1),
      hiddenMinFlyableSec: round(aSum.hiddenMinSec[k], 1),
    }));

    window.__tossC3dLast = { stage, samDefs, bearing0, samRange, a3Spec, allRuns };

    return {
      a3Spec,
      formulas: {
        climbCap: 'climbCap = spec.climbRate * clamp(speed/spec.cruiseSpeed, 0.35, 1.2)  [js/sim/aircraft.js:802-804]',
        descentCap: 'descentCap = climbCap * 1.4 (vs = clamp(altErr>0?altErr*0.9:altErr*0.35, -climbCap*1.4, climbCap))  [js/sim/aircraft.js:1785]',
      },
      tableA,
      tableB,
    };
  };
})();
