// 作戦書（検証用AIの強化 案A・PROPOSAL_playlog §4）。
//
// **面を分かっているプレイヤーの指示を、段と条件で書いたもの。**
// 素の司令官AI（`ai/commander.js`）は2秒ごとに1機ずつ「護衛 → 対地 → 積み直し → 哨戒」で
// 割り当てるだけで、面全体の見通しを持たない。作戦書はその上に乗り、
// 「誰をどの艦へ」「戦闘機はどこで待つか」をプレイヤーと同じ口（`setPlayerOrder`・モード・哨戒エリア）で出す。
// **飛び方と、どの敵機を撃つかは今の pilot/acm のまま。** 作戦書が決めるのは指示だけ。
//
// 素のAI（初見のプレイヤー）と作戦書付き（分かっているプレイヤー）を同じ種で並べ、
// その差を「その面がどれだけ理解を求めるか」として読む。
//
// 段の書き方はトリガー（`sim/triggers.js`・§12.3）をそのまま借りる ——
// `{ id, when: [条件], match?, delay?, do: [行動] }`。条件も同じもの（time・destroyed・reach・fired ほか）。
// **条件はどちらの陣営のタグも読む**（友軍側と同じ）。撃沈はプレイヤーにもログで分かる。
//
// 行動はプレイヤーの指示だけ:
//
// | 行動 | 中身 | 画面での操作 |
// |---|---|---|
// | `strike {units, tag}` | そのタグの敵（地図に載っているもの）のうち近いものへ攻撃指示。対地兵装が尽きたら手放す | 機体を選んで目標を右クリック |
// | `patrol {units, x, z, alt?, r?}` | 哨戒モードで、その地点を哨戒エリアにする | 哨戒ボタン＋地点 |
// | `escort {units, ward}` | 護衛モードで、その味方機を護る | 護衛ボタン＋味方機を右クリック |
// | `release {units}` | 手放す（司令官AIに戻す） | —— |
//
// `units` は機体の名前の配列（`'ANVIL 1'`）。**作戦書が掴んでいる機体は司令官AIが触らない**
// （`Commander` の `skip`）。手放した機体は次の考える番から司令官AIが割り当て直す。
//
// 乱数は使わない。種を固定したベンチはそのまま使える。

import { SideTriggers } from '../sim/triggers.js';
import { OWNER } from '../sim/unit.js';

/** 掴んでいる機体を見直す間隔(秒)。司令官AIより短く、パイロットと同じ程度 */
const THINK_INTERVAL = 1;

/** 対地兵装（`commander.js` の `AG_WEAPONS` と同じ） */
const AG_WEAPONS = ['AGM', 'ARM', 'BOMB'];

export const PLAY_ACTIONS = ['strike', 'patrol', 'escort', 'release'];

export class Playbook extends SideTriggers {
  /**
   * @param {object} world
   * @param {object[]} list  段の一覧（`data/playbooks.js`）
   * @param {object} mission
   */
  constructor(world, list, mission) {
    super(world, list, mission, { side: world.playerSide, owner: 'player' });
    /** 掴んでいる機体 → 任務 `{ type, ... }` */
    this.tasks = new Map();
    /** 任務の移り変わり `{ t, unit, what }`。測定の道具が読む */
    this.events = [];
    this._clock = 0;
    this._next = 0;
  }

  /** 司令官AIに触らせないか（`Commander` の `skip`） */
  holds(u) { return this.tasks.has(u); }

  /** 毎ステップ呼ぶ。段の判定と、掴んでいる機体の見直しは `THINK_INTERVAL` ごと */
  tick(dt) {
    this._clock += dt;
    if (this._clock < this._next) return;
    this._next = this._clock + THINK_INTERVAL;
    this.update(this.mission.time);
    for (const [u, task] of this.tasks) this._apply(u, task);
  }

  // -------------------------------------------------------------- 条件・手持ち

  /** 条件は**どちらの陣営のタグも**読む（友軍側と同じ） */
  _tagged(tag) {
    return this.world.units.filter((u) => u.tags && u.tags.includes(tag));
  }

  /** 手持ち＝プレイヤーの陣営の、友軍でない機体 */
  _mine(u) {
    return u.side === this.side && u.owner !== OWNER.ALLY;
  }

  _units(names) {
    const set = new Set(names || []);
    return this.world.units.filter((u) => u.alive && u.kind === 'aircraft' && this._mine(u) && set.has(u.name));
  }

  // -------------------------------------------------------------- 行動

  _act(a) {
    if (!PLAY_ACTIONS.includes(a.type)) { super._act(a); return; }
    for (const u of this._units(a.units)) {
      if (a.type === 'release') { this._release(u, 'release'); continue; }
      const task = { ...a, applied: false, target: null };
      this.tasks.set(u, task);
      this._note(u, `${a.type}${a.tag ? ' ' + a.tag : ''}${a.ward ? ' ' + a.ward : ''}`);
    }
  }

  /** 任務をいまの機体に当てる。地上・離着陸中は待つ（上がってから当てる） */
  _apply(u, task) {
    if (!u.alive) { this.tasks.delete(u); return; }
    if (u.onGround || u.state === 'takeoff' || u.state === 'landing') return;
    switch (task.type) {
      case 'strike': this._strike(u, task); break;
      case 'patrol': this._patrol(u, task); break;
      case 'escort': this._escort(u, task); break;
      default: break;
    }
  }

  _strike(u, task) {
    // **撃ち尽くしたら手放す。** 人は積み直しに帰すが、その一言は司令官AIが持っている（§72.2）
    if (!u.loadout.some((id) => AG_WEAPONS.includes(id))) { this._release(u, 'spent'); return; }
    let t = task.target;
    if (!t || !t.alive) {
      t = this._nearestKnown(u, task.tag);
      if (!t) { this._release(u, 'no-target'); return; }
      if (task.target) this._note(u, `retarget ${t.name}`);
      task.target = t;
    }
    u.aiMode = 'STRIKE';
    u.strikeTarget = t;
    u.escortTarget = null;
    if (!u.order || u.order.type !== 'attack' || u.order.target !== t || !u.order.player) {
      u.setPlayerOrder({ type: 'attack', target: t });
    }
  }

  _patrol(u, task) {
    if (task.applied) return;
    task.applied = true;
    const h = this.world.terrain ? Math.max(0, this.world.terrain.heightAt(task.x, task.z)) : 0;
    const alt = task.alt != null ? h + task.alt : u.desiredAlt;
    u.aiMode = 'PATROL';
    u.strikeTarget = null;
    u.escortTarget = null;
    u.patrolArea = { x: task.x, z: task.z, alt, radius: task.r || 4500 };
    u.setOrder({ type: 'orbit', x: task.x, z: task.z, alt, radius: task.r || 4500 });
  }

  _escort(u, task) {
    const w = this._units([task.ward])[0];
    if (!w) { this._release(u, 'ward-lost'); return; }
    u.aiMode = 'ESCORT';
    u.escortTarget = w;
    u.strikeTarget = null;
  }

  /** 地図に載っている（記憶を含む）そのタグの敵のうち、いちばん近いもの */
  _nearestKnown(u, tag) {
    const map = this.world.detection?.contactsFor(this.side);
    let best = null;
    let bestD = Infinity;
    for (const t of this._tagged(tag)) {
      if (!t.alive || t.side === this.side) continue;
      if (map && !map.has(t.id)) continue;
      const d = Math.hypot(t.pos.x - u.pos.x, t.pos.z - u.pos.z);
      if (d < bestD) { bestD = d; best = t; }
    }
    return best;
  }

  /** 手放す。プレイヤーの指示の印を外さないと、司令官AIが触らない（`order.player`） */
  _release(u, why) {
    if (!this.tasks.has(u)) return;
    this.tasks.delete(u);
    if (u.order && u.order.player && u.order.type !== 'rtb') u.clearOrders();
    if (u.aiMode !== 'RTB') u.aiMode = 'COORDINATE';
    u.strikeTarget = null;
    this._note(u, `release (${why})`);
  }

  _note(u, what) {
    this.events.push({ t: +this.mission.time.toFixed(1), unit: u.name, what });
  }
}
