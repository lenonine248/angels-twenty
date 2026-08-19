// ユニットの選択と指示。
// 仕様 §10.1 の「RTS標準操作」を担当する（リストパネル側は ui/hud.js）。
//
// ピック方式について:
//   地形メッシュは13万ポリゴンあり Raycaster では重いため、
//   地面のピックはハイトマップに沿ってレイマーチする独自実装を使う。
//   ユニットのピックは画面座標での最近傍探索（RTSではこちらの方が掴みやすい）。

import * as THREE from 'three';
import { clamp } from '../core/rng.js';
import { Formation } from '../ai/formation.js';
import { getLabelMaterial } from '../world/models.js';
import { WEAPONS } from '../data/weapons.js';
import { effectiveMissileRange } from '../core/atmosphere.js';
import { estimateHitChance, hitLabel } from '../sim/combat.js';

const PICK_RADIUS_PX = 26;
const DRAG_THRESHOLD_PX = 6;

export class CommandController {
  constructor({ canvas, camera, world, sceneRoot }) {
    this.canvas = canvas;
    this.camera = camera;
    this.world = world;
    this.selection = [];
    this.groups = new Map();
    this.hoverUnit = null;

    this._dragStart = null;
    this._dragNow = null;
    this._selBox = document.getElementById('selBox');

    this.paths = new OrderPathRenderer();
    sceneRoot.add(this.paths.object);

    this._bind();
  }

  /** ステージを切り替えるとき、同じコントローラを新しいワールドへ繋ぎ替える */
  setWorld(world) {
    this.world = world;
    this.selection = [];
    this.groups.clear();
    this.hoverUnit = null;
  }

  // ------------------------------------------------------------ 入力

  _bind() {
    const c = this.canvas;

    c.addEventListener('mousedown', (e) => {
      if (e.button === 0) {
        this._dragStart = { x: e.clientX, y: e.clientY, shift: e.shiftKey };
        this._dragNow = { x: e.clientX, y: e.clientY };
      } else if (e.button === 2) {
        this._issueOrderAt(e.clientX, e.clientY, e.shiftKey);
      }
    });

    window.addEventListener('mousemove', (e) => {
      if (this._dragStart) {
        this._dragNow = { x: e.clientX, y: e.clientY };
        this._updateSelBox();
      }
      this.hoverUnit = this._unitAtScreen(e.clientX, e.clientY, null);
      this._updateHoverInfo(e.clientX, e.clientY);
    });

    window.addEventListener('mouseup', (e) => {
      if (e.button !== 0 || !this._dragStart) return;
      const s = this._dragStart, n = this._dragNow;
      const dist = Math.hypot(n.x - s.x, n.y - s.y);
      if (dist < DRAG_THRESHOLD_PX) this._clickSelect(n.x, n.y, s.shift);
      else this._boxSelect(s, n, s.shift);
      this._dragStart = null;
      this._updateSelBox();
    });

    window.addEventListener('keydown', (e) => {
      if (e.target && /INPUT|TEXTAREA/.test(e.target.tagName)) return;

      // 編隊: Ctrl+数字で登録、数字で呼び出し
      if (/^Digit[1-9]$/.test(e.code)) {
        const n = e.code.slice(5);
        if (e.ctrlKey) {
          this.groups.set(n, this.selection.slice());
        } else {
          const g = (this.groups.get(n) || []).filter((u) => u.alive);
          if (g.length) this.select(g);
        }
        e.preventDefault();
        return;
      }

      switch (e.code) {
        case 'Escape':
          // 何も選択していなければメニューを開く
          if (this.selection.length) this.select([]);
          else window.dispatchEvent(new CustomEvent('at:menu'));
          break;
        case 'Tab':    e.preventDefault(); this._cycleSelect(e.shiftKey ? -1 : 1); break;
        case 'KeyZ':   this.adjustAltitude(-500); break;
        case 'KeyX':   this.adjustAltitude(+500); break;
        case 'KeyC':   this.centerOnSelection(); break;
        case 'KeyB':   this.orderRtb(); break;
        case 'KeyG':   e.shiftKey ? this.disbandFormation() : this.makeFormation(); break;
        default: break;
      }
    });
  }

  /**
   * カーソル先のユニットまでの直線距離を出す。
   * 「今から撃てるか／追いつけるか」を判断するのに、距離が読めないと話にならない。
   */
  _updateHoverInfo(px, py) {
    const box = document.getElementById('hoverInfo');
    if (!box) return;
    const u = this.hoverUnit;
    if (!u || !u.alive) { box.classList.add('hidden'); return; }

    const det = this.world.detection;
    const contact = u.side === this.world.playerSide
      ? null : det && det.contactsFor(this.world.playerSide).get(u.id);
    if (u.side !== this.world.playerSide && !contact) { box.classList.add('hidden'); return; }

    // 識別段階に応じて出せる情報を変える
    const detailed = !contact || (contact.level >= 2);
    const identified = !contact || contact.level >= 1;
    const name = !identified ? 'UNKNOWN' : u.name;

    const rows = [`<b>${name}</b>`];
    const pos = contact ? contact.pos : u.pos;
    if (u.kind === 'aircraft') {
      rows.push(`高度 ${(pos.y / 1000).toFixed(1)}km`);
      if (detailed) rows.push(`速度 ${Math.round(contact ? contact.speed : u.speed)}m/s`);
    }

    // 選択中の機体からの直線距離（最も近い1機）
    let best = null;
    for (const s of this.selection) {
      const d = s.pos.distanceTo(pos);
      if (!best || d < best.d) best = { d, u: s };
    }
    if (best) {
      rows.push(`<span class="hi-dist">${best.u.name} から ${(best.d / 1000).toFixed(1)}km</span>`);

      // 指定中の兵装（無ければ最も安い使用可能兵装）での命中期待度
      if (u.side !== this.world.playerSide) {
        const wid = best.u.selectedWeapon
          || best.u.loadout.find((id) => {
            const w = WEAPONS[id];
            return w && (u.kind === 'aircraft' ? w.kind === 'aam' : w.kind !== 'aam');
          });
        if (wid) {
          const p = estimateHitChance(best.u, u, WEAPONS[wid]);
          const l = hitLabel(p);
          rows.push(`<span class="hi-hit ${l.cls}">${wid} 命中期待 ${l.text}</span>`);
        }
      }
    }

    box.innerHTML = rows.join(' / ');
    box.style.left = `${px + 16}px`;
    box.style.top = `${py + 16}px`;
    box.classList.remove('hidden');
  }

  // ------------------------------------------------------------ 選択

  select(units) {
    const next = units.filter((u) => u.alive);
    // 選択から外れた機体の兵装指定は解除する。
    // 残したままだと、次にその機体を選んだとき身に覚えのない兵装が指定されている。
    for (const u of this.selection) {
      if (!next.includes(u)) u.selectedWeapon = null;
    }
    this.selection = next;
  }

  toggle(unit) {
    const i = this.selection.indexOf(unit);
    if (i >= 0) { this.selection.splice(i, 1); unit.selectedWeapon = null; }
    else this.selection.push(unit);
  }

  isSelected(unit) { return this.selection.includes(unit); }

  _clickSelect(px, py, additive) {
    const u = this._unitAtScreen(px, py, this.world.playerSide);
    // 指示できるのは航空機だけ（飛行場はロースター/パネルから操作する）
    if (u && u.kind !== 'aircraft') { if (!additive) this.select([]); return; }
    if (!u) { if (!additive) this.select([]); return; }
    if (additive) this.toggle(u);
    else this.select([u]);
  }

  _boxSelect(a, b, additive) {
    const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x);
    const y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
    const hit = [];
    for (const u of this.world.units) {
      if (!u.alive || u.side !== this.world.playerSide || u.kind !== 'aircraft') continue;
      const s = this._project(u.pos);
      if (!s) continue;
      if (s.x >= x0 && s.x <= x1 && s.y >= y0 && s.y <= y1) hit.push(u);
    }
    if (additive) for (const u of hit) if (!this.isSelected(u)) this.selection.push(u);
    else this.select(hit);
  }

  _cycleSelect(dir) {
    const mine = this.world.units.filter(
      (u) => u.alive && u.side === this.world.playerSide && u.kind === 'aircraft');
    if (!mine.length) return;
    const cur = this.selection.length === 1 ? mine.indexOf(this.selection[0]) : -1;
    const next = ((cur + dir) % mine.length + mine.length) % mine.length;
    this.select([mine[next]]);
  }

  centerOnSelection() {
    if (!this.selection.length || !this.world.rig) return;
    let x = 0, z = 0;
    for (const u of this.selection) { x += u.pos.x; z += u.pos.z; }
    this.world.rig.lookAtPoint(x / this.selection.length, z / this.selection.length);
  }

  // ------------------------------------------------------------ 指示

  _issueOrderAt(px, py, append) {
    if (!this.selection.length) return;

    const target = this._unitAtScreen(px, py, null);
    if (target && target.side !== this.world.playerSide) {
      for (const u of this.selection) {
        if (u === target) continue;
        if (u.selectedWeapon) {
          // 兵装を指定しているときは「その兵装で撃て」という射撃指示。
          // 機体の攻撃目標そのものは変えない。
          if (!u.loadout.includes(u.selectedWeapon)) continue;
          u.fireTasks.push({ weapon: u.selectedWeapon, target });
          this.world.log?.(`${u.name} ${u.selectedWeapon} → ${target.name} 射撃指示`);
        } else {
          // player:true の指示はAIが上書きしない（回避と燃料切れを除く）
          u.setOrder({ type: 'attack', target, player: true }, append);
        }
      }
      return;
    }
    if (target && target.side === this.world.playerSide) {
      let slot = 1;
      for (const u of this.selection) {
        if (u === target) continue;
        u.setOrder({ type: 'follow', target, slot: slot++, player: true }, append);
      }
      return;
    }

    const p = this._groundAtScreen(px, py);
    if (!p) return;

    // 編隊がまるごと選択されていれば、リーダーに指示して僚機は追従させる
    const formation = this._selectedFormation();
    if (formation && !append) {
      const leader = formation.leader;
      formation.issue({ type: 'move', x: p.x, z: p.z, alt: leader.order?.alt ?? leader.desiredAlt });
      for (const u of formation.members) {
        u.patrolArea = { x: p.x, z: p.z, alt: leader.desiredAlt, radius: 4500 };
      }
      return;
    }
    // 複数機は目標点の周囲に散らす（同一点に殺到しないように）
    const n = this.selection.length;
    let i = 0;
    for (const u of this.selection) {
      const ang = (i / Math.max(1, n)) * Math.PI * 2;
      const spread = n > 1 ? 700 + n * 90 : 0;
      i++;
      const tx = clamp(p.x + Math.cos(ang) * spread, 0, this.world.mapSize);
      const tz = clamp(p.z + Math.sin(ang) * spread, 0, this.world.mapSize);
      u.setOrder({ type: 'move', x: tx, z: tz, alt: u.order?.alt ?? u.desiredAlt, player: true }, append);
      // 到達後の待機・哨戒もそこで行う
      u.patrolArea = { x: tx, z: tz, alt: u.order?.alt ?? u.desiredAlt, radius: 4500 };
    }
  }

  /** 選択中の機体（最大4機）で編隊を組む */
  makeFormation() {
    const members = this.selection.filter((u) => u.kind === 'aircraft' && u.alive).slice(0, 4);
    if (members.length < 2) return;
    const f = new Formation(members);
    this.world.formations.push(f);
    f.setMode('COORDINATE');
    this.world.log?.(`${f.name} 編成（${members.map((m) => m.name).join(', ')}）`);
  }

  /** 選択機が属する編隊を解散する */
  disbandFormation() {
    const seen = new Set();
    for (const u of this.selection) {
      if (!u.formation || seen.has(u.formation)) continue;
      seen.add(u.formation);
      const f = u.formation;
      for (const m of f.members.slice()) f.remove(m);
      this.world.log?.(`${f.name} 解散`);
    }
    this.world.formations = this.world.formations.filter((f) => f.members.length > 0);
  }

  /** 選択が編隊とちょうど一致していればその編隊を返す */
  _selectedFormation() {
    const f = this.selection[0] && this.selection[0].formation;
    if (!f) return null;
    if (this.selection.length !== f.members.length) return null;
    return this.selection.every((u) => u.formation === f) ? f : null;
  }

  /** 選択機を最寄りの自軍飛行場へ帰投させる */
  orderRtb() {
    for (const u of this.selection) {
      if (u.onGround || !u.nearestBase) continue;
      const ab = u.nearestBase(this.world);
      if (ab) u.setOrder({ type: 'rtb', airbase: ab });
    }
  }

  adjustAltitude(delta) {
    for (const u of this.selection) {
      const base = u.order?.alt ?? u.desiredAlt;
      const alt = clamp(base + delta, 300, u.spec.ceiling);
      if (u.order) u.order.alt = alt;
      for (const q of u.queue) q.alt = alt;
      u.desiredAlt = alt;
    }
  }

  setAltitude(alt) {
    for (const u of this.selection) {
      const a = clamp(alt, 300, u.spec.ceiling);
      if (u.order) u.order.alt = a;
      for (const q of u.queue) q.alt = a;
      u.desiredAlt = a;
    }
  }

  // ------------------------------------------------------------ ピック

  /** ワールド座標 → 画面座標(px)。カメラ後方なら null。 */
  _project(v3) {
    const p = _tmpVec.copy(v3).project(this.camera);
    if (p.z > 1) return null;
    return {
      x: (p.x * 0.5 + 0.5) * window.innerWidth,
      y: (-p.y * 0.5 + 0.5) * window.innerHeight,
    };
  }

  /** 画面座標に最も近いユニット。side を指定するとその陣営に限定。 */
  _unitAtScreen(px, py, side) {
    let best = null, bestD = PICK_RADIUS_PX;
    for (const u of this.world.units) {
      if (!u.alive) continue;
      if (side && u.side !== side) continue;
      if (!this.world.isVisibleToPlayer(u)) continue;
      // 敵は「探知した位置」で掴む（逆探知だけの目標は真の位置とずれている）
      const s = this._project(this.world.displayPosOf(u));
      if (!s) continue;
      const d = Math.hypot(s.x - px, s.y - py);
      if (d < bestD) { bestD = d; best = u; }
    }
    return best;
  }

  /** 画面座標 → 地形上のワールド座標 */
  _groundAtScreen(px, py) {
    const ndc = new THREE.Vector2(
      (px / window.innerWidth) * 2 - 1,
      -(py / window.innerHeight) * 2 + 1,
    );
    _raycaster.setFromCamera(ndc, this.camera);
    return raycastTerrain(_raycaster.ray.origin, _raycaster.ray.direction, this.world.terrain);
  }

  // ------------------------------------------------------------ 表示

  _updateSelBox() {
    const box = this._selBox;
    if (!box) return;
    if (!this._dragStart) { box.style.display = 'none'; return; }
    const s = this._dragStart, n = this._dragNow;
    if (Math.hypot(n.x - s.x, n.y - s.y) < DRAG_THRESHOLD_PX) { box.style.display = 'none'; return; }
    box.style.display = 'block';
    box.style.left = Math.min(s.x, n.x) + 'px';
    box.style.top = Math.min(s.y, n.y) + 'px';
    box.style.width = Math.abs(n.x - s.x) + 'px';
    box.style.height = Math.abs(n.y - s.y) + 'px';
  }

  /** 毎フレーム: 指示経路の線・距離ラベル・射程円を更新 */
  update(camera) {
    this.selection = this.selection.filter((u) => u.alive);
    this.paths.rebuild(this.selection, this.world.terrain, camera, this.world);
  }
}

// ---------------------------------------------------------------- 地形レイキャスト

const _tmpVec = new THREE.Vector3();
const _raycaster = new THREE.Raycaster();
const _p = new THREE.Vector3();

/**
 * 視線を地形に沿って進め、最初に地表を割った点を返す。
 * 地表からの高さに比例した可変ステップで進む（球面トレースと同じ考え方）。
 */
export function raycastTerrain(origin, dir, terrain, maxDist = 300000) {
  let t = 0, prevT = 0, prevD = null;
  for (let i = 0; i < 400; i++) {
    _p.copy(dir).multiplyScalar(t).add(origin);
    const ground = Math.max(0, terrain.heightAt(_p.x, _p.z));
    const d = _p.y - ground;
    if (d < 4) {
      // 直前の位置との間を二分探索して精度を上げる
      let lo = prevT, hi = t;
      for (let k = 0; k < 24; k++) {
        const mid = (lo + hi) * 0.5;
        _p.copy(dir).multiplyScalar(mid).add(origin);
        const g = Math.max(0, terrain.heightAt(_p.x, _p.z));
        if (_p.y - g > 0) lo = mid; else hi = mid;
      }
      _p.copy(dir).multiplyScalar(hi).add(origin);
      return { x: _p.x, y: Math.max(0, terrain.heightAt(_p.x, _p.z)), z: _p.z };
    }
    if (prevD !== null && d > prevD && dir.y >= 0) return null;   // 空を見ている
    prevT = t;
    prevD = d;
    t += Math.max(120, d * 0.75);
    if (t > maxDist) return null;
  }
  return null;
}

// ---------------------------------------------------------------- 経路表示

const MAX_PATH_VERTS = 2048;

/** 選択中ユニットの指示経路・距離ラベル・射程円を描く */
class OrderPathRenderer {
  constructor() {
    this.labels = [];        // 距離ラベルのスプライト（使い回す）
    this.circles = [];       // 兵装の射程円
    this.positions = new Float32Array(MAX_PATH_VERTS * 3);
    this.colors = new Float32Array(MAX_PATH_VERTS * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('color', new THREE.BufferAttribute(this.colors, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setDrawRange(0, 0);
    this.geometry = geo;
    this.object = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.8, depthTest: false,
    }));
    this.object.renderOrder = 5;
    this.object.frustumCulled = false;
    this.object.name = 'orderPaths';
  }

  rebuild(units, terrain, camera, world) {
    let n = 0;
    let labelIdx = 0;
    let circleIdx = 0;
    const P = this.positions, C = this.colors;
    const seg = (ax, ay, az, bx, by, bz, col) => {
      if (n + 2 > MAX_PATH_VERTS) return;
      P[n * 3] = ax; P[n * 3 + 1] = ay; P[n * 3 + 2] = az;
      C[n * 3] = col[0]; C[n * 3 + 1] = col[1]; C[n * 3 + 2] = col[2];
      n++;
      P[n * 3] = bx; P[n * 3 + 1] = by; P[n * 3 + 2] = bz;
      C[n * 3] = col[0]; C[n * 3 + 1] = col[1]; C[n * 3 + 2] = col[2];
      n++;
    };

    const AMBER = [1.0, 0.71, 0.28];
    const RED = [1.0, 0.36, 0.27];

    for (const u of units) {
      if (typeof u.waypoints !== 'function') continue;   // 地上ユニットは経路を持たない
      const pts = u.waypoints();
      let px = u.pos.x, py = u.pos.y, pz = u.pos.z;
      for (const w of pts) {
        const col = w.hostile ? RED : AMBER;
        seg(px, py, pz, w.x, w.alt, w.z, col);
        // 目標点から地表への垂線
        const g = Math.max(0, terrain.heightAt(w.x, w.z));
        seg(w.x, w.alt, w.z, w.x, g, w.z, col);
        // 区間の中央に距離を出す
        if (camera) {
          const d = Math.hypot(w.x - px, w.alt - py, w.z - pz);
          if (d > 400) {
            this._label(labelIdx++, (px + w.x) / 2, (py + w.alt) / 2, (pz + w.z) / 2,
              `${(d / 1000).toFixed(1)}km`, w.hostile ? '#ff8a78' : '#ffd08a', camera);
          }
        }
        px = w.x; py = w.alt; pz = w.z;
      }

      // 射撃指示（兵装指定）の相手へ点線代わりの直線
      for (const t of u.fireTasks || []) {
        if (!t.target || !t.target.alive) continue;
        seg(u.pos.x, u.pos.y, u.pos.z, t.target.pos.x, t.target.pos.y, t.target.pos.z, RED);
        if (camera) {
          this._label(labelIdx++,
            (u.pos.x + t.target.pos.x) / 2, (u.pos.y + t.target.pos.y) / 2,
            (u.pos.z + t.target.pos.z) / 2, t.weapon, '#ff5b44', camera);
        }
      }

      // 選択中の兵装の射程円
      if (u.selectedWeapon && camera && world) {
        const w = WEAPONS[u.selectedWeapon];
        if (w && w.range) {
          const r = effectiveMissileRange(w, u.pos.y) * 0.85;
          this._circle(circleIdx++, u.pos, r);
        }
      }
    }

    for (let i = labelIdx; i < this.labels.length; i++) this.labels[i].visible = false;
    for (let i = circleIdx; i < this.circles.length; i++) this.circles[i].visible = false;

    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.color.needsUpdate = true;
    this.geometry.setDrawRange(0, n);
  }

  _label(i, x, y, z, text, color, camera) {
    let s = this.labels[i];
    if (!s) {
      s = new THREE.Sprite(getLabelMaterial(text, color));
      s.renderOrder = 8;
      this.object.add(s);
      this.labels[i] = s;
    }
    s.material = getLabelMaterial(text, color);
    s.visible = true;
    s.position.set(x, y, z);
    const dist = camera.position.distanceTo(s.position);
    const mpp = 2 * dist * Math.tan((camera.fov * Math.PI / 180) / 2) / window.innerHeight;
    const h = 13 * mpp;
    s.scale.set(h * (s.material.userData.aspect || 4), h, 1);
  }

  _circle(i, center, radius) {
    let c = this.circles[i];
    if (!c) {
      const pts = [];
      for (let k = 0; k < 72; k++) {
        const a = (k / 72) * Math.PI * 2;
        pts.push(new THREE.Vector3(Math.cos(a), 0, Math.sin(a)));
      }
      const geo = new THREE.BufferGeometry().setFromPoints(pts);
      c = new THREE.LineLoop(geo, new THREE.LineBasicMaterial({
        color: 0x6fd8e8, transparent: true, opacity: 0.45, depthTest: false,
      }));
      c.renderOrder = 5;
      c.frustumCulled = false;
      this.object.add(c);
      this.circles[i] = c;
    }
    c.visible = true;
    c.position.copy(center);
    c.scale.set(radius, 1, radius);
  }
}
