// 高空で AAM-S が当たらない理由を切り分ける（§98.7）。
//
//   fetch('/tools/kinematics.js').then(r => r.text()).then(eval)
//   fetch('/tools/_aamsalt.js').then(r => r.text()).then(eval)
//   AT.aamsalt.start()            // 走らせっぱなしにする（45秒の打ち切りを避ける）
//   AT.aamsalt.state              // { done, total, running }
//   AT.aamsalt.report()           // 集計だけ返す
//
// §98.6 で「8,000m 超の AAM-S は 0/11」まで分かった。候補は
// **ミサイルの旋回（動圧）・ミサイルの抗力・目標の性能・シーカー／フレア**。
// 実戦の記録を割るのではなく、**条件を強制して**測る（§98.6 の11発は旧版の一時フラグでしか出ない）。
//
// - kin : `kinematics.js` と同じ「誘導を切れない」弾。対抗手段なし。残るのは運動だけ
// - live: 本物のシーカー、目標はフレアを撒く
// - 要因を1つずつ「3,000m の値」に差し替える（高度はそのまま）:
//   Mturn  … ミサイルの `turnRateAt`（動圧の限界）
//   Mdrag  … ミサイルの慣性飛行の抗力（旋回抗力の項は差し替えていない）
//   Tperf  … 目標の `effectiveTurnRate` と `altitudeMaxSpeed`（推力は式の中にあるので触れない）

(function () {
  const REF = 3000;
  const knock = { Mturn: false, Mdrag: false, Tperf: false };
  const rows = [];
  const state = { done: 0, total: 0, running: false, error: null };
  let installed = null;

  async function install() {
    if (installed) return installed;
    const { Missile } = await import('/js/sim/missile.js');
    const { Aircraft } = await import('/js/sim/aircraft.js');
    const { missileDragFactor } = await import('/js/core/atmosphere.js');

    const swapY = (obj, fn) => { const y = obj.pos.y; obj.pos.y = REF; try { return fn(); } finally { obj.pos.y = y; } };

    const oTurn = Missile.prototype.turnRateAt;
    Missile.prototype.turnRateAt = function (s) {
      return knock.Mturn ? swapY(this, () => oTurn.call(this, s)) : oTurn.call(this, s);
    };
    const oUpd = Missile.prototype._updateMissile;
    Missile.prototype._updateMissile = function (dt, world) {
      if (this.__d0 == null) this.__d0 = this.drag;
      this.drag = knock.Mdrag
        ? this.__d0 * missileDragFactor(REF) / missileDragFactor(this.pos.y) : this.__d0;
      return oUpd.call(this, dt, world);
    };
    // 1フレームごとの様子を弾に溜める
    const oUp = Missile.prototype.update;
    Missile.prototype.update = function (dt, world) {
      const r = oUp.call(this, dt, world);
      const s = this.__st || (this.__st = { n: 0, sat: 0, tl: 0, tspd: 0, alt: 0 });
      s.n++;
      s.tl += this._turnLoad || 0;
      if ((this._turnLoad || 0) >= 0.999) s.sat++;
      if (this.target) s.tspd += this.target.speed || 0;
      s.alt += this.pos.y;
      return r;
    };
    const P = Aircraft.prototype;
    const dTurn = Object.getOwnPropertyDescriptor(P, 'effectiveTurnRate');
    const dMax = Object.getOwnPropertyDescriptor(P, 'altitudeMaxSpeed');
    Object.defineProperty(P, 'effectiveTurnRate', { configurable: true,
      get() { return knock.Tperf ? swapY(this, () => dTurn.get.call(this)) : dTurn.get.call(this); } });
    Object.defineProperty(P, 'altitudeMaxSpeed', { configurable: true,
      get() { return knock.Tperf ? swapY(this, () => dMax.get.call(this)) : dMax.get.call(this); } });

    installed = { Missile, Aircraft, oTurn, oUpd, oUp, dTurn, dMax };
    return installed;
  }

  function uninstall() {
    if (!installed) return;
    const { Missile, Aircraft, oTurn, oUpd, oUp, dTurn, dMax } = installed;
    Missile.prototype.turnRateAt = oTurn;
    Missile.prototype._updateMissile = oUpd;
    Missile.prototype.update = oUp;
    Object.defineProperty(Aircraft.prototype, 'effectiveTurnRate', dTurn);
    Object.defineProperty(Aircraft.prototype, 'altitudeMaxSpeed', dMax);
    installed = null;
  }

  function plan(opts) {
    const alts = opts.alts || [3000, 6000, 8000, 10000, 11500];
    const kms = opts.kms || [2, 3, 4, 5, 6, 7, 8];
    const asps = opts.aspects || [0, 45, 90, 135, 180];
    const reps = opts.reps || 2;
    const hi = opts.hi || 11500;
    const cells = [];
    for (const mode of ['kin', 'live']) for (const alt of alts) cells.push({ mode, alt, k: '' });
    for (const k of ['Mturn', 'Mdrag', 'Tperf', 'Mturn+Mdrag']) cells.push({ mode: 'kin', alt: hi, k });
    for (const k of ['Mturn', 'Mturn+Mdrag']) cells.push({ mode: 'live', alt: hi, k });
    const jobs = [];
    for (const c of cells) for (const km of kms) for (const a of asps) for (let r = 0; r < reps; r++) jobs.push({ ...c, km, a });
    return jobs;
  }

  /** 高度 × 発射時の機首上げ（§98.7） */
  function planPitch(opts) {
    const alts = opts.alts || [3000, 6000, 8000, 10000, 11500];
    const pitches = opts.pitches || [0, 10, 20, 28, 35];
    const kms = opts.kms || [4, 5, 6];
    const asps = opts.aspects || [0, 45, 90, 135, 180];
    const jobs = [];
    for (const mode of opts.modes || ['kin', 'live']) for (const alt of alts) for (const p of pitches) {
      for (const km of kms) for (const a of asps) jobs.push({ mode, alt, k: 'P' + p, pitch: p, km, a });
      if (opts.knock) for (const km of kms) for (const a of asps) jobs.push({ mode, alt, k: 'P' + p + '+Mturn', pitch: p, km, a });
    }
    return jobs;
  }

  async function start(opts = {}) {
    if (state.running) return 'running';
    rows.length = 0;
    const jobs = opts.pitch ? planPitch(opts) : plan(opts);
    Object.assign(state, { done: 0, total: jobs.length, running: true, error: null });
    try {
      await install();
      const K = AT.kin._internal;
      const b = await K.fresh(11);
      const C = b.combat;
      let last = null;
      const oFire = C.fire;
      C.fire = function (...a) { last = oFire.apply(this, a); return last; };
      let patchedMode = null;
      for (const j of jobs) {
        if (j.mode !== patchedMode) {
          if (j.mode === 'kin') await K.patch(); else K.unpatch();
          patchedMode = j.mode;
        }
        knock.Mturn = j.k.includes('Mturn');
        knock.Mdrag = j.k.includes('Mdrag');
        knock.Tperf = j.k.includes('Tperf');
        last = null;
        const r = K.shot(b, 'AAM-S', j.km, j.a, j.alt, { live: j.mode === 'live', pitch: j.pitch });
        const m = last, s = m && m.__st;
        rows.push({ ...j,
          hit: r && r.結末 === '撃墜',
          why: m ? (m.endReason || (m.alive ? 'timeout' : '?')) : 'nofire',
          lost: m ? (m.lostReason || null) : null,
          minD: r ? r.最接近 : null, tof: r ? r.飛翔秒 : null,
          vEnd: m ? Math.round(m.speed) : null,
          sat: s && s.n ? s.sat / s.n : 0, tl: s && s.n ? s.tl / s.n : 0,
          tspd: s && s.n ? s.tspd / s.n : 0, malt: s && s.n ? s.alt / s.n : 0 });
        state.done++;
        if (state.done % 10 === 0) await new Promise((res) => setTimeout(res, 0));
      }
      C.fire = oFire;
      K.unpatch();
    } catch (e) {
      state.error = String(e && e.stack || e);
    } finally {
      knock.Mturn = knock.Mdrag = knock.Tperf = false;
      uninstall();
      state.running = false;
    }
    return state;
  }

  const med = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };

  function report() {
    const key = (r) => `${r.mode} ${r.alt} ${r.k || '-'}`;
    const groups = new Map();
    for (const r of rows) { const g = groups.get(key(r)) || []; g.push(r); groups.set(key(r), g); }
    const out = [];
    for (const [k, g] of groups) {
      const why = {};
      for (const r of g) if (!r.hit) { const w = r.why + (r.lost ? '(' + r.lost + ')' : ''); why[w] = (why[w] || 0) + 1; }
      const miss = g.filter((r) => !r.hit);
      out.push({ cell: k, hit: `${g.filter((r) => r.hit).length}/${g.length}`,
        missWhy: Object.entries(why).map(([a, n]) => `${a}:${n}`).join(' '),
        sat: +(g.reduce((s, r) => s + r.sat, 0) / g.length).toFixed(2),
        tl: +(g.reduce((s, r) => s + r.tl, 0) / g.length).toFixed(2),
        vEndMiss: med(miss.map((r) => r.vEnd)), minDMiss: med(miss.map((r) => r.minD)),
        tofMiss: med(miss.map((r) => r.tof)), tspd: Math.round(med(g.map((r) => r.tspd))) });
    }
    return out;
  }

  /** 高度 × 距離（またはアスペクト）の命中表。無差し替えの行だけ */
  function grid(mode = 'kin', by = 'km') {
    const g = rows.filter((r) => r.mode === mode && !r.k);
    const alts = [...new Set(g.map((r) => r.alt))];
    const cols = [...new Set(g.map((r) => r[by]))];
    const out = {};
    for (const alt of alts) {
      out[alt] = cols.map((c) => { const x = g.filter((r) => r.alt === alt && r[by] === c); return `${c}:${x.filter((r) => r.hit).length}/${x.length}`; }).join(' ');
    }
    return out;
  }

  window.AT = window.AT || {};
  window.AT.aamsalt = { planPitch, start, report, grid, rows, state, knock, uninstall };
})();
