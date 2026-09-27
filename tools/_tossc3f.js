// c3 の「トスで低く放すと攻撃が悪化するのは (a)地形に遮られるから (b)距離が縮んで
// 窓に入れないから、それ以外か」を切り分ける6回目。tools/_tossc3e.js の
// loadStage/openScenario/低い床パッチ(installLowFloorPatch)をそのまま流用する。
// ゲーム本体(js/)は一切変更しない。
//
// 変種は T0(無改造)とT1b(床の係数0.8)の2つだけ。前回と同じ配置
// (SAM 5か所 × 出発方位6つ・battleSeed 0xC30004)。
//
// 新規に測るもの:
//  - 爆弾1発ごと: 放した瞬間の距離・高度・地上高・ピッチ・attackRun、
//    「地形を無視した予測落下点」(js/sim/acm.js の bombSolution/bombImpactPoint を
//    combat.js の投下判定と同じ引数(aimY=目標の標高)で呼ぶ)と実際の爆発点(m.pos、
//    'ground'終端なら地形に当たった高さに既にクランプ済み)。
//    分類: 直撃(endReason==='hit') / 近弾(実爆発点が目標からblastRadius以内) /
//    地形に遮られた(予測距離-実距離>300m) / 手前・奥に外れた(それ以外、進行軸上の符号)。
//  - 機首上げ(pull)1回ごと: 開始距離・開始高度・開始地上高、その間に放った弾数、
//    0発で終わった場合の理由(js/sim/acm.js:623 と同じ2条件のどちらが成立したか、
//    その瞬間u.evadingだったか)。
//
// 読みの確認(コードで裏取り済み):
//  - combat.js の投下判定(973-995行)は「地形を無視した予測落下点」が目標から
//    blastRadius以内のときだけ発射する。つまり**放たれた弾は定義上ほぼ全て
//    予測落下点が目標近傍**。実弾がそれでも外れるなら、原因は
//    (i)地形が手前で遮った (ii)bombDispersion(combat.js:1082-1086、低空トスでは
//    小さい)によるばらつき、のどちらかのはず。
//  - pull の終了はacm.js 611-626行の状態機械で、pull→out以外の遷移は無い
//    (pull中に死ぬ/試行終了で宙ぶらりんになるケースだけ別扱いにする)。
//  - main.js:318-321 の実行順は「全ユニットupdate(移動・attackRun決定含む)→
//    detection→pilotAI→combat.update(発射)」。同じtick内でattackRunは
//    移動より前に決まり、発射(combat.update)は移動後の位置を使うが、
//    attackRunの値自体はその同じtickの決定がそのまま残っている。
//    **最初はtickループの外側(onFixedUpdate後)でattackRunの変化を見ていたが、
//    それだと「pull開始そのtickに放たれた弾」を毎回取りこぼし、
//    nonPullBombsが実測(T0:26/43・T1b:38/53)で異常に高くなった。**
//    aircraft.js:1029 の `this.attackRun = run.phase` はプロパティ代入なので、
//    u に accessor(setter)を仕掛けて代入の瞬間(=移動より前、発射より前)に
//    pull開始/終了を捕まえるよう直した。これで同tickの発射も正しく
//    現在のpullへ帰属する。
//
// 読み込み:
//   await fetch('/tools/_tossc3f.js').then(r => r.text()).then(eval);
// 実行(重いので直接awaitせず、fire-and-forgetしてポーリングで回収する):
//   window.__tc3fResult = null;
//   window.__tossC3fRun().then(r => window.__tc3fResult = r)
//     .catch(e => window.__tc3fResult = { error: String((e && e.stack) || e) });
// 回収:
//   window.__tc3fResult   // nullなら未完了
//
// 生ログ(各runの生の集計)は window.__tossC3fLast に積む。航跡そのものは積まない。
(() => {
  const DT = 1 / 30;
  const DEG = Math.PI / 180;
  const MAX_T = 260;
  const RIDGE_CLIMB = 2200, LOOK_STEP = 150, LOOK_NEAR = 3000, MIN_AGL = 220;

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

  function round(x, d = 0) { const k = 10 ** d; return x == null || !Number.isFinite(x) ? null : Math.round(x * k) / k; }
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
  function quantile(arr, q) {
    const a = arr.filter((x) => x != null).slice().sort((x, y) => x - y);
    if (!a.length) return null;
    const idx = (a.length - 1) * q;
    const lo = Math.floor(idx), hi = Math.ceil(idx);
    if (lo === hi) return a[lo];
    return a[lo] + (a[hi] - a[lo]) * (idx - lo);
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
      id, group: '計測', name: 'TOSS C3F PROBE', title: '計測用（非表示）',
      battleSeed: 0xC30004,
      brief: '計測用の内部ステージ（c3の地形・配置を写す・SAM隠れ6回目・弾/pull詳細）。', hint: '',
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

  // ---------------------------------------------------------------- 低い床パッチ（T1b・margin0.8。tools/_tossc3e.jsと同一）
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

  // ---------------------------------------------------------------- pull追跡（attackRun代入の瞬間を捕まえる）
  // aircraft.js:1029 `this.attackRun = run.phase` の代入そのものにフックする。
  // ここで読む u.pos/u.heading は、その代入の直前に tossAttackRun が使ったのと
  // 同じ(移動前の)値 —— 同関数内で代入の後に _steer/_integrate が動くため。
  function installPullTracker(u, target, targetXZ, terrain, bombSolution, bombImpactPoint, angleDiff, TOSS, blastRadius) {
    const pulls = [];
    let currentPull = null;
    let raw = u.attackRun;
    Object.defineProperty(u, 'attackRun', {
      configurable: true,
      get() { return raw; },
      set(v) {
        if (v === 'pull' && raw !== 'pull') {
          const dx = targetXZ.x - u.pos.x, dz = targetXZ.z - u.pos.z;
          const flat = Math.hypot(dx, dz);
          const ground = terrain.heightAt(u.pos.x, u.pos.z);
          currentPull = {
            startDist: round(flat, 0), startAlt: round(u.pos.y, 0),
            startAGL: round(u.pos.y - ground, 0),
            bombs: 0,
          };
        } else if (v !== 'pull' && raw === 'pull' && currentPull) {
          const dx = targetXZ.x - u.pos.x, dz = targetXZ.z - u.pos.z;
          const flat = Math.hypot(dx, dz);
          const bearing = headingOf(dx, dz);
          const angleOff = Math.abs(angleDiff(bearing, u.heading));
          const sol = bombSolution(u, target.pos.y);
          const hit = bombImpactPoint(u, sol.throwRange);
          const ahead = ((hit.x - u.pos.x) * dx + (hit.z - u.pos.z) * dz) / Math.max(1, flat);
          const windowOver = ahead > flat + blastRadius;
          const angleOver = angleOff > 4 * TOSS.align;
          currentPull.endReason = windowOver && angleOver ? 'both' : windowOver ? 'window' : angleOver ? 'angle' : 'unknown';
          currentPull.evadingAtExit = !!u.evading;
          currentPull.dangling = false;
          pulls.push(currentPull);
          currentPull = null;
        }
        raw = v;
      },
    });
    return {
      isPull: () => raw === 'pull',
      addBomb: () => { if (currentPull) currentPull.bombs++; },
      finalize: () => {
        if (currentPull) {
          currentPull.endReason = 'trial_end';
          currentPull.evadingAtExit = !!u.evading;
          currentPull.dangling = true;
          pulls.push(currentPull);
          currentPull = null;
        }
        return pulls;
      },
    };
  }

  // ---------------------------------------------------------------- 1試行（爆弾・pullの詳細つき）
  function runTrialF(ctx, cfg) {
    const { world, u, target } = ctx;
    const terrain = world.terrain;
    const targetXZ = { x: target.pos.x, z: target.pos.z };
    const { bombSolution, bombImpactPoint, TOSS, angleDiff, blastRadius } = cfg;

    u.bombProfile = 'toss';
    u.setPlayerOrder({ type: 'attack', target });

    const tracker = installPullTracker(u, target, targetXZ, terrain, bombSolution, bombImpactPoint, angleDiff, TOSS, blastRadius);

    const bombRecords = [];
    let nonPullBombs = 0;

    world.onFire = (shooter, tgt, weapon, m) => {
      if (shooter !== u || weapon.kind !== 'bomb') return;
      const ground = terrain.heightAt(u.pos.x, u.pos.z);
      const sol = bombSolution(u, target.pos.y);
      const pred = bombImpactPoint(u, sol.throwRange);
      bombRecords.push({
        releasePos: { x: m.pos.x, y: m.pos.y, z: m.pos.z },
        releaseDist: Math.hypot(targetXZ.x - u.pos.x, targetXZ.z - u.pos.z),
        releaseAlt: u.pos.y,
        releaseAGL: u.pos.y - ground,
        releasePitch: u.pitch,
        releaseAttackRun: u.attackRun,
        predPoint: pred,
        predDist: sol.throwRange,
        m, resolved: false,
      });
      if (tracker.isPull()) tracker.addBomb();
      else nonPullBombs++;
    };

    let destroyedAt = null, killTick = null;
    let tick = 0;
    const maxTicks = Math.round(MAX_T / DT);

    for (; tick < maxTicks; tick++) {
      AT.loop.onFixedUpdate(DT);
      AT.loop.simTime += DT;
      const t = (tick + 1) * DT;

      for (const rec of bombRecords) {
        if (!rec.resolved && !rec.m.alive) {
          rec.resolved = true;
          rec.actualPos = { x: rec.m.pos.x, y: rec.m.pos.y, z: rec.m.pos.z };
          rec.endReason = rec.m.endReason;
          rec.explodeTick = tick;
        }
      }

      if (!target.alive && destroyedAt == null) { destroyedAt = t; killTick = tick; }
      if (!u.alive) break;
      if (destroyedAt != null && t - destroyedAt > 20) break;
    }
    world.onFire = null;
    const pulls = tracker.finalize();

    // ---- 爆弾ごとの分類（問い1・2）
    const bombs = bombRecords.map((rec) => {
      if (!rec.resolved) return { category: 'unresolved' };
      let isKillShot = destroyedAt != null && rec.explodeTick === killTick;
      if (rec.endReason === 'hit') {
        return { category: 'hit', isKillShot };
      }
      const dTarget = Math.hypot(rec.actualPos.x - targetXZ.x, rec.actualPos.z - targetXZ.z);
      if (dTarget <= blastRadius) {
        return { category: 'near', distTarget: round(dTarget), isKillShot };
      }
      const actualDist = Math.hypot(rec.actualPos.x - rec.releasePos.x, rec.actualPos.z - rec.releasePos.z);
      const gap = rec.predDist - actualDist;
      if (gap > 300) {
        return {
          category: 'blocked', distTarget: round(dTarget), blockElev: round(rec.actualPos.y),
          gap: round(gap), isKillShot,
        };
      }
      const relFlat = Math.max(1, rec.releaseDist);
      const axisX = (targetXZ.x - rec.releasePos.x) / relFlat, axisZ = (targetXZ.z - rec.releasePos.z) / relFlat;
      const along = (rec.actualPos.x - rec.releasePos.x) * axisX + (rec.actualPos.z - rec.releasePos.z) * axisZ;
      const signed = along - relFlat; // >0: 目標を越えて奥 / <0: 目標の手前
      return { category: signed < 0 ? 'short' : 'long', distTarget: round(dTarget), signed: round(signed), isKillShot };
    });

    return {
      destroyed: !target.alive, loss: !u.alive,
      bombsUsed: bombRecords.length, nonPullBombs,
      bombs, pulls,
    };
  }

  // ---------------------------------------------------------------- 実行本体
  window.__tossC3fRun = async () => {
    const stage = await loadStage();
    const target0 = stage.enemy.ground.find((g) => g.type === 'RADAR');
    const base0 = stage.friendly.base;
    const bearing0 = headingOf(target0.x - base0.x, target0.z - base0.z);
    const distBaseTarget = Math.hypot(base0.x - target0.x, base0.z - target0.z);

    const rngMod = await import('/js/core/rng.js');
    const unitMod = await import('/js/sim/unit.js');
    const clamp = rngMod.clamp, angleDiff = unitMod.angleDiff;
    const weaponsMod = await import('/js/data/weapons.js');
    const blastRadius = weaponsMod.WEAPONS['BOMB'].blastRadius;
    const acmMod = await import('/js/sim/acm.js');
    const { bombSolution, bombImpactPoint, TOSS } = acmMod;

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
    const variantCfg = { T0: { margin: null }, T1b: { margin: 0.8 } };

    const allRuns = {};
    async function runOne(variantLabel, samLabel, headingLabel) {
      const cfg = variantCfg[variantLabel];
      const id = `tc3f_${variantLabel}_${samLabel}_${headingLabel}`;
      const base = rotatedBase(headingDefs[headingLabel]);
      const samXZ = samDefs[samLabel];
      const extraGround = [{ type: 'SAM', name: `SAM ${samLabel}`, x: round(samXZ.x), z: round(samXZ.z), known: true }];
      const ctx = await openScenario(id, stage, base, extraGround);

      if (cfg.margin != null) installLowFloorPatch(ctx.u, clamp, angleDiff, cfg.margin);

      const res = runTrialF(ctx, { bombSolution, bombImpactPoint, TOSS, angleDiff, blastRadius });
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

    // ---------------------------------------------------------------- 集計: 爆弾の分類（表1）
    function aggregateBombs(variantLabel) {
      const runs = [];
      for (const samLabel of samLabels) for (const h of headingLabels) runs.push(allRuns[`${variantLabel}_${samLabel}_${h}`]);
      const allBombs = [];
      for (const r of runs) for (const b of r.bombs) allBombs.push(b);
      const n = allBombs.length;
      const byCat = {};
      for (const cat of ['hit', 'near', 'blocked', 'short', 'long', 'unresolved']) {
        const list = allBombs.filter((b) => b.category === cat);
        byCat[cat] = { n: list.length, pct: n ? round(list.length / n * 100, 1) : null };
      }
      const blockedList = allBombs.filter((b) => b.category === 'blocked');
      const blockedDist = blockedList.map((b) => b.distTarget);
      const blockedElev = blockedList.map((b) => b.blockElev);
      const kills = allBombs.filter((b) => b.isKillShot);
      const killsByCat = {};
      for (const cat of ['hit', 'near']) killsByCat[cat] = kills.filter((b) => b.category === cat).length;
      return {
        variant: variantLabel, n, byCat,
        blockedDistTarget: {
          n: blockedDist.length, mean: round(mean(blockedDist), 0), median: round(median(blockedDist), 0),
          p10: round(quantile(blockedDist, 0.1), 0), p90: round(quantile(blockedDist, 0.9), 0),
          min: blockedDist.length ? round(Math.min(...blockedDist), 0) : null,
          max: blockedDist.length ? round(Math.max(...blockedDist), 0) : null,
        },
        blockedElevMean: round(mean(blockedElev), 0),
        killShots: { n: kills.length, byCat: killsByCat },
      };
    }
    const bombTable = Object.keys(variantCfg).map(aggregateBombs);

    // ---------------------------------------------------------------- 集計: 機首上げ（表2）
    function aggregatePulls(variantLabel) {
      const runs = [];
      for (const samLabel of samLabels) for (const h of headingLabels) runs.push(allRuns[`${variantLabel}_${samLabel}_${h}`]);
      const allPulls = [];
      for (const r of runs) for (const p of r.pulls) allPulls.push(p);
      const n = allPulls.length;
      const zero = allPulls.filter((p) => p.bombs === 0);
      const reasonCount = {};
      for (const reason of ['window', 'angle', 'both', 'unknown', 'trial_end']) {
        const list = zero.filter((p) => p.endReason === reason);
        reasonCount[reason] = { n: list.length, evadingAtExit: list.filter((p) => p.evadingAtExit).length };
      }
      const destroyedRuns = runs.filter((r) => r.destroyed);
      const destroyedCount = destroyedRuns.length;
      const totalBombsInDestroyed = sum(destroyedRuns.map((r) => r.bombsUsed));
      const totalPullsInDestroyed = sum(destroyedRuns.map((r) => r.pulls.length));
      return {
        variant: variantLabel, n, runsN: runs.length,
        zeroBombCount: zero.length, zeroBombPct: n ? round(zero.length / n * 100, 1) : null,
        reasonCount,
        startDistAvg: round(mean(allPulls.map((p) => p.startDist)), 0),
        startAGLAvg: round(mean(allPulls.map((p) => p.startAGL)), 0),
        startDistAvgZero: round(mean(zero.map((p) => p.startDist)), 0),
        startAGLAvgZero: round(mean(zero.map((p) => p.startAGL)), 0),
        startDistAvgNonzero: round(mean(allPulls.filter((p) => p.bombs > 0).map((p) => p.startDist)), 0),
        startAGLAvgNonzero: round(mean(allPulls.filter((p) => p.bombs > 0).map((p) => p.startAGL)), 0),
        destroyedCount,
        pullsPerKill: destroyedCount ? round(totalPullsInDestroyed / destroyedCount, 2) : null,
        bombsPerKill: destroyedCount ? round(totalBombsInDestroyed / destroyedCount, 2) : null,
        nonPullBombsSum: sum(runs.map((r) => r.nonPullBombs)),
      };
    }
    const pullTable = Object.keys(variantCfg).map(aggregatePulls);

    window.__tossC3fLast = { stage, samDefs, bearing0, blastRadius, allRuns };

    return { bombTable, pullTable };
  };
})();
