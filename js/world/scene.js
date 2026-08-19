// Three.js のセットアップと RTS 風カメラリグ。
// カメラは「地上の注視点 + 方位 + 仰角 + 距離」で表現する。
// 指揮官視点（斜め上からの見下ろし）を基本とし、真上に近い戦域俯瞰までズームアウトできる。

import * as THREE from 'three';
import { MAP_SIZE } from './terrain.js';
import { clamp } from '../core/rng.js';

const SKY_COLOR = 0x9fb9cb;

export class CameraRig {
  constructor(terrain) {
    this.terrain = terrain;
    this.target = new THREE.Vector3(MAP_SIZE / 2, 0, MAP_SIZE / 2);
    this.azimuth = Math.PI * 0.25;   // 方位（ラジアン）
    this.pitch = 0.85;               // 仰角（0=水平, PI/2=真上）
    this.distance = 12000;           // 注視点からの距離(m)

    // 注視点の対地高度(m)。地面を見ると高度3km超の機体が画面外へ出るため、
    // 選択中のユニットの高度に追従させる。
    this.focusAlt = 2200;
    this.focusAltTarget = 2200;

    // 補間用の実値
    this._azimuth = this.azimuth;
    this._pitch = this.pitch;
    this._distance = this.distance;
    this._target = this.target.clone();

    this.minDistance = 900;
    this.maxDistance = 46000;
    this.minPitch = 0.22;
    this.maxPitch = 1.45;
  }

  /** 注視点を移動（カメラの向きに対する前後左右） */
  pan(forward, right, speedScale = 1) {
    const s = this.distance * 0.55 * speedScale;
    const sin = Math.sin(this.azimuth), cos = Math.cos(this.azimuth);
    // 画面奥方向 = カメラの向いている水平方向
    this.target.x += (-sin * forward + cos * right) * s;
    this.target.z += (-cos * forward - sin * right) * s;
    this._clampTarget();
  }

  rotate(delta) { this.azimuth += delta; }
  tilt(delta) { this.pitch = clamp(this.pitch + delta, this.minPitch, this.maxPitch); }
  zoom(factor) {
    this.distance = clamp(this.distance * factor, this.minDistance, this.maxDistance);
  }

  /** 指定ワールド座標へ注視点を移す */
  lookAtPoint(x, z) {
    this.target.set(x, 0, z);
    this._clampTarget();
  }

  _clampTarget() {
    const m = MAP_SIZE * 0.06;
    this.target.x = clamp(this.target.x, -m, MAP_SIZE + m);
    this.target.z = clamp(this.target.z, -m, MAP_SIZE + m);
  }

  /** 補間して実カメラへ反映 */
  update(camera, realDt) {
    const k = 1 - Math.pow(0.0015, realDt);   // フレームレート非依存の減衰
    this._azimuth += (this.azimuth - this._azimuth) * k;
    this._pitch += (this.pitch - this._pitch) * k;
    this._distance += (this.distance - this._distance) * k;

    // 注視点は「地表高度 + 注目高度」。地表に追従しつつ、機体の高度も画面に収める。
    this.focusAlt += (this.focusAltTarget - this.focusAlt) * (1 - Math.pow(0.15, realDt));
    const ground = this.terrain ? Math.max(0, this.terrain.heightAt(this.target.x, this.target.z)) : 0;
    this.target.y = ground + this.focusAlt;
    this._target.lerp(this.target, k);

    const d = this._distance;
    const cp = Math.cos(this._pitch), sp = Math.sin(this._pitch);
    camera.position.set(
      this._target.x + Math.sin(this._azimuth) * cp * d,
      this._target.y + sp * d,
      this._target.z + Math.cos(this._azimuth) * cp * d,
    );
    camera.lookAt(this._target);
  }
}

export class SceneManager {
  constructor(canvas, terrain) {
    this.canvas = canvas;
    this.terrain = terrain;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(SKY_COLOR);
    this.scene.fog = new THREE.Fog(SKY_COLOR, 18000, 95000);

    this.camera = new THREE.PerspectiveCamera(48, 1, 25, 260000);
    this.rig = new CameraRig(terrain);
    this.terrain = terrain;

    this._setupLights();

    // ワールドのルート（ユニットやエフェクトはここにぶら下げる）
    this.world = new THREE.Group();
    this.scene.add(this.world);

    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  _setupLights() {
    const sun = new THREE.DirectionalLight(0xfff0d8, 1.25);
    sun.position.set(-0.55, 0.75, -0.36).normalize();
    this.scene.add(sun);
    this.sun = sun;

    // 空と地面からの回り込み光。低ポリの面を潰さない程度に弱く。
    this.scene.add(new THREE.HemisphereLight(SKY_COLOR, 0x3a3626, 0.55));
  }

  add(obj) { this.world.add(obj); }

  /** ステージを切り替えるとき、前のステージの表示物をすべて捨てる */
  reset() {
    for (const child of this.world.children.slice()) this.world.remove(child);
  }

  setTerrain(terrain) {
    this.terrain = terrain;
    this.rig.terrain = terrain;
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  update(realDt) {
    this.rig.update(this.camera, realDt);
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }
}

/**
 * カメラ操作の入力を接続する。
 * P2 以降でユニット選択（左クリック・右クリック）が入るため、
 * カメラは「WASD / QE / RF / ホイール / 中ボタンドラッグ」に限定しておく。
 */
export function attachCameraControls(rig, dom) {
  const keys = new Set();
  let midDrag = false, lastX = 0, lastY = 0;

  window.addEventListener('keydown', (e) => {
    // 入力欄にフォーカスがある場合は無視
    if (e.target && /INPUT|TEXTAREA/.test(e.target.tagName)) return;
    keys.add(e.code);
  });
  window.addEventListener('keyup', (e) => keys.delete(e.code));
  window.addEventListener('blur', () => keys.clear());

  dom.addEventListener('wheel', (e) => {
    e.preventDefault();
    rig.zoom(e.deltaY > 0 ? 1.14 : 1 / 1.14);
  }, { passive: false });

  dom.addEventListener('mousedown', (e) => {
    if (e.button === 1) { midDrag = true; lastX = e.clientX; lastY = e.clientY; e.preventDefault(); }
  });
  window.addEventListener('mouseup', (e) => { if (e.button === 1) midDrag = false; });
  window.addEventListener('mousemove', (e) => {
    if (!midDrag) return;
    rig.rotate((e.clientX - lastX) * -0.005);
    rig.tilt((e.clientY - lastY) * 0.004);
    lastX = e.clientX; lastY = e.clientY;
  });
  dom.addEventListener('contextmenu', (e) => e.preventDefault());

  /** 毎フレーム呼ぶ。realDt は実時間（ポーズ中もカメラは動かせる） */
  return function updateCameraInput(realDt) {
    const fast = keys.has('ShiftLeft') || keys.has('ShiftRight') ? 2.4 : 1;
    let fwd = 0, right = 0;
    if (keys.has('KeyW')) fwd += 1;
    if (keys.has('KeyS')) fwd -= 1;
    if (keys.has('KeyD')) right += 1;
    if (keys.has('KeyA')) right -= 1;
    if (fwd || right) rig.pan(fwd * realDt, right * realDt, fast);

    if (keys.has('KeyQ')) rig.rotate(realDt * 1.1);
    if (keys.has('KeyE')) rig.rotate(-realDt * 1.1);
    if (keys.has('KeyR')) rig.tilt(realDt * 0.8);
    if (keys.has('KeyF')) rig.tilt(-realDt * 0.8);
  };
}
