// ローポリ機体モデルの手続き生成。
// 外部モデルファイルを持たず、機種ごとの形状パラメータから三角形を組み立てる。
// 見た目は「昔の低ポリゴンゲーム」。1機あたり24三角形程度。
//
// モデルは全長1.0の単位空間で作り、描画時にスケールする。
// 機首は -Z を向く（heading=0 が北 = -Z 方向 と一致する）。

import * as THREE from 'three';

const geometryCache = new Map();
const materialCache = new Map();

/** 機影の目標画面サイズ(px)。RTSとして掴める大きさを維持する。 */
const TARGET_PX = 46;
const MIN_LENGTH_M = 60;
const MAX_LENGTH_M = 1100;

/**
 * 機体の表示全長(m)を決める。
 *
 * 実寸15mの戦闘機は51kmのマップ上では1px未満になり、選択も識別もできない。
 * 画面上でおよそ一定サイズに見えるよう、カメラ距離から逆算して誇張する
 * （RTSのユニットアイコンと同じ考え方）。寄れば実寸に近づく。
 */
export function aircraftDisplayLength(cameraDistance, camera) {
  const metersPerPixel =
    2 * cameraDistance * Math.tan((camera.fov * Math.PI / 180) / 2) / window.innerHeight;
  return THREE.MathUtils.clamp(metersPerPixel * TARGET_PX, MIN_LENGTH_M, MAX_LENGTH_M);
}

/** 機種形状から機体ジオメトリを作る（キャッシュ付き） */
export function getJetGeometry(shape, key) {
  if (geometryCache.has(key)) return geometryCache.get(key);

  const L = shape.length;
  const S = shape.span * 0.5;
  const SW = shape.sweep;
  const F = shape.fatness;
  const r = 0.045 * F;

  const pos = [];
  const tri = (a, b, c) => { pos.push(...a, ...b, ...c); };
  const quad = (a, b, c, d) => { tri(a, b, c); tri(a, c, d); };

  // --- 胴体（前後2つのリングを持つ菱形断面） ---
  const zNose = -0.55 * L, zA = -0.22 * L, zB = 0.26 * L, zTail = 0.46 * L;
  const ring = (z, s) => [
    [0, r * 1.15 * s, z],   // 上
    [r * s, 0, z],          // 右
    [0, -r * 0.85 * s, z],  // 下
    [-r * s, 0, z],         // 左
  ];
  const A = ring(zA, 1), B = ring(zB, 0.72);
  const nose = [0, r * 0.15, zNose];
  const tail = [0, r * 0.25, zTail];

  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    tri(nose, A[i], A[j]);          // 機首
    quad(A[i], B[i], B[j], A[j]);   // 胴中央
    tri(B[j], B[i], tail);          // 尾部
  }

  // --- 主翼（後退角つき） ---
  for (const s of [1, -1]) {
    const rootF = [s * r * 0.9, 0, -0.06 * L];
    const rootR = [s * r * 0.9, 0, 0.28 * L];
    const tipF = [s * S, 0, -0.06 * L + SW * L + 0.16 * L];
    const tipR = [s * S, 0, 0.28 * L + SW * L * 0.55];
    quad(rootF, tipF, tipR, rootR);
  }

  // --- 水平尾翼 ---
  for (const s of [1, -1]) {
    const rootF = [s * r * 0.7, 0, 0.30 * L];
    const rootR = [s * r * 0.7, 0, 0.45 * L];
    const tip = [s * S * 0.40, 0, 0.45 * L];
    tri(rootF, tip, rootR);
  }

  // --- 垂直尾翼 ---
  const fins = shape.twinTail ? [r * 0.75, -r * 0.75] : [0];
  for (const fx of fins) {
    const lean = shape.twinTail ? Math.sign(fx) * 0.05 : 0;
    tri(
      [fx, r * 0.5, 0.18 * L],
      [fx + lean, r * 0.5 + 0.15 * L, 0.40 * L],
      [fx, r * 0.5, 0.46 * L],
    );
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  geometryCache.set(key, geo);
  return geo;
}

/**
 * 路面用のマテリアル。
 *
 * 滑走路の天面は飛行場の標高＝整地された地形とちょうど同じ高さにある
 * （そうしないと駐機中の機体が路面に埋まる）。同一平面のままだと
 * 深度の取り合いでちらつくので、**深度だけ手前へずらす**。
 * 位置を持ち上げて逃げると、こんどは機体が浮いて見える。
 */
const pavementCache = new Map();
function getPavementMaterial(color) {
  if (!pavementCache.has(color)) {
    const emissive = new THREE.Color(color).multiplyScalar(0.28);
    pavementCache.set(color, new THREE.MeshLambertMaterial({
      color, emissive, flatShading: true, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -8,
    }));
  }
  return pavementCache.get(color);
}

function getMaterial(color) {
  if (!materialCache.has(color)) {
    // 影側でも機影が黒く潰れないよう、わずかに自発光させる
    const emissive = new THREE.Color(color).multiplyScalar(0.28);
    materialCache.set(color, new THREE.MeshLambertMaterial({
      color, emissive, flatShading: true, side: THREE.DoubleSide,
    }));
  }
  return materialCache.get(color);
}

const RING_COLOR = { blue: 0x6fd8e8, red: 0xff5b44 };
const ALT_LINE_COLOR = { blue: 0x4a8fa8, red: 0x8a4a3a };

/**
 * 機体の表示オブジェクトを作る。
 * 構成: body（機体本体） / altLine（地表への垂線） / ring（選択リング）
 * 高度線と選択リングは「見下ろし視点で高度を読む」ために必須。
 */
export function createAircraftView(ac) {
  const spec = ac.spec;
  const group = new THREE.Group();
  group.name = `unit-${ac.id}`;

  const body = new THREE.Mesh(getJetGeometry(spec.shape, spec.id), getMaterial(spec.color));
  body.name = 'body';
  group.add(body);

  // 地表への垂線（scale.y で長さを変える）
  const lineGeo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, -1, 0),
  ]);
  const altLine = new THREE.Line(lineGeo, new THREE.LineBasicMaterial({
    color: ALT_LINE_COLOR[ac.side] ?? 0x888888, transparent: true, opacity: 0.45,
  }));
  altLine.name = 'altLine';
  group.add(altLine);

  // 地表の接地点リング（常時表示・薄い）
  const spot = new THREE.Mesh(
    new THREE.RingGeometry(0.30, 0.42, 16),
    new THREE.MeshBasicMaterial({
      color: RING_COLOR[ac.side] ?? 0x888888,
      transparent: true, opacity: 0.55, side: THREE.DoubleSide,
    }),
  );
  spot.rotation.x = -Math.PI / 2;
  spot.name = 'spot';
  group.add(spot);

  // 選択リング（選択時のみ表示）
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.62, 0.80, 24),
    new THREE.MeshBasicMaterial({
      color: 0xffb648, transparent: true, opacity: 0.9, side: THREE.DoubleSide,
    }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.name = 'ring';
  ring.visible = false;
  group.add(ring);

  group.userData.unit = ac;
  ac.view = group;
  return group;
}

/**
 * 表示オブジェクトをシミュレーション状態に同期する。
 * @param {Aircraft} ac
 * @param {Terrain} terrain
 * @param {number} size 機体の表示全長(m)。aircraftDisplayLength() で求める。
 * @param {boolean} selected
 */
export function syncAircraftView(ac, terrain, size, selected, visible = true) {
  const g = ac.view;
  if (!g) return;
  g.visible = ac.alive && visible;
  if (!g.visible) return;

  g.position.copy(ac.pos);

  const body = g.getObjectByName('body');
  body.scale.setScalar(size);
  // 機体モデルは重心が原点にある。地上では機底が路面に接するよう持ち上げる。
  // 機影は画面上で一定サイズになるよう誇張しているので、持ち上げ量も表示倍率で決まる。
  body.position.y = ac.onGround ? -(bodyFloorOf(ac.spec) * size) : 0;
  // 機首方向・バンク・ピッチ
  body.rotation.set(0, 0, 0);
  body.rotateY(-ac.heading);
  // 機首は -Z を向いているので、X軸まわりの正回転で機首が上がる。
  // 上昇(pitch>0)で機首上げになるよう符号はそのまま渡す。
  body.rotateX(ac.pitch);
  body.rotateZ(-ac.roll * 0.9);

  const ground = Math.max(0, terrain.heightAt(ac.pos.x, ac.pos.z));
  const agl = Math.max(0, ac.pos.y - ground);

  const altLine = g.getObjectByName('altLine');
  altLine.scale.y = agl;

  const spot = g.getObjectByName('spot');
  spot.position.y = -agl;
  spot.scale.setScalar(size * 0.9);

  const ring = g.getObjectByName('ring');
  ring.visible = selected;
  if (selected) {
    ring.position.y = -agl;
    ring.scale.setScalar(size * 1.1);
  }
}

/** 機体モデルの最下点（単位空間）。機種ごとに一度だけ測って覚える。 */
const floorCache = new Map();
function bodyFloorOf(spec) {
  if (floorCache.has(spec.id)) return floorCache.get(spec.id);
  const geo = getJetGeometry(spec.shape, spec.id);
  if (!geo.boundingBox) geo.computeBoundingBox();
  const y = geo.boundingBox.min.y;
  floorCache.set(spec.id, y);
  return y;
}

// ================================================================ 地上ユニット

const TARGET_PX_GROUND = 26;

/** 地上ユニットの表示倍率。引きの画でも点にならないよう最低サイズを保証する。 */
export function groundDisplayScale(cameraDistance, camera, realSize) {
  const metersPerPixel =
    2 * cameraDistance * Math.tan((camera.fov * Math.PI / 180) / 2) / window.innerHeight;
  return Math.max(1, (metersPerPixel * TARGET_PX_GROUND) / realSize);
}

function boxMesh(w, h, d, color, x = 0, y = 0, z = 0, material = null) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material || getMaterial(color));
  m.position.set(x, y + h / 2, z);
  return m;
}

/** 地上・水上ユニットのローポリ表示を作る（単位空間: 全長1.0） */
export function createGroundView(gu) {
  const spec = gu.spec;
  const group = new THREE.Group();
  group.name = `unit-${gu.id}`;

  const shape = new THREE.Group();
  shape.name = 'shape';
  const c = spec.color;
  const dark = new THREE.Color(c).multiplyScalar(0.65).getHex();

  switch (spec.category) {
    case 'radar': {
      shape.add(boxMesh(0.5, 0.16, 0.5, dark, 0, 0, 0));
      const dish = new THREE.Mesh(
        new THREE.ConeGeometry(0.34, 0.30, 8, 1, true), getMaterial(c));
      dish.position.set(0, 0.42, 0);
      dish.rotation.set(Math.PI * 0.62, 0, 0);
      shape.add(dish);
      shape.add(boxMesh(0.10, 0.28, 0.10, dark, 0, 0.14, 0));
      break;
    }
    case 'sam': {
      shape.add(boxMesh(0.62, 0.18, 0.46, dark));
      for (const s of [-1, 1]) {
        const rail = boxMesh(0.10, 0.07, 0.52, c, s * 0.15, 0.20, 0);
        rail.rotation.x = -0.42;
        shape.add(rail);
      }
      break;
    }
    case 'aaa': {
      shape.add(boxMesh(0.44, 0.16, 0.44, dark));
      const barrel = boxMesh(0.07, 0.07, 0.42, c, 0, 0.20, -0.10);
      barrel.rotation.x = -0.55;
      shape.add(barrel);
      break;
    }
    case 'airbase': {
      // 滑走路は**ローカル -Z 方向**に伸ばす。
      // 表示は rotation.y = -heading で回すので、-Z が sim 側の
      // runwayDir = (sin h, 0, -cos h) と一致する。機体モデルの機首も -Z。
      // ここを X 方向に描くと、見た目の滑走路が実際の離着陸方向と90度ずれる。
      // boxMesh は「与えた y に底面を置く」。滑走路とエプロンは
      // **天面**を飛行場の標高（y=0）に合わせないと、その厚みぶんだけ
      // 路面が持ち上がり、駐機中の機体が路面に埋まって見える。
      shape.add(boxMesh(0.20, 0.012, 1.7, 0x3a3a38, 0, -0.012, 0,
        getPavementMaterial(0x3a3a38)));                                // 滑走路
      // エプロン・管制塔・格納庫は滑走路の脇（+X）、進入端の側（+Z）にまとめる
      shape.add(boxMesh(0.42, 0.02, 0.30, 0x44443f, 0.34, -0.02, 0.55,
        getPavementMaterial(0x44443f)));                                // エプロン
      shape.add(boxMesh(0.10, 0.22, 0.10, c, 0.34, 0, 0.55));         // 管制塔
      for (let i = 0; i < 3; i++) {
        shape.add(boxMesh(0.16, 0.09, 0.16, dark, 0.34, 0, 0.30 - i * 0.24));
      }
      // 滑走路灯。両端に置いて、点滅で「生きている飛行場」だと分かるようにする。
      for (const sz of [-0.85, 0.85]) {
        const lamp = new THREE.Mesh(
          new THREE.SphereGeometry(0.05, 6, 4),
          new THREE.MeshBasicMaterial({
            color: gu.side === 'red' ? 0xff7a52 : 0x8fe6ff,
            transparent: true, depthTest: false,
          }),
        );
        lamp.position.set(0, 0.04, sz);
        lamp.renderOrder = 6;
        lamp.name = 'beacon';
        shape.add(lamp);
      }
      // 管制塔の回転灯
      const beacon = new THREE.Mesh(
        new THREE.SphereGeometry(0.055, 6, 4),
        new THREE.MeshBasicMaterial({ color: 0xffd070, transparent: true, depthTest: false }),
      );
      beacon.position.set(0.34, 0.25, 0.55);
      beacon.renderOrder = 6;
      beacon.name = 'beacon';
      shape.add(beacon);
      break;
    }
    case 'ship': {
      const hull = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.10, 1.0), getMaterial(dark));
      hull.position.y = 0.03;
      shape.add(hull);
      shape.add(boxMesh(0.18, 0.16, 0.34, c, 0, 0.08, 0.05));
      shape.add(boxMesh(0.06, 0.22, 0.06, c, 0, 0.24, 0.10));
      break;
    }
    case 'ground':
    default: {
      for (let i = 0; i < 3; i++) {
        shape.add(boxMesh(0.22, 0.14, 0.40, i === 1 ? c : dark, 0, 0, -0.45 + i * 0.45));
      }
      break;
    }
  }
  group.add(shape);

  // 接地マーカー
  const spot = new THREE.Mesh(
    new THREE.RingGeometry(0.55, 0.68, 20),
    new THREE.MeshBasicMaterial({
      color: RING_COLOR[gu.side] ?? 0x888888,
      transparent: true, opacity: 0.5, side: THREE.DoubleSide,
    }),
  );
  spot.rotation.x = -Math.PI / 2;
  spot.position.y = 2;
  spot.name = 'spot';
  group.add(spot);

  group.userData.unit = gu;
  gu.view = group;
  return group;
}

export function syncGroundView(gu, scale, visible = true) {
  const g = gu.view;
  if (!g) return;
  g.visible = gu.alive && visible;
  if (!g.visible) return;
  g.position.copy(gu.pos);
  g.rotation.y = -gu.heading;
  const size = gu.spec.size * scale;
  const shape = g.getObjectByName('shape');
  shape.scale.setScalar(size);
  const spot = g.getObjectByName('spot');
  spot.scale.setScalar(size);

  // 飛行場の灯火。実時間で点滅させる（シミュレーションの状態は持たない）
  if (gu.spec.category === 'airbase') {
    const t = performance.now() * 0.001;
    let i = 0;
    shape.traverse((o) => {
      if (o.name !== 'beacon') return;
      const phase = t * 1.6 + (i++) * 0.7;
      o.material.opacity = 0.35 + 0.65 * Math.pow(Math.max(0, Math.sin(phase)), 6);
    });
  }
}

// ================================================================ ラベル

const labelCache = new Map();

/** 文字列からスプライト用のマテリアルを作る（キャッシュ付き） */
export function getLabelMaterial(text, color = '#ffffff') {
  const key = `${text}|${color}`;
  if (labelCache.has(key)) return labelCache.get(key);
  return buildLabelMaterial(text, color, key);
}

/** 文字列からスプライトを作る（キャッシュ付き） */
export function makeLabelSprite(text, color = '#ffffff') {
  return new THREE.Sprite(getLabelMaterial(text, color));
}

function buildLabelMaterial(text, color, key) {
  const pad = 8, fontSize = 34;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  ctx.font = `${fontSize}px Consolas, "MS Gothic", monospace`;
  const w = Math.ceil(ctx.measureText(text).width) + pad * 2;
  canvas.width = w;
  canvas.height = fontSize + pad * 2;

  const c2 = canvas.getContext('2d');
  c2.font = `${fontSize}px Consolas, "MS Gothic", monospace`;
  c2.fillStyle = 'rgba(6, 12, 14, 0.62)';
  c2.fillRect(0, 0, canvas.width, canvas.height);
  c2.fillStyle = color;
  c2.textBaseline = 'middle';
  c2.fillText(text, pad, canvas.height / 2);

  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
  mat.userData.aspect = canvas.width / canvas.height;
  labelCache.set(key, mat);
  return mat;
}
