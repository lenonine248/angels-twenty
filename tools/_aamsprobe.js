// AAM-S 初弾計測プローブ（§98.6 用・使い捨て）。本体コードは変えない。
//
//   fetch('/tools/bench.js').then(r=>r.text()).then(eval)
//   fetch('/tools/_aamsprobe.js').then(r=>r.text()).then(eval)
//   await AT.aamsprobe.runAB(1, AT.watch.SEEDS11)  // ESCORT を旧新で回す
//   AT.aamsprobe.results   // { old: [...], new: [...] } 各要素は1戦分
//
// 各戦につき、AAM-S が航空機を狙って撃たれた最初の4発を記録する。
//
// 注意: `world.missiles.push` を setup で包んでも、combat.js の
// `update()` が毎tick `w.missiles = w.missiles.filter(...)` で
// **配列そのものを新しく作り直す**ため、次のtickには自作の push は
// 消えている（filter は新しい配列を返す）。実際に確認したところ、
// この方式では発射が1件も拾えなかった。代わりに、発射そのものを行う
// `Combat.prototype.fire` を import 経由で1回だけ包む。
(function () {
  if (window.AT && window.AT.aamsprobe) return;

  const results = { old: [], new: [] };
  let patched = false;

  function climbRateOf(world, u) {
    const arr = world.__aamAlt.get(u.id);
    if (!arr || !arr.length) return 0;
    const curTick = world.__aamTick || 0;
    const curY = u.pos.y;
    let ref = arr[0];
    for (let i = arr.length - 1; i >= 0; i--) {
      ref = arr[i];
      if (curTick - arr[i].tick >= 15) break;
    }
    const dtTicks = curTick - ref.tick;
    if (dtTicks <= 0) return 0;
    return (curY - ref.y) / (dtTicks / 30);
  }

  function recordShot(world, rec, shooter, target, m) {
    const flat = Math.hypot(shooter.pos.x - target.pos.x, shooter.pos.z - target.pos.z);
    const aboveShooter = shooter.pos.y - target.pos.y;
    const perchShooter = flat > 4000 && aboveShooter > 0 && shooter.commandedAlt == null;
    let perchTarget = '—';
    if (target.order && target.order.type === 'attack' && target.order.target === shooter) {
      const aboveTarget = target.pos.y - shooter.pos.y;
      perchTarget = flat > 4000 && aboveTarget > 0 && target.commandedAlt == null;
    }
    const idx = rec.shots.length;
    m.__aamProbeIdx = idx;
    rec.shots.push({
      idx,
      t: +((world.__aamTick || 0) / 30).toFixed(1),
      shooterSide: shooter.side, shooterName: shooter.name,
      targetSide: target.side, targetName: target.name,
      shooterAlt: Math.round(shooter.pos.y),
      shooterSpeedH: Math.round(shooter.speed),
      shooterClimb: Math.round(climbRateOf(world, shooter)),
      targetAlt: Math.round(target.pos.y),
      targetSpeedH: Math.round(target.speed),
      targetClimb: Math.round(climbRateOf(world, target)),
      altDiff: Math.round(target.pos.y - shooter.pos.y),
      flat: Math.round(flat),
      perchShooter, perchTarget,
      pk: m.pk,
      _m: m, _target: target,
    });
  }

  async function ensurePatch() {
    if (patched) return;
    const unitMod = await import('/js/sim/unit.js');
    const missionMod = await import('/js/sim/mission.js');
    const combatMod = await import('/js/sim/combat.js');

    // 命中して倒したのがどの追跡弾かを拾う（destroy() 自体は書き換えない）
    const uproto = unitMod.Unit.prototype;
    const origDamage = uproto.damage;
    uproto.damage = function (amount, source = null) {
      if (this.alive && source && source.__aamProbeIdx != null && (this.hp - amount) <= 0) {
        this.__aamKilledByIdx = source.__aamProbeIdx;
      }
      return origDamage.call(this, amount, source);
    };

    // 発射そのもの。AAM-S・目標=生存中の航空機・4発未満のときだけ記録する。
    const cproto = combatMod.CombatSystem.prototype;
    const origFire = cproto.fire;
    cproto.fire = function (shooter, target, weapon) {
      const m = origFire.call(this, shooter, target, weapon);
      const world = this.world;
      if (m && world.__aamRec && weapon && weapon.id === 'AAM-S'
        && target && target.kind === 'aircraft' && target.alive
        && world.__aamRec.shots.length < 4) {
        recordShot(world, world.__aamRec, shooter, target, m);
      }
      return m;
    };

    // 高度履歴（上昇率算出用）と、自軍最初の喪失の tick を拾う
    const mproto = missionMod.Mission.prototype;
    const origMissionUpdate = mproto.update;
    mproto.update = function (dt) {
      const world = this.world;
      if (world && world.__aamRec) {
        world.__aamTick = (world.__aamTick || 0) + 1;
        const rec = world.__aamRec;
        for (const u of world.units) {
          if (u.kind !== 'aircraft') continue;
          if (u.alive) {
            let arr = world.__aamAlt.get(u.id);
            if (!arr) { arr = []; world.__aamAlt.set(u.id, arr); }
            arr.push({ tick: world.__aamTick, y: u.pos.y });
            if (arr.length > 40) arr.shift();
          } else if (u.side === world.playerSide && u.deathCause !== 'withdraw' && !rec.firstLossSeen) {
            rec.firstLossSeen = true;
            rec.firstLoss = {
              name: u.name, t: +(world.__aamTick / 30).toFixed(1),
              killedByIdx: u.__aamKilledByIdx != null ? u.__aamKilledByIdx : null,
            };
          }
        }
      }
      return origMissionUpdate.call(this, dt);
    };

    patched = true;
  }

  function attachRecorder(b, old) {
    globalThis.__approachOld = !!old;
    const w = b.world;
    w.__aamAlt = new Map();
    w.__aamTick = 0;
    const rec = {
      stage: b.stage.name, seed: b.seed, old,
      shots: [], firstLossSeen: false, firstLoss: null,
    };
    w.__aamRec = rec;
    return rec;
  }

  function finalize(rec) {
    for (const s of rec.shots) {
      const m = s._m, tg = s._target;
      s.hitReason = m.endReason || null;
      s.killed = tg.__aamKilledByIdx === s.idx;
      s.shooterSpeedTot = Math.round(Math.hypot(s.shooterSpeedH, s.shooterClimb));
      s.targetSpeedTot = Math.round(Math.hypot(s.targetSpeedH, s.targetClimb));
      delete s._m; delete s._target;
    }
    if (rec.firstLoss) {
      rec.firstLoss.matchesTrackedShot = rec.shots.some((s) => s.idx === rec.firstLoss.killedByIdx);
    }
    delete rec.firstLossSeen;
  }

  async function run(stageIndex, seeds, old) {
    await ensurePatch();
    const bucket = old ? results.old : results.new;
    for (const seed of seeds) {
      let attached = null;
      const summary = await AT.bench.stage(stageIndex, 0, {
        seeds: [seed],
        setup: (b) => { attached = attachRecorder(b, old); },
      });
      finalize(attached);
      attached.summary = summary;
      bucket.push(attached);
    }
    return bucket.length;
  }

  async function runAB(stageIndex, seeds) {
    results.old.length = 0; results.new.length = 0;
    await run(stageIndex, seeds, true);
    await run(stageIndex, seeds, false);
    delete globalThis.__approachOld;
    return { old: results.old.length, new: results.new.length };
  }

  window.AT = window.AT || {};
  window.AT.aamsprobe = { run, runAB, results, ensurePatch };
})();
