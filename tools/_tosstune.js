// トス爆撃 AI の調整値スイープ（pullLead × releaseInterval）計測ハーネス。
// ゲーム本体(js/)は一切変更しない。実行中に import した acm.js の TOSS オブジェクトと
// weapons.js の BOMB.dispersionPerKm を直接書き換えて振り、終わったら必ず既定値へ戻す。
//
// 読み込み（_tut_harness.js が先に必要。__open を使う）:
//   await fetch('/tools/_tut_harness.js').then(r => r.text()).then(eval);
//   await fetch('/tools/_tosstune.js').then(r => r.text()).then(eval);
// 実行（1回の呼び出しの中で最後まで回すこと）:
//   await __tossTuneRun()
//
// 返り値: { table: [...条件ごとの集計], refRows: [...散布0参考行], restored: {...} }
// 生ログは window.__tossTuneLast に積む。
(() => {
  const DT = 1 / 30;
  const DEG = Math.PI / 180;
  const TARGET_XZ = { x: 26000, z: 28000 };
  const START_D = 12000;
  const BEARINGS = [0, 60, 120, 180, 240, 300];

  function buildTutorial(id, type, bombCount) {
    return {
      id,
      group: '計測',
      name: 'TOSS TUNE PROBE',
      title: '計測用（非表示）',
      brief: '計測用の内部ステージ。地形は平坦。防御なし。',
      hint: '',
      terrain: { seed: 90017, mountainAmount: 0, coast: 'none', valleyDepth: 0, rivers: 0, baseAltitude: 400 },
      weaponPoints: 0,
      noFail: true,
      friendly: {
        base: { x: 11000, z: 40000 },
        startAirborne: true,
        startAlt: 3000,
        aircraft: [{
          type, name: 'PROBE 1', loadout: Array(bombCount).fill('BOMB'),
          autoWeapons: { BOMB: true },
        }],
      },
      enemy: {
        aircraft: [],
        ground: [{
          type: 'RADAR', name: 'レーダーサイト', x: TARGET_XZ.x, z: TARGET_XZ.z,
          tags: ['target'], known: true,
        }],
      },
      steps: [{ text: '(計測用ダミー手順)', check: () => false }],
    };
  }

  async function openScenario(id, type, bombCount) {
    if (!AT.tutorials.find((t) => t.id === id)) AT.tutorials.push(buildTutorial(id, type, bombCount));
    await __open(id);
    const b = AT.battle;
    const world = b.world;
    const u = world.units.find((x) => x.kind === 'aircraft' && x.side === world.playerSide);
    const target = world.units.find((x) => x.tags && x.tags.includes('target'));
    const groundY = target.pos.y;
    world.terrain.heightAt = () => groundY;
    return { world, u, target, groundY, bombCount, type };
  }

  function reseedContact(world, u, target, Contact, LEVEL) {
    const map = world.detection.contactsFor(u.side);
    const c = new Contact(target, AT.loop.simTime);
    c.level = LEVEL.DETAILED;
    c.ever = true;
    c.detected = false;
    c.exactNow = false;
    c.err = 0;
    c.pos.copy(target.pos);
    map.set(target.id, c);
  }

  function placeAircraft(u, target, bearingDeg, groundY, spec) {
    const th = bearingDeg * DEG;
    u.pos.set(target.pos.x - START_D * Math.sin(th), groundY + 3000, target.pos.z + START_D * Math.cos(th));
    u.heading = th;
    u._desiredHeading = th;
    u.roll = 0;
    u.pitch = 0;
    u.speed = spec.cruiseSpeed;
  }

  function resetTrial(ctx, cfg, Contact, LEVEL) {
    const { world, u, target, groundY, bombCount } = ctx;
    const spec = u.spec;

    target.hp = target.maxHp; target.alive = true; target._deathHandled = false; target.deathCause = null;
    if (target.mounts) for (const m of target.mounts) { m.accum = 0; m.reload = 0; }
    reseedContact(world, u, target, Contact, LEVEL);

    placeAircraft(u, target, cfg.bearing, groundY, spec);
    u.hp = spec.hp; u.alive = true; u.deathCause = null; u._deathHandled = false;
    u._runTarget = null; u._runPhase = undefined; u._runHeading = undefined;
    u._tossEgress = false; u.attackRun = null;
    u.commandedAlt = null;
    u.fuel = u.fuelMax; u._rtbTriggered = false; u._bingoWarned = false;
    u.aiMode = null; u.acmMode = null; u.cranking = false; u._acmExtending = false; u.fireCooldown = 0;
    u.loadout = Array(bombCount).fill('BOMB');
    u.fireTasks = [];
    u.autoWeapons = { BOMB: true };
    u.bombProfile = cfg.profile;
    u.order = null; u.queue.length = 0;
    u.setPlayerOrder({ type: 'attack', target });

    world.missiles = [];
    world.bullets = [];
  }

  /** 1試行を最後まで進める。撃破から30秒 or 300秒で打ち切り。 */
  function runTrial(ctx, cfg, Contact, LEVEL) {
    const { world, u, target } = ctx;
    const shots = [];
    let pullEpisodeCounter = 0;
    let lastPhaseForEpisode = null;
    const episodeShotCount = new Map();
    let firedOutsidePull = 0;

    // pull フェーズへ入った回数を数えつつ、いまの一連が何回目かを返す（0=pull外）
    const noteEpisode = () => {
      const ph = u.attackRun;
      if (ph === 'pull' && lastPhaseForEpisode !== 'pull') pullEpisodeCounter++;
      lastPhaseForEpisode = ph;
      return ph === 'pull' ? pullEpisodeCounter : 0;
    };

    const onFire = (shooter, tgt, weapon, m) => {
      if (shooter !== u || weapon.kind !== 'bomb') return;
      const id = noteEpisode();
      if (id === 0) firedOutsidePull++;
      else episodeShotCount.set(id, (episodeShotCount.get(id) || 0) + 1);
      shots.push({ idx: shots.length, t: AT.loop.simTime, pullId: id, m });
    };
    world.onFire = onFire;

    let destroyedAt = null, done = false;
    const maxTicks = Math.round(300 / DT);
    let i = 0;
    for (; i < maxTicks; i++) {
      reseedContact(world, u, target, Contact, LEVEL);
      AT.loop.onFixedUpdate(DT);
      AT.loop.simTime += DT;
      const t = (i + 1) * DT;
      noteEpisode();

      if (!target.alive && destroyedAt == null) destroyedAt = t;
      if (!u.alive) done = true;
      if (destroyedAt != null && t - destroyedAt > 30) done = true;
      if (t > 300) done = true;
      if (done) break;
    }
    world.onFire = null;

    let firstMiss = null;
    const allMiss = [];
    for (const s of shots) {
      const miss = Math.hypot(s.m.pos.x - target.pos.x, s.m.pos.z - target.pos.z);
      allMiss.push(Math.round(miss));
      if (s.idx === 0) firstMiss = Math.round(miss);
    }

    return {
      destroyed: !target.alive,
      destroyedAt: destroyedAt != null ? Math.round(destroyedAt * 10) / 10 : null,
      bombsUsed: shots.length,
      pullCount: pullEpisodeCounter,
      firstMiss,
      allMiss,
      firingEpisodeShotCounts: [...episodeShotCount.values()],
      firedOutsidePull,
      aircraftAlive: u.alive,
    };
  }

  function summarizeCond(rows) {
    const n = rows.length;
    const destroyedN = rows.filter((r) => r.destroyed).length;
    const destroyedTimes = rows.filter((r) => r.destroyed && r.destroyedAt != null).map((r) => r.destroyedAt);
    const med = (arr) => {
      if (!arr.length) return null;
      const s = [...arr].sort((a, b) => a - b);
      const m = Math.floor(s.length / 2);
      return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
    };
    const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
    const round1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
    const allMissPooled = rows.flatMap((r) => r.allMiss);
    const firstMisses = rows.filter((r) => r.firstMiss != null).map((r) => r.firstMiss);
    const firingEpisodesPooled = rows.flatMap((r) => r.firingEpisodeShotCounts);
    const firedOutsidePullTotal = rows.reduce((a, r) => a + r.firedOutsidePull, 0);
    return {
      n,
      destroyedFrac: `${destroyedN}/${n}`,
      destroyedMedianT: round1(med(destroyedTimes)),
      avgBombsUsed: round1(avg(rows.map((r) => r.bombsUsed))),
      avgPullCount: round1(avg(rows.map((r) => r.pullCount))),
      avgFirstMiss: round1(avg(firstMisses)),
      avgAllMiss: round1(avg(allMissPooled)),
      avgShotsPerPull: round1(avg(firingEpisodesPooled)),
      firedOutsidePullTotal,
    };
  }

  // 引数で振る値を絞れる。`pullLeads: [null]` / `releaseIntervals: [null]` は「書き換えず既定のまま」。
  //   await __tossTuneRun({ pullLeads: [null], releaseIntervals: [null], noRef: true })  // 既定値だけ
  window.__tossTuneRun = async (opt = {}) => {
    const acm = await import('/js/sim/acm.js');
    const det = await import('/js/sim/detection.js');
    const weaponsMod = await import('/js/data/weapons.js');
    const { TOSS } = acm;
    const { Contact, LEVEL } = det;
    const BOMB = weaponsMod.WEAPONS.BOMB;

    const origPullLead = TOSS.pullLead;
    const origReleaseInterval = TOSS.releaseInterval;
    const origDispersion = BOMB.dispersionPerKm;

    const aircraftDefs = [['A-3', 'A-3', 4], ['F-2', 'F-2', 2]];
    const pullLeads = opt.pullLeads || [0.8, 0.4, 0.1];
    const releaseIntervals = opt.releaseIntervals || [0.5, 0.2, 0];

    const table = [];
    const refRows = [];
    const allRows = [];

    try {
      for (const [label, type, bombCount] of aircraftDefs) {
        const ctx = await openScenario(`tosstune_${type}`, type, bombCount);

        // 水平（基準）
        {
          const rows = [];
          for (const bearing of BEARINGS) {
            const cfg = { bearing, profile: 'level' };
            resetTrial(ctx, cfg, Contact, LEVEL);
            const res = runTrial(ctx, cfg, Contact, LEVEL);
            rows.push(res);
            allRows.push({ aircraft: label, profile: 'level', pullLead: null, releaseInterval: null, bearing, ...res });
          }
          table.push({ aircraft: label, profile: 'level', pullLead: null, releaseInterval: null, ...summarizeCond(rows) });
        }

        // トス 3(pullLead) x 3(releaseInterval)
        for (const pl of pullLeads) {
          for (const ri of releaseIntervals) {
            if (pl != null) TOSS.pullLead = pl;
            if (ri != null) TOSS.releaseInterval = ri;
            const rows = [];
            for (const bearing of BEARINGS) {
              const cfg = { bearing, profile: 'toss' };
              resetTrial(ctx, cfg, Contact, LEVEL);
              const res = runTrial(ctx, cfg, Contact, LEVEL);
              rows.push(res);
              allRows.push({ aircraft: label, profile: 'toss', pullLead: pl, releaseInterval: ri, bearing, ...res });
            }
            table.push({ aircraft: label, profile: 'toss', pullLead: TOSS.pullLead, releaseInterval: TOSS.releaseInterval, ...summarizeCond(rows) });
          }
        }

        // 散布0の参考（既定の pullLead / releaseInterval）
        if (!opt.noRef) {
          TOSS.pullLead = origPullLead;
          TOSS.releaseInterval = origReleaseInterval;
          BOMB.dispersionPerKm = 0;
          const rows = [];
          for (const bearing of BEARINGS) {
            const cfg = { bearing, profile: 'toss' };
            resetTrial(ctx, cfg, Contact, LEVEL);
            const res = runTrial(ctx, cfg, Contact, LEVEL);
            rows.push(res);
            allRows.push({ aircraft: label, profile: 'toss(散布0)', pullLead: origPullLead, releaseInterval: origReleaseInterval, bearing, ...res });
          }
          refRows.push({ aircraft: label, profile: 'toss(散布0)', pullLead: origPullLead, releaseInterval: origReleaseInterval, ...summarizeCond(rows) });
          BOMB.dispersionPerKm = origDispersion;
        }
      }
    } finally {
      TOSS.pullLead = origPullLead;
      TOSS.releaseInterval = origReleaseInterval;
      BOMB.dispersionPerKm = origDispersion;
    }

    window.__tossTuneLast = { table, refRows, allRows };
    return {
      table,
      refRows,
      restored: { pullLead: TOSS.pullLead, releaseInterval: TOSS.releaseInterval, dispersionPerKm: BOMB.dispersionPerKm },
    };
  };

  return 'tosstune ready';
})();
