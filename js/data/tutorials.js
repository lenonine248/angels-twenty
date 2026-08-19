// チュートリアルの定義。仕様書 §19。
//
// 中身は P12 で入れる。ここが空のあいだ、タイトルのチュートリアルは
// 「準備中」として押せない状態で並ぶ（枠だけ先に作ってある）。
//
// 手順の形（§19.1）:
//
//   {
//     id: 't1',
//     name: '指揮の基本',
//     title: '選択と移動指示',
//     terrain: { seed: 90001, ... },
//     friendly: { ... },            // ステージ定義と同じ形
//     enemy: { ... },
//     steps: [
//       { text: '機体をクリックして選択する',        done: 'select' },
//       { text: '地面を右クリックして移動を指示する', done: 'order:move' },
//     ],
//   }
//
// 通常のステージと違い、目標(objectives)ではなく steps で進む。
// 全手順を終えたらクリア。評価は付けない。失敗条件も置かない。

export const TUTORIALS = [];

/** 終えたチュートリアルか */
export function isTutorialDone(id, done) {
  return Array.isArray(done) && done.includes(id);
}
