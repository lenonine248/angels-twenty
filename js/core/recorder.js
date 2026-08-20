// 戦闘の記録。仕様書 §23。
//
// **姿勢は間隔サンプリング、出来事はイベント。** 2つに分ける。
//
// 姿勢を毎フレーム持つと量が跳ねるうえ、後から見たいのは「どこを飛んでいたか」で
// あって 1/30 秒の揺れではない。逆に発射・命中・撃墜は一瞬の出来事なので、
// 間引くと消えてしまう。
//
// 記録するのは**実際の動き**と**そのとき見えていたもの**の両方（§23.2）。
// 前者だけだと霧の中でどう判断していたかが追えず、後者だけだと
// 「あの敵はどこから来たのか」が最後まで分からない。振り返り側で切り替える。
//
// ミサイルはサンプリングしない。寿命が短く速度が 420〜1,100 m/s あるので、
// 0.5秒間隔では 210〜550m 飛ぶ。発射と着弾の2点があれば間を補間して描けるし、
// 見たいのは軌跡であって加速度ではない。
//
// **入力リプレイ（シード＋指示）にはしない。** シミュレーションは決定論的だと
// 確認したが（§23.1）、sim/ を1行変えるだけで過去の記録が再生できなくなる。
// 定数を測って動かし続けている最中のこの企画には合わない。

import { VERSION } from './version.js';

/** サンプリング間隔(秒) */
export const SAMPLE_DT = 0.5;

/** 記録の形式版。読み込み側が古い記録を弾くために使う */
export const FORMAT = 1;

export class Recorder {
  constructor(stage, world, seed) {
    this.stage = stage;
    this.world = world;
    /** その戦闘の乱数の種（§24）。同じ状況をやり直すために残す */
    this.seed = seed ?? null;
    this.enabled = true;

    /** 静的な名簿。サンプル側は id だけ持てば済む */
    this.units = [];
    this._known = new Set();

    this.samples = [];
    this.events = [];
    this._next = 0;             // 次にサンプルを取る時刻
    this.result = null;
    this.stats = null;
  }

  /** 名簿へ載せる（初出のときだけ） */
  _roster(u) {
    if (this._known.has(u.id)) return;
    this._known.add(u.id);
    this.units.push({
      id: u.id,
      name: u.name,
      side: u.side,
      kind: u.kind,
      type: u.typeId || (u.spec && u.spec.id) || '',
    });
  }

  /**
   * 毎ステップ呼ぶ。間隔に達したときだけ実際に記録する。
   * 呼ぶ側に間隔を意識させない。
   */
  tick(time) {
    if (!this.enabled || time < this._next) return;
    this._next = time + SAMPLE_DT;
    this.sample(time);
  }

  sample(time) {
    const w = this.world;
    // 数値を平らに並べる。{x:..,y:..} を並べるより JSON がずっと小さい。
    const u = [];
    for (const unit of w.units) {
      if (!unit.alive) continue;
      this._roster(unit);
      u.push(
        unit.id,
        Math.round(unit.pos.x), Math.round(unit.pos.y), Math.round(unit.pos.z),
        Math.round((unit.heading * 180) / Math.PI),
        Math.round(unit.hp),
      );
    }

    // そのとき自軍に見えていたもの。座標は**表示上の位置**を使う。
    // 逆探知は ±1km ずれた位置しか分からないので、真の座標を入れると
    // 「見えていたもの」にならない。
    const c = [];
    const det = w.detection;
    if (det) {
      for (const [, ct] of det.contactsFor(w.playerSide)) {
        if (ct.unit && ct.unit.side === w.playerSide) continue;
        c.push(
          ct.unit ? ct.unit.id : 0,
          Math.round(ct.pos.x), Math.round(ct.pos.z),
          ct.level | 0,
          ct.detected ? 1 : 0,
        );
      }
    }

    this.samples.push({ t: Math.round(time * 10) / 10, u, c });
  }

  /**
   * 出来事。位置は起きた場所を丸めて持つ。
   * @param {string} type 'fire' | 'hit' | 'kill' | 'loss' | 'withdraw' | 'order'
   */
  event(type, time, o = {}) {
    if (!this.enabled) return;
    const e = { t: Math.round(time * 10) / 10, type };
    if (o.unit) { this._roster(o.unit); e.id = o.unit.id; e.side = o.unit.side; }
    if (o.target) { this._roster(o.target); e.tid = o.target.id; }
    if (o.pos) { e.x = Math.round(o.pos.x); e.y = Math.round(o.pos.y); e.z = Math.round(o.pos.z); }
    if (o.weapon) e.w = o.weapon;
    if (o.cause) e.cause = o.cause;
    if (o.label) e.label = o.label;
    this.events.push(e);
  }

  finish(result, stats) {
    this.result = result;
    this.stats = stats || null;
  }

  /** 受け渡し用の素のデータ */
  toJSON() {
    return {
      v: FORMAT,
      version: VERSION,
      seed: this.seed,
      stage: {
        id: this.stage.id,
        name: this.stage.name,
        title: this.stage.title,
        // 地形は「シード＋パラメータ」から同じ形が再現できる（§2）。
        // 画像を持たずに済むので、記録がそのぶん軽くなる。
        terrain: { ...this.stage.terrain },
      },
      dt: SAMPLE_DT,
      units: this.units,
      samples: this.samples,
      events: this.events,
      result: this.result,
      stats: this.stats,
    };
  }

  /** だいたいの大きさ(KB)。開発中の目安 */
  sizeKb() {
    return Math.round(JSON.stringify(this.toJSON()).length / 1024);
  }
}

// ---------------------------------------------------------------- 受け渡し

/** 記録をファイルへ落とす */
export function downloadRecording(rec, filename) {
  const data = rec instanceof Recorder ? rec.toJSON() : rec;
  const name = filename
    || `at-${data.stage.id}-${String(Math.round(data.stats?.sec || 0)).padStart(4, '0')}s.json`;
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 少し待ってから解放する。即座に revoke するとダウンロードが始まらない環境がある
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/**
 * 読み込む。壊れた・古い記録は理由を付けて弾く。
 * 黙って半端に開くと、振り返り画面が空で出て原因が分からなくなる。
 */
export function parseRecording(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error('記録として読めません（JSON ではありません）');
  }
  if (!data || data.v !== FORMAT) {
    throw new Error(`対応していない記録の形式です（この版は v${FORMAT}）`);
  }
  if (!Array.isArray(data.samples) || !Array.isArray(data.units)) {
    throw new Error('記録の中身が足りません');
  }
  return data;
}
