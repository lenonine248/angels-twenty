// c3 で「SAMから隠れられるか」の5回目。tools/_tossc3d.js の構造
// (loadStage/openScenario/低い床パッチ/runTrial)を写して使う。
// ゲーム本体(js/)は一切変更しない。
//
// 読み(未測定・今回検証する): トスの進入・離脱の指令高度は
//   js/sim/aircraft.js:1032-1036
//     const floor = this._terrainFloor(world, desiredHeading) + 300;
//     if (run.phase === 'pull') { desiredAlt = this.pos.y + TOSS_PULL_ALT; }
//     else {
//       desiredAlt = o.alt ?? this.commandedAlt ?? Math.max(t.pos.y + TOSS_INGRESS_ALT, floor);
//       if (run.phase === 'out') desiredAlt = Math.max(desiredAlt, floor);
//     }
//   TOSS_INGRESS_ALT = 300 (aircraft.js:35)。つまり「目標の高度+300」と「地形の床+300」の
//   大きい方が使われる。目標より低い土地の上では、床をいくら下げてもこの
//   「目標+300」が下限として残る、という読み。
//
// 変種:
//   T0  今のトス(無改造)
//   T1b 床の係数0.8(_terrainScanを差し替え。前回と同じ)
//   T1d T1bの床 ＋ in/outの指令高度を「床だけ」にする(目標+300の下限を外す)。
//       やり方(本体は変えない): u._terrainFloor をラップして、トスのin/out中に
//       呼ばれた値(=aircraft.js:1032の floor 用の生値)を lastFloor として毎回記録する。
//       u._steer もラップし、呼び出し前に「前tickの attackRun が in/out だったら
//       commandedAlt = lastFloor + 300、そうでなければ null」を u.commandedAlt に立てて
//       から本来の _steer を呼ぶ。aircraft.js 1035行の
//       `o.alt ?? this.commandedAlt ?? Math.max(...)` が commandedAlt を拾うので、
//       "目標+300" 分岐に入らず「床+300」だけが使われる。1tick(1/30s)遅れの値を使うが、
//       地形は滑らかなので実用上の差は無視できる。pull中はcommandedAltを見ないコードなので
//       無害。プレイヤーが高度指定した場合(o.alt)は今回考えない。
//   T1e T1dと同じだが、u._steer 呼び出し時点で「既知のSAM陣地が26km以内」
//       (js/ai/pilot.js:88 SAM_AVOID_RANGE=26000と同じ値)のときだけ低床パッチと
//       commandedAlt上書きを適用するゲート付き。26km超ではT0と同じ(元のtherrainScan・
//       commandedAltは触らない)に完全フォールバックする。
//
// 読み込み:
//   await fetch('/tools/_tossc3e.js').then(r => r.text()).then(eval);
// 実行(重いので直接awaitせず、fire-and-forgetしてポーリングで回収する):
//   window.__tc3eResult = null;
//   window.__tossC3eRun().then(r => window.__tc3eResult = r)
//     .catch(e => window.__tc3eResult = { error: String((e && e.stack) || e) });
// 回収:
//   window.__tc3eResult   // nullなら未完了
//
// 生ログ(各runの生の集計)は window.__tossC3eLast に積む。航跡そのものは積まない。
(() => {
  const DT = 1 / 30;
  const DEG = Math.PI / 180;
  const MAX_T = 260;
  const SAM_CLEARANCE = 8, SAM_STEP = 400;
  const RIDGE_CLIMB = 2200, LOOK_STEP = 150, LOOK_NEAR = 3000, MIN_AGL = 220;
  const SAM_AVOID_RANGE = 26000; // js/ai/pilot.js:88 と同じ値
  const TOSS_INGRESS_ALT = 300; // js/sim/aircraft.js:35 と同じ値(確認用)

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
  function median(arr) {
    const a = arr.filter((x) => x != null).slice().sort((x, y) => x - y);
    if (!a.length) return null;
    const mid = a.length >> 1;
    return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
  }

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
      id, group: '計測', name: 'TOSS C3E PROBE', title: '計測用（非表示）',
      battleSeed: 0xC30004,
      brief: '計測用の内部ステージ（c3の地形・配置を写す・SAM隠れ5回目）。', hint: '',
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

  // ---------------------------------------------------------------- 低い床パッチ（T1b/d/e共通・margin0.8）
  // gate() が false を返す間は元の _terrainScan にそのままフォールバックする(T1eの26km外)。
  function installLowFloorPatch(u, clamp, angleDiff, margin, gate) {
    const gateFn = gate || (() => true);
    const orig = u._terrainScan.bind(u);
    u._terrainScan = function (world, desiredHeading = u.heading) {
      if (u.bombProfile === 'toss' && (u.attackRun === 'in' || u.attackRun === 'out') && gateFn()) {
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

  // ---------------------------------------------------------------- T1d/T1e: 指令高度を「床だけ」にする上書き
  // gate() が false の間は commandedAlt を一切触らない(=T0と同じ経路)。
  function installFloorOnlyOverride(u, gate) {
    const gateFn = gate || (() => true);
    let lastFloor = null;
    let overrideSec = 0;
    const origTerrainFloor = u._terrainFloor.bind(u);
    u._terrainFloor = function (world, desiredHeading) {
      const f = origTerrainFloor(world, desiredHeading);
      if (u.bombProfile === 'toss' && (u.attackRun === 'in' || u.attackRun === 'out')) lastFloor = f;
      return f;
    };
    const origSteer = u._steer.bind(u);
    u._steer = function (dt, world) {
      const active = u.bombProfile === 'toss' && (u.attackRun === 'in' || u.attackRun === 'out') && gateFn();
      if (active && lastFloor != null) {
        u.commandedAlt = lastFloor + 300;
        overrideSec += dt;
      } else {
        u.commandedAlt = null;
      }
      return origSteer(dt, world);
    };
    return { stats: () => ({ overrideSec: round(overrideSec, 1) }) };
  }

  // ---------------------------------------------------------------- T1b専用: 「目標+300」vs「床+300」の優劣プローブ（問い1）
  function installDominanceProbe(u, target) {
    const stats = { floorSec: 0, targetSec: 0, tieSec: 0 };
    const origTerrainFloor = u._terrainFloor.bind(u);
    u._terrainFloor = function (world, desiredHeading) {
      const f = origTerrainFloor(world, desiredHeading);
      if (u.bombProfile === 'toss' && (u.attackRun === 'in' || u.attackRun === 'out')) {
        const floorTerm = f + 300;
        const targetTerm = target.pos.y + TOSS_INGRESS_ALT;
        if (floorTerm > targetTerm) stats.floorSec += DT;
        else if (targetTerm > floorTerm) stats.targetSec += DT;
        else stats.tieSec += DT;
      }
      return f;
    };
    return stats;
  }

  // ---------------------------------------------------------------- 1試行
  const stageKeys = ['farIn', 'nearIn', 'pull', 'out', 'evading', 'other'];

  function runTrialE(ctx, cfg) {
    const { world, u, target, sam } = ctx;
    const terrain = world.terrain;
    const targetXZ = { x: target.pos.x, z: target.pos.z };

    u.bombProfile = 'toss';
    u.setPlayerOrder({ type: 'attack', target });

    let samFired = 0, samHits = 0;
    world.onMissileHit = (m, tgt) => { if (tgt === u && m.weapon && m.weapon.kind === 'sam') samHits++; };

    const samBuckets = {}; for (const k of stageKeys) samBuckets[k] = 0;
    let minAGL = Infinity, terrainCollision = false;
    let inAGLSum = 0, inAGLCount = 0, outAGLSum = 0, outAGLCount = 0;
    let terrainAvoidingSec = 0;
    const bombEvents = [];
    world.onFire = (shooter, tgt, weapon, m) => {
      if (shooter === u && weapon.kind === 'bomb') bombEvents.push(m);
      else if (sam && shooter === sam && weapon.kind === 'sam') samFired++;
    };

    let firstSeenStage = null, firstSeenDist = null;
    let prevPhase = null;
    const pullStartDists = [];

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

      if (prevPhase === 'in' && phase === 'pull') pullStartDists.push(flat);
      prevPhase = phase;

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
          if (firstSeenStage == null) { firstSeenStage = stage; firstSeenDist = flat; }
        }
      }

      if (u.alive) {
        const agl = u.pos.y - ground;
        if (agl < minAGL) minAGL = agl;
        if (phase === 'in') { inAGLSum += agl; inAGLCount++; }
        else if (phase === 'out') { outAGLSum += agl; outAGLCount++; }
        if (u.terrainAvoiding) terrainAvoidingSec += DT;
      }

      if (!target.alive && destroyedAt == null) destroyedAt = t;
      if (!u.alive) { if (u.deathCause === 'terrain') terrainCollision = true; break; }
      if (destroyedAt != null && t - destroyedAt > 20) break;
    }

    world.onFire = null;
    world.onMissileHit = null;

    const bombsUsed = bombEvents.length;
    const hits = bombEvents.filter((m) => m.endReason === 'hit').length;
    const groundImpacts = bombEvents.filter((m) => m.endReason === 'ground').length;

    return {
      destroyed: !target.alive, destroyedAt: round(destroyedAt, 1),
      loss: !u.alive, terrainCollision,
      bombsUsed, hits, groundImpacts,
      samFired, samHits,
      samBuckets: { ...samBuckets },
      minAGL: Number.isFinite(minAGL) ? round(minAGL) : null,
      inAGLAvg: inAGLCount ? round(inAGLSum / inAGLCount) : null,
      outAGLAvg: outAGLCount ? round(outAGLSum / outAGLCount) : null,
      terrainAvoidingSec: round(terrainAvoidingSec, 1),
      firstSeenStage, firstSeenDist: round(firstSeenDist, 0),
      pullStartDists: pullStartDists.map((d) => round(d, 0)),
      endT: round(tick * DT, 1),
    };
  }

  // ---------------------------------------------------------------- 実行本体
  window.__tossC3eRun = async () => {
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
    const headingDefs = { h0: 0, hp10: 10 * DEG, hm10: -10 * DEG, hp20: 20 * DEG, hm20: -20 * DEG, hp30: 30 * DEG };
    function rotatedBase(offsetRad) {
      const brg = bearing0 + offsetRad;
      return { x: target0.x - distBaseTarget * Math.sin(brg), z: target0.z + distBaseTarget * Math.cos(brg) };
    }

    const samLabels = ['S0', 'S1', 'S2', 'S3', 'S4'];
    const headingLabels = ['h0', 'hp10', 'hm10', 'hp20', 'hm20', 'hp30'];
    const variantCfg = {
      T0: { margin: null, override: false, gated: false },
      T1b: { margin: 0.8, override: false, gated: false },
      T1d: { margin: 0.8, override: true, gated: false },
      T1e: { margin: 0.8, override: true, gated: true },
    };

    const allRuns = {};
    const dominanceSum = { floorSec: 0, targetSec: 0, tieSec: 0 };
    const overrideSecSum = { T1d: 0, T1e: 0 };

    async function runOne(variantLabel, samLabel, headingLabel) {
      const cfg = variantCfg[variantLabel];
      const id = `tc3e_${variantLabel}_${samLabel}_${headingLabel}`;
      const base = rotatedBase(headingDefs[headingLabel]);
      const samXZ = samDefs[samLabel];
      const extraGround = [{ type: 'SAM', name: `SAM ${samLabel}`, x: round(samXZ.x), z: round(samXZ.z), known: true }];
      const ctx = await openScenario(id, stage, base, extraGround);

      let gate = () => true;
      if (cfg.gated) {
        gate = () => ctx.sam && ctx.sam.alive
          && Math.hypot(ctx.sam.pos.x - ctx.u.pos.x, ctx.sam.pos.z - ctx.u.pos.z) <= SAM_AVOID_RANGE;
      }
      if (cfg.margin != null) installLowFloorPatch(ctx.u, clamp, angleDiff, cfg.margin, gate);

      let overrideHandle = null;
      if (cfg.override) overrideHandle = installFloorOnlyOverride(ctx.u, gate);

      let domProbe = null;
      if (variantLabel === 'T1b') domProbe = installDominanceProbe(ctx.u, ctx.target);

      const res = runTrialE(ctx, { samRange });

      if (domProbe) {
        dominanceSum.floorSec += domProbe.floorSec;
        dominanceSum.targetSec += domProbe.targetSec;
        dominanceSum.tieSec += domProbe.tieSec;
      }
      if (overrideHandle && (variantLabel === 'T1d' || variantLabel === 'T1e')) {
        overrideSecSum[variantLabel] += overrideHandle.stats().overrideSec;
      }

      allRuns[`${variantLabel}_${samLabel}_${headingLabel}`] = res;
      return res;
    }

    for (const variantLabel of Object.keys(variantCfg)) {
      for (const samLabel of samLabels) {
        for (const headingLabel of headingLabels) {
          await runOne(variantLabel, samLabel, headingLabel);
        }
      }
    }

    // ---------------------------------------------------------------- 集計（表2）
    function aggregateVariant(variantLabel) {
      const runs = [];
      for (const samLabel of samLabels) for (const h of headingLabels) runs.push(allRuns[`${variantLabel}_${samLabel}_${h}`]);
      const n = runs.length;
      const timeVals = runs.map((r) => r.destroyedAt != null ? r.destroyedAt : r.endT);
      const samSeen = {};
      for (const k of stageKeys) samSeen[k] = round(sum(runs.map((r) => r.samBuckets[k])), 1);
      const allPullDists = [];
      for (const r of runs) for (const d of r.pullStartDists) allPullDists.push(d);
      return {
        variant: variantLabel, n,
        destroyedCount: runs.filter((r) => r.destroyed).length,
        avgTime: round(mean(timeVals), 1),
        avgBombs: round(mean(runs.map((r) => r.bombsUsed)), 2),
        lossCount: runs.filter((r) => r.loss).length,
        collisionCount: runs.filter((r) => r.terrainCollision).length,
        samFiredSum: sum(runs.map((r) => r.samFired)),
        samHitsSum: sum(runs.map((r) => r.samHits)),
        samSeen,
        inAGLAvg: round(mean(runs.map((r) => r.inAGLAvg)), 0),
        outAGLAvg: round(mean(runs.map((r) => r.outAGLAvg)), 0),
        minAGL: round(Math.min(...runs.map((r) => r.minAGL != null ? r.minAGL : Infinity)), 1),
        terrainAvoidingSecAvg: round(mean(runs.map((r) => r.terrainAvoidingSec)), 1),
        pullStartDistAvg: round(mean(allPullDists), 0),
        pullStartDistN: allPullDists.length,
        groundImpactBombsSum: sum(runs.map((r) => r.groundImpacts)),
      };
    }
    const tableVariant = Object.keys(variantCfg).map(aggregateVariant);

    // ---------------------------------------------------------------- 問い3: 最初にSAMに見えた瞬間
    function firstSeenSummary(variantLabel) {
      const runs = [];
      for (const samLabel of samLabels) for (const h of headingLabels) runs.push(allRuns[`${variantLabel}_${samLabel}_${h}`]);
      const byStage = {};
      for (const k of stageKeys) byStage[k] = 0;
      let neverSeen = 0;
      const dists = [];
      for (const r of runs) {
        if (r.firstSeenStage == null) { neverSeen++; continue; }
        byStage[r.firstSeenStage]++;
        dists.push(r.firstSeenDist);
      }
      return { variant: variantLabel, n: runs.length, neverSeen, byStage, medianDist: round(median(dists), 0) };
    }
    const firstSeenTable = ['T0', 'T1d', 'T1e'].map(firstSeenSummary);

    // ---------------------------------------------------------------- 問い1: T1bのdominance
    const domTotal = dominanceSum.floorSec + dominanceSum.targetSec + dominanceSum.tieSec;
    const dominanceResult = {
      floorSec: round(dominanceSum.floorSec, 1),
      targetSec: round(dominanceSum.targetSec, 1),
      tieSec: round(dominanceSum.tieSec, 1),
      floorPct: domTotal ? round(dominanceSum.floorSec / domTotal * 100, 1) : null,
      targetPct: domTotal ? round(dominanceSum.targetSec / domTotal * 100, 1) : null,
    };

    window.__tossC3eLast = { stage, samDefs, bearing0, samRange, allRuns };

    return {
      note: 'commandedAlt override mechanism: u._terrainFloor と u._steer をラップ。詳細はファイル冒頭コメント参照。',
      dominance_T1b: dominanceResult,
      overrideSecSum,
      tableVariant,
      firstSeenTable,
    };
  };
})();
