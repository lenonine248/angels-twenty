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
    hint: '中距離AAMはこちらにしかない。先に撃てる間合いを活かせ。'
      + '短距離AAMは後方からなら8km、正面からは4kmまでしか掴めない。',
    terrain: { seed: 40404, mountainAmount: 0.5, coast: 'none', valleyDepth: 0.6, rivers: 1, baseAltitude: 300 },
    weaponPoints: 14,
    friendly: {
      base: { x: 10000, z: 40000 },
      startAirborne: true,
      startAlt: 4500,
      aircraft: [
        { type: 'F-1', name: 'VIPER 1', loadout: ['AAM-M', 'AAM-S', 'AAM-S'] },
        { type: 'F-1', name: 'VIPER 2', loadout: ['AAM-M', 'AAM-S', 'AAM-S'] },
      ],
    },
    enemy: {
      // 哨戒しているだけで、こちらの基地を狙わない。**時間の圧力が無い**。
      //
      // **搭載は赤外線だけ。** こちらだけが中距離弾を持つので先に撃てる
      // — 兵装の序列がそのまま最初の教材になる。
      // 同じ搭載にすると 0/18（こちらが3本積むぶん搭載重量で負ける）、
      // 双方2本に揃えると 7/18 で決着まで中央524秒の長い機銃戦になった。
      aircraft: [
        { type: 'J-7', name: 'BANDIT 1', x: 30000, z: 24000, agl: 4500, aiMode: 'PATROL', tags: ['cap'],
          loadout: ['AAM-S', 'AAM-S'] },
        { type: 'J-7', name: 'BANDIT 2', x: 32000, z: 26000, agl: 4500, aiMode: 'PATROL', tags: ['cap'],
          loadout: ['AAM-S', 'AAM-S'] },
      ],
      ground: [],
    },
    // 評価基準（§18）。既定搭載は 4P（2機×2P）。実測の中央は87秒
    rating: { time: [120, 240], points: [6, 10], losses: [0, 1] },
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
    weaponPoints: 34,
    friendly: {
      base: { x: 10000, z: 38000 },
      startAirborne: true,
      startAlt: 4500,
      aircraft: [
        { type: 'F-1', name: 'VIPER 1', loadout: ['AAM-M', 'AAM-M', 'AAM-S', 'AAM-S'] },
        { type: 'F-1', name: 'VIPER 2', loadout: ['AAM-M', 'AAM-S', 'AAM-S'] },
        { type: 'F-2', name: 'HAMMER 1', loadout: ['AAM-M', 'AAM-M', 'AAM-S', 'AAM-S'] },
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
      ],
      ground: [],
    },
    // 評価基準（§18）。輸送機の飛行時間が約232秒なので、これより速くは終わらない。
    // 急かす評価にはせず「積み替えで往復して間延びしなかったか」を見る。
    // 節約の基準は実プレイの記録から（AAM-M中心なら10〜12P、AAM-A中心だと30P超）
    rating: { time: [240, 300], points: [12, 22], losses: [0, 1] },
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
    weaponPoints: 20,
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
        // これ以上遠ざけると迎撃が遠方になり、護衛と戦っている間に
        // 爆撃機だけが抜けてくるため、かえって守りにくくなる。
        // **搭載は2発**（既定の敵機は AAM-M+AAM-S+AAM-S の3発）。
        //
        // §28.13 で兵装の作りを直したら、このミッションだけ 16/18 → 10/18 まで落ちた。
        // 敵も同じ兵装を積んでいるので、**弾が良くなるほど正面での撃ち合いが
        // 決定的になり、時間制限つきの目的を持つこちらが不利になる**。
        // 弾種を落とす（AAM-S×3）と逆に難しくなった（6/18）ので、効くのは弾数のほう。
        // J-7 は低速・低旋回の迎撃機なので、こちらより積めないのは筋も通る。
        { type: 'J-7', name: 'BANDIT 1', x: 38000, z: 14000, agl: 5000, aiMode: 'PURSUIT', tags: ['raid'],
          loadout: ['AAM-M', 'AAM-S'] },
        { type: 'J-7', name: 'BANDIT 2', x: 39500, z: 15200, agl: 5000, aiMode: 'PURSUIT', tags: ['raid'],
          loadout: ['AAM-M', 'AAM-S'] },
        { type: 'B-9', name: 'RAIDER 1', x: 41000, z: 16500, agl: 5600, aiMode: 'STRIKE', tags: ['raid', 'bomber'],
          strikeTargetTag: 'home' },
      ],
      ground: [],
    },
    // 評価基準（§18）。[◎の上限, ○の上限]
    // 迅速: 爆撃機は約4分で基地へ到達する。2分半で決着なら◎
    // 節約: **既定搭載は12P**（§34 で組み直した）。基準もそれに合わせる。
    // 8P のままだと、ステージが渡してくる搭載で出撃した時点で ◎ が取れない
    // — §32.6 で IRON UMBRELLA に見つけたのと同じ欠陥になる
    rating: { time: [150, 240], points: [14, 20], losses: [0, 1] },
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
        { type: 'F-2', name: 'HAMMER 1', loadout: ['ARM', 'ARM', 'AAM-S'] },
        { type: 'A-3', name: 'ANVIL 1', loadout: ['AGM', 'AGM', 'AAM-S', 'AAM-S'] },
        { type: 'A-3', name: 'ANVIL 2', loadout: ['AGM', 'AGM', 'AAM-S', 'AAM-S'] },
        { type: 'F-1', name: 'VIPER 1', loadout: ['AAM-M', 'AAM-S', 'AAM-S'] },
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
    rating: { time: [540, 900], points: [28, 40], losses: [0, 1] },
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
    weaponPoints: 52,
    friendly: {
      base: { x: 8000, z: 40000 },
      startAirborne: false,
      aircraft: [
        { type: 'A-3', name: 'ANVIL 1', loadout: ['BOMB', 'BOMB', 'BOMB', 'BOMB', 'AAM-S'] },
        { type: 'A-3', name: 'ANVIL 2', loadout: ['AGM', 'AGM', 'AAM-S'] },
        { type: 'F-1', name: 'VIPER 1', loadout: ['AAM-M', 'AAM-M', 'AAM-S', 'TANK'] },
        { type: 'F-1', name: 'VIPER 2', loadout: ['AAM-M', 'AAM-S', 'AAM-S', 'TANK'] },
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
    rating: { time: [480, 840], points: [22, 36], losses: [0, 1] },
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
        { type: 'F-2', name: 'HAMMER 1', loadout: ['AAM-M', 'AAM-S', 'AGM'] },
        { type: 'F-1', name: 'VIPER 1', loadout: ['AAM-M', 'AAM-M', 'AAM-S'] },
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
        { type: 'CONVOY', name: '車両部隊', x: 44000, z: 27000, tags: ['invasion'],
          route: [{ x: 44000, z: 27000 }, { x: 36000, z: 29000 }] },
      ],
    },
    // 評価基準（§18）。既定搭載で31P。目標は西へ動いてくるので待てば距離は縮む
    rating: { time: [540, 900], points: [34, 46], losses: [0, 1] },
    objectives: [
      { id: 'stop', type: 'destroyAll', tag: 'invasion', label: '上陸部隊（艦船2・車両部隊）を撃破する' },
      { id: 'radar', type: 'protect', tag: 'coastal-radar', label: '沿岸レーダーを守る', fail: true },
    ],
  },

  // ------------------------------------------------------------------ 7
  {
    id: 's6',
    name: 'TOTAL WAR',
    title: '総力戦',
    brief: '最終作戦。敵の早期警戒機を撃墜し、飛行場2箇所を破壊せよ。\n'
      + '敵は全戦力を投入してくる。損害を抑えながら段階的に削るしかない。',
    hint: '早期警戒機を先に落とせば、敵の探知網が大きく弱まり低空侵入が効くようになる。',
    terrain: { seed: 60606, mountainAmount: 1.2, coast: 'e', valleyDepth: 1.1, rivers: 3, baseAltitude: 460 },
    weaponPoints: 90,
    friendly: {
      base: { x: 8000, z: 42000 },
      startAirborne: false,
      aircraft: [
        { type: 'F-1', name: 'VIPER 1', loadout: ['AAM-A', 'AAM-M', 'AAM-S'] },
        { type: 'F-1', name: 'VIPER 2', loadout: ['AAM-M', 'AAM-M', 'AAM-S', 'TANK'] },
        { type: 'F-2', name: 'HAMMER 1', loadout: ['ARM', 'ARM', 'AAM-S'] },
        { type: 'A-3', name: 'ANVIL 1', loadout: ['AGM', 'AGM', 'BOMB', 'BOMB', 'AAM-S'] },
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
    rating: { time: [900, 1500], points: [44, 66], losses: [0, 2] },
    objectives: [
      { id: 'awacs', type: 'destroyAll', tag: 'awacs', label: '敵早期警戒機を撃墜する' },
      { id: 'bases', type: 'destroyAll', tag: 'target', label: '敵飛行場2箇所を破壊する' },
      { id: 'alive', type: 'protect', tag: 'home', label: '自軍飛行場を守る', fail: true },
    ],
  },
];

export function getStage(id) {
  return STAGES.find((s) => s.id === id) || null;
}

/** クリア済みリストから、そのステージが解禁されているかを返す（前ステージのクリアが条件） */
export function isUnlocked(stage, cleared) {
  const i = STAGES.indexOf(stage);
  if (i <= 0) return true;
  return cleared.includes(STAGES[i - 1].id);
}
