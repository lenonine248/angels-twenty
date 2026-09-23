// LONG WATCH（防衛面）の「過程」を数えるハーネス。
//
//   fetch('/tools/bench.js').then(r => r.text()).then(eval)
//   fetch('/tools/watchprobe.js').then(r => r.text()).then(eval)
//   await AT.watch.run()          // 現行を18種
//   await AT.watch.compare()      // 4つの変種を同じ18種で並べる
//
// **クリア数が何も言わない面のために作った。**
// §92.1 で敵飛行場の上に GUARD を2機置いてから、ベンチの司令官AIは
// 飛行場を抜けられない（0/6）。勝利条件が「元を断つ」なので、
// クリア数は下限としても読めない。そこで結末ではなく過程を並べる:
//
//   1. 守りの側 —— 施設がいつ・何箇所落ちたか、敵機が空に何機いたか。
//      §92.2 の算数「`max` が有限なら、出し切ったあとは減る一方」を確かめる
//   2. 攻めの側 —— 攻撃に出たか、飛行場へどこまで近づけたか、
//      何点削ったか、どこで落ちたか
//   3. 撃墜の中身 —— 爆撃機・護衛・GUARD のどれを落としているか
//
// 判定は何も変えない。`setup` で `mission.update` を包み、毎刻み覗くだけ。
//
// 変種の差し替えは**その戦闘の中だけ**で行う。`reinforce` の設定は
// ステージ定義と同じオブジェクトなので、書き換えずに**差し替える**
// （書き換えると次の戦闘へ漏れる・§92.3 の教訓）。
(function () {
  // **「18種」は2組ある**（§92.4）。取り違えると、触っていない面まで動いて見える。
  //   SEEDS11 … 11 の倍数（11〜198）。STATUS の「いまの数字」はこちらで取ってきた
  //   SEEDS18 … `AT.aamm.SEEDS18` と同じ。§92.3 の比較はこちら
  const SEEDS11 = Array.from({ length: 18 }, (_, k) => 11 * (k + 1));
  const SEEDS18 = [11, 22, 33, 44, 55, 66, 77, 88, 99,
    101, 202, 303, 404, 505, 606, 707, 808, 909];
  // 150 = 第1波・300 = 旧間隔の第2波・390 = 現行の第2波（ここで出し切る）
  const MARKS = [150, 300, 390, 480, 600, 750, 900];
  const NEAR_BASE = 15000;   // 「飛行場の近く」と数える半径（GUARD の鎖 14km ＋α）

  const km = (m) => +(m / 1000).toFixed(1);
  const flat = (a, b) => Math.hypot(a.pos.x - b.pos.x, a.pos.z - b.pos.z);
  const med = (xs) => {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };
  const avg = (xs) => (xs.length ? +(xs.reduce((s, x) => s + x, 0) / xs.length).toFixed(2) : null);
  const tally = (xs) => xs.reduce((m, x) => { m[x] = (m[x] || 0) + 1; return m; }, {});

  /** 変種。`setup(b)` は戦闘が組み上がった直後・1刻みも進める前に呼ばれる */
  const VARIANTS = {
    現行: null,
    // **原因を割るための形。出荷する形ではない。** GUARD が 0/18 の全部を
    // 説明しているなら、ここでクリアが戻る
    GUARD抜き: (b) => {
      for (const u of b.world.units) {
        if (u.guardHome) { u.deathCause = 'withdraw'; u.destroy(); }
      }
    },
    // §92.2 より前の間隔。`first` が 150 なので第1波は同じ時刻、第2波だけ 390 → 300
    旧間隔: (b) => {
      for (const r of b.mission.reinforce) r.config = { ...r.config, every: 150 };
    },
    // §92 の前の形（GUARD 無し・every 150）。**公開版（Beta 2.95）の LONG WATCH と同じ面**で、
    // 健全性の基準になる —— 旧「いまの数字」と同じ種（`SEEDS11`）で回せば 4/18 に戻る。
    // **乱数列までは揃わない。** 配置の散らばり（`main.js` の `jit`）は機体ごとに
    // `world.rng()` を引くので、GUARD を湧かせてから消すと以降の引きがずれる。
    // クリアは一致、損失は 3.8 → 3.94 だった（§92.4）
    旧間隔GUARD抜き: (b) => {
      VARIANTS.GUARD抜き(b);
      VARIANTS.旧間隔(b);
    },
  };

  function instrument(b, rec, variant) {
    if (variant) variant(b);
    const w = b.world;
    const me = w.playerSide;
    const base = w.units.find((u) => u.kind === 'airbase' && u.side !== me);
    const isDepot = (u) => (u.tags || []).includes('depot');
    const cat = (u) => (u.guardHome ? 'GUARD' : (u.typeId || '?'));

    rec.baseMax = base.maxHp;
    rec.baseMin = base.hp;
    rec.baseDeadT = null;
    rec.redAir = {};         // 刻み時刻 → 空にいる敵機（GUARD を除く）
    rec.guardAlive = {};
    rec.peak = 0;
    rec.peakT = 0;
    rec.depotLostT = [];
    rec.strikeT = {};        // 名前 → 飛行場を攻撃目標に受け取った最初の時刻
    rec.closest = {};        // 名前 → 飛行場への最接近（m）
    rec.blueDead = [];
    rec.redDead = [];
    rec.groundLost = { depot: 0, other: 0 };

    const seen = new Set();
    let t = 0;
    let mark = 0;
    const orig = b.mission.update.bind(b.mission);
    b.mission.update = (dt) => {
      orig(dt);
      t += dt;

      rec.baseMin = Math.min(rec.baseMin, base.alive ? base.hp : 0);
      if (!base.alive && rec.baseDeadT == null) rec.baseDeadT = Math.round(t);

      let air = 0;
      for (const u of w.units) {
        if (!u.alive) {
          if (seen.has(u) || u.deathCause === 'withdraw') continue;
          seen.add(u);
          const T = Math.round(t);
          if (u.side === me) {
            if (u.kind === 'aircraft') {
              rec.blueDead.push({ name: u.name, t: T, dBase: km(flat(u, base)), mode: u.aiMode,
                cause: u.deathCause || '被弾' });
            } else if (isDepot(u)) { rec.groundLost.depot++; rec.depotLostT.push(T); }
            else rec.groundLost.other++;
          } else if (u.kind === 'aircraft') {
            rec.redDead.push({ cat: cat(u), t: T, dBase: km(flat(u, base)), xKm: km(u.pos.x) });
          }
          continue;
        }
        if (u.kind !== 'aircraft') continue;
        if (u.side === me) {
          if (u.onGround) continue;
          const d = flat(u, base);
          if (rec.closest[u.name] == null || d < rec.closest[u.name]) rec.closest[u.name] = d;
          if (u.aiMode === 'STRIKE' && u.strikeTarget === base && rec.strikeT[u.name] == null) {
            rec.strikeT[u.name] = Math.round(t);
          }
        } else if (!u.onGround && !u.guardHome) {
          air++;
        }
      }
      if (air > rec.peak) { rec.peak = air; rec.peakT = Math.round(t); }
      while (mark < MARKS.length && t >= MARKS[mark]) {
        rec.redAir[MARKS[mark]] = air;
        rec.guardAlive[MARKS[mark]] = w.units.filter((u) => u.alive && u.guardHome).length;
        mark++;
      }
    };
    rec._finish = () => {
      rec.spawned = b.mission.reinforce.reduce((s, r) => s + r.spawned, 0);
      rec.depotsLeft = w.units.filter((u) => u.alive && u.side === me && isDepot(u)).length;
      delete rec._finish;
    };
  }

  async function runVariant(name, seeds = SEEDS18) {
    const i = AT.stages.findIndex((s) => s.name === 'LONG WATCH');
    const rows = [];
    for (const seed of seeds) {
      const rec = { seed };
      const r = await AT.bench.runOne(i, false,
        { seed, setup: (b) => instrument(b, rec, VARIANTS[name]) });
      rec._finish();
      rows.push({ ...rec, state: r.state, reason: r.reason, sec: r.sec,
        kills: r.kills, losses: r.losses });
    }
    return rows;
  }

  /** 18戦を1行にまとめる。**件数と割合は並べて出す**（§92.3 の教訓） */
  function summarize(rows) {
    const n = rows.length;
    const clear = rows.filter((r) => r.state === 'clear').length;
    const fails = rows.filter((r) => r.state !== 'clear');
    const redAir = {};
    for (const m of MARKS) {
      const xs = rows.filter((r) => r.redAir[m] != null).map((r) => r.redAir[m]);
      redAir[m] = xs.length ? `${med(xs)}（${xs.length}戦）` : '—';
    }
    const redBy = (c) => avg(rows.map((r) => r.redDead.filter((d) => d.cat === c).length));
    const blueAir = rows.flatMap((r) => r.blueDead);
    const struck = rows.filter((r) => Object.keys(r.strikeT).length);
    const nearest = rows.map((r) => Math.min(...Object.values(r.closest), Infinity));
    const anvil = rows.map((r) => r.closest['ANVIL 1']).filter((d) => d != null);
    return {
      n,
      クリア: `${clear}/${n}`,
      失敗理由: tally(fails.map((r) => r.reason || '(900秒で未決着)')),
      所要秒_中央値: med(rows.map((r) => r.sec)),
      撃墜: avg(rows.map((r) => r.kills)),
      撃墜の中身: { 'B-9': redBy('B-9'), 'J-7': redBy('J-7'), GUARD: redBy('GUARD') },
      損失: avg(rows.map((r) => r.losses)),
      損失の中身: {
        機体: avg(rows.map((r) => r.blueDead.length)),
        施設: avg(rows.map((r) => r.groundLost.depot)),
        防空: avg(rows.map((r) => r.groundLost.other)),
      },
      施設の残り: tally(rows.map((r) => r.depotsLeft)),
      施設が落ちた時刻_中央値: {
        '1箇所目': med(rows.filter((r) => r.depotLostT.length >= 1).map((r) => r.depotLostT[0])),
        '2箇所目': med(rows.filter((r) => r.depotLostT.length >= 2).map((r) => r.depotLostT[1])),
      },
      敵機が空にいる数_中央値: redAir,
      敵機の最多: { 中央値: med(rows.map((r) => r.peak)), その時刻_中央値: med(rows.map((r) => r.peakT)) },
      増援が湧いた数: tally(rows.map((r) => r.spawned)),
      GUARD生存_900秒: med(rows.filter((r) => r.guardAlive[900] != null).map((r) => r.guardAlive[900])),
      攻めの側: {
        飛行場を攻撃目標にした戦: struck.length,
        その最初の時刻_中央値: med(struck.map((r) => Math.min(...Object.values(r.strikeT)))),
        いちばん近づいた機_km_中央値: km(med(nearest.filter(Number.isFinite)) ?? NaN),
        ANVIL1の最接近_km_中央値: anvil.length ? km(med(anvil)) : null,
        '飛行場を削った戦': rows.filter((r) => r.baseMin < r.baseMax).length,
        '飛行場の残りhp_中央値': med(rows.map((r) => Math.round(r.baseMin))),
        '飛行場を潰した戦': rows.filter((r) => r.baseDeadT != null).length,
      },
      自軍機が落ちた場所: {
        [`飛行場の${NEAR_BASE / 1000}km以内`]: blueAir.filter((d) => d.dBase * 1000 <= NEAR_BASE).length,
        それ以外: blueAir.filter((d) => d.dBase * 1000 > NEAR_BASE).length,
        そのときの任務: tally(blueAir.map((d) => d.mode)),
      },
    };
  }

  /** 同じ種で2つの変種の結末が違った種の数 */
  function diff(a, b) {
    const sig = (r) => `${r.state}|${r.depotsLeft}|${r.kills}|${r.losses}`;
    return a.filter((r, k) => sig(r) !== sig(b[k])).length;
  }

  AT.watch = {
    SEEDS11,
    SEEDS18,
    VARIANTS,
    last: {},
    async run(name = '現行', seeds = SEEDS18) {
      const rows = await runVariant(name, seeds);
      AT.watch.last[name] = rows;
      return summarize(rows);
    },
    async compare(names = Object.keys(VARIANTS), seeds = SEEDS18) {
      const out = {};
      // **この呼び出しで回したものだけを突き合わせる。** `last` には前の呼び出しの
      // 別の種の行が残っていることがあり、それと比べると種の違いを数えてしまう
      const got = {};
      for (const name of names) {
        const rows = await runVariant(name, seeds);
        AT.watch.last[name] = rows;
        got[name] = rows;
        out[name] = summarize(rows);
      }
      if (got.現行 && got.旧間隔) out.結末が変わった種_現行対旧間隔 = diff(got.現行, got.旧間隔);
      if (got.現行 && got.GUARD抜き) out.結末が変わった種_現行対GUARD抜き = diff(got.現行, got.GUARD抜き);
      return out;
    },
    summarize,
  };
})();
