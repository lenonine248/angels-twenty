// AAM-M が「撃てない」と判定された回数と、その理由を数えるハーネス。
//
//   fetch('/tools/bench.js').then(r => r.text()).then(eval)
//   fetch('/tools/aammprobe.js').then(r => r.text()).then(eval)
//   await AT.aamm.run(0, 6, [11, 22, 33, 44, 55, 66])   // CLEAN SWEEP
//   await AT.aamm.run(6, 6, [11, 22, 33, 44, 55, 66])   // LONG WATCH
//
// **プレイヤーの報告を数字にするために作った。** 「敵の方を向いていて射程内なのに
// AAM-M を撃たない」「互いに上昇し合っているときに起きやすい」——
// 疑っているのは縦の扇（`radarLockFovV` ±20度）が**機首から**測られること
// （`sim/unit.js` の `radarElevation`）で、上昇中は扇ごと上を向くため、
// 正面・同高度の相手が扇から落ちる。
//
// 測るのは次の3つ:
//   1. 発射可否の判定が落ちた理由の分布（`_envelopeReason` の言葉で数える）
//   2. そのうち縦の扇で落ちたぶんの割合
//   3. **縦の扇で落ちたうち、機首の傾きだけが原因のもの**
//      （水平線から測れば扇の内側 = |geo| <= fovV なのに、
//        機首から測ると外 = |geo - pitch| > fovV）
//
// 3 が大きければ、落としているのは幾何ではなく自機の姿勢。
(function () {
  const bucket = new Map();
  let ok = 0;
  let ng = 0;
  const vert = [];

  /** 理由の文から数値を潰して、同じ門を1つにまとめる */
  function norm(s) {
    return String(s).replace(/-?\d+(\.\d+)?/g, 'N');
  }

  function pct(a, b) {
    return b > 0 ? (a * 100 / b).toFixed(1) + '%' : '—';
  }

  AT.aamm = {
    /**
     * @param {number} stageIndex ステージ番号（0 = CLEAN SWEEP / 6 = LONG WATCH）
     * @param {number} runs       周回数
     * @param {?number[]} seeds   種を固定する（§24.3）。省くと毎回引く
     */
    async run(stageIndex = 0, runs = 6, seeds) {
      bucket.clear();
      ok = 0; ng = 0; vert.length = 0;
      const { WEAPONS } = await import('/js/data/weapons.js');
      const W = WEAPONS['AAM-M'];

      // **戦闘が組み上がった直後に差し替える**（1ステップも進める前・bench の作法）。
      // 判定そのものは変えない —— 返り値をそのまま返して、横で数えるだけ。
      const setup = (b) => {
        const c = b.combat;
        const side = b.world.playerSide;
        const raw = c.inEnvelope.bind(c);
        c.inEnvelope = (sh, tg, w) => {
          const r = raw(sh, tg, w);
          if (w !== W || !sh || sh.side !== side) return r;
          if (!tg || tg.kind !== 'aircraft' || tg.onGround) return r;
          if (r) { ok++; return r; }
          ng++;
          const why = c._envelopeReason(sh, tg, w);
          bucket.set(norm(why), (bucket.get(norm(why)) || 0) + 1);
          if (why.indexOf('上下の扇') >= 0) {
            const dy = tg.pos.y - sh.pos.y;
            const flat = Math.max(1, Math.hypot(tg.pos.x - sh.pos.x, tg.pos.z - sh.pos.z));
            vert.push({
              geo: Math.atan2(dy, flat) * 180 / Math.PI,      // 水平線から見た仰角
              pitch: (sh.pitch || 0) * 180 / Math.PI,         // 自機の上下角
              km: flat / 1000,
            });
          }
          return r;
        };
      };

      await AT.bench.stage(stageIndex, runs, { seeds, setup });
      return this.report();
    },

    report() {
      const total = ok + ng;
      const lines = [];
      lines.push(`AAM-M 発射可否の判定: ${total}件 / 通った ${ok} (${pct(ok, total)}) / 落ちた ${ng}`);
      const rows = [...bucket.entries()].sort((a, b) => b[1] - a[1]);
      for (const [why, n] of rows) lines.push(`  ${pct(n, ng).padStart(6)} ${String(n).padStart(6)}  ${why}`);

      // 縦の扇で落ちたぶんの内訳。**機首の傾きだけが原因のもの**を数える
      const FOV = 20;
      const byPitch = vert.filter((v) => Math.abs(v.geo) <= FOV);
      lines.push('');
      lines.push(`縦の扇で落ちた ${vert.length}件のうち、水平線から測れば扇の内側だったもの: `
        + `${byPitch.length} (${pct(byPitch.length, vert.length)})`);
      if (byPitch.length) {
        const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
        lines.push(`  自機の上下角 中央値 ${med(byPitch.map((v) => v.pitch)).toFixed(1)}度`
          + ` / 最大 ${Math.max(...byPitch.map((v) => Math.abs(v.pitch))).toFixed(1)}度`);
        lines.push(`  目標の仰角（水平線から）中央値 ${med(byPitch.map((v) => Math.abs(v.geo))).toFixed(1)}度`);
        lines.push(`  距離 中央値 ${med(byPitch.map((v) => v.km)).toFixed(1)}km`);
        const up = byPitch.filter((v) => v.pitch > 0).length;
        lines.push(`  上昇中 ${up} / 降下中 ${byPitch.length - up}`);
      }
      const out = lines.join('\n');
      console.log(out);
      return out;
    },
  };
})();

// ---------------------------------------------------------------- 扇の幅のA/B
//
//   await AT.aamm.fan(0, [11,22,33,44,55,66])
//   await AT.aamm.fan(6, [11,22,33,44,55,66])
//
// 縦のロックの扇（`radarLockFovV`・既定20度）だけを動かして比べる。
// **機体ごとに spec の複製を持たせる** —— `getType` の spec は機種で共有なので、
// そのまま書き換えると次の周回へ漏れて A/B にならない。
(function () {
  function setFov(v) {
    return (b) => {
      for (const u of b.world.units) {
        if (u.kind !== 'aircraft' || !u.spec) continue;
        u.spec = { ...u.spec, radarLockFovV: v };
      }
    };
  }

  AT.aamm.fan = async function fan(stageIndex = 0, seeds) {
    const variants = { 'V20(現行)': setFov(20), 'V30': setFov(30), 'V40': setFov(40) };
    return AT.bench.ab(stageIndex, seeds, variants);
  };
})();

// ---------------------------------------------------------------- ①と②を並べる
//
//   await AT.aamm.compare(0, [11,22,33,44,55,66])
//
// §92.3 の対策を同じ種で並べる。
//
// **①（撃つ前から姿勢を寝かせる）は測って取り消した**ので、いま並ぶのは ②
// （`radarLockFovV` を広げる）だけ。②も取り消してあるが、
// **入れ直すかを判断する道具としてそのまま残す。**
//
// **結末だけでは選べない**（§82.3）。②は扇落ちが大きく減るのにベンチの結末が動かない。
// **規則が働いた回数と、働いた瞬間の値**を一緒に出す:
//
//   1. AAM-M の発射可否が「上下の扇の外」で落ちた割合
//   2. **AAM-M の照射切れ件数**（§83.4 と同じ指標）
//   3. **発射の窓にいるあいだの上下角と比エネルギー**（①の代償はここに出る）
//   4. クリア・損失・撃墜
//
// ### 差し替えは**型表**に掛ける `[重要]`
//
// 最初は機体ごとに掛けていた（`setup` の中で `world.units` を回す）。
// **湧いてくる増援に掛からない。** LONG WATCH は敵機の半分が増援なので、
// 「対策なし」の周回で増援だけ対策が効いている状態を測っていた。
//
// `ALL_TYPES`（`spec` は機種で共有）に掛けて、変種ごとに必ず戻す。
// **遅れて生まれた機体にも同じ条件が掛かる。**
// 挙動そのものを差し替えるなら `Aircraft.prototype` に掛ける（同じ理由）。
(function () {
  const med = (a) => {
    if (!a.length) return null;
    const t = [...a].sort((x, y) => x - y);
    return t[t.length >> 1];
  };

  /**
   * §41 の読み方に合わせて **18種**を既定にする。
   * 6種では1面差（6/6 → 5/6 ＝ 種1つ）がノイズと切り分けられない。
   */
  AT.aamm.SEEDS18 = [11, 22, 33, 44, 55, 66, 77, 88, 99,
    101, 202, 303, 404, 505, 606, 707, 808, 909];

  AT.aamm.compare = async function compare(stageIndex = 0, seeds = AT.aamm.SEEDS18) {
    const { WEAPONS } = await import('/js/data/weapons.js');
    const { ALL_TYPES, AIRCRAFT_TYPES, ENEMY_TYPES } = await import('/js/data/aircraft.js');
    const MM = await import('/js/sim/missile.js');
    const W = WEAPONS['AAM-M'];

    // 照射切れを数える。**プロトタイプに1度だけ掛けて、変種ごとに数え直す。**
    if (!MM.Missile.prototype.__probed) {
      const raw = MM.Missile.prototype._goStupid;
      MM.Missile.prototype._goStupid = function _goStupid(reason = '?') {
        if (!this.lost && AT.aamm._lost && this.weapon && this.weapon.id === 'AAM-M') {
          AT.aamm._lost[reason] = (AT.aamm._lost[reason] || 0) + 1;
        }
        return raw.call(this, reason);
      };
      MM.Missile.prototype.__probed = true;
    }

    /**
     * **押さえが掛かる場面にいるか**を、変種に依らず同じ式で判定する（b案の条件）。
     *
     * **変種で動く量を条件に入れてはいけない** —— 母集団が変種ごとに変わってしまう。
     * 挙動を差し替える変種を足すときも同じ（その述語を条件に使わない）。**扇の広さは変種で動く**ので、
     * ここでは扇に触らない条件（水平線から見た仰角が20度以内・SARH弾を積んでいる）で
     * 母集団を揃える。
     */
    function inWindow(u, t) {
      const dy = t.pos.y - u.pos.y;
      const flat = Math.max(1, Math.hypot(t.pos.x - u.pos.x, t.pos.z - u.pos.z));
      if (Math.abs(Math.atan2(dy, flat)) > 20 * Math.PI / 180) return false;
      return u.loadout.some((id) => WEAPONS[id] && WEAPONS[id].guidance === 'sarh');
    }

    /**
     * 扇が見ている量そのもの（§92.3 の教訓）。
     * **`|pitch|` を測ると符号ごと逆に出る** —— 押さえは機首を目標の線へ向けるので、
     * 水平に飛んでいたものが傾いて `|pitch|` は上がる。測るのは**機首からのずれ**。
     */
    function offEl(u, t) {
      const dy = t.pos.y - u.pos.y;
      const flat = Math.max(1, Math.hypot(t.pos.x - u.pos.x, t.pos.z - u.pos.z));
      return Math.abs(Math.atan2(dy, flat) - (u.pitch || 0)) * 180 / Math.PI;
    }

    /** 1変種ぶん。`on()` で条件を掛け、`off()` で必ず戻す */
    async function one(label, on, off) {
      const bucket = new Map();
      let ok = 0; let ng = 0; let vert = 0;
      const es = []; const pit = []; const pitAll = [];
      AT.aamm._lost = {};
      on();
      try {
        const setup = (b) => {
          const side = b.world.playerSide;
          const c = b.combat;
          const raw = c.inEnvelope.bind(c);
          c.inEnvelope = (sh, tg, w) => {
            const r = raw(sh, tg, w);
            if (w !== W || !sh || sh.side !== side) return r;
            if (!tg || tg.kind !== 'aircraft' || tg.onGround) return r;
            if (r) { ok++; return r; }
            ng++;
            const why = String(c._envelopeReason(sh, tg, w));
            bucket.set(why.replace(/-?\d+(\.\d+)?/g, 'N'), (bucket.get(why.replace(/-?\d+(\.\d+)?/g, 'N')) || 0) + 1);
            if (why.indexOf('上下の扇') >= 0) vert++;
            return r;
          };

          // 毎ステップの標本。`pilotAI.update` は bench の刻みで必ず呼ばれる
          const rawUpd = b.pilotAI.update.bind(b.pilotAI);
          b.pilotAI.update = (dt) => {
            rawUpd(dt);
            for (const u of b.world.units) {
              if (!u.alive || u.kind !== 'aircraft' || u.side !== side || u.onGround) continue;
              const o = u.order;
              if (!o || o.type !== 'attack') continue;
              const t = o.target;
              if (!t || !t.alive || t.kind !== 'aircraft' || t.onGround) continue;
              pitAll.push(Math.abs(u.pitch) * 180 / Math.PI);
              if (!inWindow(u, t)) continue;       // **窓の中だけ**が①の管轄
              pit.push(offEl(u, t));               // 機首からのずれ（扇が見ている量）
              es.push(u.specificEnergy);
            }
          };
        };

        const sm = await AT.bench.stage(stageIndex, seeds.length, { seeds, setup });
        const total = ok + ng;
        const top = [...bucket.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
          .map(([k, v]) => `${k.slice(0, 16)} ${(v * 100 / ng).toFixed(0)}%`);
        return {
          変種: label,
          クリア: sm.clear,
          損失: sm.losses,
          撃墜: sm.kills,
          通過率: `${(ok * 100 / total).toFixed(1)}%`,
          // **割合だけでは足りない**（§92.3）。分母（落ちた件数）が変種で動くので、
          // 縦の扇の割合が上がっても件数は減っていることがある。両方出す。
          落ちた件数: ng,
          縦で落ちた件数: vert,
          上下の扇の外: `${(vert * 100 / ng).toFixed(1)}%`,
          照射切れ: AT.aamm._lost['照射切れ'] || 0,
          '機首からのずれ(中央値)': med(pit) != null ? +med(pit).toFixed(1) : null,
          '窓の中の比エネ(中央値)': med(es) != null ? Math.round(med(es)) : null,
          '交戦中の上下角(中央値)': med(pitAll) != null ? +med(pitAll).toFixed(1) : null,
          窓の標本: pit.length,
          落ちた理由の上位: top.join(' / '),
        };
      } finally {
        off();
      }
    }

    // ② の差し替え（型表。`spec` は機種で共有なので、湧いた機体にも効く）。
    //
    // **陣営ごとに掛けられる**（§92.3）—— `AIRCRAFT_TYPES` が自軍の機種、
    // `ENEMY_TYPES` が敵の機種。扇を広げる変更は**両軍に効く**ので、
    // 機数で負けている側（＝いつもプレイヤー）が損をしていないかを切り分ける。
    // **片側だけ広げるのは出荷する形ではない。** 原因を割るための測り方。
    const saved = [];
    const fovOn = (v, table = ALL_TYPES) => () => {
      saved.length = 0;
      for (const k of Object.keys(table)) {
        const t = table[k];
        if (t.radarLockFovV == null) continue;
        saved.push([t, t.radarLockFovV]);
        t.radarLockFovV = v;
      }
    };
    const fovOff = () => { for (const [t, v] of saved) t.radarLockFovV = v; saved.length = 0; };

    // **①（撃つ前から姿勢を寝かせる）の変種はもう無い。**
    // 2通り作って18種で測り、どちらも詰まりを増やしたので取り消した（§92.3）。
    // 入れ直すなら `Aircraft.prototype` を差し替える変種をここに足す。
    const out = [];
    out.push(await one('元', () => {}, () => {}));
    out.push(await one('②V30 両軍', fovOn(30), fovOff));
    out.push(await one('②V40 両軍', fovOn(40), fovOff));
    out.push(await one('②V40 自軍だけ', fovOn(40, AIRCRAFT_TYPES), fovOff));
    out.push(await one('②V40 敵だけ', fovOn(40, ENEMY_TYPES), fovOff));
    console.table(out);
    return out;
  };
})();
