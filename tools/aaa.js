// 対空砲の検証。仕様書 §51。
//
//   fetch('/tools/aaa.js').then(r=>r.text()).then(eval)
//   await AT.aaa.sweep()        // 3種の砲を高度ごとに通過して、どこから当たるかを測る
//   await AT.aaa.strike()       // 対地攻撃モードのAIが砲の圏をどう通るかを測る
//
// **検証用ステージ `d1` を使う**（デバッグモードで出る）。本編のステージでは測れない —
// 実測で司令官AIは対空砲の射程3kmに一度も入らなかった（最接近 3,563m）。
// 手前で全滅するか未達で終わるので、発砲そのものが起きない。
//
// `d1` は 12km 間隔で 対空砲 / 敵飛行場 / 艦船 を1基ずつ並べてある。
// こちらは武装なし・機銃も切ってあるので、**撃たれる側だけ**を切り出せる。

(function () {
  const DT = 1 / 30;
  const STAGE = () => AT.stageList().findIndex((s) => s.id === 'd1');

  let hooked = false;

  /**
   * 対空砲のダメージを記録する。**一度だけ**取り付ける。
   *
   * `Unit.prototype.damage` を包む。ここでしか発生源が分からない —
   * 弾幕はミサイルと違って実体が無く、`_updateAaa` から直接呼ばれるため。
   */
  async function hook() {
    if (hooked) return;
    const { Unit } = await import('/js/sim/unit.js');
    const orig = Unit.prototype.damage;
    Unit.prototype.damage = function (amount, source) {
      const wpn = source && source.spec && source.spec.weapon;
      if (wpn && wpn.kind === 'aaa' && this.kind === 'aircraft' && window.__aaaLog) {
        const w = window.__aaaW;
        window.__aaaLog.push({
          t: +(window.__aaaT || 0).toFixed(1),
          unit: this.name,
          src: source.spec.id,
          amount,
          d: Math.round(this.pos.distanceTo(source.pos)),
          agl: Math.round(this.pos.y - Math.max(0, w.terrain.heightAt(this.pos.x, this.pos.z))),
        });
      }
      return orig.call(this, amount, source);
    };
    hooked = true;
  }

  /** 戦闘を組んで凍らせる。bench.runOne と同じ待ち方をする */
  function open(seed) {
    return new Promise((resolve) => {
      const prev = AT.battle;
      AT.startStage(STAGE(), seed);
      const wait = () => {
        if (!AT.battle || AT.battle === prev) { requestAnimationFrame(wait); return; }
        AT.loop.setPaused(true);
        resolve(AT.battle);
      };
      requestAnimationFrame(wait);
    });
  }

  /** 手で1ステップ進める（描画を回さない） */
  function step(b) {
    const w = b.world;
    for (const u of w.units) if (u.alive) u.update(DT, w);
    for (const m of w.missiles) if (m.alive) m.update(DT, w);
    if (w.bullets) for (const p of w.bullets) if (p.alive) p.update(DT, w);
    w.detection.update(DT);
    b.pilotAI.update(DT);
    b.combat.update(DT);
    b.mission.update(DT);
    window.__aaaT = (window.__aaaT || 0) + DT;
  }

  const gunOf = (w, id) => w.units.find((u) => u.spec && u.spec.id === id && u.side === 'red');

  /** 観測機を1機だけ残す。同時に撃たれると発生源が読めない */
  function soloProbe(w) {
    const mine = w.units.filter((u) => u.kind === 'aircraft' && u.side === w.playerSide);
    for (let i = 1; i < mine.length; i++) mine[i].alive = false;
    return mine[0];
  }

  function summarize(probe, gun, minD, aglAtMin) {
    const log = window.__aaaLog;
    const dmg = log.reduce((n, r) => n + (r.amount || 0), 0);
    return {
      最接近: Math.round(minD),
      最接近時AGL: Math.round(aglAtMin),
      被弾開始: log.length ? log[0].d : null,
      被弾開始時AGL: log.length ? log[0].agl : null,
      被弾: +dmg.toFixed(1),
      残HP: Math.round(Math.max(0, probe.hp)),
      撃墜: !probe.alive,
      圏内秒: +(log.length * DT).toFixed(1),
    };
  }

  /**
   * 1回の通過。砲の西 `lead` m から東へまっすぐ飛ばす。
   *
   * **AIモードは MANUAL。** 回避も目標選択もさせない。
   * 「その高度・その距離で当たるか」だけを見たいので、機動が混ざると読めなくなる。
   */
  async function pass(gunId, agl, opts = {}) {
    await hook();
    const lead = opts.lead ?? 7000;
    const tail = opts.tail ?? 6000;
    const b = await open(opts.seed ?? 11);
    const w = b.world;
    window.__aaaW = w; window.__aaaT = 0; window.__aaaLog = [];

    const gun = gunOf(w, gunId);
    const probe = soloProbe(w);
    const gy = Math.max(0, w.terrain.heightAt(gun.pos.x - lead, gun.pos.z));
    probe.pos.set(gun.pos.x - lead, gy + agl, gun.pos.z);
    probe.heading = Math.PI / 2;              // 東
    probe.pitch = 0;
    probe.speed = opts.speed ?? probe.spec.cruiseSpeed;
    probe.aiMode = 'MANUAL';
    probe.hp = probe.maxHp;
    probe.setOrder({ type: 'move', x: gun.pos.x + tail, z: gun.pos.z, alt: gy + agl });

    let minD = Infinity, aglAtMin = 0;
    const limit = (lead + tail) / Math.max(1, probe.speed) + 30;
    for (let t = 0; t < limit; t += DT) {
      step(b);
      if (!probe.alive) break;
      const d = probe.pos.distanceTo(gun.pos);
      if (d < minD) {
        minD = d;
        aglAtMin = probe.pos.y - Math.max(0, w.terrain.heightAt(probe.pos.x, probe.pos.z));
      }
      if (probe.pos.x > gun.pos.x + tail * 0.9) break;
    }
    return Object.assign({ 砲: gunId, 指定AGL: agl }, summarize(probe, gun, minD, aglAtMin));
  }

  /** 3種 × 高度の総当たり */
  async function sweep(opts = {}) {
    const alts = opts.alts || [300, 600, 1000, 1400, 1700, 2000, 2400, 2800, 3500];
    const rows = [];
    for (const id of (opts.guns || ['AAA', 'AIRBASE', 'SHIP'])) {
      for (const agl of alts) rows.push(await pass(id, agl, opts));
    }
    console.table(rows);
    return rows;
  }

  /**
   * 対地攻撃モードのAIが、砲の圏をどう通るか。
   *
   * `d1` の機体は無武装なので、ここでだけ AGM を積ませる
   * （撃たせるためではなく、`_checkWinchester` で勝手に帰投させないため）。
   * 自動使用は切ってあるので**撃たない**。飛び方だけを見る。
   */
  async function strike(opts = {}) {
    await hook();
    const b = await open(opts.seed ?? 11);
    const w = b.world;
    window.__aaaW = w; window.__aaaT = 0; window.__aaaLog = [];

    const gun = gunOf(w, opts.gun || 'AAA');
    const probe = soloProbe(w);
    probe.loadout = ['AGM', 'AGM'];
    probe.autoWeapons = { AGM: false, GUN: false };
    probe.aiMode = 'STRIKE';
    probe.hp = probe.maxHp;
    probe.strikeTarget = gun;
    probe.setOrder({ type: 'attack', target: gun });

    const prof = [];
    let minD = Infinity, aglAtMin = 0, tick = 0;
    for (let t = 0; t < (opts.seconds || 400); t += DT) {
      step(b);
      if (!probe.alive) break;
      const d = probe.pos.distanceTo(gun.pos);
      const agl = probe.pos.y - Math.max(0, w.terrain.heightAt(probe.pos.x, probe.pos.z));
      if (d < minD) { minD = d; aglAtMin = agl; }
      if (tick++ % 150 === 0) prof.push({ t: Math.round(t), d: Math.round(d), agl: Math.round(agl) });
      if (d < 300) break;
    }
    const out = Object.assign({ 砲: opts.gun || 'AAA' }, summarize(probe, gun, minD, aglAtMin));
    console.table(prof);
    console.log(out);
    return { out, prof };
  }

  AT.aaa = { pass, sweep, strike, open, step };
  return 'AT.aaa ready';
})();
