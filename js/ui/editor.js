// ステージエディタ。仕様書 §66。
//
// **作るための道具**（§47 の調整パネルは詰めるための道具）。
// 地形・配置・目標・評価・文章までを触って、その場で試遊できる。
//
// 自前の `#editor` を持つ。`#screens` を借りると `ScreenManager` の
// クリック処理と同じ要素を取り合うので、入れ物を分けてある。
//
// 座標はワールド(0〜51,200) ↔ 画布(0〜512) の比だけ。
// 地形の絵はブリーフィングの戦域図と同じ `terrain.buildMinimapImage()`。

import { Terrain, CELLS, MAP_SIZE } from '../world/terrain.js';
import { AI_MODES } from '../ai/pilot.js';
import { GROUND_TYPES } from '../data/ground.js';
import { loadoutCost } from '../data/weapons.js';
import * as custom from '../data/custom.js';
import { loadoutRow, removeOne, LOADOUT_HINT } from './loadout.js';

const SIZE = 512;                      // 画布の一辺(px)
const HIT = 11;                        // 掴める距離(px)
/** 自軍機ツールでここまで飛行場に寄せて押したら「自動配置」になる(m)（§71.5） */
const AUTO_PLACE_RANGE = 5000;

/** ツール。`place` が null のものは配置しない */
const TOOLS = [
  ['select', '選択', null],
  ['fbase', '自軍飛行場', 'fbase'],
  ['fair', '自軍機', 'fair'],
  ['eair', '敵機', 'eair'],
  ['eground', '敵地上', 'eground'],
  ['ebase', '敵飛行場', 'ebase'],
  ['reach', '到達地点', 'reach'],
];

const TABS = [
  ['terrain', '地形'],
  ['objectives', '目標'],
  ['rating', '評価'],
  ['text', '文章'],
  ['list', '一覧'],
];

const COAST = ['none', 'n', 'e', 's', 'w'];


/**
 * 地図の内側に収める。**非数を弾くのが本題。**
 * 画布が表示されていない（大きさ 0）ときに割り算が壊れて NaN が入り、
 * `x: null` のステージができてしまう。
 */
const clampPos = (v) => {
  if (!Number.isFinite(v)) return 0;
  return Math.round(Math.max(0, Math.min(MAP_SIZE, v)));
};

/**
 * 座標を持たない自軍機が、実際に出てくる場所（§71.5）。
 *
 * **本体（`main.js` の `spawnStage`）と同じ式**を使う。
 * 2か所に別々の式を置くと、エディタで見た配置と試遊した配置がずれる ——
 * 何を直しているのか分からなくなる類のずれなので、式は写す。
 *
 * | ステージ | 出る場所 |
 * |---|---|
 * | `startAirborne: true` | 飛行場の**空中**、機体ごとに 1.2km ずつ後ろへずらして並ぶ |
 * | `startAirborne: false` | 飛行場そのもの（地上待機）|
 *
 * 地上待機のほうは全機が同じ点に重なるので、**読めるように扇状にずらして描く**。
 * これは表示だけの都合で、本体には何も渡さない。
 *
 * 飛行場の位置は本体では `findFlatSpot()` で平らな場所へ寄せられるので、
 * ここで描く点とは 2km ほどずれることがある。**目安として読むこと。**
 */
function autoStartPos(base, i, startAirborne) {
  if (startAirborne) {
    return { x: base.x + 1500 + i * 1200, z: base.z - 1500 - i * 900 };
  }
  return { x: base.x + 1300 + (i % 2) * 1100, z: base.z + 1300 + Math.floor(i / 2) * 1100 };
}

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** `a.b.0` のような道でオブジェクトを読み書きする */
function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
}
function setPath(obj, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  let o = obj;
  for (const k of keys) { if (o[k] == null) o[k] = /^\d+$/.test(k) ? [] : {}; o = o[k]; }
  o[last] = value;
}

export class StageEditor {
  constructor(o = {}) {
    this.root = document.getElementById('editor');
    this.onPlaytest = o.onPlaytest;
    this.onExit = o.onExit;
    this.stage = null;
    this.tool = 'select';
    this.tab = 'terrain';
    this.sel = null;                   // { kind, i }
    this.msg = '';
    this._terrain = null;
    this._terrainKey = '';
    this._drag = null;

    this.root.addEventListener('click', (e) => this._onClick(e));
    this.root.addEventListener('input', (e) => this._onInput(e));
    this.root.addEventListener('change', (e) => this._onInput(e));
  }

  get isOpen() { return !this.root.classList.contains('hidden'); }

  open(stage) {
    this.stage = structuredClone(stage || custom.blankStage());
    this.sel = null;
    this.tool = 'select';
    this.msg = '';
    this.root.classList.remove('hidden');
    this._render();
  }

  close() {
    this.root.classList.add('hidden');
    this.root.innerHTML = '';
    this.stage = null;
  }

  // -------------------------------------------------------------- 描画

  _render() {
    const s = this.stage;
    if (!s) return;
    this.root.innerHTML = `
      <div class="ed-wrap">
        <div class="ed-top">
          <span class="ed-brand">STAGE EDITOR</span>
          <label>名前<input data-ed="name" value="${esc(s.name)}" size="16"></label>
          <label>副題<input data-ed="title" value="${esc(s.title)}" size="14"></label>
          <span class="ed-id">${esc(s.id)}</span>
          <span class="ed-spacer"></span>
          <button data-edcmd="playtest" class="go">試遊</button>
          <button data-edcmd="save">保存</button>
          <button data-edcmd="exit" class="ghost">戻る</button>
        </div>
        <div class="ed-body">
          <div class="ed-left">
            <canvas id="edMap" width="${SIZE}" height="${SIZE}"></canvas>
            <div class="ed-maphint">クリックで配置 / ドラッグで移動 / 右クリックで削除</div>
          </div>
          <div class="ed-right">
            <div class="ed-tools">${TOOLS.map(([id, label]) =>
              `<button data-edtool="${id}" class="${this.tool === id ? 'active' : ''}">${label}</button>`).join('')}</div>
            <div class="ed-props">${this._props()}</div>
          </div>
        </div>
        <div class="ed-tabs">${TABS.map(([id, label]) =>
          `<button data-edtab="${id}" class="${this.tab === id ? 'active' : ''}">${label}</button>`).join('')}</div>
        <div class="ed-tabbody">${this._tab()}</div>
        <div class="ed-msg">${this.msg}</div>
      </div>`;
    this._draw();
    this._wireCanvas();
  }

  /** 画布と下半分だけ描き直す（入力欄の途中で作り直すと打てなくなる） */
  _refresh(full = false) {
    if (full) { this._render(); return; }
    const props = this.root.querySelector('.ed-props');
    if (props) props.innerHTML = this._props();
    const msg = this.root.querySelector('.ed-msg');
    if (msg) msg.innerHTML = this.msg;
    this._draw();
  }

  // -------------------------------------------------------------- 地図

  _terrainFor() {
    const key = JSON.stringify(this.stage.terrain);
    if (key !== this._terrainKey) {
      this._terrainKey = key;
      this._terrain = new Terrain(this.stage.terrain);
    }
    return this._terrain;
  }

  _px(v) { return (v / MAP_SIZE) * SIZE; }
  _world(p) { return (p / SIZE) * MAP_SIZE; }

  _draw() {
    const canvas = this.root.querySelector('#edMap');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    // 地形は 256 で出るので、拡大して敷く
    const off = document.createElement('canvas');
    off.width = CELLS; off.height = CELLS;
    const octx = off.getContext('2d');
    octx.putImageData(this._terrainFor().buildMinimapImage(octx), 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, SIZE, SIZE);
    ctx.drawImage(off, 0, 0, SIZE, SIZE);

    const items = this._items();
    // **自動配置の機体は飛行場と線で結ぶ**（§71.5）。
    // 「そこに置いてある」のではなく「飛行場から決まる」と一目で分かるように。
    // 印より先に引いて、線が印の上に乗らないようにする。
    ctx.save();
    ctx.strokeStyle = 'rgba(143, 212, 255, 0.45)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    for (const it of items) {
      if (!it.tether) continue;
      ctx.beginPath();
      ctx.moveTo(this._px(it.tether.x), this._px(it.tether.z));
      ctx.lineTo(this._px(it.x), this._px(it.z));
      ctx.stroke();
    }
    ctx.restore();

    for (const it of items) {
      const x = this._px(it.x); const z = this._px(it.z);
      const on = this.sel && this.sel.kind === it.kind && this.sel.i === it.i;
      // 自動配置は塗りを抜いて輪郭だけにする。掴んで動かせないことの合図でもある
      ctx.fillStyle = it.auto ? 'rgba(8, 16, 18, 0.75)' : it.color;
      ctx.strokeStyle = on ? '#ffffff' : (it.auto ? it.color : 'rgba(0,0,0,0.6)');
      ctx.lineWidth = on ? 2 : (it.auto ? 1.5 : 1);
      const r = it.big ? 7 : 5;
      ctx.beginPath();
      if (it.round) ctx.arc(x, z, r, 0, Math.PI * 2);
      else ctx.rect(x - r, z - r, r * 2, r * 2);
      ctx.fill(); ctx.stroke();
      if (it.radius) {
        ctx.strokeStyle = it.color;
        ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(x, z, this._px(it.radius), 0, Math.PI * 2); ctx.stroke();
      }
      if (on) {
        ctx.fillStyle = '#fff';
        ctx.font = '11px monospace';
        ctx.fillText(it.label || '', x + 10, z - 8);
      }
    }
  }

  /**
   * 地図に出すもの。**編集の実体への参照を持たせる。**
   * 掴んで動かすときにここから直接 x/z を書き換える。
   */
  _items() {
    const s = this.stage;
    const out = [];
    const f = s.friendly || {};
    if (f.base) out.push({ kind: 'fbase', i: 0, x: f.base.x, z: f.base.z, ref: f.base,
      color: '#5aa9ff', big: true, label: '自軍飛行場' });
    // **座標を持たない自軍機も描く**（§71.5）。
    //
    // 以前は `if (a.x == null) return;` で捨てていた。だが座標が無いことは
    // 「置かれていない」ではなく「**置き場所を本体が決める**」という意味で、
    // CLEAN SWEEP と SCRAMBLE の全機がこれに当たる。エディタで複製すると
    // 自軍が1機も出ないのに、試遊すると出てくる、という食い違いになっていた。
    //
    // 本体が使う式（`main.js` の `spawnStage`）と同じ場所へ描く。
    (f.aircraft || []).forEach((a, i) => {
      const auto = a.x == null;
      if (auto && !f.base) return;      // 基準にする飛行場が無い
      const p = auto ? autoStartPos(f.base, i, !!f.startAirborne) : a;
      out.push({ kind: 'fair', i, x: p.x, z: p.z, ref: a, color: '#8fd4ff', round: true,
        label: a.name, auto, atBase: auto && !f.startAirborne, tether: auto ? f.base : null });
    });
    const e = s.enemy || {};
    ['base', 'base2'].forEach((key, i) => {
      const b = e[key];
      if (b) out.push({ kind: 'ebase', i, x: b.x, z: b.z, ref: b, color: '#ff5b44', big: true, label: '敵飛行場' });
    });
    (e.aircraft || []).forEach((a, i) => out.push({ kind: 'eair', i, x: a.x, z: a.z, ref: a,
      color: '#ff8a78', round: true, label: a.name }));
    (e.ground || []).forEach((g, i) => out.push({ kind: 'eground', i, x: g.x, z: g.z, ref: g,
      color: '#e0705a', label: g.name }));
    (s.objectives || []).forEach((o, i) => {
      if (o.type !== 'reach' || o.x == null) return;
      out.push({ kind: 'reach', i, x: o.x, z: o.z, ref: o, color: '#ffb648',
        round: true, radius: o.radius || 3000, label: o.label || '到達地点' });
    });
    return out;
  }

  _hit(px, pz) {
    let best = null; let bd = HIT;
    for (const it of this._items()) {
      const d = Math.hypot(this._px(it.x) - px, this._px(it.z) - pz);
      if (d <= bd) { bd = d; best = it; }
    }
    return best;
  }

  _wireCanvas() {
    const canvas = this.root.querySelector('#edMap');
    if (!canvas) return;
    const at = (ev) => {
      const r = canvas.getBoundingClientRect();
      // 表示されていないと 0 が返る。**そのまま割ると Infinity になる。**
      const w = r.width || SIZE;
      const h = r.height || SIZE;
      return { px: (ev.clientX - r.left) * (SIZE / w),
        pz: (ev.clientY - r.top) * (SIZE / h) };
    };
    canvas.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      const { px, pz } = at(ev);
      const it = this._hit(px, pz);
      if (it) this._removeItem(it.kind, it.i);
    });
    canvas.addEventListener('mousedown', (ev) => {
      if (ev.button !== 0) return;
      const { px, pz } = at(ev);
      const it = this._hit(px, pz);
      if (this.tool === 'select' || it) {
        if (!it) { this.sel = null; this._refresh(); return; }
        this.sel = { kind: it.kind, i: it.i };
        // **自動配置は掴めない**（§71.5）。掴めてしまうと、位置を見ようとして
        // なぞっただけで x/z が生えて「指定配置」に化ける。
        // 位置を決めたいなら右欄の「この位置に固定」を押させる。
        this._drag = it.auto ? null : { ref: it.ref };
        this._refresh();
        return;
      }
      this._place(this.tool, this._world(px), this._world(pz));
    });
    window.addEventListener('mousemove', this._onMove = (ev) => {
      if (!this._drag || !this.isOpen) return;
      const { px, pz } = at(ev);
      this._drag.ref.x = clampPos(this._world(px));
      this._drag.ref.z = clampPos(this._world(pz));
      this._draw();
    });
    window.addEventListener('mouseup', this._onUp = () => {
      if (!this._drag) return;
      this._drag = null;
      this._refresh();
    });
  }

  // -------------------------------------------------------------- 配置

  _place(tool, x, z) {
    const s = this.stage;
    x = clampPos(x); z = clampPos(z);
    const f = s.friendly = s.friendly || {};
    const e = s.enemy = s.enemy || {};
    if (tool === 'fbase') { f.base = { x, z }; this.sel = { kind: 'fbase', i: 0 }; }
    else if (tool === 'fair') {
      f.aircraft = f.aircraft || [];
      const n = f.aircraft.length + 1;
      const ac = { type: 'F-1', name: `FLIGHT ${n}`, loadout: ['AAM-M', 'AAM-S'] };
      // **飛行場の近くを押したら「自動配置」として足す**（§71.5）。
      // 位置を書かない機体は本体が飛行場を基準に並べる。エディタ側にも
      // その足し方が要る —— 無いと、飛行場発進のステージが作れない。
      // 離して押せば、いままでどおり座標を持つ機体になる。
      if (!f.base || Math.hypot(x - f.base.x, z - f.base.z) > AUTO_PLACE_RANGE) {
        ac.x = x; ac.z = z;
      }
      f.aircraft.push(ac);
      this.sel = { kind: 'fair', i: f.aircraft.length - 1 };
    } else if (tool === 'eair') {
      e.aircraft = e.aircraft || [];
      const n = e.aircraft.length + 1;
      e.aircraft.push({ type: 'J-7', name: `BANDIT ${n}`, x, z, agl: 5000, aiMode: 'PATROL', tags: ['cap'] });
      this.sel = { kind: 'eair', i: e.aircraft.length - 1 };
    } else if (tool === 'eground') {
      e.ground = e.ground || [];
      const n = e.ground.length + 1;
      e.ground.push({ type: 'SAM', name: `目標 ${n}`, x, z, tags: ['target'], known: true });
      this.sel = { kind: 'eground', i: e.ground.length - 1 };
    } else if (tool === 'ebase') {
      const key = e.base ? 'base2' : 'base';
      e[key] = { x, z, tags: ['target'], known: true };
      this.sel = { kind: 'ebase', i: key === 'base' ? 0 : 1 };
    } else if (tool === 'reach') {
      s.objectives = s.objectives || [];
      const o = (s.objectives || []).find((v) => v.type === 'reach');
      if (o) { o.x = x; o.z = z; this.sel = { kind: 'reach', i: s.objectives.indexOf(o) }; }
      else {
        s.objectives.push({ id: 'arrive', type: 'reach', tag: 'transport', x, z, radius: 3000,
          label: '指定地点まで護衛する' });
        this.sel = { kind: 'reach', i: s.objectives.length - 1 };
      }
    }
    this._refresh(true);
  }

  _removeItem(kind, i) {
    const s = this.stage;
    if (kind === 'fbase') delete s.friendly.base;
    else if (kind === 'fair') s.friendly.aircraft.splice(i, 1);
    else if (kind === 'eair') s.enemy.aircraft.splice(i, 1);
    else if (kind === 'eground') s.enemy.ground.splice(i, 1);
    else if (kind === 'ebase') delete s.enemy[i === 0 ? 'base' : 'base2'];
    else if (kind === 'reach') s.objectives.splice(i, 1);
    this.sel = null;
    this._refresh(true);
  }

  _selRef() {
    const it = this._selItem();
    return it ? it.ref : null;
  }

  /** いま選んでいる地図上の項目そのもの（`auto` などの表示情報を含む） */
  _selItem() {
    if (!this.sel) return null;
    return this._items().find((v) => v.kind === this.sel.kind && v.i === this.sel.i) || null;
  }

  // -------------------------------------------------------------- 右側

  _props() {
    const ref = this._selRef();
    if (!ref) return '<div class="ed-empty">地図の何かを選ぶと、ここで細かく設定できます</div>';
    const k = this.sel.kind;
    const rows = [];
    const num = (path, label, step = 1) =>
      `<label>${label}<input type="number" step="${step}" data-edsel="${path}"
        value="${esc(getPath(ref, path))}"></label>`;
    const text = (path, label, size = 12) =>
      `<label>${label}<input data-edsel="${path}" value="${esc(getPath(ref, path))}" size="${size}"></label>`;
    const pick = (path, label, opts) =>
      `<label>${label}<select data-edsel="${path}">${opts.map((o) =>
        `<option value="${esc(o)}"${getPath(ref, path) === o ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select></label>`;

    const item = this._selItem();
    rows.push(`<div class="ed-selname">${k === 'fbase' ? '自軍飛行場'
      : k === 'ebase' ? '敵飛行場' : esc(ref.name || ref.label || '')}</div>`);
    // 自動配置の機体は座標を持たない。空の欄を出すと、打ち込めるように見えて
    // **打ち込んだ瞬間に指定配置へ化ける**（しかも片方だけ埋まる）
    if (!(item && item.auto)) rows.push(num('x', 'X') + num('z', 'Z'));

    if (k === 'fair') {
      rows.push(this._spawnRow(item));
      rows.push(pick('type', '機種', custom.FRIENDLY_AIR_TYPES) + text('name', '名前'));
      rows.push(this._loadoutRow(ref));
      rows.push(text('tags', 'タグ（カンマ区切り）', 18));
    } else if (k === 'eair') {
      rows.push(pick('type', '機種', custom.ENEMY_AIR_TYPES) + text('name', '名前'));
      rows.push(num('agl', '対地高度', 100) + pick('aiMode', 'AIモード', Object.keys(AI_MODES)));
      rows.push(this._loadoutRow(ref));
      rows.push(text('tags', 'タグ', 18));
    } else if (k === 'eground') {
      rows.push(pick('type', '種別', custom.GROUND_PLACEABLE) + text('name', '名前'));
      rows.push(text('tags', 'タグ', 18)
        + `<label>判明<input type="checkbox" data-edsel="known"${ref.known ? ' checked' : ''}></label>`
        + `<label>武装なし<input type="checkbox" data-edsel="unarmed"${ref.unarmed ? ' checked' : ''}></label>`);
      // 進んで壊しに行く相手（§67.3）。空なら巡回だけ
      rows.push(text('attackTag', '攻撃目標のタグ', 14)
        + '<span class="ed-note">このタグを持つ相手へ寄って、射程で止まって撃つ</span>');
    } else if (k === 'ebase') {
      rows.push(text('tags', 'タグ', 18)
        + `<label>判明<input type="checkbox" data-edsel="known"${ref.known ? ' checked' : ''}></label>`);
      const r = ref.reinforce;
      rows.push(`<label>増援<input type="checkbox" data-edsel="reinforce"${r ? ' checked' : ''}></label>`
        + (r ? num('reinforce.every', '間隔(秒)', 10) + num('reinforce.max', '最大機数')
          + pick('reinforce.type', '機種', custom.ENEMY_AIR_TYPES) : ''));
    } else if (k === 'fbase') {
      const air = !!this.stage.friendly.startAirborne;
      rows.push(`<div class="ed-note">位置を持たない自軍機は、${air
        ? 'ここから 1.5km ほど前方の空中に並びます（点線で結んだ印）'
        : 'ここに駐機した状態で始まります（点線で結んだ印）'}</div>`);
      rows.push('<div class="ed-note">本体は近くの平らな場所へ飛行場を寄せるので、'
        + '実際の位置は 2km ほどずれることがあります</div>');
    } else if (k === 'reach') {
      rows.push(text('tag', 'タグ') + num('radius', '半径', 500));
      rows.push(text('label', '説明', 26));
    }
    rows.push(`<button data-edcmd="del" class="ed-del">この配置を消す</button>`);
    return rows.map((r) => `<div class="ed-row">${r}</div>`).join('');
  }

  /**
   * 自軍機の「どこから出るか」（§71.5）。
   *
   * 座標を持つ／持たないの差は本体にとって大きいのに、地図の上では
   * **見分けがつかない**。ここで名前を付けて、切り替えを1押しにする。
   */
  _spawnRow(item) {
    if (!item) return '';
    const air = !!this.stage.friendly.startAirborne;
    if (item.auto) {
      const where = air ? '飛行場の前方に自動で並ぶ' : '飛行場に駐機（地上発進）';
      return `<span class="ed-spawn">発進: ${where}</span>`
        + (air ? '<button data-edcmd="pin">この位置に固定</button>' : '')
        + `<span class="ed-note">${air
          ? '固定すると座標を持ち、掴んで動かせるようになります'
          : '「地形」タブの空中発進を入れると、空中に並べられます'}</span>`;
    }
    return '<span class="ed-spawn">発進: 指定した位置</span>'
      + '<button data-edcmd="unpin">飛行場にまかせる</button>'
      + (air ? '' : '<span class="ed-warn">空中発進が切れているので、'
        + 'この座標は使われません（飛行場から出ます）</span>');
  }

  _loadoutRow(ref) {
    const load = ref.loadout || [];
    // スロットもポイントも見ない —— エディタは「置きたいものを置く」場所で、
    // 積み過ぎは `validate()` が警告として拾う（§66）。
    const row = loadoutRow({
      loadout: load,
      add: (id) => `data-edload="add:${id}"`,
      del: (id) => `data-edload="del:${id}"`,
    });
    return `<div class="ed-load"><span>搭載 (${loadoutCost(load)}P)</span>
        <span class="ld-hint">${LOADOUT_HINT}</span></div>
      <div class="ed-load adds">${row}</div>`;
  }

  // -------------------------------------------------------------- 下側

  _tab() {
    const s = this.stage;
    const num = (path, label, step = 1) =>
      `<label>${label}<input type="number" step="${step}" data-ed="${path}"
        value="${esc(getPath(s, path))}"></label>`;
    if (this.tab === 'terrain') {
      const t = s.terrain;
      return `<div class="ed-row">
          ${num('terrain.seed', '種')}
          <button data-edcmd="reseed">引き直す</button>
          ${num('terrain.mountainAmount', '山岳', 0.1)}
          ${num('terrain.valleyDepth', '谷', 0.1)}
          ${num('terrain.rivers', '河川')}
          ${num('terrain.baseAltitude', '基準標高', 50)}
          <label>海岸<select data-ed="terrain.coast">${COAST.map((c) =>
            `<option value="${c}"${t.coast === c ? ' selected' : ''}>${c}</option>`).join('')}</select></label>
        </div>
        <div class="ed-row">
          <label>空中発進<input type="checkbox" data-ed="friendly.startAirborne"${
            s.friendly.startAirborne ? ' checked' : ''}></label>
          ${num('friendly.startAlt', '発進高度', 500)}
          <label>敵の練度<input type="number" step="0.1" data-ed="enemy.skill"
            value="${esc(s.enemy.skill ?? 0.6)}"></label>
        </div>`;
    }
    if (this.tab === 'objectives') {
      const rows = (s.objectives || []).map((o, i) => `
        <div class="ed-row">
          <select data-edobj="${i}.type">${custom.OBJECTIVE_TYPES.map((t) =>
            `<option value="${t}"${o.type === t ? ' selected' : ''}>${t}</option>`).join('')}</select>
          <input data-edobj="${i}.id" value="${esc(o.id)}" size="7" title="内部ID">
          <input data-edobj="${i}.tag" value="${esc(o.tag)}" size="10" title="タグ">
          <input data-edobj="${i}.label" value="${esc(o.label)}" size="28" title="画面に出る説明">
          ${o.type === 'survive' ? `<input type="number" data-edobj="${i}.seconds"
            value="${esc(o.seconds ?? 300)}" size="5" title="秒数">` : ''}
          <label>失敗<input type="checkbox" data-edobj="${i}.fail"${o.fail ? ' checked' : ''}></label>
          <button data-edcmd="delobj:${i}" class="ed-del">消す</button>
        </div>`).join('');
      return rows + `<div class="ed-row"><button data-edcmd="addobj">目標を足す</button>
        <span class="ed-note">destroyAll は敵のタグ、protect と reach は味方のタグを見ます</span></div>`;
    }
    if (this.tab === 'rating') {
      const r = s.rating || (s.rating = { time: [300, 600], points: [10, 18], losses: [0, 1] });
      return `<div class="ed-row">${num('weaponPoints', '兵装ポイント上限')}
          <span class="ed-note">プリセットの合計 ${
            (s.friendly.aircraft || []).reduce((n, a) => n + loadoutCost(a.loadout || []), 0)}P</span></div>
        <div class="ed-row">迅速 ◎${num('rating.time.0', '', 10)} ○${num('rating.time.1', '', 10)} 秒</div>
        <div class="ed-row">節約 ◎${num('rating.points.0', '')} ○${num('rating.points.1', '')} P</div>
        <div class="ed-row">損失 ◎${num('rating.losses.0', '')} ○${num('rating.losses.1', '')} 機</div>`;
    }
    if (this.tab === 'text') {
      return `<div class="ed-row col"><label>ブリーフィング</label>
          <textarea data-ed="brief" rows="3">${esc(s.brief)}</textarea></div>
        <div class="ed-row col"><label>助言</label>
          <textarea data-ed="hint" rows="2">${esc(s.hint)}</textarea></div>`;
    }
    // 一覧
    const list = custom.customStages().map((c) => `
      <div class="ed-listrow${c.id === s.id ? ' cur' : ''}">
        <b>${esc(c.name)}</b><span>${esc(c.title)}</span><i>${esc(c.id)}</i>
        <button data-edcmd="load:${c.id}">開く</button>
        <button data-edcmd="dup:${c.id}">複製</button>
        <button data-edcmd="rm:${c.id}" class="ed-del">削除</button>
      </div>`).join('') || '<div class="ed-empty">まだ1つも保存されていません</div>';
    return `${list}
      <div class="ed-row">
        <button data-edcmd="new">白紙から作る</button>
        <button data-edcmd="export">JSONを書き出す</button>
        <button data-edcmd="import">JSONを読み込む</button>
        <button data-edcmd="snippet">stages.js 用のコードを出す</button>
      </div>
      <textarea id="edOut" class="hidden" rows="8"></textarea>`;
  }

  // -------------------------------------------------------------- 入力

  _onInput(e) {
    const t = e.target;
    const val = (raw) => {
      if (t.type === 'checkbox') return t.checked;
      if (t.type === 'number') { const n = Number(raw); return Number.isFinite(n) ? n : 0; }
      return raw;
    };
    if (t.dataset.ed) {
      setPath(this.stage, t.dataset.ed, val(t.value));
      this._draw();
      if (t.dataset.ed.startsWith('terrain')) this._draw();
      return;
    }
    if (t.dataset.edsel) {
      const ref = this._selRef();
      if (!ref) return;
      const path = t.dataset.edsel;
      if (path === 'tags') {
        ref.tags = t.value.split(',').map((v) => v.trim()).filter(Boolean);
      } else if (path === 'reinforce') {
        if (t.checked) ref.reinforce = ref.reinforce || { every: 180, max: 4, type: 'J-7' };
        else delete ref.reinforce;
        this._refresh();
        return;
      } else {
        setPath(ref, path, val(t.value));
      }
      this._draw();
      return;
    }
    if (t.dataset.edobj) {
      const [i, key] = t.dataset.edobj.split('.');
      const o = this.stage.objectives[Number(i)];
      if (!o) return;
      o[key] = val(t.value);
      if (key === 'type') this._refresh(true);
      else this._draw();
    }
  }

  // -------------------------------------------------------------- 押した

  _onClick(e) {
    const tool = e.target.closest('button[data-edtool]');
    if (tool) { this.tool = tool.dataset.edtool; this.sel = null; this._render(); return; }
    const tab = e.target.closest('button[data-edtab]');
    if (tab) { this.tab = tab.dataset.edtab; this._render(); return; }
    const load = e.target.closest('button[data-edload]');
    if (load && !load.classList.contains('disabled')) {
      const ref = this._selRef();
      if (!ref) return;
      const [op, arg] = load.dataset.edload.split(':');
      ref.loadout = ref.loadout || [];
      if (op === 'add') ref.loadout.push(arg);
      else ref.loadout = removeOne(ref.loadout, arg);
      this._refresh();
      return;
    }
    const cmd = e.target.closest('button[data-edcmd]');
    if (!cmd) return;
    const [op, arg] = cmd.dataset.edcmd.split(':');
    this._command(op, arg);
  }

  _command(op, arg) {
    const s = this.stage;
    switch (op) {
      case 'exit': this.close(); this.onExit?.(); break;
      case 'del': if (this.sel) this._removeItem(this.sel.kind, this.sel.i); break;
      // 自動配置 ⇄ 指定配置（§71.5）。固定するときは、いま描いている点を写す ——
      // 「押したら別の場所へ飛んだ」と見えないようにするため。
      case 'pin': {
        const ref = this._selRef();
        const base = s.friendly && s.friendly.base;
        if (!ref || !base || this.sel.kind !== 'fair') break;
        const p = autoStartPos(base, this.sel.i, !!s.friendly.startAirborne);
        ref.x = clampPos(p.x); ref.z = clampPos(p.z);
        this._refresh();
        break;
      }
      case 'unpin': {
        const ref = this._selRef();
        if (!ref || this.sel.kind !== 'fair') break;
        delete ref.x; delete ref.z;
        this._refresh();
        break;
      }
      case 'reseed':
        s.terrain.seed = 10000 + Math.floor(Math.random() * 89999);
        this._render();
        break;
      case 'addobj':
        s.objectives = s.objectives || [];
        s.objectives.push({ id: 'obj' + (s.objectives.length + 1), type: 'destroyAll',
          tag: 'target', label: '新しい目標' });
        this._render();
        break;
      case 'delobj': s.objectives.splice(Number(arg), 1); this._render(); break;
      case 'new': this.open(custom.blankStage()); break;
      case 'load': {
        const c = custom.getCustom(arg);
        if (c) this.open(c);
        break;
      }
      case 'dup': {
        const c = custom.getCustom(arg);
        if (!c) break;
        const copy = custom.duplicate(c);
        custom.save(copy);
        this.open(copy);
        break;
      }
      case 'rm': custom.remove(arg); this._render(); break;
      case 'save': this._save(); break;
      case 'playtest': this._playtest(); break;
      case 'export': this._out(custom.toJSON(s), 'JSON。ファイルに保存すれば、あとで読み込めます'); break;
      case 'snippet': this._out(custom.snippet(s), 'stages.js の STAGES に足すコード。id は s7 などに直すこと'); break;
      case 'import': this._import(); break;
      default: break;
    }
  }

  _out(text, note) {
    this.tab = 'list';
    this._render();
    const box = this.root.querySelector('#edOut');
    if (!box) return;
    box.classList.remove('hidden');
    box.value = text;
    box.select();
    this._say(note, 'ok');
  }

  _import() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.addEventListener('change', () => {
      const file = input.files && input.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const res = custom.fromJSON(String(reader.result));
        if (!res.ok) { this._say(`読み込めません: ${res.why}`, 'bad'); this._refresh(); return; }
        const first = custom.getCustom(res.added[0]);
        this.open(first);
        this._say(`${res.added.length} 件読み込みました`, 'ok');
        this._refresh();
      };
      reader.readAsText(file);
    });
    input.click();
  }

  _say(text, kind) {
    this.msg = `<span class="ed-${kind}">${esc(text)}</span>`;
    const box = this.root.querySelector('.ed-msg');
    if (box) box.innerHTML = this.msg;
  }

  /** 検証して結果を出す。`fatal` があれば false */
  _check() {
    const v = custom.validate(this.stage);
    const parts = [];
    for (const m of v.fatal) parts.push(`<span class="ed-bad">✕ ${esc(m)}</span>`);
    for (const m of v.warn) parts.push(`<span class="ed-warn">△ ${esc(m)}</span>`);
    if (!parts.length) parts.push('<span class="ed-ok">✓ 遊べる形になっています</span>');
    this.msg = parts.join(' ');
    const box = this.root.querySelector('.ed-msg');
    if (box) box.innerHTML = this.msg;
    return v.ok;
  }

  _save() {
    // **警告では止めない**（§66.5）。作りかけを保存できないと作業にならない。
    const ok = this._check();
    if (!ok) { this._say('遊べない箇所があるので保存しません（上の ✕ を直してください）', 'bad'); return; }
    const res = custom.save(this.stage);
    if (!res.ok) { this._say(res.why, 'bad'); return; }
    this._say(`保存しました（${this.stage.id}）`, 'ok');
  }

  _playtest() {
    if (!this._check()) { this._say('遊べない箇所があります（上の ✕ を直してください）', 'bad'); return; }
    custom.save(this.stage);
    const stage = structuredClone(this.stage);
    this.close();
    this.onPlaytest?.(stage);
  }
}
