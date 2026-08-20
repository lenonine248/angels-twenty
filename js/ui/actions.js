// 「プレイヤーが今これをした」を UI 側から知らせる口。仕様書 §19.2。
//
// チュートリアルの手順判定はこれを受けて進む。
//
// **シミュレーション側からは絶対に呼ばない。**
// sim/ が「チュートリアルかどうか」を気にし始めると、本編の挙動に条件分岐が
// 混ざって壊れやすくなる。呼んでよいのは ui/ と main.js の橋渡し部分だけ。
//
// 逆に、状態を見れば分かること（高度・速度・探知・撃破・着陸など）は
// ここを通さない。手順側の check(ctx) で毎フレーム見るほうが、
// 通知点を増やさずに済む。ここに置くのは「操作そのもの」だけ。
//
// 種類（増やすときは data/tutorials.js の手順と対で足す）:
//
//   select        ユニットを選択した
//   order:move    移動を指示した
//   order:attack  攻撃を指示した
//   order:follow  随伴を指示した
//   order:rtb     帰投を指示した
//   alt:up        指示高度を上げた
//   alt:down      指示高度を下げた
//   speed         倍速を変えた
//   pause         一時停止した／解除した
//   formation     編隊を組んだ
//   aimode        AIモードを変えた（detail.mode）
//   threshold     自動発射のしきい値を変えた（detail.value）
//   guard         「誘導中に回避するか」を切り替えた
//   weapon        使用兵装を指定した（detail.weapon）
//   fire          ミサイルを発射した（detail.weapon）
//   takeoff       飛行場から発進させた
//   loadout       搭載を積み替えた

/** 購読者はチュートリアルだけなので1つで足りる */
let listener = null;

/** @param {?(kind: string, detail: object) => void} fn */
export function onAction(fn) { listener = fn; }

export function notify(kind, detail) {
  if (listener) listener(kind, detail || {});
}
