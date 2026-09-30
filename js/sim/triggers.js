// 敵側・友軍側のトリガー（条件 → 行動）。仕様書 §12.3（敵側）・§9.8.1（友軍側・§102 A2）。
//
// ステージ作者が「SAM が落ちたら迎撃機を飛行場へ戻す」のような筋を書くための仕組み。
// `stage.enemy.triggers` / `stage.ally.triggers` を書いた面でだけ動く —— 書かなければ何も起きない。
//
// **敵側は、敵が知りうることだけで判定する。**
// 数えるのは敵自身の損害と戦力、それに敵のセンサーがいま掴んでいる自軍機。
// 見えていない自軍の動きや損害で敵が動いたら、プレイヤーから見て理不尽になる。
//
// **友軍側はどちらの陣営のタグも読む**（プレイヤーの決め）。友軍はプレイヤーと敵対しないので、
// 見えていない敵の損害を知っていても理不尽にはならない ——「敵の防空が壊れたら友軍が動く」を書くための口。
// **行動が触るのは友軍の機体だけ**（プレイヤーの機体は同じ陣営でも動かさない）。
//
// 乱数は使わない。条件は `world.units` と探知から作るので、種を固定したベンチはそのまま使える。

import { SIDE, OWNER } from './unit.js';
import { GROUND_MODES } from './ground.js';

export const TRIGGER_CONDITIONS = ['time', 'detected', 'destroyed', 'below', 'enter', 'reach', 'fired'];
export const TRIGGER_ACTIONS = ['guard', 'defend', 'restore', 'launch', 'reinforce', 'notice', 'ground', 'spawn'];

/** `reach` の半径の既定（m）。艦の持ち場の到達判定（150m）より広くとり、止まる手前でも拾う */
export const REACH_DEFAULT_R = 500;

/** 陣取る高さの既定（対地・m）と持ち場の半径の既定。`spawnStage` の敵機と同じ値 */
export const GUARD_DEFAULT = { agl: 5000, radius: 4500 };
/** 飛行場の防空に戻るときの持ち場（飛行場の上・m） */
export const DEFEND_AREA = { above: 4000, radius: 6000 };

/**
 * 司令官が割り当てるモード。**戻すときはこれを直接書き戻さない** ——
 * 攻撃目標などは司令官が一緒に決めているので、`COORDINATE` にして司令官に選び直させる。
 */
const COMMANDER_MODES = new Set(['ESCORT', 'STRIKE', 'COORDINATE']);

export class SideTriggers {
  /**
   * @param {object} world
   * @param {object[]} list   `stage.enemy.triggers` / `stage.ally.triggers`
   * @param {object} mission  `Mission`。時刻・増援・探知の判定・飛行場を借りる
   * @param {object} [opts]
   * @param {string} [opts.side]   陣営（既定は敵）
   * @param {string|null} [opts.owner]  指揮系統。友軍なら 'ally'（§102）。敵は持たない
   */
  constructor(world, list, mission, { side = SIDE.RED, owner = null } = {}) {
    this.world = world;
    this.mission = mission;
    this.side = side;
    this.owner = owner;
    this.triggers = (list || []).map((t) => ({ def: t, metAt: null, done: false }));
    /** 実行した記録 `{ id, t }`。測定の道具が読む */
    this.log = [];
    this._launched = 0;
  }

  /** `Mission.update` から 2Hz で呼ばれる */
  update(time) {
    for (const t of this.triggers) {
      if (t.done) continue;
      if (t.metAt == null) {
        if (!this._met(t.def)) continue;
        t.metAt = time;
      }
      if (time < t.metAt + (t.def.delay || 0)) continue;
      t.done = true;
      this.log.push({ id: t.def.id, t: time });
      for (const a of t.def.do || []) this._act(a);
    }
  }

  /** 実行済みか（`fired` の条件が読む） */
  fired(id) {
    return this.triggers.some((t) => t.done && t.def.id === id);
  }

  // -------------------------------------------------------------- 条件

  _met(def) {
    const list = def.when || [];
    if (!list.length) return false;          // 条件の無いトリガーは動かさない（書きかけ）
    return def.match === 'any' ? list.some((c) => this._cond(c)) : list.every((c) => this._cond(c));
  }

  _cond(c) {
    const w = this.world;
    switch (c.type) {
      case 'time': return this.mission.time >= (c.seconds || 0);
      case 'detected': return this.mission._spotted(this.side);
      case 'destroyed': {
        const units = this._tagged(c.tag);
        if (!units.length) return false;
        const dead = units.filter((u) => !u.alive).length;
        return c.count > 0 ? dead >= c.count : dead === units.length;
      }
      case 'below': {
        // **持ち主がまだ1つもいなければ成立させない。** 増援だけで作る編隊は
        // 開始時に0機なので、ここで成立させると開幕に発火してしまう
        // タグなしは**この司令官の手持ち**（敵なら敵の航空機すべて・友軍なら友軍機だけ）
        const units = c.tag ? this._tagged(c.tag)
          : w.units.filter((u) => this._mine(u) && u.kind === 'aircraft');
        if (!units.length) return false;
        return units.filter((u) => u.alive).length <= (c.n ?? 0);
      }
      case 'enter': {
        // **その陣営がいま掴んでいる相手の機体だけを、見えている位置で数える。**
        // 真の位置で数えると、見えていない侵入に敵が反応する
        const d = w.detection;
        if (!d) return false;
        const r = c.r || 5000;
        for (const [, ct] of d.contactsFor(this.side)) {
          const u = ct.unit;
          if (!ct.detected || !u || !u.alive || u.kind !== 'aircraft' || u.side === this.side) continue;
          if (Math.hypot(ct.pos.x - c.x, ct.pos.z - c.z) <= r) return true;
        }
        return false;
      }
      case 'reach': {
        // **自分の側のユニットがその地点に着いた**（§107）。艦・地上・航空機を問わない。
        // 数えるのは自分の手の内の真の位置なので、「知りうることだけで判定する」に反しない
        const r = c.r || REACH_DEFAULT_R;
        return this._tagged(c.tag).some((u) => u.alive && u.side === this.side
          && Math.hypot(u.pos.x - c.x, u.pos.z - c.z) <= r);
      }
      case 'fired': return this.fired(c.id);
      default: return false;
    }
  }

  /**
   * 条件が数えるそのタグのユニット。
   * **敵側は自分の陣営だけ**（プレイヤー側のタグは見ない —— 見えていない損害は分からない）。
   * **友軍側はどちらの陣営も**（プレイヤーの機体・敵の施設を含む・§102 A2）
   */
  _tagged(tag) {
    const all = this.owner === OWNER.ALLY;
    return this.world.units.filter((u) => (all || u.side === this.side) && u.tags && u.tags.includes(tag));
  }

  /** この司令官の手持ちか。敵は陣営だけ、友軍は `owner` まで見る（プレイヤーの機体は動かさない） */
  _mine(u) {
    return u.side === this.side && (u.owner ?? null) === this.owner;
  }

  /** 行動が触るそのタグのユニット（手持ちだけ） */
  _own(tag) {
    return this.world.units.filter((u) => this._mine(u) && u.tags && u.tags.includes(tag));
  }

  // -------------------------------------------------------------- 行動

  _act(a) {
    const w = this.world;
    switch (a.type) {
      case 'guard': {
        const h = w.terrain ? Math.max(0, w.terrain.heightAt(a.x, a.z)) : 0;
        this._station(a.tag, { x: a.x, z: a.z, alt: h + (a.alt || GUARD_DEFAULT.agl),
          radius: a.r || GUARD_DEFAULT.radius });
        break;
      }
      case 'defend': {
        const ab = this._base(a.base);
        if (!ab) break;
        this._station(a.tag, { x: ab.pos.x, z: ab.pos.z, alt: ab.pos.y + DEFEND_AREA.above,
          radius: DEFEND_AREA.radius });
        break;
      }
      case 'restore':
        for (const u of this._aircraft(a.tag)) this._restore(u);
        break;
      case 'launch': {
        const ab = this._base(a.base);
        if (!ab || !a.aircraft) break;
        const n = Math.max(1, a.n || 1);
        for (let i = 0; i < n; i++) {
          this._launched++;
          w.spawnReinforcement?.(ab, a.aircraft, `T${this._launched}`, a.tag ? [a.tag] : undefined,
            this.owner, a.loadout);
        }
        break;
      }
      case 'reinforce': {
        const ab = this._base(a.base);
        // 共用の飛行場（友軍の 'home'）には他の持ち主の増援が載りうるので、持ち主まで揃える
        const r = ab && this.mission.reinforce.find((v) => v.airbase === ab && (v.owner ?? null) === this.owner);
        if (!r) break;
        if (a.on) { r.held = false; r.armed = true; } else r.held = true;
        break;
      }
      case 'notice':
        if (a.text) w.log?.(`【状況】${a.text}`);
        break;
      case 'ground': {
        // 地上の行動を切り替える（§103・A3）。`{ tag, mode, x, z, attackTag }`。
        // x/z は `hold` の持ち場・`retreat` の下がる先（省けば、hold はその場・retreat は出現した位置）。
        // `attackTag` は `advance` の相手を差し替える（省けばステージに書いたもの）
        if (!GROUND_MODES.includes(a.mode)) break;
        const pt = Number.isFinite(a.x) && Number.isFinite(a.z) ? { x: a.x, z: a.z } : null;
        for (const u of this._own(a.tag)) {
          if (!u.alive || u.kind === 'aircraft' || u.groundMode === undefined) continue;
          u.groundMode = a.mode;
          if (a.mode === 'hold') u.holdAt = pt || { x: u.pos.x, z: u.pos.z };
          if (a.mode === 'retreat') u.retreatTo = pt || u.retreatTo;
          if (a.mode === 'advance' && a.attackTag) u.attackTag = a.attackTag;
        }
        break;
      }
      case 'spawn': {
        // 地上部隊をその場に出す（§107・揚陸）。`{ units: [{ type, name, x, z, tags, attackTag, known }] }`。
        // 書き方はステージの `ground` と同じ。出たものはこの司令官の手持ちになる
        for (const g of a.units || []) {
          if (!Number.isFinite(g.x) || !Number.isFinite(g.z)) continue;
          w.spawnGround?.({ ...g }, this.side, this.owner);
        }
        break;
      }
      default: break;
    }
  }

  /** 飛行場を名前で引く。敵は `base`/`base2`、友軍は `base`（友軍飛行場）/`home`（共用のプレイヤーの飛行場） */
  _base(key) {
    const bases = this.owner === OWNER.ALLY ? this.mission.allyBases : this.mission.enemyBases;
    const ab = bases && bases[key];
    return ab && ab.alive ? ab : null;
  }

  _aircraft(tag) {
    return this._own(tag).filter((u) => u.alive && u.kind === 'aircraft');
  }

  /**
   * 持ち場を与えて陣取らせる。**その時点で生きている機体だけ**（写し取り）。
   *
   * `guardHome` を立てるのが要 —— 立てないと、弾切れで帰って積み直したあと
   * `PATROL` で上がり、司令官の指揮下へ戻って持ち場を離れる（`airbase.js` の `launch`）。
   * 帰投中の機体はその帰投を続け、上がり直してから新しい持ち場へ行く。
   */
  _station(tag, area) {
    for (const u of this._aircraft(tag)) {
      this._remember(u);
      u.patrolArea = { ...area };
      u.guardHome = true;
      if (u.aiMode === 'RTB') continue;
      u.aiMode = 'GUARD';
      if (!u.onGround) u.setOrder({ type: 'orbit', x: area.x, z: area.z, alt: area.alt, radius: area.radius });
    }
  }

  /** トリガーが最初に触る前の状態を覚える。2度目以降は上書きしない */
  _remember(u) {
    if (u._trigSaved) return;
    u._trigSaved = {
      aiMode: u.aiMode,
      patrolArea: u.patrolArea ? { ...u.patrolArea } : null,
      guardHome: !!u.guardHome,
    };
  }

  _restore(u) {
    const s = u._trigSaved;
    if (!s) return;
    u._trigSaved = null;
    u.guardHome = s.guardHome;
    if (s.patrolArea) u.patrolArea = s.patrolArea;
    if (u.aiMode === 'RTB') return;              // 帰投は続ける。上がり直すときに元のモードになる
    let mode = s.aiMode;
    if (mode === 'RTB') mode = s.guardHome ? 'GUARD' : 'PATROL';
    else if (COMMANDER_MODES.has(mode)) mode = 'COORDINATE';
    u.aiMode = mode;
    const p = u.patrolArea;
    if (p && !u.onGround && (mode === 'GUARD' || mode === 'PATROL')) {
      u.setOrder({ type: 'orbit', x: p.x, z: p.z, alt: p.alt, radius: p.radius });
    }
  }
}

/** 以前の名前（§101）。敵側は `new SideTriggers(world, list, mission)` と同じ */
export const EnemyTriggers = SideTriggers;
