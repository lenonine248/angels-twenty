// 「高度指定なしの attack 指示だと ARM を撃てない」が、プレイヤーの実際の操作の道でも起きるかを測る。
// tools/_samshipprobe.js の幾何（全面海・マップ中央に目標・24km手前から目標へ機首）を流用。ゲーム本体(js/)は変更しない。
//
// 道(path):
//   P1  = setPlayerOrder({type:'attack', target}) だけ（ui/commands.js:312・commandedAlt は null のまま）
//   P2  = P1 + selectedWeapon='ARM' と fireTasks.push({weapon:'ARM', target}) を1件（右クリック1回ぶん・commands.js:308）
//   C   = commandedAlt=7000 を先に入れて P1（チュートリアル w6 の高度指定つき）
//   C2  = commandedAlt=7000 + P2
// 機体(ac): A3_ARM4 / A3_A2G2(ARM×2+AGM×2) / F2_ARM2   出発高度(alt): 3000 / 4500 / 7000
// 目標(tgt): RADAR（黙らない・撃たない）/ SAM（陣地）
// autoWeapons はいじらない（プレイヤー機の既定＝全て自動）。aiMode も生まれたときの既定のまま（cfgの戻り値 aiMode0 に記録）。
//
// 毎秒: combat.fireBlockReason(u, u.order.target)   ＝FLIGHT ROSTER（ui/hud.js:881）
//       combat.fireBlockReason(u, task.target, WEAPONS.ARM, true) ＝射撃指示の待たされ理由（hud.js:557）
//   を、目標までの水平距離が22km以内のあいだ数える。
//
// 読み込み（親ページ。先に _tut_harness.js を読む必要は無い。iframe側に自分で読ませる）:
//   await fetch('/tools/_armaltprobe.js').then(r => r.text()).then(eval);
//   window.__aaDrive({chunk:60}).then(r => window.__aaDriveResult = r);  // fire-and-forget
//   window.__aaProgress / window.__aaRuns / window.__aaAgg()
(() => {
  const DT = 1 / 30, DEG = Math.PI / 180;
  const MAX_T = 300;
  const D_START = 24000;
  const C = { x: 25600, z: 25600 };
  const TERRAIN = { seed: 91001, mountainAmount: 0, coast: 'none', valleyDepth: 0, rivers: 0, baseAltitude: -1500 };
  const ACS = {
    A3_ARM4: { type: 'A-3', lo: ['ARM', 'ARM', 'ARM', 'ARM'] },
    A3_A2G2: { type: 'A-3', lo: ['ARM', 'ARM', 'AGM', 'AGM'] },
    F2_ARM2: { type: 'F-2', lo: ['ARM', 'ARM'] },
  };
  const PATHS = ['P1', 'P2', 'C', 'C2'];   // opts.olds=[false,true] で変更前/後（既定は後だけ）
  const round = (x, d = 0) => { const k = 10 ** d; return x == null || !Number.isFinite(x) ? null : Math.round(x * k) / k; };
  const off = (p, d, ang) => ({ x: p.x + d * Math.sin(ang), z: p.z - d * Math.cos(ang) });

  function buildScenario(id, cfg, brg) {
    const start = off(C, -D_START, brg);
    const a = ACS[cfg.ac];
    return {
      id, group: '計測', name: 'ARMALT PROBE', title: '計測用（非表示）', battleSeed: cfg.seed >>> 0,
      brief: '計測用', hint: '', terrain: { ...TERRAIN }, weaponPoints: 99, noFail: true,
      friendly: {
        base: { x: 3000, z: 3000 }, startAirborne: true, startAlt: cfg.alt,
        aircraft: [{ type: a.type, name: 'ATK', x: round(start.x, 1), z: round(start.z, 1), loadout: a.lo.slice() }],
      },
      enemy: { skill: 0.6, aircraft: [], ground: [{ type: cfg.tgt.replace('_NS', ''), name: 'TGT', x: C.x, z: C.z, known: true }] },
      steps: [{ text: '(計測用ダミー手順)', check: () => false }],
    };
  }

  const norm = (s) => (s == null ? '(理由なし=撃てる)' : String(s).replace(/[0-9.]+/g, '#').trim());

  window.__aaOne = async (cfg) => {
    const brg = cfg.k * 60 * DEG;
    const id = 'aa_probe';
    const i0 = AT.tutorials.findIndex((t) => t.id === id);
    if (i0 >= 0) AT.tutorials.splice(i0, 1);
    AT.tutorials.push(buildScenario(id, cfg, brg));
    await __open(id);
    const world = AT.battle.world;
    const wm = await import('/js/data/weapons.js');
    // ARM の高度段（sim/aircraft.js の _armUsableOn）。cfg.old なら常に偽＝変更前と同じ道。新しい側は真を返した回数を数える
    const am = await import('/js/sim/aircraft.js');
    const proto = am.Aircraft.prototype;
    if (!proto.__origArm) proto.__origArm = proto._armUsableOn;
    let trues = 0;
    proto._armUsableOn = cfg.old ? () => false : function (t) { const r = proto.__origArm.call(this, t); if (r) trues++; return r; };
    const u = world.units.find((x) => x.kind === 'aircraft' && x.side === world.playerSide);
    const tg = world.units.find((x) => x.side !== world.playerSide && x.spec && x.kind !== 'aircraft');
    if (cfg.tgt.includes('_NS')) for (const m of tg.mounts) if (m.w.kind === 'sam') m.ammo = 0;   // _NS = SAM弾数0（SAMSHIP_NS: HP380でARM×2では残る＝AGMが要る）
    const aiMode0 = u.aiMode;
    u.heading = brg;

    // ---- 操作の道（チュートリアル w6 の順: 高度指定 → 攻撃指示 → 兵装選択 → 射撃指示）
    if (cfg.path === 'C' || cfg.path === 'C2') {          // 高度指定（ui/commands.js の setAltitude と同じ。攻撃指示より先）
      if (u.order) u.order.alt = 7000;
      u.desiredAlt = 7000; u.commandedAlt = 7000;
    }
    u.setPlayerOrder({ type: 'attack', target: tg });
    if (cfg.path === 'P2' || cfg.path === 'C2') {
      u.selectedWeapon = 'ARM';
      u.fireTasks.push({ weapon: 'ARM', target: tg });     // 右クリック1回ぶん（commands.js:308）
    }
    const gun0 = u.gun;

    const rec = {
      fired: 0, fireD: [], fireAlt: [], fireT: [],
      below2500T: null, below2500D: null, altAt: {}, minAlt: Infinity, minD: Infinity,
      why1: {}, why2: {}, ordSec: {}, sec22: 0,
      agm: 0, agmD: [], agmAlt: [], maxAlt: 0, lastArmT: null, altAfterSpent: null, minAltAfterSpent: Infinity,
    };
    world.onFire = (sh, t, w) => {
      if (sh === u && w.id === 'AGM') { rec.agm++; rec.agmD.push(Math.hypot(t.pos.x - u.pos.x, t.pos.z - u.pos.z) / 1000); rec.agmAlt.push(u.pos.y); }
      if (sh === u && w.id === 'ARM') {
        rec.lastArmT = tick * DT;
        rec.fired++; rec.fireD.push(Math.hypot(t.pos.x - u.pos.x, t.pos.z - u.pos.z) / 1000);
        rec.fireAlt.push(u.pos.y); rec.fireT.push(tick * DT);
      }
    };
    world.onMissileHit = null;
    let tick = 0, killT = null, deadAt = null, endReason = 'maxT';
    const marks = [22000, 20000, 15000, 10000, 5000];
    const done = new Set();
    for (; tick < Math.round(MAX_T / DT); tick++) {
      AT.loop.onFixedUpdate(DT); AT.loop.simTime += DT;
      const t = (tick + 1) * DT;
      if (u.alive) {
        const flat = Math.hypot(tg.pos.x - u.pos.x, tg.pos.z - u.pos.z);
        if (flat < rec.minD) rec.minD = flat;
        if (u.pos.y < rec.minAlt) rec.minAlt = u.pos.y;
        if (u.pos.y > rec.maxAlt) rec.maxAlt = u.pos.y;
        if (rec.lastArmT != null && !u.loadout.includes('ARM')) { if (rec.altAfterSpent == null && t - rec.lastArmT >= 20) rec.altAfterSpent = u.pos.y; if (t - rec.lastArmT >= 20 && u.pos.y < rec.minAltAfterSpent) rec.minAltAfterSpent = u.pos.y; }
        if (rec.below2500T == null && u.pos.y < 2500) { rec.below2500T = round(t, 1); rec.below2500D = round(flat / 1000, 1); }
        for (const m of marks) if (!done.has(m) && flat <= m) { done.add(m); rec.altAt[m / 1000] = round(u.pos.y); }
        if (tick % 30 === 29) {
          const ot = u.order ? u.order.type : 'none';
          rec.ordSec[ot] = (rec.ordSec[ot] || 0) + 1;
          if (flat <= 22000 && tg.alive) {
            rec.sec22++;
            let r1 = null;
            if (u.order && u.order.type === 'attack' && u.order.target && u.order.target.alive) r1 = world.combat.fireBlockReason(u, u.order.target);
            else r1 = '(攻撃指示なし)';
            const k1 = norm(r1); rec.why1[k1] = (rec.why1[k1] || 0) + 1;
            if (cfg.path === 'P2' || cfg.path === 'C2') {
              const task = (u.fireTasks || []).find((x) => x.target && x.target.alive);
              const k2 = task ? norm(world.combat.fireBlockReason(u, task.target, wm.WEAPONS[task.weapon], true)) : '(射撃指示なし)';
              rec.why2[k2] = (rec.why2[k2] || 0) + 1;
            }
          }
        }
      }
      if (!tg.alive && killT == null) killT = t;
      if (killT != null && t - killT > 5) { endReason = 'killed'; break; }
      if (!u.alive) {
        if (deadAt == null) deadAt = t;
        if (t - deadAt > 30) { endReason = 'dead'; break; }
      }
    }
    world.onFire = null;
    proto._armUsableOn = proto.__origArm;
    let cause = null;
    if (!u.alive) cause = u.deathCause || (u.lastHit && u.lastHit.weapon === 'SAM-M' ? 'sam' : u.lastHit && u.lastHit.weapon === 'GUN' ? 'gun' : 'other');
    const mean = (a) => (a.length ? round(a.reduce((s, x) => s + x, 0) / a.length, 1) : null);
    return {
      cfg, trues, agm: rec.agm, agmD: mean(rec.agmD), agmAlt: mean(rec.agmAlt), maxAlt: round(rec.maxAlt), altAfterSpent: round(rec.altAfterSpent), minAltAfterSpent: Number.isFinite(rec.minAltAfterSpent) ? round(rec.minAltAfterSpent) : null, aiMode0, autoW: JSON.stringify(u.autoWeapons),
      fired: rec.fired, fireD: mean(rec.fireD), fireAlt: mean(rec.fireAlt), fireT: rec.fireT.length ? round(rec.fireT[0], 1) : null,
      below2500T: rec.below2500T, below2500D: rec.below2500D, altAt: rec.altAt, minAlt: round(rec.minAlt), minD: round(rec.minD),
      killed: !tg.alive, killT: killT != null ? round(killT, 1) : null, alive: u.alive, cause, deathT: deadAt != null ? round(deadAt, 1) : null,
      sec22: rec.sec22, why1: rec.why1, why2: rec.why2, ordSec: rec.ordSec,
      endOrder: u.order ? u.order.type : null, endMode: u.aiMode, gunUsed: gun0 - u.gun, ordLeft: u.loadout.filter((w) => w === 'ARM' || w === 'AGM').length,
      tasksLeft: (u.fireTasks || []).length, endT: round(tick * DT, 1), endReason,
    };
  };

  window.__aaRuns = window.__aaRuns || [];
  window.__aaDrive = async (opts = {}) => {
    const acs = opts.acs || Object.keys(ACS), alts = opts.alts || [3000, 4500, 7000];
    const tgts = opts.tgts || ['RADAR', 'SAM'], paths = opts.paths || PATHS;
    const ks = opts.ks || [0, 1, 2, 3, 4, 5], seeds = opts.seeds || [0x5A2001];
    const chunk = opts.chunk || 60;
    const list = [];
    for (const old of (opts.olds || [false])) for (const path of paths) for (const ac of acs) for (const alt of alts) for (const tgt of tgts) for (const k of ks) for (const seed of seeds) list.push({ path, ac, alt, tgt, k, seed, old });
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const harness = await fetch('/tools/_tut_harness.js').then((r) => r.text());
    const probe = await fetch('/tools/_armaltprobe.js').then((r) => r.text());
    window.__aaProgress = { done: 0, total: list.length, t0: performance.now(), err: null };
    for (let s = 0; s < list.length; s += chunk) {
      const fr = document.createElement('iframe');
      fr.src = '/'; fr.style.cssText = 'position:fixed;left:0;top:0;width:640px;height:400px;border:0;';
      document.body.appendChild(fr);
      let ready = false;
      for (let i = 0; i < 600 && !ready; i++) { await sleep(100); try { ready = !!fr.contentWindow.AT_READY && !!fr.contentWindow.AT; } catch (e) { /* 読込中 */ } }
      if (!ready) { window.__aaProgress.err = 'iframe not ready'; fr.remove(); break; }
      fr.contentWindow.eval(harness); fr.contentWindow.eval(probe);
      for (const cfg of list.slice(s, s + chunk)) {
        try { window.__aaRuns.push(JSON.parse(JSON.stringify(await fr.contentWindow.__aaOne(cfg)))); }
        catch (e) { window.__aaProgress.err = `${cfg.path}/${cfg.ac}: ${String((e && e.stack) || e).slice(0, 300)}`; window.__aaRuns.push({ cfg, error: true }); }
        window.__aaProgress.done++;
      }
      fr.src = 'about:blank'; await sleep(300); fr.remove(); await sleep(2500);
    }
    window.__aaProgress.sec = round((performance.now() - window.__aaProgress.t0) / 1000);
    return window.__aaProgress;
  };
})();
