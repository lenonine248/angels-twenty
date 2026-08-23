// ユニットの選択と指示。
// 仕様 §10.1 の「RTS標準操作」を担当する（リストパネル側は ui/hud.js）。
//
// ピック方式について:
//   地形メッシュは13万ポリゴンあり Raycaster では重いため、
//   地面のピックはハイトマップに沿ってレイマーチする独自実装を使う。
//   ユニットのピックは画面座標での最近傍探索（RTSではこちらの方が掴みやすい）。

import * as THREE from 'three';
import { clamp } from '../core/rng.js';
import { Formation, freeFormationNumber, MAX_FORMATION_NUMBER } from '../ai/formation.js';
import { getLabelMaterial } from '../world/models.js';
import { WEAPONS } from '../data/weapons.js';
import { effectiveMissileRange } from '../core/atmosphere.js';
import { estimateHitChance, estimateGunHit, hitLabel } from '../sim/combat.js';
import { notify } from './actions.js';

const PICK_RADIUS_PX = 26;
const DRAG_THRESHOLD_PX = 6;

export class CommandController {
  constructor({ canvas, camera, world, sceneRoot }) {
    this.canvas = canvas;
    this.camera = camera;
    this.world = world;
    this.selection = [];
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

      // 編隊: 数字で選択、Ctrl+数字で番号の付け替え
      if (/^Digit[1-9]$/.test(e.code)) {
        const n = Number(e.code.slice(5));
        if (e.ctrlKey) this.renumberFormation(n);
        else this.selectFormation(n);
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
          // 表示も同じ見積りにする。撃たない理由と食い違うと混乱するだけ
          const aimErr = this.world.combat ? this.world.combat.aimErrorOf(best.u, u) : 0;
          const p = estimateHitChance(best.u, u, WEAPONS[wid], aimErr);
          const l = hitLabel(p);
          rows.push(`<span class="hi-hit ${l.cls}">${wid} 命中期待 ${l.text}</span>`);
        }
        // **なぜ撃たないのか**を出す。
        // 命中期待度は「当たるか」の見積りで、「撃ってよいか」は別の条件。
        // 同一目標への同時誘導数や再装填は画面に出ていなかったため、
        // 期待度が高いまま撃たない状態が不具合にしか見えなかった。
        // 兵装を指定していないときは null を渡す。
        // AI と同じ規則で選ばせないと、表示の兵装だけが射程外で
        // 「射程外」と出るのに実際は別の兵装で撃つ、という食い違いが起きる。
        const block = this.world.combat && this.world.combat.fireBlockReason(
          best.u, u, best.u.selectedWeapon ? WEAPONS[best.u.selectedWeapon] : null);
        if (block) rows.push(`<span class="hi-hit bad">撃てない: ${block}</span>`);
        // 機銃は実体弾なので「今この距離・この向きで当たるか」が刻々変わる。
        // 撃てる位置に付けたかどうかが読めないと、機銃で仕留める判断ができない。
        const gp = estimateGunHit(best.u, u);
        if (gp > 0.01) {
          const gl = hitLabel(gp * 3);      // 機銃は1発あたりの値なので目盛りを合わせる
          rows.push(`<span class="hi-hit ${gl.cls}">機銃 ${Math.round(gp * 100)}%/発</span>`);
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
    if (next.length) notify('select', { units: next });
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
    // else を波括弧なしで書くと内側の if に付いてしまい、
    // Shift 無しの範囲選択が何もしなくなる（実際そうなっていた）。
    if (additive) {
      for (const u of hit) if (!this.isSelected(u)) this.selection.push(u);
      if (hit.length) notify('select', { units: this.selection });
    } else {
      this.select(hit);
    }
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
          // プレイヤーの指示はAIが上書きしない（回避と燃料切れを除く）
          u.setPlayerOrder({ type: 'attack', target }, append);
        }
      }
      notify('order:attack', { target });
      return;
    }
    if (target && target.side === this.world.playerSide) {
      let slot = 1;
      for (const u of this.selection) {
        if (u === target) continue;
        u.setPlayerOrder({ type: 'follow', target, slot: slot++ }, append);
      }
      notify('order:follow', { target });
      return;
    }

    const p = this._groundAtScreen(px, py);
    if (!p) return;

    // 編隊がまるごと選択されていれば、リーダーに指示して僚機は追従させる
    const formation = this._selectedFormation();
    if (formation && !append) {
      const leader = formation.leader;
      formation.issue({
        type: 'move', x: p.x, z: p.z,
        alt: leader.order?.alt ?? leader.desiredAlt,
      });
      for (const u of formation.members) {
        u.patrolArea = { x: p.x, z: p.z, alt: leader.desiredAlt, radius: 4500 };
      }
      notify('order:move', { x: p.x, z: p.z });
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
      u.setPlayerOrder({ type: 'move', x: tx, z: tz, alt: u.order?.alt ?? u.desiredAlt }, append);
      // 到達後の待機・哨戒もそこで行う
      u.patrolArea = { x: tx, z: tz, alt: u.order?.alt ?? u.desiredAlt, radius: 4500 };
    }
    notify('order:move', { x: p.x, z: p.z });
  }

  /** 番号から編隊を引く */
  formationByNumber(n) {
    return (this.world.formations || []).find((f) => f.number === n && f.alive) || null;
  }

  /** その番号の編隊を丸ごと選択する */
  selectFormation(n) {
    const f = this.formationByNumber(n);
    if (!f) return;
    const alive = f.members.filter((u) => u.alive);
    if (alive.length) this.select(alive);
  }

  /**
   * 選択中の編隊の番号を付け替える。
   * その番号を別の編隊が使っていたら入れ替える（消さない）。
   */
  renumberFormation(n) {
    if (n < 1 || n > MAX_FORMATION_NUMBER) return;
    const f = this.selection.map((u) => u.formation).find(Boolean);
    if (!f || f.number === n) return;
    const other = this.formationByNumber(n);
    const old = f.number;
    f.setNumber(n);
    if (other && other !== f) other.setNumber(old);
    this.world.log?.(other && other !== f
      ? `${f.name} と ${other.name} の番号を入れ替えました`
      : `編隊の番号を ${n} にしました`);
  }

  /** 選択中の機体（最大4機）で編隊を組む */
  makeFormation() {
    const members = this.selection.filter((u) => u.kind === 'aircraft' && u.alive).slice(0, 4);
    if (members.length < 2) return;
    const f = new Formation(members, freeFormationNumber(this.world.formations));
    this.world.formations.push(f);
    f.setMode('COORDINATE');
    this.world.log?.(`${f.name} 編成（${members.map((m) => m.name).join(', ')}）`);
    notify('formation', { formation: f });
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
    let ordered = false;
    for (const u of this.selection) {
      if (u.onGround || !u.nearestBase) continue;
      const ab = u.nearestBase(this.world);
      // **`setPlayerOrder` を使うこと。** 素の `setOrder` だと `player` が付かず、
      // 対地攻撃モードの機体は次の tick で `_strike()` に攻撃指示へ戻される
      // — 実測で「Bキーの帰投だけ効かない」という形で出ていた。
      if (ab) { u.setPlayerOrder({ type: 'rtb', airbase: ab }); ordered = true; }
    }
    if (ordered) notify('order:rtb', {});
  }

  adjustAltitude(delta) {
    if (this.selection.length) notify(delta > 0 ? 'alt:up' : 'alt:down', { delta });
    for (const u of this.selection) {
      const base = u.order?.alt ?? u.desiredAlt;
      this._applyAltitude(u, base + delta);
    }
  }

  setAltitude(alt) {
    const cur = this.selection[0] ? (this.selection[0].order?.alt ?? this.selection[0].desiredAlt) : alt;
    if (this.selection.length && alt !== cur) notify(alt > cur ? 'alt:up' : 'alt:down', { alt });
    for (const u of this.selection) this._applyAltitude(u, alt);
  }

  /**
   * 指示高度を1機に反映する。
   *
   * **哨戒エリアの高度も一緒に書き換えるのが要点。**
   * AI は待機旋回中の機体を「手が空いている」とみなして毎回 orbit 指示を出し直し、
   * その高度に哨戒エリアの値を使う。ここを直さないと、Z/X で上げた高度が
   * 数秒で元に戻る（実際に戻っていた）。
   */
  _applyAltitude(u, alt) {
    const a = clamp(alt, 300, u.spec.ceiling);
    if (u.order) u.order.alt = a;
    for (const q of u.queue) q.alt = a;
    u.desiredAlt = a;
    if (u.patrolArea) u.patrolArea.alt = a;
    // **プレイヤーが決めた高度**として機体に覚えさせる。
    // 指示(order)に持たせるだけだと、敵を右クリックして攻撃指示を出した瞬間に
    // 新しい指示へ差し替わって消える。空戦機動はこれを見て、
    // 交戦の間合いに入るまで指定高度を保つ（§6.2.5 / sim/acm.js）。
    u.commandedAlt = a;
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
      // **記憶しているだけの敵は、既に壊れていても掴める。**
      // `!u.alive` で弾いていたので、地図に出ているのにクリックできない＝
      // **壊れていることが分かってしまった**（§3 の「攻撃したが結果を見ていない」が台無し）。
      // 探知の側は正しく作られていて、見ていない前で壊れた静止目標の記憶は残る。
      // 自軍は生きているものだけ（死んだ僚機に指示は出せない）。
      if (side ? !u.alive : (!u.alive && !this.world.isVisibleToPlayer(u))) continue;
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
/** レーダーの扇の内側の弧（探知距離に対する比）。ここまで入れば即座に識別できる */
const IDENT_ARC = 0.5;

/** 選択中ユニットの指示経路・距離ラベル・射程円を描く */
class OrderPathRenderer {
  constructor() {
    this.labels = [];        // 距離ラベルのスプライト（使い回す）
    this.circles = [];       // 兵装の射程円
    this.fans = [];          // レーダーの扇
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
    let fanIdx = 0;
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

      // レーダーの扇。「今どこを見ているか」が見えないと、
      // 機首を向ける／向けないの判断そのものが成立しない。
      // 全方位レーダー（早期警戒機）は扇にならないので円で出す。
      // 切っているあいだは扇を消す（§26.8）。出たままだと見えている気になる
      if (!u.onGround && u.radarRange > 0) {
        this._radarFan(fanIdx++, u);
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
    for (let i = fanIdx; i < this.fans.length; i++) this.fans[i].visible = false;

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

  /**
   * レーダーの扇。機体の高度の水平面に、機首方向を中心とした扇形を描く。
   *
   * **面（薄い塗り）と輪郭の2枚重ね**にしてある。
   * 探知距離は 40km あり、ふつうの寄り（10〜20km）では輪郭の弧が画面の外に出る。
   * 線だけだと「2本の線が伸びている」だけになって扇に見えないので、
   * 手前が必ず映る面を敷いて向きが読めるようにする。
   *
   * 内側の弧は「ここまで入れば即座に識別できる」距離（探知距離の半分）。
   */
  _radarFan(i, u) {
    const range = u.radarRange || 0;
    const omni = !!u.spec.omniRadar;
    const half = omni ? Math.PI : (u.spec.radarFovH || 60) * Math.PI / 180;
    let f = this.fans[i];
    if (!f || f.userData.half !== half) {
      if (f) this.object.remove(f);
      f = new THREE.Group();
      f.userData.half = half;
      f.frustumCulled = false;

      // 面。機首は -Z なので、+Y が -Z へ来るように倒して角度を合わせる。
      const wedge = new THREE.Mesh(
        new THREE.CircleGeometry(1, 32, Math.PI / 2 - half, 2 * half),
        new THREE.MeshBasicMaterial({
          color: 0x6fd8e8, transparent: true, opacity: 0.11,
          depthTest: false, side: THREE.DoubleSide,
        }),
      );
      wedge.rotation.x = -Math.PI / 2;
      wedge.renderOrder = 3;
      f.add(wedge);

      // 輪郭（外周・内側の弧・扇の両端）
      const pts = [];
      const STEPS = 28;
      const arc = (r, closeToCenter) => {
        if (closeToCenter) pts.push(new THREE.Vector3(0, 0, 0));
        for (let k = 0; k <= STEPS; k++) {
          const a = -half + (2 * half * k) / STEPS;
          pts.push(new THREE.Vector3(Math.sin(a) * r, 0, -Math.cos(a) * r));
        }
        if (closeToCenter) pts.push(new THREE.Vector3(0, 0, 0));
      };
      arc(1, !omni);
      arc(IDENT_ARC, false);
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({
          color: 0x6fd8e8, transparent: true, opacity: 0.4, depthTest: false,
        }),
      );
      line.renderOrder = 4;
      f.add(line);

      this.object.add(f);
      this.fans[i] = f;
    }
    f.visible = true;
    f.position.copy(u.pos);
    f.rotation.y = -u.heading;
    f.scale.set(range, 1, range);
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
