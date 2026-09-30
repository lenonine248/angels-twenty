// J-13 がレーダーを出して AAM-M を撃ったとき、狙われた側が「逆探知だけの航跡」で撃ち返せるかを測る。**開発用**。
//
//   fetch('/tools/bench.js').then(r => r.text()).then(eval)
//   fetch('/tools/_aceprobe.js').then(r => r.text()).then(eval)
//   fetch('/tools/_j13lockprobe.js').then(r => r.text()).then(eval)
//   await AT.j13.start({ variants: ['K1', 'K2'], seeds: AT.ace.SEEDS })   // 終わるまで待つ
//   AT.j13.report()            // 変種ごとの集計だけ
//   AT.j13.rows                // 1戦1行（生。返さない）
//
// 本体は書き換えない。`_aceprobe.js` の `AT.ace.runOne` を、`AT.bench.runOne` の `setup` に
// 計測の差し込みを足して呼ぶだけ（`AT.bench.runOne` は呼ぶ間だけ差し替えて戻す）。
//
// 列の定義:
//   b1.*  自軍（blue）が J-13 に向けて撃った**最初の AAM-M**。`world.onFire` の瞬間に取る
//     dist      発射時の 撃った機体→J-13 の3D距離(m)
//     lvl/det/exactNow/approx/err/jam   発射時点の blue の J-13 に対する Contact の状態（直近の走査の結果）
//     trackSec  発射時点で `det.time - contact.trackStart`（継続追尾の秒数）
//     lastVia   直近の走査で Contact.observe に渡ってきた経路。`exact=false` → 'rwr'、
//               `exact && level=2` → 'visual'、`exact && level<2` → 'radar'（`evaluate` の返し方と同じ）
//     viaAge    その走査が発射の何秒前か（走査は 0.2s ごと）。detected=false（ロスト中）なら null 相当
//     rwrOnly   `det && lastVia==='rwr' && viaAge<=0.25` ＝ 発射の直前の走査で**逆探知しか J-13 を捉えていなかった**
//     inVis     dist ≤ 8000（visualRange。目視の内側）
//     inRadEq   dist ≤ 撃った機体の radarRange × rcs（=9,000m。扇・視線・ルックダウンは見ない粗い値）
//     ord       撃った機体の order.target が J-13 だったか
//   b1.res    その弾の結末: hit / lost:<lostReason>（誘導喪失＝照射切れ 等）/ spent:<失速|通過|寿命> / その他 endReason
//   b1.paintOff  弾が飛んでいる間、`m.painting===false`（`illuminates` が false）だった秒数
//   j1.*  J-13 が自軍に向けて撃った最初の AAM-M（発射距離・結末。結末の分け方は同じ）
//   firstDet  blue の J-13 Contact が最初に detected になった走査: 時刻・経路・距離（nearest sensor までの真の距離）
//   firstId   Contact.level が最初に IDENTIFIED 以上になった走査: 時刻・経路・距離・why
//             why='track10'（生の level が UNKNOWN のまま IDENT_TRACK_TIME で上がった）/ 'direct'（その走査で level>=1 が来た）
//   idViaHist  firstId までの走査ごとの経路の件数（rwr/radar/visual）。逆探知10秒で上がったかの内訳
//   outcome   blue（J-13 が落ちて自軍残り）/ red / both / none（時間切れ）
(function () {
  const rows = [];
  const state = { done: 0, total: 0, running: false, error: null };
  let Contact = null;
  let U = null;
  let patched = false;

  // 前の包み（`_aceprobe` の chain）が getter/setter なら、その setter に渡す。
  // 素のままだと `bench.js` の `w.onFire = …` の代入で内側の包みが落ちる（`shotsByWeapon` が空になっていた）
  function chain(w, name, mine) {
    const prev = Object.getOwnPropertyDescriptor(w, name);
    if (prev && prev.get && prev.set) {
      Object.defineProperty(w, name, {
        configurable: true,
        get: () => { const inner = prev.get.call(w); return (...a) => { mine(...a); return inner(...a); }; },
        set: (f) => prev.set.call(w, f),
      });
      return;
    }
    let theirs = w[name] || null;
    Object.defineProperty(w, name, {
      configurable: true,
      get: () => (...args) => { mine(...args); return theirs ? theirs(...args) : undefined; },
      set: (f) => { theirs = f; },
    });
  }
  const r1 = (v) => Math.round(v * 10) / 10;

  // Contact.observe を1度だけ包む。J-13（`unit.__j13`）の blue 向け Contact だけを見る
  function patchContact() {
    if (patched) return;
    const orig = Contact.prototype.observe;
    Contact.prototype.observe = function (unit, time, level, exact, dist = 0, jamErr = 0) {
      const rec = unit && unit.__j13;
      const wasDet = this.detected;
      orig.call(this, unit, time, level, exact, dist, jamErr);
      if (!rec || rec.hookDead) return;
      const via = !exact ? 'rwr' : (level >= 2 ? 'visual' : 'radar');
      this.__last = { t: time, level, exact, dist, via };
      rec.scans++;
      let near = Infinity;
      for (const b of rec.blues) if (b.alive) near = Math.min(near, b.pos.distanceTo(unit.pos));
      if (!rec.firstDet && this.detected) {
        rec.firstDet = { t: r1(time), via, dist: Math.round(near), emit: !!unit.radarActive, lvlRaw: level };
      }
      if (!rec.firstId) {
        rec.viaHist[via] = (rec.viaHist[via] || 0) + 1;
        if (this.level >= 1) {
          rec.firstId = {
            t: r1(time), via, dist: Math.round(near), why: level >= 1 ? 'direct' : 'track10',
            trackSec: r1(time - this.trackStart), emit: !!unit.radarActive,
          };
          rec.idViaHist = { ...rec.viaHist };
        }
      }
      void wasDet;
    };
    patched = true;
  }

  function install(b) {
    const w = b.world;
    const det = w.detection;
    const ace = b.__ace.aces[0];
    const blues = b.__ace.blues;
    const rec = {
      blues, scans: 0, firstDet: null, firstId: null, viaHist: {}, idViaHist: null,
      blueShots: [], aceShots: [], blueGround: w.units.filter((u) => u.side === w.playerSide && u.kind !== 'aircraft').length,
    };
    ace.__j13 = rec;
    const mtrack = [];

    chain(w, 'onFire', (sh, tg, wp, m) => {
      if (!m || !wp) return;
      const d = sh.pos.distanceTo(tg.pos);
      if (sh.side === w.playerSide && tg === ace) {
        const c = det.contactsFor(w.playerSide).get(ace.id);
        const last = c && c.__last ? c.__last : null;
        const viaAge = last ? r1(det.time - last.t) : null;
        const s = {
          w: wp.id, t: r1(det.time), dist: Math.round(d),
          lvl: c ? c.level : null, det: c ? c.detected : null, exactNow: c ? c.exactNow : null,
          approx: c ? c.approx : null, err: c ? Math.round(c.err) : null, jam: c ? c.jammed : null,
          trackSec: c ? r1(det.time - c.trackStart) : null,
          lastVia: last ? last.via : null, viaAge,
          rwrOnly: !!(c && c.detected && last && last.via === 'rwr' && viaAge <= 0.25),
          inVis: d <= (sh.spec.visualRange || 0),
          inRadEq: d <= (sh.radarRange || 0) * (ace.spec.rcs ?? 1),
          ord: !!(sh.order && sh.order.target === ace),
          aceEmit: !!ace.radarActive,
        };
        rec.blueShots.push(s);
        mtrack.push({ m, s, ace, side: 'blue', tg });
      } else if (sh === ace) {
        const s = { w: wp.id, t: r1(det.time), dist: Math.round(d), aceEmit: !!ace.radarActive };
        rec.aceShots.push(s);
        mtrack.push({ m, s, ace, side: 'ace', tg, chaff0: tg.chaff ?? 0 });
      }
    });

    // §104 後: 自軍が J-13 を目標にしている間の「撃てない理由」を秒で数える（fireBlockReason の文言から数字を落とす）
    rec.blk = {}; rec.atkSec = 0; rec.evSec = 0; rec.noMSec = 0;
    const prev = det.update;
    det.update = (dt) => {
      prev(dt);
      if (ace.alive && w.combat) {
        for (const sh of blues) {
          if (!sh.alive || !sh.order || sh.order.type !== 'attack' || sh.order.target !== ace) continue;
          rec.atkSec += dt;
          if (sh.evading) rec.evSec += dt;
          const hasM = sh.loadout.includes('AAM-M');
          if (!hasM) rec.noMSec += dt;
          let why = null;
          try { why = w.combat.fireBlockReason(sh, ace); } catch (e) { why = 'ERR'; }
          const k = (why == null ? '(撃てる)' : String(why).replace(/[0-9.]+/g, 'N')) + (hasM ? '' : '[AAM-Mなし]');
          rec.blk[k] = (rec.blk[k] || 0) + dt;
        }
      }
      for (const o of mtrack) {
        const { m, s } = o;
        if (s.res) continue;
        if (m.alive) {
          if (m.painting === false) {
            s._po = (s._po || 0) + dt;
            if (!s.cut) {       // 照射が最初に切れた瞬間の幾何（撃った側 → 目標）
              const l = m.launcher, t = m.target;
              if (l && t) {
                const dx = t.pos.x - l.pos.x, dz = t.pos.z - l.pos.z, dy = t.pos.y - l.pos.y;
                const flat = Math.hypot(dx, dz);
                s.cut = {
                  at: r1(m.age || 0), dist: Math.round(Math.hypot(flat, dy)),
                  hoff: Math.round(Math.abs(U.angleDiff(U.headingOf(dx, dz), l.heading)) / U.DEG),
                  voff: Math.round(Math.abs(U.radarElevation(l, dy, flat)) / U.DEG),
                  evading: !!l.evading, cranking: !!l.cranking, radarOn: !!l.radarActive, launcherAlive: !!l.alive,
                };
              }
            }
          }
          continue;
        }
        s.paintOff = r1(s._po || 0);
        let res;
        if (m.__hit) res = 'hit';
        else if (m.lostReason) res = 'lost:' + m.lostReason;
        else if (m.endReason === 'spent') {
          res = 'spent:' + (m.speed < m.weapon.speed * 0.35 ? '失速' : (m._openingFor >= 0.5 ? '通過' : '寿命'));
        } else res = String(m.endReason || '?');
        s.res = res;
        s.tof = r1(m.age || 0);
        s.decoyTries = m._decoyTries || 0;
        s.jamPeak = r1(m._jamPeak || 0);
        s.minDist = m._minDist == null ? null : Math.round(m._minDist);
        s.tgEvading = !!(o.tg && o.tg.evading);
        s.tgDead = !!(o.tg && !o.tg.alive);
        if (o.side === 'ace') s.chaffUsed = o.chaff0 - ((o.tg && o.tg.chaff) ?? 0);
      }
    };
    return rec;
  }

  async function runProbe(variant, seed) {
    if (!Contact) Contact = (await import('/js/sim/detection.js')).Contact;
    if (!U) U = await import('/js/sim/unit.js');
    patchContact();
    const origRun = AT.bench.runOne;
    let rec = null;
    AT.bench.runOne = (i, t, opts) => origRun(i, t, {
      ...opts, setup: (b) => { opts.setup(b); rec = install(b); },
    });
    try { await AT.ace.runOne('1v1', variant, seed); } finally { AT.bench.runOne = origRun; }
    const row = AT.ace.rows.pop();      // aceprobe 側の行は本ツールの範囲外。ここで引き取る
    if (rec) rec.hookDead = true;
    const bs = rec.blueShots, as = rec.aceShots;
    const b1 = bs.find((s) => s.w === 'AAM-M') || null;
    const bS = bs.find((s) => s.w === 'AAM-S') || null;
    const j1 = as.find((s) => s.w === 'AAM-M') || null;
    const outcome = row.aceDied && row.blueLost ? 'both' : row.aceDied ? 'blue' : row.blueLost ? 'red' : 'none';
    rows.push({
      variant, seed, state: row.state, sec: row.sec, outcome, scans: rec.scans, blueGround: rec.blueGround,
      bMall: bs.filter((s) => s.w === 'AAM-M').map((s) => ({ dist: s.dist, res: s.res || 'flying', rwrOnly: s.rwrOnly })),
      b1, bS, bM: bs.filter((s) => s.w === 'AAM-M').length, j1, jM: as.filter((s) => s.w === 'AAM-M').length,
      firstDet: rec.firstDet, firstId: rec.firstId, idViaHist: rec.idViaHist, viaHist: rec.viaHist,
      radarOnFrac: row.radarOnFrac, minRange: row.minRange,
      blk: rec.blk, atkSec: rec.atkSec, evSec: rec.evSec, noMSec: rec.noMSec, aceDied: row.aceDied, blueLost: row.blueLost,
      shotsByWeapon: row.shotsByWeapon,
    });
  }

  async function start(opts = {}) {
    if (state.running) return 'running';
    if (!AT.ace) throw new Error('_aceprobe.js を先に読むこと');
    if (!AT.__aceBase) AT.__aceBase = JSON.parse(JSON.stringify(AT.stages[0]));
    const variants = opts.variants || ['K1', 'K2'];
    const seeds = opts.seeds || AT.ace.SEEDS;
    state.total += variants.length * seeds.length;
    state.running = true; state.error = null;
    try {
      for (const v of variants) for (const s of seeds) { await runProbe(v, s); state.done++; }
    } catch (e) { state.error = String(e && e.stack || e); }
    state.running = false;
    return { done: state.done, total: state.total, error: state.error };
  }

  const med = (a) => { const s = a.filter((v) => v != null).sort((x, y) => x - y); return s.length ? s[Math.floor((s.length - 1) / 2) + (s.length % 2 ? 0 : 0)] : null; };
  const rng = (a) => { const s = a.filter((v) => v != null); return s.length ? [Math.min(...s), Math.max(...s)] : null; };
  const cnt = (a, f) => { const o = {}; for (const x of a) { const k = f(x); o[k] = (o[k] || 0) + 1; } return o; };
  const km = (v) => (v == null ? null : r1(v / 1000));

  function report(variants) {
    const vs = variants || [...new Set(rows.map((r) => r.variant))];
    const out = {};
    for (const v of vs) {
      const rs = rows.filter((r) => r.variant === v);
      const b1 = rs.filter((r) => r.b1).map((r) => r.b1);
      const j1 = rs.filter((r) => r.j1).map((r) => r.j1);
      const fd = rs.filter((r) => r.firstDet).map((r) => r.firstDet);
      const fi = rs.filter((r) => r.firstId).map((r) => r.firstId);
      out[v] = {
        N: rs.length,
        outcome: cnt(rs, (r) => r.outcome),
        blueFiredM: b1.length,
        blueMDistKm: { med: km(med(b1.map((s) => s.dist))), range: (rng(b1.map((s) => s.dist)) || []).map(km) },
        rwrOnly: b1.filter((s) => s.rwrOnly).length,
        lastVia: cnt(b1, (s) => s.lastVia + (s.det ? '' : '(lost)')),
        inVis: b1.filter((s) => s.inVis).length,
        inRadEq: b1.filter((s) => s.inRadEq).length,
        exactNow: b1.filter((s) => s.exactNow).length,
        approx: b1.filter((s) => s.approx).length,
        lvl: cnt(b1, (s) => s.lvl),
        trackSecMed: med(b1.map((s) => s.trackSec)),
        ord: b1.filter((s) => s.ord).length,
        blueMRes: cnt(b1, (s) => s.res || 'flying'),
        paintOffMed: med(b1.map((s) => s.paintOff || 0)),
        cutN: b1.filter((s) => s.cut).length,
        cutHoffMed: med(b1.filter((s) => s.cut).map((s) => s.cut.hoff)),
        cutVoffMed: med(b1.filter((s) => s.cut).map((s) => s.cut.voff)),
        cutDistKmMed: km(med(b1.filter((s) => s.cut).map((s) => s.cut.dist))),
        cutEvading: b1.filter((s) => s.cut && s.cut.evading).length,
        cutCranking: b1.filter((s) => s.cut && s.cut.cranking).length,
        cutLauncherDead: b1.filter((s) => s.cut && !s.cut.launcherAlive).length,
        cutAtSecMed: med(b1.filter((s) => s.cut).map((s) => s.cut.at)),
        tofMed: med(b1.map((s) => s.tof)),
        minDistMed: med(b1.map((s) => s.minDist)),
        blueMAllRes: (() => { const o = {}; for (const r of rs) for (const x of r.bMall || []) { const k = x.res.split(':')[0] === 'lost' || x.res.split(':')[0] === 'spent' ? x.res : x.res; o[k] = (o[k] || 0) + 1; } return o; })(),
        blueMAllHits: rs.reduce((n, r) => n + (r.bMall || []).filter((x) => x.res === 'hit').length, 0),
        blueMAllN: rs.reduce((n, r) => n + (r.bMall || []).length, 0),
        blueMCountMed: med(rs.map((r) => r.bM)),
        blueSFirstKm: km(med(rs.filter((r) => r.bS).map((r) => r.bS.dist))),
        aceFiredM: j1.length,
        aceMDistKm: { med: km(med(j1.map((s) => s.dist))), range: (rng(j1.map((s) => s.dist)) || []).map(km) },
        aceMRes: cnt(j1, (s) => s.res || 'flying'),
        aceEmitAtFire: j1.filter((s) => s.aceEmit).length,
        firstDetN: fd.length,
        firstDetVia: cnt(fd, (s) => s.via),
        firstDetDistKm: km(med(fd.map((s) => s.dist))),
        firstDetT: med(fd.map((s) => s.t)),
        firstIdN: fi.length,
        firstIdVia: cnt(fi, (s) => s.via),
        firstIdWhy: cnt(fi, (s) => s.why),
        firstIdDistKm: { med: km(med(fi.map((s) => s.dist))), range: (rng(fi.map((s) => s.dist)) || []).map(km) },
        firstIdT: med(fi.map((s) => s.t)),
        firstIdTrackSec: med(fi.map((s) => s.trackSec)),
        atkSecMed: med(rs.map((r) => Math.round(r.atkSec))),
        evSecMed: med(rs.map((r) => Math.round(r.evSec))),
        secMed: med(rs.map((r) => r.sec)),
        blkSecPerBattle: (() => { const o = {}; for (const r of rs) for (const [k, v] of Object.entries(r.blk || {})) o[k] = (o[k] || 0) + v; for (const k in o) o[k] = Math.round(o[k] / rs.length * 10) / 10; return o; })(),
        minRangeMed: med(rs.map((r) => r.minRange)),
        blueLostSum: rs.reduce((n, r) => n + (r.blueLost || 0), 0),
        blueGroundUnits: rs.length ? rs[0].blueGround : null,
      };
    }
    return out;
  }

  window.AT.j13 = { start, state, report, rows, runProbe };
})();
