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
// 手順にはこの2つのほかに、案内のための任意指定がある:
//
//   pause: true            その手順に入ったら時間を止める
//   highlight: '<選択子>'  押してほしい／見てほしい場所を光らせる
//
// **画面を操作してほしい手順では時間を止める。** 飛びながらパネルを探させると、
// 探しているあいだに状況が変わってしまう。止まっていても選択・指示・視点は
// 動かせるので（§8）、手順を進めるのに困らない。
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

    /** 手順が指す場所を囲む枠。HUD は毎フレーム作り直されるので、位置も毎回引き直す */
    this._hi = document.createElement('div');
    this._hi.className = 'tut-hi hidden';
    document.body.appendChild(this._hi);
    /** この手順でもう時間を止めたか（止めたあとプレイヤーが動かしたら邪魔しない） */
    this._pausedFor = -1;
    /** 時間を動かすために覚えておく loop（update のたびに入れ替える） */
    this._loop = null;

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
    this._loop = ctx.loop || this._loop;
    this._elapsed += realDt;
    if (this._flash > 0) {
      this._flash -= realDt;
      if (this._flash <= 0) {
        this._pending = null;
        if (this.index >= this.steps.length) this._finish();
        else this._render(true);
      }
      this._updateHighlight();
      return;
    }
    const s = this.current;
    if (!s) { this._updateHighlight(); return; }

    // 画面を操作してほしい手順に入ったら時間を止める。
    // 止めるのは**入った瞬間の一度だけ**。毎フレーム止めると、
    // プレイヤーが自分で再開しても即座に止め返されて操作を奪うことになる。
    if (s.pause && this._pausedFor !== this.index) {
      this._pausedFor = this.index;
      ctx.loop?.setPaused(true);
    }

    this._updateHighlight();

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
    this._hi?.remove();
    this._hi = null;
    if (this.root) {
      this.root.removeEventListener('click', this._onClick);
      this.root.classList.add('hidden');
      this.root.innerHTML = '';
    }
    this.root = null;
  }

  // -------------------------------------------------------------- 内部

  _advance() {
    const done = this.steps[this.index];
    this._pending = done;
    this.index++;
    this._mem = {};             // 覚え書きは手順ごとに捨てる
    this._flash = DONE_FLASH;

    // 止めた手順を終えたら**こちらで動かし直す**。
    // パネルを触らせるために止めたのだから、済んだら戻すのが対。
    // 戻さないと、次の「右クリックで撃つ」で何も起きず、
    // 止まっていることに気づけないまま行き詰まる。
    if (done && done.pause && this._loop && this._loop.paused) {
      this._loop.setPaused(false);
    }
    this._render(true);
  }

  _finish() {
    this.finished = true;
    this._render(true);
    if (this.onFinish) this.onFinish();
  }

  /**
   * 手順が指す場所へ枠を重ねる。
   *
   * クラスを付けるのではなく**上に枠を置く**。SELECTED パネルは毎フレーム
   * innerHTML から作り直されるので、付けたクラスはすぐ消えてしまう。
   */
  _updateHighlight() {
    const hi = this._hi;
    if (!hi) return;
    const s = this._pending ? null : this.current;
    const sel = s && s.highlight;
    if (!sel) { hi.classList.add('hidden'); return; }
    const el = document.querySelector(sel);
    if (!el) { hi.classList.add('hidden'); return; }
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) { hi.classList.add('hidden'); return; }
    hi.style.left = `${r.left - 4}px`;
    hi.style.top = `${r.top - 4}px`;
    hi.style.width = `${r.width + 8}px`;
    hi.style.height = `${r.height + 8}px`;
    hi.classList.remove('hidden');
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
