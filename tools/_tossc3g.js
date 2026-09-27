// §95.9で本体に入れた「山越しトス」(js/sim/aircraft.js の_terrainScan climbCredit・
// acm.js の tossClearAlt/TOSS.climbCredit・combat.js の bombPathClear投下判定)を測る。
// tools/_tossc3f.js を土台にする。ゲーム本体(js/)は一切変更しない。
//
// _tossc3f との違い:
//  - 低い床は今回「本体の実装」なので、tools側でu._terrainScanを差し替える必要が無い。
//    変種は acm.js の TOSS.climbCredit を直接差し替えるだけ(N0=既定0.8, N1=0)。
//    TOSSはモジュールのライブバインディングが指す同一オブジェクトなので、
//    プロパティを書き換えれば本体のaircraft.js/combat.jsが次に読んだときそのまま効く
//    (importの束縛自体は変えない・書き換えるのはオブジェクトのプロパティ)。
//    本当に効いているかは__tossC3gRunの戻り値のverifyブロックで確認する
//    (u._terrainScanを直接climbCredit違いで2回呼び、floorが変わるか見る)。
//  - tools/_tossc3e.js からSAM可視秒(段階別)・進入/離脱の地上高平均・最低地上高・
//    地形衝突(u.deathCause==='terrain')・SAM発射/命中を移植し、1回のtickループに統合。
//  - 新規: ポップアップ(u._tossPopped)の回数と、ポップアップ時の投射の床(u._tossClear.alt)・
//    高度・地上高。attackRunの全遷移を記録し、'in'→'out'の直接遷移
//    (機首上げできないまま入り直した回数)を数える。
//
// 読み込み:
//   await fetch('/tools/_tossc3g.js').then(r => r.text()).then(eval);
// 実行(重いので直接awaitせず、fire-and-forgetしてポーリングで回収する):
//   window.__tc3gResult = null;
//   window.__tossC3gRun().then(r => window.__tc3gResult = r)
//     .catch(e => window.__tc3gResult = { error: String((e && e.stack) || e) });
// 回収:
//   window.__tc3gResult   // nullなら未完了
//
// 生ログ(各runの生の集計)は window.__tossC3gLast に積む。航跡そのものは積まない。
(() => {
  const DT = 1 / 30;
  const DEG = Math.PI / 180;
  const MAX_T = 260;
  const SAM_CLEARANCE = 8, SAM_STEP = 400;

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
      id, group: '計測', name: 'TOSS C3G PROBE', title: '計測用（非表示）',
      battleSeed: 0xC30004,
      brief: '計測用の内部ステージ（c3の地形・配置を写す・山越しトス§95.9の本体計測）。', hint: '',
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

  // ---------------------------------------------------------------- 追跡: attackRunの全遷移・pull詳細・ポップアップ
  // attackRunの代入(aircraft.js:1029 `this.attackRun = run.phase`)と
  // _tossPopped の代入(aircraft.js:1069/1073)、どちらもプロパティ代入なので
  // アクセサで捕まえる。u.pos/u.headingは代入の直前=移動より前の値。
  function installRunTracker(u, target, targetXZ, terrain, bombSolution, bombImpactPoint, angleDiff, TOSS, blastRadius) {
    const pulls = [];
    const transitions = [];
    const pops = [];
    let currentPull = null;
    let raw = u.attackRun;

    Object.defineProperty(u, 'attackRun', {
      configurable: true,
      get() { return raw; },
      set(v) {
        if (v !== raw) transitions.push({ from: raw, to: v });
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

    let rawPopped = u._tossPopped;
    Object.defineProperty(u, '_tossPopped', {
      configurable: true,
      get() { return rawPopped; },
      set(v) {
        if (v && !rawPopped) {
          const clear = u._tossClear;
          const ground = terrain.heightAt(u.pos.x, u.pos.z);
          pops.push({
            clearAlt: clear ? round(clear.alt, 0) : null,
            posAlt: round(u.pos.y, 0),
            posAGL: round(u.pos.y - ground, 0),
          });
        }
        rawPopped = v;
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
        return { pulls, transitions, pops };
      },
    };
  }

  // ---------------------------------------------------------------- 1試行
  const stageKeys = ['farIn', 'nearIn', 'pull', 'out', 'evading', 'other'];

  function runTrialG(ctx, cfg) {
    const { world, u, target, sam } = ctx;
    const terrain = world.terrain;
    const targetXZ = { x: target.pos.x, z: target.pos.z };
    const { bombSolution, bombImpactPoint, TOSS, angleDiff, blastRadius, samRange } = cfg;

    u.bombProfile = 'toss';
    u.setPlayerOrder({ type: 'attack', target });

    const tracker = installRunTracker(u, target, targetXZ, terrain, bombSolution, bombImpactPoint, angleDiff, TOSS, blastRadius);

    let samFired = 0, samHits = 0;
    world.onMissileHit = (m, tgt) => { if (tgt === u && m.weapon && m.weapon.kind === 'sam') samHits++; };

    const samBuckets = {}; for (const k of stageKeys) samBuckets[k] = 0;
    let minAGL = Infinity, terrainCollision = false;
    let inAGLSum = 0, inAGLCount = 0, outAGLSum = 0, outAGLCount = 0;

    const bombRecords = [];
    let nonPullBombs = 0;
    world.onFire = (shooter, tgt, weapon, m) => {
      if (shooter === u && weapon.kind === 'bomb') {
        const ground = terrain.heightAt(u.pos.x, u.pos.z);
        const sol = bombSolution(u, target.pos.y);
        const pred = bombImpactPoint(u, sol.throwRange);
        bombRecords.push({
          releasePos: { x: m.pos.x, y: m.pos.y, z: m.pos.z },
          releaseDist: Math.hypot(targetXZ.x - u.pos.x, targetXZ.z - u.pos.z),
          releaseAlt: u.pos.y, releaseAGL: u.pos.y - ground,
          predPoint: pred, predDist: sol.throwRange,
          m, resolved: false,
        });
        if (tracker.isPull()) tracker.addBomb();
        else nonPullBombs++;
      } else if (sam && shooter === sam && weapon.kind === 'sam') samFired++;
    };

    let destroyedAt = null, killTick = null;
    let tick = 0;
    const maxTicks = Math.round(MAX_T / DT);

    for (; tick < maxTicks; tick++) {
      AT.loop.onFixedUpdate(DT);
      AT.loop.simTime += DT;
      const t = (tick + 1) * DT;
      const phase = u.attackRun;
      const ground = terrain.heightAt(u.pos.x, u.pos.z);
      const flat = Math.hypot(targetXZ.x - u.pos.x, targetXZ.z - u.pos.z);

      let stage = null;
      if (sam && sam.alive) {
        const samFlat = Math.hypot(sam.pos.x - u.pos.x, sam.pos.z - u.pos.z);
        if (samFlat <= samRange && terrain.hasLineOfSight(sam.pos, u.pos, SAM_CLEARANCE, SAM_STEP)) {
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
      }

      for (const rec of bombRecords) {
        if (!rec.resolved && !rec.m.alive) {
          rec.resolved = true;
          rec.actualPos = { x: rec.m.pos.x, y: rec.m.pos.y, z: rec.m.pos.z };
          rec.endReason = rec.m.endReason;
          rec.explodeTick = tick;
        }
      }

      if (!target.alive && destroyedAt == null) { destroyedAt = t; killTick = tick; }
      if (!u.alive) { if (u.deathCause === 'terrain') terrainCollision = true; break; }
      if (destroyedAt != null && t - destroyedAt > 20) break;
    }
    world.onFire = null;
    world.onMissileHit = null;
    const { pulls, transitions, pops } = tracker.finalize();

    // ---- 爆弾ごとの分類
    const bombs = bombRecords.map((rec) => {
      if (!rec.resolved) return { category: 'unresolved' };
      const isKillShot = destroyedAt != null && rec.explodeTick === killTick;
      if (rec.endReason === 'hit') return { category: 'hit', isKillShot };
      const dTarget = Math.hypot(rec.actualPos.x - targetXZ.x, rec.actualPos.z - targetXZ.z);
      if (dTarget <= blastRadius) return { category: 'near', distTarget: round(dTarget), isKillShot };
      const actualDist = Math.hypot(rec.actualPos.x - rec.releasePos.x, rec.actualPos.z - rec.releasePos.z);
      const gap = rec.predDist - actualDist;
      if (gap > 300) {
        return { category: 'blocked', distTarget: round(dTarget), blockElev: round(rec.actualPos.y), gap: round(gap), isKillShot };
      }
      const relFlat = Math.max(1, rec.releaseDist);
      const axisX = (targetXZ.x - rec.releasePos.x) / relFlat, axisZ = (targetXZ.z - rec.releasePos.z) / relFlat;
      const along = (rec.actualPos.x - rec.releasePos.x) * axisX + (rec.actualPos.z - rec.releasePos.z) * axisZ;
      const signed = along - relFlat;
      return { category: signed < 0 ? 'short' : 'long', distTarget: round(dTarget), isKillShot };
    });

    // 「機首上げできないまま近づきすぎて入り直した」= 'in'から'out'への直接遷移
    const directInOut = transitions.filter((tr) => tr.from === 'in' && tr.to === 'out').length;

    return {
      destroyed: !target.alive, loss: !u.alive, terrainCollision,
      bombsUsed: bombRecords.length, nonPullBombs, bombs,
      pulls, pops, directInOut,
      samFired, samHits, samBuckets: { ...samBuckets },
      minAGL: Number.isFinite(minAGL) ? round(minAGL) : null,
      inAGLAvg: inAGLCount ? round(inAGLSum / inAGLCount) : null,
      outAGLAvg: outAGLCount ? round(outAGLSum / outAGLCount) : null,
      // destroyedAt = 撃破の瞬間(t)。endTは撃破後20秒の後始末を待ってからループを
      // 抜けた時刻なので「平均秒」には使わない(誤って使うと系統的に+20秒前後ずれる)。
      destroyedAt: destroyedAt != null ? round(destroyedAt, 1) : null,
      endT: round(tick * DT, 1),
    };
  }

  // ---------------------------------------------------------------- 実行本体
  window.__tossC3gRun = async () => {
    const stage = await loadStage();
    const target0 = stage.enemy.ground.find((g) => g.type === 'RADAR');
    const base0 = stage.friendly.base;
    const bearing0 = headingOf(target0.x - base0.x, target0.z - base0.z);
    const distBaseTarget = Math.hypot(base0.x - target0.x, base0.z - target0.z);

    const unitMod = await import('/js/sim/unit.js');
    const angleDiff = unitMod.angleDiff;
    const weaponsMod = await import('/js/data/weapons.js');
    const blastRadius = weaponsMod.WEAPONS['BOMB'].blastRadius;
    const samRange = weaponsMod.WEAPONS['SAM-M'].range;
    const acmMod = await import('/js/sim/acm.js');
    const { bombSolution, bombImpactPoint, TOSS } = acmMod;
    const originalClimbCredit = TOSS.climbCredit;

    // ---- 差し替えが本体に効いているかの確認 -------------------------------------
    // u._terrainScanをclimbCredit違いで直接2回呼ぶ(本体のtossAttackRun/combat.jsの
    // 分岐は経由しないが、TOSS.climbCreditを実際に読むのと同じ関数・同じ経路)。
    const verify = {};
    {
      const perp0 = bearing0 + Math.PI / 2;
      const vBase = (() => {
        const brg = bearing0;
        return { x: target0.x - distBaseTarget * Math.sin(brg), z: target0.z + distBaseTarget * Math.cos(brg) };
      })();
      const vSam = offset(target0, 300, perp0);
      const ctx = await openScenario('tc3g_verify', stage, vBase, [{ type: 'SAM', name: 'SAM verify', x: round(vSam.x), z: round(vSam.z), known: true }]);
      ctx.u.bombProfile = 'toss';
      ctx.u.setPlayerOrder({ type: 'attack', target: ctx.target });
      // 1tickだけ進めて、その針路上でfloorを比べる
      AT.loop.onFixedUpdate(DT);
      AT.loop.simTime += DT;
      const floorDefault = ctx.u._terrainScan(ctx.world, ctx.u.heading, TOSS.climbCredit).floor;
      TOSS.climbCredit = 0;
      const floorAfterSetZero = ctx.u._terrainScan(ctx.world, ctx.u.heading, TOSS.climbCredit).floor;
      const floorReadBack = acmMod.TOSS.climbCredit; // 別の変数越しに読んでも同じインスタンスか
      TOSS.climbCredit = originalClimbCredit; // 元へ戻す
      verify.originalClimbCredit = originalClimbCredit;
      verify.floorWithDefaultCredit = round(floorDefault);
      verify.floorWithZeroCredit = round(floorAfterSetZero);
      verify.floorDroppedWhenZeroed = floorAfterSetZero < floorDefault;
      verify.climbCreditReadBackAfterSet = floorReadBack;
      verify.climbCreditRestored = TOSS.climbCredit === originalClimbCredit;
    }

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
    const variantCfg = { N0: { climbCredit: originalClimbCredit }, N1: { climbCredit: 0 } };

    const allRuns = {};
    async function runOne(variantLabel, samLabel, headingLabel) {
      const id = `tc3g_${variantLabel}_${samLabel}_${headingLabel}`;
      const base = rotatedBase(headingDefs[headingLabel]);
      const samXZ = samDefs[samLabel];
      const extraGround = [{ type: 'SAM', name: `SAM ${samLabel}`, x: round(samXZ.x), z: round(samXZ.z), known: true }];
      const ctx = await openScenario(id, stage, base, extraGround);
      const res = runTrialG(ctx, { bombSolution, bombImpactPoint, TOSS, angleDiff, blastRadius, samRange });
      allRuns[`${variantLabel}_${samLabel}_${headingLabel}`] = res;
      return res;
    }

    for (const variantLabel of Object.keys(variantCfg)) {
      TOSS.climbCredit = variantCfg[variantLabel].climbCredit; // ここで本体の分岐が実際に読む値を差し替える
      for (const samLabel of samLabels) {
        for (const headingLabel of headingLabels) {
          await runOne(variantLabel, samLabel, headingLabel);
        }
      }
    }
    TOSS.climbCredit = originalClimbCredit; // 後片付け

    // ---------------------------------------------------------------- 集計: 変種ごとの表(撃破/秒/爆弾/損失/衝突/SAM/AGL)
    function aggregateVariant(variantLabel) {
      const runs = [];
      for (const samLabel of samLabels) for (const h of headingLabels) runs.push(allRuns[`${variantLabel}_${samLabel}_${h}`]);
      const n = runs.length;
      const destroyedCount = runs.filter((r) => r.destroyed).length;
      // T0/T1bの「平均秒」は撃破までの時間(destroyedAt)。endTは撃破後20秒の後始末を
      // 待った終了時刻なので使わない(以前の版はここでendTを使っていて系統的に長く出た)。
      const timeVals = runs.map((r) => r.destroyed ? r.destroyedAt : null).filter((x) => x != null);
      const totalBombs = sum(runs.map((r) => r.bombsUsed));
      const samSeen = {};
      for (const k of stageKeys) samSeen[k] = round(sum(runs.map((r) => r.samBuckets[k])), 1);
      const samSeenTotal = round(sum(stageKeys.map((k) => sum(runs.map((r) => r.samBuckets[k])))), 1);
      return {
        variant: variantLabel, n,
        destroyedFrac: `${destroyedCount}/${n}`,
        avgTimeToKill: round(mean(timeVals), 1),
        totalBombs, bombsPerKill: destroyedCount ? round(totalBombs / destroyedCount, 2) : null,
        lossCount: runs.filter((r) => r.loss).length,
        collisionCount: runs.filter((r) => r.terrainCollision).length,
        minAGL: round(Math.min(...runs.map((r) => r.minAGL != null ? r.minAGL : Infinity)), 1),
        samFiredSum: sum(runs.map((r) => r.samFired)),
        samHitsSum: sum(runs.map((r) => r.samHits)),
        samSeenTotal, samSeen,
        inAGLAvg: round(mean(runs.map((r) => r.inAGLAvg)), 0),
        outAGLAvg: round(mean(runs.map((r) => r.outAGLAvg)), 0),
        nonPullBombsSum: sum(runs.map((r) => r.nonPullBombs)),
      };
    }

    // ---------------------------------------------------------------- 集計: 爆弾の分類
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
      const kills = allBombs.filter((b) => b.isKillShot);
      const killsByCat = {};
      for (const cat of ['hit', 'near']) killsByCat[cat] = kills.filter((b) => b.category === cat).length;
      return {
        variant: variantLabel, n, byCat,
        blockedElevMean: round(mean(blockedList.map((b) => b.blockElev)), 0),
        killShots: { n: kills.length, byCat: killsByCat },
      };
    }

    // ---------------------------------------------------------------- 集計: 機首上げ・ポップアップ・入り直し
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
      const allPops = [];
      for (const r of runs) for (const p of r.pops) allPops.push(p);
      return {
        variant: variantLabel, n,
        zeroBombCount: zero.length, zeroBombPct: n ? round(zero.length / n * 100, 1) : null,
        reasonCount,
        startDistAvg: round(mean(allPulls.map((p) => p.startDist)), 0),
        startAltAvg: round(mean(allPulls.map((p) => p.startAlt)), 0),
        startAGLAvg: round(mean(allPulls.map((p) => p.startAGL)), 0),
        popCount: allPops.length,
        popClearAltAvg: round(mean(allPops.map((p) => p.clearAlt)), 0),
        popPosAltAvg: round(mean(allPops.map((p) => p.posAlt)), 0),
        popPosAGLAvg: round(mean(allPops.map((p) => p.posAGL)), 0),
        directInOutSum: sum(runs.map((r) => r.directInOut)),
      };
    }

    const variantTable = Object.keys(variantCfg).map(aggregateVariant);
    const bombTable = Object.keys(variantCfg).map(aggregateBombs);
    const pullTable = Object.keys(variantCfg).map(aggregatePulls);

    window.__tossC3gLast = { stage, samDefs, bearing0, blastRadius, samRange, allRuns };

    return { verify, variantTable, bombTable, pullTable };
  };
})();
