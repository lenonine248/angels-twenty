// 兵装のコスト釣り合いを測る道具。仕様書 §89。
//
//   fetch('/tools/bench.js').then(r=>r.text()).then(eval)
//   fetch('/tools/wpncost.js').then(r=>r.text()).then(eval)
//
//   await AT.wpn.usage([0,1,2])                      // 兵装別の成績（実戦・既定の搭載）
//   await AT.wpn.loadout(0, { A: {...}, B: {...} })  // 同ポイントの搭載くらべ
//   AT.wpn.curve()                                   // 命中期待度の式（走らせない）
//
// **ベンチの数字は「司令官AIが使ったときの成績」**（§41）。
// 人間が操作すれば必ずこれより良くなるので、ここで出る値は下限として読む。
//
// ── なぜ専用の道具が要るか ──
//
// `tools/bench.js` は発射数と命中数を**全部まとめて**数える。
// 兵装ごとの単価を出すには「どの弾が撃たれ、どの弾が何を壊したか」が要る。
// しかも `bench.js` の `step()` は `world.onFire` / `onMissileHit` を
// 自分で上書きするので、**そこに相乗りできない**。
// だから計装は prototype 側（`CombatSystem.fire` と `Unit.damage`）に張る。
//
// **味方の弾だけ数える。** 敵も同じ兵装を撃つので、混ぜると
// 命中率が敵の成績で薄まる（`tools/cloudplay.js` で一度踏んだ）。

(function () {
  const SEEDS = [11, 22, 33, 44, 55, 66, 77, 88, 99, 110, 121, 132, 143, 154, 165, 176, 187, 198];

  let tap = null;      // 張った計装
  let bag = null;      // いま溜めている集計

  function row(id) {
    let r = bag.get(id);
    if (!r) {
      r = { 発射: 0, 有効弾: 0, 与ダメ: 0, 撃墜: 0, 空中: 0, 地上: 0,
        直撃: 0, かすり: 0,
        _hit: new Set(), _km: 0, _underFire: 0, _why: new Map(), _miss: [], _kind: new Map(), _vs: new Map() };
      bag.set(id, r);
    }
    return r;
  }

  /** 外れた弾の内訳。**合計が動かなくても、ここは動く**（§41 の読み方） */
  function why(id, reason) {
    const m = row(id)._why;
    m.set(reason, (m.get(reason) || 0) + 1);
  }

  /**
   * 計装を張る。
   *
   * 発射は `CombatSystem.fire`、当たりと撃墜は `Unit.damage` で数える。
   * **命中を `onMissileHit` で数えない**のは、爆風で複数を壊した弾や
   * 座標へ飛んだ弾の扱いが経路ごとに違うため。
   * 「1ダメージでも与えたか」で見れば、どの経路でも同じ意味になる。
   */
  async function install() {
    if (tap) return tap;
    const cm = await import('/js/sim/combat.js');
    const um = await import('/js/sim/unit.js');
    const mm = await import('/js/sim/missile.js');
    const C = cm.CombatSystem;
    const U = um.Unit;
    const M = mm.Missile;
    const origFire = C.prototype.fire;
    const origDamage = U.prototype.damage;
    const origEnd = M.prototype.destroy;

    // **弾が何で終わったか。** 命中率だけでは AAM-M と AAM-A の差が読めない
    // ——「照射が切れた」と「終末で掴めなかった」は別の弱点で、
    // 直し方も値段の付け方も変わる。
    M.prototype.destroy = function (world, reason) {
      const live = this.alive;
      origEnd.call(this, world, reason);
      if (!bag || !live || !this.weapon) return;
      if (!AT.battle || this.side !== AT.battle.world.playerSide) return;
      const r = row(this.weapon.id);
      // `spent` は**4つの終わり方の寄せ集め**（失速・寿命・誘導喪失の時間切れ・通過）。
      // まとめたままだと「エネルギーが足りない」と「追い越した」が同じ欄に入り、
      // どちらを直せばよいか分からない。**ここで割る。**
      let w = reason === 'hit' ? '命中' : (this.lostReason || reason || '?');
      if (w === 'spent') {
        if (this.speed < this.weapon.speed * 0.35) w = '失速';
        else if (this._openingFor >= 0.5) w = '通過';
        else w = '寿命';
      }
      why(this.weapon.id, w);
      if (reason !== 'hit' && this._minDist != null) r._miss.push(Math.round(this._minDist));
    };

    C.prototype.fire = function (shooter, target, weapon) {
      const m = origFire.call(this, shooter, target, weapon);
      if (bag && m && weapon && shooter.side === this.world.playerSide) {
        const r = row(weapon.id);
        r.発射++;
        // 発射時の間合いと、そのとき自分が撃たれていたか（§38.2 の項が効く場面）
        r._km += shooter.pos.distanceTo(target.pos) / 1000;
        if (shooter.threats && shooter.threats.length) r._underFire++;
      }
      return m;
    };

    U.prototype.damage = function (amount, source) {
      const live = this.alive && this.hp > 0;
      const before = this.hp;
      origDamage.call(this, amount, source);
      if (!bag || !live || !source) return;
      // 撃った側が味方でなければ数えない
      const mine = source.side && AT.battle && source.side === AT.battle.world.playerSide;
      if (!mine) return;
      const id = source.weapon && source.weapon.id ? source.weapon.id
        : (source.kind === 'aircraft' ? '機銃' : null);
      if (!id) return;
      const r = row(id);
      const dealt = Math.min(amount, before);
      r.与ダメ += dealt;
      // **相手ごとに割る。** ARM は本来レーダーと SAM を潰す兵装なので、
      // 耐久400の飛行場を殴った分を混ぜると単価が実態より悪く出る
      // （プレイヤーの指摘。実際そうなっていた）
      {
        const t = (this.spec && (this.spec.name || this.spec.id)) || this.kind;
        let e = r._vs.get(t);
        if (!e) { e = { 弾: new Set(), 与ダメ: 0, 撃破: 0 }; r._vs.set(t, e); }
        e.弾.add(source);
        e.与ダメ += dealt;
        if (this.hp <= 0) e.撃破++;
      }
      if (!r._hit.has(source)) {
        r._hit.add(source);
        r.有効弾++;
        // **直撃とかすりを分ける**（`missile.js` の `_checkImpact`）。
        // かすりは 40〜70 しか入らないので、同じ「命中」でも意味が違う。
        if (source.weapon && amount >= source.weapon.damage - 0.5) r.直撃++;
        else if (source.weapon) r.かすり++;
      }
      if (this.hp <= 0) {
        r.撃墜++;
        if (this.kind === 'aircraft') r.空中++; else r.地上++;
        // **何を壊したかで割る。** ARM は電波を出すものしか狙えないので、
        // AGM と同じ「1撃墜あたり何発」で並べると相手の耐久が違うまま比べてしまう
        const t = (this.spec && (this.spec.name || this.spec.id)) || this.kind;
        r._kind.set(t, (r._kind.get(t) || 0) + 1);
      }
    };

    // **撃てない理由を数える**（§80.3 の `fireBlockReason` をそのまま使う）。
    //
    // 「被射撃中に AAM-M を1発も撃たない」が観測されたとき、
    // 原因の候補は3つある —— 期待度のしきい値・レーダー扇・そもそも交戦していない。
    // **どれなのかを当てずに決めない。** 1秒に1度、味方機ごとに聞く。
    const origUpdate = C.prototype.update;
    C.prototype.update = function (dt) {
      origUpdate.call(this, dt);
      if (!bag || !probe) return;
      probe.t += dt;
      if (probe.t < 1) return;
      probe.t = 0;
      const w = this.world;
      for (const u of w.units) {
        if (u.kind !== 'aircraft' || u.side !== w.playerSide || !u.alive || u.onGround) continue;
        const o = u.order;
        const t = o && o.type === 'attack' ? o.target : null;
        if (!t || !t.alive || t.kind !== 'aircraft') continue;
        const fired = u.threats && u.threats.length ? '被射撃中' : '平時';
        for (const id of probe.ids) {
          if (!u.loadout.includes(id)) continue;
          // **角度や秒数を含む文言はそのままだと1件ずつ別の欄になる。**
          // 「左右の扇の外 63度」「同 89度」を別々に数えても何も分からない。
          const why = (this.fireBlockReason(u, t, probe.W[id]) || '撃てる')
            .replace(/ .*$/, '').replace(/^(AAM-[SMA])$/, '$1 誘導中');
          const k = `${id}/${fired}`;
          let m = probe.out.get(k);
          if (!m) { m = new Map(); probe.out.set(k, m); }
          m.set(why, (m.get(why) || 0) + 1);
        }
      }
    };

    tap = { C, U, M, origFire, origDamage, origEnd, origUpdate };
    return tap;
  }

  /** 撃てない理由の標本を取る（重いので明示的に入れる） */
  let probe = null;
  async function watchBlocks(ids = ['AAM-M', 'AAM-A']) {
    const { WEAPONS } = await import('/js/data/weapons.js');
    probe = { t: 0, ids, W: WEAPONS, out: new Map() };
  }
  function blocks(label) {
    const out = [];
    for (const [k, m] of probe.out) {
      const total = [...m.values()].reduce((a, b) => a + b, 0);
      const o = { 状況: k, 標本: total };
      for (const [r, v] of [...m].sort((a, b) => b[1] - a[1])) {
        o[r] = Math.round((100 * v) / total) + '%';
      }
      out.push(o);
    }
    console.log((label || '') + '撃てない理由（1秒ごとの標本）');
    console.table(out);
    return out;
  }

  function uninstall() {
    if (!tap) return;
    tap.C.prototype.fire = tap.origFire;
    tap.U.prototype.damage = tap.origDamage;
    tap.M.prototype.destroy = tap.origEnd;
    tap.C.prototype.update = tap.origUpdate;
    tap = null;
    probe = null;
  }

  /** 外れ方の内訳を表にする */
  function reasons(label) {
    const out = [];
    for (const [id, r] of bag) {
      if (!r.発射) continue;
      const o = { 兵装: id, 発射: r.発射 };
      const total = [...r._why.values()].reduce((a, b) => a + b, 0);
      for (const [k, v] of [...r._why].sort((a, b) => b[1] - a[1])) {
        o[k] = v + `(${Math.round((100 * v) / Math.max(1, total))}%)`;
      }
      const ms = r._miss.slice().sort((a, b) => a - b);
      o['外れの最接近(中央)'] = ms.length ? ms[Math.floor(ms.length / 2)] + 'm' : '-';
      o['壊した相手'] = [...r._kind].sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k}${v}`).join(' ') || '-';
      out.push(o);
    }
    console.log((label || '外れ方') + 'の内訳');
    console.table(out);
    return out;
  }

  /** 集計を表にする。**単価はここで出す** */
  async function table(label) {
    const { WEAPONS } = await import('/js/data/weapons.js');
    const out = [];
    let pts = 0;
    for (const [id, r] of bag) {
      const cost = (WEAPONS[id] || {}).cost ?? 0;
      const spent = r.発射 * cost;
      pts += spent;
      out.push({
        兵装: id,
        単価: cost,
        発射: r.発射,
        有効弾: r.有効弾,
        直撃: r.直撃,
        かすり: r.かすり,
        命中率: r.発射 ? +(r.有効弾 / r.発射).toFixed(3) : 0,
        直撃率: r.発射 ? +(r.直撃 / r.発射).toFixed(3) : 0,
        撃墜: r.撃墜,
        '1発の撃墜': r.発射 ? +(r.撃墜 / r.発射).toFixed(3) : 0,
        消費P: spent,
        '1Pの撃墜': spent ? +(r.撃墜 / spent).toFixed(3) : (r.発射 ? '0P' : 0),
        '1Pの与ダメ': spent ? Math.round(r.与ダメ / spent) : (r.発射 ? '0P' : 0),
        平均発射km: r.発射 ? +(r._km / r.発射).toFixed(1) : 0,
        被射撃中: r.発射 ? Math.round((100 * r._underFire) / r.発射) + '%' : '-',
      });
    }
    out.sort((a, b) => b.発射 - a.発射);
    console.log((label || '兵装別') + ` — 消費 ${pts}P`);
    console.table(out);
    return out;
  }

  function reset() { bag = new Map(); }

  /**
   * 「何を相手にしたときの単価か」で割った表（プレイヤーの指摘・§89）。
   *
   * 撃破数だけで割ると、**とどめを刺した弾**に全部の手柄が付く。
   * 与ダメで割るほうが、複数の弾で削った相手では実態に近い。
   */
  async function versus(label) {
    const { WEAPONS } = await import('/js/data/weapons.js');
    const out = [];
    for (const [id, r] of bag) {
      const cost = (WEAPONS[id] || {}).cost ?? 0;
      if (!cost) continue;                      // 0P の兵装は単価が出せない
      for (const [t, e] of r._vs) {
        out.push({
          兵装: id, 相手: t, 当てた弾: e.弾.size, 与ダメ: Math.round(e.与ダメ), 撃破: e.撃破,
          'P(当てた弾)': e.弾.size * cost,
          '1Pの与ダメ': +(e.与ダメ / (e.弾.size * cost)).toFixed(1),
          '撃破あたりP': e.撃破 ? +((e.弾.size * cost) / e.撃破).toFixed(1) : null,
        });
      }
    }
    out.sort((a, b) => b.与ダメ - a.与ダメ);
    console.log((label || '') + '相手別');
    console.table(out);
    return out;
  }

  // ---------------------------------------------------------------- 実戦

  /**
   * 既定の搭載のまま回して、兵装ごとの成績を出す。
   *
   * @param {number[]} stages 面の番号（省略で全面）
   * @param {number[]} seeds  種（省略で18個）
   */
  async function usage(stages, seeds) {
    await install();
    reset();
    const ss = stages || AT.stages.map((_, i) => i);
    const sd = seeds || SEEDS;
    const runs = [];
    for (const i of ss) {
      for (const seed of sd) runs.push(await AT.bench.runOne(i, false, { seed }));
    }
    const clear = runs.filter((r) => r.state === 'clear').length;
    console.log(`${ss.length}面 × ${sd.length}種 = ${runs.length}戦  クリア ${clear}/${runs.length}`);
    const t = await table('兵装別の成績');
    const wy = reasons('兵装別');
    uninstall();
    return { runs, table: t, reasons: wy, clear, n: runs.length };
  }

  // ---------------------------------------------------------------- 搭載くらべ

  /**
   * 味方戦闘機の搭載を差し替える `setup` を作る。
   *
   * **ポイントの残りも計算し直す**（`main.js` の出撃前の引き算と同じ式）。
   * ここを忘れると、高い搭載のほうが**余分な原資を持ったまま**戦う。
   * `baseLoadout` も置き換えるのは、帰投後の積み直しがそちらを見るため
   * （`ai/commander.js` の `_needsRearm`）。
   *
   * @param {object} map 機種ID → 搭載配列。'*' は全機
   */
  function swap(map) {
    return (b) => {
      const W = AT.wpn._W;
      const w = b.world;
      for (const u of w.units) {
        if (u.kind !== 'aircraft' || u.side !== w.playerSide) continue;
        const L = map[u.spec.id] || map['*'];
        if (!L) continue;
        if (!W.loadoutFits(L, u.spec)) {
          console.warn(`[wpn] ${u.name}(${u.spec.id}) に ${L.join('+')} は載らない`);
          continue;
        }
        u.loadout = L.slice();
        u.baseLoadout = L.slice();
        u.plannedLoadout = null;
        u.refreshFuelCapacity?.();
      }
      let spent = 0;
      for (const u of w.units) {
        if (u.kind !== 'aircraft' || u.side !== w.playerSide) continue;
        spent += W.loadoutCost(u.loadout);
      }
      w.weaponPoints = (w.weaponPointsMax ?? 0) - spent;
    };
  }

  /**
   * 同じ種で搭載だけ変えて比べる。
   *
   *   await AT.wpn.loadout(0, {
   *     'M2S2(4P)': { 'F-1': ['AAM-M','AAM-M','AAM-S','AAM-S'] },
   *     'A1S2(4P)': { 'F-1': ['AAM-A','AAM-S','AAM-S'] },
   *   })
   *
   * 兵装別の成績も条件ごとに分けて出す。
   */
  async function loadout(i, variants, seeds) {
    await install();
    AT.wpn._W = await import('/js/data/weapons.js');
    const sd = seeds || SEEDS;
    const names = Object.keys(variants);
    const by = {};
    const tabs = {};
    const whys = {};
    for (const name of names) {
      reset();
      by[name] = [];
      for (const seed of sd) {
        // 搭載表を渡してもよいし、条件を丸ごと差し替える関数を渡してもよい。
        // **関数をそのまま `swap` に入れると搭載表として読まれ、黙って何もしない**
        // （実際にそれで「しきい値を変えても結果が1ビットも動かない」を測ってしまった）
        const v = variants[name];
        const setup = typeof v === 'function' ? v : swap(v);
        by[name].push(await AT.bench.runOne(i, false, { seed, setup }));
      }
      tabs[name] = await table('[' + name + ']');
      whys[name] = reasons('[' + name + ']');
    }
    const rows = sd.map((seed, k) => {
      const o = { seed };
      for (const name of names) {
        const r = by[name][k];
        o[name] = `${r.state === 'clear' ? '○' : '×'} ${r.kills}撃墜/${r.losses}損失 ${r.sec}s`;
      }
      const base = AT.bench.sig(by[names[0]][k]);
      o.差 = names.every((n) => AT.bench.sig(by[n][k]) === base) ? '' : '★';
      return o;
    });
    console.table(rows);
    const summary = {};
    for (const name of names) summary[name] = AT.bench.summarize(by[name]);
    console.table(summary);
    uninstall();
    return { rows, summary, tabs, whys, by };
  }

  // ---------------------------------------------------------------- 見積り

  /**
   * 命中期待度の式が AAM-M と AAM-A をどう見ているかを距離で出す（§38.3）。
   *
   * **走らせない。** 式だけを読む。ここで差が付いていれば、
   * それは実測の差ではなく **AI がそう信じている**というだけのこと。
   */
  async function curve(opts = {}) {
    const { estimateHitChance } = await import('/js/sim/combat.js');
    const { WEAPONS } = await import('/js/data/weapons.js');
    const THREE = await import('three');
    const alt = opts.alt ?? 6000;
    const aspect = opts.aspect ?? 0;      // 0 = こちらへ真っ直ぐ来る
    const mk = (z, heading) => ({
      pos: new THREE.Vector3(0, alt, z), heading, kind: 'aircraft',
      alive: true, onGround: false, speed: 250, threats: [],
      spec: { size: 12 }, heat: 1,
    });
    const out = [];
    for (const km of opts.ranges || [4, 6, 8, 10, 12, 14, 16, 18, 20, 22]) {
      const sh = mk(0, Math.PI);
      const tg = mk(km * 1000, (aspect * Math.PI) / 180);
      const o = { km };
      for (const id of ['AAM-M', 'AAM-A']) o[id] = +estimateHitChance(sh, tg, WEAPONS[id]).toFixed(3);
      o['A/M'] = o['AAM-M'] ? +(o['AAM-A'] / o['AAM-M']).toFixed(2) : null;
      // 自分も撃たれている場合（AAM-M だけ 0.25 倍される）
      const sh2 = mk(0, Math.PI);
      sh2.threats = [{}];
      o['M被射撃'] = +estimateHitChance(sh2, tg, WEAPONS['AAM-M']).toFixed(3);
      o['A被射撃'] = +estimateHitChance(sh2, tg, WEAPONS['AAM-A']).toFixed(3);
      out.push(o);
    }
    console.table(out);
    return out;
  }

  AT.wpn = { usage, loadout, curve, table, reasons, versus, watchBlocks, blocks, install, uninstall, reset, swap, SEEDS, _W: null };
  return 'wpncost ready';
})();
