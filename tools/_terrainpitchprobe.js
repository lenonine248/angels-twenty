// §99 検証用：地形対策あり版(VERTICAL.pullG)を、跳び・地形衝突・ニアミス・deep割合を
// 1本のプローブで同時に測る道具。本体コードは変更しない。
// 「1戦=1回の実行」を保証するため、Aircraft.prototype.update は一度だけ包み、
// 各 stage×seed の組ごとに AT.bench.runOne を1回だけ呼ぶ。
//
// 使い方（コンソール）：
//   await fetch('/tools/bench.js').then(r=>r.text()).then(eval)
//   await fetch('/tools/_terrainpitchprobe.js').then(r=>r.text()).then(eval)
//   (await import('/js/sim/aircraft.js')).VERTICAL.pullG = 3   // 版を変えたらページをリロードしてから
//   for (const i of [0,1,2,3,4,5,6,7]) await AT.tpp.stage(i, [11,22])
//   AT.tpp.report()
//
// deep割合の定義: update() を呼ぶ「前」に、
//   pullG が数値（null でない）かつ state === 'flying' かつ _altFloor != null の刻みを
//   分母(deepEligibleTicks)とし、その中で pos.y < _altFloor - deepBelow(150) の刻みを
//   分子(deepTicks)とする。deepPct = deepTicks/deepEligibleTicks*100。
(function () {
  if (window.AT && window.AT.tpp) return;

  const RAD2DEG = 180 / Math.PI;
  let patched = false;
  let curMeta = { stageIndex: null, seed: null };

  const runs = [];           // 1戦=1要素（bench の戻り値 + 内訳）
  const terrainEvents = [];  // 地形衝突1件ずつ
  const jumps = [];          // 跳び1件ずつ
  const dpitch = { n: 0, over10: 0, over20: 0, over40: 0 };
  let nearMissTicks = 0;
  let airborneTicks = 0;
  let acAirSeconds = 0;
  let deepTicks = 0;
  let deepEligibleTicks = 0;

  async function ensurePatch() {
    if (patched) return;
    const mod = await import('/js/sim/aircraft.js');
    const proto = mod.Aircraft.prototype;
    const orig = proto.update;
    window.__tpp_VERTICAL = mod.VERTICAL;
    proto.update = function (dt, world) {
      const wasAlive = this.alive;
      const wasOnGround = this.onGround;
      const y0 = this.pos.y;

      // --- deep 判定は update の前に（本文の判定と同じ量を使う） ---
      if (wasAlive && dt > 0) {
        const pullG = mod.VERTICAL.pullG;
        if (typeof pullG === 'number' && this.state === 'flying' && this._altFloor != null) {
          deepEligibleTicks++;
          if (this.pos.y < this._altFloor - mod.VERTICAL.deepBelow) deepTicks++;
        }
      }

      const r = orig.call(this, dt, world);

      if (wasAlive && dt > 0) {
        const isOnGround = this.onGround;
        if (!(wasOnGround && isOnGround)) sampleAirTick(this, dt, world, wasOnGround, isOnGround, y0);
        if (!this.alive && this.deathCause === 'terrain') onTerrainDeath(this, world);
      }
      if (!this.alive) { delete this.__tpp_pitch; delete this.__tpp_ring; }
      return r;
    };
    patched = true;
  }

  function sampleAirTick(u, dt, world, wasOnGround, isOnGround, y0) {
    // --- 跳び・dpitch/dt（_pitchprobe と同じ定義） ---
    const pitchDeg = u.pitch * RAD2DEG;
    const vs = (u.pos.y - y0) / dt;
    const prev = u.__tpp_pitch;
    if (prev) {
      let dp = pitchDeg - prev.pitchDeg;
      if (dp > 180) dp -= 360; else if (dp < -180) dp += 360;
      const dpRate = Math.abs(dp) / dt;
      dpitch.n++;
      if (dpRate > 10) dpitch.over10++;
      if (dpRate > 20) dpitch.over20++;
      if (dpRate > 40) dpitch.over40++;
      acAirSeconds += dt;
      if (Math.abs(dp) >= 5) {
        jumps.push({
          deg: +dp.toFixed(1), stageIndex: curMeta.stageIndex, seed: curMeta.seed,
          side: u.side, acName: u.name, aiMode: u.aiMode,
          orderType: u.order ? u.order.type : null,
          threat: !!(u.threats && u.threats.length > 0),
          tossy: !!u.attackRun,
          groundTrans: wasOnGround !== isOnGround,
        });
      }
    }
    u.__tpp_pitch = { pitchDeg, vs };

    // --- ニアミス（地表からの余裕）: 空中にいる刻みだけ ---
    if (!isOnGround && world && world.terrain) {
      const ground = Math.max(0, world.terrain.heightAt(u.pos.x, u.pos.z));
      const margin = u.pos.y - ground;
      airborneTicks++;
      if (margin < 100) nearMissTicks++;
    }

    // --- 地形衝突の履歴リングバッファ(直近16秒) ---
    const buf = u.__tpp_ring || (u.__tpp_ring = []);
    const t = (u.__tpp_t = (u.__tpp_t || 0) + dt);
    let floor = null;
    try { floor = typeof u._terrainFloor === 'function' ? u._terrainFloor(world) : null; } catch (e) { /* noop */ }
    const ground2 = world && world.terrain ? Math.max(0, world.terrain.heightAt(u.pos.x, u.pos.z)) : null;
    buf.push({
      t, y: u.pos.y, ground: ground2, floor, vs, aiMode: u.aiMode,
      orderType: u.order && u.order.type, altFloor: u._altFloor ?? null,
      terrainAvoiding: !!u.terrainAvoiding,
    });
    while (buf.length > 1 && (buf[buf.length - 1].t - buf[0].t) > 16) buf.shift();
  }

  function onTerrainDeath(u, world) {
    const buf = (u.__tpp_ring || []).slice();
    const last = buf[buf.length - 1] || {};
    terrainEvents.push({
      stageIndex: curMeta.stageIndex, seed: curMeta.seed, side: u.side, typeId: u.typeId,
      aiMode: last.aiMode ?? u.aiMode, orderType: last.orderType ?? (u.order && u.order.type),
      vs: last.vs != null ? +last.vs.toFixed(1) : null,
      phase: (last.vs != null && last.vs < -1) ? '降下中' : ((last.vs != null && last.vs > 1) ? '上昇中' : '水平'),
      deathY: Math.round(u.pos.y),
      ground: last.ground != null ? Math.round(last.ground) : null,
      altFloor: last.altFloor != null ? Math.round(last.altFloor) : null,
      vsMinusFloorGap: (last.vs != null && last.altFloor != null)
        ? +(u.pos.y - last.altFloor).toFixed(0) : null,
      terrainAvoiding: last.terrainAvoiding,
    });
  }

  async function stage(i, seeds) {
    await ensurePatch();
    for (const seed of seeds) {
      curMeta = { stageIndex: i, seed };
      const r = await AT.bench.runOne(i, false, { seed });
      runs.push({ stageIndex: i, seed, ...r });
    }
    curMeta = { stageIndex: null, seed: null };
  }

  function pct(n, d) { return d ? +(100 * n / d).toFixed(2) : 0; }

  function report() {
    const n = runs.length;
    const clear = runs.filter((r) => r.state === 'clear').length;
    const kills = runs.reduce((s, r) => s + r.kills, 0);
    const losses = runs.reduce((s, r) => s + r.losses, 0);
    const shots = runs.reduce((s, r) => s + r.shots, 0);
    const hits = runs.reduce((s, r) => s + r.hits, 0);
    return {
      n, clear: `${clear}/${n}`, kills, losses, shots, hits,
      pkPct: pct(hits, shots),
      jumpsPerAcMin: acAirSeconds > 0 ? +(jumps.length / (acAirSeconds / 60)).toFixed(3) : 0,
      jumpsTotal: jumps.length, dpitchN: dpitch.n,
      dpitchOverShare: {
        over10: pct(dpitch.over10, dpitch.n), over20: pct(dpitch.over20, dpitch.n), over40: pct(dpitch.over40, dpitch.n),
      },
      nearMissPct: pct(nearMissTicks, airborneTicks), airborneTicks,
      deepPct: pct(deepTicks, deepEligibleTicks), deepEligibleTicks, deepTicks,
      terrainEventsN: terrainEvents.length,
      terrainBySide: Object.fromEntries(
        [...new Set(terrainEvents.map((e) => e.side))].map((s) => [s, terrainEvents.filter((e) => e.side === s).length])
      ),
    };
  }

  function reset() {
    runs.length = 0; terrainEvents.length = 0; jumps.length = 0;
    dpitch.n = 0; dpitch.over10 = 0; dpitch.over20 = 0; dpitch.over40 = 0;
    nearMissTicks = 0; airborneTicks = 0; acAirSeconds = 0;
    deepTicks = 0; deepEligibleTicks = 0;
  }

  window.AT = window.AT || {};
  window.AT.tpp = {
    stage, report, reset,
    runs: () => runs, terrainEvents: () => terrainEvents, jumps: () => jumps,
  };
})();
