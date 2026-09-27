// トス爆撃 AI（groundAttackRun/tossAttackRun 経由の自律攻撃）計測ハーネス。
// ゲーム本体(js/)は一切変更しない。実行専用・使い捨てではなく再利用前提。
//
// 読み込み（先に _tut_harness.js を読んでおくこと。__open/__fast等を使う）:
//   await fetch('/tools/_tut_harness.js').then(r => r.text()).then(eval);
//   await fetch('/tools/_tossai.js').then(r => r.text()).then(eval);
// 実行（1回の呼び出しの中で最後まで回すこと。§93.12 と同じ理由）:
//   await __tossAiRun()
//
// 返り値: { table: [...集計行], edge: {...端の場合}, uiCheck: {...} }
// 生ログは window.__tossAiLast に積む。
(() => {
  const DT = 1 / 30;
  const DEG = Math.PI / 180;
  const TARGET_XZ = { x: 26000, z: 28000 };
  const AAA_OFFSET = 200;
  const START_D = 12000;

  function buildTutorial(id, type, bombCount, groundCfg) {
    const enemyGround = [];
    if (groundCfg === 'radar') {
      enemyGround.push({
        type: 'RADAR', name: 'レーダーサイト', x: TARGET_XZ.x, z: TARGET_XZ.z,
        tags: ['target'], known: true,
      });
    } else if (groundCfg === 'radar_aaa') {
      enemyGround.push({
        type: 'RADAR', name: 'レーダーサイト', x: TARGET_XZ.x, z: TARGET_XZ.z,
        tags: ['target'], known: true,
      });
      enemyGround.push({
        type: 'AAA', name: '対空砲', x: TARGET_XZ.x + AAA_OFFSET, z: TARGET_XZ.z,
        known: true,
      });
    } else if (groundCfg === 'airbase') {
      enemyGround.push({
        type: 'AIRBASE', name: '飛行場', x: TARGET_XZ.x, z: TARGET_XZ.z,
        tags: ['target'], known: true,
      });
    }
    return {
      id,
      group: '計測',
      name: 'TOSS AI PROBE',
      title: '計測用（非表示）',
      brief: '計測用の内部ステージ。地形はほぼ平坦。',
      hint: '',
      terrain: { seed: 90017, mountainAmount: 0, coast: 'none', valleyDepth: 0, rivers: 0, baseAltitude: 400 },
      weaponPoints: 0,
      noFail: true,
      friendly: {
        base: { x: 11000, z: 40000 },
        startAirborne: true,
        startAlt: 3000,
        aircraft: [{
          type, name: 'PROBE 1', loadout: Array(bombCount).fill('BOMB'),
          autoWeapons: { BOMB: true },
        }],
      },
      enemy: { aircraft: [], ground: enemyGround },
      steps: [{ text: '(計測用ダミー手順)', check: () => false }],
    };
  }

  async function openScenario(id, type, bombCount, groundCfg) {
    if (!AT.tutorials.find((t) => t.id === id)) AT.tutorials.push(buildTutorial(id, type, bombCount, groundCfg));
    await __open(id);
    const b = AT.battle;
    const world = b.world;
    const u = world.units.find((x) => x.kind === 'aircraft' && x.side === world.playerSide);
    const target = world.units.find((x) => x.tags && x.tags.includes('target'));
    const aaa = world.units.find((x) => x.typeId === 'AAA');
    const groundY = target.pos.y;
    world.terrain.heightAt = () => groundY;
    return { world, u, target, aaa, groundY, bombCount, type, groundCfg };
  }

  /** `known` のコンタクトを作り直す（tossprobe と同じ理由。§95計測の既知の穴） */
  function reseedContact(world, u, target) {
    const { Contact, LEVEL } = window.__tossAiDetection;
    const map = world.detection.contactsFor(u.side);
    const c = new Contact(target, AT.loop.simTime);
    c.level = LEVEL.DETAILED;
    c.ever = true;
    c.detected = false;
    c.exactNow = false;
    c.err = 0;
    c.pos.copy(target.pos);
    map.set(target.id, c);
  }

  function placeAircraft(u, target, bearingDeg, groundY, spec) {
    const th = bearingDeg * DEG;
    u.pos.set(target.pos.x - START_D * Math.sin(th), groundY + 3000, target.pos.z + START_D * Math.cos(th));
    u.heading = th;
    u._desiredHeading = th;
    u.roll = 0;
    u.pitch = 0;
    u.speed = spec.cruiseSpeed;
  }

  function resetTrial(ctx, cfg) {
    const { world, u, target, aaa, groundY, bombCount } = ctx;
    const spec = u.spec;

    target.hp = target.maxHp; target.alive = true; target._deathHandled = false; target.deathCause = null;
    if (target.mounts) for (const m of target.mounts) { m.accum = 0; m.reload = 0; }
    if (aaa) {
      aaa.hp = aaa.maxHp; aaa.alive = true; aaa._deathHandled = false; aaa.deathCause = null;
      for (const m of aaa.mounts) { m.accum = 0; m.reload = 0; }
    }
    reseedContact(world, u, target);

    placeAircraft(u, target, cfg.bearing, groundY, spec);
    u.hp = spec.hp; u.alive = true; u.deathCause = null; u._deathHandled = false;
    u._runTarget = null; u._runPhase = undefined; u._runHeading = undefined;
    u._tossEgress = false; u.attackRun = null;
    u.commandedAlt = null;
    u.fuel = u.fuelMax; u._rtbTriggered = false; u._bingoWarned = false;
    u.aiMode = null; u.acmMode = null; u.cranking = false; u._acmExtending = false; u.fireCooldown = 0;
    u.loadout = Array(bombCount).fill('BOMB');
    u.fireTasks = []; // AI自身に撃たせる（射撃指示は使わない）
    u.autoWeapons = { BOMB: true };
    u.bombProfile = cfg.profile;
    u.order = null; u.queue.length = 0;
    u.setPlayerOrder({ type: 'attack', target });

    world.missiles = [];
    world.bullets = [];
  }

  function computeMaxPullDuration(phaseLog, endT) {
    let max = 0;
    for (let k = 0; k < phaseLog.length; k++) {
      if (phaseLog[k].phase === 'pull') {
        const start = phaseLog[k].t;
        const end = k + 1 < phaseLog.length ? phaseLog[k + 1].t : endT;
        max = Math.max(max, end - start);
      }
    }
    return Math.round(max * 10) / 10;
  }

  /** 1試行を最後まで進める */
  function runTrial(ctx, cfg, defender) {
    const { world, u, target, groundY } = ctx;
    const acm = window.__tossAiAcm;
    const shots = [];
    let bulletsFired = 0, bulletsHit = 0;
    let pullCount = 0, prevPhase = null;
    const phaseLog = [];
    let maxAgl = 0, inRangeSeconds = 0, destroyedAt = null;

    const onFire = (shooter, tgt, weapon, m) => {
      if (shooter !== u || weapon.kind !== 'bomb') return;
      const aim = world.believedPosOf(shooter.side, tgt) || tgt.pos;
      const sol = acm.bombAimPoint(shooter, tgt, aim);
      const hit = acm.bombImpactPoint(shooter, sol.throwRange);
      shots.push({
        idx: shots.length,
        t: AT.loop.simTime,
        flatAtFire: Math.hypot(tgt.pos.x - shooter.pos.x, tgt.pos.z - shooter.pos.z),
        pitchDeg: (shooter.pitch || 0) / DEG,
        agl: shooter.pos.y - groundY,
        predicted: { x: hit.x, z: hit.z },
        m,
      });
    };
    world.onFire = onFire;
    world.onBulletHit = (b, unit) => { if (unit === u) bulletsHit++; };
    const origPush = world.bullets.push.bind(world.bullets);
    world.bullets.push = (...items) => {
      for (const b of items) if (b.shooter && b.shooter.side !== u.side) bulletsFired++;
      return origPush(...items);
    };

    let done = false;
    const maxTicks = Math.round(300 / DT);
    let i = 0;
    for (; i < maxTicks; i++) {
      reseedContact(world, u, target);

      AT.loop.onFixedUpdate(DT);
      AT.loop.simTime += DT;
      const t = (i + 1) * DT;

      const agl = u.pos.y - groundY;
      if (agl > maxAgl) maxAgl = agl;

      if (defender && defender.unit.alive) {
        const flat = Math.hypot(defender.unit.pos.x - u.pos.x, defender.unit.pos.z - u.pos.z);
        const dAgl = u.pos.y - defender.unit.pos.y;
        if (flat < defender.range && dAgl < defender.maxAlt) inRangeSeconds += DT;
      }

      const phase = u.attackRun;
      if (phase !== prevPhase) {
        phaseLog.push({ t: Math.round(t * 10) / 10, phase });
        if (phase === 'pull') pullCount++;
        prevPhase = phase;
      }

      if (!target.alive && destroyedAt == null) destroyedAt = t;
      if (!u.alive) done = true;
      if (destroyedAt != null && t - destroyedAt > 60) done = true;
      if (t > 300) done = true;
      if (done) break;
    }
    world.onFire = null;
    world.onBulletHit = null;
    world.bullets.push = Array.prototype.push.bind(world.bullets);

    let firstFlat = null, firstPitchDeg = null, firstAgl = null, firstMiss = null;
    if (shots.length) {
      const s = shots[0];
      firstFlat = Math.round(s.flatAtFire);
      firstPitchDeg = Math.round(s.pitchDeg * 10) / 10;
      firstAgl = Math.round(s.agl);
      const actual = { x: s.m.pos.x, z: s.m.pos.z };
      firstMiss = Math.round(Math.hypot(actual.x - target.pos.x, actual.z - target.pos.z));
    }

    const endT = Math.min((i + 1) * DT, 300);
    return {
      destroyed: !target.alive,
      destroyedAt: destroyedAt != null ? Math.round(destroyedAt * 10) / 10 : null,
      bombsUsed: shots.length,
      firstFlat, firstPitchDeg, firstAgl, firstMiss,
      pullCount, phaseLog,
      maxPullDuration: computeMaxPullDuration(phaseLog, endT),
      aircraftAlive: u.alive,
      hpLost: Math.round(u.spec.hp - u.hp),
      inRangeSeconds: Math.round(inRangeSeconds * 10) / 10,
      bulletsFired, bulletsHit,
      maxAgl: Math.round(maxAgl),
      ticksUsed: i,
      endT: Math.round(endT * 10) / 10,
    };
  }

  function summarize(rows) {
    const n = rows.length;
    const destroyedN = rows.filter((r) => r.destroyed).length;
    const destroyedTimes = rows.filter((r) => r.destroyed && r.destroyedAt != null).map((r) => r.destroyedAt);
    const med = (arr) => {
      if (!arr.length) return null;
      const s = [...arr].sort((a, b) => a - b);
      const m = Math.floor(s.length / 2);
      return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
    };
    const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
    const round1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
    return {
      n,
      destroyedFrac: `${destroyedN}/${n}`,
      destroyedMedianT: round1(med(destroyedTimes)),
      losses: rows.filter((r) => !r.aircraftAlive).length,
      avgHpLost: round1(avg(rows.map((r) => r.hpLost))),
      avgInRangeSeconds: round1(avg(rows.map((r) => r.inRangeSeconds))),
      avgBombsUsed: round1(avg(rows.map((r) => r.bombsUsed))),
      avgFirstMiss: round1(avg(rows.filter((r) => r.firstMiss != null).map((r) => r.firstMiss))),
      avgPullCount: round1(avg(rows.map((r) => r.pullCount))),
      avgBulletsFired: round1(avg(rows.map((r) => r.bulletsFired))),
      avgBulletsHit: round1(avg(rows.map((r) => r.bulletsHit))),
      maxOfMaxAgl: Math.max(...rows.map((r) => r.maxAgl)),
      maxOfMaxPullDuration: Math.max(...rows.map((r) => r.maxPullDuration)),
    };
  }

  // ---------------------------------------------------------------- 端の場合

  /** 端2km手前開始: out→入り直し→放す、の順になるか */
  async function edgeCloseStart(ctx, groundData) {
    const spec = ctx.u.spec;
    resetTrial(ctx, { profile: 'toss', bearing: 0 });
    // 2km手前(=目標の北2km)に上書き配置。heading は目標向き(0)のまま
    ctx.u.pos.set(TARGET_XZ.x, ctx.groundY + 3000, TARGET_XZ.z + 2000);
    const res = runTrial(ctx, { profile: 'toss', bearing: 0 }, null);
    const seq = res.phaseLog.map((p) => p.phase).filter((p, idx, a) => idx === 0 || p !== a[idx - 1]);
    return { phaseSeq: seq, bombsUsed: res.bombsUsed, destroyed: res.destroyed };
  }

  /** out最中にbombProfileをlevelへ戻す: NaNにならず飛び続けるか */
  async function edgeSwitchDuringOut(ctx) {
    resetTrial(ctx, { profile: 'toss', bearing: 0 });
    const { u, target, groundY } = ctx;
    let switched = false;
    let nanSeen = false;
    const maxTicks = Math.round(120 / DT);
    for (let i = 0; i < maxTicks; i++) {
      reseedContact(ctx.world, u, target);
      AT.loop.onFixedUpdate(DT);
      AT.loop.simTime += DT;
      if (!switched && u.attackRun === 'out') { u.bombProfile = 'level'; switched = true; }
      if (!Number.isFinite(u.heading) || !Number.isFinite(u.pos.x) || !Number.isFinite(u.pos.y)
        || !Number.isFinite(u.pos.z) || !Number.isFinite(u.speed)) { nanSeen = true; break; }
      if (switched && i > maxTicks - 30) break; // 切り替え後しばらく飛べたら十分
    }
    return { switched, nanSeen, aliveAfter: u.alive, finalHeadingFinite: Number.isFinite(u.heading) };
  }

  window.__tossAiRun = async () => {
    const acm = await import('/js/sim/acm.js');
    const det = await import('/js/sim/detection.js');
    const groundData = await import('/js/data/ground.js');
    window.__tossAiAcm = acm;
    window.__tossAiDetection = det;

    const AAA_W = groundData.GROUND_TYPES.AAA.weapon;
    const AIRBASE_W = groundData.GROUND_TYPES.AIRBASE.weapon;

    const aircraftDefs = [['A-3', 'A-3', 4], ['F-2', 'F-2', 2]];
    const groundCfgs = [
      ['防空あり(AAA)', 'radar_aaa'],
      ['無防備', 'radar'],
      ['飛行場(自前AAA)', 'airbase'],
    ];
    const profiles = ['level', 'toss'];
    const bearings = [0, 120, 240];

    const allRows = [];
    const table = [];
    let edge = null, uiCheck = null;

    for (const [label, type, bombCount] of aircraftDefs) {
      for (const [cfgLabel, groundCfg] of groundCfgs) {
        const id = `tossai_${type}_${groundCfg}`;
        const ctx = await openScenario(id, type, bombCount, groundCfg);

        let defender = null;
        if (groundCfg === 'radar_aaa' && ctx.aaa) defender = { unit: ctx.aaa, range: AAA_W.range, maxAlt: AAA_W.maxAlt };
        else if (groundCfg === 'airbase') defender = { unit: ctx.target, range: AIRBASE_W.range, maxAlt: AIRBASE_W.maxAlt };

        for (const profile of profiles) {
          const rows = [];
          for (const bearing of bearings) {
            const cfg = { profile, bearing };
            resetTrial(ctx, cfg);
            const res = runTrial(ctx, cfg, defender);
            rows.push(res);
            allRows.push({ aircraft: label, ground: cfgLabel, profile, bearing, ...res });
          }
          const sum = summarize(rows);
          table.push({ aircraft: label, ground: cfgLabel, profile, ...sum });
        }

        // §3 端の場合はA-3・防空ありの場で1回ずつ
        if (label === 'A-3' && groundCfg === 'radar_aaa' && edge == null) {
          const closeStart = await edgeCloseStart(ctx, groundData);
          const switchOut = await edgeSwitchDuringOut(ctx);
          edge = { closeStart, switchOut };
        }
      }
    }

    // 全試行を通して pull 30秒超 or AGL 4000m超 がないか
    const pullOver30 = allRows.filter((r) => r.maxPullDuration > 30);
    const aglOver4000 = allRows.filter((r) => r.maxAgl > 4000);

    // §3 UIチェック: 兵装パネルの data-toss ボタン
    {
      const ctx = await openScenario('tossai_A-3_radar', 'A-3', 4, 'radar');
      resetTrial(ctx, { profile: 'level', bearing: 0 });
      AT.commands.select([ctx.u]);
      AT.hud._detailKey = null;
      AT.hud.update(1);
      const btn = document.querySelector('button[data-toss]');
      const before = ctx.u.bombProfile;
      let after = null, btnFound = !!btn;
      if (btn) {
        btn.click();
        after = ctx.u.bombProfile;
      }
      uiCheck = { btnFound, before, after, toggled: btnFound && before !== after };
    }

    window.__tossAiLast = { table, allRows, edge, uiCheck, pullOver30Count: pullOver30.length, aglOver4000Count: aglOver4000.length };
    return {
      table: table.map((r) => ({
        aircraft: r.aircraft, ground: r.ground, profile: r.profile, n: r.n,
        destroyedFrac: r.destroyedFrac, destroyedMedianT: r.destroyedMedianT,
        losses: r.losses, avgInRangeSeconds: r.avgInRangeSeconds,
        avgBombsUsed: r.avgBombsUsed, avgFirstMiss: r.avgFirstMiss, avgPullCount: r.avgPullCount,
        avgBulletsFired: r.avgBulletsFired, avgBulletsHit: r.avgBulletsHit, avgHpLost: r.avgHpLost,
      })),
      edge,
      uiCheck,
      pullOver30Count: pullOver30.length,
      aglOver4000Count: aglOver4000.length,
      pullOver30Sample: pullOver30[0] ? { aircraft: pullOver30[0].aircraft, ground: pullOver30[0].ground, profile: pullOver30[0].profile, bearing: pullOver30[0].bearing, maxPullDuration: pullOver30[0].maxPullDuration } : null,
      aglOver4000Sample: aglOver4000[0] ? { aircraft: aglOver4000[0].aircraft, ground: aglOver4000[0].ground, profile: aglOver4000[0].profile, bearing: aglOver4000[0].bearing, maxAgl: aglOver4000[0].maxAgl } : null,
    };
  };

  window.__tossAiInternal = { openScenario, resetTrial, runTrial, reseedContact, summarize };
  return 'tossai ready';
})();
