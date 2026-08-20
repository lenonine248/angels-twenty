// 戦闘の振り返り画面。仕様書 §23.3。
//
// 記録（core/recorder.js）を地図の上に開く。ここは**記録を読むだけ**で、
// シミュレーションには一切触らない。だから終わった戦闘でも、
// 別のブラウザで作られた記録ファイルでも同じように開ける。
//
// 見せ方の軸は2つ。
//
//   実際の動き    … 敵が本当はどこを飛んでいたか。**次にどう構えるか**の材料
//   見えていたもの … そのとき自分が掴んでいた情報。**なぜそう判断したか**の再現
//
// この2つを切り替えられることが、このゲームの振り返りの肝になる。
// 片方だけだと「霧の中でどう判断していたか」か「敵がどこから来たのか」の
// どちらかが最後まで分からない。

import { Terrain, MAP_SIZE, CELLS } from '../world/terrain.js';
import { downloadRecording, parseRecording } from '../core/recorder.js';

/** 出来事の見た目 */
const EVENT_STYLE = {
  fire:     { color: '#e8c56a', r: 2.5, label: '発射' },
  hit:      { color: '#ff9d4d', r: 3,   label: '命中' },
  kill:     { color: '#7ec87e', r: 4.5, label: '撃墜' },
  loss:     { color: '#ff5f5f', r: 4.5, label: '喪失' },
  withdraw: { color: '#8a8f98', r: 3.5, label: '離脱' },
  order:    { color: '#6fd8e8', r: 2,   label: '指示' },
};

const SIDE_COLOR = { blue: '#5aa9ff', red: '#ff7676' };

export class ReviewScreen {
  constructor(root) {
    this.root = root;
    this.data = null;
    this.terrainCanvas = null;

    this.mode = 'truth';        // 'truth' | 'seen'
    this.tIndex = 0;            // 時間軸の位置（サンプル番号）
    this.showEvents = new Set(['kill', 'loss', 'hit', 'fire', 'withdraw', 'order']);
    this.focusId = null;        // ある機体だけを追う

    this._onClick = (e) => this._click(e);
    this._onInput = (e) => this._input(e);
  }

  // -------------------------------------------------------------- 開閉

  open(data) {
    this.data = data;
    this.tIndex = data.samples.length - 1;      // 最初は全部見せる
    this.focusId = null;
    this._buildTerrain();
    this.root.classList.remove('hidden');
    this.root.addEventListener('click', this._onClick);
    this.root.addEventListener('input', this._onInput);
    this._render();
  }

  close() {
    this.root.classList.add('hidden');
    this.root.removeEventListener('click', this._onClick);
    this.root.removeEventListener('input', this._onInput);
    this.root.innerHTML = '';
    this.data = null;
    if (this.onClose) this.onClose();
  }

  get isOpen() { return !!this.data; }

  /**
   * 地形は「シード＋パラメータ」から作り直す（§2）。
   * 記録に画像を持たせずに済むので、ファイルがそのぶん軽い。
   */
  _buildTerrain() {
    const terrain = new Terrain(this.data.stage.terrain);
    const c = document.createElement('canvas');
    c.width = CELLS; c.height = CELLS;
    const ctx = c.getContext('2d');
    ctx.putImageData(terrain.buildMinimapImage(ctx), 0, 0);
    this.terrainCanvas = c;
  }

  // -------------------------------------------------------------- 操作

  _click(e) {
    const t = e.target.closest('[data-rv]');
    if (!t) return;
    const act = t.dataset.rv;
    if (act === 'close') { this.close(); return; }
    if (act === 'mode') { this.mode = t.dataset.mode; this._render(); return; }
    if (act === 'event') {
      const k = t.dataset.kind;
      if (this.showEvents.has(k)) this.showEvents.delete(k); else this.showEvents.add(k);
      this._render();
      return;
    }
    if (act === 'focus') {
      const id = Number(t.dataset.id);
      this.focusId = this.focusId === id ? null : id;
      this._render();
      return;
    }
    if (act === 'replay') { this.onReplay?.(this.data); return; }
    if (act === 'save') { downloadRecording(this.data); return; }
    if (act === 'load') { this._pickFile(); return; }
    if (act === 'end') { this.tIndex = this.data.samples.length - 1; this._render(); return; }
  }

  _input(e) {
    if (e.target.dataset.rv !== 'time') return;
    this.tIndex = Number(e.target.value);
    this._render();
  }

  _pickFile() {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = '.json,application/json';
    inp.addEventListener('change', async () => {
      const f = inp.files && inp.files[0];
      if (!f) return;
      try {
        const data = parseRecording(await f.text());
        this.open(data);
      } catch (err) {
        // 黙って開かない。読めない理由が分からないほうが困る
        const box = this.root.querySelector('.rv-msg');
        if (box) box.textContent = `読み込めません: ${err.message}`;
      }
    });
    inp.click();
  }

  // -------------------------------------------------------------- 描画

  _render() {
    const d = this.data;
    if (!d) return;
    const s = d.samples[this.tIndex] || d.samples[d.samples.length - 1];
    const last = d.samples.length - 1;

    const modeBtn = (id, label, title) =>
      `<button data-rv="mode" data-mode="${id}" class="${this.mode === id ? 'on' : ''}"
        title="${title}">${label}</button>`;

    const evBtn = (k) => {
      const st = EVENT_STYLE[k];
      return `<button data-rv="event" data-kind="${k}"
        class="rv-ev ${this.showEvents.has(k) ? 'on' : ''}"
        style="--c:${st.color}">${st.label}</button>`;
    };

    const roster = d.units.filter((u) => u.kind === 'aircraft')
      .map((u) => `<button data-rv="focus" data-id="${u.id}"
        class="rv-unit ${this.focusId === u.id ? 'on' : ''} side-${u.side}">${u.name}</button>`).join('');

    const st = d.stats || {};
    this.root.innerHTML = `
      <div class="rv-wrap">
        <div class="rv-head">
          <span class="rv-title">REVIEW — ${d.stage.name}<small>${d.stage.title || ''}</small></span>
          <span class="rv-res ${d.result === 'clear' ? 'clear' : 'fail'}">
            ${d.result === 'clear' ? 'MISSION COMPLETE' : 'MISSION FAILED'}</span>
          <span class="rv-meta">撃墜 ${st.kills ?? '-'} / 喪失 ${st.losses ?? '-'} / ${fmt(st.sec ?? 0)}</span>
          <button data-rv="close" class="rv-close">閉じる</button>
        </div>

        <div class="rv-body">
          <canvas class="rv-map" width="720" height="720"></canvas>
          <div class="rv-side">
            <div class="rv-group">
              <label>見せ方</label>
              ${modeBtn('truth', '実際の動き', '敵が本当はどこを飛んでいたか')}
              ${modeBtn('seen', '見えていたもの', 'そのとき自分が掴んでいた情報だけ')}
            </div>
            <div class="rv-group">
              <label>出来事</label>
              <div class="rv-evs">${Object.keys(EVENT_STYLE).map(evBtn).join('')}</div>
            </div>
            <div class="rv-group">
              <label>機体で絞る</label>
              <div class="rv-units">${roster || '<span class="dim">なし</span>'}</div>
            </div>
            <div class="rv-group">
              <label>再生</label>
              <button data-rv="replay" class="rv-play">3Dで再生する</button>
            </div>
            <div class="rv-group rv-msg-wrap">
              <button data-rv="save" class="rv-file">記録を保存</button>
              <button data-rv="load" class="rv-file">記録を読み込む</button>
              <div class="rv-msg dim"></div>
            </div>
          </div>
        </div>

        <div class="rv-foot">
          <span class="rv-clock">${fmt(s.t)}</span>
          <input type="range" data-rv="time" min="0" max="${last}" value="${this.tIndex}">
          <button data-rv="end" class="rv-file">最後まで</button>
        </div>
      </div>`;

    this._drawMap();
  }

  _drawMap() {
    const cv = this.root.querySelector('.rv-map');
    if (!cv) return;
    const ctx = cv.getContext('2d');
    const W = cv.width, H = cv.height;
    const px = (x) => (x / MAP_SIZE) * W;
    const pz = (z) => (z / MAP_SIZE) * H;

    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.terrainCanvas, 0, 0, W, H);
    // 地形をやや沈めて、線を読みやすくする
    ctx.fillStyle = 'rgba(6, 10, 16, 0.45)';
    ctx.fillRect(0, 0, W, H);

    const d = this.data;
    const upTo = this.tIndex;
    const byId = new Map(d.units.map((u) => [u.id, u]));

    // --- 軌跡
    const tracks = new Map();     // id -> [[x,z], ...]
    for (let i = 0; i <= upTo; i++) {
      const s = d.samples[i];
      if (this.mode === 'truth') {
        for (let k = 0; k < s.u.length; k += 6) {
          const id = s.u[k];
          const u = byId.get(id);
          if (!u || u.kind !== 'aircraft') continue;
          push(tracks, id, s.u[k + 1], s.u[k + 3]);
        }
      } else {
        // 見えていたもの: 自軍は真の位置（自分の機体は分かっている）、
        // 敵はコンタクトの表示位置。逆探知は ±1km ずれた位置しか分からない。
        for (let k = 0; k < s.u.length; k += 6) {
          const id = s.u[k];
          const u = byId.get(id);
          if (!u || u.side !== 'blue' || u.kind !== 'aircraft') continue;
          push(tracks, id, s.u[k + 1], s.u[k + 3]);
        }
        for (let k = 0; k < s.c.length; k += 5) {
          push(tracks, s.c[k], s.c[k + 1], s.c[k + 2]);
        }
      }
    }

    // 置いた名札の枠。近い機体どうしで文字が重なるのを避ける
    const labels = [];
    for (const [id, pts] of tracks) {
      if (this.focusId && id !== this.focusId) continue;
      const u = byId.get(id);
      const side = u ? u.side : 'red';
      ctx.strokeStyle = SIDE_COLOR[side] || '#ff7676';
      ctx.globalAlpha = this.focusId ? 0.95 : 0.65;
      ctx.lineWidth = this.focusId === id ? 2.4 : 1.4;
      ctx.beginPath();
      for (let i = 0; i < pts.length; i++) {
        const [x, z] = pts[i];
        if (i === 0) ctx.moveTo(px(x), pz(z)); else ctx.lineTo(px(x), pz(z));
      }
      ctx.stroke();

      // 現在位置に印
      const [lx, lz] = pts[pts.length - 1];
      ctx.globalAlpha = 1;
      ctx.fillStyle = SIDE_COLOR[side] || '#ff7676';
      ctx.beginPath();
      ctx.arc(px(lx), pz(lz), 3.2, 0, Math.PI * 2);
      ctx.fill();
      if (u && (this.focusId === id || u.side === 'blue')) {
        ctx.font = '10px monospace';
        const w = ctx.measureText(u.name).width;
        const bx = px(lx) + 6, by = pz(lz) - 13;
        // 重なる名札は出さない。重ねて描くと読めない字が増えるだけで、
        // どちらの機体のものかも分からなくなる
        const clash = labels.some((r) => bx < r.x + r.w && bx + w > r.x
          && by < r.y + r.h && by + 11 > r.y);
        if (!clash) {
          labels.push({ x: bx, y: by, w, h: 11 });
          ctx.fillStyle = 'rgba(226,232,240,0.85)';
          ctx.fillText(u.name, bx, pz(lz) - 5);
        }
      }
    }
    ctx.globalAlpha = 1;

    // --- 地上目標
    //
    // 動かないので軌跡は要らないが、**印は要る**。飛行場・レーダー・艦船が
    // どこにあったのかが無いと、対地の任務は振り返りようがない。
    // 「見えていたもの」では、掴めていたものだけを出す。
    const sNow = d.samples[upTo];
    const groundSeen = new Set();
    if (sNow) {
      for (let k = 0; k < sNow.c.length; k += 5) groundSeen.add(sNow.c[k]);
    }
    const aliveNow = new Set();
    if (sNow) for (let k = 0; k < sNow.u.length; k += 6) aliveNow.add(sNow.u[k]);

    // 位置は「最後に記録されていたところ」。静止目標なので開始時のもので足りる。
    const groundPos = new Map();
    for (let i = 0; i <= upTo; i++) {
      const smp = d.samples[i];
      for (let k = 0; k < smp.u.length; k += 6) {
        const u = byId.get(smp.u[k]);
        if (u && u.kind !== 'aircraft') groundPos.set(smp.u[k], [smp.u[k + 1], smp.u[k + 3]]);
      }
    }
    for (const [id, [gx, gz]] of groundPos) {
      const u = byId.get(id);
      if (!u) continue;
      if (this.mode === 'seen' && u.side !== 'blue' && !groundSeen.has(id)) continue;
      const x = px(gx), y = pz(gz);
      const dead = !aliveNow.has(id);
      ctx.strokeStyle = dead ? '#8a8f98' : (SIDE_COLOR[u.side] || '#ff7676');
      ctx.lineWidth = 1.6;
      ctx.globalAlpha = dead ? 0.5 : 1;
      ctx.strokeRect(x - 4, y - 4, 8, 8);
      ctx.globalAlpha = 1;
    }

    // --- 出来事
    const tNow = d.samples[upTo] ? d.samples[upTo].t : Infinity;
    for (const e of d.events) {
      if (e.t > tNow) continue;
      if (!this.showEvents.has(e.type)) continue;
      if (this.focusId && e.id !== this.focusId && e.tid !== this.focusId) continue;
      if (e.x == null) continue;
      const st = EVENT_STYLE[e.type];
      ctx.strokeStyle = st.color;
      ctx.fillStyle = st.color;
      ctx.lineWidth = 1.4;
      const x = px(e.x), y = pz(e.z);
      if (e.type === 'kill' || e.type === 'loss') {
        // 撃墜と喪失は×。ひと目で他と区別が付く
        ctx.beginPath();
        ctx.moveTo(x - st.r, y - st.r); ctx.lineTo(x + st.r, y + st.r);
        ctx.moveTo(x + st.r, y - st.r); ctx.lineTo(x - st.r, y + st.r);
        ctx.stroke();
      } else {
        ctx.globalAlpha = 0.85;
        ctx.beginPath();
        ctx.arc(x, y, st.r, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
    }
  }
}

function push(map, id, x, z) {
  let a = map.get(id);
  if (!a) { a = []; map.set(id, a); }
  // 同じ場所が続くときは間引く（静止した地上目標で点が積み上がるのを防ぐ）
  const last = a[a.length - 1];
  if (last && Math.abs(last[0] - x) < 5 && Math.abs(last[1] - z) < 5) return;
  a.push([x, z]);
}

function fmt(sec) {
  const s = Math.max(0, Math.round(sec));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
