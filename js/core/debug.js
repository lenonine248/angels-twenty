// デバッグモード。仕様書 §47.2。
//
// **公開版では既定で切れていて、遊ぶ人の画面には入り口が出ない。**
// 難易度の調整パネルのような「作り手が使う道具」を、一般のプレイヤーが
// 触れないようにするためのもの。
//
// 入れ方は**コンソールから `AT.setDebug(true)` のみ**。
// `tools/bench.js` などの検証ツールと同じ入り口に揃えてある。
//
// URL 引数（`?debug=1` のような形）にはしていない。
// **リンクを共有した相手にもそのまま渡ってしまう**ので、
// 「普通に遊んでいて偶然入る」経路を残さない。
//
// > ビルド工程が無く（`main` をそのまま配信）、リポジトリも公開しているので、
// > **読まれれば分かる**。ここで防いでいるのは解析ではなく、
// > 「一般のプレイヤーが意図せず触れてしまうこと」。
//
// **切れているあいだは、保存された調整値も読まない**（§47.2）。
// 隠すだけだと、以前入れた調整が公開版に効いたままになる。

const KEY = 'at_debug';

function initial() {
  try { return localStorage.getItem(KEY) === '1'; } catch { return false; }
}

let on = initial();

/** いまデバッグモードか */
export function isDebug() { return on; }

/** 切り替える。このブラウザに残る */
export function setDebug(v) {
  on = !!v;
  try {
    if (on) localStorage.setItem(KEY, '1');
    else localStorage.removeItem(KEY);
  } catch { /* 保存できなくても、その場では効く */ }
  return on;
}
