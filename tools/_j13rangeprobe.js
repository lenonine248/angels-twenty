// J-13（とその比較の J-7）が AAM-M を**撃つ距離を強制して**、距離ごとの命中を測る。**開発用**。
// §104.3 の続き —— J-13 は 18km で撃って36発とも外れた。先に撃てる窓（自軍が撃てない 9〜20km）の
// どこで撃てば当たるのかを、AI の判断ではなく条件を強制して測る。
//
//   fetch('/tools/bench.js').then(r => r.text()).then(eval)
//   fetch('/tools/_aceprobe.js').then(r => r.text()).then(eval)
//   fetch('/tools/_j13lockprobe.js').then(r => r.text()).then(eval)
//   fetch('/tools/_j13rangeprobe.js').then(r => r.text()).then(eval)
//   await AT.j13r.start({ variants: ['K1', 'N'], dists: [18000, 16000, 14000, 12000, 10000], seeds: AT.ace.SEEDS })
//   AT.j13r.report()     // 変種×距離の集計だけ
//
// 強制のしかた（本体は書き換えない）:
//   エース（敵の先頭）の `autoWeapons['AAM-M'] = false` で自動発射を止め、
//   目標までの距離が D 以下になった最初の走査で**射撃指示**（`fireTasks`）を1件積む。
//   射撃指示は探知・包絡線・再装填しか見ない（命中期待度を通らない・combat.js `_runFireTasks`）。
//   撃ったら `autoWeapons` を戻す（AAM-M は1発しか積んでいないので以後は AAM-S だけ）。
//   包絡線に入らず遅れた分は `dist` に実距離で出る（D との差は `lag`）。
//
// **配置の強制**（§104.5・`geos`）: D に入った走査で、撃つ前に高度を置き直す。
//   `{ tAgl, dAlt, chaff }` —— 目標の対地高度 tAgl(m)、撃つ側の高度 = 目標 + dAlt(m)、目標のチャフの残り（省略で触らない）。
//   水平位置・速度・機首は触らない（ピッチは垂直速度から毎刻み作り直されるので矛盾しない）。
//   「撃ち上げ（dAlt<0）」と「目標の降りる余地（tAgl）」を独立に振るため。
//   `AT.j13r.start({ variants: ['K1'], dists: [10000], geos: [{ tAgl: 1500, dAlt: -2000, chaff: 0 }, …] })`
//   集計は `AT.j13r.geoReport()`
//
// **誘導の差し替え**（§104.6・`patch`）: 走らせる間だけ `Missile.prototype` を包み、終わったら戻す。
//   'A'  `_takeFix` の外挿速度 `_fixVel` に縦を含める（ピッチから戻す: vy = tan(pitch)·max(40, speed)）
//   'AB' A ＋ `_guide` が信じている点（`_fix`）を狙うとき、目標速度を位置の差分ではなく `_fixVel` にする
//   妨害で測り直しが間引かれると、狙う点が縦に段で跳び、差分の速度が1フレームだけ跳ねる —— それを確かめる
//
// `AT.j13.runProbe` をそのまま呼ぶので、`_j13lockprobe.js` の行（b1/j1 の結末・照射切れの幾何）も
// `AT.j13.rows` に並ぶ。こちらの行は `AT.j13r.rows`（1戦1行）。
//
// 列（shots: その戦闘の AAM-M 全弾。両陣営）:
//   side     'ace'（エース）/ 'blue'（自軍）/ 'red'（エース以外の敵）
//   dist     発射時の3D距離(m)   pk  本体が発射時に付けた `m.pk`（＝ estimateHitChance の見積り）
//   uf       発射時に撃った側が撃たれていたか（`threats.length>0`。SARH_HOLD_UNDER_FIRE の条件）
//   tev      発射時に目標が回避中だったか   alt/tAlt  撃った側・目標の高度(m)
//   aspect   目標の機首から見た撃った側の方位（0=正面から撃つ … 1=真後ろから撃つ・estimateHitChance と同じ定義）
//   forced   強制で撃った弾か
//   res      hit / lost:<理由> / spent:<失速|通過|寿命> / flying（戦闘が終わったとき飛んでいた）/ その他
//   paintOff 飛翔中に照射が切れていた秒数   chaff0/chaffUsed  目標のチャフ（発射時・飛翔中に使った数）
//   minDist  本体の `_minDist`（**seekTarget** への最接近。チャフや記憶点を追っていればそちら）
//   qNotch/qScreen  飛翔中の妨害の最大（ビーム欺瞞 `_notchQuality`・チャフの壁 `_screenQuality`）
//   cpa      **本当の目標**への最接近の瞬間: d(m)・age(s)・mSpd/tSpd(m/s)・tTurn(deg/s)・tEv/tCrank・
//            tAlt/mAlt・seek（弾が追っていたもの: target/point/チャフ等）・painting（照射されていたか）
(function () {
  const rows = [];
  const state = { done: 0, total: 0, running: false, error: null };
  let U = null;
  let C = null;

  // 前の包みが getter/setter なら、その setter に渡す（`bench.js` が後から `w.onFire = …` を代入しても
  // 内側の `_aceprobe` / `_j13lockprobe` の包みを捨てない）。素の chain だと外側が内側を落とす
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

  function resOf(m) {
    if (m.__hit) return 'hit';
    if (m.alive) return 'flying';
    if (m.lostReason) return 'lost:' + m.lostReason;
    if (m.endReason === 'spent') {
      return 'spent:' + (m.speed < m.weapon.speed * 0.35 ? '失速' : (m._openingFor >= 0.5 ? '通過' : '寿命'));
    }
    return String(m.endReason || '?');
  }

  function install(b, D, geo) {
    const w = b.world;
    const det = w.detection;
    const ace = b.__ace.aces[0];
    const rec = { D, shots: [], forcedAt: null, fired: false, ms: [], geoAt: null };
    const hadAuto = ace.autoWeapons ? { ...ace.autoWeapons } : null;
    if (D != null) ace.autoWeapons = { ...(ace.autoWeapons || {}), 'AAM-M': false };

    chain(w, 'onFire', (sh, tg, wp, m) => {
      if (!m || !wp || wp.id !== 'AAM-M' || !tg) return;
      const dx = sh.pos.x - tg.pos.x, dz = sh.pos.z - tg.pos.z;
      // estimateHitChance と同じ: 目標の機首から見た撃った側の方位（0=正面・1=後方）
      const aspect = Math.abs(U.angleDiff(U.headingOf(dx, dz), tg.heading)) / Math.PI;
      const side = sh === ace ? 'ace' : (sh.side === w.playerSide ? 'blue' : 'red');
      const forced = sh === ace && D != null && !rec.fired;
      const s = {
        side, forced, dist: Math.round(sh.pos.distanceTo(tg.pos)),
        pk: m.pk == null ? null : Math.round(m.pk * 1000) / 1000,
        uf: !!(sh.threats && sh.threats.length), tev: !!tg.evading,
        alt: Math.round(sh.pos.y), tAlt: Math.round(tg.pos.y),
        aspect: Math.round(aspect * 100) / 100, t: Math.round(det.time * 10) / 10,
        chaff0: tg.chaff ?? null, tType: tg.typeId || null, sType: sh.typeId || null,
      };
      rec.shots.push(s); rec.ms.push([m, s]);
      if (sh === ace) {
        rec.fired = true;
        if (D != null) ace.autoWeapons = hadAuto ? { ...hadAuto } : {};
      }
    });

    // 飛んでいる AAM-M を毎走査見る: **本当の目標**への最接近と、その瞬間の様子
    const prevU = det.update;
    det.update = (dt) => {
      prevU(dt);
      for (const [m, s] of rec.ms) {
        if (s._done) continue;
        if (!m.alive) { s._done = true; continue; }
        const tg = m.target;
        if (m.painting === false) s.paintOff = Math.round(((s.paintOff || 0) + dt) * 10) / 10;
        if (!tg || !tg.pos) continue;
        // 妨害の2成分（missile.js `_trackTarget` が max を取るもの）。どちらが効いているか
        try {
          const qn = m._notchQuality(w, tg), qs = m._screenQuality(w, tg);
          if (!(s.qNotch >= qn)) s.qNotch = Math.round(qn * 100) / 100;
          if (!(s.qScreen >= qs)) s.qScreen = Math.round(qs * 100) / 100;
        } catch (e) { s.qErr = String(e).slice(0, 60); }
        const d = m.pos.distanceTo(tg.pos);
        if (s.cpa == null || d < s.cpa.d) {
          const sk = m.seekTarget;
          s.cpa = {
            d: Math.round(d), age: Math.round((m.age || 0) * 10) / 10,
            mSpd: Math.round(m.speed || 0),                       // 弾の速さ(m/s)
            tSpd: Math.round(tg.speed || 0),
            tTurn: Math.round(Math.abs(tg.turnRate || 0) / U.DEG),  // 目標の旋回(deg/s)
            tEv: !!tg.evading, tCrank: !!tg.cranking, tAlt: Math.round(tg.pos.y), mAlt: Math.round(m.pos.y),
            seek: !sk ? 'none' : sk === tg ? 'target' : (sk.isPoint ? 'point' : (sk.kind || 'other')),
            painting: m.painting !== false,
          };
        }
        if (s.chaff0 != null) s.chaffUsed = s.chaff0 - (tg.chaff ?? 0);
      }
    };

    if (D != null) {
      const prev = det.update;
      det.update = (dt) => {
        prev(dt);
        if (rec.fired || !ace.alive || !ace.loadout.includes('AAM-M')) return;
        let tg = ace.order && ace.order.type === 'attack' ? ace.order.target : null;
        if (!tg || !tg.alive || tg.kind !== 'aircraft') return;
        if (ace.pos.distanceTo(tg.pos) > D) return;
        if (ace.fireTasks.some((t) => t.weapon === 'AAM-M')) return;
        if (rec.forcedAt == null) {
          rec.forcedAt = Math.round(det.time * 10) / 10;
          if (geo) {
            const gT = Math.max(0, w.terrain.heightAt(tg.pos.x, tg.pos.z));
            const gA = Math.max(0, w.terrain.heightAt(ace.pos.x, ace.pos.z));
            tg.pos.y = gT + geo.tAgl;
            ace.pos.y = Math.max(gA + 300, tg.pos.y + geo.dAlt);
            if (geo.chaff != null) tg.chaff = geo.chaff;
            rec.geoAt = { gT: Math.round(gT), gA: Math.round(gA), tY: Math.round(tg.pos.y), aY: Math.round(ace.pos.y) };
          }
        }
        ace.fireTasks.push({ weapon: 'AAM-M', target: tg });
      };
    }
    return rec;
  }

  async function applyPatch(kind) {
    if (!kind) return () => {};
    const { Missile } = await import('/js/sim/missile.js');
    const P = Missile.prototype;
    const takeFix = P._takeFix, guide = P._guide;
    P._takeFix = function (t) {
      takeFix.call(this, t);
      if (t && t.pitch != null) this._fixVel.y = Math.tan(t.pitch) * Math.max(40, t.speed || 0);
    };
    if (kind === 'AB') {
      P._guide = function (dt, t) {
        if (t && t === this._fix && dt > 0) {
          if (!this._prevTargetPos) this._prevTargetPos = t.pos.clone();
          this._prevTargetPos.copy(t.pos).addScaledVector(this._fixVel, -dt);
          this._prevTargetRef = t;
        }
        return guide.call(this, dt, t);
      };
    }
    return () => { P._takeFix = takeFix; P._guide = guide; };
  }

  async function runOne(variant, seed, D, geo = null) {
    if (!U) U = await import('/js/sim/unit.js');
    const origRun = AT.bench.runOne;
    let rec = null;
    AT.bench.runOne = (i, t, opts) => origRun(i, t, {
      ...opts, setup: (b) => { opts.setup(b); rec = install(b, D, geo); },
    });
    try { await AT.j13.runProbe(variant, seed); } finally { AT.bench.runOne = origRun; }
    const jr = AT.j13.rows[AT.j13.rows.length - 1];
    for (const [m, s] of rec.ms) { s.res = resOf(m); s.minDist = m._minDist == null ? null : Math.round(m._minDist); delete s._done; }
    const a = rec.shots.find((s) => s.side === 'ace') || null;
    rows.push({
      variant, seed, D, geo, geoAt: rec.geoAt, outcome: jr.outcome, sec: jr.sec,
      forcedAt: rec.forcedAt, ace: a, lag: a && D != null ? a.dist - D : null,
      j1cut: jr.j1 ? jr.j1.cut || null : null, j1paintOff: jr.j1 ? jr.j1.paintOff : null,
      shots: rec.shots,
    });
  }

  async function start(opts = {}) {
    if (state.running) return 'running';
    if (!AT.j13) throw new Error('_j13lockprobe.js を先に読むこと');
    if (!AT.__aceBase) AT.__aceBase = JSON.parse(JSON.stringify(AT.stages[0]));
    const variants = opts.variants || ['K1', 'N'];
    const dists = opts.dists || [18000, 16000, 14000, 12000, 10000];
    const seeds = opts.seeds || AT.ace.SEEDS;
    const geos = opts.geos || [null];
    const restore = await applyPatch(opts.patch || null);
    state.total += variants.length * dists.length * geos.length * seeds.length;
    state.running = true; state.error = null;
    try {
      for (const v of variants) for (const D of dists) for (const g of geos) for (const s of seeds) {
        await runOne(v, s, D, g); rows[rows.length - 1].patch = opts.patch || null; state.done++;
      }
    } catch (e) { state.error = String(e && e.stack || e); }
    finally { restore(); }
    state.running = false;
    return { done: state.done, total: state.total, error: state.error };
  }

  const cnt = (a, f) => { const o = {}; for (const x of a) { const k = f(x); o[k] = (o[k] || 0) + 1; } return o; };
  const mean = (a) => (a.length ? Math.round(a.reduce((s, v) => s + v, 0) / a.length * 1000) / 1000 : null);
  const med = (a) => { const s = a.filter((v) => v != null).sort((x, y) => x - y); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };

  // 変種×D ごと: エースの弾の距離・命中・結末・見積り、戦闘の結末、自軍の弾
  function report() {
    const out = {};
    const keys = [...new Set(rows.map((r) => `${r.variant}@${r.D == null ? 'free' : r.D / 1000 + 'km'}${r.geo ? ' geo' : ''}`))];
    for (const k of keys) {
      const rs = rows.filter((r) => `${r.variant}@${r.D == null ? 'free' : r.D / 1000 + 'km'}${r.geo ? ' geo' : ''}` === k);
      const a = rs.filter((r) => r.ace).map((r) => r.ace);
      const bl = rs.flatMap((r) => r.shots.filter((s) => s.side === 'blue'));
      out[k] = {
        N: rs.length,
        aceFired: a.length,
        aceDistKmMed: med(a.map((s) => s.dist)) / 1000,
        lagMed: med(rs.map((r) => r.lag)),
        aceHit: a.filter((s) => s.res === 'hit').length,
        acePkMean: mean(a.map((s) => s.pk)),
        aceUF: a.filter((s) => s.uf).length,
        aceTev: a.filter((s) => s.tev).length,
        aceAspectMed: med(a.map((s) => s.aspect)),
        aceRes: cnt(a, (s) => s.res),
        j1cutEvading: rs.filter((r) => r.j1cut && r.j1cut.evading).length,
        j1cutN: rs.filter((r) => r.j1cut).length,
        outcome: cnt(rs, (r) => r.outcome),
        blueM: bl.length, blueHit: bl.filter((s) => s.res === 'hit').length,
        blueDistKmMed: med(bl.map((s) => s.dist)) / 1000,
      };
    }
    return out;
  }

  // 較正用: 全弾（両陣営）を見積り pk の帯ごとに、予測の平均と実測の命中率で並べる。
  // 撃たれていたか（uf）でも割る —— SARH_HOLD_UNDER_FIRE の項がそこを受け持つので
  function calib(filter = () => true) {
    const all = rows.flatMap((r) => r.shots.map((s) => ({ ...s, variant: r.variant, D: r.D })))
      .filter((s) => s.res !== 'flying' && s.pk != null).filter(filter);
    const bands = [[0, 0.1], [0.1, 0.2], [0.2, 0.3], [0.3, 0.4], [0.4, 0.6], [0.6, 1.01]];
    const out = {};
    for (const uf of [false, true]) {
      for (const [lo, hi] of bands) {
        const xs = all.filter((s) => s.uf === uf && s.pk >= lo && s.pk < hi);
        if (!xs.length) continue;
        out[`${uf ? 'UF' : 'free'} pk${lo}-${hi}`] = {
          n: xs.length, pred: mean(xs.map((s) => s.pk)),
          obs: Math.round(xs.filter((s) => s.res === 'hit').length / xs.length * 1000) / 1000,
          distKmMed: med(xs.map((s) => s.dist)) / 1000,
        };
      }
    }
    // 距離の帯ごと（2km 刻み）にも。見積りの距離の形がずれているかを見る
    for (const uf of [false, true]) {
      for (let lo = 4000; lo < 22000; lo += 2000) {
        const xs = all.filter((s) => s.uf === uf && s.dist >= lo && s.dist < lo + 2000);
        if (!xs.length) continue;
        out[`${uf ? 'UF' : 'free'} ${lo / 1000}-${lo / 1000 + 2}km`] = {
          n: xs.length, pred: mean(xs.map((s) => s.pk)),
          obs: Math.round(xs.filter((s) => s.res === 'hit').length / xs.length * 1000) / 1000,
          tev: xs.filter((s) => s.tev).length,
        };
      }
    }
    return out;
  }

  // すり抜けの中身: 変種×D×陣営ごとに、本当の目標への最接近の様子を並べる
  function cpa(filter = () => true) {
    const all = rows.flatMap((r) => r.shots.map((s) => ({ ...s, variant: r.variant, D: r.D })))
      .filter((s) => s.cpa).filter(filter);
    const out = {};
    const keyOf = (s) => `${s.variant}@${s.D == null ? 'free' : s.D / 1000 + 'km'} ${s.side}`;
    for (const k of [...new Set(all.map(keyOf))]) {
      const xs = all.filter((s) => keyOf(s) === k);
      out[k] = {
        n: xs.length, hit: xs.filter((s) => s.res === 'hit').length, res: cnt(xs, (s) => s.res),
        cpaDMed: med(xs.map((s) => s.cpa.d)), cpaDRange: [Math.min(...xs.map((s) => s.cpa.d)), Math.max(...xs.map((s) => s.cpa.d))],
        cpaAgeMed: med(xs.map((s) => s.cpa.age)),
        mSpdMed: med(xs.map((s) => s.cpa.mSpd)), tSpdMed: med(xs.map((s) => s.cpa.tSpd)),
        tTurnMed: med(xs.map((s) => s.cpa.tTurn)),
        tEv: xs.filter((s) => s.cpa.tEv).length, tCrank: xs.filter((s) => s.cpa.tCrank).length,
        dAltMed: med(xs.map((s) => s.cpa.tAlt - s.cpa.mAlt)),
        seek: cnt(xs, (s) => s.cpa.seek), paintingAtCpa: xs.filter((s) => s.cpa.painting).length,
        paintOffMed: med(xs.map((s) => s.paintOff || 0)),
        chaffUsedMed: med(xs.map((s) => s.chaffUsed)), minDistMed: med(xs.map((s) => s.minDist)),
        types: cnt(xs, (s) => `${s.sType}>${s.tType}`),
      };
    }
    return out;
  }

  // 配置を強制した戦闘の集計: D×目標の対地高度×高度差×チャフごとの、エースの弾の命中と外れ方
  function geoReport() {
    const out = {};
    const keyOf = (r) => `${r.patch ? '[' + r.patch + '] ' : ''}${r.variant}@${r.D / 1000}km tAgl${r.geo.tAgl} dAlt${r.geo.dAlt >= 0 ? '+' : ''}${r.geo.dAlt} chaff${r.geo.chaff ?? '-'}`;
    const rs0 = rows.filter((r) => r.geo);
    for (const k of [...new Set(rs0.map(keyOf))]) {
      const rs = rs0.filter((r) => keyOf(r) === k);
      const a = rs.filter((r) => r.ace && r.ace.res !== 'flying').map((r) => r.ace);
      const ac = a.filter((s) => s.cpa);
      out[k] = {
        n: rs.length, fired: a.length, hit: a.filter((s) => s.res === 'hit').length,
        pkMed: med(a.map((s) => s.pk)), distMed: med(a.map((s) => s.dist)), lagMed: med(rs.map((r) => r.lag)),
        res: cnt(a, (s) => s.res),
        cpaD: med(ac.map((s) => s.cpa.d)), cpaAge: med(ac.map((s) => s.cpa.age)),
        cpaDAlt: med(ac.map((s) => s.cpa.tAlt - s.cpa.mAlt)),                  // 目標−弾（負＝弾が上を通過）
        tDrop: med(ac.map((s) => s.tAlt - s.cpa.tAlt)),                         // 発射から最接近までに目標が降りた(m)
        tAglCpa: med(rs.filter((r) => r.ace && r.ace.cpa && r.geoAt).map((r) => r.ace.cpa.tAlt - r.geoAt.gT)),
        mSpd: med(ac.map((s) => s.cpa.mSpd)), tEv: ac.filter((s) => s.cpa.tEv).length,
        qNotch: med(a.map((s) => s.qNotch)), qScreen: med(a.map((s) => s.qScreen)),
        chaffUsed: med(a.map((s) => s.chaffUsed)), paintOff: med(a.map((s) => s.paintOff || 0)),
        clamped: rs.filter((r) => r.geoAt && Math.abs(r.geoAt.aY - (r.geoAt.tY + r.geo.dAlt)) > 2).length,   // 撃つ側が地面に当たって持ち上げた
        outcome: cnt(rs, (r) => r.outcome),
      };
    }
    return out;
  }

  window.AT.j13r = { start, state, report, calib, cpa, geoReport, rows, runOne };
})();
