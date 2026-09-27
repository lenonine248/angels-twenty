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
import { CLOUD_COVER, CLOUD_SHAPE, CLOUD_WIND_SPEED } from '../world/clouds.js';
import { loadoutCost } from '../data/weapons.js';
import * as custom from '../data/custom.js';
import * as stagetext from '../data/stagetext.js';
import { TRIGGER_CONDITIONS, TRIGGER_ACTIONS, GUARD_DEFAULT } from '../sim/triggers.js';
import { isTuned } from './tuning.js';
import { onDevServer } from '../core/devserver.js';
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
  ['fsup', '自軍支援機', 'fsup'],
  ['fground', '自軍地上', 'fground'],
  ['aair', '友軍機', 'aair'],
  ['abase', '友軍飛行場', 'abase'],
  ['eair', '敵機', 'eair'],
  ['eground', '敵地上', 'eground'],
  ['ebase', '敵飛行場', 'ebase'],
  ['reach', '到達地点', 'reach'],
];

const TABS = [
  ['terrain', '地形'],
  ['weather', '天候'],
  ['objectives', '目標'],
  ['triggers', 'トリガー'],
  ['rating', '評価'],
  ['text', '文章'],
  ['list', '一覧'],
];

const COAST = ['none', 'n', 'e', 's', 'w'];

/** トリガー（§12.3）の条件・行動の名前。値は本体の `type` */
const COND_NAME = {
  time: '経過時間', detected: '敵に見つかった', destroyed: '敵のタグが破壊された',
  below: '敵の残りが n 機以下', enter: '自軍機が区域に入った', fired: '別のトリガーが実行済み',
};
const ACT_NAME = {
  guard: '地点に陣取る', defend: '飛行場の防空に戻る', restore: '元の動きに戻す',
  launch: '飛行場から出撃', reinforce: '増援を動かす／止める', notice: '状況文を出す',
  ground: '地上部隊の行動を変える',
};
/** 地上の行動（§103）の名前。値は本体の `groundMode` */
const GROUND_MODE_NAME = { advance: '前進', hold: '持つ', route: '巡回', retreat: '下がる' };

/**
 * 動く地上ユニットの点を地図に出す（§67.3・§103）: 進路の点・持ち場・下がる先。
 * `side` は 'e'（敵）/ 'f'（自軍・友軍）。進路は `i*100+j`、持ち場は `i*10`、下がる先は `i*10+1`
 */
function groundPoints(out, g, i, side) {
  const name = g.name || '地上';
  (g.route || []).forEach((wp, j) => out.push({ kind: `${side}route`, i: i * 100 + j, x: wp.x, z: wp.z,
    ref: wp, color: side === 'e' ? '#e0a05a' : '#7fb8e8', round: true,
    label: `${name} の経路 ${j + 1}`,
    tether: j === 0 ? { x: g.x, z: g.z } : { x: g.route[j - 1].x, z: g.route[j - 1].z } }));
  if (g.holdAt) out.push({ kind: `${side}gpt`, i: i * 10, x: g.holdAt.x, z: g.holdAt.z, ref: g.holdAt,
    color: side === 'e' ? '#e0c05a' : '#9fd0ff', round: true, label: `${name} の持ち場`, tether: { x: g.x, z: g.z } });
  if (g.retreatTo) out.push({ kind: `${side}gpt`, i: i * 10 + 1, x: g.retreatTo.x, z: g.retreatTo.z, ref: g.retreatTo,
    color: '#b0b0b0', round: true, label: `${name} の下がる先`, tether: { x: g.x, z: g.z } });
}
const BASE_NAME = { base: '敵飛行場 1', base2: '敵飛行場 2' };
/** 友軍側のトリガー（§102 A2）。条件の読み方が違うものだけ名前を替える */
const COND_NAME_ALLY = {
  ...COND_NAME, detected: '友軍側が敵機を見つけた', destroyed: 'タグが破壊された（敵味方とも）',
  below: '残りが n 機以下', enter: '敵機が区域に入った',
};
const ALLY_BASE_NAME = { base: '友軍飛行場', home: '自軍飛行場（共用）' };
/** 地図の上のトリガーの印。条件・行動の添字をこの数で畳んで1つの `i` にする */
const TRIG_STRIDE = 1000;
/** 友軍側のトリガーの印は `i` にこれを足して敵側と分ける */
const TRIG_ALLY = 1000000;

const CLOUD_KINDS = Object.keys(CLOUD_COVER);
const CLOUD_SHAPES = Object.keys(CLOUD_SHAPE);

/** 天候を書き始めるときの既定（§88.16 の面に近い層） */
const WEATHER_DEFAULT = { cloud: 'scattered', base: 2400, top: 3800, shape: 'puffy' };


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
    /** トリガータブで見ている側（§102 A2）。'enemy' / 'ally' */
    this.trigSide = 'enemy';
    this.sel = null;                   // { kind, i }
    this.msg = '';
    this._baseId = null;               // 出力の下敷き（§91）。null は自動判定
    this._terrain = null;
    this._terrainKey = '';
    this._mapImage = null;         // 地形の下敷き（種が変わるまで使い回す）
    this._drag = null;

    this.root.addEventListener('click', (e) => this._onClick(e));
    this.root.addEventListener('input', (e) => this._onInput(e));
    this.root.addEventListener('change', (e) => this._onInput(e));

    // **ドラッグの受けは構築時に1度だけ張る。**
    //
    // 以前は `_wireCanvas()`（＝描き直すたびに走る）の中で `window` へ足していて、
    // **一度も外していなかった。** 漏れた受けはどれも同じ `this` を見るので、
    // ドラッグ中は**全部が動く** —— 実測で描き直し30回のあと、
    // mousemove 1回が `_draw()` を31回・150ms。配置もツール切替もタブ切替も
    // 描き直しを通るので、数分で届く。
    //
    // 画布の上の受け（contextmenu/mousedown）は画布ごと作り直されるので、
    // あちらは `_wireCanvas()` のままでよい（要素が消えれば受けも消える）。
    window.addEventListener('mousemove', (ev) => {
      if (!this._drag || !this.isOpen) return;
      const p = this._at(ev);
      if (!p) return;
      this._drag.ref.x = clampPos(this._world(p.px));
      this._drag.ref.z = clampPos(this._world(p.pz));
      this._draw();
    });
    window.addEventListener('mouseup', () => {
      if (!this._drag) return;
      this._drag = null;
      this._refresh();
    });
  }

  /** 画面の点 → 画布の座標。画布が無ければ null */
  _at(ev) {
    const canvas = this.root.querySelector('#edMap');
    if (!canvas) return null;
    const r = canvas.getBoundingClientRect();
    // 表示されていないと 0 が返る。**そのまま割ると Infinity になる。**
    const w = r.width || SIZE;
    const h = r.height || SIZE;
    return { px: (ev.clientX - r.left) * (SIZE / w), pz: (ev.clientY - r.top) * (SIZE / h) };
  }

  get isOpen() { return !this.root.classList.contains('hidden'); }

  open(stage) {
    // **節ごと欠けた定義でも開けるようにしてから触る**（§66.10）。
    // 読み込んだ JSON は `friendly` しか保証されていない。
    this.stage = custom.normalize(structuredClone(stage || custom.blankStage()));
    this.sel = null;
    this.tool = 'select';
    this.msg = '';
    this._baseId = null;               // 面が変わったら下敷きの選び直しも捨てる
    this._dirty = false;
    this._pending = null;
    this.root.classList.remove('hidden');
    this._render();
  }

  /**
   * **保存していない編集を黙って捨てない**（§66.10）。
   *
   * ブラウザの確認窓は使わない（この作りでは他に1つも出していない）。
   * **同じボタンをもう一度押させる**形にする —— 押し間違いは止まるし、
   * 分かっていて捨てたい人は2回押すだけで済む。
   */
  _mayDiscard(token, what) {
    if (!this._dirty) return true;
    if (this._pending === token) { this._pending = null; return true; }
    this._pending = token;
    this._say(`保存していない編集があります。${what}なら、もう一度押してください`, 'warn');
    return false;
  }

  close() {
    this.root.classList.add('hidden');
    this.root.innerHTML = '';
    this.stage = null;
    this._dirty = false;
    this._pending = null;
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
      this._mapImage = null;                  // 下敷きも作り直す
    }
    return this._terrain;
  }

  /**
   * 地形の下敷き。**種が変わるまで使い回す。**
   *
   * 以前は `_draw()` のたびに `buildMinimapImage()` を呼んでいた ——
   * 5.8ms のうち 4.6ms がそれで、**ドラッグ中は mousemove ごとに**走っていた。
   * 地形は掴んで動かしている間ずっと同じものなので、作り直す理由が無い。
   */
  _mapCanvas() {
    const terrain = this._terrainFor();
    if (this._mapImage) return this._mapImage;
    const off = document.createElement('canvas');
    off.width = CELLS; off.height = CELLS;
    const octx = off.getContext('2d');
    octx.putImageData(terrain.buildMinimapImage(octx), 0, 0);
    this._mapImage = off;
    return off;
  }

  _px(v) { return (v / MAP_SIZE) * SIZE; }
  _world(p) { return (p / SIZE) * MAP_SIZE; }

  _draw() {
    const canvas = this.root.querySelector('#edMap');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    // 地形は 256 で出るので、拡大して敷く（下敷きは使い回す）
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, SIZE, SIZE);
    ctx.drawImage(this._mapCanvas(), 0, 0, SIZE, SIZE);

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
    // **支援機**（§80.4）。守る対象・運ぶ対象で、プレイヤーの指揮下に入らない。
    // `moveTo` を持つものは行き先も点で出して、掴んで動かせるようにする ——
    // 「どこまで運ぶのか」は数字より地図で決めたい。
    (f.support || []).forEach((a, i) => {
      out.push({ kind: 'fsup', i, x: a.x, z: a.z, ref: a, color: '#7ce0c0', round: true,
        big: true, label: a.name });
      if (a.moveTo) {
        out.push({ kind: 'fsupTo', i, x: a.moveTo.x, z: a.moveTo.z, ref: a.moveTo,
          color: '#7ce0c0', round: true, label: `${a.name || '支援機'} の行き先`,
          tether: { x: a.x, z: a.z } });
      }
    });
    (f.ground || []).forEach((g, i) => {
      out.push({ kind: 'fground', i, x: g.x, z: g.z, ref: g,
        color: '#5aa9ff', label: g.owner === 'ally' ? `${g.name || '地上'}（友軍）` : g.name });
      groundPoints(out, g, i, 'f');
    });
    // **友軍**（§102）。航空機は緑、飛行場は自軍と同じ青（Q7）。
    // 座標を持たない友軍機は待機する飛行場の上に描く（掴めない＝自軍機の自動配置と同じ扱い）
    const al = s.ally || {};
    if (al.base) out.push({ kind: 'abase', i: 0, x: al.base.x, z: al.base.z, ref: al.base,
      color: '#5aa9ff', big: true, label: '友軍飛行場' });
    (al.aircraft || []).forEach((a, i) => {
      const auto = a.x == null;
      const home = al.base && a.base !== 'home' ? al.base : f.base;
      if (auto && !home) return;
      out.push({ kind: 'aair', i, x: auto ? home.x + 600 * (i + 1) : a.x, z: auto ? home.z - 600 : a.z,
        ref: a, color: '#5fd68a', round: true, label: a.name, auto, tether: auto ? home : null });
    });
    const e = s.enemy || {};
    ['base', 'base2'].forEach((key, i) => {
      const b = e[key];
      if (b) out.push({ kind: 'ebase', i, x: b.x, z: b.z, ref: b, color: '#ff5b44', big: true, label: '敵飛行場' });
    });
    (e.aircraft || []).forEach((a, i) => out.push({ kind: 'eair', i, x: a.x, z: a.z, ref: a,
      color: '#ff8a78', round: true, label: a.name }));
    (e.ground || []).forEach((g, i) => {
      out.push({ kind: 'eground', i, x: g.x, z: g.z, ref: g, color: '#e0705a', label: g.name });
      groundPoints(out, g, i, 'e');
    });
    // トリガーの地点と区域（§12.3）。**地図で置きたいもの**なので印を出して掴めるようにする。
    // 友軍側（§102 A2）も同じ印で、`i` を `TRIG_ALLY` だけずらして分ける
    for (const [host, off, who] of [[e, 0, ''], [s.ally || {}, TRIG_ALLY, '（友軍）']]) {
      (host.triggers || []).forEach((t, ti) => {
        (t.when || []).forEach((c, j) => {
          if (c.type !== 'enter' || c.x == null) return;
          out.push({ kind: 'tenter', i: off + ti * TRIG_STRIDE + j, x: c.x, z: c.z, ref: c, color: '#c792ff',
            round: true, radius: c.r || 5000, label: `${t.label || t.id} の区域${who}` });
        });
        (t.do || []).forEach((a, j) => {
          if (a.type !== 'guard' || a.x == null) return;
          out.push({ kind: 'tguard', i: off + ti * TRIG_STRIDE + j, x: a.x, z: a.z, ref: a, color: '#c792ff',
            radius: a.r || GUARD_DEFAULT.radius, label: `${t.label || t.id} の陣取る地点（${a.tag}）${who}` });
        });
        // 地上の行動の地点（§103）。持ち場・下がる先
        (t.do || []).forEach((a, j) => {
          if (a.type !== 'ground' || a.x == null) return;
          out.push({ kind: 'tground', i: off + ti * TRIG_STRIDE + j, x: a.x, z: a.z, ref: a, color: '#c792ff',
            round: true, label: `${t.label || t.id} の${GROUND_MODE_NAME[a.mode] || ''}地点（${a.tag}）${who}` });
        });
      });
    }
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

  /**
   * 画布の上の受け。**画布ごと作り直されるので、ここに張ってよい。**
   * `window` へ張るものは構築時に1度だけ（漏れる）。
   */
  _wireCanvas() {
    const canvas = this.root.querySelector('#edMap');
    if (!canvas) return;
    canvas.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      const p = this._at(ev);
      if (!p) return;
      const it = this._hit(p.px, p.pz);
      if (it) this._removeItem(it.kind, it.i);
    });
    canvas.addEventListener('mousedown', (ev) => {
      if (ev.button !== 0) return;
      const p = this._at(ev);
      if (!p) return;
      const it = this._hit(p.px, p.pz);
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
      this._place(this.tool, this._world(p.px), this._world(p.pz));
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
    } else if (tool === 'fsup') {
      f.support = f.support || [];
      const n = f.support.length + 1;
      f.support.push({ type: 'E-8', name: `CARGO ${n}`, x, z, agl: 4200,
        aiMode: 'TRANSIT', tags: ['transport'] });
      this.sel = { kind: 'fsup', i: f.support.length - 1 };
    } else if (tool === 'fground') {
      f.ground = f.ground || [];
      const n = f.ground.length + 1;
      f.ground.push({ type: 'DEPOT', name: `補給施設 ${n}`, x, z, tags: ['depot'], known: true });
      this.sel = { kind: 'fground', i: f.ground.length - 1 };
    } else if (tool === 'aair') {
      // 友軍機（§102）。飛行場の近くを押したら待機（座標なし）、離して押せば空中で出現
      const al = s.ally = s.ally || {};
      al.aircraft = al.aircraft || [];
      if (!al.objectives) al.objectives = [{ id: 'ally1', type: 'destroyAll', tag: 'target', label: '目標を叩く' }];
      const n = al.aircraft.length + 1;
      const ac = { type: 'F-1', name: `EAGLE ${n}`, loadout: ['AAM-M', 'AAM-M', 'AAM-S', 'AAM-S'] };
      const near = [al.base, f.base].find((b) => b && Math.hypot(x - b.x, z - b.z) <= AUTO_PLACE_RANGE);
      if (!near) { ac.x = x; ac.z = z; ac.agl = 4500; }
      else if (near === f.base && al.base) ac.base = 'home';
      al.aircraft.push(ac);
      this.sel = { kind: 'aair', i: al.aircraft.length - 1 };
    } else if (tool === 'abase') {
      const al = s.ally = s.ally || {};
      al.base = { x, z };
      this.sel = { kind: 'abase', i: 0 };
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
    this._dirty = true;
    this._refresh(true);
  }

  _removeItem(kind, i) {
    const s = this.stage;
    if (kind === 'fbase') delete s.friendly.base;
    else if (kind === 'fair') s.friendly.aircraft.splice(i, 1);
    else if (kind === 'fsup') s.friendly.support.splice(i, 1);
    else if (kind === 'fsupTo') delete s.friendly.support[i].moveTo;   // 行き先だけ消す
    else if (kind === 'fground') s.friendly.ground.splice(i, 1);
    else if (kind === 'aair') s.ally.aircraft.splice(i, 1);
    else if (kind === 'abase') {
      delete s.ally.base;
      for (const a of s.ally.aircraft || []) delete a.base;   // 共用の飛行場に戻る
    }
    else if (kind === 'eroute' || kind === 'froute') {
      const g = (kind === 'eroute' ? s.enemy : s.friendly).ground[Math.floor(i / 100)];
      if (g && g.route) {
        g.route.splice(i % 100, 1);
        if (!g.route.length) delete g.route;       // 空の経路は残さない
      }
    }
    else if (kind === 'egpt' || kind === 'fgpt') {
      // 持ち場・下がる先の点（§103）。消すと「その場で持つ」「出現した位置へ下がる」に戻る
      const g = (kind === 'egpt' ? s.enemy : s.friendly).ground[Math.floor(i / 10)];
      if (g) delete g[i % 10 === 0 ? 'holdAt' : 'retreatTo'];
    }
    else if (kind === 'eair') s.enemy.aircraft.splice(i, 1);
    else if (kind === 'eground') s.enemy.ground.splice(i, 1);
    else if (kind === 'ebase') delete s.enemy[i === 0 ? 'base' : 'base2'];
    else if (kind === 'reach') s.objectives.splice(i, 1);
    else if (kind === 'tenter' || kind === 'tguard') {
      const host = i >= TRIG_ALLY ? s.ally : s.enemy;
      const t = host && host.triggers && host.triggers[Math.floor((i % TRIG_ALLY) / TRIG_STRIDE)];
      if (t) (kind === 'tenter' ? t.when : t.do).splice(i % TRIG_STRIDE, 1);
    }
    else if (kind === 'tground') {
      // 点だけ消す（行動は残る —— 持つならその場、下がるなら置いた位置へ）
      const host = i >= TRIG_ALLY ? s.ally : s.enemy;
      const t = host && host.triggers && host.triggers[Math.floor((i % TRIG_ALLY) / TRIG_STRIDE)];
      const a = t && t.do[i % TRIG_STRIDE];
      if (a) { delete a.x; delete a.z; }
    }
    this.sel = null;
    this._dirty = true;
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

  /**
   * 動く地上ユニットの欄（§67.3・§103）: 攻撃目標のタグ・地上の行動・持ち場・下がる先・進路。
   * 動かない陣地には出さない
   */
  _groundMoveRows(rows, ref, text) {
    const spec = GROUND_TYPES[ref.type];
    if (!spec || spec.static) return;
    // 進んで壊しに行く相手（§67.3）。空なら巡回だけ
    rows.push(text('attackTag', '攻撃目標のタグ', 14)
      + '<span class="ed-note">このタグを持つ相手へ寄って、射程で止まって撃つ</span>');
    const cur = ref.groundMode || '';
    rows.push(`<label>地上の行動<select data-edsel="groundMode">${[['', '既定'], ...Object.entries(GROUND_MODE_NAME)]
      .map(([v, n]) => `<option value="${v}"${cur === v ? ' selected' : ''}>${n}</option>`).join('')}</select></label>`
      + '<span class="ed-note">既定: 攻撃目標のタグがあれば前進、進路があれば巡回、どちらも無ければその場で持つ。トリガーで切り替えられます</span>');
    rows.push(`<label>持ち場を置く<input type="checkbox" data-edsel="holdAt"${ref.holdAt ? ' checked' : ''}></label>`
      + `<label>下がる先を置く<input type="checkbox" data-edsel="retreatTo"${ref.retreatTo ? ' checked' : ''}></label>`
      + '<span class="ed-note">無ければ「持つ」はその場・「下がる」は置いた位置</span>');
    // 進む相手（COASTAL WALL の車両部隊）。点は地図に出して掴めるようにする
    const rt = ref.route;
    rows.push(`<label>進路を持つ<input type="checkbox" data-edsel="route"${rt ? ' checked' : ''}></label>`
      + (rt ? `<button data-edcmd="addwp">点を足す</button>`
        + `<span class="ed-note">${rt.length}点を順に回ります（最後まで行くと先頭へ戻る）。地図の点を掴んで動かせます</span>`
        : '<span class="ed-note">入れると地図に経路の点が出ます。動かない陣地なら切ったままで構いません</span>'));
  }

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
    const KIND_NAME = { fbase: '自軍飛行場', ebase: '敵飛行場', abase: '友軍飛行場', fsupTo: '支援機の行き先',
      tenter: `トリガーの区域`, tguard: 'トリガーの陣取る地点' };
    rows.push(`<div class="ed-selname">${KIND_NAME[k] || esc(ref.name || ref.label || '')}</div>`);
    // 自動配置の機体は座標を持たない。空の欄を出すと、打ち込めるように見えて
    // **打ち込んだ瞬間に指定配置へ化ける**（しかも片方だけ埋まる）
    if (!(item && item.auto)) rows.push(num('x', 'X') + num('z', 'Z'));

    if (k === 'fair') {
      rows.push(this._spawnRow(item));
      rows.push(pick('type', '機種', custom.FRIENDLY_AIR_TYPES) + text('name', '名前'));
      rows.push(this._loadoutRow(ref));
      rows.push(text('tags', 'タグ（カンマ区切り）', 18));
    } else if (k === 'aair') {
      // 友軍機（§102）。プレイヤーは操作できない。友軍の司令官が「友軍の任務」（目標タブ）を読んで動かす
      rows.push(pick('type', '機種', custom.FRIENDLY_AIR_TYPES) + text('name', '名前'));
      if (item && item.auto) {
        const al = this.stage.ally || {};
        rows.push(al.base
          ? `<label>待機する飛行場<select data-edsel="allyBase">
              <option value="ally"${ref.base !== 'home' ? ' selected' : ''}>友軍飛行場</option>
              <option value="home"${ref.base === 'home' ? ' selected' : ''}>自軍飛行場（共用）</option></select></label>`
          : '<span class="ed-note">自軍飛行場で待機して始まります（共用・整備枠は使いません）</span>');
      } else {
        rows.push(num('agl', '対地高度', 100) + '<span class="ed-note">空中で出現します。飛行場の近くに置くと待機になります</span>');
      }
      rows.push(this._loadoutRow(ref));
      rows.push(text('tags', 'タグ', 18) + pick('aiMode', 'AIモード', Object.keys(AI_MODES)));
      rows.push('<div class="ed-note">兵装ポイントは使いません。積み直しは最初の搭載に戻します</div>');
    } else if (k === 'abase') {
      rows.push(`<label>敵に判明<input type="checkbox" data-edsel="known"${ref.known ? ' checked' : ''}></label>`
        + '<span class="ed-note">友軍専用。プレイヤーの機体は使えず、全滅の判定（飛行場をすべて失う）にも数えません</span>');
      const r = ref.reinforce;
      rows.push(`<label>友軍の増援<input type="checkbox" data-edsel="reinforce"${r ? ' checked' : ''}></label>`
        + (r ? num('reinforce.every', '間隔(秒)', 10) + num('reinforce.max', '最大機数')
          + num('reinforce.burst', '1波の機数') + num('reinforce.first', '初回まで(秒)', 10) : ''));
      if (r) {
        rows.push(`<label>機種（カンマ区切り）<input data-edsel="reinforce.types"
            value="${esc((r.types || (r.type ? [r.type] : ['F-1'])).join(','))}" size="20"></label>`
          + '<span class="ed-note">搭載はその機種の既定になります</span>');
      }
    } else if (k === 'fsup') {
      rows.push(pick('type', '機種', custom.SUPPORT_AIR_TYPES) + text('name', '名前'));
      rows.push(num('agl', '対地高度', 100) + pick('aiMode', 'AIモード', Object.keys(AI_MODES)));
      rows.push(text('tags', 'タグ', 18)
        + `<label>操作できる<input type="checkbox" data-edsel="commandable"${
          ref.commandable ? ' checked' : ''}></label>`
        + '<span class="ed-note">既定では指揮下に置きません（護衛の対象を動かせると護衛が成立しない・§80.4）</span>');
      // 行き先。**点を出すかどうか**を切り替えるので、他の項目と同じ経路では書けない
      rows.push(`<label>行き先を決める<input type="checkbox" data-edsel="moveTo"${
        ref.moveTo ? ' checked' : ''}></label>`
        + (ref.moveTo ? '<span class="ed-note">地図に出た点を掴んで動かせます</span>'
          : '<span class="ed-note">入れると地図に行き先の点が出ます（護衛の到達目標と組で使う）</span>'));
    } else if (k === 'egpt' || k === 'fgpt') {
      rows.push(`<div class="ed-note">${this.sel.i % 10 === 0
        ? '行動が「持つ」のとき、ここへ動いて留まります'
        : '行動が「下がる」のとき、ここへ下がって留まります'}。右クリックで点を消せます</div>`);
    } else if (k === 'eroute' || k === 'froute') {
      rows.push('<div class="ed-note">車両はこの点を順に回ります。'
        + '右クリックで点だけ消せます（最後の1点を消すと進路ごと外れます）</div>');
    } else if (k === 'fsupTo') {
      rows.push(num('alt', '到達高度(m)', 500));
      rows.push('<div class="ed-note">支援機はここへ向かい、着いたらこの周りを回ります。'
        + '「到達地点」ツールで同じ場所に目標を置くと、護衛ミッションになります</div>');
    } else if (k === 'fground') {
      rows.push(pick('type', '種別', custom.GROUND_PLACEABLE) + text('name', '名前'));
      rows.push(text('tags', 'タグ', 18)
        + `<label>敵に判明<input type="checkbox" data-edsel="known"${ref.known ? ' checked' : ''}></label>`
        + `<label>武装なし<input type="checkbox" data-edsel="unarmed"${ref.unarmed ? ' checked' : ''}></label>`
        + `<label>友軍<input type="checkbox" data-edsel="owner"${ref.owner === 'ally' ? ' checked' : ''}></label>`);
      rows.push('<div class="ed-note">守る対象なら protect、いくつ残すかで測るなら hold の目標と組で使います。'
        + '「友軍」は指揮系統だけの印（色は自軍と同じ青・§102）。地上の行動を動かすトリガーは友軍側から書けます</div>');
      this._groundMoveRows(rows, ref, text);
    } else if (k === 'eair') {
      rows.push(pick('type', '機種', custom.ENEMY_AIR_TYPES) + text('name', '名前'));
      rows.push(num('agl', '対地高度', 100) + pick('aiMode', 'AIモード', Object.keys(AI_MODES)));
      rows.push(this._loadoutRow(ref));
      rows.push(text('tags', 'タグ', 18));
      // 爆撃機に「どこを狙うか」を持たせる（SCRAMBLE の形）
      rows.push(text('strikeTargetTag', '爆撃目標のタグ', 14)
        + '<span class="ed-note">このタグを持つものへ真っ直ぐ向かって爆撃します（空欄なら AIモードまかせ）</span>');
    } else if (k === 'eground') {
      rows.push(pick('type', '種別', custom.GROUND_PLACEABLE) + text('name', '名前'));
      rows.push(text('tags', 'タグ', 18)
        + `<label>判明<input type="checkbox" data-edsel="known"${ref.known ? ' checked' : ''}></label>`
        + `<label>武装なし<input type="checkbox" data-edsel="unarmed"${ref.unarmed ? ' checked' : ''}></label>`);
      this._groundMoveRows(rows, ref, text);
    } else if (k === 'ebase') {
      rows.push(text('tags', 'タグ', 18)
        + `<label>判明<input type="checkbox" data-edsel="known"${ref.known ? ' checked' : ''}></label>`);
      const r = ref.reinforce;
      rows.push(`<label>増援<input type="checkbox" data-edsel="reinforce"${r ? ' checked' : ''}></label>`
        + (r ? num('reinforce.every', '間隔(秒)', 10) + num('reinforce.max', '最大機数')
          + num('reinforce.burst', '1波の機数') + num('reinforce.first', '初回まで(秒)', 10) : ''));
      if (r) {
        // **機種は複数書ける**（`types`）。本体は `types` を順に使い、
        // 無ければ `type` に落ちる —— 出す側は `types` に寄せて1本にする。
        const types = (r.types || (r.type ? [r.type] : ['J-7'])).join(',');
        rows.push(`<label>機種（カンマ区切り）<input data-edsel="reinforce.types"
            value="${esc(types)}" size="20"></label>`
          + '<span class="ed-note">順番に使います。「B-9,J-7,J-7」なら爆撃機1・護衛2の波</span>'
          + '<span class="ed-note">「初回まで」は第1波が湧くまでの秒数。空欄なら間隔と同じ。'
          + '中盤だけ緩めたいときに、開幕の強襲まで一緒に楽にしないための欄です</span>');
        // **タグが無いと増援は目標から見えない**（§74.3 の `pending`）。
        // ここを空のままにすると「全機撃墜」が湧いている最中に達成になる。
        rows.push(`<label>増援のタグ<input data-edsel="reinforce.tags"
            value="${esc((r.tags || []).join(','))}" size="16"></label>`
          + '<span class="ed-warn">空だと、湧いた機体は destroyAll の数に入りません（§74.3）</span>');
        // 開始の3通り（§80.5・§12.3）
        const START = [['', '開始から数える'], ['detected', '見つかってから数える'], ['trigger', 'トリガーで開始']];
        rows.push(`<label>増援の開始<select data-edsel="reinforce.after">${START.map(([v, l]) =>
          `<option value="${v}"${(r.after || '') === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>`
          + '<span class="ed-note">「見つかってから」はこちらが敵に掴まれるまで時計が動きません。'
          + '「トリガーで開始」は「増援を動かす」行動が実行されるまで湧きません</span>');
      }
    } else if (k === 'fbase') {
      const air = !!this.stage.friendly.startAirborne;
      rows.push(`<div class="ed-note">位置を持たない自軍機は、${air
        ? 'ここから 1.5km ほど前方の空中に並びます（点線で結んだ印）'
        : 'ここに駐機した状態で始まります（点線で結んだ印）'}</div>`);
      rows.push('<div class="ed-note">本体は近くの平らな場所へ飛行場を寄せるので、'
        + '実際の位置は 2km ほどずれることがあります</div>');
    } else if (k === 'tenter') {
      const ally = this.sel.i >= TRIG_ALLY;
      rows.push(num('r', '半径(m)', 500));
      rows.push(`<div class="ed-note">${ally ? '自軍側（プレイヤー・友軍）がいま探知している敵機' : '敵がいま探知している自軍機'}`
        + 'がこの輪に入ると成立します。見えていない侵入には反応しません。細目は「トリガー」タブで</div>');
    } else if (k === 'tground') {
      rows.push('<div class="ed-note">トリガーが動かす地上部隊の持ち場／下がる先。右クリックで点だけ消せます'
        + '（消すと、持つならその場・下がるなら置いた位置）。細目は「トリガー」タブで</div>');
    } else if (k === 'tguard') {
      const ally = this.sel.i >= TRIG_ALLY;
      rows.push(num('alt', '対地高度(m)', 100) + num('r', '半径(m)', 500));
      rows.push(`<div class="ed-note">その時点で生きているタグの${ally ? '友軍機' : '機体'}が、この輪の上を回って守ります。`
        + '細目は「トリガー」タブで</div>');
    } else if (k === 'reach') {
      rows.push(text('tag', 'タグ') + num('radius', '半径', 500));
      rows.push(text('label', '説明', 26));
    }
    rows.push(`<button data-edcmd="del" class="ed-del">この配置を消す</button>`);
    return rows.map((r) => `<div class="ed-row">${r}</div>`).join('');
  }

  /**
   * 友軍の任務（§102）。敵側の任務と同じ形で、友軍の司令官AIが読む。
   * **書かなければ友軍は動かない**（Q5）—— 友軍機を置いただけでは何もしないので、ここで気付けるように書く。
   */
  _allyObjectives(row) {
    const al = this.stage.ally || {};
    const list = (al.objectives || []).map((o, i) => row(o, i, 'edallyobj', { del: 'delallyobj', fail: false })).join('');
    const has = (al.aircraft || []).length;
    return `<div class="bf-section">友軍の任務（§102）</div>${list
      || `<div class="ed-empty">${has ? '<span class="ed-warn">友軍機を置いたのに任務がありません。書かなければ友軍の司令官は動きません</span>'
        : '友軍機（地図の「友軍機」）を置いて任務を書くと、友軍の司令官AIが動かします'}</div>`}
      <div class="ed-row"><button data-edcmd="addallyobj">友軍の任務を足す</button>
        <label>友軍の練度<input type="number" step="0.1" data-ed="ally.skill" value="${esc(al.skill ?? 1)}"></label>
        <label>こちらの攻撃機も護衛する<input type="checkbox" data-ed="ally.escortPlayer"${
          al.escortPlayer === false ? '' : ' checked'}></label>
        <span class="ed-note">destroyAll は敵のタグ、protect は味方のタグ（プレイヤーの機体も護れる）。
          勝敗にも評価にも入りません</span></div>`;
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

  /**
   * トリガーの一覧（§12.3）。1件ずつ枠に入れ、条件の行と行動の行を並べる。
   *
   * タグ・飛行場・機種・別のトリガーは**選択肢から選ばせる** ——
   * 打ち間違いは「黙って何も起きない」形でしか現れないので、打たせないのが一番効く。
   */
  _triggerTab() {
    // 敵側と友軍側（§102 A2）で違うのは、タグ・飛行場・機種の選択肢と言葉だけ
    const ally = this.trigSide === 'ally';
    const e = this._trigHost() || {};
    const list = e.triggers || [];
    const actTags = ally ? this._allyTags() : this._enemyTags();
    // 友軍の条件はどちらの陣営のタグも読む（行動が触るのは友軍機だけ）
    const condTags = ally ? [...new Set([...actTags, ...this._friendlyTags(), ...this._enemyTags()])] : actTags;
    const bases = this._trigBases();
    const baseName = ally ? ALLY_BASE_NAME : BASE_NAME;
    const condName = ally ? COND_NAME_ALLY : COND_NAME;
    const opt = (pairs, cur) => pairs.map(([v, l]) =>
      `<option value="${esc(v)}"${String(cur ?? '') === String(v) ? ' selected' : ''}>${esc(l)}</option>`).join('');
    const sel = (path, pairs, cur, title = '') =>
      `<select data-edtrig="${path}" title="${title}">${opt(pairs, cur)}</select>`;
    // 今の値が選択肢に無ければ残す（読み込んだ定義を黙って書き換えない）
    const withCur = (pairs, cur) => (cur && !pairs.some(([v]) => v === cur)
      ? [[cur, `${cur}（見つかりません）`], ...pairs] : pairs);
    const tagSel = (path, cur, blank, tags = actTags) => sel(path,
      withCur([...(blank ? [['', blank]] : []), ...tags.map((t) => [t, t])], cur), cur, 'タグ');
    const baseSel = (path, cur) => sel(path, withCur(bases.map((k) => [k, baseName[k]]), cur), cur, '飛行場');
    const num = (path, label, cur, step = 1) =>
      `<label>${label}<input type="number" step="${step}" data-edtrig="${path}" value="${esc(cur ?? '')}"></label>`;

    const condRow = (c, i, j) => {
      const p = `${i}.when.${j}`;
      let f = '';
      if (c.type === 'time') f = num(`${p}.seconds`, '秒', c.seconds, 10);
      else if (c.type === 'destroyed') {
        f = tagSel(`${p}.tag`, c.tag, '', condTags) + num(`${p}.count`, '個数（0＝全滅）', c.count ?? 0);
      } else if (c.type === 'below') {
        f = tagSel(`${p}.tag`, c.tag, ally ? '（友軍機すべて）' : '（敵の航空機すべて）', condTags)
          + num(`${p}.n`, '機以下', c.n);
      } else if (c.type === 'enter') {
        f = '<span class="ed-note">地図の紫の輪を動かして決めます</span>' + num(`${p}.r`, '半径', c.r, 500);
      } else if (c.type === 'fired') {
        f = sel(`${p}.id`, withCur(list.filter((o, k) => k !== i).map((o) => [o.id, o.label || o.id]), c.id), c.id);
      }
      return `<div class="ed-row ed-trigline"><span class="ed-trigtag">もし</span>
        ${sel(`${p}.type`, TRIGGER_CONDITIONS.map((v) => [v, condName[v]]), c.type)}${f}
        <button data-edcmd="delcond:${i}.${j}" class="ed-del">×</button></div>`;
    };
    const actRow = (a, i, j) => {
      const p = `${i}.do.${j}`;
      let f = '';
      if (a.type === 'guard') {
        f = tagSel(`${p}.tag`, a.tag) + num(`${p}.alt`, '対地高度', a.alt, 100) + num(`${p}.r`, '半径', a.r, 500)
          + '<span class="ed-note">地点は地図の紫の四角</span>';
      } else if (a.type === 'defend') f = tagSel(`${p}.tag`, a.tag) + baseSel(`${p}.base`, a.base);
      else if (a.type === 'restore') f = tagSel(`${p}.tag`, a.tag);
      else if (a.type === 'launch') {
        f = baseSel(`${p}.base`, a.base)
          + sel(`${p}.aircraft`, (ally ? custom.FRIENDLY_AIR_TYPES : custom.ENEMY_AIR_TYPES).map((v) => [v, v]),
            a.aircraft, '機種')
          + num(`${p}.n`, '機数', a.n)
          + `<label>付けるタグ<input data-edtrig="${p}.tag" value="${esc(a.tag || '')}" size="8"></label>`;
      } else if (a.type === 'reinforce') {
        f = baseSel(`${p}.base`, a.base)
          + sel(`${p}.on`, [['true', '動かす'], ['false', '止める']], String(!!a.on));
      } else if (a.type === 'notice') {
        f = `<input data-edtrig="${p}.text" value="${esc(a.text || '')}" size="36" title="画面のログに【状況】として出る">`;
      } else if (a.type === 'ground') {
        // 地上の行動（§103）。動かせるのは動く地上ユニットだけ
        f = tagSel(`${p}.tag`, a.tag, '', this._groundTags(ally))
          + sel(`${p}.mode`, Object.entries(GROUND_MODE_NAME), a.mode, '行動')
          + (a.mode === 'advance'
            ? `<label>攻撃目標のタグ<input data-edtrig="${p}.attackTag" value="${esc(a.attackTag || '')}" size="8" title="空ならステージに書いたもの"></label>`
            : '')
          + (a.mode === 'hold' || a.mode === 'retreat'
            ? `<button data-edcmd="trgpt:${i}.${j}">${a.x == null ? '地点を置く' : '地点を外す'}</button>`
              + `<span class="ed-note">${a.x == null ? (a.mode === 'hold' ? 'その場で持つ' : '置いた位置へ下がる') : '地図の紫の点'}</span>`
            : '');
      }
      return `<div class="ed-row ed-trigline"><span class="ed-trigtag">→</span>
        ${sel(`${p}.type`, TRIGGER_ACTIONS.map((v) => [v, ACT_NAME[v]]), a.type)}${f}
        <button data-edcmd="delact:${i}.${j}" class="ed-del">×</button></div>`;
    };

    const blocks = list.map((t, i) => `<div class="ed-trig">
      <div class="ed-row">
        <input data-edtrig="${i}.id" value="${esc(t.id)}" size="8" title="ID（別のトリガーから指すときの名前）">
        <input data-edtrig="${i}.label" value="${esc(t.label || '')}" size="28" title="メモ（画面には出ません）">
        ${sel(`${i}.match`, [['all', '条件をすべて満たしたら'], ['any', '条件のどれか1つで']], t.match || 'all')}
        ${num(`${i}.delay`, '遅らせる(秒)', t.delay ?? 0, 5)}
        <button data-edcmd="deltrig:${i}" class="ed-del">消す</button>
      </div>
      ${(t.when || []).map((c, j) => condRow(c, i, j)).join('')}
      <div class="ed-row"><button data-edcmd="addcond:${i}">条件を足す</button></div>
      ${(t.do || []).map((a, j) => actRow(a, i, j)).join('')}
      <div class="ed-row"><button data-edcmd="addact:${i}">行動を足す</button></div>
    </div>`).join('');

    const sideRow = `<div class="ed-row ed-trigside">
      <button data-edcmd="trigside:enemy"${ally ? '' : ' class="on"'}>敵側 (${((this.stage.enemy || {}).triggers || []).length})</button>
      <button data-edcmd="trigside:ally"${ally ? ' class="on"' : ''}>友軍側 (${((this.stage.ally || {}).triggers || []).length})</button></div>`;
    const empty = ally ? 'トリガーはありません。友軍は最初の設定のまま動きます'
      : 'トリガーはありません。敵は最初の設定のまま動きます';
    const note = ally
      ? `友軍側のトリガーは、敵味方どちらのタグの損害も数えます（「敵の SAM が壊れたら」が書けます）。区域は自軍側が探知している敵機だけを数えます。
          行動が動かすのは友軍機だけで、プレイヤーの機体は動きません。友軍の任務が無くても動きます`
      : '数えるのは敵自身の損害と、敵が探知している自軍機だけです。';
    return `${sideRow}${blocks || `<div class="ed-empty">${empty}</div>`}
      <div class="ed-row"><button data-edcmd="addtrig">トリガーを足す</button>
        <span class="ed-note">条件がそろったら一度だけ行動します。${note}
          「陣取る」「元に戻す」はその時点で生きている機体にだけ効きます（あとで出る機体には、同じトリガーで「出撃」→「陣取る」の順に書く）</span></div>`;
  }

  /** トリガータブで見ている側の入れ物（`stage.enemy` / `stage.ally`）。`create` で無ければ作る */
  _trigHost(create = false) {
    const s = this.stage;
    const key = this.trigSide === 'ally' ? 'ally' : 'enemy';
    if (create && !s[key]) s[key] = {};
    return s[key] || null;
  }

  /** トリガーの行動が指せる飛行場。敵は `base`/`base2`、友軍は `base`（友軍飛行場）/`home`（共用） */
  _trigBases() {
    const s = this.stage;
    if (this.trigSide === 'ally') {
      return [...((s.ally || {}).base ? ['base'] : []), ...((s.friendly || {}).base ? ['home'] : [])];
    }
    const e = s.enemy || {};
    return ['base', 'base2'].filter((k) => e[k]);
  }

  /** 友軍が持つタグ（友軍機・友軍の増援・友軍のトリガーの出撃）。行動が触れるもの（§102 A2） */
  _allyTags() {
    const al = this.stage.ally || {};
    const set = new Set();
    for (const u of al.aircraft || []) for (const t of u.tags || []) set.add(t);
    for (const r of [al.reinforce, al.base && al.base.reinforce]) for (const t of (r && r.tags) || []) set.add(t);
    for (const t of al.triggers || []) for (const a of t.do || []) if (a.type === 'launch' && a.tag) set.add(a.tag);
    return [...set];
  }

  /** 自軍側（プレイヤー・友軍の地上・支援機・飛行場）のタグ。友軍の条件が読む */
  _friendlyTags() {
    const f = this.stage.friendly || {};
    const set = new Set(['home']);
    if ((this.stage.ally || {}).base) set.add('ally-home');
    for (const u of [...(f.aircraft || []), ...(f.ground || []), ...(f.support || [])]) {
      for (const t of u.tags || []) set.add(t);
    }
    return [...set];
  }

  /** 敵側のタグ。配置・飛行場・増援・トリガーの出撃が付けるものまで（§12.3） */
  /** 動く地上ユニットのタグ（§103）。敵側は敵の、友軍側は友軍（`owner: 'ally'`）の */
  _groundTags(ally) {
    const list = ally ? ((this.stage.friendly || {}).ground || []).filter((g) => g.owner === 'ally')
      : ((this.stage.enemy || {}).ground || []);
    const set = new Set();
    for (const g of list) if (GROUND_TYPES[g.type] && !GROUND_TYPES[g.type].static) for (const t of g.tags || []) set.add(t);
    return [...set];
  }

  _enemyTags() {
    const e = this.stage.enemy || {};
    const set = new Set();
    for (const u of [...(e.aircraft || []), ...(e.ground || [])]) for (const t of u.tags || []) set.add(t);
    for (const k of ['base', 'base2']) {
      const b = e[k];
      if (!b) continue;
      for (const t of b.tags || []) set.add(t);
      for (const t of (b.reinforce && b.reinforce.tags) || []) set.add(t);
    }
    for (const t of e.triggers || []) for (const a of t.do || []) if (a.type === 'launch' && a.tag) set.add(a.tag);
    return [...set];
  }

  /** 条件・行動を足したとき、型を変えたときの既定（§12.3） */
  _trigDefault(kind, type) {
    const ally = this.trigSide === 'ally';
    const e = this._trigHost() || {};
    const tag = (ally ? this._allyTags() : this._enemyTags())[0] || '';
    const base = this._trigBases()[0] || 'base';
    const at = (ally ? (base === 'home' ? (this.stage.friendly || {}).base : e.base) : e[base])
      || { x: MAP_SIZE / 2, z: MAP_SIZE / 2 };
    const near = { x: clampPos(at.x + 6000), z: clampPos(at.z + 6000) };
    if (kind === 'when') {
      switch (type) {
        case 'time': return { type, seconds: 120 };
        case 'destroyed': return { type, tag: ally ? (this._enemyTags()[0] || tag) : tag, count: 0 };
        case 'below': return { type, n: 1 };
        case 'enter': return { type, ...near, r: 8000 };
        case 'fired': return { type, id: ((e.triggers || [])[0] || {}).id || '' };
        default: return { type };
      }
    }
    switch (type) {
      case 'guard': return { type, tag, ...near, alt: GUARD_DEFAULT.agl, r: GUARD_DEFAULT.radius };
      case 'defend': return { type, tag, base };
      case 'restore': return { type, tag };
      case 'launch': return { type, base, aircraft: ally ? 'F-1' : 'J-7', n: 2 };
      case 'reinforce': return { type, base, on: true };
      case 'ground': return { type, tag: this._groundTags(ally)[0] || '', mode: 'advance' };
      default: return { type, text: '' };
    }
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
            value="${esc(s.enemy.skill ?? 1)}"></label>
        </div>`;
    }
    if (this.tab === 'weather') {
      const w = s.weather;
      const cloud = (w && w.cloud) || 'none';
      const on = cloud !== 'none';
      const wind = (w && w.wind) || {};
      const sel = (path, label, opts, cur) =>
        `<label>${label}<select data-ed="${path}">${opts.map((o) =>
          `<option value="${o}"${cur === o ? ' selected' : ''}>${o}</option>`).join('')}</select></label>`;
      if (!on) {
        return `<div class="ed-row">${sel('weather.cloud', '雲量', CLOUD_KINDS, 'none')}
          <span class="ed-note">`
          + '雲量を選ぶと、層の高さと風の欄が出てきます</span></div>';
      }
      // **層の高さが設計の道具**（§88.16）。雲量より効くので、そう書いておく
      return `<div class="ed-row">
          ${sel('weather.cloud', '雲量', CLOUD_KINDS, cloud)}
          <span class="ed-note">覆う割合 ${Math.round((CLOUD_COVER[cloud] ?? 0) * 100)}%</span>
          ${sel('weather.shape', '塊の形', CLOUD_SHAPES, (w && w.shape) || 'puffy')}
          <span class="ed-note">見た目と当たり判定は同じ形です</span>
        </div>
        <div class="ed-row">
          ${num('weather.base', '雲底(m)', 100)}
          ${num('weather.top', '雲頂(m)', 100)}
          <span class="ed-note"><b>層の高さは雲量より効きます</b>（交戦高度に重ねるか、下を通らせるか）</span>
        </div>
        <div class="ed-row">
          <label>風向(度)<input type="number" step="10" data-ed="weather.wind.deg"
            value="${esc(wind.deg ?? '')}" placeholder="乱数"></label>
          <label>風速(m/s)<input type="number" step="1" data-ed="weather.wind.speed"
            value="${esc(wind.speed ?? '')}" placeholder="${CLOUD_WIND_SPEED}"></label>
          <span class="ed-note">吹いてくる方位。空欄なら向きは戦闘ごとの乱数・速さは ${CLOUD_WIND_SPEED}m/s。0 で止まります</span>
        </div>`;
    }
    if (this.tab === 'objectives') {
      // 自軍の目標と敵側の任務（§73）は**同じ形**なので、行の組み立ては1つにする。
      // `attr` だけ変えて書き込み先を分ける。
      const row = (o, i, attr, opts = {}) => `
        <div class="ed-row">
          <select data-${attr}="${i}.type">${custom.OBJECTIVE_TYPES.map((t) =>
            `<option value="${t}"${o.type === t ? ' selected' : ''}>${t}</option>`).join('')}</select>
          <input data-${attr}="${i}.id" value="${esc(o.id)}" size="7" title="内部ID">
          <input data-${attr}="${i}.tag" value="${esc(o.tag)}" size="10" title="タグ">
          <input data-${attr}="${i}.label" value="${esc(o.label)}" size="26" title="画面に出る説明">
          ${o.type === 'survive' ? `<label title="秒数">秒<input type="number" data-${attr}="${i}.seconds"
            value="${esc(o.seconds ?? 300)}" size="5"></label>` : ''}
          ${o.type === 'hold' ? `<label title="これを下回ると失敗">残す数<input type="number"
            data-${attr}="${i}.min" value="${esc(o.min ?? 1)}" size="4"></label>` : ''}
          ${opts.fail === false ? '' : `<label title="入れると「失敗すると負け」。外すと「達成すると勝ち」">失敗条件<input
            type="checkbox" data-${attr}="${i}.fail"${o.fail ? ' checked' : ''}></label>`}
          <button data-edcmd="${opts.del}:${i}" class="ed-del">消す</button>
        </div>`;
      const mine = (s.objectives || []).map((o, i) => row(o, i, 'edobj', { del: 'delobj' })).join('');
      const foe = ((s.enemy && s.enemy.objectives) || [])
        .map((o, i) => row(o, i, 'edfoeobj', { del: 'delfoeobj', fail: false })).join('');
      return `<div class="bf-section">自軍の目標</div>${mine}
        <div class="ed-row"><button data-edcmd="addobj">目標を足す</button>
          <span class="ed-note">destroyAll は敵のタグ、protect・hold・reach は味方のタグを見ます。
            hold は「残す数」を下回ると失敗（protect は1つでも失えば失敗）</span></div>
        <div class="bf-section">敵側の任務（§73）</div>${foe
          || '<div class="ed-empty">書かなければ、敵は陣営としての目標を持ちません（各機が勝手に戦います）</div>'}
        <div class="ed-row"><button data-edcmd="addfoeobj">敵の任務を足す</button>
          <span class="ed-note">敵の司令官AIが「何を壊すか・誰を護るか」を読みます。
            勝敗には出ません</span></div>
        ${this._allyObjectives(row)}`;
    }
    if (this.tab === 'triggers') return this._triggerTab();
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
    // 下敷きの選び直し（§91）。既定は自動判定 ——
    // `basedOn` を持たない古い面でも、名前から拾えることがある
    const auto = stagetext.baseOf(s);
    const cur = this._baseId;
    const opt = (v, label, on) => `<option value="${esc(v)}"${on ? ' selected' : ''}>${esc(label)}</option>`;
    const bases = opt('auto', `自動（${auto ? auto.name : '下敷きなし'}）`, cur == null)
      + opt('', '下敷きなし（全文を出す）', cur === '')
      + stagetext.baseList().map((b) => opt(b.id, `${b.name}（${b.id}）`, cur === b.id)).join('');
    return `${list}
      <div class="ed-row">
        <button data-edcmd="new">白紙から作る</button>
        <button data-edcmd="export">JSONを書き出す</button>
        <button data-edcmd="import">JSONを読み込む</button>
        <button data-edcmd="snippet">stages.js 用のコードを出す</button>
      </div>
      <div class="ed-row">
        <button data-edcmd="outline">要点と差分を出す</button>
        <label>下敷き<select data-edbase>${bases}</select></label>
        ${onDevServer() ? '<button data-edcmd="tofile">ファイルに書き出す</button>' : ''}
        <span class="ed-note">相談するとき用の写し（§91）。下敷きがあれば
          <b>元の面との違いだけ</b>を出します${onDevServer()
            ? '。書き出し先は stages_out/' : '（公開版なので書き出しは出ません）'}</span>
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
    // **下敷きの選択はステージを触っていない**（§91）。
    // ここで抜けないと、出力の宛先を選んだだけで「保存していない編集がある」になる
    if (t.dataset.edbase != null) {
      this._baseId = t.value === 'auto' ? null : t.value;
      return;
    }
    this._dirty = true;
    this._pending = null;
    // **雲量は節ごと出し入れする。** `none` のまま空の `weather` を残すと、
    // 書き出した定義に意味の無い節が混ざる（本体は `cloud` が無ければ雲なし）
    if (t.dataset.ed === 'weather.cloud') {
      if (t.value === 'none') delete this.stage.weather;
      else this.stage.weather = { ...WEATHER_DEFAULT, ...(this.stage.weather || {}), cloud: t.value };
      this._refresh(true);
      return;
    }
    // 風は空欄なら「書かない」。書かないことが**乱数の向き・既定の速さ**という指定になる
    if (t.dataset.ed === 'weather.wind.deg' || t.dataset.ed === 'weather.wind.speed') {
      const key = t.dataset.ed.split('.')[2];
      const w = this.stage.weather;
      if (!w) return;
      if (t.value === '') { if (w.wind) delete w.wind[key]; if (w.wind && !Object.keys(w.wind).length) delete w.wind; }
      else { w.wind = w.wind || {}; w.wind[key] = val(t.value); }
      return;
    }
    if (t.dataset.ed) {
      setPath(this.stage, t.dataset.ed, val(t.value));
      this._draw();
      return;
    }
    if (t.dataset.edsel) {
      const ref = this._selRef();
      if (!ref) return;
      const path = t.dataset.edsel;
      if (path === 'tags') {
        ref.tags = t.value.split(',').map((v) => v.trim()).filter(Boolean);
      } else if (path === 'reinforce.types' || path === 'reinforce.tags') {
        const key = path.split('.')[1];
        const list = t.value.split(',').map((v) => v.trim()).filter(Boolean);
        ref.reinforce = ref.reinforce || {};
        if (list.length) ref.reinforce[key] = list;
        else delete ref.reinforce[key];
        if (key === 'types') delete ref.reinforce.type;   // 言い方を1つに寄せる
        return;
      } else if (path === 'reinforce.first') {
        // **空欄なら「間隔と同じ」**（既定の挙動）。
        // 0 や空文字をそのまま残すと開始と同時に湧いてしまうので、消す。
        ref.reinforce = ref.reinforce || {};
        const v = Number(t.value);
        if (t.value !== '' && v > 0) ref.reinforce.first = v;
        else delete ref.reinforce.first;
        return;
      } else if (path === 'reinforce.after') {
        ref.reinforce = ref.reinforce || {};
        if (t.value) ref.reinforce.after = t.value;
        else delete ref.reinforce.after;
        return;
      } else if (path === 'route') {
        if (t.checked) ref.route = ref.route
          || [{ x: clampPos(ref.x - 8000), z: clampPos(ref.z) }, { x: clampPos(ref.x + 8000), z: clampPos(ref.z) }];
        else delete ref.route;
        this._refresh(true);
        return;
      } else if (path === 'groundMode') {
        if (t.value) ref.groundMode = t.value; else delete ref.groundMode;
        this._draw();
        return;
      } else if (path === 'holdAt' || path === 'retreatTo') {
        // 持ち場・下がる先（§103）。入れたら**いまの位置から少し離して**置く（重なると掴めない）
        const off = path === 'holdAt' ? 2500 : -2500;
        if (t.checked) ref[path] = ref[path] || { x: clampPos(ref.x + off), z: clampPos(ref.z) };
        else delete ref[path];
        this._refresh(true);
        return;
      } else if (path === 'moveTo') {
        // 支援機の行き先。入れたら**いまの位置から少し先**に置く ——
        // 地図の原点に出ると「どこへ飛んだのか」が分からない
        if (t.checked) ref.moveTo = ref.moveTo || { x: clampPos(ref.x + 12000), z: clampPos(ref.z - 12000), alt: 4200 };
        else delete ref.moveTo;
        this._refresh(true);
        return;
      } else if (path === 'owner') {
        // 指揮系統（§102）。書くのは 'ally' のときだけ
        if (t.checked) ref.owner = 'ally'; else delete ref.owner;
        this._draw();
        return;
      } else if (path === 'allyBase') {
        if (t.value === 'home') ref.base = 'home'; else delete ref.base;
        this._draw();
        return;
      } else if (path === 'reinforce') {
        const ally = this.sel && this.sel.kind === 'abase';
        if (t.checked) ref.reinforce = ref.reinforce || { every: 180, max: 4, burst: 1, types: [ally ? 'F-1' : 'J-7'] };
        else delete ref.reinforce;
        this._refresh();
        return;
      } else if (path === 'x' || path === 'z') {
        // **打ち込んだ座標も地図の内側へ丸める。**
        // 掴んで動かす側は丸めていたのに、数値欄は素通しだった。
        ref[path] = clampPos(val(t.value));
      } else {
        setPath(ref, path, val(t.value));
      }
      this._draw();
      return;
    }
    if (t.dataset.edtrig) {
      // トリガー（§12.3）。道は見ている側（`enemy` / `ally`）の `triggers` からの相対
      const host = this._trigHost();
      const list = host && host.triggers;
      if (!list) return;
      const path = t.dataset.edtrig;
      const keys = path.split('.');
      const key = keys[keys.length - 1];
      // 条件・行動の型を変えたら、欄ごと既定に差し替える（前の型の欄を残さない）
      if (key === 'type' && keys.length === 4) {
        const [i, kind, j] = keys;
        list[Number(i)][kind][Number(j)] = this._trigDefault(kind, t.value);
        this._refresh(true);
        return;
      }
      let v = val(t.value);
      if (key === 'on') v = t.value === 'true';
      if (key === 'tag' && keys.length > 2 && v === '') {
        // 「敵の航空機すべて」・出撃のタグなし は欄ごと消す
        const o = getPath(list, keys.slice(0, -1).join('.'));
        if (o) delete o.tag;
      } else if (key === 'attackTag' && v === '') {
        const o = getPath(list, keys.slice(0, -1).join('.'));
        if (o) delete o.attackTag;
      } else setPath(list, path, v);
      // 地上の行動を替えたら欄の組が変わる（攻撃目標のタグ／地点）
      if (key === 'mode') { this._refresh(true); return; }
      this._draw();
      return;
    }
    const objAttr = t.dataset.edobj ? 'edobj' : (t.dataset.edfoeobj ? 'edfoeobj'
      : (t.dataset.edallyobj ? 'edallyobj' : null));
    if (objAttr) {
      const [i, key] = t.dataset[objAttr].split('.');
      const list = objAttr === 'edobj' ? this.stage.objectives
        : objAttr === 'edallyobj' ? (this.stage.ally && this.stage.ally.objectives)
          : (this.stage.enemy && this.stage.enemy.objectives);
      const o = list && list[Number(i)];
      if (!o) return;
      o[key] = (key === 'x' || key === 'z') ? clampPos(val(t.value)) : val(t.value);
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
      this._dirty = true;
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
    // 「もう一度押す」の待ち受けは、別のものを押したら解く
    if (this._pending && this._pending !== op + ':' + (arg || '')) this._pending = null;
    switch (op) {
      case 'exit':
        if (!this._mayDiscard('exit:', '編集を捨てて戻る')) break;
        this.close(); this.onExit?.();
        break;
      case 'del': if (this.sel) this._removeItem(this.sel.kind, this.sel.i); break;
      // 自動配置 ⇄ 指定配置（§71.5）。固定するときは、いま描いている点を写す ——
      // 「押したら別の場所へ飛んだ」と見えないようにするため。
      case 'pin': {
        this._dirty = true;
        const ref = this._selRef();
        const base = s.friendly && s.friendly.base;
        if (!ref || !base || this.sel.kind !== 'fair') break;
        const p = autoStartPos(base, this.sel.i, !!s.friendly.startAirborne);
        ref.x = clampPos(p.x); ref.z = clampPos(p.z);
        this._refresh();
        break;
      }
      case 'unpin': {
        this._dirty = true;
        const ref = this._selRef();
        if (!ref || this.sel.kind !== 'fair') break;
        delete ref.x; delete ref.z;
        this._refresh();
        break;
      }
      case 'reseed':
        s.terrain.seed = 10000 + Math.floor(Math.random() * 89999);
        this._dirty = true;
        this._render();
        break;
      case 'addobj':
        s.objectives = s.objectives || [];
        s.objectives.push({ id: 'obj' + (s.objectives.length + 1), type: 'destroyAll',
          tag: 'target', label: '新しい目標' });
        this._dirty = true;
        this._render();
        break;
      case 'addwp': {
        const ref = this._selRef();
        if (!ref || !ref.route || !ref.route.length) break;
        const last = ref.route[ref.route.length - 1];
        ref.route.push({ x: clampPos(last.x + 4000), z: clampPos(last.z + 4000) });
        this._dirty = true;
        this._refresh(true);
        break;
      }
      case 'addfoeobj': {
        const e = s.enemy = s.enemy || {};
        e.objectives = e.objectives || [];
        e.objectives.push({ id: 'foe' + (e.objectives.length + 1), type: 'destroyAll',
          tag: 'home', label: '自軍飛行場を潰す' });
        this._dirty = true;
        this._render();
        break;
      }
      case 'addallyobj': {
        const al = s.ally = s.ally || {};
        al.objectives = al.objectives || [];
        al.objectives.push({ id: 'ally' + (al.objectives.length + 1), type: 'destroyAll',
          tag: 'target', label: '目標を叩く' });
        this._dirty = true;
        this._render();
        break;
      }
      case 'delallyobj':
        s.ally.objectives.splice(Number(arg), 1);
        // 空の配列は残さない。`main.js` は「書いてあるか」で友軍の司令官を出す
        if (!s.ally.objectives.length) delete s.ally.objectives;
        this._dirty = true;
        this._render();
        break;
      case 'delfoeobj':
        s.enemy.objectives.splice(Number(arg), 1);
        // **空の配列は残さない。** `main.js` は「書いてあるか」で敵司令官を出す
        if (!s.enemy.objectives.length) delete s.enemy.objectives;
        this._dirty = true;
        this._render();
        break;
      case 'trigside':
        this.trigSide = arg === 'ally' ? 'ally' : 'enemy';
        this._render();
        break;
      case 'addtrig': {
        const e = this._trigHost(true);
        e.triggers = e.triggers || [];
        let n = e.triggers.length + 1;
        while (e.triggers.some((t) => t.id === 'trig' + n)) n++;
        e.triggers.push({ id: 'trig' + n, label: '', match: 'all',
          when: [this._trigDefault('when', 'destroyed')], do: [this._trigDefault('do', 'defend')] });
        this._dirty = true;
        this._refresh(true);
        break;
      }
      case 'deltrig': {
        const e = this._trigHost();
        e.triggers.splice(Number(arg), 1);
        // **空の配列は残さない**（敵の任務と同じ）
        if (!e.triggers.length) delete e.triggers;
        this.sel = null;
        this._dirty = true;
        this._refresh(true);
        break;
      }
      case 'addcond':
      case 'addact': {
        const t = this._trigHost().triggers[Number(arg)];
        const kind = op === 'addcond' ? 'when' : 'do';
        t[kind] = t[kind] || [];
        t[kind].push(this._trigDefault(kind, op === 'addcond' ? 'time' : 'notice'));
        this._dirty = true;
        this._refresh(true);
        break;
      }
      case 'trgpt': {
        // 地上の行動の地点（§103）を置く／外す。置くときは**そのタグの地上部隊の近く**へ
        const [i, j] = arg.split('.').map(Number);
        const a = this._trigHost().triggers[i].do[j];
        if (a.x != null) { delete a.x; delete a.z; } else {
          const ally = this.trigSide === 'ally';
          const list = ally ? ((s.friendly || {}).ground || []) : ((s.enemy || {}).ground || []);
          const g = list.find((u) => (u.tags || []).includes(a.tag)) || { x: MAP_SIZE / 2, z: MAP_SIZE / 2 };
          a.x = clampPos(g.x + (a.mode === 'retreat' ? -3000 : 3000));
          a.z = clampPos(g.z);
        }
        this._dirty = true;
        this._refresh(true);
        break;
      }
      case 'delcond':
      case 'delact': {
        const [i, j] = arg.split('.').map(Number);
        this._trigHost().triggers[i][op === 'delcond' ? 'when' : 'do'].splice(j, 1);
        this.sel = null;
        this._dirty = true;
        this._refresh(true);
        break;
      }
      case 'delobj':
        s.objectives.splice(Number(arg), 1);
        this._dirty = true;
        this._render();
        break;
      case 'new':
        if (!this._mayDiscard('new:', '白紙から作り直す')) break;
        this.open(custom.blankStage());
        break;
      case 'load': {
        if (!this._mayDiscard('load:' + arg, 'そちらを開く')) break;
        const c = custom.getCustom(arg);
        if (c) this.open(c);
        break;
      }
      case 'dup': {
        if (!this._mayDiscard('dup:' + arg, '複製を開く')) break;
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
      case 'outline': this._out(this._outline(), '要点（下敷きがあれば差分）。このまま貼れば読めます'); break;
      case 'tofile': this._toFile(); break;
      case 'import': this._import(); break;
      default: break;
    }
  }

  /** いま選ばれている下敷き。`null` は「下敷き無し」、未選択なら自動判定 */
  _base() {
    if (this._baseId === '') return null;
    if (this._baseId) return stagetext.baseById(this._baseId);
    return stagetext.baseOf(this.stage);
  }

  /**
   * 相談用の写し（§91）。**下敷きの面に §47 の上書きが載っていたら注記する** ——
   * 載ったままだと、差分は「調整後の値との違い」になる。
   */
  _outline() {
    const base = this._base();
    return stagetext.outline(this.stage, base, { baseTuned: !!base && isTuned(base.id) });
  }

  /**
   * 開発サーバのときだけ、写しと定義をファイルに落とす（§91）。
   *
   * **エディタの面は localStorage の中にあり、開発側からは読めない。**
   * 画面から拾ってコピーする道は残したうえで、手元で遊んでいるときは
   * そのままファイルに落ちるようにしておく。
   */
  async _toFile() {
    const s = this.stage;
    // 日本語の名前はファイル名に残らない。**id を必ず付ける**ので衝突はしない
    const slug = String(s.name || 'stage').toLowerCase().replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'stage';
    const name = `${slug}-${s.id}`;
    const put = (ext, body, type) => fetch(`/stage/${name}.${ext}`, {
      method: 'POST', headers: { 'Content-Type': type }, body,
    });
    try {
      const [a, b] = await Promise.all([
        put('txt', this._outline(), 'text/plain; charset=utf-8'),
        put('json', custom.toJSON(s), 'application/json'),
      ]);
      if (!a.ok || !b.ok) { this._say(`書き出せませんでした（${a.status} / ${b.status}）`, 'bad'); return; }
      this._say(`stages_out/${name}.txt と ${name}.json に書き出しました`, 'ok');
    } catch (err) {
      this._say('書き出せませんでした（開発サーバが要ります）', 'bad');
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

  /**
   * 検証して結果を出す。`fatal` があれば false。
   *
   * @param {string} lead 先頭に添える一言（何をしようとして止まったのか）
   */
  _check(lead = '') {
    const v = custom.validate(this.stage);
    const parts = [];
    // **何が悪いのかを消さない。**
    //
    // 以前は結果を出したあとに `_say('…上の ✕ を直してください')` で
    // **その一覧を上書き**していた。読めと言っている当のものが消えるので、
    // 何を直せばよいのか分からなかった。**前置きとして混ぜる。**
    if (lead) parts.push(`<span class="ed-bad">${esc(lead)}</span>`);
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
    if (!this._check('保存しません:')) return;
    const res = custom.save(this.stage);
    if (!res.ok) { this._say(res.why, 'bad'); return; }
    this._dirty = false;
    this._pending = null;
    this._say(`保存しました（${this.stage.id}）`, 'ok');
  }

  _playtest() {
    if (!this._check('試遊できません:')) return;
    // **保存に失敗したら試遊しない**（§66.9）。試遊から戻るときに開き直すのは
    // 保管庫の側なので、保存が落ちていると**編集内容が消える。**
    const res = custom.save(this.stage);
    if (!res.ok) { this._say(`${res.why}（試遊を中止しました）`, 'bad'); return; }
    const stage = structuredClone(this.stage);
    this.close();
    this.onPlaytest?.(stage);
  }
}
