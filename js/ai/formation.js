// 編隊。仕様書 §9.3。
//
// 1〜4機で任意に編成・解除できる。編隊単位で指示を出すと僚機はリーダーに追従し、
// 連携モードではレーダーの扇を役割ごとに分担する（実際の分担は ai/pilot.js）。
//
// 編隊は「所属」を持つだけの薄い箱にしてある。飛行も交戦も個々の機体が行うので、
// 編隊が崩れても各機は自律して戦い続ける。

const MAX_MEMBERS = 4;
/** 編隊に付けられる番号。数字キーでそのまま呼び出す。 */
export const MAX_FORMATION_NUMBER = 9;

/**
 * 隊形。仕様書 §22.4。
 *
 * プレイヤーが選ぶのは**隊形だけ**。誰がどこへ回り込むかは AI が決める。
 * 「密集か、開くか」は指揮官の判断だが、そこから先は操縦の話になる。
 */
export const SHAPE = {
  TIGHT:  { id: 'TIGHT',  label: '密集', back: 700,  lateral: 550,  desc: '互いを近くに置く。護衛や、まとめて動かしたいときに' },
  SPREAD: { id: 'SPREAD', label: '横隊', back: 250,  lateral: 1800, desc: '横に開く。探知の幅が広がり、挟み撃ちに移りやすい' },
};
let nextId = 1;

/** ID を振り直す（`sim/unit.js` の `resetUnitIds` と同じ理由） */
export function resetFormationIds() { nextId = 1; }

/**
 * 空いている最小の番号を返す。
 * 通し番号を振ると、解散を繰り返すうちに「編隊7」しか無い状態になり、
 * 数字キーとの対応が覚えられなくなる。空きを詰めて若い番号を使い回す。
 */
export function freeFormationNumber(formations) {
  const used = new Set((formations || []).map((f) => f.number));
  for (let n = 1; n <= MAX_FORMATION_NUMBER; n++) if (!used.has(n)) return n;
  return MAX_FORMATION_NUMBER;
}

export class Formation {
  constructor(members, number = 1) {
    this.id = nextId++;          // 内部の一意キー（表示には使わない）
    this.setNumber(number);
    /** 隊形。既定は横隊（連携で組むことが多いため） */
    this.shape = SHAPE.SPREAD.id;
    this.members = [];
    for (const m of members.slice(0, MAX_MEMBERS)) this.add(m);
  }

  /** 隊形を切り替える */
  setShape(id) {
    if (!SHAPE[id]) return this;
    this.shape = id;
    for (const m of this.members) m.formationShape = id;
    return this;
  }

  get shapeSpec() { return SHAPE[this.shape] || SHAPE.SPREAD; }

  /** 表示・数字キーで使う番号を付け替える */
  setNumber(n) {
    this.number = Math.min(MAX_FORMATION_NUMBER, Math.max(1, Math.round(n)));
    this.name = `編隊${this.number}`;
    return this;
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
    this.members.forEach((m, i) => {
      m.formationSlot = i;
      m.formationShape = this.shape;
    });
  }

  /** 死んだ機体を落とす。空になったら false を返す。 */
  prune() {
    this.members = this.members.filter((m) => m.alive);
    this._reindex();
    return this.members.length > 0;
  }

  /**
   * **編隊全体にプレイヤーの指示を出す。**
   * リーダーが指示を受け、僚機はリーダーに追従する。
   * 攻撃指示だけは全機が同じ目標へ向かう（数で押すため）。
   *
   * 呼び出し側に `player` を付けさせない — 付け忘れると僚機だけ
   * 「指示なし」扱いになって AI が即座に上書きし、
   * **編隊指示を出したのに崩れる**（Beta 2.22 で実際に踏んだ）。
   * `Aircraft.setPlayerOrder` の注記も参照。
   */
  issue(order) {
    const leader = this.leader;
    if (!leader) return;
    leader.setPlayerOrder(order);
    for (const m of this.members) {
      if (m === leader || !m.alive) continue;
      if (order.type === 'attack') { m.setPlayerOrder({ ...order }); continue; }
      m.setPlayerOrder({ type: 'follow', target: leader, slot: m.formationSlot });
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
