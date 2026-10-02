// 作戦書（PROPOSAL_playlog §4 案A）の A/B。ゲーム本体は触らない。
// 搭載と指示を別々に付け外しした 2×2 を、同じ種で並べる:
//   素      … 司令官AIだけ・ブリーフィングの既定の搭載
//   搭載    … 司令官AIだけ・作戦書の搭載
//   指示    … 作戦書の段・既定の搭載
//   作戦書  … 作戦書の段・作戦書の搭載
//
// 親ページ（アプリを開いたタブ・**ペインを表示したまま** —— 隠すと rAF が止まり戦闘が組み上がらない）で:
//   await fetch('/tools/_playbookab.js').then(r => r.text()).then(eval);
//   window.__pbDrive({ stage: 's5', seeds: [101..124], maxSec: 1800 });   // fire-and-forget
//   window.__pbProgress   // '12/96' のような進み
//   window.__pbSummary()  // 腕ごとの集計（終わってから）
//   window.__pbRows       // 1戦1行
//
// 列（__pbRows の1行）:
//   arm, seed, state(clear/fail/active), sec, reason, losses(プレイヤーの機体の損失数)
//   land1/land2: 上陸の発火時刻（無ければ null） lst1/lst2: 揚陸艦の撃沈時刻（無ければ null）
//   lost: 落ちた自軍機 `名前@秒<落とした相手/兵装>`  pts: 出撃時の残りポイント
(() => {
  const ARMS = {
    素: {},
    搭載: { loadouts: true },
    指示: { playbook: true },
    作戦書: { playbook: true, loadouts: true },
  };

  // `arms` は腕の名前の配列（上の ARMS から引く）か、`{ 名前: bench の opts }`（作戦書の書き換えを試すとき）
  async function drive({ stage = 's5', seeds, maxSec = 1800, arms = Object.keys(ARMS) } = {}) {
    const defs = Array.isArray(arms) ? Object.fromEntries(arms.map((a) => [a, ARMS[a]])) : arms;
    arms = Object.keys(defs);
    if (!AT.bench) await fetch('/tools/bench.js').then((r) => r.text()).then(eval);
    const idx = AT.stageList().findIndex((s) => s.id === stage);
    const rows = [];
    window.__pbRows = rows;
    const total = arms.length * seeds.length;
    for (const arm of arms) {
      for (const seed of seeds) {
        const r = await AT.bench.runOne(idx, false, { seed, maxSec, ...defs[arm] });
        const trig = (id) => { const x = r.enemyTriggers.find((e) => e.id === id); return x ? Math.round(x.t) : null; };
        const died = (name) => { const d = r.deaths.find((e) => e.name === name); return d ? Math.round(d.t) : null; };
        rows.push({
          arm, seed, state: r.state, sec: r.sec, reason: r.reason, losses: r.losses,
          land1: trig('land1'), land2: trig('land2'),
          lst1: died('揚陸艦 1'), lst2: died('揚陸艦 2'),
          lost: r.deaths.filter((d) => d.side === 'blue' && d.name !== '沿岸レーダー')
            .map((d) => `${d.name}@${Math.round(d.t)}<${d.by || d.cause}/${d.weapon || '-'}>`),
          pts: r.pointsLeft,
        });
        window.__pbProgress = `${rows.length}/${total}`;
      }
    }
    return rows;
  }

  function summary(rows = window.__pbRows) {
    const out = {};
    const med = (a) => { const s = a.filter((x) => x != null).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
    for (const arm of [...new Set(rows.map((r) => r.arm))]) {
      const rs = rows.filter((r) => r.arm === arm);
      const n = rs.length;
      const cnt = (f) => rs.filter(f).length;
      // 落とした相手の種類で割る（敵機・艦・その他）
      const by = {};
      for (const r of rs) for (const l of r.lost) {
        const who = /BANDIT/.test(l) ? '敵機' : (/揚陸艦/.test(l) ? '艦' : 'その他');
        by[who] = (by[who] || 0) + 1;
      }
      out[arm] = {
        n,
        clear: cnt((r) => r.state === 'clear'),
        fail: cnt((r) => r.state === 'fail'),
        stall: cnt((r) => r.state === 'active'),
        上陸なし: cnt((r) => r.land1 == null && r.land2 == null),
        上陸1のみ: cnt((r) => (r.land1 != null) !== (r.land2 != null)),
        上陸両方: cnt((r) => r.land1 != null && r.land2 != null),
        上陸なしclear: cnt((r) => r.state === 'clear' && r.land1 == null && r.land2 == null),
        艦1撃沈中央: med(rs.map((r) => r.lst1)),
        艦2撃沈中央: med(rs.map((r) => r.lst2)),
        clear秒中央: med(rs.filter((r) => r.state === 'clear').map((r) => r.sec)),
        // losses は沿岸レーダー（自軍の地上）も数えるので、機体だけを別に出す
        損失平均: +(rs.reduce((s, r) => s + r.losses, 0) / n).toFixed(2),
        機体損失平均: +(rs.reduce((s, r) => s + r.lost.length, 0) / n).toFixed(2),
        全滅: cnt((r) => r.lost.length >= 4),
        損失の相手: JSON.stringify(by),
        pts最小: Math.min(...rs.map((r) => r.pts)),
      };
    }
    console.table(out);
    return out;
  }

  window.__pbDrive = (o) => drive(o).then((r) => { window.__pbDone = true; return r; });
  window.__pbSummary = summary;
})();
