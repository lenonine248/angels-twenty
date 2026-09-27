// 稜線を挟んだ目標へのトス爆撃。§95 続き・稜線版。
// ゲーム本体(js/)は一切変更しない。_tossai.js / _tossdef.js を土台にする。
//
// 読み込み:
//   await fetch('/tools/_tut_harness.js').then(r => r.text()).then(eval);
//   await fetch('/tools/_tossai.js').then(r => r.text()).then(eval);
//   await fetch('/tools/_tossdef.js').then(r => r.text()).then(eval);
//   await fetch('/tools/_tossridge.js').then(r => r.text()).then(eval);
// 実行（1回の呼び出しの中で最後まで回すこと）:
//   await __tossRidgeRun()
//
// 返り値: { table: [...集計行(方位3つ平均)] }。生ログは window.__tossRidgeLast。
(() => {
  const DT = 1 / 30;
  const DEG = Math.PI / 180;
  const TARGET_XZ = { x: 26000, z: 28000 };
  const START_D = 12000;
  const SIGMA = 400; // 稜線断面のガウスσ(m)
  const DR = 2000;   // 稜線は目標から進入側へこれだけ離れた位置

  function buildScenario(id, type, bombCount, groundList) {
    return {
      id,
      group: '計測',
      name: 'TOSS RIDGE PROBE',
      title: '計測用（非表示）',
      brief: '計測用の内部ステージ。地形は稜線を差し込む。',
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

  async function openScenario3(id, type, bombCount, groundList, defenderTypeId) {
    if (!AT.tutorials.find((t) => t.id === id)) AT.tutorials.push(buildScenario(id, type, bombCount, groundList));
    await __open(id);
    const b = AT.battle;
    const world = b.world;
    const u = world.units.find((x) => x.kind === 'aircraft' && x.side === world.playerSide);
    const target = world.units.find((x) => x.tags && x.tags.includes('target'));
    const defender = defenderTypeId ? world.units.find((x) => x.typeId === defenderTypeId) : null;
    const groundY = target.pos.y; // 稜線を差し込む前の平坦高度＝基準
    return { world, u, target, aaa: defender, groundY, bombCount, type };
  }

  /**
   * 進入方位に垂直な、無限に長い稜線を作る heightAt を返す。
   * 断面はガウス（σ=SIGMA）、頂上高さ groundY+H、目標から進入側へ Dr 離れた位置が頂上。
   * dir = 進入方位(th)の前進単位ベクトル(x,z)。R = target - Dr*dir が稜線の中心点。
   * s = (pos - R)・dir （正なら目標側、負なら機側）。稜線は s に対してのみ変化する
   * ＝無限に長い直線の稜線（perp方向には一定）。
   */
  function buildRidgeHeightAt(groundY, target, bearingDeg, H, Dr) {
    const th = bearingDeg * DEG;
    const dirx = Math.sin(th), dirz = -Math.cos(th);
    const Rx = target.pos.x - Dr * dirx, Rz = target.pos.z - Dr * dirz;
    const heightAt = (x, z) => {
      if (H === 0) return groundY;
      const s = (x - Rx) * dirx + (z - Rz) * dirz;
      return groundY + H * Math.exp(-(s * s) / (2 * SIGMA * SIGMA));
    };
    return { heightAt, dirx, dirz, Rx, Rz };
  }

  function resetTrialRidge(ctx, cfg) {
    window.__tossAiInternal.resetTrial(ctx, cfg);
    if (ctx.aaa) {
      for (const m of ctx.aaa.mounts) m.ammo = m.w.ammo ?? Infinity;
    }
    if (cfg.alt != null) AT.commands._applyAltitude(ctx.u, cfg.alt);
  }

  function avg(arr) { const a = arr.filter((x) => x != null); return a.length ? Math.round((a.reduce((s, x) => s + x, 0) / a.length) * 10) / 10 : null; }
  function fracTrue(arr) { const a = arr.filter((x) => x != null); return a.length ? Math.round((a.filter((x) => x).length / a.length) * 100) / 100 : null; }

  /**
   * 1試行。稜線ジオメトリ(ridge)・守り手(defSpec)を渡す。
   *  - h8/h5: 稜線まで8km/5km地点での「機体高度 - 稜線頂上高度」
   *  - triggerAgl/triggerCrossed: トスなら pull 開始の瞬間、水平なら1発目投下の瞬間の
   *    「稜線からの高さ」と「すでに稜線を渡っていたか」
   *  - visibleSeconds: hasLineOfSight真 かつ 射程内（SAMは射程判定を割愛しLOSのみ）
   *  - firstVisibleAt/Flat: その条件が最初に真になった時刻・水平距離
   *  - enemyContactAt: 敵側コンタクトに自機が乗った時刻
   *  - bombsOnRidge/firstMiss: 着弾点が目標から500m以上・地面高さが基準+50m以上／1発目が外れたか
   */
  function runTrialRidge(ctx, cfg, ridge, defSpec, profile) {
    const { world, u, target, groundY } = ctx;
    const acm = window.__tossAiAcm;
    const terrain = world.terrain;
    const shots = [];
    let bulletsFired = 0, bulletsHit = 0, missilesFired = 0, missilesHit = 0;
    let prevPhase = null, destroyedAt = null;
    let h8 = null, h5 = null, sawH8 = false, sawH5 = false;
    let triggerAgl = null, triggerCrossed = null, triggerDone = false;
    let visibleSeconds = 0, firstVisibleAt = null, firstVisibleFlat = null;
    let enemyContactAt = null;

    const onFire = (shooter, tgt, weapon, m) => {
      if (shooter === u && weapon.kind === 'bomb') {
        const aim = world.believedPosOf(shooter.side, tgt) || tgt.pos;
        const sol = acm.bombAimPoint(shooter, tgt, aim);
        const hit = acm.bombImpactPoint(shooter, sol.throwRange);
        const distFromTarget = Math.hypot(hit.x - target.pos.x, hit.z - target.pos.z);
        const hAtHit = terrain.heightAt(hit.x, hit.z);
        shots.push({
          idx: shots.length,
          t: AT.loop.simTime,
          agl: shooter.pos.y - groundY,
          distFromTarget: Math.round(distFromTarget),
          onRidge: distFromTarget >= 500 && hAtHit >= groundY + 50,
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

      // 稜線までの符号付き距離（正=まだ手前、負=渡った）
      const s = (u.pos.x - ridge.Rx) * ridge.dirx + (u.pos.z - ridge.Rz) * ridge.dirz;
      const distToRidge = -s;
      const ridgeTopY = groundY + ridge.H;
      const heightAboveRidge = u.pos.y - ridgeTopY;
      if (!sawH8 && distToRidge <= 8000) { h8 = Math.round(heightAboveRidge); sawH8 = true; }
      if (!sawH5 && distToRidge <= 5000) { h5 = Math.round(heightAboveRidge); sawH5 = true; }

      if (!triggerDone) {
        const phase = u.attackRun;
        if (profile === 'toss') {
          if (prevPhase !== 'pull' && phase === 'pull') {
            triggerAgl = Math.round(heightAboveRidge);
            triggerCrossed = distToRidge <= 0;
            triggerDone = true;
          }
        } else if (shots.length === 1) {
          triggerAgl = Math.round(heightAboveRidge);
          triggerCrossed = distToRidge <= 0;
          triggerDone = true;
        }
        prevPhase = phase;
      }

      if (defSpec && defSpec.unit.alive) {
        const flat = Math.hypot(defSpec.unit.pos.x - u.pos.x, defSpec.unit.pos.z - u.pos.z);
        const dAgl = u.pos.y - defSpec.unit.pos.y;
        const inRange = defSpec.range == null ? true : (flat < defSpec.range && dAgl < defSpec.maxAlt);
        const los = terrain.hasLineOfSight(defSpec.unit.pos, u.pos);
        if (los && inRange) {
          visibleSeconds += DT;
          if (firstVisibleAt == null) { firstVisibleAt = Math.round(t * 10) / 10; firstVisibleFlat = Math.round(flat); }
        }
        if (enemyContactAt == null) {
          const emap = world.detection.contactsFor(defSpec.unit.side);
          if (emap.has(u.id)) enemyContactAt = Math.round(t * 10) / 10;
        }
      }

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

    const firstMiss = shots.length ? !shots[0].onRidge && shots[0].distFromTarget > 130 : null;

    return {
      destroyed: !target.alive,
      aircraftAlive: u.alive,
      hpLost: Math.round(u.spec.hp - u.hp),
      bombsUsed: shots.length,
      bombsOnRidge: shots.filter((s) => s.onRidge).length,
      firstMiss,
      h8, h5, triggerAgl, triggerCrossed,
      visibleSeconds: Math.round(visibleSeconds * 10) / 10,
      firstVisibleAt, firstVisibleFlat,
      enemyContactAt,
      bulletsFired, bulletsHit, missilesFired, missilesHit,
    };
  }

  function summarizeRidge(rows) {
    const n = rows.length;
    return {
      n,
      destroyedFrac: `${rows.filter((r) => r.destroyed).length}/${n}`,
      losses: rows.filter((r) => !r.aircraftAlive).length,
      avgHpLost: avg(rows.map((r) => r.hpLost)),
      avgH8: avg(rows.map((r) => r.h8)),
      avgH5: avg(rows.map((r) => r.h5)),
      avgTriggerAgl: avg(rows.map((r) => r.triggerAgl)),
      crossedAtTriggerFrac: fracTrue(rows.map((r) => r.triggerCrossed)),
      avgVisibleSeconds: avg(rows.map((r) => r.visibleSeconds)),
      avgFirstVisibleAt: avg(rows.map((r) => r.firstVisibleAt)),
      avgFirstVisibleFlat: avg(rows.map((r) => r.firstVisibleFlat)),
      avgEnemyContactAt: avg(rows.map((r) => r.enemyContactAt)),
      avgMissilesFired: avg(rows.map((r) => r.missilesFired)),
      avgMissilesHit: avg(rows.map((r) => r.missilesHit)),
      avgBombsUsed: avg(rows.map((r) => r.bombsUsed)),
      avgBombsOnRidge: avg(rows.map((r) => r.bombsOnRidge)),
      firstMissFrac: fracTrue(rows.map((r) => r.firstMiss)),
    };
  }

  async function runCase(H, scene, aircraftLabel, type, bombCount, groundList, defenderTypeId, defSpecBuilder, conds, allRows, table) {
    const id = `tossridge_H${H}_${scene}_${type}_${defenderTypeId || 'none'}`;
    const ctx = await openScenario3(id, type, bombCount, groundList, defenderTypeId);
    const defSpec = defSpecBuilder ? defSpecBuilder(ctx) : null;
    for (const cond of conds) {
      const rows = [];
      for (const bearing of [0, 120, 240]) {
        const ridgeBuild = buildRidgeHeightAt(ctx.groundY, ctx.target, bearing, H, DR);
        ctx.world.terrain.heightAt = ridgeBuild.heightAt;
        const ridge = { ...ridgeBuild, H };
        const cfg = { profile: cond.profile, bearing, alt: cond.alt ? cond.alt(ctx) : null };
        resetTrialRidge(ctx, cfg);
        const res = runTrialRidge(ctx, cfg, ridge, defSpec, cond.profile);
        rows.push(res);
        allRows.push({ H, scene, aircraft: aircraftLabel, cond: cond.label, bearing, ...res });
      }
      table.push({ H, scene, aircraft: aircraftLabel, cond: cond.label, ...summarizeRidge(rows) });
    }
  }

  window.__tossRidgeRun = async (opts = {}) => {
    const acm = await import('/js/sim/acm.js');
    const det = await import('/js/sim/detection.js');
    const groundData = await import('/js/data/ground.js');
    window.__tossAiAcm = acm;
    window.__tossAiDetection = det;
    const AAA_W = groundData.GROUND_TYPES.AAA.weapon;

    const aircraftDefs = opts.aircraftDefs || [['A-3', 'A-3', 4], ['F-2', 'F-2', 2]];
    const Hs = opts.Hs || [0, 400, 800];
    const allRows = [];
    const table = [];

    const conds = [
      { label: '水平(alt指示無)', profile: 'level' },
      { label: 'トス(alt指示無)', profile: 'toss' },
      { label: 'トス+alt(目標+300)', profile: 'toss', alt: (ctx) => ctx.groundY + 300 },
    ];

    for (const H of Hs) {
      for (const [label, type, bombCount] of aircraftDefs) {
        const groundKnownAaa = [
          { type: 'RADAR', name: 'レーダーサイト', x: TARGET_XZ.x, z: TARGET_XZ.z, tags: ['target'], known: true },
          { type: 'AAA', name: '対空砲', x: TARGET_XZ.x + 200, z: TARGET_XZ.z, known: true },
        ];
        await runCase(H, 'i_known_aaa', label, type, bombCount, groundKnownAaa, 'AAA',
          (ctx) => ({ unit: ctx.aaa, range: AAA_W.range, maxAlt: AAA_W.maxAlt }),
          conds, allRows, table);

        const groundUnknownAaa = [
          { type: 'RADAR', name: 'レーダーサイト', x: TARGET_XZ.x, z: TARGET_XZ.z, tags: ['target'], known: true },
          { type: 'AAA', name: '対空砲', x: TARGET_XZ.x + 200, z: TARGET_XZ.z, known: false },
        ];
        await runCase(H, 'ii_unknown_aaa', label, type, bombCount, groundUnknownAaa, 'AAA',
          (ctx) => ({ unit: ctx.aaa, range: AAA_W.range, maxAlt: AAA_W.maxAlt }),
          conds, allRows, table);

        const groundSam = [
          { type: 'RADAR', name: 'レーダーサイト', x: TARGET_XZ.x, z: TARGET_XZ.z, tags: ['target'], known: true },
          { type: 'SAM', name: 'SAM陣地', x: TARGET_XZ.x + 1000, z: TARGET_XZ.z, known: true },
        ];
        await runCase(H, 'iii_sam', label, type, bombCount, groundSam, 'SAM',
          (ctx) => ({ unit: ctx.aaa, range: null, maxAlt: null }),
          conds, allRows, table);
      }
    }

    window.__tossRidgeLast = { table, allRows };
    return { table };
  };

  return 'tossridge ready';
})();
