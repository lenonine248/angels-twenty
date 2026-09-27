// §99 検証用：VERTICAL.pullG を入れたときの地形衝突を1件ずつ調べる道具。
// 各機の直近 ~16秒のリングバッファを持ち、deathCause==='terrain' で死んだ瞬間に
// 履歴を要約して保存する。本体コードは変更しない。
// 使い方（コンソール）：
//   await fetch('/tools/bench.js').then(r=>r.text()).then(eval)
//   await fetch('/tools/_terrainprobe.js').then(r=>r.text()).then(eval)
//   (await import('/js/sim/aircraft.js')).VERTICAL.pullG = 2   // 版を変えるときはページをリロードしてから
//   for (const i of [0,1,2,3,4,5,6,7]) await AT.tprobe.stage(i, [11,22])
//   AT.tprobe.report()      // 集計
//   AT.tprobe.events()      // 1件ずつの詳細（配列）
(function () {
  if (window.AT && window.AT.tprobe) return;

  const HISTORY_SEC = 16;
  let patched = false;
  let curMeta = { stageIndex: null, seed: null };
  let events = [];

  async function ensurePatch() {
    if (patched) return;
    const mod = await import('/js/sim/aircraft.js');
    const proto = mod.Aircraft.prototype;
    const orig = proto.update;
    proto.update = function (dt, world) {
      const wasAlive = this.alive;
      const r = orig.call(this, dt, world);
      if (wasAlive && dt > 0) sampleTick(this, dt, world);
      if (wasAlive && !this.alive && this.deathCause === 'terrain') {
        onTerrainDeath(this, world);
      }
      if (!this.alive) delete this.__tp;
      return r;
    };
    // VERTICAL の pullG を読めるように保持しておく（要約の切り返し距離の計算用）
    window.__tp_VERTICAL = mod.VERTICAL;
    patched = true;
  }

  function sampleTick(u, dt, world) {
    const buf = u.__tp || (u.__tp = []);
    const t = (u.__tp_t = (u.__tp_t || 0) + dt);
    const ground = world && world.terrain
      ? Math.max(0, world.terrain.heightAt(u.pos.x, u.pos.z)) : null;
    let floor = null;
    try { floor = typeof u._terrainFloor === 'function' ? u._terrainFloor(world) : null; } catch (e) { floor = null; }
    buf.push({
      t,
      y: u.pos.y,
      ground,
      floor,
      desiredAlt: u.desiredAlt,
      vs: u.vs,
      speed: u.speed,
      heading: u.heading,
      aiMode: u.aiMode,
      orderType: u.order && u.order.type,
      attackRun: u.attackRun || null,
      threatsN: (u.threats ? u.threats.length : 0),
    });
    while (buf.length > 1 && (buf[buf.length - 1].t - buf[0].t) > HISTORY_SEC) buf.shift();
  }

  function onTerrainDeath(u, world) {
    const buf = (u.__tp || []).slice();
    if (buf.length === 0) return;
    const last = buf[buf.length - 1];
    const deathT = last.t;
    const pullG = window.__tp_VERTICAL ? window.__tp_VERTICAL.pullG : null;
    const aV = pullG != null ? pullG * 9.81 : null;

    // desiredAlt(floor込み) >= ground+200 が死の瞬間まで連続して成り立っていた
    // 区間の開始時刻を、末尾から遡って探す。
    let clearSinceIdx = null;
    for (let i = buf.length - 1; i >= 0; i--) {
      const b = buf[i];
      const ok = b.ground != null && b.desiredAlt >= b.ground + 200;
      if (ok) clearSinceIdx = i; else break;
    }
    let clearInfo = null;
    if (clearSinceIdx != null) {
      const b = buf[clearSinceIdx];
      const ageSec = +(deathT - b.t).toFixed(2);
      const marginAtClear = b.ground != null ? +(b.y - b.ground).toFixed(0) : null;
      const vsAtClear = +b.vs.toFixed(1);
      // 切り返しに必要だった「距離」＝ vs^2/(2a) を高度換算(m)で見る
      const stopNeedM = (aV && vsAtClear < 0) ? +((vsAtClear * vsAtClear) / (2 * aV)).toFixed(0) : null;
      clearInfo = {
        ageSec, atTBeforeDeath: ageSec >= HISTORY_SEC - 0.05 ? `>=${HISTORY_SEC}s(全期間)` : `${ageSec}s前`,
        vsAtClear, marginAtClear, stopNeedM,
      };
    } else {
      clearInfo = { ageSec: null, atTBeforeDeath: '死ぬまで一度もならず', vsAtClear: null, marginAtClear: null, stopNeedM: null };
    }

    // 直近の vs の推移（切り返しの立ち上がり具合を見る）
    const lookbacks = [10, 5, 3, 2, 1, 0.5, 0.2, 0];
    const trace = lookbacks.map((lb) => {
      const targetT = deathT - lb;
      let best = buf[0];
      for (const b of buf) { if (b.t <= targetT) best = b; else break; }
      return {
        lb,
        vs: +best.vs.toFixed(1),
        margin: best.ground != null ? +(best.y - best.ground).toFixed(0) : null,
        desiredAlt: Math.round(best.desiredAlt),
        ground: best.ground != null ? Math.round(best.ground) : null,
      };
    });

    // 分類
    let category;
    const descendingThroughout = trace.filter((r) => r.lb <= 5).every((r) => r.vs < -3);
    const neverClimbedDesired = clearSinceIdx == null; // desiredAlt(床込み)自体が地面+200を上回らなかった
    const climbTooSlow = !neverClimbedDesired && clearInfo.ageSec != null && clearInfo.ageSec > 0.3
      && trace.find((r) => r.lb === 0).vs <= 5 // 死の瞬間もほぼ上昇できていない
      && trace.find((r) => r.lb === 1).vs <= 5;

    if (neverClimbedDesired) {
      category = '目標高度自体が低い';
    } else if (descendingThroughout) {
      category = '降下中の切り返し遅れ';
    } else if (climbTooSlow) {
      category = '上昇の立ち上がり遅れ';
    } else {
      category = 'その他';
    }

    events.push({
      stageIndex: curMeta.stageIndex,
      seed: curMeta.seed,
      side: u.side,
      typeId: u.typeId,
      aiMode: last.aiMode,
      orderType: last.orderType,
      attackRun: last.attackRun,
      threatsN: last.threatsN,
      pullG,
      category,
      deathY: Math.round(last.y),
      deathGround: last.ground != null ? Math.round(last.ground) : null,
      clearInfo,
      trace,
    });
  }

  async function stage(i, seeds) {
    await ensurePatch();
    for (const seed of seeds) {
      curMeta = { stageIndex: i, seed };
      await AT.bench.runOne(i, false, { seed });
    }
    curMeta = { stageIndex: null, seed: null };
  }

  function report() {
    const byCat = new Map();
    for (const e of events) byCat.set(e.category, (byCat.get(e.category) || 0) + 1);
    return {
      total: events.length,
      byCategory: Object.fromEntries([...byCat.entries()].sort((a, b) => b[1] - a[1])),
      bySide: Object.fromEntries(
        [...new Set(events.map((e) => e.side))].map((s) => [s, events.filter((e) => e.side === s).length])
      ),
    };
  }

  function list() {
    return events.map((e) => ({
      stage: e.stageIndex, seed: e.seed, side: e.side, type: e.typeId,
      aiMode: e.aiMode, order: e.orderType, run: e.attackRun, threats: e.threatsN,
      category: e.category,
      clearAge: e.clearInfo.atTBeforeDeath, vsAtClear: e.clearInfo.vsAtClear,
      marginAtClear: e.clearInfo.marginAtClear, stopNeedM: e.clearInfo.stopNeedM,
    }));
  }

  function reset() { events = []; }

  window.AT = window.AT || {};
  window.AT.tprobe = { stage, report, events: () => events, list, reset };
})();
