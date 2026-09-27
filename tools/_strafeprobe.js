// STATUS ⑭「起伏のある地形での機銃掃射が衝突防止のせいで安定しない」を測る。
// ゲーム本体(js/)は変更しない。変種は機体のインスタンスの _terrainScan を差し替えるだけ。
//
// 何を見るか:
//  - 掃射のパス(attackRun が 'in' のまま目標から WINDOW 以内に入ってから 'out' になるまで)ごとに、
//    撃てた弾数・与えた損害と、撃てなかった刻みが**どの関門で止まったか**
//    (combat.js `_tryGun` と同じ順: 弾切れ/距離/機首ずれ(上下・左右)/命中見込み/視線)。
//  - 掃射の道筋(aircraft.js の `目標＋clamp(距離×0.18, 120, 900)`)より、
//    実際の高度と床(`_terrainScan`)がどれだけ上にあったか、地形回避で針路が振られたか。
//  - 地形への衝突・最低の地上高。
// 変種(VARIANTS): V0 が今の本体。V1 は §95.9 のトスと同じ「上昇の余地を見込む床」を
//   掃射の in/out に掛けた場合。V2 は in のあいだ**目標より先の地形だけ**に余地を見込む
//   (目標の上を過ぎてから登り始める前提・目標の手前は今の床のまま)。V3 は V2 ＋ out に V1 の余地。
//   どれも道具の中だけ(機体のインスタンスの _terrainScan を差し替える)。
//
// 読み込み:
//   await fetch('/tools/_tut_harness.js').then(r => r.text()).then(eval);
//   await fetch('/tools/_strafeprobe.js').then(r => r.text()).then(eval);
// 実行(重いので fire-and-forget してポーリング):
//   window.__spResult = null;
//   window.__strafeRun({ terrains: ['F','H','M','C'], types: ['A-3','F-1'], variants: ['V0','V1','V2','V3'], spots: 8, bearings: 3 })
//     .then(r => window.__spResult = r).catch(e => window.__spResult = { error: String((e && e.stack) || e) });
//   window.__spProgress  // 進み具合
// 生の各 run は window.__spRuns に積む(航跡は積まない)。
(() => {
  const DT = 1 / 30;
  const DEG = Math.PI / 180;
  const MAX_T = 200;          // 1本の上限(秒)
  const START_DIST = 12000;   // 出発点は目標からこの距離
  const WINDOW = 3200;        // combat.js の GUN_MAX_ENGAGE と同じ。パスを数え始める距離
  const MAP = 51200;

  const TERRAINS = {
    F: { seed: 88001, mountainAmount: 0, coast: 'none', valleyDepth: 0, rivers: 0, baseAltitude: 300 },     // 対照(平ら)
    H: { seed: 88001, mountainAmount: 0.4, coast: 'none', valleyDepth: 0.4, rivers: 1, baseAltitude: 300 }, // 丘(組み込み面の地形)
    M: { seed: 70707, mountainAmount: 0.7, coast: 'none', valleyDepth: 0.7, rivers: 2, baseAltitude: 400 }, // 起伏(組み込み面の地形)
    C: { seed: 17878, mountainAmount: 0.8, coast: 'none', valleyDepth: 0.9, rivers: 2, baseAltitude: 400 }, // c3(§95.9)
  };

  // in: 'none' | 'all'(今からの余地) | 'beyond'(目標より先だけ・目標からの余地)。out: 余地の係数
  const VARIANTS = {
    V0: { in: 'none', inCredit: 0, outCredit: 0 },
    V1: { in: 'all', inCredit: 0.8, outCredit: 0.8 },
    V2: { in: 'beyond', inCredit: 0.8, outCredit: 0 },
    V3: { in: 'beyond', inCredit: 0.8, outCredit: 0.8 },
  };

  // aircraft.js `_terrainScan` の写し（定数も写し。V0 の run で本体との一致を確かめる）。
  // 違いは余地の起点だけ: 目標までの道のり dT より先の点に `credit × climbRate × (s − dT)/速さ` を見込む。
  const MIN_AGL = 220, LOOK_STEP = 150, LOOK_NEAR = 3000, RIDGE_CLIMB = 2200;
  function scanBeyond(u, world, desiredHeading, dT, credit, angleDiff) {
    const terrain = world.terrain;
    const climbTime = RIDGE_CLIMB / Math.max(20, u.spec.climbRate);
    const lookAhead = clamp(u.speed * climbTime, 4000, 11000);
    const dtNear = LOOK_STEP / Math.max(50, u.speed);
    const turnNear = u.effectiveTurnRate * dtNear;
    let h = u.heading;
    let remaining = angleDiff(desiredHeading, u.heading);
    let x = u.pos.x, z = u.pos.z;
    let ground = terrain.heightAt(x, z);
    let travelled = 0, peakAt = 0;
    let floor = Math.max(ground, 0) + MIN_AGL;
    const perM = credit * u.spec.climbRate / Math.max(50, u.speed);
    while (travelled < lookAhead) {
      const step = travelled < LOOK_NEAR ? LOOK_STEP : LOOK_STEP * 3;
      const turnPerStep = turnNear * (step / LOOK_STEP);
      const turn = clamp(remaining, -turnPerStep, turnPerStep);
      h += turn; remaining -= turn;
      x += Math.sin(h) * step; z += -Math.cos(h) * step;
      travelled += step;
      const g = terrain.heightAt(x, z);
      if (g > ground) { ground = g; peakAt = travelled; }
      const beyond = travelled - dT;
      floor = Math.max(floor, Math.max(g, 0) + MIN_AGL - (beyond > 0 ? perM * beyond : 0));
    }
    return { floor, dist: peakAt };
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const round = (x, d = 0) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const mean = (a) => { const b = a.filter((x) => x != null && Number.isFinite(x)); return b.length ? b.reduce((s, x) => s + x, 0) / b.length : null; };
  const median = (a) => { const b = a.filter((x) => x != null && Number.isFinite(x)).sort((x, y) => x - y); if (!b.length) return null; const m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; };

  let M = null;
  async function mods() {
    if (M) return M;
    const unit = await import('/js/sim/unit.js');
    const combat = await import('/js/sim/combat.js');
    const bullet = await import('/js/sim/bullet.js');
    M = {
      angleDiff: unit.angleDiff, headingOf: unit.headingOf,
      estimateGunHit: combat.estimateGunHit, GUN_THRESHOLD: combat.GUN_THRESHOLD,
      CONE: combat.GUN_AIM_CONE_GROUND, aimPointOf: bullet.aimPointOf, BULLET_LIFE: bullet.BULLET_LIFE,
      aimPt: null, losPt: null,   // 最初の run で機体の pos から作る（three を import しないため）
    };
    return M;
  }

  function scenario(id, T, spot, start, startAGL, type) {
    return {
      id, group: '計測', name: 'STRAFE PROBE', title: '計測用（非表示）',
      battleSeed: 0x57AF01, brief: '計測用（STATUS ⑭ 起伏地形の機銃掃射）', hint: '',
      terrain: { ...T }, weaponPoints: 99, noFail: true,
      friendly: {
        base: { x: Math.round(start.x), z: Math.round(start.z) }, startAirborne: true, startAlt: startAGL,
        aircraft: [{ type, name: 'probe', x: Math.round(start.x), z: Math.round(start.z), loadout: [], autoWeapons: { GUN: true } }],
      },
      enemy: { skill: 0.6, aircraft: [], ground: [{ type: 'RADAR', name: 'tgt', x: Math.round(spot.x), z: Math.round(spot.z), known: true }] },
      steps: [{ text: '(計測用ダミー手順)', check: () => false }],
    };
  }

  async function open(sc) {
    const i0 = AT.tutorials.findIndex((t) => t.id === sc.id);
    if (i0 >= 0) AT.tutorials.splice(i0, 1);
    AT.tutorials.push(sc);
    await __open(sc.id);
    const i1 = AT.tutorials.findIndex((t) => t.id === sc.id);
    if (i1 >= 0) AT.tutorials.splice(i1, 1);
    const world = AT.battle.world;
    const u = world.units.find((x) => x.kind === 'aircraft' && x.side === world.playerSide);
    const tgt = world.units.find((x) => x.typeId === 'RADAR');
    return { world, u, tgt };
  }

  // 目標の周りの起伏: 半径 1〜5km の輪の最高点 − 目標の標高
  function relief(terrain, x, z) {
    const h0 = terrain.heightAt(x, z);
    let hi = h0;
    for (let r = 1000; r <= 5000; r += 1000) {
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2;
        hi = Math.max(hi, terrain.heightAt(x + r * Math.sin(a), z - r * Math.cos(a)));
      }
    }
    return hi - h0;
  }

  // 地形ごとに目標の点を選ぶ。起伏の四分位から同数ずつ(平らな地形は無作為)
  function pickSpots(terrain, key, n, rng) {
    const cand = [];
    for (let i = 0; i < 400; i++) {
      const x = 9000 + rng() * (MAP - 18000), z = 9000 + rng() * (MAP - 18000);
      if (terrain.heightAt(x, z) < 5) continue; // 水面は避ける
      cand.push({ x, z, relief: relief(terrain, x, z) });
    }
    cand.sort((a, b) => a.relief - b.relief);
    if (key === 'F') return cand.slice(0, n).map((s, i) => ({ ...s, q: 0 }));
    const out = [];
    const per = Math.max(1, Math.round(n / 4));
    for (let q = 0; q < 4; q++) {
      const lo = Math.floor((q * cand.length) / 4), hi = Math.floor(((q + 1) * cand.length) / 4);
      for (let j = 0; j < per; j++) out.push({ ...cand[lo + Math.floor(rng() * (hi - lo))], q });
    }
    return out;
  }

  function startFor(terrain, spot, bearing) {
    for (let k = 0; k < 12; k++) {
      const b = bearing + k * 30 * DEG;
      const s = { x: spot.x + START_DIST * Math.sin(b), z: spot.z - START_DIST * Math.cos(b) };
      if (s.x < 1500 || s.x > MAP - 1500 || s.z < 1500 || s.z > MAP - 1500) continue;
      let hi = 0;
      for (let d = 0; d <= START_DIST; d += 200) {
        const f = d / START_DIST;
        hi = Math.max(hi, terrain.heightAt(s.x + (spot.x - s.x) * f, s.z + (spot.z - s.z) * f));
      }
      const g = Math.max(0, terrain.heightAt(s.x, s.z));
      return { start: s, bearing: b, startAGL: Math.max(300, hi + 500 - g) };
    }
    return null;
  }

  function newPass(t, flat, angleOff) {
    return {
      t0: t, t1: null, entryAngle: angleOff, ticks: 0,
      gate: { ammo: 0, far: 0, coneP: 0, coneY: 0, est: 0, los: 0, ok: 0 },
      okFired: 0, rounds: 0, dmg: 0,
      bindTicks: 0, avoidTicks: 0, maxSwing: 0,
      maxAbove: -Infinity, sumAbove: 0, nAbove: 0,       // 実際の高度 − 掃射の道筋(射程内)
      maxLift: -Infinity,                                 // 床 − 掃射の道筋(射程内)
      minDist: Infinity, aglAtMin: null, pitchAtMin: null,
    };
  }

  async function runOne(cfg) {
    const m = await mods();
    const t0wall = performance.now();
    const { world, u, tgt } = await open(scenario(`sp_${cfg.key}`, TERRAINS[cfg.key], cfg.spot, cfg.start, cfg.startAGL, cfg.type));
    const terrain = world.terrain;
    if (!m.aimPt) { m.aimPt = u.pos.clone(); m.losPt = u.pos.clone(); }
    const g = u.spec.gunSpec;
    const range = g.muzzleSpeed * m.BULLET_LIFE * 0.95;
    const need = m.GUN_THRESHOLD[u.fireThreshold || 'mid'] ?? m.GUN_THRESHOLD.mid;
    const verify = { loadout: u.loadout.slice(), gun: u.gun, tgtY: round(tgt.pos.y) };

    tgt.hp = 1e6; // 撃破で止めない（パスごとの弾・損害を比べる）
    u.heading = m.headingOf(tgt.pos.x - u.pos.x, tgt.pos.z - u.pos.z);
    const V = VARIANTS[cfg.v];
    const origScan = u._terrainScan;
    if (cfg.v !== 'V0') {
      u._terrainScan = function (w, h, cc = 0) {
        const p = this.attackRun;
        if (p === 'in' && V.in === 'beyond') {
          const dT = Math.hypot(tgt.pos.x - this.pos.x, tgt.pos.z - this.pos.z);
          return scanBeyond(this, w, h, dT, V.inCredit, m.angleDiff);
        }
        if (p === 'in' && V.in === 'all') return origScan.call(this, w, h, V.inCredit);
        if (p === 'out' && V.outCredit > 0) return origScan.call(this, w, h, V.outCredit);
        return origScan.call(this, w, h, cc);
      };
    }
    let copyMaxDiff = 0; // V0 のとき、写しの scanBeyond(dT=∞, 0) と本体の差
    // 段階ごとの安全: 最低の地上高・150m 未満の秒・地形回避の秒
    const byPh = { win: { min: Infinity, low: 0, avoid: 0, n: 0 }, in: { min: Infinity, low: 0, avoid: 0, n: 0 }, out: { min: Infinity, low: 0, avoid: 0, n: 0 } };
    let worst = null;
    u.setPlayerOrder({ type: 'attack', target: tgt });

    let firedNow = 0;
    const prevGF = world.onGunFire;
    world.onGunFire = (s, t, n) => { if (s === u) firedNow += n; if (prevGF) prevGF.call(world, s, t, n); };

    const passes = [];
    let pass = null, lastFiring = null, orphanRounds = 0;
    let hpPrev = tgt.hp, minAGL = Infinity, dead = null, ammoOutAt = null;
    let t = 0;
    const maxTicks = Math.round(MAX_T / DT);
    for (let tick = 0; tick < maxTicks; tick++) {
      AT.loop.onFixedUpdate(DT);
      AT.loop.simTime += DT;
      t = (tick + 1) * DT;
      if (!u.alive) { dead = u.deathCause || 'other'; break; }
      const phase = u.attackRun;
      const dx = tgt.pos.x - u.pos.x, dz = tgt.pos.z - u.pos.z;
      const flat = Math.hypot(dx, dz);
      const bearing = m.headingOf(dx, dz);
      const ground = Math.max(0, terrain.heightAt(u.pos.x, u.pos.z));
      const agl = u.pos.y - ground;
      minAGL = Math.min(minAGL, agl);
      {
        const ph = phase === 'out' ? byPh.out : (phase === 'in' && flat < WINDOW ? byPh.win : byPh.in);
        ph.n++;
        ph.min = Math.min(ph.min, agl);
        if (agl < 150) ph.low++;
        if (u.terrainAvoiding) ph.avoid++;
        if (!worst || agl < worst.agl) {
          worst = { agl: round(agl), phase: phase === 'out' ? 'out' : (flat < WINDOW ? 'win' : 'in'), flat: round(flat), t: round(t, 1), pitch: round((u.pitch || 0) / DEG, 1) };
        }
      }
      if (cfg.v === 'V0' && phase === 'in' && flat < WINDOW && (tick % 15) === 0) {
        const dh = u._desiredHeading ?? u.heading;
        const a = scanBeyond(u, world, dh, Infinity, 0, m.angleDiff).floor;
        const b = origScan.call(u, world, dh, 0).floor;
        copyMaxDiff = Math.max(copyMaxDiff, Math.abs(a - b));
      }

      if (!pass && phase === 'in' && flat < WINDOW) {
        pass = newPass(t, flat, Math.abs(m.angleDiff(bearing, u.heading)) / DEG);
        passes.push(pass);
      } else if (pass && phase !== 'in') {
        pass.t1 = t; pass = null;
      }

      if (firedNow > 0) {
        if (pass) { pass.rounds += firedNow; lastFiring = pass; } else orphanRounds += firedNow;
      }
      const dhp = hpPrev - tgt.hp; hpPrev = tgt.hp;
      if (dhp > 0 && lastFiring) lastFiring.dmg += dhp;

      if (pass) {
        pass.ticks++;
        const dist = u.pos.distanceTo(tgt.pos);
        const pathAlt = tgt.pos.y + clamp(flat * 0.18, 120, 900);
        let gate;
        if (u.gun <= 0) gate = 'ammo';
        else if (dist > WINDOW || dist > range) gate = 'far';
        else {
          m.aimPointOf(u, tgt, g.muzzleSpeed, m.aimPt);
          const ax = m.aimPt.x - u.pos.x, ay = m.aimPt.y - u.pos.y, az = m.aimPt.z - u.pos.z;
          const fa = Math.hypot(ax, az);
          const yaw = Math.abs(m.angleDiff(m.headingOf(ax, az), u.heading));
          const pitch = Math.abs(Math.atan2(ay, Math.max(1, fa)) - (u.pitch || 0));
          if (Math.hypot(yaw, pitch) > m.CONE) gate = pitch >= yaw ? 'coneP' : 'coneY';
          else if (m.estimateGunHit(u, tgt) < need) gate = 'est';
          else {
            m.losPt.set(tgt.pos.x, tgt.pos.y + 40, tgt.pos.z);
            gate = terrain.hasLineOfSight(u.pos, m.losPt, 8, 300) ? 'ok' : 'los';
          }
        }
        pass.gate[gate]++;
        if (gate === 'ok' && firedNow > 0) pass.okFired++;
        if (gate !== 'far' && gate !== 'ammo') {
          const floorNow = u._terrainScan(world, u._desiredHeading ?? u.heading).floor;
          const above = u.pos.y - pathAlt;
          const lift = floorNow - pathAlt;
          if (lift > 1) pass.bindTicks++;
          pass.maxLift = Math.max(pass.maxLift, lift);
          pass.maxAbove = Math.max(pass.maxAbove, above);
          pass.sumAbove += above; pass.nAbove++;
        }
        if (u.terrainAvoiding) pass.avoidTicks++;
        pass.maxSwing = Math.max(pass.maxSwing, Math.abs(m.angleDiff(u._desiredHeading ?? u.heading, bearing)) / DEG);
        if (dist < pass.minDist) { pass.minDist = dist; pass.aglAtMin = u.pos.y - ground; pass.pitchAtMin = (u.pitch || 0) / DEG; }
      }
      firedNow = 0;

      if (u.gun <= 0 && ammoOutAt == null) ammoOutAt = t;
      if (ammoOutAt != null && t > ammoOutAt + 4) break;
    }
    if (pass) pass.t1 = t;
    world.onGunFire = prevGF;
    return {
      key: cfg.key, type: cfg.type, v: cfg.v, spotIdx: cfg.spotIdx, q: cfg.spot.q,
      relief: round(cfg.spot.relief), bearing: round(cfg.bearing / DEG), verify, copyMaxDiff: round(copyMaxDiff, 2),
      dead, minAGL: round(minAGL), gunLeft: u.gun, ammoOutAt: round(ammoOutAt, 1), endT: round(t, 1), orphanRounds,
      worst,
      phases: Object.fromEntries(Object.entries(byPh).map(([k, o]) => [k, { min: round(o.min), lowSec: round(o.low * DT, 1), avoidSec: round(o.avoid * DT, 1), sec: round(o.n * DT, 1) }])),
      cycle: round(median(passes.slice(1).map((p, i) => p.t0 - passes[i].t0)), 1),
      totalDmg: round(1e6 - tgt.hp, 1),
      passes: passes.map((p) => ({
        dur: round((p.t1 ?? t) - p.t0, 1), entryAngle: round(p.entryAngle), ticks: p.ticks, gate: p.gate, okFired: p.okFired,
        rounds: p.rounds, dmg: round(p.dmg, 1), bind: p.bindTicks, avoid: p.avoidTicks, maxSwing: round(p.maxSwing),
        maxAbove: round(p.maxAbove), meanAbove: p.nAbove ? round(p.sumAbove / p.nAbove) : null, maxLift: round(p.maxLift),
        minDist: round(p.minDist), aglAtMin: round(p.aglAtMin), pitchAtMin: round(p.pitchAtMin, 1),
      })),
      wallMs: Math.round(performance.now() - t0wall),
    };
  }

  // ---------------------------------------------------------------- 集計
  function summarize(runs, keyFn) {
    const groups = new Map();
    for (const r of runs) {
      const k = keyFn(r);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(r);
    }
    const rows = [];
    for (const [k, rs] of groups) {
      const ps = rs.flatMap((r) => r.passes);
      // 弾切れの後のパスは数えない（撃てないのが当然）
      const live = ps.filter((p) => p.gate.ammo < p.ticks * 0.5);
      const inRange = (p) => p.ticks - p.gate.far - p.gate.ammo;
      const tot = (f) => live.reduce((s, p) => s + f(p), 0);
      const irT = tot(inRange) || 1;
      const g = (name) => round((100 * tot((p) => p.gate[name])) / irT);
      rows.push({
        group: k, runs: rs.length,
        crash: rs.filter((r) => r.dead === 'terrain').length, otherDeath: rs.filter((r) => r.dead && r.dead !== 'terrain').length,
        minAGL: Math.min(...rs.map((r) => r.minAGL)),
        passes: live.length,
        firedPct: round((100 * live.filter((p) => p.rounds > 0).length) / Math.max(1, live.length)),
        roundsPerPass: round(mean(live.map((p) => p.rounds)), 1),
        dmgPerPass: round(mean(live.map((p) => p.dmg)), 1),
        dmgPerRound: round(tot((p) => p.dmg) / Math.max(1, tot((p) => p.rounds)), 2),
        passSec: round(median(live.map((p) => p.dur)), 1),
        stuckPasses: live.filter((p) => p.dur > 60).length,
        // 射程内の刻みの内訳(%)
        inRangeSec: round(irT * DT / Math.max(1, live.length), 1),
        ok: g('ok'), coneP: g('coneP'), coneY: g('coneY'), est: g('est'), los: g('los'),
        bindPct: round((100 * tot((p) => p.bind)) / irT),
        avoidPct: round((100 * tot((p) => p.avoid)) / Math.max(1, tot((p) => p.ticks))),
        medMaxAbove: round(median(live.map((p) => p.maxAbove))),
        medMaxLift: round(median(live.map((p) => p.maxLift))),
        dmgPerRun: round(mean(rs.map((r) => r.totalDmg)), 1),
        cycle: round(median(rs.map((r) => r.cycle)), 1),
        // 安全: 段階ごとの最低の地上高・150m 未満の秒（1本あたり）・地形回避の秒（1本あたり）
        minWin: Math.min(...rs.map((r) => r.phases.win.min ?? Infinity)),
        minIn: Math.min(...rs.map((r) => r.phases.in.min ?? Infinity)),
        minOut: Math.min(...rs.map((r) => r.phases.out.min ?? Infinity)),
        lowWin: round(mean(rs.map((r) => r.phases.win.lowSec)), 2),
        lowIn: round(mean(rs.map((r) => r.phases.in.lowSec)), 2),
        lowOut: round(mean(rs.map((r) => r.phases.out.lowSec)), 2),
        runsBelow150: rs.filter((r) => r.minAGL < 150).length,
        runsBelow100: rs.filter((r) => r.minAGL < 100).length,
        avoidOut: round(mean(rs.map((r) => r.phases.out.avoidSec)), 2),
        avoidIn: round(mean(rs.map((r) => r.phases.in.avoidSec + r.phases.win.avoidSec)), 2),
        worstPhase: rs.filter((r) => r.minAGL < 150).reduce((o, r) => { o[r.worst.phase] = (o[r.worst.phase] || 0) + 1; return o; }, {}),
      });
    }
    return rows;
  }

  // 撃てたかを「道筋よりどれだけ上を飛んだか」で割る
  function byAbove(runs) {
    const cls = (p) => (p.maxAbove == null ? 'n/a' : p.maxAbove < 150 ? '<150' : p.maxAbove < 400 ? '150-400' : p.maxAbove < 800 ? '400-800' : '800+');
    const out = {};
    for (const r of runs) {
      for (const p of r.passes) {
        if (p.gate.ammo >= p.ticks * 0.5) continue;
        const k = `${r.key}|${r.v}|${cls(p)}`;
        out[k] = out[k] || { n: 0, fired: 0, dmg: 0, coneP: 0, inRange: 0 };
        out[k].n++;
        if (p.rounds > 0) out[k].fired++;
        out[k].dmg += p.dmg;
        out[k].coneP += p.gate.coneP;
        out[k].inRange += p.ticks - p.gate.far - p.gate.ammo;
      }
    }
    for (const k in out) {
      const o = out[k];
      out[k] = { n: o.n, firedPct: round((100 * o.fired) / o.n), dmgPerPass: round(o.dmg / o.n, 1), conePPct: round((100 * o.coneP) / Math.max(1, o.inRange)) };
    }
    return out;
  }

  window.__strafeRun = async (opt = {}) => {
    const terrains = opt.terrains || ['F', 'H', 'M', 'C'];
    const types = opt.types || ['A-3', 'F-1'];
    const variants = opt.variants || ['V0', 'V1', 'V2', 'V3'];
    const nSpots = opt.spots || 8;
    const nBear = opt.bearings || 3;
    const runs = [];
    window.__spRuns = runs;
    const t0 = performance.now();
    const spotsInfo = {};
    for (const key of terrains) {
      // 地形を作るために1度開き、そこで点を選ぶ
      const probe = await open(scenario(`sp_${key}`, TERRAINS[key], { x: MAP / 2, z: MAP / 2 }, { x: MAP / 2 + 5000, z: MAP / 2 }, 1500, 'A-3'));
      const rng = mulberry32(0x5714 + key.charCodeAt(0));
      const spots = pickSpots(probe.world.terrain, key, key === 'F' ? Math.max(2, nSpots >> 1) : nSpots, rng);
      spotsInfo[key] = spots.map((s) => ({ x: round(s.x), z: round(s.z), relief: round(s.relief), q: s.q }));
      const plans = [];
      spots.forEach((spot, si) => {
        const b0 = rng() * Math.PI * 2;
        for (let b = 0; b < nBear; b++) {
          const st = startFor(probe.world.terrain, spot, b0 + (b * 2 * Math.PI) / nBear);
          if (st) plans.push({ spot, si, ...st });
        }
      });
      for (const pl of plans) {
        for (const type of types) {
          for (const v of variants) {
            window.__spProgress = `${key} ${runs.length} runs ${Math.round((performance.now() - t0) / 1000)}s`;
            const r = await runOne({ key, type, v, spot: pl.spot, spotIdx: pl.si, start: pl.start, startAGL: pl.startAGL, bearing: pl.bearing });
            runs.push(r);
          }
        }
      }
    }
    const verify = {
      loadouts: [...new Set(runs.map((r) => JSON.stringify(r.verify.loadout)))],
      // 「ok」と判定した刻みのうち実際に弾が出た割合（関門の写しが本体と合っているかの確かめ）
      okTicks: runs.reduce((s, r) => s + r.passes.reduce((a, p) => a + p.gate.ok, 0), 0),
      okFired: runs.reduce((s, r) => s + r.passes.reduce((a, p) => a + p.okFired, 0), 0),
      orphanRounds: runs.reduce((s, r) => s + r.orphanRounds, 0),
      totalRounds: runs.reduce((s, r) => s + r.passes.reduce((a, p) => a + p.rounds, 0) + r.orphanRounds, 0),
      // 写しの scanBeyond(dT=∞, 余地0) と本体の _terrainScan の最大差(m)。0 でなければ写しが違う
      copyMaxDiff: Math.max(0, ...runs.map((r) => r.copyMaxDiff || 0)),
    };
    return {
      wallSec: Math.round((performance.now() - t0) / 1000),
      verify,
      spots: spotsInfo,
      byTerrainTypeVariant: summarize(runs, (r) => `${r.key}|${r.type}|${r.v}`),
      byTerrainVariant: summarize(runs, (r) => `${r.key}|${r.v}`),
      byReliefQuartile: summarize(runs.filter((r) => r.key !== 'F'), (r) => `q${r.q}|${r.v}`),
      byAbove: byAbove(runs),
    };
  };
})();
