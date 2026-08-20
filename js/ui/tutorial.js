// チュートリアルの進行。仕様書 §19。
//
// 手順を1つずつ出し、達成したら次へ進む。全部終えたらクリア。
// 評価は付けず、失敗条件も置かない（§19.1）。
//
// 手順の達成判定は2通り:
//
//   done:  'select' など   プレイヤーの操作を ui/actions.js 経由で受け取る
//   check: (ctx) => bool   毎フレーム状態を見る（高度・速度・探知・撃破など）
//
// **状態で分かることは check を使う。** 通知点を増やすほど本編の
// コードにチュートリアル都合の行が増えていく。ここを我慢すると、
// sim/ には一行も手を入れずに済む。
//
// ctx = { world, commands, loop, rig, elapsed }

const DONE_FLASH = 1.1;         // 「達成」表示を出しておく秒数（実時間）

export class TutorialRunner {
  /**
   * @param {object} tutorial data/tutorials.js の1本
   * @param {object} o
   * @param {()=>void} o.onFinish 全手順を終えた
   * @param {()=>void} o.onRestart 最初からやり直す（戦闘ごと組み直す）
   */
  constructor(tutorial, o) {
    this.tutorial = tutorial;
    this.onFinish = o.onFinish;
    this.onRestart = o.onRestart;
    this.index = 0;
    this.finished = false;

    this._flash = 0;            // 達成表示の残り秒
    this._pending = null;       // 達成したがまだ表示中の手順
    this._elapsed = 0;
    this._renderKey = null;
    /** 手順ごとの覚え書き。次の手順へ進むと空になる（check が使う） */
    this._mem = {};

    this.root = document.getElementById('tutorial');
    this._onClick = (e) => {
      if (e.target.closest('[data-tut="restart"]') && this.onRestart) this.onRestart();
    };
    if (this.root) {
      this.root.classList.remove('hidden');
      this.root.addEventListener('click', this._onClick);
    }
    this._render(true);
  }

  get steps() { return this.tutorial.steps; }
  get current() { return this.finished ? null : this.steps[this.index]; }

  /**
   * ui/actions.js からの通知。
   *
   * 「達成」表示を出している最中でも受け付ける。ここで捨てると、
   * 手早く続けて操作したぶんが無かったことになる（実際に落ちていた）。
   * ただし直前に達成した手順と同じ操作だけは無視する
   * （1回の操作で2手順ぶん進んでしまうのを防ぐ）。
   */
  handleAction(kind, detail) {
    if (this._pending && this._pending.done === kind) return;
    const s = this.current;
    if (!s || s.done !== kind) return;
    // 手順が細かい条件を持つ場合（例: 特定のAIモード）
    if (s.when && !s.when(detail)) return;
    this._advance();
  }

  /** 毎フレーム（実時間）。ポーズ中も呼ぶ — 一時停止を覚える手順があるため。 */
  update(ctx, realDt) {
    this._elapsed += realDt;
    if (this._flash > 0) {
      this._flash -= realDt;
      if (this._flash <= 0) {
        this._pending = null;
        if (this.index >= this.steps.length) this._finish();
        else this._render(true);
      }
      return;
    }
    const s = this.current;
    if (!s) return;
    if (s.check) {
      let ok = false;
      try {
        ok = !!s.check({ ...ctx, mem: this._mem, elapsed: this._elapsed });
      } catch (e) {
        // 手順の判定で落ちてもチュートリアルは止めない（次のフレームで再挑戦）
        ok = false;
      }
      if (ok) { this._advance(); return; }
    }
    this._render(false);
  }

  destroy() {
    if (this.root) {
      this.root.removeEventListener('click', this._onClick);
      this.root.classList.add('hidden');
      this.root.innerHTML = '';
    }
    this.root = null;
  }

  // -------------------------------------------------------------- 内部

  _advance() {
    this._pending = this.steps[this.index];
    this.index++;
    this._mem = {};             // 覚え書きは手順ごとに捨てる
    this._flash = DONE_FLASH;
    this._render(true);
  }

  _finish() {
    this.finished = true;
    this._render(true);
    if (this.onFinish) this.onFinish();
  }

  _render(force) {
    if (!this.root) return;
    const n = this.steps.length;
    const done = this._pending;
    const s = done || this.current;

    // 表示が変わらないうちは作り直さない
    const key = `${this.index}|${done ? 1 : 0}|${this.finished ? 1 : 0}`;
    if (!force && key === this._renderKey) return;
    this._renderKey = key;

    if (this.finished) {
      this.root.innerHTML = `
        <div class="tut-box done">
          <div class="tut-head">TUTORIAL — ${this.tutorial.name}</div>
          <div class="tut-step">すべての手順を終えました</div>
        </div>`;
      return;
    }

    const no = done ? this.index : this.index + 1;
    this.root.innerHTML = `
      <div class="tut-box${done ? ' hit' : ''}">
        <div class="tut-head">
          TUTORIAL — ${this.tutorial.name}
          <span class="tut-count">手順 ${no} / ${n}</span>
          <button class="tut-restart" data-tut="restart" title="最初の手順からやり直す">やり直す</button>
        </div>
        <div class="tut-step">${done ? '✔ ' : ''}${s.text}</div>
        ${!done && s.note ? `<div class="tut-note">${s.note}</div>` : ''}
      </div>`;
  }
}
