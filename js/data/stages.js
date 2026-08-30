// ステージ定義。仕様書 §13。
//
// 地形は seed とパラメータから毎回同じものが生成される（ブリーフィングでの地形読みが成立する）。
// 配置物の座標は 0〜51200 のワールド座標。
//
// objectives の型:
//   destroyAll : tag を持つ敵をすべて破壊する
//   protect    : tag を持つ味方が破壊されたら失敗（fail:true と併用）
//   reach      : tag を持つ味方が指定地点へ到達する
//   survive    : 指定秒数を耐える
//
// 敵ユニットに known:true を付けると、ブリーフィング時点で位置が判明している
// （＝開始時から記憶コンタクトとして地図に出る）。
//
// 敵機に moveTo:{x,z,agl} を付けると、その地点へ向かって飛ぶ（哨戒しない）。

import { isDebug } from '../core/debug.js';
import { customStages } from './custom.js';

export const STAGES = [
  // ------------------------------------------------------------------ 1
  //
  // **空戦だけの初ミッション**（§36）。
  //
  // それまで先頭だった SCRAMBLE は「正面での迎撃・時間制限つき・爆撃機を落とす」
  // という構造で、**殺傷力のどんな変化にも過敏に反応する**。
  // 実際 §28.13・§34.1・§34.4・§34.5・§35.2 と5回続けて、
  // 物理を実機に寄せる変更のたびにこのミッションだけが壊れた。
  // 毎回「守りが強くなる → 双方が落ちない → 爆撃機が抜ける」という同じ形。
  //
  // 最初のミッションは**守るものを持たせない**。落とすだけなら、
  // 兵装や回避の釣り合いが動いても結果が素直に動く。
  // 釣り合いを測るときの物差しとしても、こちらのほうが読める。
  {
    id: 's0',
    name: 'CLEAN SWEEP',
    title: '初陣',
    brief: '国境付近で敵の哨戒機を捉えた。空域から追い払え。\n'
      + '守るものは無い。落とすことだけを考えればよい。',
    hint: '互いに中距離AAMを持つ。先に撃ったほうが有利だが、撃たれたら逃げる判断も要る。'
      + '短距離AAMは後方からなら8km、正面からは4kmまでしか掴めない。',
    terrain: { seed: 40404, mountainAmount: 0.5, coast: 'none', valleyDepth: 0.6, rivers: 1, baseAltitude: 300 },
    // **上限は広く取る**（§41.2）。点を気にしないなら厚く積んでクリアできる余地。
    weaponPoints: 24,
    friendly: {
      base: { x: 10000, z: 40000 },
      startAirborne: true,
      startAlt: 4500,
      // **プリセットは○評価の帯**（§41.2。◎≤10 / ○≤14 に対して 12P）。
      // ステージが渡してくる搭載でそのまま ◎ が付くと、節約という軸が消える。
      //
      // **3機目を足した**（§70.13）。§70.12 で見積りを正して目視外の
      // 撃ち合いが互角になったぶん、2機対2機では司令官AIで 39% まで落ちた。
      // 練度のダイヤルは効かなかった（1.0 → 0.8 で −6pt ＝ 誤差）ので、
      // **機数で寄せる**（プレイヤーの判断）。
      aircraft: [
        { type: 'F-1', name: 'VIPER 1', loadout: ['AAM-M', 'AAM-M', 'AAM-S', 'AAM-S'] },
        { type: 'F-1', name: 'VIPER 2', loadout: ['AAM-M', 'AAM-M', 'AAM-S', 'AAM-S'] },
        { type: 'F-1', name: 'VIPER 3', loadout: ['AAM-M', 'AAM-M', 'AAM-S', 'AAM-S'] },
      ],
    },
    enemy: {
      // 哨戒しているだけで、こちらの基地を狙わない。**時間の圧力が無い**。
      //
      // **搭載は既定どおり**（AAM-M+AAM-S×2）。§48 のテストプレイで戻した。
      //
      // ここは長く「赤外線だけ」にしていた。こちらだけが中距離弾を持てば
      // 先に撃てる — 兵装の序列がそのまま最初の教材になる、という狙い。
      // それ自体は成立していたが、**遊ぶと交戦にならない**。
      // 相手が撃ち返してこないので、間合いを詰められる前に片付いてしまう。
      //
      // ベンチの勝率は動かなかった（同じ種18で 16/18 のまま）。
      // **動いたのは中身のほう** — 決着までの中央値が 162秒 → 80秒。
      // 互いに中距離弾を持つので、遠距離での撃ち合いで決まるようになった。
      // 「先に撃てる」利点は残っている（こちらは2本、相手は1本）。
      //
      // 昔の測定（赤外線だけの頃）:
      // 同じ搭載3本にすると 0/18（搭載重量で負ける）、
      // 双方2本に揃えると 7/18 で決着まで中央524秒の長い機銃戦になった。
      //
      // **間合いは §41.2 の帯（序盤は8〜9割）に合わせて置いた。**
      // §38 で中距離弾が 17.8km の兵装になったので、詰まっていると
      // その利点を使う前に交戦が始まってしまう（13/18 = 72%）。
      // 4.5km 遠ざけると 11/12 = 92%・損失0.42 になり、
      // 「先に撃てる間合いを活かせ」という教材として成立する。
      //
      // 距離には帯がある（同じ種12・§41.4）:
      // 現行 8/12 ／ +3km 8/12 ／ **+4.5km 11/12** ／ +6km 12/12（緩すぎ）。
      aircraft: [
        { type: 'J-7', name: 'BANDIT 1', x: 33600, z: 26700, agl: 4500, aiMode: 'PATROL', tags: ['cap'],
          loadout: ['AAM-M', 'AAM-S', 'AAM-S'] },
        { type: 'J-7', name: 'BANDIT 2', x: 35600, z: 28700, agl: 4500, aiMode: 'PATROL', tags: ['cap'],
          loadout: ['AAM-M', 'AAM-S', 'AAM-S'] },
      ],
      ground: [],
    },
    // 評価基準（§18）。プリセットは 8P（2機 × AAM-M2本）で ○ に入る。
    // **敵にも中距離弾を持たせたぶん決着が速くなる**（実測の中央 162秒 → 80秒）ので、
    // 迅速の基準も詰める。ベンチは下限なので、人が指揮すればもっと速い。
    //
    // **迅速を 120/180 → 90/120 に詰めた**（§57・プレイヤーのテストプレイ）。
    // 司令官AIでも中央80秒だったので、120秒では時間の軸が一度も効かず、
    // 3つの評価のうち1つが常に満点という状態だった。
    //
    // **節約の帯を 6/10 → 10/14 に移した**（§70.13）。3機目を足してプリセットが
    // 8P → 12P になったので、**帯のほうを搭載に合わせる**（§45.1）。
    // ◎ を取るには AAM-M を1本落とす必要がある、という関係は保っている。
    // `weaponPoints: 24` は「全ハードポイントを AAM-M で埋めても収まる」
    // （3機 × 4本 × 2P = 24P）ままなので触らない（§41.2）。
    rating: { time: [90, 120], points: [10, 14], losses: [0, 1] },
    objectives: [
      { id: 'kill', type: 'destroyAll', tag: 'cap', label: '敵の哨戒機を全機撃墜する' },
    ],
  },

  // ------------------------------------------------------------------ 2
  {
    id: 's2',
    name: 'ESCORT',
    title: '輸送機護衛',
    brief: '前線への補給物資を積んだ輸送機を、離脱地点まで護衛せよ。\n'
      + '敵は輸送機を狙って迎撃機を上げてくる。輸送機は自衛できない。',
    hint: '護衛モードにしておくと、輸送機に近づく敵だけを迎撃して戻ってくる。',
    terrain: { seed: 20202, mountainAmount: 1.1, coast: 'none', valleyDepth: 1.1, rivers: 3, baseAltitude: 450 },
    // 護衛は「守りながら戦う」ぶん、同数では足りない。
    // 3機目を足して敵と同数にし、ここでは護衛モードの使い方を覚えてもらう。
    //
    // 上限 30P は**全ハードポイント（13本）を AAM-M で埋めても 26P** で収まる高さ
    // （§41.2 の「点を気にしないなら厚く積んでクリアできる余地」）。
    // アクティブAAM で固めきるには足りない — そこは節約と引き換えになる。
    weaponPoints: 30,
    friendly: {
      base: { x: 10000, z: 38000 },
      startAirborne: true,
      startAlt: 4500,
      // **輸送機の進路上、約4km 前方から始める**（§40・§41.4）。
      //
      // 輸送機は (12000,36000) から (44000,12000) へ向かう。その進路に沿って
      // 前に出しておくと、脅威を**輸送機から遠いところで**迎えられる。
      //
      // 距離には最適点がある（実測・同じ種18・敵3機のとき）:
      // 併走(0km) 14/18 ／ 前方8km 18/18 ／ 前方12km 9/18。
      // 出過ぎると輸送機が丸裸になり、近すぎると交戦が輸送機の上で起きる。
      //
      // **8km だと 100% で緩すぎたので 4km に戻し、敵を4機にした**（§41）。
      // 前方4km＋敵4機で 12/18 = 67%。
      // **プリセットは短距離AAMと中距離AAMだけ**（§45）。
      //
      // 初心者向けの面なので、兵装の種類を増やさない。
      // **AAM-A はプリセットに使わない** — 2スロット食うので搭載重量が変わり、
      // 「点を合わせるために1本挿す」と釣り合いが読めなくなる（§45.2）。
      //
      // ○評価（◎≤10 / ○≤18 に対して 12P）。
      // **帯のほうを搭載に合わせた。** 逆をやると、点を埋めるために
      // 兵装を厚くする → 成績が上がる → 敵を増やす、という螺旋になる（§45.1）。
      aircraft: [
        { type: 'F-1', name: 'VIPER 1', x: 14000, z: 32700,
          loadout: ['AAM-M', 'AAM-M', 'AAM-S', 'AAM-S'] },
        { type: 'F-1', name: 'VIPER 2', x: 15200, z: 33600,
          loadout: ['AAM-M', 'AAM-M', 'AAM-S', 'AAM-S'] },
        { type: 'F-2', name: 'HAMMER 1', x: 16400, z: 34500,
          loadout: ['AAM-M', 'AAM-M', 'AAM-S', 'AAM-S'] },
      ],
      support: [
        { type: 'E-8', name: 'CARGO', x: 12000, z: 36000, agl: 4200, tags: ['transport'],
          aiMode: 'TRANSIT', moveTo: { x: 44000, z: 12000, alt: 4200 } },
      ],
    },
    enemy: {
      aircraft: [
        { type: 'J-7', name: 'BANDIT 1', x: 34000, z: 18000, agl: 5500, aiMode: 'PURSUIT', tags: ['cap'] },
        { type: 'J-7', name: 'BANDIT 2', x: 36000, z: 20000, agl: 5500, aiMode: 'PURSUIT', tags: ['cap'] },
        { type: 'J-7', name: 'BANDIT 3', x: 40000, z: 14000, agl: 6000, aiMode: 'PURSUIT', tags: ['cap'] },
        // **4機目は撤去した**（§45.1）。プリセットを厚くしたぶんを敵で戻していたが、
        // 初心者向けの面としては相手が多すぎた。搭載を素直に戻したので数も戻す。
      ],
      ground: [],
    },
    // 評価基準（§18）。輸送機の飛行時間が約232秒なので、これより速くは終わらない。
    // 急かす評価にはせず「積み替えで往復して間延びしなかったか」を見る。
    // 節約の基準は実プレイの記録から（AAM-M中心なら10〜12P、AAM-A中心だと30P超）
    // 節約の帯は**プリセット(12P)が○に入る**ように置く（§45.1）。
    rating: { time: [240, 320], points: [10, 18], losses: [0, 1] },
    objectives: [
      { id: 'arrive', type: 'reach', tag: 'transport', x: 44000, z: 12000, radius: 3000,
        label: '輸送機を北東の離脱地点まで護衛する' },
      { id: 'cargo', type: 'protect', tag: 'transport', label: '輸送機を失わない', fail: true },
    ],
  },

  // ------------------------------------------------------------------ 3
  {
    id: 's1',
    name: 'SCRAMBLE',
    title: '緊急発進',
    brief: '国境を越えて敵編隊が接近中。自軍飛行場に到達される前に迎撃せよ。\n'
      + '敵は爆撃機を伴っている。護衛の迎撃機を排除してから爆撃機を落とせ。',
    hint: 'まずは編隊（Gキー）を組み、連携モードでレーダーの扇を広く張ると早く見つけられる。',
    terrain: { seed: 10101, mountainAmount: 0.8, coast: 'none', valleyDepth: 0.8, rivers: 2, baseAltitude: 380 },
    // 上限 26P は**全ハードポイント（13本）を AAM-M で埋めるとちょうど**。
    // 積み切ってもクリアはできるが、それだと節約の評価は捨てることになる。
    weaponPoints: 26,
    friendly: {
      base: { x: 12000, z: 40000 },
      startAirborne: true,
      startAlt: 4000,
      // **ハードポイントは埋めない。** F-1 は4本積めるが3本に留める。
      //
      // Beta 2.18 でクリアが 0/6 に落ちたとき、真っ先に「弾が足りない」と考えて
      // 4本目を積んだが、**むしろ悪化した**（4本 4/6 に対し 3本 5/6）。
      // 4本目は搭載重量として旋回率を 8% 削るだけで、当たらない弾が1発増えるだけだった。
      //
      // 本当の原因は命中期待度が**セミアクティブの誘導保持を見ていなかった**こと
      // （§28.8）。AI が AAM-M を遠距離で撃ち続け、30発撃って命中ゼロだった。
      // **§34 で搭載を組み直した。** 赤外線が正面では 4km までしか掴めなくなり
      // （§34.1）、正面での迎撃であるこのミッションでは赤外線2本では足りない。
      // レーダー弾を2本に増やして 1/18 → 10/18 に戻した。
      // 撃ちっぱなしの AAM-A なら 16/18 まで戻るが、6P は最初のミッションには高い。
      // **プリセットは短距離AAMと中距離AAMだけ**（§45）。
      // ○評価（◎≤10 / ○≤14 に対して 12P）。帯のほうを搭載に合わせてある。
      aircraft: [
        { type: 'F-1', name: 'VIPER 1', loadout: ['AAM-M', 'AAM-M', 'AAM-S', 'AAM-S'] },
        { type: 'F-1', name: 'VIPER 2', loadout: ['AAM-M', 'AAM-M', 'AAM-S', 'AAM-S'] },
        { type: 'F-2', name: 'HAMMER 1', loadout: ['AAM-M', 'AAM-M', 'AAM-S', 'AAM-S'] },
      ],
    },
    enemy: {
      // 練度は下げない。時間制限のある防衛任務では、敵を弱くすると
      // 消極的になって戦闘が長引き、その間に爆撃機が抜けてかえって難しくなる。
      aircraft: [
        // 進発位置は自軍飛行場から約37km。爆撃機の到達まで約4分。
        // **距離は難易度の軸として使えない**（§41.4 で実測）。
        // 遠ざけると迎撃が遠方になって護衛と戦う間に爆撃機が抜け、
        // 近づけると時間が足りなくなる ─ どちらへ動かしても難しくなる。
        // **搭載は既定どおりの3発**（AAM-M+AAM-S×2）。§48 のテストプレイで戻した。
        //
        // 長く2発に絞っていた。§28.13 で兵装の作りを直したとき、このミッションだけ
        // 16/18 → 10/18 まで落ちたためで、敵も同じ兵装を積んでいるので
        // **弾が良くなるほど正面での撃ち合いが決定的になり、時間制限つきの目的を
        // 持つこちらが不利になる**という理屈だった。
        // 弾種を落とす（AAM-S×3）と逆に難しくなった（6/18）ので、効くのは弾数のほう。
        //
        // その後 §38・§42〜§46 で兵装そのものが直り、前提が変わった。
        // 3発に戻しても 16/18（同じ種18）で、**絞る理由はもう無い**。
        // 他の面と搭載が揃うぶん、敵の強さを機数で読めるようになる。
        //
        // 爆撃機の自衛用 AAM-S は外してある（既定は BOMB×6+AAM-S）。
        // **本命は落とされる側**という役どころを、搭載でもはっきりさせる。
        //
        // **護衛は2機**（§45.1）。§41.4 で3機に増やしたが、来襲側が厚すぎた。
        // 難易度は距離では戻せない（8km手前 89% / 12km手前 100% / 16km手前 100% と
        // 単調でなく、遠ざけても近づけても効かない）ので、数で釣り合いを取っていた。
        // **プリセットを素直に戻したぶん、こちらも戻す。**
        { type: 'J-7', name: 'BANDIT 1', x: 38000, z: 14000, agl: 5000, aiMode: 'PURSUIT', tags: ['raid'],
          loadout: ['AAM-M', 'AAM-S', 'AAM-S'] },
        { type: 'J-7', name: 'BANDIT 2', x: 39500, z: 15200, agl: 5000, aiMode: 'PURSUIT', tags: ['raid'],
          loadout: ['AAM-M', 'AAM-S', 'AAM-S'] },
        { type: 'B-9', name: 'RAIDER 1', x: 41000, z: 16500, agl: 5600, aiMode: 'STRIKE', tags: ['raid', 'bomber'],
          loadout: ['BOMB', 'BOMB', 'BOMB', 'BOMB', 'BOMB', 'BOMB'], strikeTargetTag: 'home' },
      ],
      ground: [],
    },
    // 評価基準（§18）。[◎の上限, ○の上限]
    // 迅速: 爆撃機は約4分で基地へ到達する。2分半で決着なら◎
    // 節約: **既定搭載は12P**（§34 で組み直した）。基準もそれに合わせる。
    // 8P のままだと、ステージが渡してくる搭載で出撃した時点で ◎ が取れない
    // — §32.6 で IRON UMBRELLA に見つけたのと同じ欠陥になる
    // 節約の帯は**プリセット(12P)が○に入る**ように置く（§45.1）。
    rating: { time: [170, 260], points: [10, 14], losses: [0, 1] },
    objectives: [
      { id: 'kill', type: 'destroyAll', tag: 'raid', label: '来襲した敵編隊を全機撃墜する' },
      { id: 'base', type: 'protect', tag: 'home', label: '自軍飛行場を守る', fail: true },
    ],
  },

  // ------------------------------------------------------------------ 4
  {
    id: 's3',
    name: 'IRON UMBRELLA',
    title: '鉄の傘を破る',
    brief: '敵の防空網を制圧する。SAM陣地2箇所とレーダーサイトを破壊せよ。\n'
      + 'SAMはレーダーを止めて隠れることができる。対レーダーミサイル(ARM)が有効だが、\n'
      + '沈黙されると誘導が切れる。低空侵入で地形に隠れる手もある。',
    hint: 'SAMは高空にいる機体ほど遠くから狙う。低空で山陰を進めば探知も交戦も遅らせられる。',
    terrain: { seed: 30303, mountainAmount: 1.3, coast: 'none', valleyDepth: 1.2, rivers: 2, baseAltitude: 500 },
    weaponPoints: 44,
    friendly: {
      base: { x: 9000, z: 42000 },
      startAirborne: false,
      // 対地攻撃機は2機。1機失っただけで「30km先まで積み替えて往復し直す」
      // という長い作業が確定してしまうのを避ける（実プレイで18分がそれに消えた）。
      aircraft: [
        // §57 のテストプレイで組み直した。ANVIL 1 を爆装にして役割を分ける
        // （ARM で防空を剥がす → 爆弾で潰す → AGM で残りを叩く）。
        { type: 'F-2', name: 'HAMMER 1', loadout: ['ARM', 'ARM', 'AAM-S'] },
        { type: 'A-3', name: 'ANVIL 1', loadout: ['BOMB', 'BOMB', 'BOMB', 'BOMB', 'AAM-S'] },
        { type: 'A-3', name: 'ANVIL 2', loadout: ['AGM', 'AGM', 'AAM-S', 'AAM-S'] },
        { type: 'F-1', name: 'VIPER 1', loadout: ['AAM-M', 'AAM-M', 'AAM-S', 'AAM-S'] },
      ],
    },
    enemy: {
      aircraft: [
        { type: 'J-7', name: 'BANDIT 1', x: 36000, z: 18000, agl: 5000, aiMode: 'PATROL', tags: ['cap'] },
      ],
      ground: [
        { type: 'RADAR', name: 'レーダーサイト', x: 33000, z: 22000, tags: ['air-defense'], known: true },
        { type: 'SAM', name: 'SAM陣地 A', x: 29000, z: 24000, tags: ['air-defense'], known: true },
        { type: 'SAM', name: 'SAM陣地 B', x: 34500, z: 27000, tags: ['air-defense'] },
        { type: 'AAA', name: '対空砲 A', x: 31000, z: 23000, tags: [] },
      ],
    },
    // 評価基準（§18）。既定搭載で34P。無誘導爆弾（0P）を混ぜて低空で入れば節約できる。
    // 迅速の基準は「積み替えの往復をせず一度の出撃で片付いたか」
    rating: { time: [540, 900], points: [18, 24], losses: [0, 1] },
    objectives: [
      { id: 'sead', type: 'destroyAll', tag: 'air-defense', label: 'SAM陣地2箇所とレーダーサイトを破壊する' },
      { id: 'alive', type: 'protect', tag: 'home', label: '自軍飛行場を守る', fail: true },
    ],
  },

  // ------------------------------------------------------------------ 5
  {
    id: 's4',
    name: 'DAWN BLADE',
    title: '暁の刃',
    brief: '敵飛行場を破壊し、航空戦力の再生産を止める。\n'
      + '飛行場は破壊するまで迎撃機を上げ続ける。長居すれば不利になる。',
    hint: '進出距離が長い。増槽(TANK)を積むか、帰投のタイミングを早めに考えること。',
    terrain: { seed: 40404, mountainAmount: 1.0, coast: 'e', valleyDepth: 1.0, rivers: 3, baseAltitude: 420 },
    weaponPoints: 36,
    friendly: {
      base: { x: 8000, z: 40000 },
      startAirborne: false,
      aircraft: [
        // §57 のテストプレイで組み直した。**対地目標は山の陰**にあるので、
        // 近くまで行くか横から回り込む必要がある。ARM で先に防空を剥がす。
        { type: 'A-3', name: 'ANVIL 1', loadout: ['ARM', 'ARM', 'AAM-S', 'AAM-S'] },
        { type: 'A-3', name: 'ANVIL 2', loadout: ['BOMB', 'BOMB', 'BOMB', 'BOMB', 'AAM-S', 'AAM-S'] },
        { type: 'F-1', name: 'VIPER 1', loadout: ['AAM-M', 'AAM-M', 'AAM-S', 'TANK'] },
        { type: 'F-1', name: 'VIPER 2', loadout: ['AAM-M', 'AAM-M', 'AAM-S', 'TANK'] },
      ],
    },
    enemy: {
      base: { x: 40000, z: 20000, tags: ['target'], known: true, reinforce: { every: 170, max: 4, type: 'J-7' } },
      aircraft: [
        { type: 'J-7', name: 'BANDIT 1', x: 37000, z: 22000, agl: 5200, aiMode: 'PATROL', tags: ['cap'] },
        { type: 'J-7', name: 'BANDIT 2', x: 42000, z: 18000, agl: 5200, aiMode: 'PATROL', tags: ['cap'] },
      ],
      ground: [
        { type: 'SAM', name: 'SAM陣地', x: 36000, z: 21000, tags: [], known: true },
        { type: 'AAA', name: '対空砲', x: 39500, z: 20500, tags: [] },
      ],
    },
    // 評価基準（§18）。既定搭載で16P。進出38kmの往復に時間を取られる
    rating: { time: [360, 600], points: [16, 20], losses: [0, 1] },
    objectives: [
      { id: 'kill-base', type: 'destroyAll', tag: 'target', label: '敵飛行場を破壊する' },
      { id: 'alive', type: 'protect', tag: 'home', label: '自軍飛行場を守る', fail: true },
    ],
  },

  // ------------------------------------------------------------------ 6
  {
    id: 's5',
    name: 'COASTAL WALL',
    title: '沿岸の壁',
    brief: '敵の上陸部隊が沿岸へ向かっている。艦船と車両部隊を阻止せよ。\n'
      + '同時に、沿岸のレーダーサイトを守り抜くこと。これを失えば防空網が崩れる。',
    hint: '艦船は近接防空を持つ。低空で近づくと危険。対地ミサイルで距離を取って撃つのが安全。',
    terrain: { seed: 50505, mountainAmount: 0.9, coast: 'e', valleyDepth: 0.9, rivers: 2, baseAltitude: 400 },
    weaponPoints: 56,
    friendly: {
      base: { x: 10000, z: 30000 },
      startAirborne: false,
      aircraft: [
        { type: 'A-3', name: 'ANVIL 1', loadout: ['AGM', 'AGM', 'AAM-S', 'AAM-S'] },
        { type: 'A-3', name: 'ANVIL 2', loadout: ['AGM', 'AGM', 'AAM-S', 'AAM-S'] },
        // §57 のテストプレイで組み直した。護衛の2機を空戦専任にして、
        // 増槽で足を伸ばす（沿岸まで出て戻るのに要る）。
        { type: 'F-2', name: 'HAMMER 1', loadout: ['AAM-M', 'AAM-M', 'AAM-S', 'AAM-S', 'TANK'] },
        { type: 'F-1', name: 'VIPER 1', loadout: ['AAM-M', 'AAM-M', 'AAM-S', 'TANK'] },
      ],
      ground: [
        { type: 'RADAR', name: '沿岸レーダー', x: 34000, z: 30000, tags: ['coastal-radar'] },
      ],
    },
    enemy: {
      aircraft: [
        { type: 'J-7', name: 'BANDIT 1', x: 44000, z: 22000, agl: 5000, aiMode: 'PATROL', tags: ['cap'] },
      ],
      ground: [
        { type: 'SHIP', name: '揚陸艦 1', x: 47000, z: 32000, tags: ['invasion'], known: true,
          route: [{ x: 47000, z: 32000 }, { x: 43600, z: 31000 }] },
        { type: 'SHIP', name: '揚陸艦 2', x: 47500, z: 36000, tags: ['invasion'], known: true,
          route: [{ x: 47500, z: 36000 }, { x: 43200, z: 34500 }] },
        // **沿岸レーダーへ向かう**（§67.3）。
        //
        // これまでは巡回するだけで、レーダーへの攻撃手段も無かった。
        // 「沿岸レーダーを守る」は失敗条件として書いてあるのに、
        // **放置しても全滅以外でゲームオーバーにならなかった**
        // （実測: 6戦とも沿岸レーダーは無傷）。
        // 機銃（射程800m）を持ったので、**着く前に倒す**という時間の勝負になる。
        { type: 'CONVOY', name: '車両部隊', x: 44000, z: 27000, tags: ['invasion'],
          attackTag: 'coastal-radar' },
      ],
    },
    // 評価基準（§18）。既定搭載で31P。目標は西へ動いてくるので待てば距離は縮む
    rating: { time: [540, 900], points: [16, 24], losses: [0, 1] },
    objectives: [
      { id: 'stop', type: 'destroyAll', tag: 'invasion', label: '上陸部隊（艦船2・車両部隊）を撃破する' },
      { id: 'radar', type: 'protect', tag: 'coastal-radar', label: '沿岸レーダーを守る', fail: true },
    ],
  },


  // ------------------------------------------------------------------ 7
  //
  // **防衛ミッション**（§74）。敵に司令官AIを付けた最初の本編ステージ。
  //
  // ##### SCRAMBLE の形を引き継がない
  //
  // 本編で唯一の防衛面だった SCRAMBLE は、**物理の改善を5回続けて止めた**（§36）。
  // 「守りが強くなる → 双方が落ちない → 爆撃機が抜ける」で、
  // 殺傷力をどちらへ動かしても結果が反転する。原因は**守る対象が1つ**で、
  // 敵が1機到達すれば終わる二値だったこと（飛行場 HP400 に対し爆弾は1発260）。
  //
  // こちらは**補給施設5つのうち3つ以上**を残せばよい（`hold` 目標・§74.1）。
  // 1機抜けても即敗北にはならないので、結果が連続的に動く。
  //
  // ##### クリア条件は「元を断つ」`[実測で決めた]`
  //
  // 3通り書いて測った。
  //
  // | 目標の立て方 | 結果 |
  // |---|---|
  // | 15分耐える（`survive`）| 0/6。施設は残るのに機体が尽きる。しかも**迅速の評価が死ぬ**（必ず15分かかる）|
  // | 来襲を全滅させる（`destroyAll raid`）| **2/6**。原因は下記 —— **敵が終わらない** |
  // | **敵飛行場を潰す** | これ |
  //
  // 2つめを測って分かったのが、この面の性格そのものだった。
  // **敵の司令官AIが爆撃 → 帰投 → 積み直し → 再出撃を回す**（§72・§73）ので、
  // 落とし切れない限り空襲は永久に続く（実測: 増援1が t480 に弾1で帰投し、
  // t780 に満載、t840 に再出撃）。**「凌ぐ」だけでは終わらない面**になっている。
  //
  // ##### 地形が「守るか出るか」を作る `[実測で直した]`
  //
  // 最初は自軍基地・施設・敵飛行場を**同じ緯度に並べて**いた。すると
  // **防衛と進攻が同じ動作**になる —— 東へ押していけば、向かってくる襲撃隊と
  // そのまま正面衝突する。司令官AIは開始と同時に全機で突っ込み、
  // **175秒・6/6 で、空襲が一度も起きないまま終わった。**
  //
  // 敵飛行場を**北東の隅**へ移した。施設は南北に散らしてあるので、
  // 飛行場へ向かう針路と、南の施設を守る位置は**重ならない**。
  // 出れば守りが薄くなる、が地形から出るようになった。
  //
  // ##### いまの数字 `[実測・種6]`
  //
  // **2/6・中央243秒・損失3.2。** 負け方は2通りで、どちらも意味のある負け方 ——
  // 「自軍の戦闘機が全滅」と「補給施設を4箇所以上守るに失敗」。
  // 時間切れ（未達）は出ない。
  //
  // **司令官AIは「いつ出るか」を計れない**（§72.4 で2度試して外した層）ので、
  // この数字は下限として読む。後半面はテストプレイで判定する（§41.3）。
  //
  // ##### 自軍の地上防空
  //
  // SAM陣地1基と対空砲2基。**全部は覆えない**位置に置いてある。
  // 圏の外にある施設をどう守るかが、戦闘機の置き場所の判断になる。
  {
    id: 's7',
    name: 'LONG WATCH',
    title: '長い夜警',
    brief: '敵が後方の補給施設群へ波状の空襲を仕掛けてくる。\n'
      + '敵は落とされても補給して出直す。施設を4箇所以上残したまま、元を断て。',
    hint: '守っているだけでは終わらない。敵飛行場は北東 40km。'
      + '自軍のSAM陣地は施設のすべてを覆えない —— 出れば南が空く。',
    terrain: { seed: 70707, mountainAmount: 0.7, coast: 'none', valleyDepth: 0.7, rivers: 2, baseAltitude: 400 },
    // 上限 40P。**対地兵装を積んで元を断ちに行く余地**を残した高さ
    weaponPoints: 40,
    friendly: {
      base: { x: 8000, z: 30000 },
      startAirborne: true,
      startAlt: 4500,
      aircraft: [
        { type: 'F-1', name: 'VIPER 1', loadout: ['AAM-M', 'AAM-M', 'AAM-S', 'AAM-S'] },
        { type: 'F-1', name: 'VIPER 2', loadout: ['AAM-M', 'AAM-M', 'AAM-S', 'AAM-S'] },
        { type: 'F-2', name: 'HAMMER 1', loadout: ['AAM-M', 'AAM-M', 'AAM-S', 'AAM-S', 'TANK'] },
        // **元を断つ1機。**
        //
        // 最初は ARM を積んだ F-2 にしていたが、**t90 に落ちると誰も基地を壊せなくなり**、
        // 残り3機が900秒ずっと哨戒して終わった（敵基地 hp400 のまま）。
        // 打撃力を1機に集めると、その1機の生死が面の成否そのものになる。
        //
        // A-3 にして**弾を2種4発**持たせた。硬く（hp160）、AGM が落ちても爆弾が残る。
        // 遅いので、出るなら早く決めることになる
        { type: 'A-3', name: 'ANVIL 1', loadout: ['AGM', 'AGM', 'BOMB', 'BOMB', 'AAM-S', 'AAM-S'] },
      ],
      // 守る施設。**南北に散らしてある** —— 1点に固めると
      // 「SAM の圏に入れるかどうか」だけの面になる。
      //
      // **`known: true` は施設だけ**（§73.3）。襲撃側は狙う場所を知っていて当然だが、
      // **地上防空の位置は伏せる** —— どこを覆っているかが守り手の手札になる。
      // 撃てば逆探知で分かるので、隠せるのは最初の一波だけ。
      ground: [
        { type: 'DEPOT', name: '補給施設 A', x: 13000, z: 20000, tags: ['depot'], known: true },
        { type: 'DEPOT', name: '補給施設 B', x: 15000, z: 26000, tags: ['depot'], known: true },
        { type: 'DEPOT', name: '補給施設 C', x: 14000, z: 32000, tags: ['depot'], known: true },
        { type: 'DEPOT', name: '補給施設 D', x: 16000, z: 38000, tags: ['depot'], known: true },
        { type: 'DEPOT', name: '補給施設 E', x: 12000, z: 43000, tags: ['depot'], known: true },
        // 自軍の地上防空。SAM は中央の3箇所を覆い、南北の端は届かない
        { type: 'SAM', name: '自軍SAM', x: 15000, z: 29000, tags: ['aaa'] },
        { type: 'AAA', name: '対空砲 北', x: 13500, z: 21000, tags: ['aaa'] },
        { type: 'AAA', name: '対空砲 南', x: 13000, z: 42000, tags: ['aaa'] },
      ],
    },
    enemy: {
      // **敵の任務**（§73）。司令官AIが読んで、爆撃機を施設へ差し向ける
      objectives: [
        { id: 'raid', type: 'destroyAll', tag: 'depot', label: '敵の補給施設を破壊する' },
      ],
      // 増援＝波。爆撃機1＋護衛2の編隊が 200秒ごとに湧く。
      // **max は多めに置く** —— 待っていれば湧き続ける、が時間の圧力になる
      // **増援にも `raid` タグを付ける**（§74.3）。無いと「来襲を全滅させる」が
      // 最初の4機を落とした時点で達成になってしまう
      // **北東の隅**。施設の列（西・南北に長い）とは針路が重ならない。
      // 増援は潰すまで湧き続ける
      base: { x: 44000, z: 12000, tags: ['target'], known: true,
        reinforce: { every: 150, max: 6, burst: 3, types: ['B-9', 'J-7', 'J-7'],
          tags: ['raid'] } },
      // **SAM は置かない**（測って外した）。
      //
      // 置くと ARM 2発（320）では飛行場 hp400 に届かず、爆弾を落とすには
      // 圏内へ入るしかない —— **司令官AIは900秒かけて一度も潰せなかった**（0/6）。
      // 増援を減らしても同じで、詰まっていたのは攻めきれないほうだった。
      //
      // **出る代償は地形と時間が持つ。** 北東 40km を往復する間、南の施設が空く。
      ground: [],
      aircraft: [
        // 1波目は開始時から空中にいる
        { type: 'B-9', name: 'RAIDER 1', x: 34000, z: 24000, agl: 5200, tags: ['raid'] },
        { type: 'B-9', name: 'RAIDER 2', x: 35000, z: 34000, agl: 5200, tags: ['raid'] },
        { type: 'J-7', name: 'BANDIT 1', x: 33000, z: 26000, agl: 5400, tags: ['raid'] },
        { type: 'J-7', name: 'BANDIT 2', x: 33500, z: 33000, agl: 5400, tags: ['raid'] },
      ],
    },
    // 評価基準（§18）。既定搭載で24P。
    // **損失は施設も数える**（`handleDeaths` は自軍のユニットをすべて数える）ので、
    // 施設を2つ失ってもよい設計に合わせて帯を広く取る
    // 評価基準（§18）。プリセットは 20P。
    // 節約の帯は**プリセットが○に入る**ように置く（§45.1）。
    // **損失は施設も数える**（`handleDeaths` は自軍のユニットをすべて数える）ので、
    // 施設を2つ失ってもよい設計に合わせて帯を広く取る。
    // 迅速の ◎ は**元を断って早く畳んだとき**にだけ届く
    rating: { time: [420, 700], points: [16, 22], losses: [1, 3] },
    objectives: [
      { id: 'source', type: 'destroyAll', tag: 'target', label: '敵飛行場を破壊し、空襲を止める' },
      // **min は 4。** 3 で測ったら6戦とも 4/5 残って、
      // 守りの軸が一度も勝敗に効かなかった（`hold` があっても判定に触れない）
      { id: 'hold', type: 'hold', tag: 'depot', min: 4, label: '補給施設を4箇所以上守る', fail: true },
    ],
  },

  // ------------------------------------------------------------------ 8
  {
    id: 's6',
    name: 'TOTAL WAR',
    title: '総力戦',
    brief: '最終作戦。敵の早期警戒機を撃墜し、飛行場2箇所を破壊せよ。\n'
      + '敵は全戦力を投入してくる。損害を抑えながら段階的に削るしかない。',
    hint: '早期警戒機を先に落とせば、敵の探知網が大きく弱まり低空侵入が効くようになる。',
    terrain: { seed: 60606, mountainAmount: 1.2, coast: 'e', valleyDepth: 1.1, rivers: 3, baseAltitude: 460 },
    // **一度は補給して出直す前提**の面（§57）。上限はそのぶん高く取る。
    weaponPoints: 85,
    friendly: {
      base: { x: 8000, z: 42000 },
      startAirborne: false,
      aircraft: [
        // §57 のテストプレイで組み直した。AAM-A をやめて中距離弾で揃える。
        { type: 'F-1', name: 'VIPER 1', loadout: ['AAM-M', 'AAM-M', 'AAM-S', 'TANK'] },
        { type: 'F-1', name: 'VIPER 2', loadout: ['AAM-M', 'AAM-M', 'AAM-S', 'TANK'] },
        { type: 'F-2', name: 'HAMMER 1', loadout: ['ARM', 'ARM', 'AAM-S'] },
        { type: 'A-3', name: 'ANVIL 1', loadout: ['AGM', 'BOMB', 'BOMB', 'AAM-S', 'AAM-S'] },
      ],
    },
    enemy: {
      base: { x: 42000, z: 18000, tags: ['target'], known: true, reinforce: { every: 210, max: 4, type: 'J-7' } },
      base2: { x: 38000, z: 36000, tags: ['target'], known: true },
      aircraft: [
        { type: 'E-8', name: 'SENTRY', x: 45000, z: 27000, agl: 8500, aiMode: 'EVADE', tags: ['awacs'] },
        { type: 'J-7', name: 'BANDIT 1', x: 38000, z: 20000, agl: 5500, aiMode: 'PATROL', tags: ['cap'] },
        { type: 'J-7', name: 'BANDIT 2', x: 40000, z: 32000, agl: 5500, aiMode: 'PATROL', tags: ['cap'] },
        { type: 'J-7', name: 'BANDIT 3', x: 44000, z: 24000, agl: 6000, aiMode: 'PURSUIT', tags: ['cap'] },
      ],
      ground: [
        { type: 'RADAR', name: 'レーダーサイト', x: 35000, z: 26000, tags: [], known: true },
        { type: 'SAM', name: 'SAM陣地 A', x: 37000, z: 22000, tags: [], known: true },
        { type: 'SAM', name: 'SAM陣地 B', x: 37500, z: 33000, tags: [] },
        { type: 'AAA', name: '対空砲', x: 41500, z: 18500, tags: [] },
      ],
    },
    // 評価基準（§18）。既定搭載で34P。目標が3系統あり出撃は2度以上になる。
    // 最終作戦なので損失には少し寛容にする
    rating: { time: [900, 1500], points: [45, 60], losses: [0, 2] },
    objectives: [
      { id: 'awacs', type: 'destroyAll', tag: 'awacs', label: '敵早期警戒機を撃墜する' },
      { id: 'bases', type: 'destroyAll', tag: 'target', label: '敵飛行場2箇所を破壊する' },
      { id: 'alive', type: 'protect', tag: 'home', label: '自軍飛行場を守る', fail: true },
    ],
  },
];

// ==================================================================
// 検証用ステージ（SPEC §51）
//
// **デバッグモードでだけ出る**（§47.2）。一般のプレイヤーには存在しない。
//
// 本編のステージでは対空砲のふるまいが測れない。実測（同じ種3〜6）:
// 司令官AIは対空砲の射程3kmに**一度も入らない** — 最接近は
// IRON UMBRELLA で 3,563m、DAWN BLADE で 4,055m。手前で全滅するか未達で終わる。
// 発砲そのものが起きないので、AI に回避を入れても効きが判定できない。
//
// **撃たれる側だけを切り出す。** こちらは武装を持たず、機銃も切ってある。
// 攻撃が絡まないぶん実戦とはずれるが、「近づいたらどうなるか」は素直に出る。
// ==================================================================

export const DEBUG_STAGES = [
  {
    id: 'd1',
    debug: true,
    name: 'AAA TEST',
    title: '対空砲の検証',
    brief: '検証用。対空砲・飛行場の近接防空・艦船の近接防空を1基ずつ、'
      + '十分に離して並べてある。\n'
      + 'こちらは武装を持たない（機銃も切ってある）ので、'
      + '近づいて撃たれる挙動だけを見られる。',
    hint: '西から順に 対空砲（射程3km・射高1,500m）／飛行場（3.5km・1,800m）／'
      + '艦船（4.5km・2,500m）。高度を変えながら通過して、どこから当たるかを見る。',
    // **平地寄りにする。** 地形が視線を切ると、対空砲が撃たない理由が
    // 「射高の外」なのか「尾根の陰」なのか分からなくなる。
    terrain: { seed: 77001, mountainAmount: 0.2, coast: 'e', valleyDepth: 0.3, rivers: 0, baseAltitude: 300 },
    weaponPoints: 0,
    noFail: true,
    friendly: {
      base: { x: 6000, z: 26000 },
      startAirborne: true,
      startAlt: 3000,
      // 武装なし・機銃も切る。**こちらから撃たない**のがこのステージの前提。
      aircraft: [
        { type: 'F-1', name: 'PROBE 1', loadout: [], autoWeapons: { GUN: false } },
        { type: 'A-3', name: 'PROBE 2', loadout: [], autoWeapons: { GUN: false } },
      ],
    },
    enemy: {
      // **1基ずつ、12km 離す。** 近いと圏が重なって、どれに撃たれたのか読めない。
      // すべて `known: true` にして、最初から地図に出す（探すのが目的ではない）。
      aircraft: [],
      ground: [
        { type: 'AAA', name: '対空砲', x: 20000, z: 26000, tags: ['gun'], known: true },
        { type: 'SHIP', name: '艦船', x: 44000, z: 26000, tags: ['gun'], known: true },
      ],
      // 飛行場は `enemy.base` からしか置けない（main.js の placeAirbase）。
      // 増援は付けない — 戦闘機が湧くと対空砲の観察にならない。
      base: { x: 32000, z: 26000, tags: ['gun'], known: true },
    },
    rating: { time: [9999, 9999], points: [0, 0], losses: [0, 99] },
    objectives: [
      { id: 'watch', type: 'survive', seconds: 900, label: '15分間、対空砲のふるまいを観察する' },
    ],
  },

  // ------------------------------------------------------------------
  //
  // **敵側の司令官AIの検証**（§27.6）。
  //
  // 敵に「自軍飛行場を破壊せよ」という任務を与えて、`ai/commander.js` が
  // 赤側でも動くかを見る。本編の7面は `enemy.objectives` を持たないので、
  // 敵側の司令官が動く面はここだけ。
  //
  // 見どころは3つ:
  //
  //   1. 敵の攻撃機が STRIKE で自軍飛行場へ向かうか（**目標が読めているか**）
  //   2. 敵の戦闘機が ESCORT で攻撃機に付くか（**護衛の割り当てが赤でも動くか**）
  //   3. 敵が撃ち尽くしたら積み直しに帰るか（§72.2 が赤でも動くか）
  //
  // 自軍飛行場に `known: true` を付けてある —— これが無いと、
  // 目標を与えても**どこにあるか知らない**ので何も起きない（§27.6）。
  {
    id: 'd2',
    debug: true,
    name: 'DEFENSE TEST',
    title: '敵側司令官AIの検証',
    brief: '検証用。敵に「自軍飛行場を破壊せよ」という任務を与えてある。\n'
      + 'こちらは武装を持たないので、敵が陣営として何をするかだけを見られる。',
    hint: '敵は攻撃機2機と護衛1機。飛行場の位置は敵に知られている。'
      + '進撃 → 爆撃 → 帰投 → 積み直して再出撃、までが見どころ。',
    terrain: { seed: 77002, mountainAmount: 0.6, coast: 'none', valleyDepth: 0.6, rivers: 1, baseAltitude: 350 },
    weaponPoints: 0,
    // **勝敗を付けない**（d1 と同じ）。撃ち落として終わりにすると、
    // 敵の司令官が任務を最後までやり切る様子が見られない。
    noFail: true,
    friendly: {
      // **`known: true` が肝。** 敵側のブリーフィングに載る（§27.6）
      base: { x: 10000, z: 26000, known: true },
      startAirborne: true,
      startAlt: 4500,
      // **武装なし・機銃も切る**（d1 と同じ）。
      // 戦闘機3機を置いたら 6/6 で来襲を全滅させてしまい、
      // 爆撃も帰投も一度も起きなかった。**撃たない側から見る。**
      aircraft: [
        { type: 'F-1', name: 'PROBE 1', loadout: [], autoWeapons: { GUN: false } },
      ],
    },
    enemy: {
      // **敵の任務**（§27.6）。`destroyAll` のタグは相手側（青）を指し、
      // `protect` のタグは自分側（赤）を指す —— 自軍の書き方と同じ向き。
      objectives: [
        { id: 'strike', type: 'destroyAll', tag: 'home', label: '敵飛行場を破壊する' },
      ],
      aircraft: [
        // 攻撃機。`strikeTargetTag` は**書かない** —— 目標は司令官が割り当てる
        { type: 'B-9', name: 'RAIDER 1', x: 42000, z: 24000, agl: 5000, tags: ['raid'],
          loadout: ['BOMB', 'BOMB', 'BOMB', 'BOMB', 'BOMB', 'BOMB'] },
        { type: 'B-9', name: 'RAIDER 2', x: 43000, z: 28000, agl: 5000, tags: ['raid'],
          loadout: ['BOMB', 'BOMB', 'BOMB', 'BOMB', 'BOMB', 'BOMB'] },
        // 護衛。対地兵装を積まないので、司令官の規則1で ESCORT に入るはず
        { type: 'J-7', name: 'BANDIT 1', x: 41000, z: 25000, agl: 5200, tags: ['raid'],
          loadout: ['AAM-M', 'AAM-S', 'AAM-S'] },
      ],
      ground: [],
    },
    rating: { time: [9999, 9999], points: [0, 0], losses: [0, 99] },
    objectives: [
      { id: 'watch', type: 'survive', seconds: 900, label: '15分間、敵の来襲を観察する' },
    ],
  },
];

/** いま選べるステージ（デバッグモードなら検証用も並ぶ） */
/**
 * 遊べるステージの一覧。
 *
 * **自作ステージ（§66）はデバッグモードのときだけ混ざる。**
 * 切っていれば読み込みもしない —— 隠すだけだと、
 * 作りかけの面が公開版の一覧に出てしまう（§47.2 と同じ考え）。
 */
export function stageList() {
  if (!isDebug()) return STAGES;
  return STAGES.concat(DEBUG_STAGES, customStages());
}

export function getStage(id) {
  return STAGES.find((s) => s.id === id)
    || DEBUG_STAGES.find((s) => s.id === id)
    || (isDebug() ? customStages().find((s) => s.id === id) : null)
    || null;
}

/** クリア済みリストから、そのステージが解禁されているかを返す（前ステージのクリアが条件） */
export function isUnlocked(stage, cleared) {
  if (stage && stage.debug) return true;           // 検証用は常に開いている
  const i = STAGES.indexOf(stage);
  if (i <= 0) return true;
  return cleared.includes(STAGES[i - 1].id);
}
