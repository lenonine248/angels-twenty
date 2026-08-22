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

  function setup(estimate) {
    return (b) => {
      const shots = new Map();
      wrap(b.world, 'onFire', (sh, tg, wp, m) => {
        if (!m || wp.kind !== 'aam') return;
        shots.set(m, {
          p: estimate(sh, tg, wp, b.combat.aimErrorOf(sh, tg)),
          w: wp.id,
          km: +(sh.pos.distanceTo(tg.pos) / 1000).toFixed(1),
          alt: Math.round(sh.pos.y),
          結末: '未',
        });
      });
      wrap(b.world, 'onMissileHit', (m) => { const s = shots.get(m); if (s) s.結末 = '命中'; });
      wrap(b.world, 'onDecoyed', (m) => { const s = shots.get(m); if (s && s.結末 === '未') s.結末 = 'デコイ'; });
      b._calibShots = shots;
    };
  }

  async function run(stages, seeds) {
    const mod = await import('/js/sim/combat.js');
    const est = mod.estimateHitChance;
    for (const i of stages) {
      for (const seed of seeds) {
        await AT.bench.runOne(i, false, { seed, setup: setup(est) });
        for (const [m, s] of AT.battle._calibShots) {
          if (s.結末 === '未') s.結末 = m.lost ? '誘導喪失' : '外れ';
          rows.push(s);
        }
      }
    }
    return rows.length;
  }

  function reset() { rows.length = 0; }

  const rate = (g) => (g.length ? g.filter((r) => r.結末 === '命中').length / g.length : null);
  const mean = (g) => (g.length ? g.reduce((n, r) => n + r.p, 0) / g.length : null);
  const fmt = (g) => (g.length
    ? `n=${String(g.length).padStart(3)} 予測${mean(g).toFixed(2)} 実測${rate(g).toFixed(2)} 差${(mean(g) - rate(g)).toFixed(2)}`
    : 'n=0');

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

  AT.calib = { run, report, reset, rows };
  return 'calib ready';
})();
