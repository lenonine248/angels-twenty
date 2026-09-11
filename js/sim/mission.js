// ミッション目標の判定。仕様書 §12。
//
// 重要な原則: 判定は**内部の真の状態**で行う。
// 目標が自軍の視界外で破壊された場合も、条件を満たしていればクリアになる
// （プレイヤーの画面上は「状態不明」のままでも、実際に壊れていれば達成）。

export const MISSION = { ACTIVE: 'active', CLEAR: 'clear', FAIL: 'fail' };

/** タグを持つユニット。**陣営で絞らない** —— タグはどちらの側のものも指せる */
function tagged(world, tag) {
  return world.units.filter((u) => u.tags && u.tags.includes(tag));
}

/**
 * 目標1件を進める（§27.6）。**陣営に依らない。**
 *
 * `Mission`（プレイヤーの勝敗）と `SideObjectives`（敵の任務）が同じ式を使う。
 * 2か所に書くと必ずずれる —— しかも敵側は勝敗に出ないので、
 * ずれても**誰も気づかないまま敵の判断だけが狂う**。
 *
 * @param {object} o     `{ type, tag, done, failed, ... }`。破壊的に更新する
 * @param {object} world
 * @param {number} time  任務開始からの秒数（`survive` が見る）
 */
export function advanceObjective(o, world, time, pending = null) {
  if (o.done || o.failed) return;
  switch (o.type) {
    case 'destroyAll': {
      // **まだ湧いてくるうちは「全滅」ではない**（§74.3）。
      //
      // 増援にタグを付けると、波と波の谷間で `units` が全滅状態になる ——
      // 実測で LONG WATCH が **t78 に達成**していた（1波目を落としただけ。
      // 2波目は t200）。倒した数ではなく、**敵が送るのをやめたか**で見る。
      //
      // 湧き元（飛行場）を潰せば `pending` から消えるので、
      // **元を断てば待たずに畳める** —— 近道がここで効く。
      if (pending && pending.has(o.tag)) break;
      const units = tagged(world, o.tag);
      if (units.length > 0 && units.every((u) => !u.alive)) o.done = true;
      break;
    }
    case 'protect': {
      const units = tagged(world, o.tag);
      if (units.length > 0 && units.some((u) => !u.alive)) o.failed = true;
      break;
    }
    // **N個以上残っていれば持ちこたえている**（§74.1）。
    //
    // `protect` は1つでも失えば即失敗という二値で、防衛任務をその形で作ると
    // **1機抜けただけで終わる** —— SCRAMBLE が5回続けて物理の改善を止めた形（§36）。
    // 「守りが強くなる → 双方が落ちない → 爆撃機が抜ける」で、
    // 殺傷力をどちらへ動かしても結果が反転してしまう。
    //
    // 残す数に幅を持たせると、**殺傷力の変化に対して結果が連続的に動く。**
    case 'hold': {
      const units = tagged(world, o.tag);
      if (!units.length) break;
      const left = units.filter((u) => u.alive).length;
      if (left < (o.min ?? 1)) o.failed = true;
      break;
    }
    case 'reach': {
      const units = tagged(world, o.tag).filter((u) => u.alive);
      if (units.some((u) => Math.hypot(u.pos.x - o.x, u.pos.z - o.z) < (o.radius || 3000))) {
        o.done = true;
      }
      break;
    }
    case 'survive':
      if (time >= o.seconds) o.done = true;
      break;
    default: break;
  }
}

/**
 * 目標の見出しに足す進み具合（§74.1）。
 *
 * `hold` は**あと何個で負けるか**が読めないと判断できない ——
 * 「3つ以上残す」とだけ書いてあっても、いま4つなのか5つなのかで
 * 前に出るか下がるかが変わる。
 */
function objectiveSuffix(o, world) {
  if (o.type !== 'hold') return '';
  const units = tagged(world, o.tag);
  if (!units.length) return '';
  return `（${units.filter((u) => u.alive).length}/${units.length} 健在）`;
}

/**
 * **敵側の任務**（§27.6）。勝敗には出ない、司令官AIへの指示書。
 *
 * `ai/commander.js` は `mission.objectives` から
 * 「何を壊すか／誰を護るか」を読む。赤に司令官を渡すとき、
 * ここが無いと**目標が空になって全機 COORDINATE に落ちる** ——
 * 敵が陣営として動かない。§27.6 の実質の作業はここだった。
 *
 * `Mission` を使い回さないのは、あちらが**プレイヤーの勝敗**を持っているから。
 * 敵の目標が達成されても、それがそのまま敗北になるとは限らない
 * （「飛行場を守る」を `protect` 目標として**プレイヤー側に**書くのが敗北条件）。
 *
 * ステージ定義では `enemy.objectives` に書く。タグの向きは自軍と同じ:
 *
 * | 型 | タグが指す先 |
 * |---|---|
 * | `destroyAll` | **相手側**（敵から見れば自軍）のユニット |
 * | `protect` | **自分側**（敵自身）のユニット |
 */
export class SideObjectives {
  constructor(world, list) {
    this.world = world;
    this.time = 0;
    this._accum = 0;
    this.objectives = (list || []).map((o) => ({ ...o, done: false, failed: false }));
  }

  update(dt) {
    this.time += dt;
    this._accum += dt;
    if (this._accum < 0.5) return;      // 判定は2Hzで十分（Mission と同じ）
    this._accum = 0;
    for (const o of this.objectives) advanceObjective(o, this.world, this.time);
  }
}

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
    // `after: 'detected'` を書くと、**こちらが敵に見つかるまで時計が動かない**（§80.5）
    this.reinforce.push({
      airbase, config, timer: config.every, spawned: 0,
      armed: config.after !== 'detected',
    });
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
    const pending = this._pendingTags();
    for (const o of this.objectives) advanceObjective(o, w, this.time, pending);

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

  /**
   * **これから湧いてくる**敵に付くタグ（§74.3）。
   *
   * 飛行場を潰すか、送る数を出し切れば、そのタグは外れる。
   */
  /** その陣営が、こちらの機体を1機でも掴んでいるか（§80.5） */
  _spotted(side) {
    const d = this.world.detection;
    if (!d) return false;
    for (const [, c] of d.contactsFor(side)) {
      const t = c.unit;
      if (t && t.alive && t.kind === 'aircraft' && t.side === this.world.playerSide) return true;
    }
    return false;
  }

  _pendingTags() {
    const set = new Set();
    for (const r of this.reinforce) {
      if (!r.airbase.alive) continue;               // 潰せば止まる
      if (r.spawned >= r.config.max) continue;      // 出し切った
      for (const t of r.config.tags || []) set.add(t);
    }
    return set;
  }

  _fail(reason) {
    this.state = MISSION.FAIL;
    this.failReason = reason;
    this.world.log?.(`【任務失敗】${reason}`);
  }

  // -------------------------------------------------------------- 増援

  /**
   * 増援。**飛行場を潰せば止まる**（防衛任務では「元を断つ」が選択肢になる）。
   *
   * 書き方は2通り（§74.2）:
   *
   * | | |
   * |---|---|
   * | `{ every, max, type }` | 1機ずつ。従来どおり |
   * | `{ every, max, types: [...], burst: N }` | **一度に N 機、機種を順に配る** |
   *
   * 波状の来襲は後者で書く —— 爆撃機と護衛を混ぜた編隊が、間を置いて何度か来る。
   * `types` は使い切ったら先頭へ戻る。`max` は**機数の総計**で数える。
   *
   * `tags` を書くと増援にもタグが付く（§74.3）。これが無いと
   * **「来襲した編隊を全滅させる」を目標に書けない** —— 湧いてくるほうにタグが無く、
   * `destroyAll` が最初の4機を落とした時点で達成になってしまう。
   */
  _updateReinforcements(dt) {
    for (const r of this.reinforce) {
      if (!r.airbase.alive) continue;              // 飛行場を潰せば増援は止まる
      if (r.spawned >= r.config.max) continue;
      // **見つかってから上げる**（§80.5）。
      //
      // 迎撃機を時計だけで上げると、こちらがまだ自陣にいるうちから
      // 敵が湧いている。「侵入を察知して緊急発進した」という筋にするなら、
      // 起算はそちらが**こちらを掴んだ瞬間**であるべき。
      // 一度動き出した時計は止めない —— 隠れ直せば湧かなくなる、では
      // **見つからないように往復するのが最適手**になってしまう。
      if (!r.armed) {
        if (!this._spotted(r.airbase.side)) continue;
        r.armed = true;
      }
      r.timer -= dt;
      if (r.timer > 0) continue;
      r.timer = r.config.every;
      const burst = Math.max(1, r.config.burst || 1);
      const list = r.config.types;
      for (let i = 0; i < burst && r.spawned < r.config.max; i++) {
        const type = list ? list[r.spawned % list.length] : r.config.type;
        r.spawned++;
        this.world.spawnReinforcement?.(r.airbase, type, r.spawned, r.config.tags);
      }
    }
  }

  /** UI表示用 */
  status() {
    return this.objectives.map((o) => ({
      label: o.label + objectiveSuffix(o, this.world),
      state: o.failed ? 'failed' : o.done ? 'done' : 'active',
      optional: !!o.fail,
    }));
  }
}
