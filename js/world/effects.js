// ミサイル・デコイ・爆発・粒子演出の描画。
// シミュレーション側（sim/missile.js）の状態を毎フレーム反映するだけで、
// ここには当たり判定やゲームロジックを持たせない。
//
// 粒子について:
// - 煙・火花は 2 つの THREE.Points にまとめて 1 ドローコールずつで描く。
//   個別メッシュにすると乱戦で数百ドローコールになり、地形より重くなる。
// - 粒子の大きさは「画面上のピクセル」で指定する。機体表示（models.js）が
//   ズームに依存しない大きさなので、粒子だけ実寸だと縮尺が合わない。

import * as THREE from 'three';

const MISSILE_COLOR = { blue: 0x9fd8ff, red: 0xffb08a };
const TRAIL_COLOR = { blue: 0x7ab8d8, red: 0xd89878 };
const MAX_TRAIL = 40;

const SMOKE_CAP = 1400;
const SPARK_CAP = 900;

const PARTICLE_VERT = `
attribute float aSize;
attribute float aAlpha;
attribute vec3 aColor;
varying float vAlpha;
varying vec3 vColor;
void main() {
  vAlpha = aAlpha;
  vColor = aColor;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize;
  gl_Position = projectionMatrix * mv;
}`;

const PARTICLE_FRAG = `
varying float vAlpha;
varying vec3 vColor;
void main() {
  vec2 c = gl_PointCoord - vec2(0.5);
  float d = dot(c, c);
  if (d > 0.25) discard;
  float a = vAlpha * (1.0 - d * 4.0);
  gl_FragColor = vec4(vColor, a);
}`;

/** 同種の粒子をまとめて 1 つの Points で描く */
class ParticleField {
  constructor(capacity, additive) {
    this.capacity = capacity;
    this.list = [];

    const geo = new THREE.BufferGeometry();
    const mk = (n) => new THREE.BufferAttribute(
      new Float32Array(capacity * n), n).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', mk(3));
    geo.setAttribute('aColor', mk(3));
    geo.setAttribute('aSize', mk(1));
    geo.setAttribute('aAlpha', mk(1));
    geo.setDrawRange(0, 0);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);

    const mat = new THREE.ShaderMaterial({
      vertexShader: PARTICLE_VERT,
      fragmentShader: PARTICLE_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });

    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = additive ? 6 : 3;
    this.geo = geo;
  }

  /**
   * @param {object} o {x,y,z,vx,vy,vz,life,color:[r,g,b],size0,size1,alpha,drag,grav}
   */
  emit(o) {
    if (this.list.length >= this.capacity) return;
    o.t = 0;
    this.list.push(o);
  }

  update(dt) {
    const pos = this.geo.attributes.position.array;
    const col = this.geo.attributes.aColor.array;
    const siz = this.geo.attributes.aSize.array;
    const alp = this.geo.attributes.aAlpha.array;

    let n = 0;
    for (let i = 0; i < this.list.length; i++) {
      const p = this.list[i];
      p.t += dt;
      if (p.t >= p.life) continue;

      const k = 1 - p.drag * dt;
      p.vx *= k; p.vy *= k; p.vz *= k;
      p.vy += (p.grav || 0) * dt;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;

      const f = p.t / p.life;
      pos[n * 3] = p.x; pos[n * 3 + 1] = p.y; pos[n * 3 + 2] = p.z;
      col[n * 3] = p.color[0]; col[n * 3 + 1] = p.color[1]; col[n * 3 + 2] = p.color[2];
      siz[n] = p.size0 + (p.size1 - p.size0) * f;
      // 出はじめを立ち上げ、後半でゆっくり消す。
      // 完全にゼロから始めると、一時停止中に出た粒子が見えないままになる。
      alp[n] = p.alpha * Math.min(1, 0.3 + f * 6) * (1 - f);
      n++;

      this.list[n - 1] = p;
    }
    this.list.length = n;

    this.geo.setDrawRange(0, n);
    if (n > 0) {
      this.geo.attributes.position.needsUpdate = true;
      this.geo.attributes.aColor.needsUpdate = true;
      this.geo.attributes.aSize.needsUpdate = true;
      this.geo.attributes.aAlpha.needsUpdate = true;
    }
  }
}

export class Effects {
  constructor(root) {
    this.root = root;
    this.group = new THREE.Group();
    this.group.name = 'effects';
    root.add(this.group);

    this.missileViews = new Map();
    this.decoyViews = new Map();
    this.explosions = [];
    this.tracers = [];
    this.rings = [];
    this.emitters = [];        // 時間をかけて出し続ける煙（撃破後の火災など）

    this.smoke = new ParticleField(SMOKE_CAP, false);
    this.sparks = new ParticleField(SPARK_CAP, true);
    this.group.add(this.smoke.points);
    this.group.add(this.sparks.points);

    /** 爆発が起きたときに呼ばれる（音響を繋ぐためのフック） */
    this.onExplosion = null;

    this._missileGeo = new THREE.ConeGeometry(0.12, 1, 5);
    this._missileGeo.rotateX(-Math.PI / 2);       // 先端を -Z へ
    this._explosionGeo = new THREE.IcosahedronGeometry(1, 0);
    this._ringGeo = new THREE.RingGeometry(0.86, 1.0, 32);
    this._ringGeo.rotateX(-Math.PI / 2);

    this._px = 1;              // 1ピクセルあたりの世界長（毎フレーム更新）
  }

  // ------------------------------------------------------------ 爆発

  /**
   * 爆発を1つ足す。
   * @param {THREE.Vector3} pos
   * @param {number} size 爆発の見かけの半径(m)
   * @param {'air'|'ground'} kind 地表なら衝撃波の輪と土煙を足す
   */
  explosion(pos, size = 250, kind = 'air') {
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffb648, wireframe: true, transparent: true, opacity: 0.95, depthTest: false,
    });
    const mesh = new THREE.Mesh(this._explosionGeo, mat);
    mesh.position.copy(pos);
    mesh.scale.setScalar(size * 0.25);
    mesh.renderOrder = 7;
    this.group.add(mesh);
    this.explosions.push({ mesh, life: 0, max: 0.75, size });

    const big = Math.min(2.2, size / 260);

    // 火の粉
    const sparks = Math.round(10 + big * 12);
    for (let i = 0; i < sparks; i++) {
      const s = 70 + Math.random() * 190 * big;
      const dir = randomDir();
      this.sparks.emit({
        x: pos.x, y: pos.y, z: pos.z,
        vx: dir.x * s, vy: dir.y * s + 20, vz: dir.z * s,
        life: 0.35 + Math.random() * 0.55,
        color: [1, 0.62 + Math.random() * 0.3, 0.24],
        size0: 5 + big * 3, size1: 1, alpha: 1, drag: 1.6, grav: -70,
      });
    }

    // 煙
    const puffs = Math.round(6 + big * 8);
    for (let i = 0; i < puffs; i++) {
      const dir = randomDir();
      const s = 20 + Math.random() * 60 * big;
      const v = 0.34 + Math.random() * 0.16;
      this.smoke.emit({
        x: pos.x, y: pos.y, z: pos.z,
        vx: dir.x * s, vy: Math.abs(dir.y) * s * 0.7 + 12, vz: dir.z * s,
        life: 1.6 + Math.random() * 1.8,
        color: [v, v * 0.94, v * 0.90],
        size0: 10 + big * 6, size1: 34 + big * 26, alpha: 0.75, drag: 1.0, grav: 3,
      });
    }

    if (kind === 'ground') {
      this.shockwave(pos, size * 6);
      // 舞い上がる土煙
      for (let i = 0; i < 10; i++) {
        const a = Math.random() * Math.PI * 2;
        const s = 40 + Math.random() * 90 * big;
        this.smoke.emit({
          x: pos.x, y: pos.y + 8, z: pos.z,
          vx: Math.cos(a) * s, vy: 6 + Math.random() * 16, vz: Math.sin(a) * s,
          life: 2.2 + Math.random() * 1.6,
          color: [0.50, 0.44, 0.35],
          size0: 12, size1: 52 + big * 24, alpha: 0.62, drag: 1.5, grav: 1,
        });
      }
    }

    if (this.onExplosion) this.onExplosion(pos, size, kind);
  }

  /** 地表を走る衝撃波の輪 */
  shockwave(pos, radius) {
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffd9a0, transparent: true, opacity: 0.55,
      side: THREE.DoubleSide, depthTest: false,
    });
    const mesh = new THREE.Mesh(this._ringGeo, mat);
    mesh.position.set(pos.x, pos.y + 12, pos.z);
    mesh.renderOrder = 5;
    this.group.add(mesh);
    this.rings.push({ mesh, life: 0, max: 0.7, radius });
  }

  /**
   * 撃破された機体の残骸。破片が尾を引いて落ちていく。
   * @param {THREE.Vector3} vel 撃墜時の速度（残骸が慣性で飛ぶ）
   */
  wreck(pos, vel, kind = 'aircraft') {
    const air = kind === 'aircraft';
    const n = air ? 7 : 5;
    for (let i = 0; i < n; i++) {
      const dir = randomDir();
      const s = 40 + Math.random() * 90;
      this.emitters.push({
        x: pos.x, y: pos.y, z: pos.z,
        vx: (vel ? vel.x * 0.55 : 0) + dir.x * s,
        vy: (vel ? vel.y * 0.5 : 0) + dir.y * s * 0.6 + 10,
        vz: (vel ? vel.z * 0.55 : 0) + dir.z * s,
        life: air ? 3.2 + Math.random() * 2.4 : 1.6,
        t: 0, acc: 0, rate: 0.035,
        grav: -68, drag: 0.28,
        color: [0.20, 0.19, 0.19], size0: 8, size1: 28, alpha: 0.8,
        ember: true,
      });
    }
    if (!air) this.fire(pos, 7);
  }

  /** その場で燃え続ける火災（地上目標の撃破跡） */
  fire(pos, seconds = 6) {
    this.emitters.push({
      x: pos.x, y: pos.y + 6, z: pos.z,
      vx: 0, vy: 0, vz: 0,
      life: seconds, t: 0, acc: 0, rate: 0.07,
      grav: 0, drag: 0,
      color: [0.17, 0.16, 0.16], size0: 14, size1: 70, alpha: 0.65,
      rise: 34, ember: true, spread: 24,
    });
  }

  /** ミサイル発射の閃光と噴煙 */
  launchFlash(pos, dir) {
    this.sparks.emit({
      x: pos.x, y: pos.y, z: pos.z, vx: 0, vy: 0, vz: 0,
      life: 0.16, color: [1, 0.86, 0.6],
      size0: 26, size1: 6, alpha: 1, drag: 0, grav: 0,
    });
    const bx = dir ? -dir.x : 0, by = dir ? -dir.y : 0, bz = dir ? -dir.z : 0;
    for (let i = 0; i < 7; i++) {
      const r = randomDir();
      this.smoke.emit({
        x: pos.x, y: pos.y, z: pos.z,
        vx: bx * 90 + r.x * 26, vy: by * 90 + r.y * 26, vz: bz * 90 + r.z * 26,
        life: 0.9 + Math.random() * 0.7,
        color: [0.74, 0.74, 0.76],
        size0: 6, size1: 24, alpha: 0.6, drag: 2.2, grav: -4,
      });
    }
  }

  /** 機銃の発砲炎 */
  muzzle(pos) {
    this.sparks.emit({
      x: pos.x, y: pos.y, z: pos.z, vx: 0, vy: 0, vz: 0,
      life: 0.1, color: [1, 0.9, 0.55],
      size0: 12, size1: 3, alpha: 0.95, drag: 0, grav: 0,
    });
  }

  /** 被弾した機体が引く黒煙（1粒） */
  damageSmoke(pos, vel, severity) {
    const v = 0.24 - severity * 0.14;
    this.smoke.emit({
      x: pos.x, y: pos.y, z: pos.z,
      vx: vel.x * 0.12 + (Math.random() - 0.5) * 12,
      vy: vel.y * 0.12 + 4,
      vz: vel.z * 0.12 + (Math.random() - 0.5) * 12,
      life: 1.8 + severity * 1.6,
      color: [v, v, v],
      size0: 5, size1: 22 + severity * 24, alpha: 0.34 + severity * 0.4,
      drag: 0.9, grav: -2,
    });
    if (severity > 0.6 && Math.random() < 0.3) {
      this.sparks.emit({
        x: pos.x, y: pos.y, z: pos.z, vx: 0, vy: 0, vz: 0,
        life: 0.25, color: [1, 0.55, 0.2],
        size0: 7, size1: 2, alpha: 0.8, drag: 0, grav: 0,
      });
    }
  }

  /** 対空砲の曳光弾（短時間だけ残る線） */
  tracer(from, to, side) {
    const geo = new THREE.BufferGeometry().setFromPoints([from.clone(), to.clone()]);
    const mat = new THREE.LineBasicMaterial({
      color: side === 'red' ? 0xffb060 : 0x9fd8ff,
      transparent: true, opacity: 0.8, depthTest: false,
    });
    const line = new THREE.Line(geo, mat);
    line.renderOrder = 6;
    line.frustumCulled = false;
    this.group.add(line);
    this.tracers.push({ line, life: 0, max: 0.35 });
  }

  // ------------------------------------------------------------ 毎フレーム

  /**
   * @param {number} size 機体表示長(m)。ミサイルもこれに合わせて見えるサイズにする。
   */
  update(dt, world, size) {
    this._syncMissiles(world, size);
    this._syncDecoys(world, size);
    this._updateExplosions(dt);
    this._updateRings(dt);
    this._updateTracers(dt);
    this._updateEmitters(dt);
    this._updateDamageTrails(dt, world);
    this.smoke.update(dt);
    this.sparks.update(dt);
  }

  /** 損傷した機体が黒煙を引く。損傷が深いほど濃く長い。 */
  _updateDamageTrails(dt, world) {
    for (const u of world.units) {
      if (!u.alive || u.kind !== 'aircraft' || u.onGround) continue;
      const r = u.hp / u.maxHp;
      if (r > 0.72) continue;
      const severity = Math.min(1, (0.72 - r) / 0.62);
      u._smokeT = (u._smokeT || 0) + dt;
      const interval = 0.16 - severity * 0.10;
      if (u._smokeT < interval) continue;
      u._smokeT = 0;
      u.forward(_vel).multiplyScalar(-u.speed);
      this.damageSmoke(u.pos, _vel, severity);
    }
  }

  _updateEmitters(dt) {
    for (let i = this.emitters.length - 1; i >= 0; i--) {
      const e = this.emitters[i];
      e.t += dt;
      if (e.t >= e.life) { this.emitters.splice(i, 1); continue; }

      if (e.drag) {
        const k = 1 - e.drag * dt;
        e.vx *= k; e.vy *= k; e.vz *= k;
      }
      e.vy += (e.grav || 0) * dt;
      e.x += e.vx * dt; e.y += e.vy * dt; e.z += e.vz * dt;

      e.acc += dt;
      while (e.acc >= e.rate) {
        e.acc -= e.rate;
        const sp = e.spread || 6;
        this.smoke.emit({
          x: e.x + (Math.random() - 0.5) * sp,
          y: e.y, z: e.z + (Math.random() - 0.5) * sp,
          vx: (Math.random() - 0.5) * 14, vy: (e.rise || 6) + Math.random() * 8,
          vz: (Math.random() - 0.5) * 14,
          life: 1.8 + Math.random() * 1.6,
          color: e.color, size0: e.size0, size1: e.size1, alpha: e.alpha,
          drag: 0.7, grav: 1,
        });
        if (e.ember && Math.random() < 0.5) {
          this.sparks.emit({
            x: e.x, y: e.y, z: e.z,
            vx: (Math.random() - 0.5) * 20, vy: 10 + Math.random() * 25,
            vz: (Math.random() - 0.5) * 20,
            life: 0.3 + Math.random() * 0.4,
            color: [1, 0.5 + Math.random() * 0.3, 0.18],
            size0: 5, size1: 1, alpha: 0.9, drag: 1.2, grav: -30,
          });
        }
      }
    }
  }

  _updateRings(dt) {
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i];
      r.life += dt;
      const t = r.life / r.max;
      if (t >= 1) {
        this.group.remove(r.mesh);
        r.mesh.material.dispose();
        this.rings.splice(i, 1);
        continue;
      }
      r.mesh.scale.setScalar(r.radius * (0.1 + t * 0.9));
      r.mesh.material.opacity = 0.55 * (1 - t);
    }
  }

  _updateTracers(dt) {
    for (let i = this.tracers.length - 1; i >= 0; i--) {
      const t = this.tracers[i];
      t.life += dt;
      if (t.life >= t.max) {
        this.group.remove(t.line);
        t.line.geometry.dispose();
        t.line.material.dispose();
        this.tracers.splice(i, 1);
        continue;
      }
      t.line.material.opacity = 0.8 * (1 - t.life / t.max);
    }
  }

  _syncMissiles(world, size) {
    const seen = new Set();
    for (const m of world.missiles) {
      seen.add(m.id);
      let v = this.missileViews.get(m.id);
      if (!v) {
        const color = MISSILE_COLOR[m.side] ?? 0xffffff;
        const body = new THREE.Mesh(this._missileGeo, new THREE.MeshBasicMaterial({ color }));
        const trailGeo = new THREE.BufferGeometry();
        trailGeo.setAttribute('position',
          new THREE.BufferAttribute(new Float32Array(MAX_TRAIL * 3), 3).setUsage(THREE.DynamicDrawUsage));
        trailGeo.setDrawRange(0, 0);
        const trail = new THREE.Line(trailGeo, new THREE.LineBasicMaterial({
          color: TRAIL_COLOR[m.side] ?? 0xaaaaaa, transparent: true, opacity: 0.55, depthTest: false,
        }));
        trail.frustumCulled = false;
        trail.renderOrder = 4;
        this.group.add(body);
        this.group.add(trail);
        v = { body, trail };
        this.missileViews.set(m.id, v);
      }

      v.body.position.copy(m.pos);
      v.body.scale.setScalar(size * 0.45);
      // 進行方向へ向ける
      _look.copy(m.pos).add(m.dir);
      v.body.lookAt(_look);

      const arr = v.trail.geometry.attributes.position.array;
      const n = Math.min(MAX_TRAIL, m.trail.length);
      for (let i = 0; i < n; i++) {
        const p = m.trail[m.trail.length - n + i];
        arr[i * 3] = p.x; arr[i * 3 + 1] = p.y; arr[i * 3 + 2] = p.z;
      }
      v.trail.geometry.attributes.position.needsUpdate = true;
      v.trail.geometry.setDrawRange(0, n);
      v.trail.material.opacity = m.lost ? 0.2 : 0.55;
    }

    for (const [id, v] of this.missileViews) {
      if (seen.has(id)) continue;
      this.group.remove(v.body);
      this.group.remove(v.trail);
      v.trail.geometry.dispose();
      this.missileViews.delete(id);
    }
  }

  _syncDecoys(world, size) {
    const seen = new Set();
    for (const d of world.decoys) {
      seen.add(d.id);
      let v = this.decoyViews.get(d.id);
      if (!v) {
        const color = d.kind === 'flare' ? 0xffd070 : 0xcfd6dc;
        v = new THREE.Mesh(
          new THREE.SphereGeometry(1, 5, 3),
          new THREE.MeshBasicMaterial({ color, transparent: true, depthTest: false }),
        );
        v.renderOrder = 5;
        this.group.add(v);
        this.decoyViews.set(d.id, v);
      }
      v.position.copy(d.pos);
      v.scale.setScalar(size * 0.16);
      v.material.opacity = Math.max(0, d.life / 6);

      // フレアは火の粉を撒きながら落ちる
      if (d.kind === 'flare' && Math.random() < 0.55) {
        this.sparks.emit({
          x: d.pos.x, y: d.pos.y, z: d.pos.z,
          vx: (Math.random() - 0.5) * 18, vy: -8, vz: (Math.random() - 0.5) * 18,
          life: 0.4 + Math.random() * 0.4,
          color: [1, 0.82, 0.42],
          size0: 6, size1: 1, alpha: Math.max(0, d.life / 6), drag: 1, grav: -30,
        });
      }
    }
    for (const [id, v] of this.decoyViews) {
      if (seen.has(id)) continue;
      this.group.remove(v);
      v.geometry.dispose();
      this.decoyViews.delete(id);
    }
  }

  _updateExplosions(dt) {
    for (let i = this.explosions.length - 1; i >= 0; i--) {
      const e = this.explosions[i];
      e.life += dt;
      const t = e.life / e.max;
      if (t >= 1) {
        this.group.remove(e.mesh);
        e.mesh.material.dispose();
        this.explosions.splice(i, 1);
        continue;
      }
      e.mesh.scale.setScalar(e.size * (0.25 + t * 1.5));
      e.mesh.material.opacity = 0.95 * (1 - t);
    }
  }
}

const _look = new THREE.Vector3();
const _vel = new THREE.Vector3();

function randomDir() {
  const z = Math.random() * 2 - 1;
  const a = Math.random() * Math.PI * 2;
  const r = Math.sqrt(1 - z * z);
  return { x: Math.cos(a) * r, y: z, z: Math.sin(a) * r };
}
