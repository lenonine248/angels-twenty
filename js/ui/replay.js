// 3Dリプレイ再生。仕様書 §23.4。
//
// 記録（core/recorder.js）を3D側へ流し込む。**記録を読むだけ**で、
// シミュレーションは一切動かさない。だから終わった戦闘でも、
// 別のブラウザで作られた記録ファイルでも同じように再生できる。
//
// 動画ではないので、**カメラは自由**。寄る・回す・止める・巻き戻すができる。
// 逆に「そこから自分でやり直す」はできない。状態記録だから（§23.1）。
//
// 記録に無いものは**引き出す**。
//   ピッチ … 高度の変化と水平移動から
//   バンク … 方位の変化率から
//   接地   … 対地高度から
// 記録に持たせても良かったが、姿勢はサンプル間隔(0.5秒)では滑らかにならず、
// どのみち補間で作ることになる。ならば持たないほうが記録が軽い。

import * as THREE from 'three';
import { Terrain } from '../world/terrain.js';
import {
  createAircraftView, syncAircraftView, aircraftDisplayLength,
  createGroundView, syncGroundView, groundDisplayScale,
} from '../world/models.js';
import { getType } from '../data/aircraft.js';
import { getGroundType } from '../data/ground.js';
import { flattenRunway } from '../sim/airbase.js';

/** 再生できる速さ */
const SPEEDS = [0.5, 1, 2, 4, 8];
/** バンク角の上限 */
const MAX_ROLL = 1.1;
/** 方位の変化率(rad/s)をこの値で割ってバンクにする */
const ROLL_PER_RATE = 0.55;
/** 接地とみなす対地高度(m) */
const GROUND_AGL = 30;

export class ReplayPlayer {
  /**
   * @param {HTMLElement} bar 操作パネルの置き場
   * @param {object} scene SceneManager
   */
  constructor(bar, scene) {
    this.bar = bar;
    this.scene = scene;
    this.data = null;
    this.terrain = null;
    this.units = [];
    this.time = 0;
    this.speed = 1;
    this.playing = true;
    /** 追いかける機体（null なら自由） */
    this.followId = null;

    /** 時間のつまみを掴んでいるあいだ true。掴んでいる間はパネルを作り直さない */
    this._dragging = false;

    this._onClick = (e) => this._click(e);
    this._onInput = (e) => this._input(e);
    this._onChange = (e) => this._change(e);
    this._onKey = (e) => this._key(e);
    this._lastBarKey = null;
  }

  get isOpen() { return !!this.data; }
  get duration() {
    const s = this.data.samples;
    return s.length ? s[s.length - 1].t : 0;
  }

  // -------------------------------------------------------------- 開閉

  open(data) {
    this.data = data;
    this.time = 0;
    this.speed = 1;
    this.playing = true;
    this.followId = null;

    this.terrain = new Terrain(data.stage.terrain);
    // 飛行場のまわりは、戦闘のときと同じように**地形を作る前に**均す。
    // 均さないと滑走路が斜面に乗り、駐機中の機体が路面から浮く／埋まる。
    // 位置・向き・標高は記録に入っているので、そのまま使える。
    const first = data.samples[0];
    if (first) {
      for (const u of data.units) {
        if (u.kind !== 'airbase') continue;
        for (let k = 0; k < first.u.length; k += 6) {
          if (first.u[k] !== u.id) continue;
          flattenRunway(this.terrain, first.u[k + 1], first.u[k + 3],
            (first.u[k + 4] * Math.PI) / 180, first.u[k + 2]);
          break;
        }
      }
    }
    this.scene.reset();
    this.scene.setTerrain(this.terrain);
    this.scene.add(this.terrain.buildMesh());

    // 名簿から表示物を作る。位置はこのあと毎フレーム入れ替える。
    this.units = [];
    for (const u of data.units) {
      const ghost = {
        id: u.id, name: u.name, side: u.side, kind: u.kind,
        pos: new THREE.Vector3(), heading: 0, pitch: 0, roll: 0,
        alive: false, onGround: false, view: null,
        spec: u.kind === 'aircraft' ? safeType(u.type) : safeGround(u.type),
      };
      if (!ghost.spec) continue;             // 知らない型は飛ばす（記録が新しすぎる）
      ghost.view = u.kind === 'aircraft' ? createAircraftView(ghost) : createGroundView(ghost);
      this.scene.add(ghost.view);
      this.units.push(ghost);
    }

    // 最初の自軍機へ寄せる
    const lead = this.units.find((u) => u.side === 'blue' && u.kind === 'aircraft');
    if (lead) {
      const s = this._stateAt(0);
      const st = s.get(lead.id);
      if (st) this.scene.rig.lookAtPoint(st.x, st.z);
    }

    this.bar.classList.remove('hidden');
    this.bar.addEventListener('click', this._onClick);
    this.bar.addEventListener('input', this._onInput);
    this.bar.addEventListener('change', this._onChange);
    // 戦闘中と同じく Space で止める／動かす。操作を覚え直させない
    window.addEventListener('keydown', this._onKey);
    this._lastBarKey = null;
    this._apply(0);
    this._renderBar(true);
  }

  close() {
    this.bar.classList.add('hidden');
    this.bar.removeEventListener('click', this._onClick);
    this.bar.removeEventListener('input', this._onInput);
    this.bar.removeEventListener('change', this._onChange);
    window.removeEventListener('keydown', this._onKey);
    this._dragging = false;
    this.bar.innerHTML = '';
    this.scene.reset();
    this.units = [];
    this.data = null;
    this.terrain = null;
    if (this.onClose) this.onClose();
  }

  // -------------------------------------------------------------- 操作

  _click(e) {
    const t = e.target.closest('[data-rp]');
    if (!t) return;
    const act = t.dataset.rp;
    if (act === 'close') { this.close(); return; }
    if (act === 'play') { this.playing = !this.playing; this._renderBar(true); return; }
    if (act === 'speed') { this.speed = Number(t.dataset.v); this._renderBar(true); return; }
    if (act === 'jump') { this._seek(this.time + Number(t.dataset.v)); this._renderBar(true); return; }
    if (act === 'follow') {
      const id = Number(t.dataset.id);
      this.followId = this.followId === id ? null : id;
      this._renderBar(true);
    }
  }

  /**
   * つまみを動かしている最中。
   *
   * **ここでパネルを組み直してはいけない。** `innerHTML` を入れ替えると
   * 掴んでいた `<input>` ごと作り直されるので、その場でドラッグが切れる。
   * 動かせるのは1目盛りずつ、という状態になっていた。
   */
  _input(e) {
    if (e.target.dataset.rp !== 'time') return;
    this._dragging = true;
    this.playing = false;
    this._seek(Number(e.target.value));
    this._lightBar();
  }

  /** つまみを離した。ここで初めて組み直す */
  _change(e) {
    if (e.target.dataset.rp !== 'time') return;
    this._dragging = false;
    this._renderBar(true);
  }

  _key(e) {
    if (!this.data) return;
    if (e.target && /INPUT|TEXTAREA/.test(e.target.tagName)) return;
    if (e.code !== 'Space') return;
    e.preventDefault();
    e.stopPropagation();
    this.playing = !this.playing;
    this._renderBar(true);
  }

  _seek(t) {
    this.time = Math.max(0, Math.min(this.duration, t));
    this._apply(this.time);
  }

  // -------------------------------------------------------------- 毎フレーム

  /** main.js の render から呼ぶ（実時間） */
  update(realDt) {
    if (!this.data) return;
    if (this.playing) {
      this.time += realDt * this.speed;
      if (this.time >= this.duration) { this.time = this.duration; this.playing = false; }
    }
    this._apply(this.time);
    this._renderBar(false);
  }

  /**
   * その時刻の状態を作って表示へ流す。
   * 間隔(0.5秒)のあいだは補間する。補間しないと 2Hz のコマ送りになる。
   */
  _apply(t) {
    const cur = this._stateAt(t);
    // 姿勢はこの少しあとの状態との差から作る
    const AHEAD = 0.35;
    const nxt = this._stateAt(Math.min(this.duration, t + AHEAD));

    const size = aircraftDisplayLength(this.scene.rig.distance, this.scene.camera);
    for (const u of this.units) {
      const s = cur.get(u.id);
      u.alive = !!s;
      if (!s) { if (u.view) u.view.visible = false; continue; }

      u.pos.set(s.x, s.y, s.z);
      u.heading = s.h;

      const ground = Math.max(0, this.terrain.heightAt(s.x, s.z));
      u.onGround = u.kind !== 'aircraft' || (s.y - ground) < GROUND_AGL;

      if (u.kind === 'aircraft') {
        const n = nxt.get(u.id);
        if (n) {
          const flat = Math.hypot(n.x - s.x, n.z - s.z);
          u.pitch = Math.atan2(n.y - s.y, Math.max(1, flat));
          const dh = angleDiff(n.h, s.h) / AHEAD;         // rad/s
          u.roll = clamp(dh * ROLL_PER_RATE, -MAX_ROLL, MAX_ROLL);
        } else {
          u.pitch = 0; u.roll = 0;
        }
        syncAircraftView(u, this.terrain, size, this.followId === u.id, true);
      } else {
        syncGroundView(u, groundDisplayScale(this.scene.rig.distance, this.scene.camera,
          u.spec.size || 120), true);
      }
    }

    // 追尾中の機体へカメラを寄せる
    if (this.followId != null) {
      const s = cur.get(this.followId);
      if (s) {
        this.scene.rig.lookAtPoint(s.x, s.z);
        const ground = Math.max(0, this.terrain.heightAt(s.x, s.z));
        this.scene.rig.focusAltTarget = Math.min(7000, Math.max(400, s.y - ground));
      }
    }
  }

  /** 時刻 t の各ユニットの状態。id -> {x,y,z,h,hp} */
  _stateAt(t) {
    const out = new Map();
    const S = this.data.samples;
    if (!S.length) return out;

    // 二分探索。つまみを動かすと毎フレーム呼ばれるので、線形に探すと重い
    let lo = 0, hi = S.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (S[mid].t <= t) lo = mid; else hi = mid - 1;
    }
    const a = S[lo];
    const b = S[Math.min(S.length - 1, lo + 1)];
    const span = b.t - a.t;
    const k = span > 0 ? clamp((t - a.t) / span, 0, 1) : 0;

    const bm = new Map();
    for (let i = 0; i < b.u.length; i += 6) {
      bm.set(b.u[i], [b.u[i + 1], b.u[i + 2], b.u[i + 3], b.u[i + 4], b.u[i + 5]]);
    }
    for (let i = 0; i < a.u.length; i += 6) {
      const id = a.u[i];
      const ax = a.u[i + 1], ay = a.u[i + 2], az = a.u[i + 3];
      const ah = (a.u[i + 4] * Math.PI) / 180, ahp = a.u[i + 5];
      const nb = bm.get(id);
      if (!nb) {
        // 次のサンプルにいない＝この区間で落ちた。最後の位置で止める
        out.set(id, { x: ax, y: ay, z: az, h: ah, hp: ahp });
        continue;
      }
      const bh = (nb[3] * Math.PI) / 180;
      out.set(id, {
        x: ax + (nb[0] - ax) * k,
        y: ay + (nb[1] - ay) * k,
        z: az + (nb[2] - az) * k,
        h: ah + angleDiff(bh, ah) * k,     // 近いほうへ回す（±180°の折り返し対策）
        hp: ahp + (nb[4] - ahp) * k,
      });
    }
    return out;
  }

  // -------------------------------------------------------------- 操作パネル

  /** 時計とつまみだけ動かす（組み直さない） */
  _lightBar() {
    const cl = this.bar.querySelector('.rp-clock');
    if (cl) cl.textContent = `${fmt(this.time)} / ${fmt(this.duration)}`;
    if (this._dragging) return;          // つまみはプレイヤーが握っている
    const sl = this.bar.querySelector('[data-rp="time"]');
    if (sl) sl.value = String(this.time);
  }

  _renderBar(force) {
    // 掴んでいるあいだは何があっても組み直さない
    if (this._dragging) { this._lightBar(); return; }
    // つまみと時計以外は変わらないので、変わったときだけ組み直す
    const key = `${this.playing}|${this.speed}|${this.followId}`;
    if (!force && key === this._lastBarKey) { this._lightBar(); return; }
    this._lastBarKey = key;

    const sp = SPEEDS.map((v) => `<button data-rp="speed" data-v="${v}"
      class="${this.speed === v ? 'on' : ''}">x${v}</button>`).join('');
    const follow = this.data.units.filter((u) => u.kind === 'aircraft')
      .map((u) => `<button data-rp="follow" data-id="${u.id}"
        class="rp-unit ${this.followId === u.id ? 'on' : ''} side-${u.side}">${u.name}</button>`).join('');

    this.bar.innerHTML = `
      <div class="rp-row rp-top">
        <span class="rp-title">REPLAY — ${this.data.stage.name}</span>
        <span class="rp-hint">Space 再生／一時停止 / WASD 視点移動 / QE 旋回 / RF 仰角 / ホイール 拡大</span>
        <button data-rp="close" class="rp-close">閉じる</button>
      </div>
      <div class="rp-row">
        <button data-rp="play" class="rp-play">${this.playing ? '❚❚' : '▶'}</button>
        <button data-rp="jump" data-v="-10">◀ 10秒</button>
        <button data-rp="jump" data-v="10">10秒 ▶</button>
        <span class="rp-clock">${fmt(this.time)} / ${fmt(this.duration)}</span>
        <input type="range" data-rp="time" min="0" max="${this.duration}" step="0.1" value="${this.time}">
        <span class="rp-speeds">${sp}</span>
      </div>
      <div class="rp-row rp-follow"><label>追尾</label>${follow}</div>`;
  }
}

function safeType(id) { try { return getType(id); } catch (e) { return null; } }
function safeGround(id) { try { return getGroundType(id); } catch (e) { return null; } }

function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

/** -PI..PI に畳んだ角度差 */
function angleDiff(a, b) {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

function fmt(sec) {
  const s = Math.max(0, Math.round(sec));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
