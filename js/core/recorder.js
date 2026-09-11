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

/**
 * 記録の形式版。読み込み側が古い記録を弾くために使う。
 *
 * | | |
 * |---|---|
 * | 1 | 最初の形 |
 * | **2** | **天候・到達目標・チャフ／フレアを足し、コンタクトを厚くした**（§23.9）|
 *
 * **足しただけなので v1 も開ける。** 変わったのはコンタクト1件の長さだけで、
 * そこは `v` を見て読み分ける（`contactStride`）。
 * 古い記録は新しい要素が空のまま開く —— 弾くよりそのほうが役に立つ。
 */
export const FORMAT = 2;

/** コンタクト1件が何個の数値で書かれているか（形式版ごと）*/
export function contactStride(v) { return v >= 2 ? 9 : 5; }

/** コンタクトの旗（`flags`）*/
export const CFLAG = {
  DETECTED: 1,      // いま探知している
  APPROX: 2,        // 位置が粗い（逆探知など）
  JAMMED: 4,        // 掴んでいるが妨害されている
  UNCONFIRMED: 8,   // 攻撃したが生死を確認していない
  MEMORY: 16,       // 静止目標の記憶（探知は切れている）
};

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
    //
    // **v2 で厚くした**（§23.9）。3D再生でも戦闘と同じ印を出すには、
    // 2D地図が使う x/z だけでは足りない —— 高度線に y、
    // 誤差の円に `err`、点滅と枠に状態、ラベルに速度と方位が要る。
    const c = [];
    const det = w.detection;
    if (det) {
      for (const [, ct] of det.contactsFor(w.playerSide)) {
        if (ct.unit && ct.unit.side === w.playerSide) continue;
        let flags = 0;
        if (ct.detected) flags |= CFLAG.DETECTED;
        if (ct.approx) flags |= CFLAG.APPROX;
        if (ct.jammed) flags |= CFLAG.JAMMED;
        if (ct.unconfirmed) flags |= CFLAG.UNCONFIRMED;
        if (ct.state === 'memory') flags |= CFLAG.MEMORY;
        c.push(
          ct.unit ? ct.unit.id : 0,
          Math.round(ct.pos.x), Math.round(ct.pos.y), Math.round(ct.pos.z),
          Math.round(((ct.heading || 0) * 180) / Math.PI),
          Math.round(ct.speed || 0),
          ct.level | 0,
          Number.isFinite(ct.err) ? Math.round(ct.err) : -1,
          flags,
        );
      }
    }

    this.samples.push({ t: Math.round(time * 10) / 10, u, c });
  }

  /**
   * 出来事。位置は起きた場所を丸めて持つ。
   * @param {string} type 'fire' | 'hit' | 'kill' | 'loss' | 'withdraw' | 'order' | 'decoy'
   */
  event(type, time, o = {}) {
    if (!this.enabled) return;
    const e = { t: Math.round(time * 10) / 10, type };
    if (o.unit) { this._roster(o.unit); e.id = o.unit.id; e.side = o.unit.side; }
    if (o.target) { this._roster(o.target); e.tid = o.target.id; }
    if (o.pos) { e.x = Math.round(o.pos.x); e.y = Math.round(o.pos.y); e.z = Math.round(o.pos.z); }
    if (o.weapon) e.w = o.weapon;
    if (o.cause) e.cause = o.cause;
    if (o.kind) e.k = o.kind;            // チャフ／フレアの別（§23.9）
    if (o.label) e.label = o.label;
    this.events.push(e);
  }

  /**
   * 結末を書き留める。
   *
   * **書き方が2通りあった。** ゲーム本体は `'clear'` / `'fail'` の文字列、
   * `tools/bench.js` は `{ state, reason, sec }` の入れ物を渡していた。
   * 読む側（振り返り画面）は文字列しか見ていなかったので、
   * **ベンチで録った記録はクリアでも MISSION FAILED と出ていた。**
   *
   * **形を決めるのはここ1か所にする。** 受け取りは両方許して、
   * 残すのは `{ state, reason }` に均す。読むときは `resultOf()` を通す。
   */
  finish(result, stats) {
    const o = result && typeof result === 'object' ? result : { state: result };
    this.result = { state: o.state === 'clear' ? 'clear' : 'fail', reason: o.reason || '' };
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
        // 雲も同じ —— 種と `weather` があれば同じ形が出る（§88）。
        // **これが無いと、リプレイだけ雲の無い空になる** ——
        // 6面で雲が探知と射撃を変えているので、
        // 見ている側には「なぜ撃たないのか」が分からなくなる
        weather: this.stage.weather ? { ...this.stage.weather } : null,
        // 到達目標（§23.9）。**護衛の行き先が画面に無いと、
        // 編隊がどこへ向かっているのかが読めない。** 描くのに要る値だけ持つ
        objectives: (this.stage.objectives || [])
          .filter((o) => o.type === 'reach')
          .map((o) => ({ id: o.id, type: o.type, x: o.x, z: o.z, radius: o.radius || 3000 })),
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

/**
 * 記録の結末を読む（§23.6）。**古い記録も開ける。**
 *
 * 残っているファイルには3通りの書き方が混ざっている ——
 * 文字列 / `{state, reason, sec}` / いまの `{state, reason}`。
 * **読む側がそれぞれ判定を書くと、また片方を見落とす**ので、ここを通す。
 */
export function resultOf(data) {
  const r = data && data.result;
  const o = r && typeof r === 'object' ? r : { state: r };
  return { clear: o.state === 'clear', reason: o.reason || '' };
}

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
 * ファイルを選ばせて記録を読む。
 * 振り返り画面からもタイトルからも呼ぶので、口はここ1つにしておく。
 *
 * @returns {Promise<object|null>} 選ばなければ null。読めなければ throw
 */
export function pickRecordingFile() {
  return new Promise((resolve, reject) => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = '.json,application/json';
    inp.addEventListener('change', async () => {
      const f = inp.files && inp.files[0];
      if (!f) { resolve(null); return; }
      try { resolve(parseRecording(await f.text())); } catch (e) { reject(e); }
    });
    // 選ばずに閉じた場合。ブラウザによっては change が来ないので保険を置く
    inp.addEventListener('cancel', () => resolve(null));
    inp.click();
  });
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
  // **古い記録は弾かない。** 形式版は足し算で上がってきたので、
  // v1 は新しい要素が空のまま開ける（§23.9）。
  // 弾くのは**この版より新しい**記録だけ —— こちらが知らない形が入っている
  if (!data || !(data.v >= 1) || data.v > FORMAT) {
    throw new Error(`対応していない記録の形式です（この版は v${FORMAT} まで）`);
  }
  if (!Array.isArray(data.samples) || !Array.isArray(data.units)) {
    throw new Error('記録の中身が足りません');
  }
  return data;
}
