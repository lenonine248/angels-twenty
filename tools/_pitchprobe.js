// 機首角(pitch)の変化率・跳びを計測するプローブ。本体コードは一切変更しない。
// 使い方（コンソール）:
//   await fetch('/tools/bench.js').then(r=>r.text()).then(eval)
//   await fetch('/tools/_pitchprobe.js').then(r=>r.text()).then(eval)
//   for (let i=0;i<8;i++) await AT.pitchprobe.stage(i, [11])
//   AT.pitchprobe.report()     // 集計（生ログは AT.pitchprobe._state に残る）
//   AT.pitchprobe.reset()      // 集計をリセット（同一ページで版Bを測る前に呼ぶ）
//
// A/B で「pitchを平滑化したら跳びは減るか」を測りたいときは setVariant() で
// 変換関数を差し込む（本体の this.pitch を実際に書き換えるので、combat.js/
// missile.js/bullet.js の照準計算にも効く＝見た目だけでなく命中率への影響も測れる）:
//   AT.pitchprobe.setVariant({
//     maxRateDeg: 25,   // 1秒あたりの機首角変化を最大25度に制限する簡易版
//   })
//   AT.pitchprobe.reset()
//   for (let i=0;i<8;i++) await AT.pitchprobe.stage(i, [11])
//
// 仕組み: Aircraft.prototype.update を import() 経由で同一モジュールインスタンスに
// 対して包む。onGround（parked/servicing/ready/takeoff/着陸滑走）から外れている
// 刻み（＝空中にいる、または離着陸の境目の刻み）だけを対象に、
// 呼び出し前後の pitch・pos.y から dpitch/dt（deg/s）と vs=(dy/dt) を毎刻み計算する。
// 完全に地上にいた刻みでは前回値を破棄する（滑走中の長い空白を「1刻みの跳び」と
// 誤検出しないため）。
(function () {
  if (window.AT && window.AT.pitchprobe) return; // 二重読み込み防止

  const RAD2DEG = 180 / Math.PI;
  const G = 9.81;

  let patched = false;
  let variant = null; // { maxRateDeg?: number, transform?: (rawPitchRad, prevPitchDeg, dt, u) => pitchRad }
  let stageCtx = null;

  function freshState() {
    return {
      runs: [], // { stageIndex, seeds, summary }
      dtSet: new Set(),
      dpitch: { n: 0, sum: 0, over10: 0, over20: 0, over40: 0 },
      dvs: { n: 0, over1g: 0, over2g: 0, over3g: 0, over5g: 0, max: 0 },
      dvsLandTakeoff: { n: 0, over1g: 0, over2g: 0, over3g: 0, over5g: 0, max: 0 },
      jumps: [], // { deg, state, aiMode, orderType, threat, altJump, tossy, floorGap, groundTrans, stageIndex, seed, acName }
      acAirSeconds: 0,
      climbPitchDeg: [],
      descPitchDeg: [],
    };
  }
  let state = freshState();

  async function ensurePatch() {
    if (patched) return;
    const aircraftMod = await import('/js/sim/aircraft.js');
    const proto = aircraftMod.Aircraft.prototype;
    const origUpdate = proto.update;
    proto.update = function (dt, world) {
      const wasOnGround = this.onGround;
      const y0 = this.pos.y;
      const desiredAlt0 = this.desiredAlt;
      const r = origUpdate.call(this, dt, world);
      if (!this.alive) { delete this.__pp; return r; }

      const isOnGround = this.onGround;
      if (wasOnGround && isOnGround) { delete this.__pp; return r; } // 完全に地上：計測対象外・前回値を捨てる

      // 変種フック（差し込まれていれば pitch そのものを書き換える）
      if (variant && (variant.transform || variant.maxRateDeg != null)) {
        const prev = this.__pp;
        let newPitch = this.pitch;
        if (variant.transform) {
          newPitch = variant.transform(this.pitch, prev ? prev.pitchDeg : null, dt, this);
        } else if (variant.maxRateDeg != null && prev) {
          const maxStep = variant.maxRateDeg * dt * (Math.PI / 180);
          const raw = this.pitch;
          let d = raw - (prev.pitchDeg * Math.PI / 180);
          if (d > maxStep) d = maxStep; else if (d < -maxStep) d = -maxStep;
          newPitch = (prev.pitchDeg * Math.PI / 180) + d;
        }
        this.pitch = newPitch;
      }

      sampleTick(this, dt, y0, desiredAlt0, wasOnGround, isOnGround, world);
      return r;
    };
    patched = true;
  }

  function sampleTick(u, dt, y0, desiredAlt0, wasOnGround, isOnGround, world) {
    if (dt <= 0) return;
    state.dtSet.add(+dt.toFixed(6));
    const pitchDeg = u.pitch * RAD2DEG;
    const vs = (u.pos.y - y0) / dt;
    const prev = u.__pp;

    if (prev) {
      let dp = pitchDeg - prev.pitchDeg;
      if (dp > 180) dp -= 360; else if (dp < -180) dp += 360;
      const dpRate = Math.abs(dp) / dt; // deg/s
      state.dpitch.n++; state.dpitch.sum += dpRate;
      if (dpRate > 10) state.dpitch.over10++;
      if (dpRate > 20) state.dpitch.over20++;
      if (dpRate > 40) state.dpitch.over40++;

      const dvsRate = (vs - prev.vs) / dt; // m/s^2
      const gAbs = Math.abs(dvsRate) / G;
      const bucket = (u.state === 'landing' || u.state === 'takeoff') ? state.dvsLandTakeoff : state.dvs;
      bucket.n++;
      if (gAbs > 1) bucket.over1g++;
      if (gAbs > 2) bucket.over2g++;
      if (gAbs > 3) bucket.over3g++;
      if (gAbs > 5) bucket.over5g++;
      if (gAbs > bucket.max) bucket.max = gAbs;

      state.acAirSeconds += dt;

      if (Math.abs(dp) >= 5) {
        const threat = !!(u.threats && u.threats.length > 0);
        const altJump = Math.abs((u.desiredAlt ?? 0) - (desiredAlt0 ?? 0)) >= 200;
        const tossy = !!u.attackRun; // トス/掃射の run.phase 中
        let floorGap = null;
        try {
          if (typeof u._terrainFloor === 'function' && world) {
            floorGap = Math.round(u.pos.y - u._terrainFloor(world, u.heading));
          }
        } catch (e) { /* 計測失敗は無視 */ }
        state.jumps.push({
          deg: +dp.toFixed(1),
          state: u.state, aiMode: u.aiMode,
          orderType: u.order ? u.order.type : null,
          threat, altJump, tossy, floorGap,
          groundTrans: wasOnGround !== isOnGround,
          stageIndex: stageCtx ? stageCtx.stageIndex : null,
          seed: (window.AT && AT.battle) ? AT.battle.seed : null,
          acName: u.name,
        });
      } else if (u.state === 'flying' && !wasOnGround && !isOnGround) {
        if (vs > 5) state.climbPitchDeg.push(Math.abs(pitchDeg));
        else if (vs < -5) state.descPitchDeg.push(Math.abs(pitchDeg));
      }
    }
    u.__pp = { pitchDeg, vs, desiredAlt: u.desiredAlt };
  }

  async function stage(i, seeds) {
    await ensurePatch();
    stageCtx = { stageIndex: i };
    const summary = await AT.bench.stage(i, 0, { seeds });
    stageCtx = null;
    state.runs.push({ stageIndex: i, seeds, summary });
    return summary;
  }

  function pct(n, d) { return d ? +(100 * n / d).toFixed(2) : 0; }
  function median(a) { if (!a || !a.length) return null; const s = [...a].sort((x, y) => x - y); return +s[Math.floor(s.length / 2)].toFixed(1); }

  function reasonOf(e) {
    if (e.groundTrans) return '状態遷移(離着陸)';
    if (e.tossy) return 'トス/掃射中';
    if (e.threat) return '回避中';
    if (e.altJump) return '指示高度の段差';
    if (e.floorGap != null && e.floorGap < 60) return '地形の床';
    return 'その他(定常飛行中)';
  }

  function report() {
    const j = state.jumps;
    const total = j.length;
    const perAcMin = state.acAirSeconds > 0 ? +(total / (state.acAirSeconds / 60)).toFixed(3) : 0;

    const byReason = new Map();
    for (const e of j) {
      const r = reasonOf(e);
      let g = byReason.get(r);
      if (!g) { g = { reason: r, n: 0, degs: [] }; byReason.set(r, g); }
      g.n++; g.degs.push(Math.abs(e.deg));
    }
    const reasonRows = [...byReason.values()].sort((a, b) => b.n - a.n).map((g) => ({
      reason: g.reason, n: g.n, share: pct(g.n, total),
      medianDeg: median(g.degs), maxDeg: +Math.max(...g.degs).toFixed(1),
    }));

    return {
      dtObserved: [...state.dtSet],
      airborneTicks: state.dpitch.n,
      acAirSeconds: +state.acAirSeconds.toFixed(1),
      dpitchOverShare: {
        over10degPerSec: pct(state.dpitch.over10, state.dpitch.n),
        over20degPerSec: pct(state.dpitch.over20, state.dpitch.n),
        over40degPerSec: pct(state.dpitch.over40, state.dpitch.n),
      },
      dvsG: {
        over1g: pct(state.dvs.over1g, state.dvs.n),
        over2g: pct(state.dvs.over2g, state.dvs.n),
        over3g: pct(state.dvs.over3g, state.dvs.n),
        over5g: pct(state.dvs.over5g, state.dvs.n),
        maxG: +state.dvs.max.toFixed(2),
        n: state.dvs.n,
      },
      dvsG_landTakeoffOnly: {
        over1g: pct(state.dvsLandTakeoff.over1g, state.dvsLandTakeoff.n),
        maxG: +state.dvsLandTakeoff.max.toFixed(2),
        n: state.dvsLandTakeoff.n,
      },
      jumpsTotal: total,
      jumpsPerAcMin: perAcMin,
      jumpReasons: reasonRows,
      climbPitchMedianDeg: median(state.climbPitchDeg),
      descPitchMedianDeg: median(state.descPitchDeg),
      runs: state.runs.map((r) => ({ stage: r.stageIndex, seeds: r.seeds, summary: r.summary })),
    };
  }

  function reset() { state = freshState(); }
  function setVariant(v) { variant = v; }

  window.AT = window.AT || {};
  window.AT.pitchprobe = { stage, report, reset, setVariant };
  Object.defineProperty(window.AT.pitchprobe, '_state', { get: () => state });
})();
