// 共上昇（コクライム）計測プローブ。本体コードは一切変更しない。
// 使い方（コンソール）:
//   await fetch('/tools/bench.js').then(r=>r.text()).then(eval)
//   await fetch('/tools/_coclimbprobe.js').then(r=>r.text()).then(eval)
//   await AT.coclimb.stage(0, AT.watch.SEEDS11)   // ステージ0を18種で計測
//   AT.coclimb.results                            // 溜まった生データ
//   AT.coclimb.report()                           // 面ごとの集計
//
// 仕組み: Aircraft.prototype.update と Mission.prototype.update を
// import() 経由で同一モジュールインスタンスに対して包む。
// 1秒おき（30ステップごと）に、空中の航空機のうち attack 指示で
// 相手が空中の航空機のものについて、
//   exact      = believedPosOf(target, world) === target.pos（正確に見えている）
//   perch      = exact && 水平距離>4000 && 自分が相手より上 && commandedAlt==null
//                （approachAlt の「相手の高度+900へ上に付ける」枝の条件を外側から複製）
// を記録する。判定ロジック自体（accessAlt/attack ケース）には一切触れない。
(function () {
  if (window.AT && window.AT.coclimb) return; // 二重読み込み防止

  const results = [];
  let patched = false;
  let stageCtx = null; // {stageIndex}

  async function ensurePatch() {
    if (patched) return;
    const aircraftMod = await import('/js/sim/aircraft.js');
    const missionMod = await import('/js/sim/mission.js');

    const aproto = aircraftMod.Aircraft.prototype;
    const origUpdate = aproto.update;
    aproto.update = function (dt, world) {
      if (world && !world.__ccInit) initWorld(world);
      return origUpdate.call(this, dt, world);
    };

    const mproto = missionMod.Mission.prototype;
    const origMissionUpdate = mproto.update;
    mproto.update = function (dt) {
      origMissionUpdate.call(this, dt);
      const world = this.world;
      if (world && world.__ccInit && this.state !== 'active' && !world.__ccFinal) {
        world.__ccFinal = true;
        finalizeWorld(world);
      }
    };

    patched = true;
  }

  function initWorld(world) {
    world.__ccInit = true;
    world.__ccTick = 0;
    world.__ccAlt = new Map();   // unitId -> { name, side, spec:{ceiling}, arr:[{t,y}] }
    world.__ccEdges = [];        // { t, from, to, exact, perch }
    world.__ccMeta = {
      stageIndex: stageCtx ? stageCtx.stageIndex : null,
      seed: (window.AT && window.AT.battle) ? window.AT.battle.seed : null,
      stageName: (window.AT && window.AT.battle && window.AT.battle.stage) ? window.AT.battle.stage.name : null,
    };
    const origDetUpdate = world.detection.update.bind(world.detection);
    world.detection.update = function (ddt) {
      world.__ccTick++;
      if (world.__ccTick % 30 === 0) sampleWorld(world, +(world.__ccTick / 30).toFixed(1));
      return origDetUpdate(ddt);
    };
  }

  function sampleWorld(world, t) {
    for (const u of world.units) {
      if (!u.alive || u.kind !== 'aircraft' || u.onGround) continue;
      let rec = world.__ccAlt.get(u.id);
      if (!rec) {
        rec = { name: u.name, side: u.side, ceiling: u.spec ? u.spec.ceiling : null, arr: [] };
        world.__ccAlt.set(u.id, rec);
      }
      rec.arr.push({ t, y: u.pos.y });

      const o = u.order;
      if (!o || o.type !== 'attack') continue;
      const tg = o.target;
      if (!tg || !tg.alive || tg.kind !== 'aircraft' || tg.onGround) continue;
      const aim = u.believedPosOf ? u.believedPosOf(tg, world) : null;
      if (!aim) continue;
      const exact = aim === tg.pos;
      const dx = aim.x - u.pos.x, dz = aim.z - u.pos.z;
      const flat = Math.hypot(dx, dz);
      const above = u.pos.y - tg.pos.y;
      const perch = exact && flat > 4000 && above > 0 && u.commandedAlt == null;
      world.__ccEdges.push({ t, from: u.id, to: tg.id, exact, perch });
    }
  }

  function altAt(rec, t) {
    for (const p of rec.arr) if (p.t === t) return p.y;
    return null;
  }

  function finalizeWorld(world) {
    const meta = world.__ccMeta;
    const alt = world.__ccAlt;
    const edges = world.__ccEdges;

    // ペアごとに従事したtickを集める
    const pairTicks = new Map(); // key "a-b" (a<b) -> Map t -> {aId,bId,dirs:[{from,to,exact,perch}]}
    for (const e of edges) {
      const a = Math.min(e.from, e.to), b = Math.max(e.from, e.to);
      const key = a + '-' + b;
      let m = pairTicks.get(key);
      if (!m) { m = new Map(); pairTicks.set(key, m); }
      let entry = m.get(e.t);
      if (!entry) { entry = []; m.set(e.t, entry); }
      entry.push(e);
    }

    // 攻撃指示中に到達した最高高度（ユニットごと）
    const attackMaxAlt = new Map(); // unitId -> maxY
    for (const e of edges) {
      const rec = alt.get(e.from);
      if (!rec) continue;
      const y = altAt(rec, e.t);
      if (y == null) continue;
      const cur = attackMaxAlt.get(e.from);
      if (cur == null || y > cur) attackMaxAlt.set(e.from, y);
    }

    const segments = [];
    for (const [key, tmap] of pairTicks) {
      const [aId, bId] = key.split('-').map(Number);
      const recA = alt.get(aId), recB = alt.get(bId);
      if (!recA || !recB) continue;
      const ts = [...tmap.keys()].sort((x, y) => x - y);
      // 連続run検出
      let run = [];
      const flush = () => {
        if (run.length < 20) { run = []; return; }
        const t0 = run[0], t1 = run[run.length - 1];
        const y0A = altAt(recA, t0), y1A = altAt(recA, t1);
        const y0B = altAt(recB, t0), y1B = altAt(recB, t1);
        // perch/見えていない枝の内訳（区間中の多数決）
        let perchA = 0, perchB = 0, nonExactA = 0, nonExactB = 0, n = 0;
        for (const t of run) {
          const es = tmap.get(t) || [];
          for (const e of es) {
            n++;
            if (e.from === aId) { if (e.perch) perchA++; if (!e.exact) nonExactA++; }
            if (e.from === bId) { if (e.perch) perchB++; if (!e.exact) nonExactB++; }
          }
        }
        // 区間終了直後の状況（終わり方の推定）
        const afterT = t1 + 1;
        const aAliveAfter = alt.get(aId) ? altAt(alt.get(aId), afterT) != null : false;
        const bAliveAfter = alt.get(bId) ? altAt(alt.get(bId), afterT) != null : false;
        let reason = '不明';
        if (!aAliveAfter || !bAliveAfter) reason = '片方撃墜(または着陸復帰)';
        else {
          const ceilA = recA.ceiling, ceilB = recB.ceiling;
          const nearCeil = (ceilA && y1A > ceilA * 0.92) || (ceilB && y1B > ceilB * 0.92);
          const stillEngaged = tmap.has(afterT);
          if (nearCeil) reason = '天井で頭打ち';
          else if (!stillEngaged) reason = '指示が変わった';
          else reason = '継続中/撃った';
        }
        segments.push({
          stage: meta.stageName, stageIndex: meta.stageIndex, seed: meta.seed,
          A: recA.name, Aside: recA.side, B: recB.name, Bside: recB.side,
          startSec: t0, endSec: t1, durSec: +(t1 - t0).toFixed(0),
          altA: [Math.round(y0A), Math.round(y1A)], altB: [Math.round(y0B), Math.round(y1B)],
          perchShare: n ? +(((perchA + perchB) / n) * 100).toFixed(0) : 0,
          nonExactShare: n ? +(((nonExactA + nonExactB) / n) * 100).toFixed(0) : 0,
          reason,
        });
        run = [];
      };
      for (let i = 0; i < ts.length; i++) {
        const t = ts[i];
        const yA0 = altAt(recA, t), yA1 = altAt(recA, +(t + 1).toFixed(1));
        const yB0 = altAt(recB, t), yB1 = altAt(recB, +(t + 1).toFixed(1));
        if (yA0 == null || yA1 == null || yB0 == null || yB1 == null) { flush(); continue; }
        const rateA = yA1 - yA0, rateB = yB1 - yB0; // dt=1s なのでそのままm/s
        const contiguous = run.length === 0 || t === run[run.length - 1] + 1;
        if (rateA > 5 && rateB > 5 && contiguous) run.push(t);
        else { flush(); if (rateA > 5 && rateB > 5) run.push(t); }
      }
      flush();
    }

    results.push({
      stageIndex: meta.stageIndex, stageName: meta.stageName, seed: meta.seed,
      segments,
      attackMaxAlt: [...attackMaxAlt.values()],
    });
  }

  async function stage(i, seeds) {
    await ensurePatch();
    stageCtx = { stageIndex: i };
    const before = results.length;
    const summary = await AT.bench.stage(i, 0, { seeds });
    stageCtx = null;
    return { summary, runs: results.length - before };
  }

  function median(arr) {
    if (!arr.length) return null;
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  }

  function report() {
    const byStage = new Map();
    for (const r of results) {
      let g = byStage.get(r.stageIndex);
      if (!g) { g = { stageIndex: r.stageIndex, stageName: r.stageName, runs: 0, segCount: 0, segSec: 0, maxAlts: [], over11k: 0, perchShareAvg: [] }; byStage.set(r.stageIndex, g); }
      g.runs++;
      g.segCount += r.segments.length;
      for (const s of r.segments) { g.segSec += s.durSec; g.perchShareAvg.push(s.perchShare + s.nonExactShare); }
      g.maxAlts.push(...r.attackMaxAlt);
      g.over11k += r.attackMaxAlt.filter((y) => y > 11000).length;
    }
    const rows = [...byStage.values()].sort((a, b) => a.stageIndex - b.stageIndex).map((g) => ({
      stage: g.stageIndex, runs: g.runs, 区間数: g.segCount, 合計秒: g.segSec,
      最高高度中央値: Math.round(median(g.maxAlts) ?? 0), 最高高度最大: Math.round(Math.max(0, ...g.maxAlts)),
      '11000超の機数': g.over11k,
    }));
    console.table(rows);
    return rows;
  }

  window.AT = window.AT || {};
  window.AT.coclimb = { stage, report, results, ensurePatch };
})();
