// c3 で「SAMから隠れられるか」の2回目。tools/_tossc3.js の土台を流用し、
// (1) 低い床パッチ(T1)・(2) SAM位置5通り・(3) 出発方位ジッタ±15°・(4) 回避有無の測定 を追加する。
// ゲーム本体(js/)は一切変更しない。低い床は対象インスタンスの _terrainScan だけを
// 差し替える（プロトタイプは触らない）。定数(LOOK_STEP等)は js/sim/aircraft.js から
// 読み取ってコピーしただけで、書き換えてはいない。
//
// 読み込み（先に harness を読んでおくこと）:
//   await fetch('/tools/_tut_harness.js').then(r => r.text()).then(eval);
//   await fetch('/tools/_tossc3b.js').then(r => r.text()).then(eval);
// 実行（1回の呼び出しの中で最後まで回すこと）:
//   const res = await __tossC3bRun();
//
// 返り値: 集計済みオブジェクト。生ログは window.__tossC3bLast に積む。
(() => {
  const DT = 1 / 30;
  const DEG = Math.PI / 180;
  const MAX_T = 260;
  // aircraft.js の定数をそのまま複製（読み取りのみ。§の低い床パッチで使う）
  const RIDGE_CLIMB = 2200, LOOK_STEP = 150, LOOK_NEAR = 3000, MIN_AGL = 220;
  const LOW_FLOOR_MARGIN = 0.6;
  const SAM_EVADE_WINDOW = 15; // SAM発射後、回避状態を見る秒数

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

  // ---------------------------------------------------------------- シナリオ構築

  function buildScenario(id, stage, base, extraGround) {
    const ground = (stage.enemy.ground || []).map((g) => ({ ...g }));
    if (extraGround) ground.push(...extraGround);
    return {
      id, group: '計測', name: 'TOSS C3B PROBE', title: '計測用（非表示）',
      battleSeed: 0xC30002,
      brief: '計測用の内部ステージ（c3の地形・配置を写す・SAM隠れ2回目）。', hint: '',
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

  // ---------------------------------------------------------------- 低い床パッチ（T1）
  // インスタンスの _terrainScan だけを差し替える。プロトタイプ(js/sim/aircraft.js)は触らない。
  // bombProfile==='toss' かつ attackRun が 'in'/'out' のときだけ低い床を返し、
  // それ以外は元の _terrainScan(bind済み)をそのまま呼ぶ。dist は元のscanの意味(peakAt)を再現する。
  function installLowFloorPatch(u, clamp, angleDiff) {
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
        let lowFloor = ground + MIN_AGL; // s=0 の寄与
        while (travelled < lookAhead) {
          const step = travelled < LOOK_NEAR ? LOOK_STEP : LOOK_STEP * 3;
          const turnPerStep = turnNear * (step / LOOK_STEP);
          const turn = clamp(remaining, -turnPerStep, turnPerStep);
          h += turn; remaining -= turn;
          x += Math.sin(h) * step; z += -Math.cos(h) * step;
          travelled += step;
          const g = terrain.heightAt(x, z);
          if (g > ground) { ground = g; peakAt = travelled; }
          const req = g + MIN_AGL - LOW_FLOOR_MARGIN * climbRate * (travelled / Math.max(50, speed));
          if (req > lowFloor) lowFloor = req;
        }
        return { floor: Math.max(lowFloor, 0), dist: peakAt };
      }
      return orig(world, desiredHeading);
    };
  }

  // ---------------------------------------------------------------- 1試行

  function runTrial(ctx, cfg) {
    const { world, u, target, sam } = ctx;
    const terrain = world.terrain;
    const targetXZ = { x: target.pos.x, z: target.pos.z };

    u.bombProfile = cfg.profile;
    u.setPlayerOrder({ type: 'attack', target });
    if (cfg.scripted) AT.commands._applyAltitude(u, cfg.ridgeAlt - 50);

    const bombEvents = [];
    const samFireEvents = []; // {t}
    let samHits = 0;

    const onFire = (shooter, tgt, weapon, m) => {
      if (shooter === u && weapon.kind === 'bomb') {
        bombEvents.push({ t: AT.loop.simTime, flat: Math.hypot(targetXZ.x - u.pos.x, targetXZ.z - u.pos.z), alt: u.pos.y, phase: u.attackRun, m });
      } else if (sam && shooter === sam && weapon.kind === 'sam') {
        samFireEvents.push({ t: AT.loop.simTime });
      }
    };
    world.onFire = onFire;
    world.onMissileHit = (m, tgt) => { if (tgt === u && m.weapon && m.weapon.kind === 'sam') samHits++; };

    let radarSeenSeconds = 0, firstSeen = null;
    let samSeenSeconds = 0;
    const samBuckets = { farIn: 0, nearIn: 0, pull: 0, out: 0, other: 0 };
    const evadeTrace = []; // {t, evading}
    let minAGL = Infinity;
    let terrainCollision = false;
    const milestoneMarkers = [12000, 8000, 5000];
    const milestones = {};
    let remainingMarkers = [...milestoneMarkers];

    let climbTriggered = false, egressTriggered = false;
    let destroyedAt = null;
    let tick = 0;
    const maxTicks = Math.round(MAX_T / DT);

    for (; tick < maxTicks; tick++) {
      AT.loop.onFixedUpdate(DT);
      AT.loop.simTime += DT;
      const t = (tick + 1) * DT;
      const flat = Math.hypot(targetXZ.x - u.pos.x, targetXZ.z - u.pos.z);
      const phase = u.attackRun;

      if (cfg.scripted) {
        if (!climbTriggered && flat <= 4500) { AT.commands._applyAltitude(u, u.pos.y + 2000); climbTriggered = true; }
        if (!egressTriggered && bombEvents.length >= 1) {
          u.setPlayerOrder({ type: 'move', x: cfg.basePos.x, z: cfg.basePos.z, alt: cfg.ridgeAlt - 200 });
          egressTriggered = true;
        }
      }

      // --- レーダー(目標)からの見通し ---
      const losRadar = terrain.hasLineOfSight(target.pos, u.pos, 8, 400);
      if (losRadar) {
        radarSeenSeconds += DT;
        if (!firstSeen) firstSeen = { t: round(t, 1), flat: round(flat), alt: round(u.pos.y), phase };
      }

      // --- SAMからの見通し・段階別バケツ ---
      if (sam && sam.alive) {
        const samFlat = Math.hypot(sam.pos.x - u.pos.x, sam.pos.z - u.pos.z);
        if (samFlat <= cfg.samRange && terrain.hasLineOfSight(sam.pos, u.pos, 8, 400)) {
          samSeenSeconds += DT;
          if (u.evading) samBuckets.other += DT;
          else if (phase === 'in' && flat > 8000) samBuckets.farIn += DT;
          else if (phase === 'in' && flat <= 8000) samBuckets.nearIn += DT;
          else if (phase === 'pull') samBuckets.pull += DT;
          else if (phase === 'out') samBuckets.out += DT;
          else samBuckets.other += DT;
        }
      }
      evadeTrace.push({ t, evading: !!u.evading });

      // --- 地表高度・衝突 ---
      if (u.alive) {
        const agl = u.pos.y - terrain.heightAt(u.pos.x, u.pos.z);
        if (agl < minAGL) minAGL = agl;
      }

      // --- 進入距離の節目(高度) ---
      if (phase === 'in' || phase == null) {
        for (const marker of [...remainingMarkers]) {
          if (flat <= marker) { milestones[marker] = round(u.pos.y); remainingMarkers = remainingMarkers.filter((m) => m !== marker); }
        }
      }

      if (!target.alive && destroyedAt == null) destroyedAt = t;
      if (!u.alive) { if (u.deathCause === 'terrain') terrainCollision = true; break; }
      if (destroyedAt != null && t - destroyedAt > 20) break;
    }

    world.onFire = null;
    world.onMissileHit = null;

    const bombs = bombEvents.map((e) => {
      const m = e.m;
      return { fireT: round(e.t, 1), fireFlat: round(e.flat), fireAlt: round(e.alt), phase: e.phase, endReason: m.endReason || 'alive?', hit: m.endReason === 'hit' };
    });

    // --- SAM発射ごとの回避有無 ---
    const samFireDetail = samFireEvents.map((f) => {
      const evadedWindow = evadeTrace.some((e) => e.t >= f.t && e.t <= f.t + SAM_EVADE_WINDOW && e.evading);
      return { t: round(f.t, 1), evaded: evadedWindow };
    });

    return {
      destroyed: !target.alive, destroyedAt: round(destroyedAt, 1),
      aircraftAlive: u.alive, loss: !u.alive, terrainCollision,
      bombsUsed: bombs.length, hits: bombs.filter((b) => b.hit).length,
      radarSeenSeconds: round(radarSeenSeconds, 1), firstSeen,
      samSeenSeconds: sam ? round(samSeenSeconds, 1) : null,
      samBuckets: sam ? { farIn: round(samBuckets.farIn, 1), nearIn: round(samBuckets.nearIn, 1), pull: round(samBuckets.pull, 1), out: round(samBuckets.out, 1), other: round(samBuckets.other, 1) } : null,
      samFired: samFireEvents.length, samHits, samFireDetail,
      minAGL: Number.isFinite(minAGL) ? round(minAGL) : null,
      milestones, endT: round(tick * DT, 1),
    };
  }

  // ---------------------------------------------------------------- 実行本体

  window.__tossC3bRun = async () => {
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

    // --- SAM位置5通り（進入方位=bearing0基準。ジッタの影響を受けない絶対座標） ---
    const perp = bearing0 + Math.PI / 2;
    const samDefs = {
      S0: offset(target0, 300, perp),
      S1: offset(target0, 1000, perp),
      S2: offset(target0, 1000, perp + Math.PI),
      S3: offset(target0, 1500, bearing0),
      S4: offset(target0, 1500, bearing0 + Math.PI),
    };

    // --- 出発方位ジッタ（同じ距離で目標周りに回す。SAM位置は上のsamDefsで固定） ---
    const headingDefs = { h0: 0, hp15: 15 * DEG, hm15: -15 * DEG };
    function rotatedBase(offsetRad) {
      const brg = bearing0 + offsetRad;
      return { x: target0.x - distBaseTarget * Math.sin(brg), z: target0.z + distBaseTarget * Math.cos(brg) };
    }

    // --- 地形取得（スローアウェイのシナリオを1本開けて terrain を掴む） ---
    const probeCtx = await openScenario('tossc3b_probe0', stage, base0, null);
    const terrain = probeCtx.world.terrain;
    const samElev = {};
    for (const [label, p] of Object.entries(samDefs)) samElev[label] = { x: round(p.x), z: round(p.z), h: round(terrain.heightAt(p.x, p.z)) };

    // --- ridgeAlt（T3台本用。base0→target0直線上の最高点） ---
    let ridgeAlt = target0.y != null ? target0.y + 500 : 2500;
    {
      const dx = target0.x - base0.x, dz = target0.z - base0.z;
      const dist = Math.hypot(dx, dz);
      const n = Math.max(1, Math.floor(dist / 250));
      let peak = -Infinity;
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        const h = terrain.heightAt(base0.x + dx * t, base0.z + dz * t);
        if (h > peak) peak = h;
      }
      if (Number.isFinite(peak)) ridgeAlt = peak;
    }

    const allRuns = {};
    const table = [];

    async function runOne(variant, samLabel, headingLabel) {
      const id = `tc3b_${variant}_${samLabel}_${headingLabel}`;
      const base = rotatedBase(headingDefs[headingLabel]);
      const samXZ = samDefs[samLabel];
      const extraGround = [{ type: 'SAM', name: `SAM ${samLabel}`, x: round(samXZ.x), z: round(samXZ.z), known: true }];
      const ctx = await openScenario(id, stage, base, extraGround);

      if (variant === 'T1') installLowFloorPatch(ctx.u, clamp, angleDiff);

      const cfg = {
        profile: variant === 'T2' ? 'level' : 'toss',
        scripted: variant === 'T3',
        ridgeAlt, basePos: base, samRange,
      };
      const res = runTrial(ctx, cfg);
      const key = `${variant}_${samLabel}_${headingLabel}`;
      allRuns[key] = res;
      return res;
    }

    const variants = ['T0', 'T1', 'T2'];
    const samLabels = ['S0', 'S1', 'S2', 'S3', 'S4'];
    const headingLabels = ['h0', 'hp15', 'hm15'];

    for (const variant of variants) {
      for (const samLabel of samLabels) {
        for (const headingLabel of headingLabels) {
          await runOne(variant, samLabel, headingLabel);
        }
      }
    }
    // T3: S1のみ×3方位
    for (const headingLabel of headingLabels) {
      await runOne('T3', 'S1', headingLabel);
    }

    // ---------------------------------------------------------------- 集計
    function aggregate(variant, samLabel) {
      const runs = headingLabels.map((h) => allRuns[`${variant}_${samLabel}_${h}`]).filter(Boolean);
      const n = runs.length;
      const destroyedCount = runs.filter((r) => r.destroyed).length;
      const lossCount = runs.filter((r) => r.loss).length;
      const collisionCount = runs.filter((r) => r.terrainCollision).length;
      const timeVals = runs.map((r) => r.destroyedAt != null ? r.destroyedAt : r.endT);
      return {
        variant, samLabel, n,
        destroyedCount, avgTime: round(mean(timeVals), 1),
        avgBombs: round(mean(runs.map((r) => r.bombsUsed)), 2),
        avgHits: round(mean(runs.map((r) => r.hits)), 2),
        samSeen: {
          farIn: round(mean(runs.map((r) => r.samBuckets && r.samBuckets.farIn)), 1),
          nearIn: round(mean(runs.map((r) => r.samBuckets && r.samBuckets.nearIn)), 1),
          pull: round(mean(runs.map((r) => r.samBuckets && r.samBuckets.pull)), 1),
          out: round(mean(runs.map((r) => r.samBuckets && r.samBuckets.out)), 1),
          other: round(mean(runs.map((r) => r.samBuckets && r.samBuckets.other)), 1),
          total: round(mean(runs.map((r) => r.samSeenSeconds)), 1),
        },
        samFiredSum: sum(runs.map((r) => r.samFired)),
        samHitsSum: sum(runs.map((r) => r.samHits)),
        lossCount, collisionCount,
        minAGL: round(Math.min(...runs.map((r) => r.minAGL != null ? r.minAGL : Infinity)), 1),
      };
    }

    const aggTable = [];
    for (const variant of variants) for (const samLabel of samLabels) aggTable.push(aggregate(variant, samLabel));
    aggTable.push(aggregate('T3', 'S1'));

    // --- T1 vs T0: 進入高度(12/8/5km)の平均差 ---
    function milestoneAvg(variant, marker) {
      const vals = [];
      for (const samLabel of samLabels) for (const h of headingLabels) {
        const r = allRuns[`${variant}_${samLabel}_${h}`];
        if (r && r.milestones[marker] != null) vals.push(r.milestones[marker]);
      }
      return round(mean(vals), 0);
    }
    const milestoneCompare = [12000, 8000, 5000].map((m) => ({
      distFromTarget: m, T0: milestoneAvg('T0', m), T1: milestoneAvg('T1', m),
      drop: round(milestoneAvg('T0', m) - milestoneAvg('T1', m), 0),
    }));

    // --- 問い3: SAM発射時の回避有無（T0全SAM位置 vs T3） ---
    function evadeStats(variant, samLabelsForVariant) {
      let fired = 0, evaded = 0;
      for (const samLabel of samLabelsForVariant) for (const h of headingLabels) {
        const r = allRuns[`${variant}_${samLabel}_${h}`];
        if (!r) continue;
        fired += r.samFireDetail.length;
        evaded += r.samFireDetail.filter((f) => f.evaded).length;
      }
      return { fired, evaded, notEvaded: fired - evaded };
    }
    const evadeT0 = evadeStats('T0', samLabels);
    const evadeT3 = evadeStats('T3', ['S1']);

    window.__tossC3bLast = { stage, samDefs, samElev, bearing0, ridgeAlt, samRange, allRuns };

    return {
      samElev, ridgeAlt: round(ridgeAlt), targetY: round(probeCtx.target.pos.y),
      aggTable, milestoneCompare, evadeQ3: { T0: evadeT0, T3: evadeT3 },
    };
  };
})();
