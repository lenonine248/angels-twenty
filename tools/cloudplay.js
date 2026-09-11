// 雲が司令官AIの判断に何をしているかを測る。仕様書 §88.8 の段取り3。
//
//   fetch('/tools/bench.js').then(r=>r.text()).then(eval)
//   fetch('/tools/cloudplay.js').then(r=>r.text()).then(eval)
//   await AT.cloudplay.all()          // 雲のある6面を18種、雲あり／なしで比べる
//   await AT.cloudplay.stage(3)       // 1面だけ
//
// **作る前に測る**（§87 の教訓）。「AI に雲を理解させるか」は、
// **理解していないことで何を損しているか**が分からないと決められない。
// §87 では仕組みを先に作って、動いたのに結果が出ず、取り消した。
//
// `tools/bench.js` は結末を、`tools/tasking.js` は時間の使い道を見る。
// **こちらが見るのは「雲のせいで無駄になったもの」** ——
//
//   撃った弾が雲で誘導を失った回数（理由の内訳つき）
//   雲越しに撃ってしまった回数
//   敵機を捉えていられた割合と、**追尾が切れて掴み直した回数**
//   自機が雲の中で過ごした割合
//
// 最後の2つが本命。**「掴んでは見失う」が起きているか**を数字で見る ——
// §88.16 で空戦の面の所要が伸びた（160秒 → 273秒）理由の見当を付けるため。

(function () {
  const SEEDS = [11, 22, 33, 44, 55, 66, 77, 88, 99, 110, 121, 132, 143, 154, 165, 176, 187, 198];
  const SAMPLE = 10;        // 何ステップおきに状態を数えるか（30Hz → 3Hz）

  /** メソッドの前に自分の処理を挟む。**`this` を保つ**（実体の own プロパティで覆う）*/
  function before(obj, key, mine) {
    const inner = obj[key].bind(obj);
    obj[key] = (...a) => { mine(...a); return inner(...a); };
  }

  /** 呼び出しの前後に挟む（`onFire` のような素の関数プロパティ用）*/
  function wrapHook(obj, key, mine) {
    let inner = obj[key];
    Object.defineProperty(obj, key, {
      configurable: true,
      get() { return (...a) => { mine(...a); if (inner) inner(...a); }; },
      set(v) { inner = v; },
    });
  }

  /**
   * 1戦ぶんの計測を仕込む。`bench.runOne` の `setup` に渡す。
   *
   * @param {object|null} weather `null` なら雲を消す（比較の対照）
   */
  function setup(weather, CloudField) {
    return (b) => {
      const w = b.world;
      if (weather === null) w.clouds = new CloudField(null, () => 0);

      const shots = new Map();
      wrapHook(w, 'onFire', (sh, tg, wp, m) => {
        if (!m) return;
        shots.set(m, {
          w: wp.id,
          // **どちら側が撃ったか。** 敵機も同じ空対空弾を積んでいるので、
          // side を持たないと**両陣営の発射が同じ数字に混ざる**（実際混ざった）
          味方: sh.side === w.playerSide,
          // **撃った瞬間に雲越しだったか。** 当たり判定と同じ式で見る
          雲越し: !!(w.clouds && w.clouds.active && w.clouds.blocks(sh.pos, tg.pos)),
          // 距離も残す —— 「雲越しのほうが当たる」が出たときに
          // **近距離ばかりだから**なのかを切り分けるため
          km: +(sh.pos.distanceTo(tg.pos) / 1000).toFixed(1),
          結末: '未',
        });
      });
      wrapHook(w, 'onMissileHit', (m) => { const s = shots.get(m); if (s) s.結末 = '命中'; });
      wrapHook(w, 'onDecoyed', (m) => { const s = shots.get(m); if (s && s.結末 === '未') s.結末 = 'デコイ'; });

      // 1ステップに1度だけ通る所に相乗りする。**ループを書き写さない** ——
      // 写しはこのプロジェクトに既に5つあり、そのたびに同期を忘れている（§88.16）
      const st = {
        tick: 0, sampled: 0,
        inCloud: { blue: 0, red: 0 }, air: { blue: 0, red: 0 },
        seen: { blue: 0, red: 0 }, foes: { blue: 0, red: 0 },
        regrab: { blue: 0, red: 0 },
        _start: new Map(),
      };
      before(b.mission, 'update', () => {
        // **飛んでいる弾が雲に食われていないか。**
        // 発射の瞬間は素通しでも、**飛んでいる途中で目標が雲へ入る**ことがある。
        // 赤外線シーカーはそこで熱源を失う（§88.3）ので、
        // 「撃つときだけ見る」規則では防げない —— それが起きているかを数える
        if (w.clouds && w.clouds.active) {
          for (const m of w.missiles) {
            if (!m.alive) continue;
            const sh = shots.get(m);
            if (!sh || sh.飛行中に雲) continue;
            const t = m.seekTarget || m.target;
            if (t && t.pos && w.clouds.blocks(m.pos, t.pos)) sh.飛行中に雲 = true;
          }
        }
        // 追尾の掴み直しは**毎ステップ**見る（間引くと数え落とす）
        for (const side of ['blue', 'red']) {
          const cs = w.detection.contactsFor(side);
          if (!cs) continue;
          for (const [id, c] of cs) {
            if (c.unit.kind !== 'aircraft') continue;
            const prev = st._start.get(side + id);
            if (c.detected && prev !== undefined && c.trackStart !== prev) st.regrab[side]++;
            if (c.detected) st._start.set(side + id, c.trackStart);
          }
        }
        if (st.tick++ % SAMPLE) return;
        st.sampled++;
        for (const u of w.units) {
          if (!u.alive || u.kind !== 'aircraft' || u.onGround) continue;
          const s = st.air[u.side] !== undefined ? u.side : null;
          if (!s) continue;
          st.air[s]++;
          if (w.clouds && w.clouds.active && w.clouds.contains(u.pos)) st.inCloud[s]++;
        }
        for (const side of ['blue', 'red']) {
          const foe = side === 'blue' ? 'red' : 'blue';
          const cs = w.detection.contactsFor(side);
          if (!cs) continue;
          for (const u of w.units) {
            if (!u.alive || u.kind !== 'aircraft' || u.onGround || u.side !== foe) continue;
            st.foes[side]++;
            const c = cs.get(u.id);
            if (c && c.detected) st.seen[side]++;
          }
        }
      });

      b._cp = { shots, st };
    };
  }

  function harvest(b, out) {
    const { shots, st } = b._cp;
    for (const [m, s] of shots) {
      if (s.結末 === '未') s.結末 = m.lost ? '誘導喪失' : '外れ';
      if (m.lost) s.理由 = m.lostReason || '?';
      out.shots.push(s);
    }
    for (const k of ['inCloud', 'air', 'seen', 'foes', 'regrab']) {
      out[k].blue += st[k].blue; out[k].red += st[k].red;
    }
  }

  function blank() {
    return { shots: [], inCloud: { blue: 0, red: 0 }, air: { blue: 0, red: 0 },
      seen: { blue: 0, red: 0 }, foes: { blue: 0, red: 0 }, regrab: { blue: 0, red: 0 } };
  }

  /** 集めたものを読める形にする */
  function fold(o, mineOnly = true) {
    const all = o.shots;
    o = { ...o, shots: mineOnly ? all.filter((s) => s.味方) : all };
    const n = o.shots.length;
    const by = (f) => o.shots.filter(f).length;
    const pct = (a, b) => (b ? Math.round((a / b) * 100) + '%' : '-');
    const reasons = {};
    for (const s of o.shots) if (s.理由) reasons[s.理由] = (reasons[s.理由] || 0) + 1;
    return {
      発射: n,
      命中: pct(by((s) => s.結末 === '命中'), n),
      誘導喪失: pct(by((s) => s.結末 === '誘導喪失'), n),
      理由: reasons,
      雲越しに発射: by((s) => s.雲越し),
      兵装別: byWeapon(o.shots),
      飛行中に雲を挟んだ: by((s) => s.飛行中に雲 && !s.雲越し),
      飛行中に挟んだ弾の命中: (() => {
        const g = o.shots.filter((s) => s.飛行中に雲 && !s.雲越し);
        return g.length ? Math.round(g.filter((s) => s.結末 === '命中').length / g.length * 100) + `% (n=${g.length})` : '-';
      })(),
      敵の発射: all.length - n,
      自軍が雲の中: pct(o.inCloud.blue, o.air.blue),
      敵を捉えていた割合: pct(o.seen.blue, o.foes.blue),
      掴み直し: o.regrab.blue,
    };
  }

  /**
   * **本命の内訳。** 兵装ごとに「雲越しに撃った弾」と「素通しの弾」を分けて、
   * 当たり方を比べる。
   *
   * 雲越しが必ず無駄とは限らない —— **赤外線は切れるが、電波は弱るだけ**（§88.3）。
   * AAM-S だけが目に見えて落ちるなら「赤外線は雲越しに撃たない」という
   * **1本の規則**で済む。全部同じように落ちるなら、規則では直らない。
   */
  function byWeapon(shots) {
    const out = {};
    for (const s of shots) {
      const g = (out[s.w] = out[s.w] || { 雲越し: [0, 0, 0], 素通し: [0, 0, 0] });
      const k = s.雲越し ? '雲越し' : '素通し';
      g[k][1]++;
      g[k][2] += s.km || 0;
      if (s.結末 === '命中') g[k][0]++;
    }
    const fmt = (g) => (g[1] ? `${Math.round((g[0] / g[1]) * 100)}% n=${g[1]} 平均${(g[2] / g[1]).toFixed(1)}km` : '-');
    const r = {};
    for (const [w, g] of Object.entries(out)) {
      r[w] = { 雲越し: fmt(g.雲越し), 素通し: fmt(g.素通し) };
    }
    return r;
  }

  async function stage(i, seeds = SEEDS) {
    const { CloudField } = await import('/js/world/clouds.js');
    const on = blank(), off = blank();
    for (const seed of seeds) {
      await AT.bench.runOne(i, false, { seed, setup: setup(undefined, CloudField) });
      harvest(AT.battle, on);
      await AT.bench.runOne(i, false, { seed, setup: setup(null, CloudField) });
      harvest(AT.battle, off);
    }
    const row = { 面: AT.stages[i].name,
      雲あり: fold(on), 雲なし: fold(off),
      敵側_雲あり: fold(on, false), 敵側_雲なし: fold(off, false) };
    console.log(row);
    return row;
  }

  async function all(seeds = SEEDS) {
    const out = [];
    for (let i = 0; i < AT.stages.length; i++) {
      if (!AT.stages[i].weather) continue;
      out.push(await stage(i, seeds));
    }
    return out;
  }

  AT.cloudplay = { stage, all, setup, SEEDS };
  return 'cloudplay ready';
})();
