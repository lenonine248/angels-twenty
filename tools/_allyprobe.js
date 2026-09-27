// 友軍の司令官AI（§102）の過程を測る。**開発用**。
//
//   AT.setDebug(true)
//   fetch('/tools/bench.js').then(r=>r.text()).then(eval)
//   fetch('/tools/_allyprobe.js').then(r=>r.text()).then(eval)
//   await AT.allyprobe.run([11, 22, 33])          // d4 を種ごとに
//
// 勝敗ではなく**過程**を見る（ベンチは結末しか映さない）。友軍の司令官が考えるたび（2秒ごと）に標本を取る:
//
// | 列 | 意味 |
// |---|---|
// | escort | 友軍の戦闘機が「護衛すべき攻撃機が空に居る」拍のうち、**プレイヤーの攻撃機**を護衛していた割合 |
// | sameWard | 2機とも同じ1機を護衛していた拍（護る相手が2機以上居るのに） |
// | wardKm | 護衛中の、護る相手までの距離の中央値(km) |
// | overlap | 生きている目標が攻撃機の数以上あるのに、**2機以上が同じ目標**に向かっていた拍 |
// | allySvc | 友軍機が整備を受けていた拍（枠の外の列 `freeSlots`） |
// | waitWhileAlly | その拍に**プレイヤーの機体が整備待ち**だった回数（0 のはず・§2.6） |
// | ptsDrop | 友軍機が整備を受けていた間に兵装ポイントが減った回数（0 のはず） |

(function () {
  const median = (a) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

  function probe(b) {
    const w = b.world;
    const cmd = b.allyCommander;
    const st = { samples: 0, escortNeed: 0, escortPlayer: 0, sameWard: 0, wardD: [], overlap: 0,
      allySvc: 0, waitWhileAlly: 0, ptsDrop: 0, targets: {} };
    if (!cmd) return st;
    const raw = cmd.update.bind(cmd);
    let lastPts = w.weaponPoints;
    cmd.update = (dt) => {
      const before = cmd._next;
      raw(dt);
      if (cmd._next === before) return;         // 考えなかった拍
      st.samples++;
      const air = w.units.filter((u) => u.kind === 'aircraft' && u.side === w.playerSide && u.alive);
      const eagles = air.filter((u) => u.owner === 'ally' && !u.onGround && !cmd._isStriker(u));
      const playerStrikers = air.filter((u) => u.owner !== 'ally' && !u.onGround && cmd._hasAg(u)
        && u.aiMode !== 'RTB');
      if (playerStrikers.length) {
        const wards = [];
        for (const e of eagles) {
          st.escortNeed++;
          if (e.aiMode === 'ESCORT' && e.escortTarget && e.escortTarget.owner !== 'ally') {
            st.escortPlayer++;
            wards.push(e.escortTarget);
            st.wardD.push(e.pos.distanceTo(e.escortTarget.pos) / 1000);
          }
        }
        if (playerStrikers.length >= 2 && wards.length >= 2 && new Set(wards).size < wards.length) st.sameWard++;
      }
      const strikers = air.filter((u) => u.strikeTarget && u.strikeTarget.alive && !u.onGround);
      const live = new Set(w.units.filter((u) => u.alive && u.side !== w.playerSide && u.tags
        && u.tags.includes('target')));
      const tgt = strikers.map((u) => u.strikeTarget);
      if (live.size >= strikers.length && new Set(tgt).size < tgt.length) st.overlap++;
      for (const u of strikers) {
        const k = `${u.name}→${u.strikeTarget.name}`;
        st.targets[k] = (st.targets[k] || 0) + 1;
      }
      const allyServicing = air.some((u) => u.owner === 'ally' && u.state === 'servicing');
      if (allyServicing) {
        st.allySvc++;
        if (air.some((u) => u.owner !== 'ally' && u.airbase && u.airbase.queue.includes(u))) st.waitWhileAlly++;
        if (w.weaponPoints < lastPts && !air.some((u) => u.owner !== 'ally' && u.state === 'servicing')) st.ptsDrop++;
      }
      lastPts = w.weaponPoints;
    };
    return st;
  }

  async function run(seeds, stageId = 'd4') {
    const i = AT.stageList().findIndex((s) => s.id === stageId);
    if (i < 0) throw new Error(`${stageId} が一覧に無い（AT.setDebug(true) が要る）`);
    const rows = [];
    for (const seed of seeds) {
      let st = null;
      const r = await AT.bench.runOne(i, false, { seed, setup: (b) => { st = probe(b); } });
      rows.push({
        seed, state: r.state, sec: r.sec, losses: r.losses, allyLosses: r.allyLosses,
        escort: st.escortNeed ? +(st.escortPlayer / st.escortNeed).toFixed(2) : null,
        sameWard: st.sameWard,
        wardKm: median(st.wardD) != null ? +median(st.wardD).toFixed(1) : null,
        overlap: st.overlap, allySvc: st.allySvc, waitWhileAlly: st.waitWhileAlly, ptsDrop: st.ptsDrop,
        targets: Object.keys(st.targets).join(' / '),
      });
    }
    return rows;
  }

  AT.allyprobe = { run, probe };
  return 'allyprobe ready';
})();
