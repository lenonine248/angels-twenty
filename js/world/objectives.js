// 到達目標の印。仕様書 §23.9。
//
// **戦闘とリプレイの両方が使う。** `main.js` に置いたままだと
// リプレイから呼べず（`main.js` がリプレイを読み込むので循環する）、
// **再生のときだけ護衛の行き先が画面から消えていた。**

import * as THREE from 'three';
import { makeLabelSprite } from './models.js';

/**
 * 到達目標（objectives の reach）を戦場に描く。
 *
 * ブリーフィングの地図には出しているが、戦闘中は何も出ていなかった。
 * 「どこまで護衛するのか」が画面から読めないと、輸送機を自分で誘導したときに
 * どこへ向ければいいのか分からなくなる（実際に分からなくなった）。
 */
export function buildObjectiveMarkers(stage, terrain) {
  const out = [];
  for (const o of stage.objectives || []) {
    if (o.type !== 'reach') continue;
    const radius = o.radius || 3000;
    const ground = Math.max(0, terrain.heightAt(o.x, o.z));
    const group = new THREE.Group();
    group.name = `objective-${o.id}`;
    group.position.set(o.x, ground, o.z);

    // 地表の円と、そこから立ち上がる柱。上空からでも横からでも見つかるように。
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(radius * 0.94, radius, 64),
      new THREE.MeshBasicMaterial({
        color: 0xffb648, transparent: true, opacity: 0.5,
        side: THREE.DoubleSide, depthTest: false,
      }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 30;
    ring.renderOrder = 4;
    group.add(ring);

    const pillar = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 6000, 0)]),
      new THREE.LineBasicMaterial({
        color: 0xffb648, transparent: true, opacity: 0.28, depthTest: false,
      }),
    );
    pillar.renderOrder = 4;
    group.add(pillar);

    // ラベルは画面上で一定の大きさにする（毎フレーム scaleObjectiveLabels で合わせる）。
    // ワールド単位で固定すると、寄れば画面いっぱい、引けば粒になる。
    const label = makeLabelSprite('到達地点', '#ffb648');
    label.name = 'objLabel';
    label.position.y = 6200;
    label.renderOrder = 8;
    group.add(label);

    out.push(group);
  }
  return out;
}

/** 到達目標のラベルを画面上で一定の大きさに保つ（他のラベルと同じ方式） */
const OBJ_LABEL_PX = 16;
export function scaleObjectiveLabels(markers, camera) {
  if (!markers) return;
  for (const g of markers) {
    const label = g.getObjectByName('objLabel');
    if (!label) continue;
    label.getWorldPosition(_labelPos);
    const dist = camera.position.distanceTo(_labelPos);
    const mpp = 2 * dist * Math.tan((camera.fov * Math.PI / 180) / 2) / window.innerHeight;
    const h = OBJ_LABEL_PX * mpp;
    label.scale.set(h * (label.material.userData.aspect || 4), h, 1);
  }
}
const _labelPos = new THREE.Vector3();
