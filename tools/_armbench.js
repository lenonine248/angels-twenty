// ARM の高度段（sim/aircraft.js の _armUsableOn・§106.5）の A/B ベンチ。ゲーム本体(js/)は変更しない。
// 変更前 = Aircraft.prototype._armUsableOn を () => false に差し替えた道。変更後 = 本体のまま（真を返した回数を数える）。
// 手順は docs/STATUS.md のバランス検証: 種は 11 の倍数の18種 S11、面 0..7、AT.bench.runOne を1戦ずつ呼ぶ（stage() は要約しか返さないため）。
// 約190戦で main.js の buildBattle がメモリ不足になるので、(面×条件) ごとに iframe を使い捨てる。
//
// 親ページ（アプリを開いたタブ）で:
//   await fetch('/tools/_armbench.js').then(r => r.text()).then(eval);
//   window.__abDrive({stages:[0,1,2,3,4,5,6,7]}).then(r => window.__abDriveResult = r);   // fire-and-forget
//   window.__abProgress / window.__abRows（1戦1行）/ window.__abSummary()
(() => {
  const S11 = Array.from({ length: 18 }, (_, k) => 11 * (k + 1));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const round = (x, d = 0) => { const k = 10 ** d; return x == null || !Number.isFinite(x) ? null : Math.round(x * k) / k; };

  // iframe の中で走る本体。文字列にして eval させるため、関数を toString() で渡す
  async function inFrame(stageIndex, old, seeds) {
    const am = await import('/js/sim/aircraft.js');
    const cm = await import('/js/sim/combat.js');
    const proto = am.Aircraft.prototype;
    if (!proto.__origArm) proto.__origArm = proto._armUsableOn;
    const cnt = { trues: { player: 0, ally: 0, red: 0 }, arm: { player: 0, ally: 0, red: 0 } };
    const grp = (u) => (u.side === 'red' ? 'red' : (u.owner === 'ally' ? 'ally' : 'player'));
    proto._armUsableOn = old ? () => false : function (t) {
      const r = proto.__origArm.call(this, t);
      if (r) cnt.trues[grp(this)]++;
      return r;
    };
    const cp = cm.CombatSystem.prototype;
    if (!cp.__origFire) cp.__origFire = cp.fire;
    cp.fire = function (shooter, target, weapon) {
      if (weapon && weapon.id === 'ARM') cnt.arm[grp(shooter)]++;
      return cp.__origFire.call(this, shooter, target, weapon);
    };
    const out = [];
    for (const seed of seeds) {
      cnt.trues = { player: 0, ally: 0, red: 0 }; cnt.arm = { player: 0, ally: 0, red: 0 };
      const r = await AT.bench.runOne(stageIndex, false, { seed });
      out.push({
        stageIndex, stage: r.stage, seed, old, state: r.state, sec: r.sec, losses: r.losses, allyLosses: r.allyLosses,
        kills: r.kills, shots: r.shots, reason: r.reason,
        trues: { ...cnt.trues }, arm: { ...cnt.arm },
      });
    }
    return out;
  }

  window.__abRows = window.__abRows || [];
  window.__abDrive = async (opts = {}) => {
    const stages = opts.stages || [0, 1, 2, 3, 4, 5, 6, 7], seeds = opts.seeds || S11;
    const conds = opts.conds || [true, false];          // old=true が変更前
    const bench = await fetch('/tools/bench.js').then((r) => r.text());
    const harnessFn = inFrame.toString();
    const list = [];
    for (const st of stages) for (const old of conds) list.push({ st, old });
    window.__abProgress = { done: 0, total: list.length, err: null, t0: performance.now() };
    for (const { st, old } of list) {
      const fr = document.createElement('iframe');
      fr.src = '/'; fr.style.cssText = 'position:fixed;left:0;top:0;width:640px;height:400px;border:0;';
      document.body.appendChild(fr);
      let ready = false;
      for (let i = 0; i < 600 && !ready; i++) { await sleep(100); try { ready = !!fr.contentWindow.AT_READY && !!fr.contentWindow.AT; } catch (e) { /* 読込中 */ } }
      if (!ready) { window.__abProgress.err = 'iframe not ready'; fr.remove(); break; }
      try {
        fr.contentWindow.eval(bench);
        fr.contentWindow.eval(`window.__abInFrame = ${harnessFn}`);
        const rows = await fr.contentWindow.__abInFrame(st, old, seeds);
        for (const r of rows) window.__abRows.push(JSON.parse(JSON.stringify(r)));
      } catch (e) {
        window.__abProgress.err = `st${st} old=${old}: ${String((e && e.stack) || e).slice(0, 300)}`;
      }
      fr.src = 'about:blank'; await sleep(300); fr.remove(); await sleep(2500);
      window.__abProgress.done++;
    }
    window.__abProgress.sec = round((performance.now() - window.__abProgress.t0) / 1000);
    return window.__abProgress;
  };

  // 面×条件の集計と、1戦ごとの突き合わせ
  window.__abSummary = () => {
    const rows = window.__abRows;
    const stages = [...new Set(rows.map((r) => r.stageIndex))].sort((a, b) => a - b);
    const sum = (a) => a.reduce((s, x) => s + x, 0);
    const per = stages.map((st) => {
      const o = {};
      for (const old of [true, false]) {
        const rs = rows.filter((r) => r.stageIndex === st && r.old === old);
        o[old ? 'before' : 'after'] = {
          n: rs.length, clear: rs.filter((r) => r.state === 'clear').length, loss: sum(rs.map((r) => r.losses)),
          armP: sum(rs.map((r) => r.arm.player)), armA: sum(rs.map((r) => r.arm.ally)), armR: sum(rs.map((r) => r.arm.red)),
          trueP: sum(rs.map((r) => r.trues.player)), trueA: sum(rs.map((r) => r.trues.ally)), trueR: sum(rs.map((r) => r.trues.red)),
          trueBattles: rs.filter((r) => r.trues.player + r.trues.ally + r.trues.red > 0).length,
        };
      }
      return { stage: st, name: (rows.find((r) => r.stageIndex === st) || {}).stage, ...o };
    });
    const diffs = [];
    for (const st of stages) for (const seed of S11) {
      const a = rows.find((r) => r.stageIndex === st && r.seed === seed && r.old);
      const b = rows.find((r) => r.stageIndex === st && r.seed === seed && !r.old);
      if (!a || !b) continue;
      if (a.state !== b.state || a.losses !== b.losses || a.sec !== b.sec) {
        diffs.push({ st, seed, before: `${a.state}/L${a.losses}/${a.sec}s`, after: `${b.state}/L${b.losses}/${b.sec}s`,
          trues: b.trues, armBefore: a.arm, armAfter: b.arm });
      }
    }
    return { per, diffs };
  };
})();
