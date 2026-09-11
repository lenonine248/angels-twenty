// 雲の描画。仕様書 §88.9。
//
// **繋がった雲は継ぎ目なく1つに見せる。**
//
// 継ぎ目の正体は**重なった塊の「内側の面」**だった。
// 半透明のまま重ねると、手前の面の向こうに隠れた面まで混ざるので、
// 塊ごとの輪郭が線として浮き、濃さも積み上がる。
// 平坦→滑らかにしても、1メッシュに合成しても、そこは消えなかった。
//
// **深度だけ書くパスを先に走らせ、その深度と一致する所だけ塗る**（2パス）:
//
//   1. `colorWrite: false` で深度だけ書く → union のいちばん手前の面が残る
//   2. `depthFunc: EqualDepth` で塗る    → **その面だけが1回だけ塗られる**
//
// 内部の面は深度が一致しないので塗られない。結果として
// **繋がっている塊は縁のない1つの塊**になり、濃さも一定になる。
// 層の中にカメラを入れても崩れない（実測）。
//
// 形のほうは `CLOUD_SHAPE`（`world/clouds.js`）で選ぶ ——
// **見た目と当たり判定は同じ形**なので、そちらは遊びも変わる。
//
// **カメラより下にある層は薄くする**（プレイヤーの決め）。
// 見下ろしているだけで戦域が真っ白になるのでは、指揮の道具にならない。

import * as THREE from 'three';

/**
 * 雲の色と、陰側の持ち上げ。
 *
 * **平坦シェーディングをやめ、自発光を足した。**
 * 地形と同じ平坦シェーディングで暗い灰色にすると、
 * **雲ではなく岩山に見えた**（実際そう見えた）。
 * 滑らかな法線と明るい色、そして陰側が落ちすぎないだけの自発光にすると、
 * ようやく「柔らかい塊」として読める。
 */
const CLOUD_COLOR = 0xeaf1f8;
const CLOUD_EMISSIVE = 0.45;

/**
 * 不透明度: 層と同じ高さにいるとき / 遥か上から見下ろしたとき。
 *
 * 「見下ろしても視界が潰れない」と「雲があると分かる」の両方が要る。
 *
 * **この2つの値は一度、間違った背景の上で決めていた。** 深度パスが
 * 地形より先に走っていたころ（下の `depthMat` の注記）は、雲の向こうに
 * **地形ではなく背景色**があった。そこへ薄い白を乗せていたので、
 * 0.32 で「ちょうど見える」に見えていた —— 実際に見えていたのは
 * **地形に開いた空色の穴**で、白はほとんど効いていない。
 *
 * 地形の上に乗るようになった今、0.32 では**霞にしかならない。**
 * 濃くしても視界は潰れない —— **邪魔な所はカーソルの穴が開ける**（§88.13）。
 * 既定の視点（14km前後）だと穴の直径は 16km 前後あるので、
 * 見ようとしている所は濃さと関係なく見える。
 *
 * 調整は `AT.cloudDensity(near, far)`（デバッグ限定）。
 */
const OPACITY_NEAR = 0.85;
const OPACITY_FAR = 0.80;
/** カメラが層の上端からこれだけ離れると `OPACITY_FAR` まで薄くなる(m) */
const FADE_SPAN = 6000;

/** 塊1つの分割数。低いほど低ポリらしく、頂点も減る */
const BLOB_DETAIL = 1;

/**
 * 透かす範囲（§88.13・プレイヤーの案）。
 *
 * **見た目と見やすさは両立できる** —— 雲を薄くするのではなく、
 * **邪魔になる所だけ**開ける:
 *
 * | | |
 * |---|---|
 * | カメラのすぐ手前 | 顔に貼り付いた雲で画面が潰れない |
 * | カーソルの周り | **見ようとしている所が見える** |
 *
 * どちらもフラグメント単位なので、層そのものの濃さ（§88.9）は保ったまま。
 */
const NEAR_FADE_IN = 900;      // これより手前は完全に透ける(m)
const NEAR_FADE_OUT = 4200;    // ここまでで元の濃さへ戻る(m)
/**
 * カーソルの周りを開ける半径。**カメラからの距離に比例させる。**
 *
 * メートルで固定すると、寄れば画面いっぱいに穴が開き、引けば点にしかならない。
 * **画面上で同じ大きさに見える**ほうが道具として使える。
 */
const CURSOR_RADIUS_FRAC = 0.35;
const CURSOR_RADIUS_MIN = 1600;
const CURSOR_RADIUS_MAX = 9000;
const CURSOR_RADIUS = 5200;    // コンパイル時の初期値（毎フレーム上書きする）
const CURSOR_SOFT = 0.45;      // 内側どこまでを完全に透かすか（半径に対する割合）

const _p = new THREE.Vector3();
const _n = new THREE.Vector3();
const _pos = new THREE.Vector3();
const _scl = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _nm = new THREE.Matrix3();
const UP = new THREE.Vector3(0, 1, 0);
const _ray = new THREE.Raycaster();

/** カーソルが画面外・後方のときに置く座標（実質「掛からない」） */
const FAR_AWAY = 1e9;

/**
 * 差し込む GLSL（§88.13）。**アルファだけを触る。**
 * 層の濃さ（`opacity`）はそのままなので、見た目の設計は §88.9 のまま。
 */
const VERT_HEAD = 'varying vec3 vCloudWorld;\n';
const VERT_BODY = `#include <project_vertex>
  vCloudWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;`;
const FRAG_HEAD = `varying vec3 vCloudWorld;
uniform vec3 uCursor;
uniform float uCursorR;
uniform vec2 uNear;
`;
const FRAG_BODY = `  // カメラのすぐ手前は透かす（顔に貼り付いた雲で画面を潰さない）
  diffuseColor.a *= smoothstep(uNear.x, uNear.y, distance(cameraPosition, vCloudWorld));
  // カーソルの周りは透かす（見ようとしている所が見える）
  diffuseColor.a *= smoothstep(uCursorR * ${CURSOR_SOFT}, uCursorR,
    distance(uCursor.xz, vCloudWorld.xz));
#include <opaque_fragment>`;

/**
 * 塊の集まりを**1つのジオメトリ**にする。
 *
 * `BufferGeometryUtils` は同梱していないので手で合成する ——
 * 頂点を並べ替えるだけなので、外から持ってくる値打ちが無い。
 */
function mergeBlobs(blobs) {
  let src = new THREE.IcosahedronGeometry(1, BLOB_DETAIL);
  if (src.index) src = src.toNonIndexed();
  const sp = src.attributes.position.array;
  const sn = src.attributes.normal.array;
  const per = sp.length;
  const pos = new Float32Array(per * blobs.length);
  const nor = new Float32Array(per * blobs.length);

  let o = 0;
  for (const c of blobs) {
    _pos.set(c.x, c.y, c.z);
    // 塊ごとに向きを散らす。同じ球が並ぶと格子に見える
    _q.setFromAxisAngle(UP, (c.x + c.z) % Math.PI);
    _scl.set(c.rx, c.ry, c.rz);
    _m.compose(_pos, _q, _scl);
    _nm.getNormalMatrix(_m);
    for (let i = 0; i < per; i += 3) {
      _p.set(sp[i], sp[i + 1], sp[i + 2]).applyMatrix4(_m);
      pos[o + i] = _p.x; pos[o + i + 1] = _p.y; pos[o + i + 2] = _p.z;
      _n.set(sn[i], sn[i + 1], sn[i + 2]).applyMatrix3(_nm).normalize();
      nor[o + i] = _n.x; nor[o + i + 1] = _n.y; nor[o + i + 2] = _n.z;
    }
    o += per;
  }
  src.dispose();

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  geo.computeBoundingSphere();
  return geo;
}

export class CloudView {
  constructor(field, sceneRoot) {
    this.field = field;
    this.mesh = null;
    /** 濃さ（§88.9）。**デバッグの調整で書き換える** —— `AT.cloudDensity` */
    this.opacityNear = OPACITY_NEAR;
    this.opacityFar = OPACITY_FAR;
    /**
     * カーソルの穴の大きさ（カメラからの距離に対する割合・§88.13）。
     * **毎フレーム計算し直すので、半径そのものを外から入れても上書きされる** ——
     * 調整はこちらを触る（`AT.cloudPeek`）。
     */
    this.cursorFrac = CURSOR_RADIUS_FRAC;
    this.group = new THREE.Group();
    this.group.name = 'clouds';
    sceneRoot.add(this.group);
    if (!field || !field.active) return;

    const geo = mergeBlobs(field.blobs);

    // 1パス目: 深度だけ書く。色は書かないので画には出ない。
    //
    // **`transparent: true` は消さないこと。** 色を書かない材質に
    // 透明の指定は無意味に見えるが、three.js は**不透明の列と半透明の列を
    // `material.transparent` で分けている** —— `false` にすると
    // このパスが**地形より先**に走り、雲の深度を先に置いてしまう。
    // すると**雲の向こうの地形はそもそも描かれない**ので、
    // 層は「地形に開いた空色の穴」になり、§88.13 で穴を開けても
    // 空色が空色に変わるだけになる（実際そうなっていた）。
    // 半透明の列に入れれば地形の**あと**に走るので、
    // 深度の中身は同じまま、**向こう側が画に残る。**
    this.depthMat = new THREE.MeshBasicMaterial({
      colorWrite: false, depthWrite: true, side: THREE.DoubleSide,
      transparent: true,
    });
    const depthPass = new THREE.Mesh(geo, this.depthMat);
    depthPass.name = 'cloudDepth';
    depthPass.renderOrder = -2;
    this.group.add(depthPass);

    // 2パス目: その深度と一致する所だけ塗る → union の最外面が1回だけ塗られる
    this.mat = new THREE.MeshLambertMaterial({
      color: CLOUD_COLOR,
      // 陰側が暗く落ちると岩に見える。雲は全体が明るい
      emissive: new THREE.Color(CLOUD_COLOR).multiplyScalar(CLOUD_EMISSIVE),
      transparent: true,
      opacity: OPACITY_NEAR,
      // **滑らかに。** 地形が平坦シェーディングなので、
      // ここを分けることで「地形ではないもの」として読める
      flatShading: false,
      depthWrite: false,
      depthFunc: THREE.EqualDepth,
      side: THREE.DoubleSide,
    });
    // **邪魔な所だけ開ける**（§88.13）。層の濃さは変えず、
    // 「カメラのすぐ手前」と「カーソルの周り」のアルファだけ落とす。
    this.mat.onBeforeCompile = (shader) => {
      shader.uniforms.uCursor = { value: new THREE.Vector3(FAR_AWAY, 0, FAR_AWAY) };
      shader.uniforms.uCursorR = { value: CURSOR_RADIUS };
      shader.uniforms.uNear = { value: new THREE.Vector2(NEAR_FADE_IN, NEAR_FADE_OUT) };
      shader.vertexShader = VERT_HEAD + shader.vertexShader
        .replace('#include <project_vertex>', VERT_BODY);
      shader.fragmentShader = FRAG_HEAD + shader.fragmentShader
        .replace('#include <opaque_fragment>', FRAG_BODY);
      this._shader = shader;
    };

    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.name = 'cloudMass';
    this.mesh.renderOrder = -1;
    this.group.add(this.mesh);
  }

  /**
   * カメラの高さで層の濃さを決め（§88.9）、
   * カーソルの位置をシェーダへ渡す（§88.13）。
   *
   * @param {THREE.Vector2} [ndc] 画面上のカーソル（NDC）。無ければ開けない
   */
  update(camera, ndc) {
    if (!this.mesh) return;
    // 風で流れたぶん、**層ごと動かす**（§88.15）。
    // 当たり判定は問い合わせの点を同じ量だけ戻しているので、
    // **見た目と当たり判定は同じ場所にある**（§88.12 の約束）。
    const off = this.field.offset;
    if (off) this.group.position.set(off.x, 0, off.z);
    const above = camera.position.y - this.field.top;
    const t = above <= 0 ? 0 : Math.min(1, above / FADE_SPAN);
    this.mat.opacity = this.opacityNear + (this.opacityFar - this.opacityNear) * t;

    const u = this._shader && this._shader.uniforms.uCursor;
    if (!u) return;
    if (!ndc) { u.value.set(1e9, 0, 1e9); return; }
    // **層の平面と交わる点**を使う。地形へレイを飛ばす必要は無い ——
    // 開けたいのは雲であって地面ではない
    _ray.setFromCamera(ndc, camera);
    const midY = (this.field.base + this.field.top) / 2;
    const d = _ray.ray.direction;
    if (Math.abs(d.y) < 1e-4) { u.value.set(1e9, 0, 1e9); return; }
    const k = (midY - _ray.ray.origin.y) / d.y;
    if (k < 0) { u.value.set(1e9, 0, 1e9); return; }
    u.value.copy(_ray.ray.origin).addScaledVector(d, k);
    // 穴の大きさは**画面上で一定**に見せる（カメラから遠いほど大きく取る）
    this._shader.uniforms.uCursorR.value = Math.min(CURSOR_RADIUS_MAX,
      Math.max(CURSOR_RADIUS_MIN, u.value.distanceTo(camera.position) * this.cursorFrac));
  }

  dispose() {
    this.mesh?.geometry.dispose();
    this.mat?.dispose();
    this.depthMat?.dispose();
    this.group.parent?.remove(this.group);
    this.mesh = null;
  }
}
