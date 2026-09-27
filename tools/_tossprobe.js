// トス爆撃（上昇しながらの無誘導爆弾投下）の着弾ずれ計測プローブ。
// ゲーム本体(js/)は一切変更しない。実行専用・使い捨てではなく再利用前提。
//
// 読み込み:
//   fetch('/tools/_tossprobe.js').then(r => r.text()).then(eval)
// 実行（1回の呼び出しの中で最後まで回すこと。§93.12 と同じ理由で、
// 呼び出しを分けると合間の実時間ぶん本体の rAF が戦闘を進めてしまう）:
//   await __tossRun()
//
// 返り値: 条件ごとの要約配列（W: 機種+搭載, cfg: 条件, shots: 弾ごとの記録, destroyed）。
// 生ログは window.__tossLast に積むので、あとから覗ける。
(() => {
  const DT = 1 / 30;
  const DEG = Math.PI / 180;
  const TARGET_XZ = { x: 26000, z: 28000 }; // w7 と同じ目標座標

  function flatTutorial(id, aircraftType, bombCount) {
    return {
      id,
      group: '計測',
      name: 'TOSS PROBE',
      title: '計測用（非表示）',
      brief: '計測用の内部ステージ。地形はほぼ平坦。',
      hint: '',
      terrain: { seed: 90017, mountainAmount: 0, coast: 'none', valleyDepth: 0, rivers: 0, baseAltitude: 400 },
      weaponPoints: 0,
      noFail: true,
      friendly: {
        base: { x: 11000, z: 40000 },
        startAirborne: true,
        startAlt: 3000,
        aircraft: [{
          type: aircraftType,
          name: 'PROBE 1',
          loadout: Array(bombCount).fill('BOMB'),
          autoWeapons: { BOMB: false, GUN: false },
        }],
      },
      enemy: {
        aircraft: [],
        ground: [
          { type: 'RADAR', name: 'レーダーサイト', x: TARGET_XZ.x, z: TARGET_XZ.z, tags: ['target'], known: true },
        ],
      },
      steps: [{ text: '(計測用ダミー手順)', check: () => false }],
    };
  }

  /** 指定機種のフラット版チュートリアルを開き、機体・目標・地形の参照を返す */
  async function openFlat(id, type, bombCount) {
    if (!AT.tutorials.find((t) => t.id === id)) AT.tutorials.push(flatTutorial(id, type, bombCount));
    await __open(id);
    const b = AT.battle;
    const world = b.world;
    const u = world.units.find((x) => x.kind === 'aircraft' && x.side === world.playerSide);
    const target = world.units.find((x) => x.name === 'レーダーサイト');
    // 地形を平らにする。mountainAmount/valleyDepth を0にしても基調のfBmが残るので、
    // 目標の実測標高でそのまま固定する（heightAt を丸ごと置き換える。
    // LOS判定・地形フロア計算・爆弾の地面命中判定はすべてこれ経由なので、これだけで足りる）。
    const groundY = target.pos.y;
    world.terrain.heightAt = () => groundY;
    return { world, u, target, groundY, bombCount };
  }

  /**
   * `known` のコンタクトを作り直す（`main.js` の `seedKnownContacts` と同じ形）。
   *
   * **1試行の間ずっと、毎tick呼ぶ。** 理由は2つあって、どちらも実測して分かった:
   *
   * 1. `sim/detection.js` は目標が死ぬと `map.delete`（§363）するので、次の試行で
   *    `target.alive` だけ戻してもコンタクトが無いままになる。
   * 2. **生きている試行の途中でも消える。** 手で1回だけ種を植えた版で測ったら、
   *    目標の真上（水平距離1桁m）を通過する1〜2tickだけ実機のセンサー判定が
   *    「見えていない」を返し、`_age()` が誤差を積んで `LOST_ERROR` を超え、
   *    まさに投下したい瞬間に `map.delete` → `believedPosOf` が null →
   *    攻撃指示が `_releaseTarget` で解かれて自機中心の待機旋回に落ちる
   *    （高速条件で7条件中7条件が0発になり、原因はこれだった）。
   *
   * この計測はセンサーの当たり判定ではなく弾道解のずれを見るものなので、
   * 「静止・既知の目標をこの試行中はずっと正確に把握している」を土台として
   * 固定する。毎tick作り直すのはそのため。
   */
  function reseedContact(world, u, target) {
    const { Contact, LEVEL } = window.__tossDetection;
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

  function resetTrial(ctx, cfg) {
    const { world, u, target, groundY, bombCount } = ctx;
    target.hp = target.maxHp;
    target.alive = true;
    target._deathHandled = false;
    reseedContact(world, u, target);

    u.pos.set(TARGET_XZ.x, groundY + 300, TARGET_XZ.z + 12000); // 目標の南12km、北向き
    u.heading = 0;
    u._desiredHeading = 0;
    u.roll = 0;
    u.pitch = 0;
    u.speed = cfg.speed;
    u._runTarget = null; // groundAttackRun の進入/離脱フェーズを仕切り直す
    u._runPhase = undefined;
    u._runHeading = undefined;
    u.commandedAlt = null;
    u.fuel = u.fuelMax; // 試行をまたいで累積させない（燃料切れが強制RTBで指示を上書きする）
    u._rtbTriggered = false;
    u._bingoWarned = false;
    u.aiMode = null;
    u.acmMode = null;
    u.cranking = false;
    u._acmExtending = false;
    u.fireCooldown = 0;
    u.loadout = Array(bombCount).fill('BOMB');
    u.fireTasks = Array(bombCount).fill(0).map(() => ({ weapon: 'BOMB', target }));
    u.order = null;
    u.queue.length = 0;
    u.setPlayerOrder({ type: 'attack', target });

    // 速度固定（「高速」条件）。desiredSpeed は毎tick `this.desiredSpeed = clamp(...)`
    // で上書きされる素のプロパティなので、アクセサに差し替えて書き込みを無視させる。
    if (cfg.pinSpeed) {
      Object.defineProperty(u, 'desiredSpeed', {
        configurable: true, get: () => cfg.speed, set: () => {},
      });
    } else {
      const d = Object.getOwnPropertyDescriptor(u, 'desiredSpeed');
      if (d && d.get) delete u.desiredSpeed; // 前の試行の固定を解除、素のプロパティに戻す
      u.desiredSpeed = cfg.speed;
    }

    if (cfg.altCmd) AT.commands._applyAltitude(u, groundY + 300);
    world.missiles = [];
  }

  /** 1試行を最後まで進める */
  function runTrial(ctx, cfg) {
    const { world, u, target, groundY } = ctx;
    const acm = window.__tossAcm;
    const shots = [];
    let pending = null;
    let lastFireT = -Infinity;
    let pulled = cfg.Dpull == null;

    const onFire = (shooter, tgt, weapon, m) => {
      if (shooter !== u) return;
      const aim = world.believedPosOf(shooter.side, tgt) || tgt.pos;
      const sol = acm.bombAimPoint(shooter, tgt, aim);
      const hit = acm.bombImpactPoint(shooter, sol.throwRange);
      const rec = {
        idx: shots.length,
        t: AT.loop.simTime,
        flatAtFire: Math.hypot(tgt.pos.x - shooter.pos.x, tgt.pos.z - shooter.pos.z),
        pitchDeg: (shooter.pitch || 0) / DEG,
        agl: shooter.pos.y - groundY,
        heading: shooter.heading,
        speedAtFire: shooter.speed,
        vhSol: shooter.speed * Math.cos(shooter.pitch || 0),
        vySol: shooter.speed * Math.sin(shooter.pitch || 0),
        throwRange: sol.throwRange,
        fallTime: sol.fallTime,
        predicted: { x: hit.x, z: hit.z },
        actualVh: null,
        actualVy: null,
        missileVel0: null,
        m,
      };
      shots.push(rec);
      pending = rec;
      lastFireT = AT.loop.simTime;
    };
    world.onFire = onFire;

    const prevPos = u.pos.clone();
    let done = false;
    const maxTicks = Math.round(300 / DT);
    let i = 0;
    for (; i < maxTicks; i++) {
      reseedContact(world, u, target); // 毎tick再固定（上のコメント参照）

      if (!pulled) {
        const flatNow = Math.hypot(target.pos.x - u.pos.x, target.pos.z - u.pos.z);
        if (flatNow < cfg.Dpull) {
          AT.commands._applyAltitude(u, groundY + 4000);
          pulled = true;
        }
      }

      AT.loop.onFixedUpdate(DT);
      AT.loop.simTime += DT;

      if (pending) {
        pending.actualVh = Math.hypot(u.pos.x - prevPos.x, u.pos.z - prevPos.z) / DT;
        pending.actualVy = (u.pos.y - prevPos.y) / DT;
        pending = null;
      }
      prevPos.copy(u.pos);

      for (const s of shots) {
        if (s.missileVel0 == null && s.m.vel) {
          s.missileVel0 = { x: s.m.vel.x, y: s.m.vel.y, z: s.m.vel.z };
        }
      }

      const dx = target.pos.x - u.pos.x, dz = target.pos.z - u.pos.z;
      const flat = Math.hypot(dx, dz);
      const fx = Math.sin(u.heading), fz = -Math.cos(u.heading);
      const aheadDot = dx * fx + dz * fz;
      if (aheadDot < 0 && flat > 3000) done = true;
      if (shots.length > 0 && shots.every((s) => !s.m.alive) && AT.loop.simTime - lastFireT > 5
          && u.fireTasks.length === 0) done = true;
      if (shots.length > 0 && AT.loop.simTime - lastFireT > 60) done = true;
      if (done) break;
    }
    world.onFire = null;

    for (const s of shots) {
      s.actualImpact = { x: s.m.pos.x, z: s.m.pos.z };
      s.endReason = s.m.endReason;
      const fx = Math.sin(s.heading), fz = -Math.cos(s.heading);
      const ex = s.actualImpact.x - s.predicted.x, ez = s.actualImpact.z - s.predicted.z;
      s.alongError = ex * fx + ez * fz; // 進行方向成分。手前に落ちていればマイナス
      s.missFromTarget = Math.hypot(s.actualImpact.x - target.pos.x, s.actualImpact.z - target.pos.z);
    }
    return { shots, destroyed: !target.alive, ticksUsed: i };
  }

  window.__tossRun = async () => {
    const acm = await import('/js/sim/acm.js');
    const wdata = await import('/js/data/weapons.js');
    const det = await import('/js/sim/detection.js');
    window.__tossAcm = acm;
    window.__tossDetection = det;
    const BOMB = wdata.WEAPONS.BOMB;
    const origDispersion = BOMB.dispersionPerKm;
    BOMB.dispersionPerKm = 0;

    const out = [];
    try {
      for (const [label, type, bombCount] of [['A-3', 'A-3', 4], ['F-2', 'F-2', 2]]) {
        const ctx = await openFlat(`tossprobe_${type}`, type, bombCount);
        const low = ctx.u.spec.cruiseSpeed * 0.85;
        const high = ctx.u.spec.maxSpeed * 0.92;
        const speeds = [['低速', low, false], ['高速', high, true]];
        const pulls = [
          ['D2500', 2500, true], ['D3000', 3000, true], ['D4000', 4000, true],
          ['D5000', 5000, true], ['D6000', 6000, true],
          ['対照1_水平のまま', null, true],
          ['対照2_高度指示なし', null, false],
        ];
        for (const [spLabel, spVal, pinSpeed] of speeds) {
          for (const [pLabel, Dpull, altCmd] of pulls) {
            const cfg = { speed: spVal, pinSpeed, Dpull, altCmd };
            resetTrial(ctx, cfg);
            const res = runTrial(ctx, cfg);
            out.push({ aircraft: label, speedLabel: spLabel, speed: Math.round(spVal), pullLabel: pLabel, ...res });
          }
        }
      }

      // 散布ありの確認（1条件だけ）: A-3 低速 D3000 相当を再現
      BOMB.dispersionPerKm = origDispersion;
      const ctxA = await openFlat('tossprobe_A-3', 'A-3', 4);
      const lowA = ctxA.u.spec.cruiseSpeed * 0.85;
      const cfgDisp = { speed: lowA, pinSpeed: false, Dpull: 3000, altCmd: true };
      resetTrial(ctxA, cfgDisp);
      const dispRes = runTrial(ctxA, cfgDisp);
      out.push({ aircraft: 'A-3', speedLabel: '低速', speed: Math.round(lowA), pullLabel: 'D3000_散布1.4(参考)', ...dispRes });
    } finally {
      BOMB.dispersionPerKm = origDispersion;
    }

    window.__tossLast = out;
    return out.map((r) => ({
      aircraft: r.aircraft, speed: r.speedLabel, pull: r.pullLabel,
      shots: r.shots.length,
      firstFlat: r.shots[0] ? Math.round(r.shots[0].flatAtFire) : null,
      firstPitchDeg: r.shots[0] ? Math.round(r.shots[0].pitchDeg * 10) / 10 : null,
      firstAgl: r.shots[0] ? Math.round(r.shots[0].agl) : null,
      firstAlongError: r.shots[0] ? Math.round(r.shots[0].alongError) : null,
      missFromTarget: r.shots.map((s) => Math.round(s.missFromTarget)),
      destroyed: r.destroyed,
      ticksUsed: r.ticksUsed,
    }));
  };

  window.__tossInternal = { openFlat, resetTrial, runTrial, reseedContact };
  return 'tossprobe ready';
})();
