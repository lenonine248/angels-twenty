// 搭載を組む欄。仕様書 §70.3.3。
//
// **同じ形の欄が4か所にあった** —— ブリーフィング・出撃中の再装備・
// ステージエディタ・調整パネル。どれも「積んでいる物を1発1チップで並べる行」と
// 「`+兵装` を並べる行」の2段で、**同じ見た目なのに実装は4つ**あった。
// 1か所だけ直すと、かえってちぐはぐになる。
//
// 新しい形は**兵装ごとに1つの部品**。
//
//   本体を押す → 1つ積む
//   − を押す   → 1つ降ろす
//
// 残数は「×2」で出す。**降ろす側を「×」にしない**のはそのため ——
// 同じチップに「×2」と「×」が並ぶと読み分けられない。
// 本体が「積む」なので、対になる記号は「−」が素直でもある。

import { WEAPONS, loadoutFits, hardpointsOf } from '../data/weapons.js';

/**
 * 機体に積める兵装。
 *
 * **地上発射の弾は除く**（`kind: 'sam'`）。以前エディタだけが
 * `Object.keys(WEAPONS).filter((id) => id !== 'SAM-M')` と書いていたので、
 * §68.2 で足した `IR-SAM` が**機体の搭載候補に混ざっていた**。
 * 除外を「IDの名指し」でやると、増えたときに必ず漏れる。
 */
export const LOADABLE = Object.keys(WEAPONS).filter((id) => WEAPONS[id].kind !== 'sam');

/** その兵装を何発積んでいるか */
export function countOf(loadout, id) {
  return loadout.reduce((n, x) => n + (x === id ? 1 : 0), 0);
}

/**
 * その兵装を**末尾から**1つ降ろした新しい配列を返す。
 *
 * 添字ではなく兵装IDで指す。畳んで表示している以上、
 * 「何番目のチップか」はもう画面に存在しない。
 */
export function removeOne(loadout, id) {
  const next = loadout.slice();
  const i = next.lastIndexOf(id);
  if (i >= 0) next.splice(i, 1);
  return next;
}

/**
 * 搭載を組む欄のHTMLを作る。
 *
 * @param {object}   o
 * @param {string[]} o.loadout        いま積んでいる兵装ID
 * @param {object}   [o.spec]         機体の諸元（パイロン構成を見る）。null なら見ない
 * @param {number}   [o.points]       使える兵装ポイント。null なら見ない
 * @param {string[]} [o.list]         並べる兵装。既定は `LOADABLE`
 * @param {(id:string)=>string} o.add 「積む」ボタンに付ける data 属性
 * @param {(id:string)=>string} o.del 「降ろす」ボタンに付ける data 属性
 */
export function loadoutRow({
  loadout, spec = null, points = null, list = LOADABLE, add, del,
}) {
  return list.map((id) => {
    const w = WEAPONS[id];
    if (!w) return '';
    const n = countOf(loadout, id);
    // **パイロンが埋まっても「降ろす」は押せる。**
    // 両方塞ぐと、満載の機体から積み替える手段が無くなる。
    //
    // 収まるかは「1本足したものが成立するか」で見る（§70.7.1）。
    // **どのパイロンに載るかはプレイヤーに選ばせない** —— 割り当てが
    // 存在するかだけを検査する。
    const room = (spec == null || loadoutFits([...loadout, id], spec))
      && (points == null || w.cost === 0 || w.cost <= points);
    const tip = `${w.name} / ${w.pylon === 'small' ? '小型' : '中型'}パイロン / コスト${w.cost}`;
    return `<span class="ldw${n ? ' has' : ''}">`
      + `<button class="ldw-add${room ? '' : ' disabled'}" ${add(id)} title="${tip}">`
      + `${id}${n ? `<i>×${n}</i>` : ''}</button>`
      + `<button class="ldw-del${n ? '' : ' disabled'}" ${del(id)} title="1つ降ろす">−</button>`
      + '</span>';
  }).join('');
}

/** パイロンの使用状況を「中2/2 小1/2」の形で出す（§70.7） */
export function pylonLabel(loadout, spec) {
  const cap = hardpointsOf(spec);
  let med = 0;
  for (const id of loadout) if ((WEAPONS[id] || {}).pylon !== 'small') med++;
  const small = loadout.length - med;
  // 小型の弾が中型に溢れているぶんも「中型を使っている」と数える
  const overflow = Math.max(0, small - cap.small);
  return `中${med + overflow}/${cap.medium} 小${small - overflow}/${cap.small}`;
}

/** 欄の頭に出す操作の説明。4か所で同じ文言にする */
export const LOADOUT_HINT = '押すと1つ追加 / − で1つ外す';
