// ミサイルの素の性能を測るハーネス。仕様書 §33。
//
//   fetch('/tools/bench.js').then(r => r.text()).then(eval)
//   fetch('/tools/kinematics.js').then(r => r.text()).then(eval)
//   await AT.kin.run()          // 既定の掃引（兵装3種 × 距離 × アスペクト）
//   AT.kin.report()
//   await AT.kin.one('AAM-M', 20, 0)   // 1発だけ詳しく見る
//
// **対抗手段をすべて無効にして、回避軌道だけで振り切れるかを測る。**
//
// デコイ・ノッチ・地面クラッター・照射切れ・終末シーカーの捕捉をすべて外し、
// ミサイルは常に目標の位置を知っている状態にする。残るのは
// **速度・旋回率・エネルギー・警報の遅れ**だけ。
//
// これが要るのは、命中率の議論が対抗手段の話に流れてしまうため。
// 「チャフが強い／弱い」を動かす前に、**チャフが1枚も無いときに
// その距離で当たってよいのか**を先に決めておきたい。
//
// 目標は `sim/aircraft.js` の回避機動をそのまま使う（ビーム→終末ブレイク→降下）。
// 警報の距離（レーダー14km / 赤外線5km）も、AAM-A の中途で気づかれない性質も
// そのまま残す。**外すのは「運が絡む逃げ方」だけ**で、幾何と運動は触らない。

(function () {
  const DT = 1 / 30;
  const MAX_SEC = 120;

  const rows = [];
  let patched = null;

  /**
   * ミサイルの誘導を「絶対に切れない」ものに差し替える。
   *
   * ノッチ・クラッター・地形遮蔽・照射切れ・シーカーの捕捉をまとめて外すため、
   * 個別に潰すのではなく `_updateGuidance` ごと置き換える。
   * こうしないと、どれか1つ外し忘れたときに「何を測っているか」が曖昧になる。
   */
  async function patch() {
    if (patched) return patched;
    const mod = await import('/js/sim/missile.js');
    const M = mod.Missile;
    const orig = M.prototype._updateGuidance;
    M.prototype._updateGuidance = function (dt, world) {
      const t = this.target;
      if (!t || t.alive === false) { this._goStupid('目標消失'); return; }
      // 常に現在位置を知っている。アクティブ弾は最初から掴んでいる扱い
      this.seekTarget = t;
      this.lastKnown.copy(t.pos);
      this.active = true;
    };
    patched = { M, orig };
    return patched;
  }

  function unpatch() {
    if (!patched) return;
    patched.M.prototype._updateGuidance = patched.orig;
    patched = null;
  }

  /** 戦闘を1つ用意して、余計な機体をすべて取り除く */
  function clearField(b) {
    const w = b.world;
    const air = w.units.filter((u) => u.kind === 'aircraft');
    const shooter = air.find((u) => u.side === w.playerSide);
    const target = air.find((u) => u.side !== w.playerSide);
    for (const u of w.units) {
      if (u === shooter || u === target) continue;
      u.alive = false;              // 地上ユニットも黙らせる
      u.weapon = null;
    }
    w.missiles.length = 0;
    w.decoys.length = 0;
    w.bullets.length = 0;
    return { shooter, target };
  }

  /**
   * 1発撃って結末を返す。
   *
   * @param {object} b        戦闘
   * @param {string} weaponId 兵装
   * @param {number} km       発射距離
   * @param {number} aspectDeg 目標の向き。0=こちらへ真っ直ぐ来る / 180=真後ろへ逃げる
   * @param {number} alt      双方の高度(m)
   */
  function shot(b, weaponId, km, aspectDeg, alt, mods = {}) {
    const w = b.world;
    const { shooter, target } = clearField(b);
    if (!shooter || !target) return null;

    const R = km * 1000;
    // **毎回きれいな状態から始める。** 前の1発で目標が落ちていると、
    // 以後の測定がすべて「死んだ相手を撃つ」ことになる（実際そうなっていた）
    for (const u of [shooter, target]) {
      u.alive = true;
      u.hp = u.maxHp;
      u.threats = [];
      u.deathCause = null;
      u.evading = false;
      u.beaming = false;
      u._evadeSide = null;
      u.airbrake = 0;
      // **姿勢も戻す**。位置だけ置き直しても、機体は前の戦闘の目標高度へ
      // 降り続ける —— `pitch` は毎フレーム `atan2(上昇率, 速度)` で引き直されるので、
      // **`desiredAlt` を揃えないと機首が下がったまま**になる。
      // 実測で射手が **pitch -48.9度**（急降下）のまま始まっており、
      // 同高度の目標が**ロック扇の上下±20度の外**に出ていた。
      // そのため `live` 掃引の AAM-M は**全条件で発射2.0秒ちょうどに照射切れ**で死に、
      // 「対抗手段を入れると中距離弾は一発も当たらない」という測り間違いを生む。
      // （`patch()` を使う既定の掃引は `_updateGuidance` ごと差し替えるので影響しない）
      u.desiredAlt = alt;
      u.pitch = 0;
      u.roll = 0;
      u.fuel = u.fuelMax;
      u.flares = u.spec.flares;
      u.chaff = u.spec.chaff;
    }
    w.missiles.length = 0;

    // 射手は原点、目標は +Z 方向へ R 離れた点。射手は目標を向く
    shooter.pos.set(0, alt, 0);
    shooter.heading = Math.PI;                  // +Z 方向（headingOf(0, R) = π）
    // **機首ずれ**（§75）。発射の瞬間に目標からどれだけ外れているか。
    // `combat.fire()` は交戦包絡線を見ないので、ここで向きを変えれば
    // 「横を向いたまま撃った」弾をそのまま測れる。
    if (mods.off) shooter.heading += (mods.off * Math.PI) / 180;
    shooter.speed = shooter.spec.cruiseSpeed * 1.2;
    shooter.onGround = false;
    shooter.state = 'flying';
    shooter.loadout = [weaponId];
    shooter.fireCooldown = 0;
    shooter.radarMode = 'on';

    target.pos.set(0, alt, R);
    // aspect 0 は「射手のほうを向いている」＝ -Z 方向 ＝ heading 0
    target.heading = (aspectDeg * Math.PI) / 180;
    target.speed = target.spec.cruiseSpeed * 1.2;
    target.onGround = false;
    target.state = 'flying';
    target.autoDecoy = !!mods.live;             // 既定では対抗手段を使わせない（§33）
    target.loadout = [];                        // 撃ち返させない
    target.gun = 0;
    target.abMode = 'max';                      // 逃げに全力を出させる
    target.clearOrders();

    // **兵装の性能を差し替えて撃てるようにする**（速度・旋回率の掃引用）。
    // 元の定義を書き換えないよう複製する
    const base = AT.kin.WEAPONS[weaponId];
    const spec = (mods.speed || mods.turnRate)
      ? { ...base, speed: base.speed * (mods.speed ?? 1),
          turnRate: base.turnRate * (mods.turnRate ?? 1) }
      : base;

    // 至近弾は当たっても落ちないことがある。**当たったか**と**落ちたか**を分ける。
    // 場に弾は1発しか無いので、当たった弾を見分ける必要はない
    let hit = false;
    const prevHit = w.onMissileHit;
    w.onMissileHit = (...rest) => { hit = true; prevHit?.(...rest); };

    const m = b.combat.fire(shooter, target, spec);
    if (!m) { w.onMissileHit = prevHit; return { 結末: '発射できず' }; }

    let steps = 0;
    let minDist = Infinity;
    let warned = null;                          // 目標が気づいた時刻(秒)
    while (m.alive && steps < MAX_SEC * 30) {
      // 雲を風で流す（§88.15）。**本体の刻みに足したものはここにも足す** ——
      // このループはゲーム本体の写しなので、忘れると雲だけ止まったまま測る
      w.clouds?.advance(DT);
      for (const u of w.units) if (u.alive) u.update(DT, w);
      w.detection.update(DT);
      b.combat.update(DT);
      steps++;
      const d = m.pos.distanceTo(target.pos);
      if (d < minDist) minDist = d;
      if (warned == null && target.threats && target.threats.length) warned = steps / 30;
      if (!target.alive) break;
    }
    w.onMissileHit = prevHit;

    return {
      w: weaponId,
      km,
      aspect: aspectDeg,
      alt,
      speedX: mods.speed ?? 1,
      turnX: mods.turnRate ?? 1,
      結末: !target.alive ? '撃墜' : (hit ? '至近弾' : '回避'),
      最接近: Math.round(minDist),
      飛翔秒: +(steps / 30).toFixed(1),
      気づいた秒: warned == null ? null : +warned.toFixed(1),
      残速度: Math.round(m.speed),
    };
  }

  /** 戦闘を1つ用意する（ステージ1の地形と機体を借りる） */
  function fresh(seed) {
    return new Promise((resolve) => {
      const prev = AT.battle;
      const setSpeed = AT.loop.setSpeed.bind(AT.loop);
      const setPaused = AT.loop.setPaused.bind(AT.loop);
      AT.loop.setSpeed = () => {};
      AT.loop.setPaused = () => setPaused(true);
      setPaused(true);
      AT.startStage(0, seed);
      const wait = () => {
        if (!AT.battle || AT.battle === prev) { setTimeout(wait, 30); return; }
        AT.loop.setSpeed = setSpeed;
        AT.loop.setPaused = setPaused;
        setPaused(true);
        resolve(AT.battle);
      };
      setTimeout(wait, 40);
    });
  }

  /**
   * 掃引する。距離を細かく分け、兵装とアスペクトごとに測る。
   *
   * 高度は 6000m を既定にする。低すぎると地形が絡み、高すぎると
   * ミサイルの射程が伸びて（§高度の効き方）別の話になる。
   */
  async function run(opts = {}) {
    const weapons = opts.weapons || ['AAM-S', 'AAM-M', 'AAM-A'];
    const ranges = opts.ranges || [2, 4, 6, 8, 10, 12, 14, 16, 18, 20];
    const aspects = opts.aspects || [0, 90, 180];
    const alt = opts.alt ?? 6000;
    const seeds = opts.seeds || [11, 22, 33];
    // **対抗手段を入れたまま測るモード**（§37.5）。
    // 既定（live なし）は素の運動性能を測る道具のままで、こちらは
    // 「デコイもビームも込みで、その距離から撃って何割当たるのか」を測る。
    // 命中期待度の較正はこの数字と突き合わせる — ベンチの命中率は
    // 「AI がその距離で撃つかどうか」に汚染されていて、較正には使えない。
    const live = !!opts.live;
    if (!live) await patch();
    const b = await fresh(seeds[0]);
    for (const wid of weapons) {
      const spec = AT.kin.WEAPONS[wid];
      for (const km of ranges) {
        if (km * 1000 > spec.range * 1.1) continue;      // 射程外は撃てない
        for (const a of aspects) {
          for (const seed of seeds) {
            const r = shot(b, wid, km, a, alt, { live });
            if (r) { r.seed = seed; r.live = live; rows.push(r); }
          }
        }
      }
    }
    if (!live) unpatch();
    return rows.length;
  }

  /** 1発だけ詳しく見る */
  async function one(weaponId, km, aspectDeg, alt = 6000) {
    await patch();
    const b = await fresh(11);
    const r = shot(b, weaponId, km, aspectDeg, alt);
    unpatch();
    console.log(r);
    return r;
  }

  /**
   * 速度の推移を出す（§33）。ブーストと滑空の釣り合いを見るため。
   *
   * ロケットモーターは短時間で燃え尽き、以後は慣性で飛ぶ。
   * **どこまでが推進で、そこから先どれだけ保つのか**が射程と旋回能力の両方を決める。
   */
  async function profile(weaponId, km = 20, alt = 6000) {
    await patch();
    const b = await fresh(11);
    const w = b.world;
    const { shooter, target } = clearField(b);
    const spec = AT.kin.WEAPONS[weaponId];
    // 目標は動かさず、真っ直ぐ逃げるだけにして速度の推移だけを見る
    const r = [];
    const mm = await import('/js/sim/missile.js');
    const M = mm.Missile;
    const origUp = M.prototype.update;
    let t = 0;
    M.prototype.update = function (dt, world) {
      const before = this.age;
      const ret = origUp.call(this, dt, world);
      if (Math.floor(this.age) !== Math.floor(before)) {
        r.push({ 秒: Math.floor(this.age), 速度: Math.round(this.speed),
          飛距離: Math.round(this.pos.distanceTo(shooter.pos)),
          推進中: this.age < this.boostTime });
      }
      return ret;
    };
    const out = shot(b, weaponId, km, 180, alt);   // 後方＝いちばん長く飛ぶ
    M.prototype.update = origUp;
    unpatch();
    const boost = r.filter((x) => x.推進中);
    const peak = Math.max(...r.map((x) => x.速度));
    const lines = r.map((x) => `${String(x.秒).padStart(2)}s ${String(x.速度).padStart(4)}m/s`
      + ` ${String(x.飛距離).padStart(6)}m ${x.推進中 ? '推進' : '滑空'}`);
    console.log({ 兵装: weaponId, 設計速度: spec.speed, 到達最高: peak,
      推進時間: boost.length, 結末: out.結末, 推移: lines });
    return { 兵装: weaponId, 設計速度: spec.speed, 到達最高: peak,
      推進秒: boost.length, 結末: out.結末, 推移: lines };
  }

  function reset() { rows.length = 0; }

  const median = (a) => {
    if (!a.length) return 0;
    const s2 = [...a].sort((x, y) => x - y);
    return s2[Math.floor(s2.length / 2)];
  };

  /**
   * 「どこまで弱くすれば回避軌道だけで振り切れるか」を探す（§33）。
   *
   * 速度と旋回率に倍率を掛けて撃ち、**撃墜されなくなる倍率**を見つける。
   * 距離ごとに出すので、「この速度ならこの距離から先は逃げられる」が読める。
   */
  async function threshold(opts = {}) {
    const wid = opts.weapon || 'AAM-M';
    const ranges = opts.ranges || [4, 8, 12, 16, 20];
    const scales = opts.scales || [1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3];
    const key = opts.key || 'speed';          // 'speed' | 'turnRate'
    const aspects = opts.aspects || [0, 90, 180];
    const alt = opts.alt ?? 6000;
    await patch();
    const b = await fresh(11);
    const out = [];
    for (const km of ranges) {
      const line = [];
      for (const sc of scales) {
        let killed = 0;
        for (const a of aspects) {
          const r = shot(b, wid, km, a, alt, { [key]: sc });
          if (r && r.結末 === '撃墜') killed++;
        }
        line.push(`${key === 'speed' ? '速' : '旋'}×${sc}:${killed}/${aspects.length}`);
      }
      out.push(`${String(km).padStart(2)}km  ${line.join('  ')}`);
    }
    unpatch();
    console.log(out);
    return out;
  }

  function report() {
    const out = {};
    const weapons = [...new Set(rows.map((r) => r.w))];
    for (const wid of weapons) {
      const set = rows.filter((r) => r.w === wid);
      const kms = [...new Set(set.map((r) => r.km))].sort((a, b) => a - b);
      out[wid] = kms.map((km) => {
        const g = set.filter((r) => r.km === km);
        const mark = (r) => (r.結末 === '撃墜' ? '撃' : r.結末 === '至近弾' ? '近' : '回');
        const byAspect = [0, 90, 180].map((a) => {
          const h = g.filter((r) => r.aspect === a);
          return h.length ? h.map(mark).join('') : '-';
        });
        const esc = g.filter((r) => r.結末 === '回避');
        return `${String(km).padStart(2)}km 正面${byAspect[0]} 横${byAspect[1]} 後方${byAspect[2]}`
          + `  飛翔${(g.reduce((s, r) => s + r.飛翔秒, 0) / g.length).toFixed(1)}s`
          + `  最接近 中央${median(g.map((r) => r.最接近))}m`
          + (esc.length ? `  回避${esc.length}` : '');
      });
    }
    console.log(out);
    return out;
  }

  /**
   * **機首ずれ × 距離**の掃引（§75）。
   *
   * 発射包絡線は最大 40〜55°の機首ずれを許すが、`estimateHitChance` は
   * それを見ていない —— **射程さえ入れば横を向いたまま撃つ。**
   * どれだけ損をするのかを測る。
   */
  async function boresight(opts = {}) {
    const wid = opts.weapon || 'AAM-M';
    const ranges = opts.ranges || [4, 6, 8, 10, 12, 16, 20];
    const offs = opts.offs || [0, 10, 20, 30, 40, 50];
    const aspects = opts.aspects || [0, 90, 180];
    const alt = opts.alt ?? 6000;
    const seeds = opts.seeds || [11, 22, 33];
    await patch();
    const grid = {};
    const b = await fresh(seeds[0]);
    for (const km of ranges) {
      for (const off of offs) {
        let hit = 0; let n = 0;
        for (const asp of aspects) {
          for (let i = 0; i < seeds.length; i++) {
            const r = shot(b, wid, km, asp, alt, { off });
            if (!r || r.結末 === '発射できず') continue;
            n++; if (r.結末 === '撃墜') hit++;
          }
        }
        grid[`${km}km`] = grid[`${km}km`] || {};
        grid[`${km}km`][`${off}°`] = n ? +(hit / n).toFixed(2) : null;
      }
    }
    console.table(grid);
    return grid;
  }

  AT.kin = { run, one, threshold, profile, boresight, report, reset, rows, WEAPONS: null };
  return import('/js/data/weapons.js').then((m) => {
    AT.kin.WEAPONS = m.WEAPONS;
    return 'kinematics ready';
  });
})();
