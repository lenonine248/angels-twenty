// 未使用の地上ユニット SAMSHIP（ミサイル艦）を ARM / AGM / BOMB で攻撃したときの挙動と脅威度を測る。
// 土台は tools/_tossc3g.js（世界の組み立て・固定dtのヘッドレスtick・fire-and-forgetで結果をwindowに置く）。
// ゲーム本体(js/)は一切変更しない。Missile.prototype._blast だけ、ページ内で一時的に包む
// （爆風ダメージと直撃・かすりを分けて数えるため。ファイルは書き換えない・ページを再読込すれば消える）。
//
// 読み込み（先に _tut_harness.js を読む。__open を使う）:
//   await fetch('/tools/_tut_harness.js').then(r => r.text()).then(eval);
//   await fetch('/tools/_samshipprobe.js').then(r => r.text()).then(eval);
// 1走:   window.__ssOne({tgt:'SAMSHIP', lo:'ARM4', k:0, seed:1}).then(r => window.__ssTmp = r)
// 全体:  window.__ssDrive({chunk:60}).then(r => window.__ssDriveResult = r)  // 推奨。iframeを使い捨てて回す（下記）
//        window.__ssRunAll(opts)  // 同一ページで回す版。約190走で main.js の buildBattle がメモリ不足になる
//        どちらも fire-and-forget。window.__ssProgress を見る。結果は window.__ssRuns（親ページ）
// opts: tgts / los / ks(方位0..5=60度刻み) / seeds / alts(['auto',4500]) / chunk / from（途中再開）
// 高度: 'auto'=高度指定なしの攻撃指示（AIが決める）、4500=commandedAlt を4500に固定（プレイヤーが高度指定した形）
// 目標キー: SAMSHIP SAM SHIP PAIR(SAM+SHIP 500m離し) SAMSHIP_X/T/A(横切る/向かってくる/離れる 8m/s)
//          SAMSHIP_NS / SAMSHIP_NS_X/T/A = SAM 弾数0にした対照（近接防空と耐久だけ残す）
// 集計:  window.__ssAgg()         // 目標×積み方の表（配列）
//
// 幾何: 全目標を全面海の1点 C(=マップ中央)に置く。攻撃機は C から D_START の位置・目標へ機首・高度4500m。
//   マップが51.2kmなので「目標から30km」は6方位のうち置けない向きがある。24kmにした（どの向きでもマップ内）。
// 地形: baseAltitude=-1500 で全面が水深143m以上（艦の SHIP_MIN_DEPTH=40 を満たす）。
(() => {
  const DT = 1 / 30;
  const DEG = Math.PI / 180;
  const MAX_T = 420;
  const D_START = 24000;
  const C = { x: 25600, z: 25600 };
  const PRELEAD = 100;          // 動く艦は、攻撃機が着くころ(≒100秒後)に C を通るよう前もってずらして置く
  const SHIP_V = 8;
  const TERRAIN = { seed: 91001, mountainAmount: 0, coast: 'none', valleyDepth: 0, rivers: 0, baseAltitude: -1500 };
  const LOADOUTS = {
    ARM4: ['ARM', 'ARM', 'ARM', 'ARM'],
    AGM4: ['AGM', 'AGM', 'AGM', 'AGM'],
    BOMB4: ['BOMB', 'BOMB', 'BOMB', 'BOMB'],
    ARM2AGM2: ['ARM', 'ARM', 'AGM', 'AGM'],
  };
  const TGT_KEYS = ['SAMSHIP', 'SAM', 'SHIP', 'PAIR', 'SAMSHIP_X', 'SAMSHIP_T', 'SAMSHIP_A',
    'SAMSHIP_NS', 'SAMSHIP_NS_X', 'SAMSHIP_NS_T', 'SAMSHIP_NS_A'];
  const ORD = ['ARM', 'AGM', 'BOMB'];

  const round = (x, d = 0) => { const k = 10 ** d; return x == null || !Number.isFinite(x) ? null : Math.round(x * k) / k; };
  const off = (p, d, ang) => ({ x: p.x + d * Math.sin(ang), z: p.z - d * Math.cos(ang) });
  const sum = (a) => a.reduce((s, x) => s + (x || 0), 0);
  const mean = (a) => { const v = a.filter((x) => x != null && Number.isFinite(x)); return v.length ? sum(v) / v.length : null; };
  const median = (a) => {
    const v = a.filter((x) => x != null && Number.isFinite(x)).sort((x, y) => x - y);
    if (!v.length) return null; const m = v.length >> 1; return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
  };

  // ---------------------------------------------------------------- 目標の並べ方
  function groundDefs(tgt0, brg) {
    const tgt = tgt0.replace('_NS', '');          // _NS = SAM 弾数 0 の対照（実行時に弾数を落とす）
    const d = (type, name, p, extra = {}) => ({ type, name, x: round(p.x, 1), z: round(p.z, 1), known: true, ...extra });
    if (tgt === 'SAMSHIP') return [d('SAMSHIP', 'SAMSHIP', C)];
    if (tgt === 'SAM') return [d('SAM', 'SAM', C)];
    if (tgt === 'SHIP') return [d('SHIP', 'SHIP', C)];
    if (tgt === 'PAIR') return [d('SAM', 'SAM', off(C, 250, brg + Math.PI / 2)), d('SHIP', 'SHIP', off(C, 250, brg - Math.PI / 2))];
    // 動く艦。方位 dir に SHIP_V m/s で直進する route
    const dirOf = { SAMSHIP_X: brg + Math.PI / 2, SAMSHIP_T: brg + Math.PI, SAMSHIP_A: brg }[tgt];
    const p0 = off(C, -SHIP_V * PRELEAD, dirOf);
    const p1 = off(p0, 15000, dirOf);
    return [d('SAMSHIP', 'SAMSHIP', p0, { route: [{ x: round(p0.x, 1), z: round(p0.z, 1) }, { x: round(p1.x, 1), z: round(p1.z, 1) }] })];
  }

  function buildScenario(id, cfg, brg) {
    const start = off(C, -D_START, brg);          // C から攻撃機の進行方向の逆へ D_START
    return {
      id, group: '計測', name: 'SAMSHIP PROBE', title: '計測用（非表示）',
      battleSeed: cfg.seed >>> 0,
      brief: '計測用の内部ステージ（全面海・SAMSHIP）。', hint: '',
      terrain: { ...TERRAIN },
      weaponPoints: 99,
      noFail: true,
      friendly: {
        base: { x: 3000, z: 3000 },
        startAirborne: true, startAlt: 4500,
        aircraft: [{
          type: 'A-3', name: 'ATK', x: round(start.x, 1), z: round(start.z, 1),
          loadout: LOADOUTS[cfg.lo].slice(),
          autoWeapons: { ARM: true, AGM: true, BOMB: true },
        }],
      },
      enemy: { skill: 0.6, aircraft: [], ground: groundDefs(cfg.tgt, brg) },
      steps: [{ text: '(計測用ダミー手順)', check: () => false }],
    };
  }

  // ---------------------------------------------------------------- Missile._blast の包み（爆風中フラグ）
  let inBlast = false;
  async function patchBlast() {
    if (window.__ssPatched) return;
    const mm = await import('/js/sim/missile.js');
    const orig = mm.Missile.prototype._blast;
    mm.Missile.prototype._blast = function (world) {
      inBlast = true;
      try { return orig.call(this, world); } finally { inBlast = false; }
    };
    window.__ssPatched = true;
  }

  // ---------------------------------------------------------------- 1走
  window.__ssOne = async (cfg) => {
    await patchBlast();
    const k = cfg.k, brg = k * 60 * DEG;
    const id = 'ss_probe';
    const i0 = AT.tutorials.findIndex((t) => t.id === id);
    if (i0 >= 0) AT.tutorials.splice(i0, 1);
    AT.tutorials.push(buildScenario(id, cfg, brg));
    await __open(id);
    const world = AT.battle.world;
    const terrain = world.terrain;
    const u = world.units.find((x) => x.kind === 'aircraft' && x.side === world.playerSide);
    const targets = world.units.filter((x) => x.side !== world.playerSide && x.spec && x.kind !== 'aircraft');
    // 攻撃順: SAM を先に、あとで SHIP（PAIR のとき）
    targets.sort((a, b) => (a.typeId === 'SAM' ? 0 : 1) - (b.typeId === 'SAM' ? 0 : 1));
    const primary = targets[0];
    const armed = world.units.filter((x) => x.mounts && x.mounts.length);
    const t0mounts = new Map(targets.map((g) => [g, g.mounts.map((m) => m.ammo)]));

    u.heading = brg;
    u.setPlayerOrder({ type: 'attack', target: targets[0] });
    for (let i = 1; i < targets.length; i++) u.setPlayerOrder({ type: 'attack', target: targets[i] }, true);
    // 高度指定（ui/commands.js の setAltitude と同じ4か所）。'auto'=指定なし=AIが高度を決める
    const altCmd = cfg.alt == null || cfg.alt === 'auto' ? null : cfg.alt;
    const applyAlt = () => {
      if (altCmd == null) return;
      if (u.order) u.order.alt = altCmd;
      for (const q of u.queue) q.alt = altCmd;
      u.desiredAlt = altCmd; u.commandedAlt = altCmd;
    };
    applyAlt();
    if (cfg.tgt.includes('_NS')) for (const g of targets) for (const m of g.mounts) if (m.w.kind === 'sam') m.ammo = 0;

    const p0 = { x: primary.pos.x, z: primary.pos.z };
    const loStart = u.loadout.slice();
    const gunStart = u.gun, chaff0 = u.chaff, flare0 = u.flares;
    const maxHp = u.hp;

    // ---- 記録
    const rec = {
      cfg, brg: round(brg / DEG),
      dmgW: { ARM: 0, AGM: 0, BOMB: 0, GUN: 0, other: 0 },
      dmgKind: { direct: 0, graze: 0, blast: 0 },
      dmgByW: {},                                   // 兵装×(direct/graze/blast) の有効ダメージ
      uDmg: { sam: 0, aaa: 0, other: 0 }, uHits: { sam: 0, aaa: 0 },
      fired: { ARM: 0, AGM: 0, BOMB: 0 }, launchD: { ARM: [], AGM: [], BOMB: [] },
      msl: [],
      samFired: 0, samEnd: {}, samLostReason: {},
      armSilences: 0, silSec: 0,
      secAAA: 0, sec19: 0, sec19armed: 0, minDist: Infinity,
      det: { contact: 0, memory: 0, lost: 0, none: 0, exact: 0 },
      releases: [], logs: {}, rtbT: null,
      evadeSec: 0, reissued: 0, samFirstT: null, samFirstD: null, firstHitT: null, firstArmT: null,
    };
    const mslRecs = new Map();     // Missile -> rec
    const samMsl = [];
    let inBlastNow = false;

    const classifySrc = (src) => {
      if (!src) return { w: 'other' };
      if (src.weapon) return { w: src.weapon.id, m: src, missile: true };
      if (src.kind === 'aircraft') return { w: 'GUN' };
      return { w: 'other' };
    };

    // 目標の被ダメージ
    for (const g of targets) {
      const orig = g.damage.bind(g);
      g.damage = (amount, source) => {
        const wasAlive = g.alive, hp0 = g.hp;
        orig(amount, source);
        if (!wasAlive) return;
        const eff = Math.min(amount, hp0);
        const c = classifySrc(source);
        const key = ORD.includes(c.w) || c.w === 'GUN' ? c.w : 'other';
        rec.dmgW[key] += eff;
        if (c.missile) {
          const kind = inBlast ? 'blast' : (amount >= source.weapon.damage - 1e-6 ? 'direct' : 'graze');
          rec.dmgKind[kind] += eff;
          const kk = `${c.w}.${kind}`;
          rec.dmgByW[kk] = (rec.dmgByW[kk] || 0) + eff;
          const mr = mslRecs.get(source);
          if (mr) mr.dmg += eff;
        }
      };
    }
    // 攻撃機の被ダメージ
    {
      const orig = u.damage.bind(u);
      u.damage = (amount, source) => {
        const wasAlive = u.alive;
        orig(amount, source);
        if (!wasAlive) return;
        if (source && source.weapon && source.weapon.kind === 'sam') {
          rec.uDmg.sam += amount; rec.uHits.sam++;
          if (rec.firstHitT == null) rec.firstHitT = round(tick * DT, 1);
        }
        else if (source && source.spec && !source.weapon) { rec.uDmg.aaa += amount; rec.uHits.aaa++; }
        else rec.uDmg.other += amount;
      };
    }
    // 攻撃指示が解けた回数と理由
    {
      const proto = Object.getPrototypeOf(u);
      u._releaseTarget = function (w, order, lost) {
        const tg = order && order.target;
        const c = tg && world.detection.contactsFor(this.side).get(tg.id);
        rec.releases.push({
          t: round(tick * DT, 1), lost: !!lost, tgtAlive: tg ? tg.alive : null,
          contact: c ? (c.detected ? 'contact' : c.state) : 'none', q: this.queue.length,
        });
        return proto._releaseTarget.call(this, w, order, lost);
      };
    }
    // ログ
    const origLog = world.log;
    world.log = (msg, unit) => {
      const key = String(msg).replace(unit && unit.name ? unit.name : '', '').trim().slice(0, 30);
      if (!rec.logs[key]) rec.logs[key] = { n: 0, t: round(tick * DT, 1) };
      rec.logs[key].n++;
      try { return origLog && origLog.call(world, msg, unit); } catch (e) { /* 描画側の失敗は無視 */ }
    };
    world.onFire = (shooter, tgt, weapon, m) => {
      if (shooter === u) {
        if (ORD.includes(weapon.id)) {
          rec.fired[weapon.id]++;
          if (weapon.id === 'ARM' && rec.firstArmT == null) rec.firstArmT = round(tick * DT, 1);
          const r = { m, w: weapon.id, t0: tick * DT, dmg: 0, mem: false, minD: Infinity, done: false, tgt: tgt.name };
          rec.launchD[weapon.id].push(Math.hypot(tgt.pos.x - u.pos.x, tgt.pos.z - u.pos.z, tgt.pos.y - u.pos.y));
          mslRecs.set(m, r); rec.msl.push(r);
        }
      } else if (weapon.kind === 'sam' && shooter.side !== u.side) {
        rec.samFired++;
        if (rec.samFirstT == null) {
          rec.samFirstT = round(tick * DT, 1);
          rec.samFirstD = round(Math.hypot(shooter.pos.x - u.pos.x, shooter.pos.z - u.pos.z, shooter.pos.y - u.pos.y));
        }
        samMsl.push({ m, done: false });
      }
    };
    world.onMissileHit = null;

    const hplast = new Map(targets.map((g) => [g, g._silence || 0]));
    let killT = null, tick = 0, endReason = 'maxT', idleSince = null, deadAt = null;
    const maxTicks = Math.round(MAX_T / DT);
    const aaaOf = (g) => g.mounts.some((m) => m.w.kind === 'aaa');
    const samMount = (g) => g.mounts.find((m) => m.w.kind === 'sam');

    for (; tick < maxTicks; tick++) {
      AT.loop.onFixedUpdate(DT);
      AT.loop.simTime += DT;
      const t = (tick + 1) * DT;

      if (u.alive) {
        let nearest = Infinity, aaaIn = false, in19 = false, in19armed = false;
        for (const g of targets) {
          if (!g.alive) continue;
          const dh = Math.hypot(g.pos.x - u.pos.x, g.pos.z - u.pos.z);
          const d3 = Math.hypot(dh, u.pos.y - g.pos.y);
          if (dh < nearest) nearest = dh;
          const agl = u.pos.y - g.pos.y;
          if (aaaOf(g) && d3 <= 4500 && agl >= 0 && agl <= 2500) aaaIn = true;
          const sm = samMount(g);
          if (sm && d3 <= 19000) {
            in19 = true;
            if (g.radarActive && (g._silence || 0) <= 0 && sm.ammo > 0) in19armed = true;
          }
        }
        if (nearest < rec.minDist) rec.minDist = nearest;
        if (aaaIn) rec.secAAA += DT;
        if (in19) rec.sec19 += DT;
        if (in19armed) rec.sec19armed += DT;
      }
      // 沈黙の立ち上がり
      for (const g of targets) {
        const s = g._silence || 0;
        if (hplast.get(g) <= 0 && s > 0) rec.armSilences++;
        if (s > 0) rec.silSec += DT / targets.length;
        hplast.set(g, s);
      }
      // 探知の状態（先頭の目標）
      if (u.alive && primary.alive) {
        const c = world.detection.contactsFor(u.side).get(primary.id);
        if (!c) rec.det.none += DT;
        else if (c.detected) { rec.det.contact += DT; if (!c.approx) rec.det.exact += DT; }
        else if (c.state === 'memory') rec.det.memory += DT;
        else rec.det.lost += DT;
      }
      // 自分の弾・SAM の追跡
      for (const r of rec.msl) {
        if (r.done) continue;
        const m = r.m;
        if (m.alive) {
          if (r.w === 'ARM' && m.seekTarget && m.seekTarget.isPoint) r.mem = true;
          const tg = m.target;
          if (tg) { const d = Math.hypot(tg.pos.x - m.pos.x, tg.pos.z - m.pos.z); if (d < r.minD) r.minD = d; }
        } else {
          r.done = true;
          r.end = m.endReason; r.lost = !!m.lost; r.lostReason = m.lostReason || null;
          const tg = m.target;
          r.miss = tg ? Math.hypot(tg.pos.x - m.pos.x, tg.pos.z - m.pos.z) : null;
          r.tgtAliveAtEnd = tg ? tg.alive : null;
        }
      }
      for (const s of samMsl) {
        if (s.done) continue;
        if (!s.m.alive) {
          s.done = true;
          const e = s.m.endReason + (s.m.lost ? '/lost' : '');
          rec.samEnd[e] = (rec.samEnd[e] || 0) + 1;
          if (s.m.lost) rec.samLostReason[s.m.lostReason || '?'] = (rec.samLostReason[s.m.lostReason || '?'] || 0) + 1;
        }
      }
      if (u.alive && u.evading) rec.evadeSec += DT;
      // 次の目標へ（人が操作するなら、目標が死んだらすぐ次を指示する）
      if (u.alive && targets.length > 1) {
        const cur = u.order && u.order.type === 'attack' ? u.order.target : null;
        if (!cur || !cur.alive) {
          const nxt = targets.find((g) => g.alive);
          if (nxt) { u.setPlayerOrder({ type: 'attack', target: nxt }); applyAlt(); rec.reissued++; }
        }
      }
      // RTB
      if (u.alive && rec.rtbT == null && (u.aiMode === 'RTB' || (u.order && u.order.type === 'rtb'))) rec.rtbT = round(t, 1);

      const allDead = targets.every((g) => !g.alive);
      if (allDead && killT == null) killT = t;
      if (allDead && t - killT > 3) { endReason = 'killed'; break; }
      if (!u.alive) {
        if (deadAt == null) deadAt = t;
        const inFlight = rec.msl.some((r) => !r.done);
        if (!inFlight || t - deadAt > 60) { endReason = 'attacker_dead'; break; }
        continue;
      }
      // 兵装が尽きて弾も飛んでいない状態が45秒続いたら打ち切る（機銃掃射の様子は見える）
      const ordLeft = u.loadout.filter((w) => ORD.includes(w)).length;
      const inFlight = rec.msl.some((r) => !r.done);
      if (ordLeft === 0 && !inFlight) { if (idleSince == null) idleSince = t; if (t - idleSince > 45) { endReason = 'idle'; break; } }
      else idleSince = null;
    }
    world.onFire = null; world.onMissileHit = null; world.log = origLog;

    // ---- 仕上げ
    const ordLeft = u.loadout.filter((w) => ORD.includes(w)).length;
    let cause = null;
    if (!u.alive) {
      if (u.deathCause === 'terrain') cause = 'terrain';
      else if (u.deathCause) cause = u.deathCause;          // fuel / withdraw など
      else if (u.lastHit && u.lastHit.weapon === 'SAM-M') cause = 'sam';
      else if (u.lastHit && u.lastHit.weapon === 'GUN') cause = 'aaa';
      else cause = 'other:' + (u.lastHit ? u.lastHit.weapon : '?');
    }
    const out = {
      tgt: cfg.tgt, lo: cfg.lo, k, seed: cfg.seed, alt: cfg.alt == null ? 'auto' : cfg.alt,
      killed: targets.every((g) => !g.alive), killT: killT != null ? round(killT, 1) : null,
      tgtMove: round(Math.hypot(primary.pos.x - p0.x, primary.pos.z - p0.z)),
      tgtHpLeft: round(sum(targets.map((g) => g.hp))), tgtHpMax: round(sum(targets.map((g) => g.spec.hp))),
      uAlive: u.alive, cause, deathT: deadAt != null ? round(deadAt, 1) : null,
      uDmg: { sam: round(rec.uDmg.sam), aaa: round(rec.uDmg.aaa), other: round(rec.uDmg.other) },
      uHits: rec.uHits,
      fired: rec.fired, firedTotal: sum(Object.values(rec.fired)),
      launchD: Object.fromEntries(ORD.map((w) => [w, round(mean(rec.launchD[w]) / 1000, 1)])),
      dmgW: Object.fromEntries(Object.entries(rec.dmgW).map(([a, b]) => [a, round(b)])),
      dmgKind: Object.fromEntries(Object.entries(rec.dmgKind).map(([a, b]) => [a, round(b)])),
      dmgByW: Object.fromEntries(Object.entries(rec.dmgByW).map(([a, b]) => [a, round(b)])),
      samFired: rec.samFired, samHits: rec.uHits.sam, samEnd: rec.samEnd, samLostReason: rec.samLostReason,
      ammoLeft: targets.map((g) => { const m = samMount(g); return m ? m.ammo : null; }).filter((x) => x != null),
      ammoOut: targets.some((g) => { const m = samMount(g); return m && m.ammo <= 0; }),
      armSilences: rec.armSilences, silSec: round(rec.silSec, 1),
      msl: rec.msl.map((r) => ({
        w: r.w, end: r.end || 'alive', lost: r.lost || false, lr: r.lostReason || null, mem: r.mem,
        dmg: round(r.dmg), miss: round(r.miss), minD: round(r.minD),
      })),
      secAAA: round(rec.secAAA, 1), sec19: round(rec.sec19, 1), sec19armed: round(rec.sec19armed, 1),
      minDist: Number.isFinite(rec.minDist) ? round(rec.minDist) : null,
      det: Object.fromEntries(Object.entries(rec.det).map(([a, b]) => [a, round(b, 1)])),
      releases: rec.releases, rtbT: rec.rtbT, logs: rec.logs,
      evadeSec: round(rec.evadeSec, 1), chaffUsed: chaff0 - u.chaff, flareUsed: flare0 - u.flares, reissued: rec.reissued,
      samFirstT: rec.samFirstT, samFirstD: rec.samFirstD, firstHitT: rec.firstHitT, firstArmT: rec.firstArmT,
      ordLeft, gunUsed: gunStart - u.gun, endOrder: u.order ? u.order.type : null,
      aborted: u.alive && ordLeft > 0 && !targets.every((g) => !g.alive) && !(u.order && u.order.type === 'attack'),
      endT: round(tick * DT, 1), endReason,
    };
    return out;
  };

  // ---------------------------------------------------------------- 全体
  window.__ssRuns = window.__ssRuns || [];
  window.__ssRunAll = async (opts = {}) => {
    const tgts = opts.tgts || TGT_KEYS, los = opts.los || Object.keys(LOADOUTS);
    const ks = opts.ks || [0, 1, 2, 3, 4, 5], seeds = opts.seeds || [0x5A1001, 0x5A1002];
    const alts = opts.alts || ['auto', 4500];
    const list = [];
    for (const alt of alts) for (const tgt of tgts) for (const lo of los) for (const k of ks) for (const seed of seeds) list.push({ tgt, lo, k, seed, alt });
    window.__ssProgress = { done: 0, total: list.length, t0: performance.now(), err: null };
    for (const cfg of list) {
      try {
        const r = await window.__ssOne(cfg);
        window.__ssRuns.push(r);
      } catch (e) {
        window.__ssProgress.err = `${cfg.tgt}/${cfg.lo}/${cfg.k}: ${String((e && e.stack) || e).slice(0, 300)}`;
        window.__ssRuns.push({ tgt: cfg.tgt, lo: cfg.lo, k: cfg.k, seed: cfg.seed, alt: cfg.alt, error: true });
      }
      window.__ssProgress.done++;
    }
    window.__ssProgress.sec = round((performance.now() - window.__ssProgress.t0) / 1000);
    return window.__ssProgress;
  };

  // ---------------------------------------------------------------- 分割実行（iframe を使い捨てる）
  // 1バトルごとに地形メッシュ等が解放されず、約190走で "Array buffer allocation failed" になる
  // （main.js の buildBattle → Terrain.buildMesh。実測: 194走目で失敗）。ゲーム本体は直せないので、
  // 親ページから iframe を chunk 走ごとに作り直して回す。結果は親の window.__ssRuns に貯める。
  // 使い方（親ページ＝アプリを開いたタブ）:
  //   window.__ssDrive({chunk:80}).then(r => window.__ssDriveResult = r)   // fire-and-forget
  //   window.__ssProgress を見る。
  window.__ssDrive = async (opts = {}) => {
    const tgts = opts.tgts || TGT_KEYS, los = opts.los || Object.keys(LOADOUTS);
    const ks = opts.ks || [0, 1, 2, 3, 4, 5], seeds = opts.seeds || [0x5A1001, 0x5A1002];
    const alts = opts.alts || ['auto', 4500];
    const chunk = opts.chunk || 80, from = opts.from || 0;
    const list = [];
    for (const alt of alts) for (const tgt of tgts) for (const lo of los) for (const k of ks) for (const seed of seeds) list.push({ tgt, lo, k, seed, alt });
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const harness = await fetch('/tools/_tut_harness.js').then((r) => r.text());
    const probe = await fetch('/tools/_samshipprobe.js').then((r) => r.text());
    window.__ssProgress = { done: from, total: list.length, t0: performance.now(), err: null, frames: 0 };
    window.__ssRuns = window.__ssRuns || [];
    for (let s = from; s < list.length; s += chunk) {
      const fr = document.createElement('iframe');
      fr.src = '/';
      fr.style.cssText = 'position:fixed;left:0;top:0;width:640px;height:400px;border:0;';
      document.body.appendChild(fr);
      let ready = false;
      for (let i = 0; i < 600 && !ready; i++) { await sleep(100); try { ready = !!fr.contentWindow.AT_READY && !!fr.contentWindow.AT; } catch (e) { /* 読み込み中 */ } }
      if (!ready) { window.__ssProgress.err = 'iframe not ready'; fr.remove(); break; }
      fr.contentWindow.eval(harness);
      fr.contentWindow.eval(probe);
      window.__ssProgress.frames++;
      for (const cfg of list.slice(s, s + chunk)) {
        try {
          const r = await fr.contentWindow.__ssOne(cfg);
          window.__ssRuns.push(JSON.parse(JSON.stringify(r)));
        } catch (e) {
          window.__ssProgress.err = `${cfg.tgt}/${cfg.lo}/${cfg.k}: ${String((e && e.stack) || e).slice(0, 300)}`;
          window.__ssRuns.push({ tgt: cfg.tgt, lo: cfg.lo, k: cfg.k, seed: cfg.seed, alt: cfg.alt, error: true });
        }
        window.__ssProgress.done++;
      }
      fr.src = 'about:blank';
      await sleep(300);
      fr.remove();
      await sleep(2500);
    }
    window.__ssProgress.sec = round((performance.now() - window.__ssProgress.t0) / 1000);
    return window.__ssProgress;
  };

  // ---------------------------------------------------------------- 集計
  window.__ssAgg = (filter) => {
    const runs = window.__ssRuns.filter((r) => !r.error && (!filter || filter(r)));
    const groups = {};
    for (const r of runs) (groups[`${r.alt}|${r.tgt}|${r.lo}`] ||= []).push(r);
    const rows = [];
    for (const [key, g] of Object.entries(groups)) {
      const n = g.length;
      const kills = g.filter((r) => r.killed);
      const losses = g.filter((r) => !r.uAlive);
      const cnt = (f) => g.filter(f).length;
      const firedSum = sum(g.map((r) => r.firedTotal));
      const dmgSum = sum(g.map((r) => r.dmgW.ARM + r.dmgW.AGM + r.dmgW.BOMB));
      rows.push({
        key, n,
        kill: kills.length, killT: round(median(kills.map((r) => r.killT)), 0),
        loss: losses.length,
        lossSam: cnt((r) => r.cause === 'sam'), lossAaa: cnt((r) => r.cause === 'aaa'),
        lossOther: cnt((r) => !r.uAlive && r.cause !== 'sam' && r.cause !== 'aaa'),
        fired: round(firedSum / n, 2),
        dmgPerShot: firedSum ? round(dmgSum / firedSum, 1) : null,
        dmgGun: round(sum(g.map((r) => r.dmgW.GUN)) / n, 1),
        samFired: round(mean(g.map((r) => r.samFired)), 1), samHit: round(mean(g.map((r) => r.samHits)), 2),
        samDmg: round(mean(g.map((r) => r.uDmg.sam)), 0), aaaDmg: round(mean(g.map((r) => r.uDmg.aaa)), 0),
        ammoOut: cnt((r) => r.ammoOut),
        armSil: round(mean(g.map((r) => r.armSilences)), 2),
        secAAA: round(mean(g.map((r) => r.secAAA)), 1), sec19: round(mean(g.map((r) => r.sec19)), 0),
        sec19armed: round(mean(g.map((r) => r.sec19armed)), 0),
        minD: round(median(g.map((r) => r.minDist)), 0),
        ordLeft: round(mean(g.map((r) => r.ordLeft)), 2), aborted: cnt((r) => r.aborted),
        rtb: cnt((r) => r.rtbT != null),
      });
    }
    return rows;
  };
})();
