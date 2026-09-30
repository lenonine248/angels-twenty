// 詳細の資料。JOURNAL §93.5・§93.13。
//
// 戦闘なしで読むページ。チュートリアル一覧の「詳細」から開く。
// **表の数字は全部データか本体の式から引く**（§93.2・§79.5 を資料全体に広げたもの）。
// 釣り合いを取り直しても、ここを書き直さなくてよいようにする。
// 手で書いてよいのは「何を意味するか」の文だけ。
//
// 「試す」は既にある本を開く（案内つき・§93.5）。終えると資料へ戻る（ui/briefing.js）。

import { AIRCRAFT_TYPES, ENEMY_TYPES, SUPPORT_TYPES } from '../data/aircraft.js';
import { perfOf, fullLoad, PERF_ALT } from '../data/perf.js';
import { WEAPONS, loadoutFits, hardpointsOf } from '../data/weapons.js';
import { GROUND_TYPES, weaponsOf } from '../data/ground.js';
import { AXES, MARKS, MARK_SCORE, rankOf } from '../data/rating.js';
import { getTutorial } from '../data/tutorials.js';
import {
  AI_MODES, ENGAGE_RANGE, EVADE_RANGE, SAM_AVOID_RANGE, STRIKE_LOW_AGL,
  ARM_STANDOFF_ALT, GUN_CLEAR_MARGIN,
} from '../ai/pilot.js';
import {
  FUEL_AB_RATE, FUEL_HIGH, FUEL_LOW, LOAD_FUEL_PENALTY, LOAD_TURN_PENALTY,
} from '../sim/aircraft.js';
import { MIN_RANGE, LAUNCH_RANGE_FRAC, FIRE_THRESHOLD, irLockRange } from '../sim/combat.js';
import {
  IDENT_RANGE_RATIO, IDENT_TRACK_TIME, GROUND_VISUAL_RANGE, GROUND_RADAR_FULL_ALT,
  GROUND_RADAR_FLOOR, LOOKDOWN_AGL, LOOKDOWN_FACTOR, LOST_ERROR, LOST_HARD_CAP, WANDER,
  RWR_POS_ERROR, RWR_RANGE,
} from '../sim/detection.js';
import { RWR_SIGNATURE_FACTOR } from '../sim/unit.js';
import { ARM_NOTICE_RANGE, ARM_REACTION, SILENCE_DURATION } from '../sim/ground.js';
import {
  CLOUD_RADAR_PER_KM, CLOUD_RADAR_FLOOR, CLOUD_WIND_SPEED,
} from '../world/clouds.js';
import { effectiveMissileRange } from '../core/atmosphere.js';
import { ALT_PRESETS, CEILING_BUTTON_MIN, RADAR, AB, THRESHOLD, MODE_BUTTONS } from './hud.js';
import { ALT_STEP } from './commands.js';
import { LOADABLE } from './loadout.js';
import { inline, block } from './markup.js';

// ---------------------------------------------------------------- 書き方

/** m → km（小数1桁まで・8000 → "8"・4500 → "4.5"） */
const km = (m) => String(Math.round(m / 100) / 10);
/** 飛べる距離は km の整数で */
const kmI = (m) => String(Math.round(m / 1000));
/** 桁区切りの整数（1500 → "1,500"） */
const n0 = (v) => Math.round(v).toLocaleString('en-US');
const d1 = (v) => (Math.round(v * 10) / 10).toFixed(1);
const minutes = (sec) => (sec / 60).toFixed(1);
const pct = (v) => Math.round(v * 100);

/** 段落。記法は markup.js（**強調**・改行） */
const p = (s) => `<p>${block(s)}</p>`;
const h = (s) => `<h3>${inline(s)}</h3>`;
const notes = (items) => `<ul class="ref-notes">${items.filter(Boolean)
  .map((s) => `<li>${block(s)}</li>`).join('')}</ul>`;

/**
 * 表。行の先頭のセルを行の見出しにする。
 * セルは文字列（記法を通す）か `{ html }`（そのまま入れる）。
 * `num` に入れた列は右寄せ・等幅の数字にする。
 */
function table(head, rows, { num = [] } = {}) {
  const cls = (i) => (num.includes(i) ? ' class="num"' : '');
  const cell = (c) => (c && typeof c === 'object' ? c.html : block(c == null ? '' : String(c)));
  const th = head.map((x, i) => `<th${cls(i)}>${block(x)}</th>`).join('');
  const body = rows.map((r) => `<tr>${r.map((c, i) => (i === 0
    ? `<th>${cell(c)}</th>`
    : `<td${cls(i)}>${cell(c)}</td>`)).join('')}</tr>`).join('');
  return `<div class="ref-scroll"><table class="ref-table"><thead><tr>${th}</tr></thead>`
    + `<tbody>${body}</tbody></table></div>`;
}

/** 「試す」のボタン（表の行に置く小さいもの） */
function tryButton(id) {
  const t = getTutorial(id);
  if (!t) return '';
  return `<button class="ref-trybtn" data-act="tryTutorial" data-id="${id}"
    title="${t.name} — ${t.title}">試す</button>`;
}

/** 資料の末尾に並べる「試す」 */
function trySection(ids) {
  const list = (ids || []).map(getTutorial).filter(Boolean);
  if (!list.length) return '';
  const btns = list.map((t) => `
    <button data-act="tryTutorial" data-id="${t.id}">${t.name}<span>${t.title}</span></button>`).join('');
  return `<div class="ref-try">${h('試す')}
    <div class="ref-trylist">${btns}</div>
    <p class="ref-dim">案内つきの場が開きます。終えるとこの資料へ戻ります</p></div>`;
}

const PLAYER_TYPES = Object.keys(AIRCRAFT_TYPES);
const typeName = (id) => AIRCRAFT_TYPES[id]?.name || id;

// ---------------------------------------------------------------- 1. 操作

/**
 * キーとマウス。**入力を受けている所**: `ui/commands.js`（選択・指示・Z/X/C/B/G/数字/Tab/Esc）、
 * `world/scene.js`（WASD/QE/RF・ホイール・中ボタン）、`main.js`（Space・[ ]・H・M）。
 * 増やしたらここも足す。
 */
function controlsBody() {
  const mouse = [
    ['左クリック', '自軍機を選ぶ。**Shift を押しながら**で足す／外す'],
    ['左ドラッグ', '囲んだ自軍機をまとめて選ぶ'],
    ['右クリック（地面）', '選んだ機体をそこへ移動させる（編隊なら隊形のまま）'],
    ['右クリック（敵）', '攻撃指示。**使用兵装を指定していれば、その兵装での射撃指示**'],
    ['右クリック（自軍機）', '随伴（その機体に付いていく）'],
    ['Shift＋右クリック', '指示を後ろに足す（経路を引く）'],
    ['ホイール', 'ズーム'],
    ['中ボタンでドラッグ', '視点を回す・倒す'],
  ];
  const keys = [
    ['Z ／ X', `指示高度を ${n0(ALT_STEP)}m 下げる／上げる`],
    ['C', '選んだ機体へ視点を寄せる'],
    ['B', '帰投'],
    ['G ／ Shift＋G', '編隊を組む／解散する'],
    ['1〜9', 'その番号の編隊を選ぶ'],
    ['Ctrl＋1〜9', '選んでいる編隊の番号を付け替える'],
    ['Tab ／ Shift＋Tab', '次／前の機体を選ぶ'],
    ['Esc', '選択を外す。何も選んでいなければメニュー'],
    ['W A S D', '視点を動かす（Shift で速く）'],
    ['Q ／ E', '視点を回す'],
    ['R ／ F', '視点を倒す・起こす'],
    ['Space', '一時停止'],
    ['[ ／ ]', '時間の速さを変える'],
    ['H', '操作の早見表を出す／隠す'],
    ['M', '音を消す／戻す'],
  ];
  const opts = (list) => list.map(([, label, desc]) => `**${label}** — ${desc}`).join('\n');
  const thr = THRESHOLD.map(([id, label]) => `${label} ${pct(FIRE_THRESHOLD[id])}%`).join('・');
  const panel = [
    ['高度', `${ALT_PRESETS.map(([m, label]) => `${label} ${n0(m)}m`).join('・')}。`
      + `上昇限度が ${n0(CEILING_BUTTON_MIN)}m 以上の機体には「限界」も出る`],
    ['AIモード', `${MODE_BUTTONS.map((id) => AI_MODES[id].label).join('・')}（→ AIモード）`],
    ['レーダー', opts(RADAR)],
    ['AB', `${opts(AB)}\nAB を積んでいない機体には出ない`],
    ['自動発射のしきい値', `命中の期待度がこれを下回ると、AI は自分からは撃たない（${thr}）`],
    ['兵装', '兵装ごとに自動で使ってよいか・**使用兵装の指定**・射撃指示の取消'],
    ['デコイ', '飛んでくるミサイルにフレア／チャフを自動で撒くか'],
    ['整備', '飛行場に降りると出る。積み替え・「整備後に発進」'],
  ];
  return p('戦闘中は **H** で画面の隅に早見表を出し入れできます。ここはその全部です。')
    + h('マウス') + table(['操作', '働き'], mouse)
    + h('キー') + table(['キー', '働き'], keys)
    + h('機体のパネル')
    + p('機体を選ぶとパネルが出ます。ボタンに重ねると説明が出ます。')
    + table(['欄', '選べるもの'], panel);
}

// ---------------------------------------------------------------- 2. 3機の違い

function aircraftBody() {
  const ids = PLAYER_TYPES;
  const empty = ids.map((id) => perfOf(id));
  const full = ids.map((id) => perfOf(id, { loadout: fullLoad(id) }));
  const base = empty[0];
  const row = (label, f) => [label, ...ids.map((id, i) => f(empty[i], full[i], AIRCRAFT_TYPES[id]))];
  const range = (sec, m) => `${minutes(sec)}分\n${kmI(m)}km`;

  const rows = [
    row('巡航', (e) => `${n0(e.cruise)} m/s`),
    row('最高（AB 無し）', (e) => `${n0(e.milSpeed)} m/s`),
    row('最高（AB 全開）', (e) => (e.hasAb ? `${n0(e.abSpeed)} m/s` : 'AB 無し')),
    row('最良旋回（空荷）', (e) => `${d1(e.turnDeg)}°/s\n${n0(e.turnSpeed)} m/s・${d1(e.turnG)}G`),
    row('最良旋回（重さいっぱい）', (e, f) => `${d1(f.turnDeg)}°/s`),
    row('上昇率', (e, f, s) => `${n0(s.climbRate)} m/s`),
    row('上昇限度', (e, f, s) => `${n0(s.ceiling)} m`),
    row('耐久', (e, f, s) => String(s.hp)),
    row('飛べる時間（空荷）', (e) => range(e.enduranceSec, e.rangeM)),
    row('飛べる時間（重さいっぱい）', (e, f) => range(f.enduranceSec, f.rangeM)),
    row('飛べる時間（AB 全開・空荷）', (e) => (e.hasAb ? range(e.abEnduranceSec, e.abRangeM) : '—')),
    row('レーダー', (e) => `${km(e.radarRange)}km\n左右 ${e.radarFovH}°`),
    row('扇の広さ（F-1＝1）', (e) => `${(e.sweep / base.sweep).toFixed(1)}倍`),
    row('逆探知に映る距離', (e) => `${km(e.rwrRange)}km`),
    row('目視', (e, f, s) => `${km(s.visualRange)}km`),
    row('フレア／チャフ', (e, f, s) => `${s.flares}／${s.chaff}`),
    row('枠（中型・小型）', (e, f, s) => { const hp = hardpointsOf(s); return `${hp.medium}・${hp.small}`; }),
    row('重さの基準', (e, f, s) => String(s.loadCapacity)),
    row('機銃弾', (e, f, s) => `${s.gunRounds}発`),
  ];

  // 高度で変わるもの（F-1 の空荷で見せる）
  const alts = [0, PERF_ALT, 10000];
  const f1 = alts.map((alt) => perfOf(ids[0], { alt }));
  const byAlt = alts.map((alt, i) => `${alt ? `${n0(alt)}m` : '海面'} ${d1(f1[i].turnDeg)}°/s`).join('・');

  // ほかに出てくる機体
  const others = { ...ENEMY_TYPES, ...SUPPORT_TYPES };
  const otherRows = Object.keys(others).map((id) => {
    const s = others[id];
    const e = perfOf(id);
    const traits = [];
    if (s.rcs != null) traits.push(`レーダーに映る距離が **${pct(s.rcs)}%**（目視・逆探知には効かない）`);
    if (s.omniRadar) traits.push('全方位のレーダー');
    if (!hardpointsOf(s).total) traits.push('武装なし');
    if (s.noAfterburner) traits.push('AB 無し');
    return [s.name, `${n0(e.cruise)}\n${n0(e.abSpeed ?? e.milSpeed)}`, `${d1(e.turnDeg)}°/s`,
      `${km(s.radarRange)}km`, String(s.hp), traits.join('\n') || '—'];
  });

  return p('F-1・F-2・A-3 は、**速さ／電波／持久**を1つずつ受け持っています。'
      + 'どれかが強いのではなく、得意な場面と払う代償が違います。\n'
      + `数字は高度 ${n0(PERF_ALT)}m のもの。「重さいっぱい」は積んだ重さが機体の基準に達した状態です（→ 搭載枠）。`)
    + table(['', ...ids.map(typeName)], rows, { num: [1, 2, 3] })
    + notes([
      `**${ids[0]} は速さの機体。** 速く、よく曲がり、早く上がる。代償は燃料と耐久 —— 先に着いて先に撃ち、長くは居られない`,
      `**${ids[1]} は電波の機体。** いちばん広く見えて、**いちばん遠くから見つかる**。遅いので追いつけず、急いで駆けつけることもできない`,
      `**${ids[2]} は持久の機体。** 耐久・燃料・枠が多い。AB を積んでいないので速く逃げる手段は無いが、焚いて燃料を減らすことも無い。遅く、遠くが見えない`,
      '**高いほど空気が薄い。** 最高速はわずかに伸びるが、**旋回は鈍る** '
        + `（${ids[0]} の最良旋回: ${byAlt}）。`
        + `燃料の減りは ${n0(FUEL_HIGH.alt)}m より上で **${FUEL_HIGH.rate}倍**、`
        + `${n0(FUEL_LOW.alt)}m より下で **${FUEL_LOW.rate}倍**、AB を焚くと **${FUEL_AB_RATE}倍**`,
      '**フレア**は赤外線の弾を惹きつける。**チャフは相手のレーダーを騙すのではなく、視線を遮る** —— '
        + '照射している相手に対して**真横を向く**か**背を向けて離れる**ときに効く。'
        + '自動にしておけば、その向きになったときに撒く',
    ])
    + h('ほかに出てくる機体')
    + table(['機体', '巡航\n最高 m/s', '最良旋回', 'レーダー', '耐久', '特徴'], otherRows, { num: [1, 2, 3, 4] });
}

// ---------------------------------------------------------------- 3. AIモード

function aiModesBody() {
  const r = (m) => `${km(m)}km`;
  const rows = {
    PATROL: [r(ENGAGE_RANGE.PATROL),
      'いまの場所を中心に旋回して索敵し、**近づいた敵だけ**迎え撃つ。深追いしない。'
      + '中心はモードを選んだ位置か、移動の行き先'],
    PURSUIT: [r(ENGAGE_RANGE.PURSUIT),
      '探知した敵へ積極的に向かう。逃がしたくないときに。**深追いして燃料を使い切ることがある**'],
    COORDINATE: [r(ENGAGE_RANGE.COORDINATE),
      '追撃と同じ距離で、**編隊でレーダーの扇を左右に分担**して広く探す。単機では追撃に近い。迷ったらこれ'],
    EVADE: [r(EVADE_RANGE),
      '探知している敵がこの距離に入ると、交戦を避けて低空へ降り、**自軍飛行場へ**逃げる'],
    ESCORT: [`${r(ENGAGE_RANGE.ESCORT)}\n（守る相手から）`,
      '**随伴している相手**に近づく敵機を迎えに行く。随伴の指示が無いと哨戒に戻る'],
    STRIKE: ['—',
      `見えている地上目標へ進撃する。SAM の圏（${r(SAM_AVOID_RANGE)}）では**対地 ${n0(STRIKE_LOW_AGL)}m へ降りる**。`
      + `ARM を積んでいれば逆に **${n0(ARM_STANDOFF_ALT)}m へ上げる**（高いほど ARM が遠くまで届き、SAM の外から撃てる）`],
    MANUAL: ['—',
      `${AI_MODES.MANUAL.desc}。「撃つな」「ここを飛べ」を厳密に守らせたいときのモードで、放っておくモードではない`],
  };
  const list = MODE_BUTTONS.map((id) => [AI_MODES[id].label, ...(rows[id] || ['—', AI_MODES[id].desc])]);
  return p('機体は放っておいても自分で戦います。AIモードは**何を優先するか**の指定です。'
      + '「動き出す距離」は、探知した敵がこれより近いと動く距離です。')
    + table(['モード', '動き出す距離', 'すること'], list, { num: [1] })
    + notes([
      '**どのモードでも撃ちすぎない** —— 飛んでいる味方の弾で落とし切れる見込みなら、次を撃たない',
      '**手動以外は**、飛んでくるミサイルを避け、燃料が減れば帰る',
      `**手動以外は**、高度を指示していなければ、知っている対空砲・赤外線SAM の射高より ${n0(GUN_CLEAR_MARGIN)}m 上へ自分で上がる（→ 敵の防空）`,
      '**帰投**はモードではなく指示（B キー）',
      `敵には持ち場を離れない「${AI_MODES.GUARD.label}」もいる —— ${AI_MODES.GUARD.desc}`,
    ]);
}

// ---------------------------------------------------------------- 4. 兵装一覧

/** 兵装 → その兵装の本（兵装の群・§93.4） */
const TRY_OF_WEAPON = { GUN: 'w1', 'AAM-S': 'w2', 'AAM-M': 'w3', 'AAM-A': 'w4', AGM: 'w5', ARM: 'w6', BOMB: 'w7', TANK: 'w8' };

const GUIDANCE = {
  ir: '赤外線\n撃ちっぱなし',
  sarh: 'セミアクティブ\n当たるまで自機が照射',
  arh: 'アクティブ\n僚機のレーダーでも導ける',
  command: '撃ちっぱなし',
  arm: '電波を追う',
  none: '無誘導',
};

/** 撃つときの高さ（撃つ側と的の平均）。低空と高空の2点で見せる */
const LOW_ALT = 1000;
const HIGH_ALT = 7000;

/**
 * 最後の一撃（§12.2）になれるか。数えるのは「誘導が生きている」弾で、
 * **照射が要る弾（`fireAndForget: false`）は発射した機体が落ちると誘導が切れる**
 * （missile.js の `_updateGuidance`・mission.js の `_ordnanceAloft`）。
 */
const canLastStrike = (w) => w.fireAndForget !== false;

function weaponsBody() {
  const rows = LOADABLE.map((id) => {
    const w = WEAPONS[id];
    const air = w.kind === 'aam';
    const target = w.kind === 'support' ? '—' : (air ? '空' : '地上');
    let reach = '—';
    if (w.range) {
      // combat.js の `_envelopeReason` と同じ門の順: 射程（高度で伸びる）→ 赤外線が掴める距離。
      // 赤外線は真後ろから（掴める距離がいちばん長い向き）で見せる
      const lock = w.guidance === 'ir' ? irLockRange(w, 1) : Infinity;
      const at = (alt) => Math.min(effectiveMissileRange(w, alt) * LAUNCH_RANGE_FRAC, lock);
      reach = `${km(w.range)}km\n撃つのは ${km(at(LOW_ALT))}／${km(at(HIGH_ALT))}km`;
    }
    const pylon = w.pylon === 'small' ? '小型（中型にも）' : '中型';
    return [`${id}\n${w.name}`,
      `${target}\n${GUIDANCE[w.guidance] || w.guidance || '—'}`,
      reach,
      `${w.cost}P`,
      `${pylon}\n重さ ${w.slots}`,
      w.rearmSeconds ? `${w.rearmSeconds}秒` : '—',
      w.kind === 'support' ? '—' : (canLastStrike(w) ? '○' : '×'),
      { html: tryButton(TRY_OF_WEAPON[id]) }];
  });
  rows.unshift(['機銃', '空・地上\n無誘導', '—', '0P', '枠を使わない', '—', '×', { html: tryButton(TRY_OF_WEAPON.GUN) }]);

  const S = WEAPONS['AAM-S'], M = WEAPONS['AAM-M'], A = WEAPONS['AAM-A'];
  const G = WEAPONS.AGM, R = WEAPONS.ARM, T = WEAPONS.TANK;
  const free = LOADABLE.filter((id) => WEAPONS[id].cost === 0).join('・');
  const minR = Object.entries(MIN_RANGE).filter(([k]) => k !== 'default')
    .map(([k, v]) => `${k} ${n0(v)}m`).join('・');

  const reasons = [
    ['射程外／近すぎ', `撃てる距離の外。最小射程は ${minR}、ほかは ${n0(MIN_RANGE.default)}m`],
    ['機首から遠い N度（この距離では M度まで）', '弾が曲がり切れない角度。**遠いほど横を向いたままでも撃てる**（飛ぶ時間が長いぶん曲がれる）。近いほど正面を向くまで待つ'],
    ['射角外 N度', '弾の目（シーカー）が見える角度の外'],
    ['熱を掴めない（この向きでは X km まで）', '赤外線が相手の排気を掴めない。**正面ほど近づく必要がある**'],
    ['レーダー範囲外・左右／上下の扇の外・レーダー沈黙', 'AAM-M の照射ができない。自機のレーダーの扇に相手を入れる'],
    ['電波なし', 'ARM の相手が電波を出していない'],
    ['高度が低い／高い', 'その兵装を撃てる高度の外'],
    ['再装填 N秒', '次を撃てるまでの間'],
    ['○○ 誘導中／味方が誘導中', '同じ相手へ自分の同じ弾が飛んでいる／味方の弾で落とし切れる見込み（自動で撃つときだけ）'],
    ['期待度不足', '命中の期待度が自動発射のしきい値の下（自動で撃つときだけ。射撃指示なら撃つ）'],
    ['未探知・視線なし', '相手が見えていない。地形や雲に遮られている'],
  ];

  return p('撃つまでの流れ（攻撃指示 → 使用兵装の指定 → 右クリックで射撃指示）は基本「空対空」で扱っています。ここは兵装ごとの違いです。\n'
      + `「撃つのは」は、撃つ側と相手の平均高度が ${n0(LOW_ALT)}m／${n0(HIGH_ALT)}m のときに実際に撃ち始める距離です。`
      + 'コストは兵装ポイント（→ 勝敗と評価）、枠と重さは → 搭載枠。')
    + table(['兵装', '相手・誘導', '射程', 'コスト', '枠', '積み直し', '最後の一撃', ''], rows, { num: [3, 5] })
    + notes([
      `**コスト0（${free}）はいくら積んでも兵装ポイントが減らない**`,
      `**AAM-S** は相手の熱を追う。掴める距離は向きで変わり、**真後ろからなら ${km(irLockRange(S, 1))}km、正面からは ${km(irLockRange(S, 0))}km**。`
        + '近すぎても当たらない（曲がり切るだけの飛ぶ時間が要る）',
      '**AAM-M** は当たるまで自機のレーダーの扇に相手を入れ続ける。**誘導中に背を向けると外れる**。'
        + `高く撃つほど遠くまで届く（射程 ${km(M.range)}km）。発射した機体が落ちると誘導が切れるので、最後の一撃になれない`,
      `**AAM-A** は僚機のレーダーでも導けるので、**自機のレーダーを切ったまま撃てる**。最後は自分で相手を捉え、AAM-M より強く曲がる。コストは AAM-M の ${A.cost / M.cost}倍`,
      `**AGM** は高度を上げてもあまり伸びない。爆風があり、半径 ${G.blastRadius}m の至近弾でも効く`,
      `**ARM** は電波を出している相手にだけ撃てる。**高度 ${n0(R.minLaunchAlt)}m 以上から**。相手が電波を止めると最後の座標へ飛ぶ（爆風 ${R.blastRadius}m）。`
        + `高度を指示せずに攻撃させると、ARM が残っているうちは **${n0(ARM_STANDOFF_ALT)}m を保って**撃ち、撃ち尽くしてから降りる`,
      '**BOMB** は目標の真上を通って落とす。低く落とすほど正確で、高く落とすほど散る（散り方は落ちている時間で決まる）。'
        + '兵装パネルの「爆撃 トス」にすると、低く速く入って**手前で機首を上げて投げ上げ**、上を通らずに引き返す。'
        + '山地では**地形に沿って低く入り**、投げる前に爆弾が稜線を越えられる高さまで上がる —— 山の陰の目標を、陰にいる時間を長くして叩ける。'
        + '投げ上げた爆弾は長く飛ぶぶん散る',
      `**増槽**は燃料 +${pct(T.fuelBonus)}%。空になると自分で落とす`,
      '兵装ごとに「自動で使ってよいか」を切り替えられる。**使用兵装を指定しなければ、自動で使ってよい兵装から選んで撃つ**',
    ])
    + h('撃てない理由')
    + p('射撃指示を出すと、撃てないあいだは札の横に理由が出ます。')
    + table(['表示', '意味'], reasons);
}

// ---------------------------------------------------------------- 5. 搭載枠

function pylonsBody() {
  const ids = PLAYER_TYPES;
  /** その兵装だけを積むなら何発まで載るか（`loadoutFits` がブリーフィングと同じ判定） */
  const maxAlone = (id, spec) => {
    let n = 0;
    while (n < 20 && loadoutFits(new Array(n + 1).fill(id), spec)) n++;
    return n;
  };
  const rows = LOADABLE.map((id) => {
    const w = WEAPONS[id];
    return [`${id}\n${w.name}`, w.pylon === 'small' ? '細い（小型）' : '太い（中型）', String(w.slots),
      ...ids.map((t) => `${maxAlone(id, AIRCRAFT_TYPES[t])}`)];
  });
  const head = ids.map((t) => {
    const hp = hardpointsOf(AIRCRAFT_TYPES[t]);
    return `${t}\n中${hp.medium}・小${hp.small}`;
  });
  const thick = LOADABLE.filter((id) => WEAPONS[id].pylon !== 'small').join('・');
  const thin = LOADABLE.filter((id) => WEAPONS[id].pylon === 'small').join('・');
  const bases = ids.map((t) => `${t} ${AIRCRAFT_TYPES[t].loadCapacity}`).join('・');

  // 基準を超えて積んだときの例: 攻撃機に対地ミサイルを積めるだけ
  const heavy = ids[ids.length - 1];
  const nHeavy = maxAlone('AGM', AIRCRAFT_TYPES[heavy]);
  const e0 = perfOf(heavy);
  const eh = perfOf(heavy, { loadout: new Array(nHeavy).fill('AGM') });
  const fuelX = e0.enduranceSec / eh.enduranceSec;

  return p('枠は**太さ（中型／小型）の本数**で数えます。積める数を決めるのはこの本数です。'
      + 'ブリーフィングで枠の表示が赤くなったら載せ切れていません。')
    + table(['兵装', '太さ', '重さ', ...head], rows, { num: [2, 3, 4, 5] })
    + p('右の3列は、その兵装だけを積んだときに載る数です。')
    + notes([
      `**太い兵装（${thick}）は中型にしか載らない。** 細い空対空弾（${thin}）は小型にも、余った中型にも載る。`
        + '太い兵装どうしは中型の枠を取り合う',
      `**重さは上限ではない。** 積んだ重さの合計が機体の基準（${bases}）に達すると、`
        + `旋回が **${pct(LOAD_TURN_PENALTY)}%** 鈍り、燃料の減りが **${pct(LOAD_FUEL_PENALTY)}%** 増える。`
        + `基準を超えて積めば、そのぶんさらに鈍る —— ${heavy} に AGM を${nHeavy}発（重さ ${eh.slots}）積むと、`
        + `旋回は空荷の ${pct(eh.turnDeg / e0.turnDeg)}%、飛べる時間は 1/${d1(fuelX)}`,
      '飛行場に降りれば積み替えられる（パネルの「整備」）。積み直しにかかる時間は兵装ごと（→ 兵装一覧）。'
        + '**積み直しも兵装ポイントから引かれる**（→ 勝敗と評価）',
    ]);
}

// ---------------------------------------------------------------- 6. 探知

function detectionBody() {
  const player = PLAYER_TYPES.map((t) => AIRCRAFT_TYPES[t]);
  const radarOf = player.map((s) => `${s.id} ${km(s.radarRange)}km`).join('・');
  const rwrOf = player.map((s) => `${s.id} ${km(s.radarRange * RWR_SIGNATURE_FACTOR)}km`).join('・');
  const site = GROUND_TYPES.RADAR;
  const awacs = Object.values(SUPPORT_TYPES).find((s) => s.omniRadar);
  const visual = player[0].visualRange;
  const stealth = Object.values(ENEMY_TYPES).filter((s) => s.rcs != null)
    .map((s) => `${s.name}（${pct(s.rcs)}%）`).join('・');
  // 見失ってから忘れるまで: 誤差が LOST_ERROR に育つまで（detection.js §54）
  const forget = (speed) => Math.round(LOST_ERROR / (speed * WANDER));

  const rows = [
    ['目視', `機体 ${km(visual)}km\n地上 ${km(GROUND_VISUAL_RANGE)}km`, '全方位', '**機種まで**', '地形・雲'],
    ['機体のレーダー', radarOf.replace(/・/g, '\n'), '機首の扇', `探知距離の ${pct(IDENT_RANGE_RATIO)}% より近いか、`
      + `${IDENT_TRACK_TIME}秒追い続けると**種別**。それまでは「何か居る」`, '地形。雲の中を通ると弱る'],
    ['地上レーダー・早期警戒機', `${site.name} ${km(site.radar.range)}km`
      + (awacs ? `\n${awacs.name.split(' ')[0]} ${km(awacs.radarRange)}km` : ''), '全方位', '同上', '地形。低空の相手に弱い'],
    ['逆探知', `相手のレーダー射程の ${RWR_SIGNATURE_FACTOR}倍`, '全方位', '機体なら「何かが電波を出している」まで。地上なら**種別**。位置はぶれる',
      '地形だけ（雲では弱らない）'],
  ];
  return p('画面に出ている敵は「いま把握できている情報」です。見つける手段は3つあり、届く距離と分かることが違います。')
    + table(['手段', '届く距離', '向き', '分かること', '遮るもの'], rows)
    + notes([
      '**レーダーに映るのは空中の機体だけ。** 地上目標は目視・逆探知・ブリーフィングで判明しているものでしか分からない',
      `**電波を出すと見つかる。** 自機のレーダーは射程の ${RWR_SIGNATURE_FACTOR}倍の距離から相手の逆探知に映る（${rwrOf}）。`
        + 'レーダーの「自動」は、敵を掴んでいないときだけ探すために出す',
      `**低空は見つかりにくい。** 地上レーダーは対地 ${n0(GROUND_RADAR_FULL_ALT)}m で満額、地表すれすれでは ${pct(GROUND_RADAR_FLOOR)}% まで落ちる。`
        + `機体のレーダーも、見下ろした先の相手が対地 ${n0(LOOKDOWN_AGL)}m より低いと探知距離が ${pct(LOOKDOWN_FACTOR)}%`,
      stealth && `**見つけにくい機体がいる** —— ${stealth}。レーダーに映る距離が縮む。目視と逆探知には効かない`,
      `**逆探知の位置はぶれる。** ${km(RWR_RANGE)}km で最大 ${n0(RWR_POS_ERROR)}m、近づくほど縮み、目視の距離まで寄れば正確になる`,
      '**見失っても印は残る。** 最後に見た速さで推測位置を延ばし、誤差の円が広がっていく。'
        + `速い相手ほど早く忘れる —— 300m/s の戦闘機なら ${forget(300)}秒。どんなに遅い相手でも ${LOST_HARD_CAP}秒で消える`,
    ]);
}

// ---------------------------------------------------------------- 7. 敵の防空

/** 防空の種類ごとの避け方（武器の種類で引く —— §72.3「何を積んでいるか」で見る） */
const DODGE = {
  sam: (w) => `低く飛ぶ（対地 ${n0(w.minAlt)}m より下へは撃てず、地上レーダーは低空に弱い）か、ARM で圏の外から叩く`,
  irsam: (w) => `**上を通る**（${n0(w.maxAlt)}m より上）。電波を出さないので、降りても隠れない`,
  aaa: (w) => `**射高（${n0(w.maxAlt)}m）より上を通る**`,
};
const SAM_RANGE = { sam: WEAPONS['SAM-M'].range, irsam: WEAPONS['IR-SAM'].range };

/**
 * ミサイル艦は ARM 何発で沈むか（§106）。表に耐久の列が無いので、ここでだけ言う。
 * SAM 陣地は1発で沈むので「黙らせてから近づく」がそのまま通るが、艦は足りないと
 * 沈黙が明けて撃ち直してくる（実測で ARM×2＋AGM×2 は SAM 陣地 12/12・艦 0/12）。
 */
function samshipNote() {
  const ship = GROUND_TYPES.SAMSHIP;
  const arm = WEAPONS.ARM.damage;
  const n = Math.ceil(ship.hp / arm);
  const site = Math.ceil(GROUND_TYPES.SAM.hp / arm);
  return `**${ship.name}は ARM ${n}発で沈む**（SAM陣地は ${site}発）。${n - 1}発では残り、`
    + `黙った ${SILENCE_DURATION}秒が明けると撃ち直してくる。黙らせてから近づくなら、${n}発をまとめて当てる`;
}

function defenseBody() {
  const kinds = ['SAM', 'IRSAM', 'AAA', 'SAMSHIP', 'SHIP', 'CARRIER', 'RADAR'];
  const rows = kinds.filter((k) => GROUND_TYPES[k]).map((k) => {
    const g = GROUND_TYPES[k];
    const ws = weaponsOf(g);
    const reach = ws.map((w) => {
      const r = w.range ?? SAM_RANGE[w.kind] ?? 0;
      const lo = w.minAlt ? `${n0(w.minAlt)}` : '0';
      const hi = Number.isFinite(w.maxAlt) ? `${n0(w.maxAlt)}m` : '上限なし';
      const label = { sam: 'SAM', irsam: '赤外線', aaa: '砲' }[w.kind] || w.kind;
      return `${label} ${km(r)}km・${lo}〜${hi}`;
    }).join('\n') || '撃たない';
    const radio = g.radar && g.radar.emits
      ? `出す（探知 ${km(g.radar.range)}km）\n逆探知に映る`
      : '出さない\n逆探知に映らない';
    const dodge = ws.map((w) => DODGE[w.kind]?.(w)).filter(Boolean).join('\n')
      || '撃ってこないが、見つかると敵機が来る';
    return [g.name, reach, radio, dodge];
  });
  return p('地上からの対空は3種類（SAM・赤外線SAM・対空砲）で、**避け方がそれぞれ違います**。艦船はこれを組み合わせて持っています。')
    + table(['種類', '射程・射高（対地）', '電波', '避け方'], rows)
    + notes([
      `**SAM は ARM が来ると電波を止めて隠れる** —— ARM が ${km(ARM_NOTICE_RANGE)}km まで来ると ${ARM_REACTION}秒で止め、${SILENCE_DURATION}秒黙る。`
        + '黙っているあいだは撃ってこない（ARM は最後の座標へ飛ぶ）。レーダーサイトは止めない',
      ...(GROUND_TYPES.SAMSHIP ? [samshipNote()] : []),
      '**対空砲の弾は実体。** まっすぐ突っ込めば当たり、横切る・蛇行で当たりにくい。射高より上がいちばん確実',
      `**パイロットは、知っている対空砲・赤外線SAM の射高より ${n0(GUN_CLEAR_MARGIN)}m 上へ自分で上がる**（手動と、高度を指示しているときを除く）。`
        + '**知らない砲は避けられない** —— 対空砲は電波を出さないので、目視でしか見つからない',
      `**SAM は低く、赤外線SAM と対空砲は高く避ける。** 対地攻撃モードは SAM の圏で対地 ${n0(STRIKE_LOW_AGL)}m へ降りるが、`
        + '知っている砲の圏に近づけば、その射高の上へ上がり直す',
      '**雲は光と赤外線を切る** —— 雲の向こうの機体は、赤外線SAM も対空砲も撃てない（→ 雲と天候）',
    ]);
}

// ---------------------------------------------------------------- 8. 雲と天候

function weatherBody() {
  const shrink = pct(1 - CLOUD_RADAR_PER_KM);
  const rows = [
    ['目視', '**見えない**'],
    ['対空砲', '**撃てない**（雲の向こうは狙えない）'],
    ['赤外線（AAM-S・赤外線SAM）', '**掴めない**。雲の中にいる相手は背景に紛れて掴みにくい'],
    ['レーダー・AAM-M の照射・SAM', `**通るが弱る**。雲の中を 1km 通るごとに届く距離が ${shrink}% 縮む（最低 ${pct(CLOUD_RADAR_FLOOR)}%）。層を横切るだけなら少し、層の中を飛べば大きく落ちる`],
    ['逆探知', '**素通し**。雲の中でも電波を出せば見つかる'],
  ];
  return p('雲は**光と赤外線を通さず、電波は通すが弱らせます**。'
      + 'だから雲は、**見つけられたくない側に味方します** —— 層に潜れば照射から紛れ、層の上を通れば赤外線SAM と対空砲から隠れる。'
      + 'ただし自分からも見えなくなります。')
    + table(['何が', '雲を挟むと'], rows)
    + notes([
      '**層の高さは画面に出ない。** 視点を倒して（R／F・中ボタンのドラッグ）、機体と層の上下を横から見比べる',
      `**風は雲だけを流す**（機体は流されない）。向きはミニマップ右下の印。ふつうは ${CLOUD_WIND_SPEED}m/s（1分で約 ${km(CLOUD_WIND_SPEED * 60)}km）`,
      '**AI は雲を狙って使わない。** 敵も味方も、層に潜って隠れる・層の下から忍び寄る、はしない。'
        + '雲を使うなら高度を指示する',
    ]);
}

// ---------------------------------------------------------------- 9. 勝敗と評価

function victoryBody() {
  // 目標の型は sim/mission.js の advanceObjective の分岐と同じ
  const goals = [
    ['撃破', '指定された敵を全部倒す（増援がまだ湧くうちは、全部倒したことにならない）', '達成'],
    ['到達', '指定の味方が地点に着く', '達成'],
    ['耐える', '指定の時間を過ぎる', '達成'],
    ['守る', '指定の味方を**1つでも**失うと失敗', '失えば負け'],
    ['保持', '目標欄に「N/M 健在」と出る。決められた数を下回ると失敗', '失えば負け'],
  ];
  const marks = [MARKS.GOOD, MARKS.OK, MARKS.POOR].map((m) => `${m} ${MARK_SCORE[m]}点`).join('・');
  // 合計点 → 評価（rating.js の rankOf を 0〜満点で引く）
  const max = AXES.length * MARK_SCORE[MARKS.GOOD];
  const bands = [];
  for (let s = max; s >= 0; s--) {
    const rank = rankOf(s);
    const b = bands.find((x) => x.rank === rank);
    if (b) b.lo = s; else bands.push({ rank, hi: s, lo: s });
  }
  const bandText = bands.map((b) => `${b.rank} ${b.hi === b.lo ? b.hi : `${b.lo}〜${b.hi}`}点`).join('・');
  const noLast = LOADABLE.filter((id) => WEAPONS[id].kind !== 'support' && !canLastStrike(WEAPONS[id])).join('・');
  const axes = AXES.map((a) => [a.label, a.desc]);
  const free = LOADABLE.filter((id) => WEAPONS[id].cost === 0).join('・');

  return p('目標には**達成すれば勝ち**のものと、**失えば負け**のものがあります。前者をすべて達成すれば勝ちです。')
    + table(['目標', '中身', ''], goals)
    + h('負けになるとき')
    + notes([
      '「失えば負け」の目標を失った',
      '自軍の飛行場をすべて失った',
      '自軍の戦闘機が全滅した —— **ただし放った弾が空にあるうちは負けにしない（最後の一撃）**。'
        + `その弾が最後の目標を落とせば勝ち。${noLast} は発射した機体が落ちると誘導が切れるので、最後の一撃になれない`,
      '制限時間を過ぎた（制限のある面だけ）',
    ])
    + h('評価')
    + p(`勝つと3つの軸で評価が付きます。軸ごとに ${marks}、合計で **${bandText}**。`
      + '◎と○の帯は面ごとに違い、ブリーフィングに出ています。')
    + table(['軸', '数えるもの'], axes)
    + notes([
      '**兵装ポイントは、出撃時の搭載と、帰投して積み直したぶんが同じ財布から引かれる。** 残りが足りなければ積み直せない。'
        + '積んだまま使わなかった兵装を降ろせば戻る',
      `コスト0の兵装（${free}）はいくら積んでも減らない`,
      '練度は機体だけでなく、失った施設・地上部隊も数える。燃料切れ・地形への衝突も失ったうち',
      'チュートリアルには失敗も評価もない',
    ]);
}

// ---------------------------------------------------------------- 目次

/**
 * 資料の項目（表示順）。§93.5 の9項目。
 * `tries` は末尾に並べる「試す」（兵装一覧は表の行ごとに置く）。
 */
export const REFERENCE = [
  { id: 'controls', name: '操作一覧', title: 'キー・マウス・パネル', body: controlsBody },
  { id: 'aircraft', name: '3機の違い', title: '速さ／電波／持久', body: aircraftBody, tries: ['x2'] },
  { id: 'aimodes', name: 'AIモード', title: '任せ方を7つから選ぶ', body: aiModesBody, tries: ['x1'] },
  { id: 'weapons', name: '兵装一覧', title: '射程・コスト・誘導・撃てない理由', body: weaponsBody },
  { id: 'pylons', name: '搭載枠', title: '何がどこに何発載るか', body: pylonsBody },
  { id: 'detection', name: '探知', title: '目視・レーダー・逆探知', body: detectionBody, tries: ['t3'] },
  { id: 'defense', name: '敵の防空', title: 'SAM・赤外線SAM・対空砲', body: defenseBody },
  { id: 'weather', name: '雲と天候', title: '光・赤外線・電波', body: weatherBody, tries: ['k1'] },
  { id: 'victory', name: '勝敗と評価', title: '目標・最後の一撃・評価', body: victoryBody, tries: ['k2'] },
];

export function getReference(id) {
  return REFERENCE.find((r) => r.id === id) || null;
}

/** 項目の本文（末尾の「試す」まで） */
export function renderReference(item) {
  return item.body() + trySection(item.tries);
}
