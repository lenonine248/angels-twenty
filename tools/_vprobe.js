// §99 検証用：垂直加速度上限（VERTICAL.pullG）の A/B 用の追加計測。
// _pitchprobe.js の跳び/dpitch 計測に加えて、結末（死因・面ごとの勝敗）と
// ニアミス（地表から100m未満）、ミサイル発射/命中の合計を集める。
// 本体コードは変更しない。使い方はコンソールで：
//   await fetch('/tools/bench.js').then(r=>r.text()).then(eval)
//   await fetch('/tools/_vprobe.js').then(r=>r.text()).then(eval)
//   (await import('/js/sim/aircraft.js')).VERTICAL.pullG = 3   // または null/5/2
//   for (let i=0;i<8;i++) await AT.vprobe.stage(i, [11,22])
//   AT.vprobe.report()
(function () {
  if (window.AT && window.AT.vprobe) return;

  const RAD2DEG = 180 / Math.PI;
  let patched = false;
  let state = fresh();

  function fresh() {
    return {
      dpitch: { n: 0, over10: 0, over20: 0, over40: 0 },
      jumps: { n: 0, acAirSeconds: 0, byReason: new Map() },
      nearMiss: { flyingTicks: 0, under100: 0 },
      climbPitchDeg: [],
      descPitchDeg: [],
      deaths: { blue: new Map(), red: new Map() },
      runs: [], // { stageIndex, seeds, rows }
    };
  }

  async function ensurePatch() {
    if (patched) return;
    const mod = await import('/js/sim/aircraft.js');
    const proto = mod.Aircraft.prototype;
    const orig = proto.update;
    proto.update = function (dt, world) {
      const wasOnGround = this.onGround;
      const y0 = this.pos.y;
      const desiredAlt0 = this.desiredAlt;
      const wasAlive = this.alive;
      const r = orig.call(this, dt, world);

      if (!this.alive) {
        if (wasAlive) {
          const side = this.side;
          const cause = this.deathCause || '被弾';
          const m = state.deaths[side] || (state.deaths[side] = new Map());
          m.set(cause, (m.get(cause) || 0) + 1);
        }
        delete this.__vp;
        return r;
      }
      if (wasOnGround && this.onGround) { delete this.__vp; return r; }

      sampleTick(this, dt, y0, desiredAlt0, wasOnGround, world);
      return r;
    };
    patched = true;
  }

  function sampleTick(u, dt, y0, desiredAlt0, wasOnGround, world) {
    if (dt <= 0) return;
    const pitchDeg = u.pitch * RAD2DEG;
    const vs = (u.pos.y - y0) / dt;
    const prev = u.__vp;

    // ニアミス：飛行中(state==='flying')のみ。着陸進入(landing)・離陸(takeoff)は除く
    if (u.state === 'flying' && !wasOnGround && !u.onGround && world && world.terrain) {
      const gap = u.pos.y - world.terrain.heightAt(u.pos.x, u.pos.z);
      state.nearMiss.flyingTicks++;
      if (gap < 100) state.nearMiss.under100++;
    }

    if (prev) {
      let dp = pitchDeg - prev.pitchDeg;
      if (dp > 180) dp -= 360; else if (dp < -180) dp += 360;
      const rate = Math.abs(dp) / dt;
      state.dpitch.n++;
      if (rate > 10) state.dpitch.over10++;
      if (rate > 20) state.dpitch.over20++;
      if (rate > 40) state.dpitch.over40++;
      state.jumps.acAirSeconds += dt;

      if (Math.abs(dp) >= 5) {
        state.jumps.n++;
        const threat = !!(u.threats && u.threats.length > 0);
        const altJump = Math.abs((u.desiredAlt ?? 0) - (desiredAlt0 ?? 0)) >= 200;
        const tossy = !!u.attackRun;
        const reason = tossy ? 'トス/掃射中' : threat ? '回避中' : altJump ? '指示高度の段差' : 'その他(定常飛行中)';
        state.jumps.byReason.set(reason, (state.jumps.byReason.get(reason) || 0) + 1);
      } else if (u.state === 'flying' && !wasOnGround && !u.onGround) {
        if (vs > 5) state.climbPitchDeg.push(Math.abs(pitchDeg));
        else if (vs < -5) state.descPitchDeg.push(Math.abs(pitchDeg));
      }
    }
    u.__vp = { pitchDeg, vs, desiredAlt: u.desiredAlt };
  }

  async function stage(i, seeds) {
    await ensurePatch();
    const rows = [];
    for (const seed of seeds) {
      const r = await AT.bench.runOne(i, false, { seed });
      rows.push(r);
    }
    state.runs.push({ stageIndex: i, seeds, rows });
    return rows;
  }

  function pct(n, d) { return d ? +(100 * n / d).toFixed(2) : 0; }
  function median(a) { if (!a || !a.length) return null; const s = [...a].sort((x, y) => x - y); return +s[Math.floor(s.length / 2)].toFixed(1); }
  function sum(rows, f) { return rows.reduce((s, r) => s + f(r), 0); }

  function report() {
    const total = state.jumps.n;
    const perAcMin = state.jumps.acAirSeconds > 0 ? +(total / (state.jumps.acAirSeconds / 60)).toFixed(3) : 0;
    const reasonRows = [...state.jumps.byReason.entries()].sort((a, b) => b[1] - a[1])
      .map(([reason, n]) => ({ reason, n, share: pct(n, total) }));

    const allRows = state.runs.flatMap((r) => r.rows.map((row) => ({ ...row, stageIndex: r.stageIndex })));
    const byStage = new Map();
    for (const r of allRows) {
      let g = byStage.get(r.stageIndex);
      if (!g) { g = { stage: r.stageIndex, n: 0, clear: 0, kills: 0, losses: 0 }; byStage.set(r.stageIndex, g); }
      g.n++;
      if (r.state === 'clear') g.clear++;
      g.kills += r.kills; g.losses += r.losses;
    }
    const stageRows = [...byStage.values()].sort((a, b) => a.stage - b.stage);

    return {
      dtObserved: null,
      airborneTicks: state.dpitch.n,
      acAirSeconds: +state.jumps.acAirSeconds.toFixed(1),
      dpitchOverShare: {
        over10degPerSec: pct(state.dpitch.over10, state.dpitch.n),
        over20degPerSec: pct(state.dpitch.over20, state.dpitch.n),
        over40degPerSec: pct(state.dpitch.over40, state.dpitch.n),
      },
      jumpsTotal: total,
      jumpsPerAcMin: perAcMin,
      jumpReasons: reasonRows,
      climbPitchMedianDeg: median(state.climbPitchDeg),
      descPitchMedianDeg: median(state.descPitchDeg),
      nearMiss: {
        flyingTicks: state.nearMiss.flyingTicks,
        under100mShare: pct(state.nearMiss.under100, state.nearMiss.flyingTicks),
      },
      totals: {
        battles: allRows.length,
        clear: allRows.filter((r) => r.state === 'clear').length,
        losses: sum(allRows, (r) => r.losses),
        kills: sum(allRows, (r) => r.kills),
        shots: sum(allRows, (r) => r.shots),
        hits: sum(allRows, (r) => r.hits),
        pk: sum(allRows, (r) => r.shots) ? +(sum(allRows, (r) => r.hits) / sum(allRows, (r) => r.shots)).toFixed(3) : null,
      },
      byStage: stageRows,
      deathCauses: {
        blue: Object.fromEntries(state.deaths.blue || []),
        red: Object.fromEntries(state.deaths.red || []),
      },
    };
  }

  function reset() { state = fresh(); }

  window.AT = window.AT || {};
  window.AT.vprobe = { stage, report, reset };
  Object.defineProperty(window.AT.vprobe, '_state', { get: () => state });
})();
