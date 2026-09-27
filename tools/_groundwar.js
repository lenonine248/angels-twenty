// 空なしの地上戦（§103・A3）。**開発用。**
//
// 航空機を動かさず、地上部隊だけを回して決着を見る。
// 使い方（ブラウザのコンソール。bench.js は要らない）:
//   fetch('/tools/_groundwar.js').then(r=>r.text()).then(eval)
//   await AT.groundwar.duels([1,2,3,4,5,6,7,8,9,10])          // 3種×3種の1対1（距離 6km）
//   await AT.groundwar.duels(seeds, { spotter: true })         // 榴弾砲の側に観測の車両（武装なし）を付ける
//   await AT.groundwar.mixed(seeds, { blue: {TANK:3,ARTILLERY:2,CONVOY:2}, red: {...} })
//
// 出すもの（組ごと）: 勝った側の数・決着の秒（中央値と幅）・勝った側の残り hp（割合の中央値）・引き分け（時間切れ）。
//
// 地形は**平ら**（mountainAmount 0.05）。起伏で視線が切れる効きは別に測る（opts.terrain で差し替え）。
// 刻みは bench.js と同じ順（雲 → ユニット → 探知 → 戦闘）。パイロット・司令官・任務は回さない。

(function () {
  const DT = 1 / 30;
  const FLAT = { seed: 40404, mountainAmount: 0.05, coast: 'none', valleyDepth: 0.1, rivers: 0, baseAltitude: 300 };
  const TYPES = ['CONVOY', 'TANK', 'ARTILLERY'];
  /** 種ごとに戦う場所を南北へずらす（同じ地形の1本の線だけを測らない）。種 → 800m 刻みで ±12km */
  const zOf = (seed) => 25600 + (((seed * 7919) % 31) - 15) * 800;
  const median = (a) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

  /** 地上部隊の並び。`count` は {TYPE: n}。x0 から横 (z 方向) に 400m おきに並べる */
  function place(count, x, z0, side, extra = {}) {
    const out = [];
    let k = 0;
    for (const [type, n] of Object.entries(count)) {
      for (let i = 0; i < n; i++) {
        out.push({ type, name: `${side}-${type}-${i + 1}`, x, z: z0 + (k - 3) * 400,
          tags: ['gw', `gw-${side}`], attackTag: side === 'b' ? 'gw-r' : 'gw-b', ...extra });
        k++;
      }
    }
    return out;
  }

  function stageOf(base, blue, red, terrain) {
    const s = JSON.parse(JSON.stringify(base));
    s.id = 'groundwar';
    s.terrain = terrain || FLAT;
    s.weather = undefined;
    // プレイヤーの機体は飛行場で待たせる（1機いないと面が組めない）。地上戦からは 30km 離す
    s.friendly = { base: { x: 6000, z: 45000 },
      aircraft: [{ type: (base.friendly.aircraft[0] || {}).type || 'F-1', name: 'IDLE', loadout: [] }],
      ground: blue };
    s.enemy = { aircraft: [], ground: red, skill: 1 };
    delete s.ally;
    s.objectives = [{ id: 'gw', type: 'survive', seconds: 99999, label: 'groundwar' }];
    return s;
  }

  function start(stage, seed) {
    return new Promise((resolve) => {
      const IDX = 0;
      const orig = AT.stages[IDX];
      const prev = AT.battle;
      AT.stages[IDX] = stage;
      const setSpeed = AT.loop.setSpeed.bind(AT.loop);
      const setPaused = AT.loop.setPaused.bind(AT.loop);
      AT.loop.setSpeed = () => {};
      AT.loop.setPaused = () => setPaused(true);
      setPaused(true);
      AT.startStage(IDX, seed);
      const wait = () => {
        // **今回組んだ面の戦闘かを見る。** 開いた直後は前の戦闘が返ることがある（JOURNAL §102.4）ので、
        // 「前と違う」では足りない —— 実際に1組ずつずれた
        if (!AT.battle || AT.battle === prev || AT.battle.stage !== stage) { setTimeout(wait, 30); return; }
        AT.loop.setSpeed = setSpeed;
        AT.loop.setPaused = setPaused;
        setPaused(true);
        AT.stages[IDX] = orig;
        resolve(AT.battle);
      };
      setTimeout(wait, 40);
    });
  }

  /** 決着まで回す。`combatOnly` は数える側（観測の車両は数えない） */
  function run(b, maxSec) {
    const w = b.world;
    const fighters = (side) => w.units.filter((u) => u.kind !== 'aircraft' && u.tags && u.tags.includes(`gw-${side}`)
      && !u.tags.includes('spot'));
    const B = fighters('b'); const R = fighters('r');
    const hp0 = (list) => list.reduce((n, u) => n + u.spec.hp, 0);
    let steps = 0;
    const firstShot = { b: null, r: null };
    const onFire = w.onGunFire;
    w.onGunFire = (u, t, n, v) => {
      const k = u.side === 'blue' ? 'b' : 'r';
      if (firstShot[k] == null && u.kind !== 'aircraft') firstShot[k] = steps / 30;
      onFire?.(u, t, n, v);
    };
    while (steps < maxSec * 30) {
      w.clouds?.advance(DT);
      for (const u of w.units) if (u.alive) u.update(DT, w);
      w.detection.update(DT);
      b.combat.update(DT);
      steps++;
      if (!B.some((u) => u.alive) || !R.some((u) => u.alive)) break;
    }
    const bAlive = B.filter((u) => u.alive); const rAlive = R.filter((u) => u.alive);
    const winner = bAlive.length && !rAlive.length ? 'b' : rAlive.length && !bAlive.length ? 'r' : 'draw';
    const left = winner === 'b' ? bAlive : winner === 'r' ? rAlive : [];
    const hpLeft = left.length ? left.reduce((n, u) => n + u.hp, 0) / hp0(winner === 'b' ? B : R) : null;
    return { winner, sec: +(steps / 30).toFixed(1), hpLeft, bAlive: bAlive.length, rAlive: rAlive.length,
      firstShot };
  }

  function sum(rows) {
    const wins = { b: 0, r: 0, draw: 0 };
    for (const r of rows) wins[r.winner]++;
    const secs = rows.filter((r) => r.winner !== 'draw').map((r) => r.sec);
    return {
      b: wins.b, r: wins.r, draw: wins.draw,
      sec: median(secs), secMin: secs.length ? Math.min(...secs) : null, secMax: secs.length ? Math.max(...secs) : null,
      hpLeft: median(rows.filter((r) => r.hpLeft != null).map((r) => +r.hpLeft.toFixed(2))),
      firstB: median(rows.map((r) => r.firstShot.b).filter((v) => v != null)),
      firstR: median(rows.map((r) => r.firstShot.r).filter((v) => v != null)),
    };
  }

  /**
   * 3種×3種の1対1。青を x=20km、赤を x=20km+gap に置き、互いに `advance`。
   * `spotter: true` なら、榴弾砲の側に**武装なしの車両部隊**を榴弾砲と同じ位置に置き、その場で持たせる（観測だけ）
   */
  async function duels(seeds = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], opts = {}) {
    const base = AT.stages[0];
    const gap = opts.gap || 6000;
    const maxSec = opts.maxSec || 600;
    const out = {};
    for (const A of TYPES) {
      for (const Bt of TYPES) {
        if (opts.only && !opts.only.includes(`${A}>${Bt}`)) continue;
        const rows = [];
        for (const seed of seeds) {
          const z = zOf(seed);
          const blue = place({ [A]: 1 }, 20000, z, 'b');
          const red = place({ [Bt]: 1 }, 20000 + gap, z, 'r');
          // swap: 青と赤の出発点を入れ替える（地形の有利不利を切り分ける）
          if (opts.swap) { for (const u of blue) u.x += gap; for (const u of red) u.x -= gap; }
          if (opts.spotter) {
            if (A === 'ARTILLERY') blue.push({ type: 'CONVOY', name: 'b-spot', x: 20000 - 500, z: z - 1200, unarmed: true,
              groundMode: 'hold', tags: ['gw-b', 'spot'] });
            if (Bt === 'ARTILLERY') red.push({ type: 'CONVOY', name: 'r-spot', x: 20000 + gap + 500, z: z - 1200, unarmed: true,
              groundMode: 'hold', tags: ['gw-r', 'spot'] });
          }
          const b = await start(stageOf(base, blue, red, opts.terrain), seed);
          rows.push(run(b, maxSec));
        }
        out[`${A}>${Bt}`] = sum(rows);
      }
    }
    return out;
  }

  /** 混成どうし。既定は 戦車3＋榴弾砲2＋車両2 対 同じ編成 */
  async function mixed(seeds = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], opts = {}) {
    const base = AT.stages[0];
    const comp = { TANK: 3, ARTILLERY: 2, CONVOY: 2 };
    const gap = opts.gap || 8000;
    const rows = [];
    for (const seed of seeds) {
      const blue = place(opts.blue || comp, 20000, zOf(seed), 'b', opts.blueExtra || {});
      const red = place(opts.red || comp, 20000 + gap, zOf(seed), 'r', opts.redExtra || {});
      if (opts.swap) { for (const u of blue) u.x += gap; for (const u of red) u.x -= gap; }
      const b = await start(stageOf(base, blue, red, opts.terrain), seed);
      rows.push(run(b, opts.maxSec || 900));
    }
    return { ...sum(rows), rows: rows.map((r) => `${r.winner}@${r.sec}(${r.bAlive}:${r.rAlive})`).join(' ') };
  }

  /**
   * 面を**空なし**（地上だけ）と**空あり**（bench.js の司令官AIがプレイヤーの機体を動かす）で同じ種で回す。
   * 検証面 d5 のため（`AT.setDebug(true)` と bench.js が要る）。
   *   await AT.groundwar.stage('d5', [11,22,33], { tag: 'armor', reach: { x, z, r } })
   * 出すもの: 種ごとに 空なし「結末@秒 残った tag の数」・空あり「state@秒 残った tag の数 損失」
   */
  async function stage(id, seeds, { tag = 'armor', reach = null, maxSec = 900, air = true } = {}) {
    const idx = AT.stageList().findIndex((s) => s.id === id);
    const def = AT.stageList()[idx];
    const count = (w, t) => w.units.filter((u) => u.alive && u.tags && u.tags.includes(t)).length;
    const out = { noair: [], air: [] };
    for (const seed of seeds) {
      const b = await start(def, seed);
      const w = b.world;
      const mine = w.units.filter((u) => u.tags && u.tags.includes(tag));
      let st = 0; let res = 'stall';
      for (; st < maxSec * 30; st++) {
        w.clouds?.advance(DT);
        for (const u of w.units) if (u.alive) u.update(DT, w);
        w.detection.update(DT);
        b.combat.update(DT);
        if (!mine.some((u) => u.alive)) { res = 'lost'; break; }
        if (reach && mine.some((u) => u.alive && Math.hypot(u.pos.x - reach.x, u.pos.z - reach.z) < reach.r)) { res = 'reached'; break; }
      }
      out.noair.push(`${seed}:${res}@${Math.round(st / 30)} ${tag}${count(w, tag)}`);
    }
    if (!air || !AT.bench) return out;
    for (let k = 0; k < 8; k++) { const r = await AT.bench.runOne(0, false, { seed: 11 }); if (r.sec > 0) break; }
    for (const seed of seeds) {
      let r;
      for (let t = 0; t < 5; t++) { r = await AT.bench.runOne(idx, false, { seed }); if (r.sec > 0) break; }
      out.air.push(`${seed}:${r.state}@${r.sec} ${tag}${count(AT.battle.world, tag)} loss${r.losses}`);
    }
    return out;
  }

  /**
   * 種類の数値をその場で差し替えて回す（A/B 用）。`patch(GROUND_TYPES)` が差し替え、戻り値の関数で元に戻す。
   *   const undo = await AT.groundwar.patch((T) => { T.CONVOY.speed = 16; });  … 測る … undo();
   */
  async function patch(fn) {
    const { GROUND_TYPES } = await import('/js/data/ground.js');
    const saved = JSON.parse(JSON.stringify(GROUND_TYPES, (k, v) => (v === Infinity ? '__inf' : v)));
    fn(GROUND_TYPES);
    return () => {
      for (const [id, spec] of Object.entries(saved)) {
        const cur = GROUND_TYPES[id];
        const back = JSON.parse(JSON.stringify(spec), (k, v) => (v === '__inf' ? Infinity : v));
        for (const k of Object.keys(cur)) if (!(k in back)) delete cur[k];
        Object.assign(cur, back);
        // 兵装は同じ物を指したまま中身だけ戻す（生成済みのユニットが参照している）
        if (back.weapons) cur.weapons = back.weapons;
      }
    };
  }

  window.AT = window.AT || {};
  AT.groundwar = { duels, mixed, stage, stageOf, start, run, place, patch };
})();
