// 難易度の事前見積り。コンソールに貼り付けて使う。
//
//   fetch('/tools/difficulty.js').then(r=>r.text()).then(eval)
//   AT.difficulty.table()        全ステージの見積りを表で見る
//   AT.difficulty.of(AT.stages[2])
//
// 遊ばずに「このステージは前より何倍重いか」を出すためのもの。
// 絶対値に意味は無い。**ステージ間の比較**にだけ使う。
//
// 実測（tools/bench.js）や実プレイの記録（AT.telemetry）と食い違ったら、
// 信じるのは実測のほう。この見積りは「新しいステージを置く位置を外さない」
// ための当たりを付ける道具でしかない。

(async function () {
  // 脅威の重み。数字そのものより「相対関係」を保つことが大事。
  const AIR = { 'J-7': 10, 'B-9': 6, 'E-8': 3 };
  const OWN = { 'F-1': 10, 'F-2': 9, 'A-3': 7, 'E-8': 0 };

  // 地上目標の重みはデータから作る。手で表を持つと、
  // ユニットを足したときに更新を忘れて見積りが静かに狂う。
  const { GROUND_TYPES } = await import('/js/data/ground.js');
  const groundWeight = (id) => {
    const g = GROUND_TYPES[id];
    if (!g) return 4;
    // 壊すのに要る手数（HP）＋ こちらを撃ってくる度合い
    let w = g.hp / 18;
    if (g.weapon && g.weapon.kind === 'sam') w += 10;
    if (g.weapon && g.weapon.kind === 'aaa') w += 2;
    if (g.radar && g.radar.emits) w += 2;
    return w;
  };

  function of(stage) {
    const e = stage.enemy || {};
    const skill = e.skill ?? 1;

    // --- 敵の脅威
    let air = 0;
    for (const a of e.aircraft || []) air += (AIR[a.type] ?? 8);
    // 練度は線形より効く（腕の差は数の差より大きい）
    air *= 0.45 + 0.55 * skill * skill;

    let ground = 0;
    for (const g of e.ground || []) ground += groundWeight(g.type);
    if (e.base) ground += groundWeight('AIRBASE');

    // 増援は「総量」と「間隔の短さ」の両方で効く
    let reinforce = 0;
    const rb = e.base && e.base.reinforce;
    if (rb) reinforce = (rb.max || 0) * (AIR[rb.type] ?? 8) * (170 / Math.max(60, rb.every)) * 0.5;

    // 移動する目標は捕捉に手間がかかる（艦船・車両）
    for (const g of e.ground || []) if (g.route) ground *= 1.06;

    // --- 自軍の戦力
    const f = stage.friendly || {};
    let own = 0;
    for (const a of f.aircraft || []) own += (OWN[a.type] ?? 8);
    const points = stage.weaponPoints || 0;
    // 兵装ポイントは「使える火力」。機体そのものより効きは緩やか
    const force = own + points * 0.45;

    // --- 補正
    let mod = 1;
    // 地上で待機開始のステージは、発進・進出のぶん重い
    if (f.startAirborne === false) mod *= 1.15;
    // 守る対象があると自由に動けない
    const protect = (stage.objectives || []).filter((o) => o.type === 'protect').length;
    mod *= 1 + protect * 0.12;
    // 破壊すべき目標が多いほど手数が要る
    const destroy = (stage.objectives || []).filter((o) => o.type === 'destroyAll').length;
    mod *= 1 + Math.max(0, destroy - 1) * 0.15;

    const threat = (air + ground + reinforce) * mod;
    return {
      stage: stage.id,
      name: stage.name,
      敵空: Math.round(air),
      敵地上: Math.round(ground),
      増援: Math.round(reinforce),
      補正: +mod.toFixed(2),
      脅威: Math.round(threat),
      自軍: Math.round(force),
      難度: +(threat / Math.max(1, force)).toFixed(2),
      練度: skill,
    };
  }

  function table() {
    const rows = AT.stages.map(of);
    // 前のステージからの伸び率。ここが跳ねているところが難易度の段差。
    rows.forEach((r, i) => {
      r.前比 = i === 0 ? '—' : `x${(r.難度 / rows[i - 1].難度).toFixed(2)}`;
    });
    console.table(rows);
    return rows;
  }

  AT.difficulty = { of, table, groundWeight };
  return 'difficulty ready';
})();
