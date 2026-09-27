// 実戦の AAM-S を1発ずつ記録する（§98.7）。高空で外れる弾の「外れ方」を見るため。
//
//   fetch('/tools/bench.js')…; fetch('/tools/watchprobe.js')…; fetch('/tools/_aamshigh.js')…
//   AT.aamshigh.start([1, 6], AT.watch.SEEDS11, [true, false])   // 面・種・旧(共上昇あり)/新
//   AT.aamshigh.state / AT.aamshigh.shots
//
// 旧＝`globalThis.__approachOld`（acm.js の一時フラグ。計測後に外す）。
// 航空機を狙った AAM-S をすべて記録する（§98.6 は各戦の最初の4発だけだった）。

(function () {
  const shots = [];
  const state = { done: 0, total: 0, running: false, error: null };
  let installed = false;
  let ctx = null;

  const DEG = 180 / Math.PI;

  async function install() {
    if (installed) return;
    const { CombatSystem } = await import('/js/sim/combat.js');
    const { Missile } = await import('/js/sim/missile.js');
    const oFire = CombatSystem.prototype.fire;
    CombatSystem.prototype.fire = function (shooter, target, weapon) {
      const m = oFire.call(this, shooter, target, weapon);
      if (m && ctx && weapon && weapon.id === 'AAM-S' && target && target.kind === 'aircraft' && target.alive) {
        const los = target.pos.clone().sub(shooter.pos);
        const dist = los.length();
        los.normalize();
        // アスペクト: 目標の機首と「目標→射手」の水平角。0=正面を向き合う, 180=真後ろから
        const hx = -Math.sin(target.heading), hz = -Math.cos(target.heading);   // heading 0 = -Z
        const bx = -los.x, bz = -los.z, bl = Math.hypot(bx, bz) || 1;
        const asp = Math.acos(Math.max(-1, Math.min(1, (hx * bx + hz * bz) / bl))) * DEG;
        m.__rec = {
          ver: ctx.old ? 'old' : 'new', stage: ctx.stage, seed: ctx.seed,
          side: shooter.side,
          sAlt: Math.round(shooter.pos.y), tAlt: Math.round(target.pos.y), dist: Math.round(dist),
          sPitch: Math.round((shooter.pitch || 0) * DEG), mPitch: Math.round(Math.asin(m.dir.y) * DEG),
          off: Math.round(m.dir.angleTo(los) * DEG), asp: Math.round(asp),
          sSpd: Math.round(shooter.speed), tSpd: Math.round(target.speed),
          tHeat: +(target.heat ?? 0).toFixed(2), tAB: !!target.abActive, pk: +(m.pk ?? 0).toFixed(2),
          n: 0, sat: 0, tl: 0, aimErr: 0, aimN: 0, minD: Infinity, peakAlt: 0, minV: Infinity,
          tEvade: null, tTurnMax: 0,
        };
        m.__tgt = target;
        shots.push(m.__rec);
      }
      return m;
    };
    const oUp = Missile.prototype.update;
    Missile.prototype.update = function (dt, world) {
      const r = oUp.call(this, dt, world);
      const s = this.__rec;
      if (s) {
        const t = this.__tgt;
        s.n++;
        s.tl += this._turnLoad || 0;
        if ((this._turnLoad || 0) >= 0.999) s.sat++;
        const d = this.pos.distanceTo(t.pos);
        if (d < s.minD) s.minD = d;
        if (this.pos.y > s.peakAlt) s.peakAlt = this.pos.y;
        if (this.age > this.boostTime && this.speed < s.minV) s.minV = this.speed;
        if (this._fix && !this.lost) { s.aimErr += this._fix.pos.distanceTo(t.pos); s.aimN++; }
        if (s.tEvade == null && t.evading) s.tEvade = +this.age.toFixed(1);
        if (!this.alive && s.end == null) {
          s.end = this.endReason; s.lost = this.lostReason || null;
          s.lostAt = this.lostAt != null ? +this.lostAt.toFixed(1) : null;
          s.tof = +this.age.toFixed(1); s.vEnd = Math.round(this.speed);
          s.hit = this.endReason === 'hit';
          s.killed = t.alive === false;
          s.tAltEnd = Math.round(t.pos.y); s.tSpdEnd = Math.round(t.speed);
          s.sat = +(s.sat / s.n).toFixed(2); s.tl = +(s.tl / s.n).toFixed(2);
          s.aimErr = s.aimN ? Math.round(s.aimErr / s.aimN) : null;
          s.minD = Math.round(s.minD); s.peakAlt = Math.round(s.peakAlt);
          s.minV = s.minV === Infinity ? null : Math.round(s.minV);
          delete s.n; delete s.aimN;
          this.__rec = null;
        }
      }
      return r;
    };
    installed = true;
  }

  async function start(stages, seeds, vers = [true, false]) {
    if (state.running) return 'running';
    shots.length = 0;
    Object.assign(state, { done: 0, total: stages.length * seeds.length * vers.length, running: true, error: null });
    try {
      await install();
      for (const old of vers) {
        globalThis.__approachOld = old;
        for (const st of stages) {
          for (const seed of seeds) {
            await AT.bench.stage(st, 0, { seeds: [seed],
              setup: (b) => { ctx = { b, old, stage: b.stage.name, seed }; } });
            ctx = null;
            state.done++;
          }
        }
      }
    } catch (e) {
      state.error = String(e && e.stack || e);
    } finally {
      delete globalThis.__approachOld;
      state.running = false;
    }
    return state;
  }

  window.AT = window.AT || {};
  window.AT.aamshigh = { start, shots, state };
})();
