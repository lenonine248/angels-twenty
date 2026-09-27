// ステージ定義を「読む」ための写し。仕様書 §91。
//
// **`stages.js` へ貼るためのものではない**（あちらは `custom.snippet()`）。
// エディタで組んだ面を**人に見せて釣り合いを相談する**ための出口。
//
// 出すのは2つ。
//   要点 —— 上限・帯・機数・目標・天候・検査の結果を十数行に畳んだもの
//   差分 —— 「この面を下敷きにする」で作った面と、その組み込み面との違いだけ
//
// **差分が要る理由は長さ。** LONG WATCH を下敷きにすると定義は 60 行を超えるのに、
// 触ったのは数行という形になる。全部を貼ると**どこを触ったのかが読む側に分からない。**
//
// 体裁は §47.4（調整パネルの「コピー用に出力」）に寄せてある ——
// 同じ形で届けば、読む側は同じ読み方ができる。
//
// **下敷きは `stages.js` のいまの値を見る。** 調整パネル（§47）で上書きしていると
// そちらが入るので、上書きがあるときは呼び出し側から `baseTuned` を受けて注記する。

import { STAGES } from './stages.js';
import { loadoutCost } from './weapons.js';
import { validate } from './custom.js';

/** 下敷きに選べる面（組み込みの本編だけ。検証用と自作は出さない） */
export function baseList() { return STAGES; }

export function baseById(id) { return STAGES.find((s) => s.id === id) || null; }

/**
 * この面の下敷き（元にした組み込み面）。
 *
 * `basedOn` は §91 で足したので、**それ以前に複製した面には無い。**
 * 無ければ名前で拾う ——「LONG WATCH COPY」のように組み込みの名前で
 * 始まっていれば、それを下敷きと見なす。当たらなければ `null`。
 */
export function baseOf(stage) {
  if (!stage) return null;
  if (stage.basedOn) return baseById(stage.basedOn);
  const name = String(stage.name || '').toUpperCase();
  // **長い名前から先に見る。** 短い名前が前方一致で先に当たると、
  // 別の面を下敷きだと言い出す（"LONG WATCH" と "LONG" が両方あるとき）
  return STAGES.filter((s) => name.startsWith(String(s.name).toUpperCase()))
    .sort((a, b) => b.name.length - a.name.length)[0] || null;
}

// ---------------------------------------------------------------- 体裁

/**
 * 値を1行に畳む。**キーの引用符だけ外す**（§66.2 と同じ理由で値は触らない ——
 * 本文にアポストロフィがあると壊れる）。
 */
function val(v) {
  if (Array.isArray(v)) return `[${v.map(val).join(', ')}]`;
  if (v && typeof v === 'object') {
    return `{ ${Object.entries(v).filter(([, x]) => x !== undefined)
      .map(([k, x]) => `${k}: ${val(x)}`).join(', ')} }`;
  }
  return JSON.stringify(v);
}

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const isPlain = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** 型ごとの数（`J-7×4・B-9×2`） */
function byType(list) {
  const n = new Map();
  for (const u of list) n.set(u.type, (n.get(u.type) || 0) + 1);
  return [...n].map(([t, c]) => (c > 1 ? `${t}×${c}` : t)).join('・') || 'なし';
}

/** 目標1つを短く（`hold[depot]≥4`） */
function objText(o) {
  return `${o.type}[${o.tag ?? ''}]`
    + (o.min != null ? `≥${o.min}` : '')
    + (o.seconds ? ` ${o.seconds}秒` : '')
    + (o.fail ? '・失敗条件' : '');
}

/** 飛行場1つを短く（増援の細目まで） */
function baseText(b) {
  const r = b.reinforce;
  if (!r) return '増援なし';
  const types = r.types ? r.types.join('+') : (r.type || 'J-7');
  return `増援 ${r.every}秒ごと`
    + (r.first != null ? `（初回は${r.first}秒）` : '')
    + `・最大${r.max}機・${r.burst || 1}機ずつ・${types}`
    + (r.after === 'detected' ? '・見つかってから' : '');
}

// ---------------------------------------------------------------- 要点

function headLines(s, base, opts) {
  const f = s.friendly || {};
  const e = s.enemy || {};
  const air = f.aircraft || [];
  const r = s.rating || {};
  const preset = air.reduce((n, a) => n + loadoutCost(a.loadout || []), 0);
  const t = s.terrain || {};
  const w = s.weather;
  const out = [
    `// ${s.name}（${s.title}）— 自作ステージ ${s.id}`,
    base ? `// 下敷き: ${base.name}（${base.id}）` : '// 下敷き: なし（白紙から組んだ面）',
  ];
  if (base && opts.baseTuned) {
    out.push('// ※ 下敷きの面には調整パネル（§47）の上書きが載っています。'
      + '差分はその上書き後の値との違いです');
  }
  out.push(
    `// 地形 種${t.seed}・山${t.mountainAmount}・海岸${t.coast}・谷${t.valleyDepth}`
      + `・川${t.rivers}・標高${t.baseAltitude}m`,
    w && w.cloud && w.cloud !== 'none'
      ? `// 天候 ${w.cloud} ${w.base ?? 2500}〜${w.top ?? (w.base ?? 2500) + 1700}m`
        + (w.wind ? `・風 ${w.wind.deg ?? '乱数'}°/${w.wind.speed ?? 12}m/s` : '')
      : '// 天候 雲なし',
    `// 兵装 上限 ${s.weaponPoints}P ／ プリセット ${preset}P`
      + `（節約 ◎≤${r.points?.[0]}P ○≤${r.points?.[1]}P）`,
    `// 迅速 ◎≤${r.time?.[0]}秒 ○≤${r.time?.[1]}秒 ／ 練度 ◎≤${r.losses?.[0]}機 ○≤${r.losses?.[1]}機`,
    `// 味方 航空${air.length}（${byType(air)}）／地上${(f.ground || []).length}`
      + `／支援${(f.support || []).length}／${f.startAirborne ? '空中発進' : '地上発進'}`,
  );
  let foe = `// 敵 航空${(e.aircraft || []).length}（${byType(e.aircraft || [])}）`
    + `／地上${(e.ground || []).length}`;
  for (const key of ['base', 'base2']) {
    if (e[key]) foe += `／飛行場${key === 'base2' ? '2' : ''}（${baseText(e[key])}）`;
  }
  if (e.skill != null && e.skill !== 1) foe += `／練度 ${e.skill}`;
  out.push(foe);
  out.push(`// 目標 ${(s.objectives || []).map(objText).join(' ／ ') || 'なし'}`);
  if ((e.objectives || []).length) {
    out.push(`// 敵の任務 ${e.objectives.map(objText).join(' ／ ')}`);
  }
  // **検査の結果も一緒に出す**（§66.5）。遊べない面を見せて相談しても、
  // 話が噛み合わない ——「そもそも保存できない」ほうが先に効く。
  const v = validate(s);
  if (v.fatal.length) out.push(`// 検査 ✕ 遊べません — ${v.fatal.join(' ／ ')}`);
  if (v.warn.length) out.push(`// 検査 △ 警告 — ${v.warn.join(' ／ ')}`);
  if (!v.fatal.length && !v.warn.length) out.push('// 検査 ○ 問題なし');
  return out;
}

// ---------------------------------------------------------------- 差分

/** 配列を**名前で対応づける**節（同じ名前なら同じものと見る） */
const KEY_OF = {
  'friendly.aircraft': 'name',
  'friendly.ground': 'name',
  'friendly.support': 'name',
  'enemy.aircraft': 'name',
  'enemy.ground': 'name',
  objectives: 'id',
  'enemy.objectives': 'id',
  'ally.aircraft': 'name',
  'ally.objectives': 'id',
  'enemy.triggers': 'id',
  'ally.triggers': 'id',
};

/** 差分に出さないもの（面ごとに必ず違う・要点に既に出ている） */
const SKIP = new Set(['id', 'custom', 'basedOn', 'debug', 'name', 'title']);

/** 長い文字列は「どう変わったか」ではなく**いまの本文**を出す */
const LONG = 60;

function diffInto(path, a, b, out) {
  if (same(a, b)) return;
  if (a === undefined) { out.push([path, `${path}: （下敷きに無し）→ ${val(b)}`]); return; }
  if (b === undefined) { out.push([path, `${path}: ${val(a)} → （消した）`]); return; }
  const key = KEY_OF[path];
  if (key && Array.isArray(a) && Array.isArray(b)) { diffUnits(path, a, b, key, out); return; }
  if (isPlain(a) && isPlain(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (SKIP.has(k)) continue;
      diffInto(path ? `${path}.${k}` : k, a[k], b[k], out);
    }
    return;
  }
  if (typeof b === 'string' && (String(a).length + b.length) > LONG) {
    out.push([path, `${path}: ${val(b)}   // 下敷きから書き換え`]);
    return;
  }
  out.push([path, `${path}: ${val(a)} → ${val(b)}`]);
}

/**
 * ユニットの並びを突き合わせる。**足した・消した・変えた**の3つに分ける。
 *
 * 位置で比べると、1機足しただけで以降が全部ずれて「全部変わった」と出る。
 * 名前（目標は id）で対応づけると、実際に触ったものだけが残る。
 */
function diffUnits(path, a, b, key, out) {
  const nameOf = (u, i) => String(u[key] ?? `#${i + 1}`);
  const A = new Map(a.map((u, i) => [nameOf(u, i), u]));
  const B = new Map(b.map((u, i) => [nameOf(u, i), u]));
  for (const [k, u] of B) if (!A.has(k)) out.push([path, `${path} ＋ ${val(u)}`]);
  for (const [k, u] of A) if (!B.has(k)) out.push([path, `${path} －「${k}」を消した（${val(u)}）`]);
  for (const [k, u] of A) {
    const v = B.get(k);
    if (!v || same(u, v)) continue;
    const fields = [];
    for (const f of new Set([...Object.keys(u), ...Object.keys(v)])) {
      if (same(u[f], v[f])) continue;
      fields.push(`${f} ${u[f] === undefined ? '（無し）' : val(u[f])}`
        + ` → ${v[f] === undefined ? '（消した）' : val(v[f])}`);
    }
    out.push([path, `${path}「${k}」 ${fields.join(' ／ ')}`]);
  }
}

/** 差分の行を読みやすい順に束ねる */
const SECTIONS = [
  ['難易度', (p) => p === 'weaponPoints' || p.startsWith('rating') || p === 'enemy.skill'],
  ['味方', (p) => p.startsWith('friendly')],
  ['友軍', (p) => p.startsWith('ally')],
  ['敵', (p) => p.startsWith('enemy') && p !== 'enemy.skill' && !p.startsWith('enemy.objectives')],
  ['目標', (p) => p === 'objectives' || p.startsWith('enemy.objectives')],
  ['地形・天候', (p) => p.startsWith('terrain') || p.startsWith('weather')],
  ['文章', (p) => p === 'brief' || p === 'hint'],
];

function diffLines(s, base) {
  const found = [];
  diffInto('', base, s, found);
  if (!found.length) return ['', '// 下敷きとの違いはありません（値はそのまま）'];
  const out = ['', `// ${base.name}（${base.id}）との違い。書いていない節は下敷きのまま`];
  // **同じ節に複数行が出る**（敵機を2つ足した、など）ので、
  // 束ね先は「その行を既に出したか」で覚える。節の名前で覚えると取りこぼす
  const taken = found.map(() => false);
  for (const [label, pred] of SECTIONS) {
    const lines = [];
    found.forEach(([p, text], i) => {
      if (taken[i] || !pred(p)) return;
      taken[i] = true;
      lines.push(text);
    });
    if (lines.length) out.push('', `// ${label}`, ...lines);
  }
  const rest = found.filter((_, i) => !taken[i]).map(([, text]) => text);
  if (rest.length) out.push('', '// そのほか', ...rest);
  return out;
}

// ---------------------------------------------------------------- 全文

function listLines(key, arr) {
  if (!arr || !arr.length) return [];
  return [`${key}: [`, ...arr.map((u) => `  ${val(u)},`), '],'];
}

/** 下敷きが無い面。**定義をそのまま**、ただし1ユニット1行に畳んで出す */
function fullLines(s) {
  const f = s.friendly || {};
  const e = s.enemy || {};
  const out = ['', '// 難易度', `weaponPoints: ${s.weaponPoints},`, `rating: ${val(s.rating)},`];
  if (e.skill != null) out.push(`enemy.skill: ${e.skill},`);
  out.push('', '// 味方');
  if (f.base) out.push(`friendly.base: ${val(f.base)},`);
  out.push(`friendly.startAirborne: ${!!f.startAirborne},`
    + (f.startAlt != null ? ` friendly.startAlt: ${f.startAlt},` : ''));
  out.push(...listLines('friendly.aircraft', f.aircraft));
  out.push(...listLines('friendly.ground', f.ground));
  out.push(...listLines('friendly.support', f.support));
  // 友軍（§102）。書いた面だけ
  const al = s.ally;
  if (al) {
    out.push('', '// 友軍');
    if (al.skill != null) out.push(`ally.skill: ${al.skill},`);
    if (al.escortPlayer === false) out.push('ally.escortPlayer: false,');
    if (al.base) out.push(`ally.base: ${val(al.base)},`);
    out.push(...listLines('ally.aircraft', al.aircraft));
    if (al.reinforce) out.push(`ally.reinforce: ${val(al.reinforce)},`);
    out.push(...listLines('ally.objectives', al.objectives));
    out.push(...listLines('ally.triggers', al.triggers));
  }
  out.push('', '// 敵');
  for (const key of ['base', 'base2']) if (e[key]) out.push(`enemy.${key}: ${val(e[key])},`);
  out.push(...listLines('enemy.aircraft', e.aircraft));
  out.push(...listLines('enemy.ground', e.ground));
  out.push(...listLines('enemy.triggers', e.triggers));
  out.push('', '// 目標');
  out.push(...listLines('objectives', s.objectives));
  out.push(...listLines('enemy.objectives', e.objectives));
  out.push('', '// 地形・天候', `terrain: ${val(s.terrain)},`);
  if (s.weather) out.push(`weather: ${val(s.weather)},`);
  if (s.brief || s.hint) {
    out.push('', '// 文章');
    if (s.brief) out.push(`brief: ${val(s.brief)},`);
    if (s.hint) out.push(`hint: ${val(s.hint)},`);
  }
  return out;
}

// ---------------------------------------------------------------- 出口

/**
 * 面を読める形に写す。
 *
 * @param {object} stage 書き出す面（エディタが持っているもの）
 * @param {?object} base 下敷きの面。`undefined` なら `baseOf()` で探す。
 *   `null` を渡せば下敷き無しとして全文を出す
 * @param {{baseTuned?: boolean}} opts 下敷きに §47 の上書きが載っているか
 */
export function outline(stage, base = baseOf(stage), opts = {}) {
  const out = headLines(stage, base, opts);
  out.push(...(base ? diffLines(stage, base) : fullLines(stage)));
  return out.join('\n');
}
