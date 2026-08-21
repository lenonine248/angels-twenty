// バランス検証用のバッチ実行。ブラウザのコンソールに貼り付けて使う。
//
//   fetch('/tools/bench.js').then(r=>r.text()).then(eval)
//   await AT.bench.all(5)        // 全6ステージを5回ずつ
//   await AT.bench.stage(0, 10)  // ステージ1を10回
//   await AT.bench.ab(3, [11,22,33], { A: null, B: (b) => ... })  // 種を固定して比較
//
// ステージ3以降は地上で待機して始まるため、プレイヤーの指示が無いと
// 誰も発進しない。そこで最低限の代理プレイヤー（発進させ、目標へ攻撃指示を出す）
// を入れてある。人間が操作したほうが必ず良い結果になるので、
// ここで出る数字は「下限」として読むこと。
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
   */
  function runOne(stageIndex, trace, opts = {}) {
    return new Promise((resolve) => {
      // 直前の戦闘を覚えておく。
      // startBattle は nextFrame を2回挟んでから戦闘を組むので、その間 AT.battle は
      // **前の戦闘のまま**。「battle があるか」だけで待つと前の戦闘を計測してしまい、
      // 別ステージの結果が混ざる（実際に混ざっていた）。
      const prev = AT.battle;

      // **組み上がった瞬間に凍らせる。**
      // buildBattle は最後に loop.setSpeed(1) を呼ぶので、放っておくと
      // 実時間のループが新しい戦闘を進め始める。こちらが気付くのは 30ms 後の
      // ポーリングなので、**何フレーム進んだかが実行のたびに変わる**。
      // 同じ種でも結果がずれる原因はこれだった（シミュレーション自体は決定論的）。
      // setSpeed を一時的に乗っ取って、0 ステップも進まないようにする。
      const setSpeed = AT.loop.setSpeed.bind(AT.loop);
      AT.loop.setSpeed = () => setSpeed(0);

      AT.startStage(stageIndex, opts.seed);
      const wait = () => {
        if (!AT.battle || AT.battle === prev) { setTimeout(wait, 30); return; }
        AT.loop.setSpeed = setSpeed;
        setSpeed(0);
        if (opts.setup) opts.setup(AT.battle);
        const r = step(trace);
        r.seed = AT.battle.seed;
        resolve(r);
      };
      setTimeout(wait, 40);
    });
  }

  function step(trace) {
    const b = AT.battle;
    const w = b.world;
    const t0 = performance.now();
    let steps = 0;
    let kills = 0;
    let losses = 0;
    let shots = 0;
    let hits = 0;

    const auto = new AutoPlayer(b);
    let autoT = 0;

    // 電波管制の効き具合（§26）。機体×ステップで数えて、出していた割合を出す。
    // 「差が出なかった」で終わらせないために、**そもそも黙っていたのか**を残す。
    const emit = { blue: [0, 0], red: [0, 0] };
    // 双方が初めて相手を捉えた時刻。黙ることで探知が遅れたかを見る
    const firstSeen = { blue: null, red: null };

    const events = [];
    const at = () => 't' + Math.round(steps / 30);
    const km = (a, c) => (a.pos.distanceTo(c.pos) / 1000).toFixed(1) + 'km';
    w.onFire = (sh, tg, wp) => {
      shots++;
      if (trace) events.push(`${at()} ${sh.name} ${wp.id} -> ${tg.name} ${km(sh, tg)} alt${Math.round(sh.pos.y)}`);
    };
    w.onMissileHit = (m, tg) => {
      hits++;
      if (trace) events.push(`${at()}   HIT ${tg.name} hp${Math.round(tg.hp)}`);
    };

    while (b.mission.state === 'active' && steps < MAX_SEC * 30) {
      for (const u of w.units) if (u.alive) u.update(DT, w);
      w.detection.update(DT);
      b.pilotAI.update(DT);
      b.combat.update(DT);
      for (const u of w.units) {
        if (u.alive || u._benchDead) continue;
        u._benchDead = true;
        if (trace) events.push(`${at()} DEAD ${u.name} (${u.deathCause || '被弾'})`);
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

      autoT += DT;
      if (autoT >= 0.5) { autoT = 0; auto.update(); }
      steps++;
    }

    const alive = w.units.filter((u) => u.alive);
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

  /**
   * 代理プレイヤー。人間の操作を粗く真似るだけの最小限のもの。
   * - 地上待機の機体を発進させる
   * - 未達の destroyAll 目標に対し、兵装が噛み合う機体へ攻撃指示を出す
   * - 目標が死んだら次の目標へ振り直す
   */
  class AutoPlayer {
    constructor(battle) {
      this.b = battle;
      this.w = battle.world;
    }

    update() {
      const w = this.w;

      // 発進
      for (const u of w.units) {
        if (u.side !== w.playerSide || u.kind !== 'aircraft') continue;
        if (u.state === 'ready' && u.airbase) u.airbase.launch(u, w);
      }

      const ward = this._ward();
      const targets = this._targets();

      for (const u of w.units) {
        if (!u.alive || u.side !== w.playerSide || u.kind !== 'aircraft') continue;
        if (u.onGround || u.state === 'takeoff') continue;
        if (u._winchester) continue;
        // 非武装の支援機（輸送機・早期警戒機）は経路飛行のまま触らない
        if (u.spec.hardpoints === 0 || u.aiMode === 'TRANSIT') continue;

        // 守る対象がいて、自分が対地兵装を持たないなら護衛に付く。
        // 攻撃目標の有無より先に見る（護衛ステージには destroyAll 目標が無い）。
        if (ward && !this._hasAg(u)) {
          if (u.aiMode !== 'ESCORT' || u.escortTarget !== ward) {
            u.escortTarget = ward;
            u.aiMode = 'ESCORT';
            if (u.order && u.order.player) u.order.player = false;
          }
          continue;
        }

        const wants = this._pick(u, targets);

        // 撃てる兵装が無くなったら指示を解いて帰投させる。
        // 人間なら当然やることで、これをしないと空の機体が
        // SAM 圏に居座って落とされ、難易度の目安にならない。
        if (!wants) {
          if (u.order && u.order.player) u.setOrder({ type: 'rtb', airbase: u.nearestBase(w) });
          u.aiMode = 'RTB';
          continue;
        }
        // 補給が済んで再び撃てるようになったら帰投モードを解く
        if (u.aiMode === 'RTB') u.aiMode = 'PATROL';

        const cur = u.order && u.order.type === 'attack' ? u.order.target : null;
        if (cur && cur.alive && targets.includes(cur)) continue;
        u.setOrder({ type: 'attack', target: wants, player: true });
      }
    }

    /** protect 目標に指定されている自軍ユニット（護衛対象） */
    _ward() {
      for (const o of this.b.mission.objectives) {
        if (o.type !== 'protect' || o.failed) continue;
        for (const u of this.w.units) {
          if (u.alive && u.side === this.w.playerSide && u.kind === 'aircraft'
              && u.tags && u.tags.includes(o.tag)) return u;
        }
      }
      return null;
    }

    _hasAg(u) {
      return u.loadout.some((id) => ['AGM', 'ARM', 'BOMB'].includes(id));
    }

    /** 未達の destroyAll 目標に含まれる生存ユニット */
    _targets() {
      const out = [];
      for (const o of this.b.mission.objectives) {
        if (o.type !== 'destroyAll' || o.done) continue;
        for (const u of this.w.units) {
          if (u.alive && u.tags && u.tags.includes(o.tag)) out.push(u);
        }
      }
      return out;
    }

    /**
     * 搭載兵装に合う目標を選ぶ。撃てる相手がいなければ null。
     *
     * 守るものがある任務では「自分に近い順」ではなく
     * 「守る対象に近い順」で選ぶ。人間はそう判断する。
     * 自分に近い順にすると、飛行場へ向かう爆撃機を放置して
     * 手近な護衛機と戦い続け、その間に飛行場を失う。
     */
    _pick(u, targets) {
      const ag = this._hasAg(u);
      const aa = u.loadout.some((id) => id.startsWith('AAM'));
      const asset = this._asset();
      let best = null;
      let bestD = Infinity;
      for (const t of targets) {
        const air = t.kind === 'aircraft';
        if (air && !aa) continue;
        if (!air && !ag) continue;
        const d = asset ? t.pos.distanceTo(asset.pos) : u.pos.distanceTo(t.pos);
        if (d < bestD) { bestD = d; best = t; }
      }
      return best;
    }

    /** protect 目標に指定されている自軍の資産（飛行場を含む） */
    _asset() {
      for (const o of this.b.mission.objectives) {
        if (o.type !== 'protect' || o.failed) continue;
        for (const x of this.w.units) {
          if (x.alive && x.side === this.w.playerSide && x.tags && x.tags.includes(o.tag)) return x;
        }
      }
      return null;
    }
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

  AT.bench = { stage, all, runOne, trace, summarize, ab, sig };
  return 'bench ready';
})();
