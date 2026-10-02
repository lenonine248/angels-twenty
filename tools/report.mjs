// 1回のプレイの報告書を作る。PROPOSAL_playlog P2・P3。
//
//   node tools/report.mjs                    いちばん新しい回（playlog の最後の行）
//   node tools/report.mjs 20261001-161644-s5 回の名前で
//   node tools/report.mjs replays/x.json     リプレイを直接（ベンチの記録など）
//
// 出力は標準出力と `reports/<回の名前>.md`。
//
// **プレイヤーが補足していた3つを、記録から起こす**:
//   ① 作戦と指示 … 作戦メモ・指示・メモを時系列に並べる（理由は人が書いたぶんだけ）
//   ② 撃墜・被撃墜の理由 … 交戦ごとに「誰が先に見つけたか・撃たれた距離と向き・
//      警報と回避・周りの数・弾の残り」を並べ、仮の型に分ける
//   ③ 勝ち負けの理由 … 目標とトリガーの時系列、分かれ目の時点の自軍機の状態
//
// 読むのはリプレイの形式 v4（`js/core/recorder.js`）。v3 以前も開くが、
// 機体の状態（`a`）と敵の探知（`e`）が無いので ② の多くが「記録なし」になる。
//
// **型の分け方は仮**（PROPOSAL_playlog Q1）。v4 の記録が溜まったら分布を見て決め直す。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLAYLOG = path.join(ROOT, 'playlog.jsonl');
const REPLAYS = path.join(ROOT, 'replays');
const OUT_DIR = path.join(ROOT, 'reports');

// recorder.js と同じ値。**import しない** —— recorder.js は version.js を通して
// ブラウザ前提のものを引く可能性があり、道具が本体の読み込みに巻き込まれる
const CFLAG_DETECTED = 1;
const A_STRIDE = 7;
const AFLAG = { EMIT: 1, THREAT: 2, EVADE: 4, BEAM: 8, RUN: 16, CRANK: 32, AB: 64 };
const contactStride = (v) => (v >= 2 ? 9 : 5);

/** 周りの数を数える半径(m) */
const ODDS_RADIUS = 20000;

// ---------------------------------------------------------------- 読み込み

function readPlaylog() {
  if (!fs.existsSync(PLAYLOG)) return { runs: [], comments: {} };
  const runs = [];
  const comments = {};
  for (const line of fs.readFileSync(PLAYLOG, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    if (r.type === 'comment') { comments[r.id] = r.text; continue; }
    runs.push(r);
  }
  return { runs, comments };
}

function pickTarget(arg) {
  const { runs, comments } = readPlaylog();
  if (arg && arg.endsWith('.json')) {
    const p = path.resolve(arg);
    return { run: null, comment: null, replayPath: p };
  }
  const withReplay = runs.filter((r) => r.id && r.replay);
  const run = arg ? withReplay.find((r) => r.id === arg) : withReplay[withReplay.length - 1];
  if (!run) throw new Error(arg ? `回が見つからない: ${arg}` : 'リプレイの付いた回が playlog にまだ無い');
  return { run, comment: comments[run.id] || null, replayPath: path.join(REPLAYS, run.replay) };
}

// ---------------------------------------------------------------- 記録を引く道具

class Rec {
  constructor(data) {
    this.d = data;
    this.v = data.v || 1;
    this.cs = contactStride(this.v);
    this.units = new Map(data.units.map((u) => [u.id, u]));
    this.samples = data.samples;
    this.events = data.events || [];
    this.amodes = data.amodes || [];
    // プレイヤーの陣営。指示を出した機体の陣営、無ければ blue
    const ord = this.events.find((e) => e.type === 'order' && e.side);
    this.me = ord ? ord.side : 'blue';
    this._pos = new Map();
    this._ast = new Map();
  }

  name(id) { const u = this.units.get(id); return u ? u.name : `#${id}`; }
  unit(id) { return this.units.get(id); }
  isMine(id) { const u = this.units.get(id); return !!u && u.side === this.me && u.owner !== 'ally'; }

  /** 時刻 t 以前で最後のサンプルの番号 */
  at(t) {
    let lo = 0, hi = this.samples.length - 1;
    if (hi < 0) return -1;
    if (t < this.samples[0].t) return 0;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.samples[mid].t <= t) lo = mid; else hi = mid - 1;
    }
    return lo;
  }

  /** サンプル si の位置の表 id → {x,y,z,hdg,hp} */
  posMap(si) {
    if (this._pos.has(si)) return this._pos.get(si);
    const m = new Map();
    const u = this.samples[si].u;
    for (let k = 0; k < u.length; k += 6) {
      m.set(u[k], { x: u[k + 1], y: u[k + 2], z: u[k + 3], hdg: u[k + 4], hp: u[k + 5] });
    }
    this._pos.set(si, m);
    return m;
  }

  /** サンプル si の機体の状態 id → {...}（v4 のみ） */
  stateMap(si) {
    if (this._ast.has(si)) return this._ast.get(si);
    const m = new Map();
    const a = this.samples[si].a;
    if (a) {
      for (let k = 0; k < a.length; k += A_STRIDE) {
        m.set(a[k], {
          speed: a[k + 1], flags: a[k + 2], aam: a[k + 3], load: a[k + 4],
          fuel: a[k + 5], mode: this.amodes[a[k + 6]] || '',
        });
      }
    }
    this._ast.set(si, m);
    return m;
  }

  /** 自軍がサンプル si で id を探知していたか */
  blueSees(si, id) {
    const c = this.samples[si].c || [];
    for (let k = 0; k < c.length; k += this.cs) {
      if (c[k] !== id) continue;
      return this.cs >= 9 ? (c[k + 8] & CFLAG_DETECTED) !== 0 : true;
    }
    return false;
  }

  /** 敵がサンプル si で自軍の id を探知していたか（v4 のみ。無ければ null） */
  redSees(si, id) {
    const e = this.samples[si].e;
    if (!e) return null;
    for (let k = 0; k < e.length; k += 2) if (e[k] === id) return true;
    return false;
  }

  /** 見ている側 viewer の陣営が target を、si より前で途切れずに見続けていた最初の時刻 */
  seenSince(si, viewerSide, target) {
    const sees = (i) => (viewerSide === this.me ? this.blueSees(i, target) : this.redSees(i, target));
    if (!sees(si)) return null;
    let i = si;
    while (i > 0 && sees(i - 1)) i--;
    return this.samples[i].t;
  }
}

// ---------------------------------------------------------------- 計算

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const km = (m) => (m / 1000).toFixed(1);
const fmtT = (t) => `${Math.floor(t / 60)}:${String(Math.round(t % 60)).padStart(2, '0')}`;

/** 被弾側から見た撃った側の向き（0° 正面・180° 真後ろ）。記録の heading は度 */
function aspect(victim, shooter) {
  const h = (victim.hdg * Math.PI) / 180;
  // 前の向きは (sin h, -cos h)（sim/unit.js の forward）
  const fx = Math.sin(h), fz = -Math.cos(h);
  const dx = shooter.x - victim.x, dz = shooter.z - victim.z;
  const n = Math.hypot(dx, dz) || 1;
  const c = (fx * dx + fz * dz) / n;
  return Math.round((Math.acos(Math.max(-1, Math.min(1, c))) * 180) / Math.PI);
}

/** 1件の撃墜／被撃墜を起こす */
function engagement(R, ev) {
  const victim = ev.id;
  const vUnit = R.unit(victim);
  const out = {
    t: ev.t, victim, victimName: R.name(victim), mine: ev.type === 'loss',
    killer: ev.by ?? null, weapon: ev.w || null, cause: ev.cause || '', tags: [], facts: [],
  };
  if (!vUnit || vUnit.kind !== 'aircraft') return null;

  // 致命弾の発射を探す: 被弾側が tid の hit で、kill の直前のもの → その mid の fire
  const hit = [...R.events].reverse().find((e) => e.type === 'hit' && e.tid === victim && e.t <= ev.t + 0.5);
  const fire = hit && hit.mid != null
    ? R.events.find((e) => e.type === 'fire' && e.mid === hit.mid)
    : (hit ? [...R.events].reverse().find((e) => e.type === 'fire' && e.tid === victim && e.id === hit.id && e.t <= hit.t) : null);

  // 古い記録は撃墜に撃った相手（by）が無い。致命弾の発射から補う
  if (out.killer == null && fire) out.killer = fire.id;
  if (!out.weapon && fire) out.weapon = fire.w;
  const killerUnit = out.killer != null ? R.unit(out.killer) : null;

  if (cause_isNonCombat(out.cause)) {
    out.tags.push(`戦闘以外（${out.cause}）`);
    return out;
  }
  if (killerUnit && killerUnit.kind !== 'aircraft') {
    out.tags.push(`地上・艦の対空（${killerUnit.type || killerUnit.kind}・${out.weapon || '?'}）`);
  }

  if (fire) {
    const si = R.at(fire.t);
    const pm = R.posMap(si);
    const vp = pm.get(victim), sp = pm.get(fire.id);
    if (vp && sp) {
      const asp = aspect(vp, sp);
      out.facts.push(`発射 ${fmtT(fire.t)}（命中まで ${Math.round(ev.t - fire.t)}秒）・${fire.w}・距離 ${km(dist(vp, sp))}km`
        + `・高度 被弾側 ${Math.round(vp.y)}m／撃った側 ${Math.round(sp.y)}m・撃った側の向き ${asp}°（0 正面・180 後ろ）`);
      if (asp >= 120) out.tags.push('後ろから撃たれた');
    }
    // 先に見つけたのはどちらか
    const victimSide = vUnit.side;
    const shooterSide = victimSide === R.me ? 'enemy' : R.me;
    const vSaw = R.seenSince(si, victimSide, fire.id);
    const sSaw = R.seenSince(si, shooterSide === 'enemy' ? 'red' : R.me, victim);
    const sawTxt = (x) => (x === null ? 'いいえ' : `はい（${fmtT(x)} から）`);
    // 自軍の探知は記録が全版にある。敵の探知は v4 だけ
    if (victimSide === R.me) {
      out.facts.push(`撃たれた時、撃った相手を自軍は探知していたか: ${sawTxt(vSaw)}`
        + (R.v >= 4 ? `・相手は自機を: ${sawTxt(sSaw)}` : ''));
      if (vSaw === null) out.tags.push('見えない相手に撃たれた');
      else if (sSaw !== null && sSaw < vSaw) out.tags.push('先に見つけられた');
    } else {
      const mineSaw = R.seenSince(si, R.me, victim);
      out.facts.push(`撃った時、自軍は相手を探知していたか: ${sawTxt(mineSaw)}`
        + (R.v >= 4 ? `・相手は撃った機を: ${sawTxt(R.redSees(si, fire.id) ? R.seenSince(si, 'red', fire.id) : null)}` : ''));
    }
    // 警報と回避（v4）
    if (R.v >= 4) {
      const s0 = si, s1 = R.at(ev.t);
      let threatAt = null, evaded = new Set();
      for (let i = s0; i <= s1; i++) {
        const st = R.stateMap(i).get(victim);
        if (!st) continue;
        if (threatAt === null && (st.flags & AFLAG.THREAT)) threatAt = R.samples[i].t;
        if (st.flags & AFLAG.EVADE) evaded.add('回避');
        if (st.flags & AFLAG.BEAM) evaded.add('ビーム');
        if (st.flags & AFLAG.RUN) evaded.add('背を向けて逃げた');
        if (st.flags & AFLAG.CRANK) evaded.add('クランク');
      }
      const decoys = R.events.filter((e) => e.type === 'decoy' && e.id === victim && e.t >= fire.t && e.t <= ev.t).length;
      out.facts.push(`警報: ${threatAt === null ? '鳴っていない' : `${fmtT(threatAt)}（発射の ${Math.round(threatAt - fire.t)}秒後）`}`
        + `・動き: ${evaded.size ? [...evaded].join('・') : 'なし'}・デコイ ${decoys}回`);
      if (threatAt === null) out.tags.push('警報なし');
      else if (!evaded.size && !decoys) out.tags.push('警報は鳴ったが避けていない');
    }
    // 外れた先の弾（同じ相手を狙った弾）
    const prior = R.events.filter((e) => e.type === 'fire' && e.tid === victim && e.t < fire.t && e.t > fire.t - 120).length;
    if (prior) out.facts.push(`この前の120秒に同じ機体を狙った弾: ${prior}発`);
  } else if (out.weapon === 'GUN') {
    out.tags.push('機銃');
  } else {
    out.facts.push('発射の記録が見つからない');
  }

  // 落ちた時の状態と周りの数
  const sd = R.at(ev.t);
  const st = R.stateMap(sd).get(victim);
  if (st) {
    out.facts.push(`落ちた時: 速度 ${st.speed}m/s・AAM 残り ${st.aam}・搭載 残り ${st.load}・燃料 ${st.fuel}%・モード ${st.mode || '?'}`);
    if (out.mine && st.aam === 0 && st.mode !== 'RTB' && st.mode !== 'STRIKE') out.tags.push('AAM 切れで空域に残っていた');
  }
  const pm = R.posMap(sd);
  const vp = pm.get(victim);
  if (vp) {
    let own = 0, foe = 0;
    for (const [id, p] of pm) {
      const u = R.unit(id);
      if (!u || u.kind !== 'aircraft' || id === victim) continue;
      if (dist(p, vp) > ODDS_RADIUS) continue;
      if (u.side === vUnit.side) own++; else foe++;
    }
    out.facts.push(`半径 ${ODDS_RADIUS / 1000}km の機数: 味方 ${own}（本機を除く）・敵 ${foe}`);
    if (foe >= own + 2) out.tags.push('数で負けていた');
  }
  if (!out.tags.length) out.tags.push('その他');
  return out;
}

function cause_isNonCombat(cause) {
  return cause && cause !== '被弾';
}

/** 弾の結果を陣営・兵装ごとに */
function missileTable(R) {
  const fires = new Map();
  for (const e of R.events) if (e.type === 'fire' && e.mid != null) fires.set(e.mid, e);
  const rows = new Map();
  const key = (side, w) => `${side === R.me ? '自軍' : '敵'}|${w}`;
  for (const f of fires.values()) {
    const k = key(f.side, f.w);
    if (!rows.has(k)) rows.set(k, { fired: 0, hit: 0, spent: 0, ground: 0, other: 0, lost: {} });
    rows.get(k).fired++;
  }
  for (const e of R.events) {
    if (e.type !== 'mend') continue;
    const f = fires.get(e.mid);
    if (!f) continue;
    const r = rows.get(key(f.side, f.w));
    if (e.cause === 'hit') r.hit++;
    else if (e.cause === 'spent') r.spent++;
    else if (e.cause === 'ground') r.ground++;
    else r.other++;
    if (e.cause !== 'hit' && e.label) r.lost[e.label] = (r.lost[e.label] || 0) + 1;
  }
  return rows;
}

// ---------------------------------------------------------------- 書き出し

function report(R, run, comment, replayPath) {
  const d = R.d;
  const res = d.result && typeof d.result === 'object' ? d.result : { state: d.result };
  const L = [];
  const id = (run && run.id) || d.play || path.basename(replayPath, '.json');
  L.push(`# プレイ報告 ${id}`);
  L.push('');
  L.push(`- 面: ${d.stage.name}（${d.stage.id}）・版 ${d.version}・種 ${d.seed}・記録の形式 v${R.v}`);
  L.push(`- 結果: **${res.state}**${res.reason ? `（${res.reason}）` : ''}・${d.stats ? `${d.stats.sec}秒・撃墜 ${d.stats.kills}・損失 ${d.stats.losses}・残P ${d.stats.pointsLeft}${d.stats.rank ? `・評価 ${d.stats.rank}` : ''}` : ''}`);
  if (run && run.loadout) L.push(`- 搭載: ${run.loadout.join(' / ')}`);
  if (R.v < 4) L.push('- **v4 より前の記録**: 機体の状態と敵の探知が無いので、警報・回避・先に見つけた側の一部が出ない');
  L.push('');

  // ① 作戦
  L.push('## ① 作戦と指示');
  L.push('');
  L.push(`作戦メモ: ${d.plan || (run && run.plan) || '（なし）'}`);
  L.push('');
  const tl = [];
  // 指示は同じ時刻・同じ中身をまとめる
  const orders = new Map();
  for (const e of R.events) {
    if (e.type !== 'order') continue;
    const k = `${e.t}|${e.label}|${e.tid ?? ''}|${e.dx ?? ''},${e.dz ?? ''}`;
    if (!orders.has(k)) orders.set(k, { ...e, ids: [] });
    if (e.id != null) orders.get(k).ids.push(e.id);
  }
  for (const o of orders.values()) {
    const who = o.ids.map((i) => R.name(i)).join('・') || '?';
    const to = o.tid != null ? ` → ${R.name(o.tid)}` : o.dx != null ? ` → (${km(o.dx)}, ${km(o.dz)})km` : '';
    tl.push([o.t, `指示 ${o.label}: ${who}${to}`]);
  }
  for (const e of R.events) {
    if (e.type === 'note') tl.push([e.t, `**メモ**: ${e.text}${e.ids && e.ids.length ? `（${e.ids.map((i) => R.name(i)).join('・')}）` : ''}`]);
    if (e.type === 'trigger') tl.push([e.t, `トリガー ${e.label}（${e.cause === 'ally' ? '友軍' : '敵'}）`]);
    if (e.type === 'objective') tl.push([e.t, `目標「${e.label}」${e.cause === 'done' ? '達成' : '失敗'}`]);
    if (e.type === 'kill' || e.type === 'loss' || e.type === 'withdraw') {
      const u = R.unit(e.id);
      tl.push([e.t, `${e.type === 'loss' ? '喪失' : e.type === 'kill' ? '撃墜' : '離脱'} ${R.name(e.id)}${u && u.owner === 'ally' ? '（友軍）' : ''}`
        + `${e.by != null ? ` ← ${R.name(e.by)}${e.w ? `・${e.w}` : ''}` : e.cause && e.cause !== '被弾' ? `（${e.cause}）` : ''}`]);
    }
  }
  tl.sort((a, b) => a[0] - b[0]);
  L.push('| 時刻 | 出来事 |');
  L.push('|---|---|');
  for (const [t, s] of tl) L.push(`| ${fmtT(t)} | ${s.replace(/\|/g, '／')} |`);
  L.push('');

  // ② 交戦
  L.push('## ② 撃墜・被撃墜');
  L.push('');
  const engs = R.events.filter((e) => e.type === 'loss' || e.type === 'kill').map((e) => engagement(R, e)).filter(Boolean);
  const tagCount = (list) => {
    const m = new Map();
    for (const g of list) for (const t of g.tags) m.set(t, (m.get(t) || 0) + 1);
    return [...m].sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t} ${n}`).join('・') || '—';
  };
  L.push(`- 自軍の損失（航空機）${engs.filter((g) => g.mine).length}: ${tagCount(engs.filter((g) => g.mine))}`);
  L.push(`- 敵の撃墜（航空機）${engs.filter((g) => !g.mine).length}: ${tagCount(engs.filter((g) => !g.mine))}`);
  L.push('');
  for (const g of engs) {
    L.push(`### ${fmtT(g.t)} ${g.mine ? '喪失' : '撃墜'} ${g.victimName}${g.killer != null ? ` ← ${R.name(g.killer)}（${g.weapon || '?'}）` : ''}`);
    L.push(`型: ${g.tags.join('・')}`);
    for (const f of g.facts) L.push(`- ${f}`);
    L.push('');
  }
  const mt = missileTable(R);
  if (mt.size) {
    L.push('弾の結果（v4・発射と終わりを弾の id で対にしたもの）');
    L.push('');
    L.push('| 陣営・兵装 | 発射 | 命中 | 失速・失効 | 地面 | 外れの内訳（誘導が切れた理由） |');
    L.push('|---|---|---|---|---|---|');
    for (const [k, r] of [...mt].sort()) {
      const [s, w] = k.split('|');
      const lost = Object.entries(r.lost).map(([x, n]) => `${x} ${n}`).join('・') || '—';
      L.push(`| ${s} ${w} | ${r.fired} | ${r.hit} | ${r.spent} | ${r.ground} | ${lost} |`);
    }
    L.push('');
  }

  // ③ 分かれ目
  L.push('## ③ 勝ち負けの分かれ目');
  L.push('');
  const objs = R.events.filter((e) => e.type === 'objective');
  if (objs.length) for (const o of objs) L.push(`- ${fmtT(o.t)} 目標「${o.label}」${o.cause === 'done' ? '達成' : '失敗'}`);
  else L.push('- 目標の移り変わりの記録なし（v4 より前か、何も動かなかった）');
  const failed = objs.find((o) => o.cause === 'failed');
  const pivotT = failed ? failed.t : (res.state !== 'clear' && R.samples.length ? R.samples[R.samples.length - 1].t : null);
  if (pivotT !== null) {
    const si = R.at(pivotT);
    L.push('');
    L.push(`**${failed ? '目標を失った' : '終わった'}時点（${fmtT(pivotT)}）の自軍機**`);
    L.push('');
    L.push('| 機体 | 状態 | モード | AAM | 搭載 | 燃料 |');
    L.push('|---|---|---|---|---|---|');
    const pm = R.posMap(si), sm = R.stateMap(si);
    for (const u of R.units.values()) {
      if (u.side !== R.me || u.kind !== 'aircraft' || u.owner === 'ally') continue;
      const p = pm.get(u.id), st = sm.get(u.id);
      const dead = R.events.find((e) => (e.type === 'loss' || e.type === 'withdraw') && e.id === u.id && e.t <= pivotT);
      L.push(`| ${u.name}（${u.type}） | ${dead ? `失った ${fmtT(dead.t)}` : p ? `飛行中 高度${Math.round(p.y)}m` : '地上'} | ${st ? st.mode : '—'} | ${st ? st.aam : '—'} | ${st ? st.load : '—'} | ${st ? st.fuel + '%' : '—'} |`);
    }
    const before = R.events.filter((e) => e.type === 'loss' && e.t <= pivotT && e.t > pivotT - 180);
    L.push('');
    L.push(`その前の180秒の損失: ${before.length ? before.map((e) => `${R.name(e.id)} ${fmtT(e.t)}`).join('・') : 'なし'}`);
  }
  // 機数の推移（1分ごと）
  L.push('');
  L.push('機数の推移（1分ごと・飛んでいる航空機）');
  L.push('');
  L.push('| 時刻 | 自軍 | 友軍 | 敵 |');
  L.push('|---|---|---|---|');
  const last = R.samples.length ? R.samples[R.samples.length - 1].t : 0;
  for (let t = 0; t <= last; t += 60) {
    const pm = R.posMap(R.at(t));
    let me = 0, ally = 0, foe = 0;
    for (const id of pm.keys()) {
      const u = R.unit(id);
      if (!u || u.kind !== 'aircraft') continue;
      const p = pm.get(id);
      if (p.y < 5) continue;   // 地上で待っている機体は数えない
      if (u.side !== R.me) foe++; else if (u.owner === 'ally') ally++; else me++;
    }
    L.push(`| ${fmtT(t)} | ${me} | ${ally} | ${foe} |`);
  }
  L.push('');
  L.push(`一言: ${comment || '（なし）'}`);
  L.push('');
  return { id, md: L.join('\n') };
}

// ---------------------------------------------------------------- 入口

const arg = process.argv[2];
const { run, comment, replayPath } = pickTarget(arg);
if (!fs.existsSync(replayPath)) {
  console.error(`リプレイが無い: ${replayPath}`);
  process.exit(1);
}
const data = JSON.parse(fs.readFileSync(replayPath, 'utf8'));
const R = new Rec(data);
const { id, md } = report(R, run, comment, replayPath);
fs.mkdirSync(OUT_DIR, { recursive: true });
const out = path.join(OUT_DIR, `${id}.md`);
fs.writeFileSync(out, md, 'utf8');
console.log(md);
console.error(`→ ${path.relative(ROOT, out)}`);
