// LOST_HARD_CAP（150秒）の効きの計測。ゲーム本体(js/)は変更しない。
// 各戦闘で DetectionSystem の実体の _age / update を包み、コンタクトの削除のたびに記録する。
//   A = 素（cap 有り）／ B = cap 無効（誤差 err > LOST_ERROR による削除だけ残す）
// 土台は tools/_armbench.js（面×条件ごとに iframe を使い捨て・AT.bench.runOne を1戦ずつ・種は S11 の18種）。
//
// 親ページ（アプリを開いたタブ）で:
//   await fetch('/tools/_lostcapprobe.js').then(r => r.text()).then(eval);
//   window.__lcDrive({stages:[0,1,2,3,4,5,6,7]}).then(r => window.__lcDriveResult = r);   // fire-and-forget
//   window.__lcProgress / window.__lcSummary() / window.__lcAB()
//
// 列の定義（__lcEv の1行 = 1削除）:
//   cat: air(kind=aircraft) / ship / ground(kind=ground) / other:<kind>
//   reason: cap=上限で消えた(err<=LOST_ERROR) / err=誤差で消えた / seenDead=見ている前で撃破(別数え)
//   err: 削除時の誤差(m)   v: 目標の実際の速さ(m/s)   alive: 削除時に目標が生きていたか
//   extra: 誤差だけなら何秒後に消えていたか = (3000-err)/max(c.speed,6)（削除の"後"の秒数。cap のみ意味を持つ）
//   reacq: 削除後に同じ id が再び探知されるまでの秒数（null=再探知されず）  aliveEnd: 戦闘終了時の生死
//   tasked: 削除の瞬間、その陣営の誰かが attack 指示の target にしていたか（人数でなく有無）
(() => {
  const S11 = Array.from({ length: 18 }, (_, k) => 11 * (k + 1));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const round = (x, d = 0) => { const k = 10 ** d; return x == null || !Number.isFinite(x) ? null : Math.round(x * k) / k; };

  async function inFrame(stageIndex, capOff, seeds) {
    const dm = await import('/js/sim/detection.js');
    const LOST_ERROR = dm.LOST_ERROR, CAP = dm.LOST_HARD_CAP;
    const MIN_DRIFT = 6;
    const round = (x, d = 0) => { const k = 10 ** d; return x == null || !Number.isFinite(x) ? null : Math.round(x * k) / k; };
    const catOf = (u) => (u.kind === 'aircraft' ? 'air' : (u.kind === 'ship' ? 'ship' : (u.kind === 'ground' ? 'ground' : 'other:' + u.kind)));
    const out = [];
    for (const seed of seeds) {
      const ev = [];
      const pending = [];        // 再探知待ちの cap 削除
      const counts = { seenDead: 0 };
      const setup = (b) => {
        const d = b.world.detection, w = b.world;
        d._age = function (dt) {
          for (const side of ['blue', 'red']) {
            const map = this.contacts[side];
            for (const [id, c] of map) {
              if (!c.unit.alive && c.detected) { map.delete(id); counts.seenDead++; continue; }
              if (c.detected) continue;
              if (c.state === 'memory') continue;
              c.extrapolate(dt);
              const byErr = c.err > LOST_ERROR;
              const byCap = this.time - c.lastSeen > CAP;
              if (!(byErr || (byCap && !capOff))) continue;
              const u = c.unit;
              const reason = byErr ? 'err' : 'cap';
              const drift = Math.max(c.speed || 0, MIN_DRIFT);
              let tasked = false;
              for (const s of w.units) {
                if (s.side !== side || !s.alive || !s.order) continue;
                if (s.order.type === 'attack' && s.order.target === u) { tasked = true; break; }
              }
              const rec = { st: stageIndex, seed, capOff, side, cat: catOf(u), name: (u.spec && (u.spec.name || u.spec.id)) || u.name,
                t: round(this.time, 1), reason, err: round(c.err), v: round(u.speed || 0, 1), alive: !!u.alive,
                extra: round(Math.max(0, (LOST_ERROR - c.err) / drift), 0), reacq: null, aliveEnd: null, tasked,
                tagged: !!(u.tags && u.tags.length), _id: id, _u: u, _side: side };
              ev.push(rec);
              map.delete(id);
              pending.push(rec);
            }
          }
        };
        const upd = d.update.bind(d);
        d.update = function (dt) {
          upd(dt);
          for (const rec of pending) {
            if (rec.reacq != null) continue;
            const c = d.contacts[rec._side].get(rec._id);
            if (c && c.detected) rec.reacq = round(d.time - rec.t, 1);
          }
        };
      };
      const r = await AT.bench.runOne(stageIndex, false, { seed, setup });
      for (const e of ev) { e.aliveEnd = !!e._u.alive; delete e._u; delete e._id; delete e._side; }
      out.push({ row: { st: stageIndex, stage: r.stage, seed, capOff, state: r.state, sec: r.sec, losses: r.losses,
        allyLosses: r.allyLosses, kills: r.kills, reason: r.reason, seenDead: counts.seenDead }, ev });
    }
    return out;
  }

  window.__lcRows = window.__lcRows || [];
  window.__lcEv = window.__lcEv || [];
  window.__lcDrive = async (opts = {}) => {
    const stages = opts.stages || [0, 1, 2, 3, 4, 5, 6, 7], seeds = opts.seeds || S11;
    const conds = opts.conds || [false, true];          // capOff=false が A（素）
    const bench = await fetch('/tools/bench.js').then((r) => r.text());
    const harnessFn = inFrame.toString();
    const list = [];
    for (const st of stages) for (const capOff of conds) list.push({ st, capOff });
    window.__lcProgress = { done: 0, total: list.length, err: null, t0: performance.now() };
    for (const { st, capOff } of list) {
      const fr = document.createElement('iframe');
      fr.src = '/'; fr.style.cssText = 'position:fixed;left:0;top:0;width:640px;height:400px;border:0;';
      document.body.appendChild(fr);
      let ready = false;
      for (let i = 0; i < 600 && !ready; i++) { await sleep(100); try { ready = !!fr.contentWindow.AT_READY && !!fr.contentWindow.AT; } catch (e) { /* 読込中 */ } }
      if (!ready) { window.__lcProgress.err = 'iframe not ready'; fr.remove(); break; }
      try {
        fr.contentWindow.eval(bench);
        fr.contentWindow.eval(`window.__lcInFrame = ${harnessFn}`);
        const res = await fr.contentWindow.__lcInFrame(st, capOff, seeds);
        for (const x of res) {
          window.__lcRows.push(JSON.parse(JSON.stringify(x.row)));
          for (const e of x.ev) window.__lcEv.push(JSON.parse(JSON.stringify(e)));
        }
      } catch (e) {
        window.__lcProgress.err = `st${st} capOff=${capOff}: ${String((e && e.stack) || e).slice(0, 300)}`;
      }
      fr.src = 'about:blank'; await sleep(300); fr.remove(); await sleep(2500);
      window.__lcProgress.done++;
    }
    window.__lcProgress.sec = round((performance.now() - window.__lcProgress.t0) / 1000);
    return window.__lcProgress;
  };

  const med = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

  // A（capOff=false）の削除の集計: 面×陣営×種類の cap/err 件数と、cap の中身
  window.__lcSummary = () => {
    const ev = window.__lcEv.filter((e) => !e.capOff);
    const nA = window.__lcRows.filter((r) => !r.capOff);
    const table = {};
    for (const e of ev) {
      const k = `${e.st}|${e.side}|${e.cat}`;
      const o = table[k] || (table[k] = { cap: 0, err: 0 });
      o[e.reason]++;
    }
    const caps = ev.filter((e) => e.reason === 'cap');
    const byCat = {};
    for (const cat of [...new Set(caps.map((e) => e.cat))]) {
      const cs = caps.filter((e) => e.cat === cat);
      const re = cs.filter((e) => e.reacq != null);
      byCat[cat] = {
        n: cs.length, aliveAtDelete: round(cs.filter((e) => e.alive).length / cs.length, 2),
        aliveEnd: round(cs.filter((e) => e.aliveEnd).length / cs.length, 2),
        reacqFrac: round(re.length / cs.length, 2), reacqMedSec: med(re.map((e) => e.reacq)),
        neverReacqAliveEnd: cs.filter((e) => e.reacq == null && e.aliveEnd).length,
        extraMedSec: med(cs.map((e) => e.extra)), tasked: cs.filter((e) => e.tasked).length,
        taggedN: cs.filter((e) => e.tagged).length, errMed: med(cs.map((e) => e.err)),
        vMed: med(cs.map((e) => e.v)),
      };
    }
    const bySide = {};
    for (const e of caps) bySide[e.side] = (bySide[e.side] || 0) + 1;
    return { battlesA: nA.length, table, byCat, capBySide: bySide, seenDead: nA.reduce((s, r) => s + r.seenDead, 0),
      totalCap: caps.length, totalErr: ev.length - caps.length };
  };

  // A/B: 面ごとの clear・損失・決着時刻（clear 戦のみの中央値）と、戦闘ごとの差
  window.__lcAB = () => {
    const rows = window.__lcRows;
    const stages = [...new Set(rows.map((r) => r.st))].sort((a, b) => a - b);
    const sum = (a) => a.reduce((s, x) => s + x, 0);
    const per = stages.map((st) => {
      const o = { st, name: (rows.find((r) => r.st === st) || {}).stage };
      for (const capOff of [false, true]) {
        const rs = rows.filter((r) => r.st === st && r.capOff === capOff);
        const cl = rs.filter((r) => r.state === 'clear');
        o[capOff ? 'B' : 'A'] = { n: rs.length, clear: cl.length, loss: sum(rs.map((r) => r.losses)),
          allyLoss: sum(rs.map((r) => r.allyLosses)), secMed: med(cl.map((r) => r.sec)), secMedAll: med(rs.map((r) => r.sec)) };
      }
      return o;
    });
    const diffs = [];
    for (const st of stages) for (const seed of S11) {
      const a = rows.find((r) => r.st === st && r.seed === seed && !r.capOff);
      const b = rows.find((r) => r.st === st && r.seed === seed && r.capOff);
      if (!a || !b) continue;
      if (a.state !== b.state || a.losses !== b.losses || a.sec !== b.sec) diffs.push({ st, seed, A: `${a.state}/L${a.losses}/${a.sec}s`, B: `${b.state}/L${b.losses}/${b.sec}s` });
    }
    return { per, nDiff: diffs.length, diffs };
  };
})();
