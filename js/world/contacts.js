// 探知コンタクトの3D表示。仕様書 §4.2 / §4.3 / §4.4。
//
// 敵ユニットの機体そのものを描くのは「識別済み以上で、いま探知している」場合だけ。
// それ以外は菱形シンボルで最後に分かった位置を示す。
//   探知中 CONTACT      … 実線・全不透明
//   ロスト LOST         … 点滅しながら推測進路へ移動し、10秒で消滅
//   記憶   MEMORY       … 減光＋外枠付き（静止目標のみ・消えない）
//   状態不明 UNCONFIRMED … 記憶表示＋「?」（攻撃したが着弾を見ていない）
//
// 座標が逆探知だけで得られている目標（±1km ぶれる）は、
// **誤差の円**を足して「そこにピタリといるわけではない」と分かるようにする。
// 位置が確かな目標と同じ菱形で描くと、対地ミサイルを撃ってよい相手なのか
// 見に行くべき相手なのかが区別できない。

import * as THREE from 'three';
import { LEVEL, lostLifetimeOf, RWR_POS_ERROR } from '../sim/detection.js';
import { makeLabelSprite } from './models.js';
import { CATEGORY_LABEL } from '../data/ground.js';
import { categoryOf } from '../data/aircraft.js';

const COLOR_UNKNOWN = new THREE.Color(0xe8e8e8);
const COLOR_HOSTILE = new THREE.Color(0xff5b44);
const LABEL_PX = 15;

export class ContactRenderer {
  constructor(root, detection, side) {
    this.detection = detection;
    this.side = side;
    this.markers = new Map();
    this.group = new THREE.Group();
    this.group.name = 'contacts';
    root.add(this.group);
  }

  update(camera, terrain, size, time) {
    const contacts = this.detection.contactsFor(this.side);

    for (const [id, m] of this.markers) {
      if (!contacts.has(id)) {
        this.group.remove(m);
        this.markers.delete(id);
      }
    }

    for (const [id, c] of contacts) {
      let m = this.markers.get(id);
      if (!m) { m = createMarker(); this.markers.set(id, m); this.group.add(m); }
      syncMarker(m, c, camera, terrain, size, time);
    }
  }

  /**
   * 敵ユニットの実体メッシュを表示してよいか。
   * 「識別済み」かつ「現在探知中」かつ「位置が精密」なときだけ。
   * 逆探知だけで捕まえた目標は位置が粗いので、実体を描くと誤差が意味を失う。
   */
  showsBody(unit) {
    const c = this.detection.contactsFor(this.side).get(unit.id);
    return !!c && c.detected && c.exactNow && c.level >= LEVEL.IDENTIFIED;
  }
}

// ---------------------------------------------------------------- マーカー生成

function lineLoop(points, color) {
  const geo = new THREE.BufferGeometry().setFromPoints(points);
  const mat = new THREE.LineBasicMaterial({
    color, transparent: true, depthTest: false,
  });
  const l = new THREE.LineLoop(geo, mat);
  l.renderOrder = 6;
  return l;
}

function createMarker() {
  const g = new THREE.Group();
  g.frustumCulled = false;

  // カメラを向く板（シンボルはここに入れる）
  const bb = new THREE.Group();
  bb.name = 'bb';
  g.add(bb);

  const diamond = lineLoop([
    new THREE.Vector3(0, 1, 0), new THREE.Vector3(0.75, 0, 0),
    new THREE.Vector3(0, -1, 0), new THREE.Vector3(-0.75, 0, 0),
  ], 0xffffff);
  diamond.name = 'diamond';
  bb.add(diamond);

  // 記憶状態の外枠
  const frame = lineLoop([
    new THREE.Vector3(-1.35, 1.35, 0), new THREE.Vector3(1.35, 1.35, 0),
    new THREE.Vector3(1.35, -1.35, 0), new THREE.Vector3(-1.35, -1.35, 0),
  ], 0xffffff);
  frame.name = 'frame';
  frame.visible = false;
  bb.add(frame);

  // 地表への垂線
  const altLine = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, -1, 0)]),
    new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.3, depthTest: false }),
  );
  altLine.name = 'altLine';
  altLine.renderOrder = 6;
  g.add(altLine);

  // 逆探知の位置誤差の円（地表に置く）
  const err = new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints(
      Array.from({ length: 48 }, (_, k) => {
        const a = (k / 48) * Math.PI * 2;
        return new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
      })),
    new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.3, depthTest: false }),
  );
  err.name = 'err';
  err.visible = false;
  err.renderOrder = 6;
  g.add(err);

  // 進行方向のヒゲ（未識別でも進路は分かる）
  const heading = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]),
    new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, depthTest: false }),
  );
  heading.name = 'heading';
  heading.renderOrder = 6;
  g.add(heading);

  g.userData.labelText = null;
  return g;
}

// ---------------------------------------------------------------- 同期

function syncMarker(g, c, camera, terrain, size, time) {
  g.position.copy(c.pos);

  const state = c.state;
  const color = c.level >= LEVEL.IDENTIFIED ? COLOR_HOSTILE : COLOR_UNKNOWN;

  // 状態ごとの不透明度
  let opacity = 1;
  if (state === 'lost') {
    // 点滅しながら薄くなり、10秒で消える
    const age = Math.min(1, (time - c.lastSeen) / lostLifetimeOf(c.unit));
    opacity = (0.25 + 0.75 * (0.5 + 0.5 * Math.sin(time * 7))) * (1 - age * 0.65);
  } else if (state === 'memory') {
    opacity = c.unconfirmed ? 0.35 + 0.25 * (0.5 + 0.5 * Math.sin(time * 2.2)) : 0.5;
  }

  const bb = g.getObjectByName('bb');
  bb.quaternion.copy(camera.quaternion);

  const r = size * 0.55;
  bb.scale.setScalar(r);

  const diamond = g.getObjectByName('diamond');
  diamond.material.color.copy(color);
  diamond.material.opacity = opacity;

  const frame = g.getObjectByName('frame');
  frame.visible = state === 'memory';
  if (frame.visible) {
    frame.material.color.copy(color);
    frame.material.opacity = opacity * 0.8;
  }

  // 高度線
  const ground = Math.max(0, terrain.heightAt(c.pos.x, c.pos.z));
  const agl = Math.max(0, c.pos.y - ground);
  const altLine = g.getObjectByName('altLine');
  altLine.scale.y = agl;
  altLine.visible = agl > 50;
  altLine.material.color.copy(color);
  altLine.material.opacity = opacity * 0.35;

  // 逆探知だけの目標は誤差の円を出す
  const err = g.getObjectByName('err');
  err.visible = !!c.approx;
  if (err.visible) {
    err.position.y = -agl;                      // 地表に敷く
    // 円の大きさは**いま持っている誤差**。近づくほど縮むので、
    // 「掴めてきている」ことが画面から分かる（§25.2）
    const r = Number.isFinite(c.err) ? Math.max(60, c.err) : RWR_POS_ERROR;
    err.scale.set(r, 1, r);
    err.material.color.copy(color);
    err.material.opacity = opacity * 0.45;
  }

  // 進行方向
  const heading = g.getObjectByName('heading');
  const moving = c.unit.kind === 'aircraft' || c.speed > 1;
  heading.visible = moving;
  if (moving) {
    heading.rotation.y = -c.heading;
    heading.scale.z = size * 1.8;
    heading.material.color.copy(color);
    heading.material.opacity = opacity * 0.8;
  }

  // ラベル
  const text = labelFor(c);
  if (text !== g.userData.labelText) {
    const old = g.getObjectByName('label');
    if (old) bb.remove(old);
    const sprite = makeLabelSprite(text, '#' + color.getHexString());
    sprite.name = 'label';
    bb.add(sprite);
    g.userData.labelText = text;
    g.userData.label = sprite;
  }
  const label = g.userData.label;
  if (label) {
    const dist = camera.position.distanceTo(g.position);
    const mpp = 2 * dist * Math.tan((camera.fov * Math.PI / 180) / 2) / window.innerHeight;
    const h = LABEL_PX * mpp;
    const aspect = label.material.userData.aspect || 4;
    // bb はスケール r 済みなのでローカル値に割り戻す
    label.scale.set((h * aspect) / r, h / r, 1);
    label.position.set(1.0 + (h * aspect) / r / 2, 1.15, 0);
    label.material.opacity = Math.min(1, opacity + 0.2);
  }
}

function labelFor(c) {
  const u = c.unit;
  let base;
  if (c.level === LEVEL.UNKNOWN) {
    base = 'UNKNOWN';
  } else if (c.level === LEVEL.IDENTIFIED) {
    const cat = u.kind === 'aircraft' ? categoryOf(u.typeId) : u.kind;
    base = CATEGORY_LABEL[cat] || cat;
  } else {
    base = u.kind === 'aircraft' ? u.typeId : u.spec.name;
  }

  // 詳細判明していれば高度と速度まで読める（仕様 §4.2）
  if (u.kind === 'aircraft') {
    base += ` ${(c.pos.y / 1000).toFixed(1)}km`;
    if (c.level >= LEVEL.DETAILED && c.detected) base += ` ${Math.round(c.speed)}m/s`;
  }

  if (c.approx) base += ` [逆探知 ±${Math.round(c.err)}m]`;
  if (c.unconfirmed) base += ' ?';
  else if (c.state === 'memory') base += ' [記憶]';
  return base;
}
