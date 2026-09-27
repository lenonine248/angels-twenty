// 手動モードの機体がチャフを撒くかを測る（JOURNAL §94。直したあとの9通りは §94.5）。
//
//   fetch('/tools/_tut_harness.js').then(r => r.text()).then(eval)
//   fetch('/tools/_manualchaff.js').then(r => r.text()).then(eval)
//   await __mc({ mode: 'MANUAL', fly: 'beam' })
//
// 舞台は w3 の地形と2機だけ借りる（チュートリアルの手順は進めない）。
// 敵の BANDIT 1 に AAM-M を1発持たせて自機 VIPER 1 へ撃たせ、発射機は毎刻み自機へ機首を向けて
// 照らし続ける。自機は**プレイヤーの経路**（HUD の `_setMode` と `setPlayerOrder`）で
// 手動にし、照射源に対して真横（beam）・真後ろ（run）・そのまま（hot）へ飛ばす。
// `hold: true` は3秒ごとに真横を指示し直す（視線が回っても真横を保つ、まめなプレイヤー）。
(() => {
  const DT = 1 / 30;
  const ang = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };

  window.__mc = async ({
    mode = 'MANUAL', fly = 'beam', hold = true, range = 15000,
    shooterAlt = 7000, targetAlt = 5000, maxT = 70, side = 1,
  } = {}) => {
    await __open('w3');
    const { WEAPONS } = await import('/js/data/weapons.js');
    const M = await import('/js/sim/missile.js');
    const w = AT.battle.world;
    const me = __u('VIPER 1'), sh = __u('BANDIT 1');

    // 配置: 自機の真北 range に発射機。自機は発射機へ機首を向けて始める（正対）
    const gz = (x, z) => Math.max(0, w.terrain.heightAt(x, z));
    me.pos.set(me.pos.x, gz(me.pos.x, me.pos.z) + targetAlt, me.pos.z);
    me.heading = 0;
    sh.pos.set(me.pos.x, gz(me.pos.x, me.pos.z - range) + shooterAlt, me.pos.z - range);
    sh.heading = Math.PI;
    sh.skill = 1;
    sh.loadout = ['AAM-M'];

    AT.commands.select([me]);
    AT.hud._setMode(mode);
    me.setPlayerOrder({ type: 'move', x: me.pos.x, z: me.pos.z - 60000, alt: me.pos.y });

    const aim = () => sh.setOrder({ type: 'move', x: me.pos.x, z: me.pos.z, alt: sh.pos.y });
    const steer = () => {
      const los = Math.atan2(me.pos.x - sh.pos.x, -(me.pos.z - sh.pos.z));   // 照射源→自機
      const h = fly === 'beam' ? los + side * Math.PI / 2 : fly === 'run' ? los : los + Math.PI;
      me.setPlayerOrder({ type: 'move', x: me.pos.x + Math.sin(h) * 60000,
        z: me.pos.z - Math.cos(h) * 60000, alt: me.pos.y });
    };

    const chaff0 = me.chaff, flare0 = me.flares;
    const step = () => { aim(); AT.loop.onFixedUpdate(DT); AT.loop.simTime += DT; };
    for (let i = 0; i < 30; i++) step();                       // 1秒ならす
    const m = w.combat.fire(sh, me, WEAPONS['AAM-M']);
    if (!m) return 'fire failed';
    if (fly !== 'hot') steer();

    const s = { frames: 0, threat: 0, geoBeam: 0, geoRun: 0, flagged: 0,
      inTti: 0, gateOnly: 0, notchMax: 0, notchSum: 0, screenMax: 0, painting: 0 };
    let t = 0, after = 0, minD = Infinity, firstChaffT = null;
    const decoyStart = me._decoyStartTti();
    while (t < maxT && after < 3 && me.alive) {
      if (hold && fly !== 'hot' && Math.round(t / DT) % 90 === 0) steer();
      step(); t += DT;
      if (!m.alive) { after += DT; continue; }
      s.frames++;
      minD = Math.min(minD, m.pos.distanceTo(me.pos));
      if (m.painting) s.painting++;
      if (!me.threats.length) continue;
      s.threat++;
      const los = Math.atan2(me.pos.x - sh.pos.x, -(me.pos.z - sh.pos.z));
      const off = Math.abs(Math.abs(ang(los - me.heading)) - Math.PI / 2);
      if (off < M.NOTCH_TOLERANCE) s.geoBeam++;
      if (Math.abs(ang(los - me.heading)) < 35 * Math.PI / 180) s.geoRun++;
      if (me.running || me.beaming) s.flagged++;
      const nq = M.notchQuality(sh, me, w), sc = M.chaffScreen(sh, me, w);
      s.notchMax = Math.max(s.notchMax, nq); s.notchSum += nq;
      s.screenMax = Math.max(s.screenMax, sc);
      const d = Math.hypot(m.pos.x - me.pos.x, m.pos.z - me.pos.z);
      const tti = d / Math.max(60, m.speed);
      if (tti < decoyStart) {
        s.inTti++;
        // 残り時間は届いているのに、機動の旗だけで止められている刻み
        if (!me.running && !me.beaming && me.chaff > 0) s.gateOnly++;
      }
      if (firstChaffT == null && me.chaff < chaff0) firstChaffT = +t.toFixed(1);
    }
    const r = (n) => +(n * DT).toFixed(1);
    return {
      mode, fly, hold, range,
      chaffUsed: chaff0 - me.chaff, flaresUsed: flare0 - me.flares, firstChaffT,
      threatSec: r(s.threat), geoBeamSec: r(s.geoBeam), geoRunSec: r(s.geoRun), flagSec: r(s.flagged),
      inDecoyTtiSec: r(s.inTti), gateOnlySec: r(s.gateOnly), decoyStartTti: +decoyStart.toFixed(1),
      notchMax: +s.notchMax.toFixed(2), notchMean: s.threat ? +(s.notchSum / s.threat).toFixed(3) : 0,
      screenMax: +s.screenMax.toFixed(2),
      outcome: !me.alive ? 'hit' : m.lostReason || (m.alive ? 'flying' : 'miss'),
      minD: Math.round(minD), missileSec: r(s.frames),
    };
  };

  return 'manualchaff ready';
})();
