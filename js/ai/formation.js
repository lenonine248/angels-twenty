// 編隊。仕様書 §9.3。
//
// 1〜4機で任意に編成・解除できる。編隊単位で指示を出すと僚機はリーダーに追従し、
// 連携モードではレーダーの扇を役割ごとに分担する（実際の分担は ai/pilot.js）。
//
// 編隊は「所属」を持つだけの薄い箱にしてある。飛行も交戦も個々の機体が行うので、
// 編隊が崩れても各機は自律して戦い続ける。

const MAX_MEMBERS = 4;
let nextId = 1;

export class Formation {
  constructor(members) {
    this.id = nextId++;
    this.name = `編隊${this.id}`;
    this.members = [];
    for (const m of members.slice(0, MAX_MEMBERS)) this.add(m);
  }

  get leader() {
    return this.members.find((m) => m.alive) || null;
  }

  get alive() {
    return this.members.some((m) => m.alive);
  }

  add(ac) {
    if (this.members.includes(ac) || this.members.length >= MAX_MEMBERS) return false;
    if (ac.formation) ac.formation.remove(ac);
    this.members.push(ac);
    ac.formation = this;
    this._reindex();
    return true;
  }

  remove(ac) {
    const i = this.members.indexOf(ac);
    if (i < 0) return;
    this.members.splice(i, 1);
    ac.formation = null;
    ac.formationSlot = 0;
    this._reindex();
  }

  _reindex() {
    this.members.forEach((m, i) => { m.formationSlot = i; });
  }

  /** 死んだ機体を落とす。空になったら false を返す。 */
  prune() {
    this.members = this.members.filter((m) => m.alive);
    this._reindex();
    return this.members.length > 0;
  }

  /**
   * 編隊全体に指示を出す。
   * リーダーが指示を受け、僚機はリーダーに追従する。
   * 攻撃指示だけは全機が同じ目標へ向かう（数で押すため）。
   */
  issue(order) {
    const leader = this.leader;
    if (!leader) return;
    leader.setOrder(order);
    for (const m of this.members) {
      if (m === leader || !m.alive) continue;
      if (order.type === 'attack') m.setOrder({ ...order });
      else m.setOrder({ type: 'follow', target: leader, slot: m.formationSlot });
    }
  }

  /** 編隊全体のAIモードを揃える */
  setMode(mode) {
    for (const m of this.members) m.aiMode = mode;
  }
}

/** world.formations の掃除。毎tick呼ぶ必要はない。 */
export function pruneFormations(world) {
  if (!world.formations) return;
  world.formations = world.formations.filter((f) => f.prune());
}
