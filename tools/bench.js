// バランス検証用のバッチ実行。ブラウザのコンソールに貼り付けて使う。
//
//   fetch('/tools/bench.js').then(r=>r.text()).then(eval)
//   await AT.bench.all(5)        // 全6ステージを5回ずつ
//   await AT.bench.stage(0, 10)  // ステージ1を10回
//   await AT.bench.ab(3, [11,22,33], { A: null, B: (b) => ... })  // 種を固定して比較
//
// プレイヤーの席には**司令官AI**（`js/ai/commander.js`・§27）が座る。
// 発進させ、任務を割り当てるところまでを担い、どの敵を撃つかは
// ゲーム本体と同じ `ai/pilot.js` が探知を通して決める。
// つまりベンチと実際の遊びで、**同じ判断経路を通る**。
// 人間が操作したほうが必ず良い結果になるので、ここで出る数字は「下限」として読むこと。
//
// 描画を回さずシミュレーションだけを最大速度で進める。
// 1回の戦闘は実時間 1〜3 秒で終わる。
//
// **版どうしを比べるときは種を固定すること**（§24.3）。種を引くようにした
// Beta 2.9 以降、同じ版でも回ごとに結果が大きく振れる。種がばらばらの周回で
// 版 A と版 B を比べると、種の違いを変更の効きと取り違える。`ab()` を使う。
//
// 釣り合いの当たりを付けたいだけなら seeds を省いてよい。その場合は毎回
// 種を引くので、1回の数字ではなく分布で読む。

(function () {
  const MAX_SEC = 900;
  const DT = 1 / 30;

  /**
   * 1回まわす。
   *
   * @param {number} stageIndex
   * @param {boolean} trace   発射・命中・撃墜の時系列を残すか
   * @param {object} opts     { seed, setup }
   *   seed  … 乱数の種を固定する（§24.3）。省くと毎回引く
   *   setup … 戦闘が組み上がった直後・1ステップも進める前に呼ばれる。
   *           ここで条件を差し替える。**進めた後に触っても A/B にならない**
   *   record … リプレイを溜める（§56）。既定は false。
   *           `AT.bench.save(i, seed, 名前)` から使う
   */
  function runOne(stageIndex, trace, opts = {}) {
    return new Promise((resolve) => {
      // 直前の戦闘を覚えておく。
      // startBattle は nextFrame を2回挟んでから戦闘を組むので、その間 AT.battle は
      // **前の戦闘のまま**。「battle があるか」だけで待つと前の戦闘を計測してしまい、
      // 別ステージの結果が混ざる（実際に混ざっていた）。
      const prev = AT.battle;

      // **組み上がった瞬間に凍らせる。**
      // buildBattle は最後に速度を戻すので、放っておくと実時間のループが
      // 新しい戦闘を進め始める。こちらが気付くのは 30ms 後のポーリングなので、
      // **何フレーム進んだかが実行のたびに変わる**。
      // 同じ種でも結果がずれる原因はこれだった（シミュレーション自体は決定論的）。
      // 速度と一時停止の両方を一時的に乗っ取り、0 ステップも進まないようにする。
      const setSpeed = AT.loop.setSpeed.bind(AT.loop);
      const setPaused = AT.loop.setPaused.bind(AT.loop);
      AT.loop.setSpeed = () => {};
      AT.loop.setPaused = () => setPaused(true);
      setPaused(true);

      AT.startStage(stageIndex, opts.seed);
      const wait = () => {
        if (!AT.battle || AT.battle === prev) { setTimeout(wait, 30); return; }
        AT.loop.setSpeed = setSpeed;
        AT.loop.setPaused = setPaused;
        setPaused(true);
        if (opts.setup) opts.setup(AT.battle);
        const r = step(trace, opts.record);
        r.seed = AT.battle.seed;
        resolve(r);
      };
      setTimeout(wait, 40);
    });
  }

  function step(trace, record) {
    const b = AT.battle;
    const w = b.world;
    const t0 = performance.now();
    let steps = 0;
    let kills = 0;
    let losses = 0;
    let shots = 0;
    let hits = 0;

    // 司令官AI（§27）。旧・代理プレイヤーの置き換え。
    //
    // 旧版はここに直接書かれていて、**探知を見ず**（world.units を直接読む）、
    // **全機に同じ目標を割り当てて**いた。前者は情報量を変える変更の効きを
    // 測れなくし、後者は1機あたりの発射数を増やす変更を実際より悪く見せていた。
    // どちらもベンチ固有の癖で、ゲーム本体（ai/pilot.js）は正しかった。
    const auto = new AT.Commander(w, w.playerSide, b.mission);

    // **敵側の司令官も回す**（§27.6）。`buildBattle` が組んだものをそのまま使う。
    // ここを忘れると、ベンチと実際の遊びで**敵の動きが違う**。
    const foe = b.enemyCommander;

    // 電波管制の効き具合（§26）。機体×ステップで数えて、出していた割合を出す。
    // 「差が出なかった」で終わらせないために、**そもそも黙っていたのか**を残す。
    const emit = { blue: [0, 0], red: [0, 0] };
    // 双方が初めて相手を捉えた時刻。黙ることで探知が遅れたかを見る
    const firstSeen = { blue: null, red: null };

    const events = [];
    const at = () => 't' + Math.round(steps / 30);
    const km = (a, c) => (a.pos.distanceTo(c.pos) / 1000).toFixed(1) + 'km';
    // **リプレイを録るときは記録も足す**（§56）。
    // `main.js` が張っていたハンドラはここで上書きされるので、
    // そちらが呼んでいた `recorder.event` も一緒に消えていた。
    // しかも `main.js` 側は `loop.simTime` を使うが、ベンチはそれを進めない。
    // **ベンチ自身の時計（steps/30）で録る。**
    const now = () => steps / 30;
    w.onFire = (sh, tg, wp) => {
      shots++;
      if (record) b.recorder?.event('fire', now(), { unit: sh, target: tg, weapon: wp.id, pos: sh.pos });
      if (trace) events.push(`${at()} ${sh.name} ${wp.id} -> ${tg.name} ${km(sh, tg)} alt${Math.round(sh.pos.y)}`);
    };
    w.onMissileHit = (m, tg, dist) => {
      hits++;
      if (record) {
        b.recorder?.event('hit', now(), { unit: m.launcher, target: tg, weapon: m.weapon.id, pos: m.pos,
          label: dist != null && dist > 25 ? '至近弾' : '直撃' });
      }
      if (trace) events.push(`${at()}   HIT ${tg.name} hp${Math.round(tg.hp)}`);
    };

    while (b.mission.state === 'active' && steps < MAX_SEC * 30) {
      // **雲を風で流す**（§88.15）。`main.js` の `fixedUpdate` と同じ順番・同じ位置。
      // ここはゲーム本体の刻みを写した別の実装なので、
      // **向こうに足したものはこちらにも足す** —— 忘れると、
      // ベンチだけ雲が止まったまま測ることになる
      w.clouds?.advance(DT);
      for (const u of w.units) if (u.alive) u.update(DT, w);
      w.detection.update(DT);
      b.pilotAI.update(DT);
      b.combat.update(DT);
      for (const u of w.units) {
        if (u.alive || u._benchDead) continue;
        u._benchDead = true;
        if (trace) events.push(`${at()} DEAD ${u.name} (${u.deathCause || '被弾'})`);
        if (record) {
          const kind = u.deathCause === 'withdraw' ? 'withdraw'
            : (u.side === w.playerSide ? 'loss' : 'kill');
          b.recorder?.event(kind, now(), { unit: u, pos: u.pos, cause: u.deathCause || '被弾' });
        }
        if (u.deathCause === 'withdraw') continue;
        if (u.side === w.playerSide) losses++; else kills++;
      }
      b.mission.update(DT);

      for (const u of w.units) {
        if (!u.alive || u.kind !== 'aircraft' || u.onGround) continue;
        const e = emit[u.side];
        if (!e) continue;
        e[1]++;
        if (u.radarRange > 0) e[0]++;
      }
      for (const side of ['blue', 'red']) {
        if (firstSeen[side] != null) continue;
        for (const [, ct] of w.detection.contactsFor(side)) {
          if (ct.detected && ct.unit && ct.unit.side !== side && ct.unit.kind === 'aircraft') {
            firstSeen[side] = +(steps / 30).toFixed(1);
            break;
          }
        }
      }

      auto.update(DT);
      b.enemyPlan?.update(DT);
      if (foe) foe.update(DT);
      // **記録は頼まれたときだけ**（§56）。既定の周回では回さない —
      // 何百戦もするので、位置の標本を溜めると重いし、
      // ベンチが測っているのは数字であってリプレイではない。
      if (record) b.recorder?.tick(steps / 30);
      steps++;
    }

    const alive = w.units.filter((u) => u.alive);

    // 振り返り画面は結末を見る。書かないと空欄で開く（§23.3）。
    if (record) {
      b.recorder?.finish(
        { state: b.mission.state, reason: b.mission.failReason || '', sec: +(steps / 30).toFixed(1) },
        { kills, losses, shots, hits },
      );
    }

    return {
      stage: b.stage.name,
      state: b.mission.state,
      sec: +(steps / 30).toFixed(1),
      kills,
      losses,
      shots,
      hits,
      pk: shots ? +(hits / shots).toFixed(2) : 0,
      blueLeft: alive.filter((u) => u.side === 'blue' && u.kind === 'aircraft').length,
      redLeft: alive.filter((u) => u.side === 'red' && u.kind === 'aircraft').length,
      ms: Math.round(performance.now() - t0),
      reason: b.mission.failReason || '',
      // 出していた割合(%)。100 なら誰も黙っていない＝電波管制が効いていない
      blueEmit: emit.blue[1] ? Math.round((emit.blue[0] / emit.blue[1]) * 100) : null,
      redEmit: emit.red[1] ? Math.round((emit.red[0] / emit.red[1]) * 100) : null,
      blueSaw: firstSeen.blue,
      redSaw: firstSeen.red,
      events,
    };
  }

  function summarize(rows) {
    const n = rows.length;
    const clear = rows.filter((r) => r.state === 'clear').length;
    const stall = rows.filter((r) => r.state === 'active').length;
    const avg = (f) => +(rows.reduce((s, r) => s + f(r), 0) / n).toFixed(1);
    const secs = rows.filter((r) => r.state === 'clear').map((r) => r.sec).sort((a, b) => a - b);
    return {
      stage: rows[0].stage,
      n,
      clear: `${clear}/${n}`,
      stall,
      secMin: secs[0] ?? null,
      secMed: secs.length ? secs[Math.floor(secs.length / 2)] : null,
      secMax: secs[secs.length - 1] ?? null,
      kills: avg((r) => r.kills),
      losses: avg((r) => r.losses),
      pk: avg((r) => r.pk * 100) / 100,
      reasons: [...new Set(rows.filter((r) => r.state !== 'clear').map((r) => r.reason || '(未達)'))],
    };
  }

  async function stage(i, runs = 5, opts = {}) {
    const rows = [];
    const seeds = opts.seeds || null;
    const n = seeds ? seeds.length : runs;
    for (let k = 0; k < n; k++) {
      rows.push(await runOne(i, false, { seed: seeds ? seeds[k] : undefined, setup: opts.setup }));
    }
    console.table(rows);
    const s = summarize(rows);
    console.log(s);
    return s;
  }

  /** 結果の指紋。これが一致していれば、その種では**何も変わらなかった** */
  function sig(r) {
    return `${r.state}|${r.kills}|${r.losses}|${r.sec}`;
  }

  /**
   * 種を固定した A/B（§24.3）。同じ種で条件だけを差し替えて 1 対 1 で比べる。
   *
   *   await AT.bench.ab(3, [11, 22, 33], {
   *     現行: null,
   *     敵も自動: (b) => { for (const u of b.world.units)
   *       if (u.side === 'red' && u.kind === 'aircraft') u.radarMode = 'auto'; },
   *   })
   *
   * 種ごとに指紋を突き合わせ、違ったものだけ ★ を付ける。
   * ★ が1つも付かなければ、その変更はその条件では**何も動かしていない**。
   */
  async function ab(i, seeds, variants) {
    const names = Object.keys(variants);
    const by = {};
    for (const name of names) {
      by[name] = [];
      for (const seed of seeds) {
        by[name].push(await runOne(i, false, { seed, setup: variants[name] || undefined }));
      }
    }

    const rows = seeds.map((seed, k) => {
      const o = { seed };
      for (const name of names) {
        const r = by[name][k];
        o[name] = `${r.state} ${r.kills}撃墜/${r.losses}損失 ${r.sec}s`;
        o[`${name}:発信`] = `青${r.blueEmit}% 赤${r.redEmit}%`;
        o[`${name}:初探知`] = `青${r.blueSaw ?? '-'} 赤${r.redSaw ?? '-'}`;
      }
      const base = sig(by[names[0]][k]);
      o.差 = names.every((n) => sig(by[n][k]) === base) ? '' : '★';
      return o;
    });
    console.table(rows);

    const diff = rows.filter((r) => r.差).length;
    const summary = {};
    for (const name of names) summary[name] = summarize(by[name]);
    console.table(summary);
    console.log(`種 ${seeds.length} 個中 ${diff} 個で結果が変わった`);
    return { rows, summary, diff, by };
  }

  async function all(runs = 5) {
    const out = [];
    for (let i = 0; i < AT.stages.length; i++) out.push(await stage(i, runs));
    console.table(out);
    return out;
  }

  /** 1回だけ走らせて、発射・命中・撃墜の時系列を返す */
  async function trace(i) {
    const r = await runOne(i, true);
    console.log(r.events.join(String.fromCharCode(10)));
    return r;
  }

  /**
   * 1戦して、そのリプレイを開発サーバへ保存する（§56）。
   *
   *   await AT.bench.save(3, 11, 'iron-umbrella')
   *
   * `replays/<名前>.json` に落ちる。タイトルの「リプレイ」から開ける。
   * ブラウザからのダウンロードは環境によって止められるので、
   * 開発サーバの受け口（`POST /replay/<名前>`）へ送る形にしてある。
   */
  async function save(stageIndex, seed, name) {
    const r = await runOne(stageIndex, false, { seed, record: true });
    const rec = AT.battle && AT.battle.recorder;
    if (!rec) return { error: 'no recorder' };
    const body = JSON.stringify(rec.toJSON());
    const res = await fetch('/replay/' + name + '.json', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
    });
    return { 面: r.stage, 結果: r.state, 秒: r.sec, 撃墜: r.kills, 損失: r.losses,
      失敗理由: r.reason || '', 保存: res.status === 204 ? name + '.json' : 'FAILED ' + res.status,
      KB: Math.round(body.length / 1024) };
  }

  AT.bench = { stage, all, runOne, trace, summarize, ab, sig, save };

  // **調整パネル（§47）で触った値はベンチにもそのまま効く。**
  // 気づかずに数字を読むと、変更の効きと調整の効きを取り違える。
  const tuned = AT.tuning && AT.tuning.tunedIds ? AT.tuning.tunedIds() : [];
  if (tuned.length) {
    console.warn(`[bench] 調整パネルで触ったステージがあります: ${tuned.join(', ')}
`
      + '釣り合いを測るなら AT.tuning.resetAll() で戻してください。');
  }
  return tuned.length ? `bench ready（調整中: ${tuned.join(', ')}）` : 'bench ready';
})();
