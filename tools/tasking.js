// 司令官AIの「任務の組み立て」を測る。仕様書 §27・§59・§72。
//
//   fetch('/tools/tasking.js').then(r=>r.text()).then(eval)
//   await AT.tasking.stage(5)          // COASTAL WALL を種6つ
//   await AT.tasking.all()             // 後半4面
//   await AT.tasking.one(5, 11)        // 1戦だけ、機体ごとの明細つき
//
// **`tools/bench.js` は結末を見る。こちらは過程を見る**
// （[[feedback-bench-sees-the-outcome-not-the-play]]）。
// クリア数が動かなくても、誰が何をして過ごしたかは動く。
//
// §59.1 の測定を作り直したもの。あちらは「働いていない機体」を探すために
// 本拠からの距離を見た。こちらが探すのは**時間の使い道**——
//
//   その機体は、何を積んで、どのモードで、どれだけの秒を過ごしたか。
//
// §59.7 で残っている2つはどちらも時間の話になる:
//   順序   … 防空を剥がす前に打撃へ出て、SAM に撃たれて死ぬ
//   再出撃 … 補給して戻ったあと、対地兵装ゼロのまま旋回して過ごす
//
// **ベンチと同じ手順で回す。** 司令官AIも探知も同じものを通るので、
// ここで出る数字はそのままベンチの数字の内訳になっている。

(function () {
  const MAX_SEC = 900;
  const DT = 1 / 30;
  const SEEDS = [11, 22, 33, 44, 55, 66];
  const AG = ['AGM', 'ARM', 'BOMB'];

  /** 1戦まわして、機体ごとの過ごし方を返す */
  function runOne(stageIndex, seed) {
    return new Promise((resolve) => {
      // 組み上がった瞬間に凍らせる（bench.js と同じ手当て）。
      // 放っておくと実時間のループが進めてしまい、同じ種でも結果がずれる。
      const prev = AT.battle;
      const setSpeed = AT.loop.setSpeed.bind(AT.loop);
      const setPaused = AT.loop.setPaused.bind(AT.loop);
      AT.loop.setSpeed = () => {};
      AT.loop.setPaused = () => setPaused(true);
      setPaused(true);

      AT.startStage(stageIndex, seed);
      const wait = () => {
        if (!AT.battle || AT.battle === prev) { setTimeout(wait, 30); return; }
        AT.loop.setSpeed = setSpeed;
        AT.loop.setPaused = setPaused;
        setPaused(true);
        resolve(step());
      };
      setTimeout(wait, 40);
    });
  }

  function hasAg(u) { return u.loadout.some((id) => AG.includes(id)); }

  /** その機体が「対地の役」か。搭載は消えるので、**離陸時の搭載**で決める */
  function isStriker(u) {
    const base = u.baseLoadout || u.loadout;
    return base.some((id) => AG.includes(id));
  }

  function step() {
    const b = AT.battle;
    const w = b.world;
    const auto = new AT.Commander(w, w.playerSide, b.mission);
    const foe = b.enemyCommander;              // 敵側の司令官（§27.6）
    let steps = 0;

    // 機体ごとの記録。**離陸のたびに増える出撃の列**を持つ
    const log = new Map();
    const entry = (u) => {
      let e = log.get(u.id);
      if (!e) {
        e = { name: u.name, type: u.typeId, striker: isStriker(u),
          air: 0, ground: 0,           // 空中／地上の秒数
          agAir: 0, dryAir: 0,         // 空中で対地兵装が「ある／無い」秒数
          mode: {},                    // モード別の秒数
          shots: {}, sorties: 0, landings: 0,
          far: 0, near8: 0,            // 本拠からの最遠(m) / 8km 以内の秒数
          dead: null, killedBy: null };
        log.set(u.id, e);
      }
      return e;
    };

    // 誰に殺されたか。`damage(amount, source)` の source を控える
    const patched = new WeakSet();
    const watch = (u) => {
      if (patched.has(u)) return;
      patched.add(u);
      const orig = u.damage.bind(u);
      u.damage = (amount, source) => { if (u.alive) u._src = source; orig(amount, source); };
    };

    // 撃った兵装。**対地弾を撃てたか**が順序の話の核心
    w.onFire = (sh, tg, wp) => {
      if (sh.side !== w.playerSide) return;
      const e = entry(sh);
      e.shots[wp.id] = (e.shots[wp.id] || 0) + 1;
    };
    w.onMissileHit = () => {};

    const groundKilled = [];
    const seen = new Set();

    while (b.mission.state === 'active' && steps < MAX_SEC * 30) {
      // 雲を風で流す（§88.15）。**本体の刻みに足したものはここにも足す** ——
      // このループはゲーム本体の写しなので、忘れると雲だけ止まったまま測る
      w.clouds?.advance(DT);
      for (const u of w.units) if (u.alive) u.update(DT, w);
      w.detection.update(DT);
      b.pilotAI.update(DT);
      b.combat.update(DT);

      for (const u of w.units) {
        watch(u);
        if (u.alive || u._probeDead) continue;
        u._probeDead = true;
        if (u.side === w.playerSide && u.kind === 'aircraft') {
          const e = entry(u);
          e.dead = u.deathCause || '被弾';
          e.killedBy = describeSource(u._src);
        } else if (u.side !== w.playerSide && u.kind !== 'aircraft') {
          groundKilled.push(u.name);
        }
      }
      b.mission.update(DT);

      // --- 標本 ---
      for (const u of w.units) {
        if (u.side !== w.playerSide || u.kind !== 'aircraft' || !u.alive) continue;
        const e = entry(u);
        if (u.onGround) { e.ground += DT; } else {
          e.air += DT;
          if (hasAg(u)) e.agAir += DT; else if (e.striker) e.dryAir += DT;
          const m = u.aiMode || '(なし)';
          e.mode[m] = (e.mode[m] || 0) + DT;
          const home = u.airbase && u.airbase.pos;
          if (home) {
            const d = Math.hypot(u.pos.x - home.x, u.pos.z - home.z);
            if (d > e.far) e.far = d;
            if (d < 8000) e.near8 += DT;
          }
        }
        // 出撃と着陸の数。**状態の変わり目**で数える
        const st = u.state;
        const key = u.id + '|' + st;
        if (st === 'takeoff' && !seen.has(key)) { seen.add(key); e.sorties++; }
        if (st === 'ready' && u._wasFlying) { e.landings++; u._wasFlying = false; }
        if (st === 'flying') u._wasFlying = true;
        if (st !== 'takeoff') seen.delete(u.id + '|takeoff');
      }

      auto.update(DT);
      b.enemyPlan?.update(DT);
      if (foe) foe.update(DT);
      steps++;
    }

    return {
      stage: b.stage.name,
      state: b.mission.state,
      sec: +(steps / 30).toFixed(1),
      reason: b.mission.failReason || '',
      壊した地上: groundKilled,
      units: [...log.values()],
    };
  }

  /** ダメージ源を読める名前にする */
  function describeSource(src) {
    if (!src) return null;
    // ミサイル: weapon と launcher を持つ
    if (src.weapon && src.launcher) return `${src.launcher.name} の ${src.weapon.id}`;
    if (src.shooter) return `${src.shooter.name} の機銃`;
    if (src.name) return src.name;
    return '不明';
  }

  const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
  const r1 = (v) => Math.round(v * 10) / 10;

  /** 種を通して機体ごとにまとめる */
  function summarize(runs) {
    const by = new Map();
    for (const r of runs) {
      for (const u of r.units) {
        let e = by.get(u.name);
        if (!e) {
          e = { 機体: u.name, 役: u.striker ? '対地' : '空戦', n: 0,
            空中: 0, 地上: 0, 対地弾あり: 0, 対地弾なし: 0,
            出撃: 0, 着陸: 0, 最遠km: 0, 本拠8km: 0,
            mode: {}, shots: {}, 被撃墜: 0, 死因: {} };
          by.set(u.name, e);
        }
        e.n++;
        e.空中 += u.air; e.地上 += u.ground;
        e.対地弾あり += u.agAir; e.対地弾なし += u.dryAir;
        e.出撃 += u.sorties; e.着陸 += u.landings;
        e.最遠km = Math.max(e.最遠km, u.far / 1000);
        e.本拠8km += u.near8;
        for (const [k, v] of Object.entries(u.mode)) e.mode[k] = (e.mode[k] || 0) + v;
        for (const [k, v] of Object.entries(u.shots)) e.shots[k] = (e.shots[k] || 0) + v;
        if (u.dead) {
          e.被撃墜++;
          const k = u.killedBy || u.dead;
          e.死因[k] = (e.死因[k] || 0) + 1;
        }
      }
    }
    const out = [];
    for (const e of by.values()) {
      const air = e.空中 / e.n;
      out.push({
        機体: e.機体, 役: e.役,
        空中s: r1(air),
        地上s: r1(e.地上 / e.n),
        // **対地の役の機体が、対地兵装ゼロで空中にいた秒数**（§59.7 の475秒）
        弾切れ滞空s: e.役 === '対地' ? r1(e.対地弾なし / e.n) : null,
        出撃: r1(e.出撃 / e.n),
        着陸: r1(e.着陸 / e.n),
        最遠km: r1(e.最遠km),
        '本拠8km%': air ? Math.round((e.本拠8km / e.n / air) * 100) : 0,
        主モード: Object.entries(e.mode).sort((a, b) => b[1] - a[1])
          .slice(0, 3).map(([k, v]) => `${k} ${Math.round(v / e.n)}s`).join(' / '),
        発射: Object.entries(e.shots).map(([k, v]) => `${k}×${r1(v / e.n)}`).join(' ') || '—',
        被撃墜: `${e.被撃墜}/${e.n}`,
        死因: Object.entries(e.死因).sort((a, b) => b[1] - a[1])
          .map(([k, v]) => `${k}(${v})`).join(' / ') || '—',
      });
    }
    return out;
  }

  async function stage(i, seeds = SEEDS) {
    const runs = [];
    for (const s of seeds) runs.push(await runOne(i, s));
    const rows = summarize(runs);
    console.log(`=== ${runs[0].stage} ===  クリア ${runs.filter((r) => r.state === 'clear').length}/${runs.length}`);
    console.table(rows);
    const kills = {};
    for (const r of runs) for (const n of r.壊した地上) kills[n] = (kills[n] || 0) + 1;
    console.log('壊した地上目標:', kills);
    return { stage: runs[0].stage,
      clear: `${runs.filter((r) => r.state === 'clear').length}/${runs.length}`,
      rows, 壊した地上: kills, runs };
  }

  async function all(indices = [3, 4, 5, 6], seeds = SEEDS) {
    const out = [];
    for (const i of indices) out.push(await stage(i, seeds));
    return out;
  }

  /** 1戦だけ。機体ごとの生の記録を返す */
  async function one(i, seed) {
    const r = await runOne(i, seed);
    console.log(r.stage, r.state, r.sec + 's', r.reason);
    console.table(r.units.map((u) => ({
      機体: u.name, 役: u.striker ? '対地' : '空戦',
      空中: r1(u.air), 弾切れ滞空: r1(u.dryAir), 出撃: u.sorties, 着陸: u.landings,
      主モード: Object.entries(u.mode).sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k} ${Math.round(v)}s`).join(' / '),
      発射: Object.entries(u.shots).map(([k, v]) => `${k}×${v}`).join(' ') || '—',
      死因: u.dead ? `${u.dead} / ${u.killedBy || '?'}` : '生存',
    })));
    return r;
  }

  AT.tasking = { stage, all, one, runOne, summarize };
  console.log('AT.tasking 準備完了 — stage(i) / all() / one(i, seed)');
}());
