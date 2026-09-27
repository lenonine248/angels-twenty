// c3（自作ステージ「NEW MISSION」）でのトス爆撃AIの飛び方計測。§95 続き・実地形版。
// ゲーム本体(js/)は一切変更しない。_tossai.js / _tossdef.js / _tut_harness.js を土台にする。
//
// 読み込み（先に harness を読んでおくこと）:
//   await fetch('/tools/_tut_harness.js').then(r => r.text()).then(eval);
//   await fetch('/tools/_tossc3.js').then(r => r.text()).then(eval);
// 実行（1回の呼び出しの中で最後まで回すこと。§93.12 と同じ理由 —
// 呼び出しを分けると合間の実時間ぶん本体の rAF が戦闘を進めてしまう）:
//   await __tossC3Run()
//
// 面の定義は /stages_out/new-mission-c3.json を fetch して使う（失敗したら下の
// FALLBACK_STAGE を使う）。地形は本物（種17878・山0.8・谷0.9・川2）なので、
// c3 の RADAR は known:true で最初から `state:'memory'` の記憶目標になり
// （`sim/detection.js` の `state` ゲッター）、地形に隠れても LOST しない
// （`_age()` が `state==='memory'` を丸ごとスキップする）。**よって既存の道具にある
// 毎tickの reseedContact は要らない** —— この面では常に狙点が正確なまま。
//
// 返り値: { partA, table, flightSummary }。生ログは window.__tossC3Last に積む。
(() => {
  const DT = 1 / 30;
  const DEG = Math.PI / 180;
  const MAX_T = 260;      // 1試行の上限秒（撃破後は+20秒で打ち切り）
  const DIST_MARKERS = [12000, 10000, 8000, 6000, 5000, 4000, 3000];
  const SHADOW_MARKERS = [2000, 3000, 4000, 5000, 6000, 8000, 10000, 12000, 15000, 20000];
  const RIDGE_HIT_MARGIN = 80; // 着弾点の地形が目標標高よりこれ以上高ければ「稜線」扱い

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

  function headingOf(dx, dz) { return Math.atan2(dx, -dz); }
  function round(x, d = 0) { const k = 10 ** d; return x == null ? null : Math.round(x * k) / k; }

  async function loadStage() {
    try {
      const r = await fetch('/stages_out/new-mission-c3.json');
      if (r.ok) return await r.json();
    } catch (e) { /* fall through */ }
    return FALLBACK_STAGE;
  }

  // ---------------------------------------------------------------- シナリオ構築

  function buildScenario(id, stage, extraGround) {
    const ground = (stage.enemy.ground || []).map((g) => ({ ...g }));
    if (extraGround) ground.push(...extraGround);
    return {
      id, group: '計測', name: 'TOSS C3 PROBE', title: '計測用（非表示）',
      battleSeed: 0xC30001, // A/Bの比較なので種を固定（固定しないと爆弾散布が毎回動く）
      brief: '計測用の内部ステージ（c3の地形・配置を写す）。', hint: '',
      terrain: { ...stage.terrain },
      weaponPoints: stage.weaponPoints || 24,
      noFail: true,
      friendly: {
        base: { ...stage.friendly.base },
        startAirborne: true,
        startAlt: stage.friendly.startAlt,
        aircraft: stage.friendly.aircraft.map((a) => ({ ...a, autoWeapons: { BOMB: true } })),
      },
      enemy: { skill: stage.enemy.skill, aircraft: [], ground },
      steps: [{ text: '(計測用ダミー手順)', check: () => false }],
    };
  }

  async function openScenario(id, stage, extraGround) {
    if (!AT.tutorials.find((t) => t.id === id)) AT.tutorials.push(buildScenario(id, stage, extraGround));
    await __open(id);
    const b = AT.battle;
    const world = b.world;
    const u = world.units.find((x) => x.kind === 'aircraft' && x.side === world.playerSide);
    const target = world.units.find((x) => x.typeId === 'RADAR');
    const sam = world.units.find((x) => x.typeId === 'SAM');
    return { world, u, target, sam };
  }

  // ---------------------------------------------------------------- 地形の断面（Part A）

  /** 見えない最大高度を二分探索（clearance 8・step 400 = detection.js/missile.js と同じ） */
  function shadowHeightAt(terrain, sensorPos, x, z, hi = 12000) {
    let lo = Math.max(0, terrain.heightAt(x, z));
    let top = hi;
    for (let i = 0; i < 32; i++) {
      const mid = (lo + top) / 2;
      const visible = terrain.hasLineOfSight(sensorPos, { x, y: mid, z }, 8, 400);
      if (visible) top = mid; else lo = mid;
    }
    return lo;
  }

  function ridgesAlongSamples(samples) {
    const peaks = [];
    for (let i = 1; i < samples.length - 1; i++) {
      if (samples[i].h > samples[i - 1].h && samples[i].h >= samples[i + 1].h) peaks.push(samples[i]);
    }
    peaks.sort((a, b) => b.h - a.h);
    return peaks.slice(0, 3).map((p) => ({ distFromTarget: round(p.distFromTarget), h: round(p.h) }));
  }

  function sampleLine(terrain, p0, p1, targetXZ, step = 250) {
    const dx = p1.x - p0.x, dz = p1.z - p0.z;
    const dist = Math.hypot(dx, dz);
    const n = Math.max(1, Math.floor(dist / step));
    const samples = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const x = p0.x + dx * t, z = p0.z + dz * t;
      samples.push({ x, z, h: terrain.heightAt(x, z), distFromTarget: Math.hypot(targetXZ.x - x, targetXZ.z - z) });
    }
    return samples;
  }

  function sampleFlownPath(terrain, points, targetXZ, step = 250) {
    if (!points || points.length < 2) return [];
    const cum = [0];
    for (let i = 1; i < points.length; i++) cum.push(cum[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z));
    const total = cum[cum.length - 1];
    const samples = [];
    let idx = 0;
    for (let d = 0; d <= total; d += step) {
      while (idx < cum.length - 2 && cum[idx + 1] < d) idx++;
      const segLen = Math.max(1e-6, cum[idx + 1] - cum[idx]);
      const tt = (d - cum[idx]) / segLen;
      const x = points[idx].x + (points[idx + 1].x - points[idx].x) * tt;
      const z = points[idx].z + (points[idx + 1].z - points[idx].z) * tt;
      samples.push({ x, z, h: terrain.heightAt(x, z), distFromTarget: Math.hypot(targetXZ.x - x, targetXZ.z - z) });
    }
    return samples;
  }

  /** Part A: 基地→目標の直線 + 実際に飛んだ経路(V0)沿いの断面・影の高さ */
  function profileTerrain(world, stage, target, flownPathXZ) {
    const terrain = world.terrain;
    const base = stage.friendly.base;
    const targetXZ = { x: target.pos.x, z: target.pos.z };
    const sensorPos = target.pos;

    const lineSamples = sampleLine(terrain, base, targetXZ, targetXZ, 250);
    const pathSamples = sampleFlownPath(terrain, flownPathXZ, targetXZ, 250);

    const lineDir = { x: (base.x - targetXZ.x), z: (base.z - targetXZ.z) };
    const lineLen = Math.hypot(lineDir.x, lineDir.z);
    const ux = lineDir.x / lineLen, uz = lineDir.z / lineLen;
    const shadowLine = SHADOW_MARKERS.filter((d) => d < lineLen).map((d) => {
      const x = targetXZ.x + ux * d, z = targetXZ.z + uz * d;
      return { d, shadow: round(shadowHeightAt(terrain, sensorPos, x, z)) };
    });

    return {
      targetY: round(target.pos.y),
      targetXZ, base,
      lineRidges: ridgesAlongSamples(lineSamples),
      pathRidges: ridgesAlongSamples(pathSamples),
      shadowLine,
      terrain, sensorPos,
    };
  }

  // ---------------------------------------------------------------- 1試行

  /**
   * 1試行を最後まで進める。
   * cfg: { profile: 'toss'|'level', scripted: bool, ridgeAlt: number, sam: {unit,range}|null }
   */
  function runTrial(ctx, cfg, partA) {
    const { world, u, target, sam } = ctx;
    const terrain = world.terrain;
    const targetXZ = { x: target.pos.x, z: target.pos.z };

    u.bombProfile = cfg.profile;
    u.setPlayerOrder({ type: 'attack', target });
    if (cfg.scripted) AT.commands._applyAltitude(u, cfg.ridgeAlt - 50);

    const bombEvents = [];      // { t, flat, alt, phase, m }
    const samFireEvents = [];
    let samHits = 0;

    const onFire = (shooter, tgt, weapon, m) => {
      if (shooter === u && weapon.kind === 'bomb') {
        bombEvents.push({
          t: AT.loop.simTime,
          flat: Math.hypot(targetXZ.x - u.pos.x, targetXZ.z - u.pos.z),
          alt: u.pos.y, phase: u.attackRun, m,
        });
      } else if (sam && shooter === sam && weapon.kind === 'sam') {
        samFireEvents.push({ t: AT.loop.simTime });
      }
    };
    world.onFire = onFire;
    world.onMissileHit = (m, tgt) => { if (tgt === u && m.weapon && m.weapon.kind === 'sam') samHits++; };

    const flownPath = [];       // {x,z} 毎秒
    const losRadarHist = [];    // bool 毎tick
    const milestones = {};      // marker -> {alt, floor, shadow}
    let remainingMarkers = [...DIST_MARKERS];

    let radarSeenSeconds = 0, firstSeen = null;
    let samSeenSeconds = 0;
    let prevPhase = null, pullStart = null, maxPullAlt = null, firstPullActive = false;
    let outStartIdx = null, closestOutFlat = sam || true ? Infinity : null;
    let closestOutFlatAny = Infinity;
    let climbTriggered = false, egressTriggered = false;
    let destroyedAt = null;
    let tick = 0;
    const maxTicks = Math.round(MAX_T / DT);

    for (; tick < maxTicks; tick++) {
      AT.loop.onFixedUpdate(DT);
      AT.loop.simTime += DT;
      const t = (tick + 1) * DT;

      const flat = Math.hypot(targetXZ.x - u.pos.x, targetXZ.z - u.pos.z);

      // --- V2 台本 ---
      if (cfg.scripted) {
        if (!climbTriggered && flat <= 4500) {
          AT.commands._applyAltitude(u, u.pos.y + 2000);
          climbTriggered = true;
        }
        if (!egressTriggered && bombEvents.length >= 1) {
          u.setPlayerOrder({ type: 'move', x: ctx.basePos.x, z: ctx.basePos.z, alt: cfg.ridgeAlt - 200 });
          egressTriggered = true;
        }
      }

      // --- 見通し ---
      const losRadar = terrain.hasLineOfSight(target.pos, u.pos, 8, 400);
      losRadarHist.push(losRadar);
      if (losRadar) {
        radarSeenSeconds += DT;
        if (!firstSeen) firstSeen = { t: round(t, 1), flat: round(flat), alt: round(u.pos.y), phase: u.attackRun };
      }
      if (sam && sam.alive) {
        const samFlat = Math.hypot(sam.pos.x - u.pos.x, sam.pos.z - u.pos.z);
        if (samFlat <= cfg.samRange && terrain.hasLineOfSight(sam.pos, u.pos, 8, 400)) samSeenSeconds += DT;
      }

      // --- フェーズ遷移（pullStart/maxPullAlt は最初のパスだけ固定） ---
      const phase = u.attackRun;
      if (phase !== prevPhase) {
        if (phase === 'pull' && pullStart == null) { pullStart = { t: round(t, 1), flat: round(flat), alt: round(u.pos.y) }; maxPullAlt = u.pos.y; firstPullActive = true; }
        else if (phase !== 'pull') { firstPullActive = false; }
        if (phase === 'out' && outStartIdx == null) outStartIdx = losRadarHist.length - 1;
        prevPhase = phase;
      }
      if (phase === 'pull' && firstPullActive) maxPullAlt = Math.max(maxPullAlt, u.pos.y);
      if (phase === 'out') closestOutFlatAny = Math.min(closestOutFlatAny, flat);

      // --- 距離の節目 ---
      if (phase === 'in' || phase == null) {
        for (const marker of [...remainingMarkers]) {
          if (flat <= marker) {
            const heading = u._desiredHeading ?? u.heading;
            const floor = u._terrainScan(world, heading).floor;
            const shadow = shadowHeightAt(terrain, target.pos, u.pos.x, u.pos.z);
            milestones[marker] = { alt: round(u.pos.y), floor: round(floor), shadow: round(shadow) };
            remainingMarkers = remainingMarkers.filter((m) => m !== marker);
          }
        }
      }

      // --- 毎秒の飛行経路（Part A の実飛行経路用） ---
      if (tick % 30 === 0) flownPath.push({ x: u.pos.x, z: u.pos.z });

      if (!target.alive && destroyedAt == null) destroyedAt = t;
      if (!u.alive) break;
      if (destroyedAt != null && t - destroyedAt > 20) break;
    }

    world.onFire = null;
    world.onMissileHit = null;

    // --- 爆弾の着弾判定 ---
    const bombs = bombEvents.map((e, i) => {
      const m = e.m;
      const hit = m.endReason === 'hit';
      const groundHit = m.endReason === 'ground';
      const distFromTarget = Math.hypot(targetXZ.x - m.pos.x, targetXZ.z - m.pos.z);
      const terrainAtImpact = terrain.heightAt(m.pos.x, m.pos.z);
      const hitRidge = groundHit && (terrainAtImpact - target.pos.y > RIDGE_HIT_MARGIN);
      return {
        idx: i, fireT: round(e.t, 1), fireFlat: round(e.flat), fireAlt: round(e.alt), phase: e.phase,
        endReason: m.endReason || 'alive?', hit, groundHit, hitRidge, distFromTarget: round(distFromTarget),
      };
    });

    // --- out進入後、見えなくなるまでの秒数 ---
    let timeToHide = null;
    if (outStartIdx != null) {
      let lastTrueIdx = -1;
      for (let i = outStartIdx; i < losRadarHist.length; i++) if (losRadarHist[i]) lastTrueIdx = i;
      if (lastTrueIdx < outStartIdx) timeToHide = 0;
      else if (lastTrueIdx === losRadarHist.length - 1) timeToHide = null; // 最後まで見えたまま
      else timeToHide = round((lastTrueIdx + 1 - outStartIdx) * DT, 1);
    }

    return {
      destroyed: !target.alive,
      destroyedAt: round(destroyedAt, 1),
      aircraftAlive: u.alive,
      bombsUsed: bombs.length,
      hits: bombs.filter((b) => b.hit).length,
      groundMisses: bombs.filter((b) => b.groundHit).length,
      ridgeMisses: bombs.filter((b) => b.hitRidge).length,
      bombs,
      radarSeenSeconds: round(radarSeenSeconds, 1),
      firstSeen,
      samSeenSeconds: sam ? round(samSeenSeconds, 1) : null,
      samFired: samFireEvents.length,
      samHits,
      loss: !u.alive,
      pullStart, maxPullAlt: maxPullAlt != null ? round(maxPullAlt) : null,
      closestOutFlat: Number.isFinite(closestOutFlatAny) ? round(closestOutFlatAny) : null,
      timeToHide,
      milestones,
      flownPath,
      endT: round(tick * DT, 1),
    };
  }

  // ---------------------------------------------------------------- 実行本体

  window.__tossC3Run = async () => {
    const stage = await loadStage();
    const target0 = stage.enemy.ground.find((g) => g.type === 'RADAR');
    const base = stage.friendly.base;

    // SAM オフセット計算（レーダーサイトから進入方位に直角へ1km）
    const bearing0 = headingOf(target0.x - base.x, target0.z - base.z);
    const perp = bearing0 + Math.PI / 2; // 右90度側（恣意的選択・報告に明記）
    const samXZ = {
      x: target0.x + 1000 * Math.sin(perp),
      z: target0.z - 1000 * Math.cos(perp),
    };
    const samGround = [{ type: 'SAM', name: 'SAM陣地', x: round(samXZ.x), z: round(samXZ.z), known: true }];

    const weaponsMod = await import('/js/data/weapons.js');
    const samRange = weaponsMod.WEAPONS['SAM-M'].range;

    const table = [];
    const allRuns = {};
    let partA = null;
    let ridgeAlt = null;

    async function runOne(label, extraGround, cfg) {
      const id = `tossc3_${label}`;
      const ctx = await openScenario(id, stage, extraGround);
      ctx.basePos = base;
      cfg.samRange = samRange;
      const samSpec = ctx.sam ? { unit: ctx.sam, range: samRange } : null;
      const res = runTrial(ctx, { ...cfg, sam: samSpec }, partA);
      allRuns[label] = res;
      if (!partA && label === 'V0') {
        partA = profileTerrain(ctx.world, stage, ctx.target, res.flownPath);
        ridgeAlt = partA.lineRidges[0] ? partA.lineRidges[0].h : ctx.target.pos.y + 500;
      }
      table.push({ label, ...res });
      return res;
    }

    // V0: 今のAI・トス
    await runOne('V0', null, { profile: 'toss', scripted: false });
    // ridgeAlt が V0 実行後に決まるので、以後の scripted 版はこれを使う
    // V1: 今のAI・水平
    await runOne('V1', null, { profile: 'level', scripted: false });
    // V2: 台本（稜線-50mで進入 → 4.5kmで+2000m → 投下後に後退+稜線-200m）
    await runOne('V2', null, { profile: 'toss', scripted: true, ridgeAlt });

    // s版（SAMを追加）
    await runOne('V0s', samGround, { profile: 'toss', scripted: false });
    await runOne('V1s', samGround, { profile: 'level', scripted: false });
    await runOne('V2s', samGround, { profile: 'toss', scripted: true, ridgeAlt });

    window.__tossC3Last = { stage, samXZ, samRange, ridgeAlt, partA, allRuns };

    return {
      partA: partA && {
        targetY: partA.targetY,
        lineRidges: partA.lineRidges,
        pathRidges: partA.pathRidges,
        shadowLine: partA.shadowLine,
      },
      ridgeAlt: round(ridgeAlt),
      samXZ: { x: round(samXZ.x), z: round(samXZ.z) }, samRange,
      table: table.map((r) => ({
        label: r.label, destroyed: r.destroyed, destroyedAt: r.destroyedAt, loss: r.loss,
        bombsUsed: r.bombsUsed, hits: r.hits, groundMisses: r.groundMisses, ridgeMisses: r.ridgeMisses,
        radarSeenSeconds: r.radarSeenSeconds, firstSeen: r.firstSeen,
        samSeenSeconds: r.samSeenSeconds, samFired: r.samFired, samHits: r.samHits,
      })),
      flightSummary: ['V0', 'V2'].map((label) => {
        const r = allRuns[label];
        return {
          label, milestones: r.milestones, pullStart: r.pullStart, maxPullAlt: r.maxPullAlt,
          firstDrop: r.bombs[0] || null, closestOutFlat: r.closestOutFlat, timeToHide: r.timeToHide,
        };
      }),
    };
  };
})();
