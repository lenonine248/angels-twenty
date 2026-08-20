// ミッション目標の判定。仕様書 §12。
//
// 重要な原則: 判定は**内部の真の状態**で行う。
// 目標が自軍の視界外で破壊された場合も、条件を満たしていればクリアになる
// （プレイヤーの画面上は「状態不明」のままでも、実際に壊れていれば達成）。

export const MISSION = { ACTIVE: 'active', CLEAR: 'clear', FAIL: 'fail' };

export class Mission {
  constructor(world, stage) {
    this.world = world;
    this.stage = stage;
    this.time = 0;
    this.state = MISSION.ACTIVE;
    this.failReason = null;

    this.objectives = (stage.objectives || []).map((o) => ({
      ...o, done: false, failed: false,
    }));

    /** 敵飛行場からの増援管理 */
    this.reinforce = [];
    this._accum = 0;
  }

  registerReinforcement(airbase, config) {
    this.reinforce.push({ airbase, config, timer: config.every, spawned: 0 });
  }

  update(dt) {
    if (this.state !== MISSION.ACTIVE) return;
    this.time += dt;

    this._accum += dt;
    if (this._accum < 0.5) return;      // 判定は2Hzで十分
    const step = this._accum;
    this._accum = 0;

    this._updateReinforcements(step);
    this._evaluate();
  }

  // -------------------------------------------------------------- 判定

  _evaluate() {
    const w = this.world;

    // 敗北条件を置かないステージ（チュートリアルなど）。
    // 目標も敗北条件も無いので、この任務は自分からは終わらない。
    // 終わらせるのは画面側の仕事になる。
    if (this.stage.noFail) return;

    // --- 敗北条件（仕様 §12） ---
    const myAircraft = w.units.filter(
      (u) => u.kind === 'aircraft' && u.side === w.playerSide);
    if (myAircraft.length > 0 && myAircraft.every((u) => !u.alive)) {
      return this._fail('自軍の戦闘機が全滅しました');
    }
    const myBases = w.units.filter((u) => u.kind === 'airbase' && u.side === w.playerSide);
    if (myBases.length > 0 && myBases.every((u) => !u.alive)) {
      return this._fail('自軍の飛行場をすべて失いました');
    }

    // --- 目標ごとの判定 ---
    for (const o of this.objectives) {
      if (o.done || o.failed) continue;
      switch (o.type) {
        case 'destroyAll': {
          const units = this._tagged(o.tag);
          if (units.length > 0 && units.every((u) => !u.alive)) o.done = true;
          break;
        }
        case 'protect': {
          const units = this._tagged(o.tag);
          if (units.length > 0 && units.some((u) => !u.alive)) o.failed = true;
          break;
        }
        case 'reach': {
          const units = this._tagged(o.tag).filter((u) => u.alive);
          if (units.some((u) => Math.hypot(u.pos.x - o.x, u.pos.z - o.z) < (o.radius || 3000))) {
            o.done = true;
          }
          break;
        }
        case 'survive':
          if (this.time >= o.seconds) o.done = true;
          break;
        default: break;
      }
    }

    const failed = this.objectives.find((o) => o.failed && o.fail);
    if (failed) return this._fail(failed.label + ' に失敗しました');

    const required = this.objectives.filter((o) => !o.fail);
    if (required.length > 0 && required.every((o) => o.done)) {
      this.state = MISSION.CLEAR;
      this.world.log?.('【任務完了】すべての目標を達成しました');
    }

    if (this.stage.timeLimit && this.time > this.stage.timeLimit) {
      this._fail('制限時間を超過しました');
    }
    return undefined;
  }

  _fail(reason) {
    this.state = MISSION.FAIL;
    this.failReason = reason;
    this.world.log?.(`【任務失敗】${reason}`);
  }

  _tagged(tag) {
    return this.world.units.filter((u) => u.tags && u.tags.includes(tag));
  }

  // -------------------------------------------------------------- 増援

  _updateReinforcements(dt) {
    for (const r of this.reinforce) {
      if (!r.airbase.alive) continue;              // 飛行場を潰せば増援は止まる
      if (r.spawned >= r.config.max) continue;
      r.timer -= dt;
      if (r.timer > 0) continue;
      r.timer = r.config.every;
      r.spawned++;
      this.world.spawnReinforcement?.(r.airbase, r.config.type, r.spawned);
    }
  }

  /** UI表示用 */
  status() {
    return this.objectives.map((o) => ({
      label: o.label,
      state: o.failed ? 'failed' : o.done ? 'done' : 'active',
      optional: !!o.fail,
    }));
  }
}
