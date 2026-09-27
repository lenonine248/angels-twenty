// トス爆撃 vs 水平爆撃、守られた目標に対する比較計測。§95 の続き。
// ゲーム本体(js/)は一切変更しない。_tossai.js の resetTrial 等を使い回す。
//
// 読み込み（先に harness と _tossai.js を読んでおくこと。__tossAiInternal を使う）:
//   await fetch('/tools/_tut_harness.js').then(r => r.text()).then(eval);
//   await fetch('/tools/_tossai.js').then(r => r.text()).then(eval);
//   await fetch('/tools/_tossdef.js').then(r => r.text()).then(eval);
// 実行（1回の呼び出しの中で最後まで回すこと）:
//   await __tossDefRun()
//
// 返り値: { table: [...集計行] }。生ログは window.__tossDefLast に積む。
(() => {
  const DT = 1 / 30;
  const DEG = Math.PI / 180;
  const TARGET_XZ = { x: 26000, z: 28000 };
  const START_D = 12000;

  function buildScenario(id, type, bombCount, groundList) {
    return {
      id,
      group: '計測',
      name: 'TOSS DEF PROBE',
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
      enemy: { aircraft: [], ground: groundList },
      steps: [{ text: '(計測用ダミー手順)', check: () => false }],
    };
  }

  /** groundList を直接指定して開く。defenderTypeId でどのユニットを「守り」として扱うか選ぶ */
  async function openScenario2(id, type, bombCount, groundList, defenderTypeId) {
    if (!AT.tutorials.find((t) => t.id === id)) AT.tutorials.push(buildScenario(id, type, bombCount, groundList));
    await __open(id);
    const b = AT.battle;
    const world = b.world;
    const u = world.units.find((x) => x.kind === 'aircraft' && x.side === world.playerSide);
    const target = world.units.find((x) => x.tags && x.tags.includes('target'));
    const defender = defenderTypeId ? world.units.find((x) => x.typeId === defenderTypeId) : null;
    const groundY = target.pos.y;
    world.terrain.heightAt = () => groundY;
    return { world, u, target, aaa: defender, groundY, bombCount, type };
  }

  /**
   * __tossAiInternal.resetTrial を土台に、
   *  1) 高度指示（cfg.alt があれば _applyAltitude で入れる。攻撃指示の後でよい — commandedAlt は
   *     毎フレーム参照されるので、指示を出す順は結果に効かない。実際のプレイの経路と同じ関数を通す）
   *  2) 守備側の弾薬（SAMは ammo:8 で有限。AAAは Infinity なので影響なし）をリセット
   * を足す。
   */
  function resetTrialDef(ctx, cfg) {
    window.__tossAiInternal.resetTrial(ctx, cfg);
    if (ctx.aaa) {
      for (const m of ctx.aaa.mounts) m.ammo = m.w.ammo ?? Infinity;
    }
    if (cfg.alt != null) AT.commands._applyAltitude(ctx.u, cfg.alt);
  }

  /**
   * 独自の1試行ループ。__tossAiInternal.runTrial を土台に、
   *  - SAM の発射・命中（ミサイル。対空砲の弾(Bullet)とは別経路）
   *  - 離脱(out)中に守備側へ最も近づいた水平距離
   *  - 進入高度（in が終わる直前のAGL = 機首上げ前）
   *  - (ii用) 守備側が自軍側のコンタクトになった時刻・距離（一度だけ記録）
   * を足して返す。
   */
  function runTrialDef(ctx, cfg, defSpec, opts = {}) {
    const { world, u, target, groundY } = ctx;
    const acm = window.__tossAiAcm;
    const shots = [];
    let bulletsFired = 0, bulletsHit = 0;
    let missilesFired = 0, missilesHit = 0;
    let pullCount = 0, prevPhase = null;
    const phaseLog = [];
    let maxAgl = 0, inRangeSeconds = 0, destroyedAt = null;
    let ingressAgl = null, prevAgl = null;
    let closestOutFlat = defSpec ? Infinity : null;
    let contactAt = null, contactFlat = null;
    const trackContact = !!opts.trackContact && defSpec;

    const onFire = (shooter, tgt, weapon, m) => {
      if (shooter === u && weapon.kind === 'bomb') {
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
      } else if (defSpec && shooter === defSpec.unit && weapon.kind === 'sam') {
        missilesFired++;
      }
    };
    world.onFire = onFire;
    world.onBulletHit = (b, unit) => { if (unit === u && b.shooter && b.shooter.side !== u.side) bulletsHit++; };
    world.onMissileHit = (m, tgt) => { if (tgt === u && m.weapon && m.weapon.kind === 'sam') missilesHit++; };
    const origPush = world.bullets.push.bind(world.bullets);
    world.bullets.push = (...items) => {
      for (const b of items) if (b.shooter && b.shooter.side !== u.side) bulletsFired++;
      return origPush(...items);
    };

    let done = false;
    const maxTicks = Math.round(300 / DT);
    let i = 0;
    for (; i < maxTicks; i++) {
      window.__tossAiInternal.reseedContact(world, u, target);

      AT.loop.onFixedUpdate(DT);
      AT.loop.simTime += DT;
      const t = (i + 1) * DT;

      const agl = u.pos.y - groundY;
      if (agl > maxAgl) maxAgl = agl;

      if (defSpec && defSpec.unit.alive) {
        const flat = Math.hypot(defSpec.unit.pos.x - u.pos.x, defSpec.unit.pos.z - u.pos.z);
        const dAgl = u.pos.y - defSpec.unit.pos.y;
        if (defSpec.range != null && flat < defSpec.range && dAgl < defSpec.maxAlt) inRangeSeconds += DT;
        if (u.attackRun === 'out' && flat < closestOutFlat) closestOutFlat = flat;
        if (trackContact && contactAt == null) {
          const map = world.detection.contactsFor(u.side);
          if (map.has(defSpec.unit.id)) { contactAt = Math.round(t * 10) / 10; contactFlat = Math.round(flat); }
        }
      }

      const phase = u.attackRun;
      if (phase !== prevPhase) {
        if (prevPhase === 'in' && phase !== 'in') ingressAgl = Math.round(prevAgl);
        phaseLog.push({ t: Math.round(t * 10) / 10, phase });
        if (phase === 'pull') pullCount++;
        prevPhase = phase;
      }
      prevAgl = agl;

      if (!target.alive && destroyedAt == null) destroyedAt = t;
      if (!u.alive) done = true;
      if (destroyedAt != null && t - destroyedAt > 60) done = true;
      if (t > 300) done = true;
      if (done) break;
    }
    world.onFire = null;
    world.onBulletHit = null;
    world.onMissileHit = null;
    world.bullets.push = Array.prototype.push.bind(world.bullets);

    let firstFlat = null, firstAgl = null;
    if (shots.length) {
      const s = shots[0];
      firstFlat = Math.round(s.flatAtFire);
      firstAgl = Math.round(s.agl);
    }

    return {
      destroyed: !target.alive,
      destroyedAt: destroyedAt != null ? Math.round(destroyedAt * 10) / 10 : null,
      bombsUsed: shots.length,
      firstFlat, firstAgl, ingressAgl,
      aircraftAlive: u.alive,
      hpLost: Math.round(u.spec.hp - u.hp),
      inRangeSeconds: Math.round(inRangeSeconds * 10) / 10,
      bulletsFired, bulletsHit, missilesFired, missilesHit,
      closestOutFlat: closestOutFlat != null && Number.isFinite(closestOutFlat) ? Math.round(closestOutFlat) : null,
      contactAt, contactFlat,
      maxAgl: Math.round(maxAgl),
    };
  }

  function avg(arr) { const a = arr.filter((x) => x != null); return a.length ? Math.round((a.reduce((s, x) => s + x, 0) / a.length) * 10) / 10 : null; }

  function summarizeDef(rows) {
    const n = rows.length;
    return {
      n,
      destroyedFrac: `${rows.filter((r) => r.destroyed).length}/${n}`,
      losses: rows.filter((r) => !r.aircraftAlive).length,
      avgHpLost: avg(rows.map((r) => r.hpLost)),
      avgInRangeSeconds: avg(rows.map((r) => r.inRangeSeconds)),
      avgBulletsFired: avg(rows.map((r) => r.bulletsFired)),
      avgBulletsHit: avg(rows.map((r) => r.bulletsHit)),
      avgMissilesFired: avg(rows.map((r) => r.missilesFired)),
      avgMissilesHit: avg(rows.map((r) => r.missilesHit)),
      avgIngressAgl: avg(rows.map((r) => r.ingressAgl)),
      avgFirstFlat: avg(rows.map((r) => r.firstFlat)),
      avgClosestOutFlat: avg(rows.map((r) => r.closestOutFlat)),
      contactSeen: rows.filter((r) => r.contactAt != null).length,
      avgContactAt: avg(rows.map((r) => r.contactAt)),
      avgContactFlat: avg(rows.map((r) => r.contactFlat)),
    };
  }

  async function runCase(scene, aircraftLabel, type, bombCount, groundList, defenderTypeId, defSpecBuilder, conds, allRows, table, trackContact) {
    const id = `tossdef_${scene}_${type}_${defenderTypeId || 'none'}`;
    const ctx = await openScenario2(id, type, bombCount, groundList, defenderTypeId);
    const defSpec = defSpecBuilder ? defSpecBuilder(ctx) : null;
    for (const cond of conds) {
      const rows = [];
      for (const bearing of [0, 120, 240]) {
        const cfg = { profile: cond.profile, bearing, alt: cond.alt ? cond.alt(ctx) : null };
        resetTrialDef(ctx, cfg);
        const res = runTrialDef(ctx, cfg, defSpec, { trackContact });
        rows.push(res);
        allRows.push({ scene, aircraft: aircraftLabel, cond: cond.label, bearing, ...res });
      }
      table.push({ scene, aircraft: aircraftLabel, cond: cond.label, ...summarizeDef(rows) });
    }
  }

  window.__tossDefRun = async () => {
    const acm = await import('/js/sim/acm.js');
    const det = await import('/js/sim/detection.js');
    const groundData = await import('/js/data/ground.js');
    window.__tossAiAcm = acm;
    window.__tossAiDetection = det;
    const AAA_W = groundData.GROUND_TYPES.AAA.weapon;

    const aircraftDefs = [['A-3', 'A-3', 4], ['F-2', 'F-2', 2]];
    const allRows = [];
    const table = [];

    for (const [label, type, bombCount] of aircraftDefs) {
      // (i) 既知の対空砲（target 200m 横・known:true）
      const groundKnownAaa = [
        { type: 'RADAR', name: 'レーダーサイト', x: TARGET_XZ.x, z: TARGET_XZ.z, tags: ['target'], known: true },
        { type: 'AAA', name: '対空砲', x: TARGET_XZ.x + 200, z: TARGET_XZ.z, known: true },
      ];
      await runCase('i_known_aaa', label, type, bombCount, groundKnownAaa, 'AAA',
        (ctx) => ({ unit: ctx.aaa, range: AAA_W.range, maxAlt: AAA_W.maxAlt }),
        [
          { label: '水平(alt指示無)', profile: 'level' },
          { label: '水平+alt(目標+900)', profile: 'level', alt: (ctx) => ctx.groundY + 900 },
          { label: 'トス(alt指示無)', profile: 'toss' },
          { label: 'トス+alt(目標+300)', profile: 'toss', alt: (ctx) => ctx.groundY + 300 },
        ], allRows, table, false);

      // (ii) 見えていない対空砲（target 200m 横・known:false）
      const groundUnknownAaa = [
        { type: 'RADAR', name: 'レーダーサイト', x: TARGET_XZ.x, z: TARGET_XZ.z, tags: ['target'], known: true },
        { type: 'AAA', name: '対空砲', x: TARGET_XZ.x + 200, z: TARGET_XZ.z, known: false },
      ];
      await runCase('ii_unknown_aaa', label, type, bombCount, groundUnknownAaa, 'AAA',
        (ctx) => ({ unit: ctx.aaa, range: AAA_W.range, maxAlt: AAA_W.maxAlt }),
        [
          { label: '水平(alt指示無)', profile: 'level' },
          { label: 'トス(alt指示無)', profile: 'toss' },
        ], allRows, table, true);

      // (iii) レーダー誘導SAM（target 1000m 横・known:true）
      const groundSam = [
        { type: 'RADAR', name: 'レーダーサイト', x: TARGET_XZ.x, z: TARGET_XZ.z, tags: ['target'], known: true },
        { type: 'SAM', name: 'SAM陣地', x: TARGET_XZ.x + 1000, z: TARGET_XZ.z, known: true },
      ];
      await runCase('iii_sam', label, type, bombCount, groundSam, 'SAM',
        (ctx) => ({ unit: ctx.aaa, range: null, maxAlt: null }), // SAMの射程は高度で伸縮するため簡易には出さない
        [
          { label: '水平(alt指示無)', profile: 'level' },
          { label: 'トス(alt指示無)', profile: 'toss' },
          { label: 'トス+alt(目標+300)', profile: 'toss', alt: (ctx) => ctx.groundY + 300 },
        ], allRows, table, false);
    }

    window.__tossDefLast = { table, allRows };
    return { table };
  };

  return 'tossdef ready';
})();
