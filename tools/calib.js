// 命中期待度の較正ハーネス。仕様書 §28.8。
//
//   fetch('/tools/bench.js').then(r=>r.text()).then(eval)
//   fetch('/tools/calib.js').then(r=>r.text()).then(eval)
//   await AT.calib.run([0,1,5], [11,22,33,44,55,66])
//   AT.calib.report()
//
// **発射ごとに「そのとき予測した命中期待度」と「実際どうなったか」を対で残す。**
// これが無いと、期待度の式は当てずっぽうでしか触れない。実際 Beta 2.14 時点では
// 266発すべてが「中」に落ち、予測は 0.35〜0.49 しか出ていなかった（§28.0）。
//
// 外れた理由も分ける。当たらない理由の内訳が分からないと、
// どこを触ればいいかが決まらない（デコイ41% / 誘導喪失29% / 命中30%）。

(function () {
  const rows = [];
  const battles = [];   // §105.4: 同じ周回のベンチの結末（クリア・損失）。見積りを触ったときの A/B 用

  /**
   * world のコールバックに割り込む。
   *
   * `tools/bench.js` の step() は `world.onFire` を**代入で上書きする**ので、
   * 素直に代入すると自分のフックが消える（実際に消えて 0 件になった）。
   * getter/setter を挟んで、代入されても自分の分は残るようにする。
   */
  function wrap(obj, key, mine) {
    let inner = obj[key];
    Object.defineProperty(obj, key, {
      configurable: true,
      get() { return (...a) => { mine(...a); if (inner) inner(...a); }; },
      set(v) { inner = v; },
    });
  }

  function setup(estimate, effRange) {
    return (b) => {
      const shots = new Map();
      const nthOf = new Map();
      const rNOf = new Map();
      wrap(b.world, 'onFire', (sh, tg, wp, m) => {
        if (!m || wp.kind !== 'aam') return;
        shots.set(m, {
          // 本体が発射の直前に付けた見込みを使う（§105.6）。onFire は発射の**後**に呼ばれ、
          // そのときにはもう「この陣営は撃った」が付いているので、ここで計算し直すと初弾が初弾に見えない
          p: m.pk ?? estimate(sh, tg, wp, b.combat.aimErrorOf(sh, tg)),
          w: wp.id,
          km: +(sh.pos.distanceTo(tg.pos) / 1000).toFixed(1),
          alt: Math.round(sh.pos.y),
          // §104.5: 1v1 で外れを決めていたのは距離ではなく上下の位置関係と目標のチャフの残りだった。面でも同じかを見る
          dAlt: Math.round(sh.pos.y - tg.pos.y),                 // 撃つ側−目標（負＝撃ち上げ）
          tAgl: Math.round(tg.pos.y - Math.max(0, b.world.terrain.heightAt(tg.pos.x, tg.pos.z))),
          tChaff: tg.chaff ?? null,
          // §105.3: チャフの残りは見積りが見てはいけない量（§38）。代わりに見てよい量で割れるかを見る
          tFlares: tg.flares ?? null,
          tType: tg.typeId ?? tg.kind,
          tSpd: Math.round(tg.speed || 0),
          tUf: !!(tg.threats && tg.threats.some((x) => x !== m)),   // 目標は既に別の弾に追われているか
          nth: (nthOf.set(tg, (nthOf.get(tg) || 0) + 1), nthOf.get(tg)), // この目標へ何発目か
          // §105.6: この目標へのレーダー弾の何発目か（見積りの「初弾」は 1）
          rN: wp.guidance === 'ir' ? 0 : (rNOf.set(tg, (rNOf.get(tg) || 0) + 1), rNOf.get(tg)),
          tEv: false, tCrank: false, qN: 0, qS: 0,
          // §105.4: 見積りの距離の項が見る量（実効射程に対する割合）と、機種の区別・アスペクト（estimateHitChance と同じ定義）
          frac: +(sh.pos.distanceTo(tg.pos) / Math.max(1, effRange(wp, (sh.pos.y + tg.pos.y) * 0.5))).toFixed(3),
          noAB: !!(tg.spec && tg.spec.noAfterburner),
          asp: +(Math.abs(Math.atan2(Math.sin(Math.atan2(sh.pos.x - tg.pos.x, -(sh.pos.z - tg.pos.z)) - (tg.heading || 0)),
            Math.cos(Math.atan2(sh.pos.x - tg.pos.x, -(sh.pos.z - tg.pos.z)) - (tg.heading || 0)))) / Math.PI).toFixed(2),
          uf: !!(sh.threats && sh.threats.length),
          tAir: tg.kind === 'aircraft' && !tg.onGround,
          side: sh.side === b.world.playerSide ? 'blue' : 'red',
          結末: '未',
        });
      });
      // §105.3: 飛翔中に目標が回避したか・妨害の最大（_j13rangeprobe と同じ取り方）。
      // 「チャフの残り」で割れた差が、実は「回避するかどうか」ではないかを見る
      const det = b.world.detection;
      const prevU = det.update;
      det.update = (dt) => {
        prevU.call(det, dt);
        for (const [m, s] of shots) {
          if (s._done) continue;
          if (!m.alive) { s._done = true; continue; }
          const tg = m.target;
          if (!tg || !tg.pos) continue;
          if (tg.evading) s.tEv = true;
          if (tg.cranking) s.tCrank = true;
          if (m._notchQuality) {
            try {
              const qn = m._notchQuality(b.world, tg), qs = m._screenQuality(b.world, tg);
              if (!(s.qN >= qn)) s.qN = Math.round(qn * 100) / 100;
              if (!(s.qS >= qs)) s.qS = Math.round(qs * 100) / 100;
            } catch (e) { s.qErr = String(e).slice(0, 60); }
          }
        }
      };
      wrap(b.world, 'onMissileHit', (m) => { const s = shots.get(m); if (s) s.結末 = '命中'; });
      wrap(b.world, 'onDecoyed', (m) => { const s = shots.get(m); if (s && s.結末 === '未') s.結末 = 'デコイ'; });
      b._calibShots = shots;
    };
  }

  async function run(stages, seeds) {
    const mod = await import('/js/sim/combat.js');
    const est = mod.estimateHitChance;
    const { effectiveMissileRange } = await import('/js/core/atmosphere.js');
    for (const i of stages) {
      for (const seed of seeds) {
        const res = await AT.bench.runOne(i, false, { seed, setup: setup(est, effectiveMissileRange) });
        battles.push({ stg: i, seed, state: res && res.state, losses: res && res.losses, kills: res && res.kills, sec: res && res.sec });
        for (const [m, s] of AT.battle._calibShots) {
          if (s.結末 === '未') s.結末 = m.lost ? '誘導喪失' : '外れ';
          if (m.lost) s.理由 = m.lostReason || '?';
          s.stg = i;
          rows.push(s);
        }
      }
    }
    return rows.length;
  }

  function reset() { rows.length = 0; battles.length = 0; }

  const rate = (g) => (g.length ? g.filter((r) => r.結末 === '命中').length / g.length : null);
  const mean = (g) => (g.length ? g.reduce((n, r) => n + r.p, 0) / g.length : null);
  // **「目標消失」は分母から外す**（§105.4）。別の弾が先に落とした目標へ向かっていた弾で、
  // この弾の外れではない。数えると、撃ち重ねの多い AAM-S が 0.84 → 0.74 に低く出ていた。
  // 見積りは「目標が残っていれば当たるか」を言う量なので、それに揃える。
  const gone = (r) => r.理由 === '目標消失';
  const fmt = (g0) => {
    const g = g0.filter((r) => !gone(r));
    const k = g0.length - g.length;
    return g.length
      ? `n=${String(g.length).padStart(3)} 予測${mean(g).toFixed(2)} 実測${rate(g).toFixed(2)} 差${(mean(g) - rate(g)).toFixed(2)}${k ? ` (消失${k})` : ''}`
      : `n=0${k ? ` (消失${k})` : ''}`;
  };

  function report() {
    const out = { 総発射: rows.length };

    const cnt = {};
    for (const r of rows) cnt[r.結末] = (cnt[r.結末] || 0) + 1;
    out.結末 = Object.entries(cnt)
      .map(([k, v]) => `${k} ${v} (${Math.round((v / rows.length) * 100)}%)`);

    out.全体 = fmt(rows);

    const ps = rows.map((r) => r.p).sort((a, b) => a - b);
    out.期待度の幅 = rows.length
      ? `最小${ps[0].toFixed(2)} 中央${ps[Math.floor(ps.length / 2)].toFixed(2)} 最大${ps[ps.length - 1].toFixed(2)}`
      : '-';

    out.距離帯 = [[0, 4], [4, 8], [8, 14], [14, 30]].map(([a, z]) =>
      `${a}〜${z}km: ${fmt(rows.filter((r) => r.km >= a && r.km < z))}`);

    out.兵装 = ['AAM-S', 'AAM-M', 'AAM-A'].map((w) =>
      `${w}: ${fmt(rows.filter((r) => r.w === w))}`);

    // 表示ラベルが出分かれているか。これが §28.8 の検収条件
    out.表示 = [['低', 0, 0.15], ['中', 0.15, 0.35], ['高', 0.35, 1.01]].map(([lab, a, z]) =>
      `${lab}: ${fmt(rows.filter((r) => r.p >= a && r.p < z))}`);

    console.log(out);
    return out;
  }

  /**
   * AAM-M（空の目標・撃たれていない側）を「上下の位置関係 × 目標のチャフの残り」で割る（§104.5）。
   * 帯: 撃ち上げ dAlt < −500 / 同高度 ±500 / 撃ち下ろし > +500。チャフ 0 / 1〜5 / 6以上
   */
  function split(weapon = 'AAM-M') {
    const xs = rows.filter((r) => r.w === weapon && r.tAir && !r.uf);
    const vb = (d) => (d < -500 ? '上げ' : d > 500 ? '下ろし' : '同高度');
    const cb = (c) => (c == null ? '?' : c === 0 ? 'c0' : c <= 5 ? 'c1-5' : 'c6+');
    const kb = (k) => (k < 8 ? '<8' : k < 14 ? '8-14' : '14+');
    const out = {};
    for (const r of xs) {
      const key = `${vb(r.dAlt)} ${cb(r.tChaff)} ${kb(r.km)}km`;
      (out[key] = out[key] || []).push(r);
    }
    const res = {};
    for (const k of Object.keys(out).sort()) res[k] = fmt(out[k]);
    res['(撃たれている側)'] = fmt(rows.filter((r) => r.w === weapon && r.tAir && r.uf));
    return res;
  }

  /**
   * 任意の鍵で割る（§105.3）。`AT.calib.by((r) => r.tType, { w: 'AAM-M' })`
   * filter の既定は「空の目標・撃たれていない側」（split と同じ母集団）
   */
  function by(key, { w = 'AAM-M', filter = (r) => r.tAir && !r.uf } = {}) {
    const out = {};
    for (const r of rows) {
      if (r.w !== w || !filter(r)) continue;
      const k = String(key(r));
      (out[k] = out[k] || []).push(r);
    }
    const res = {};
    for (const k of Object.keys(out).sort()) res[k] = fmt(out[k]);
    return res;
  }

  /** 同じ周回のベンチ（§105.4）。面ごとのクリア数と損失の合計 */
  function bench() {
    const out = {};
    for (const x of battles) {
      const o = (out[x.stg] = out[x.stg] || { clear: 0, n: 0, losses: 0 });
      o.n++; if (x.state === 'clear') o.clear++; o.losses += x.losses || 0;
    }
    return Object.entries(out).map(([k, o]) => `面${k} ${o.clear}/${o.n} 損失${o.losses}`);
  }

  AT.calib = { run, report, split, by, bench, reset, rows, battles };
  return 'calib ready';
})();
