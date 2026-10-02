// 面ごとの作戦書（`ai/playbook.js`・PROPOSAL_playlog §4 案A）。**検証用だけ** —— 本編の画面は読まない。
//
// 1つの面に1つ。中身は「その面を分かっているプレイヤーが出す指示」。
// `{ loadouts: { 機体名: [兵装] }, steps: [段] }`。搭載は出撃前の選択、段は戦闘中の指示。
// ベンチでは別々に付け外しできる（`playbook`・`loadouts`）—— どちらが効いたかを分けるため。
// 面の**芯**（解き方の要点）を書き、素の司令官AIとの差でその芯がどれだけ効くかを測る。

export const PLAYBOOKS = {
  // COASTAL WALL（§107）。**芯は「上陸される前に、艦1隻に攻撃機1機を当てる」。**
  //
  // 人の上陸なしのクリア（2026-09-30 15:16・289秒）をなぞる: 戦闘機2機が敵機2機を前で受け持ち
  // （137・162秒に撃墜）、ANVIL 2 が艦1・ANVIL 1 が艦2 を AGM 2発ずつで沈めた（272・288秒）。
  // 艦1 のほうが先に岸に着く（約397秒）ので、近いほうを先に、ではなく**艦ごとに1機**を割り振る。
  //
  // 戦闘機の哨戒点は敵機の初期位置（44000, 22000／44000, 38000）と自軍飛行場の間、
  // 艦の近接防空（低空が危ない）から外れるよう高めに置く。
  //
  // **2機とも艦1 に集中させる版は測って退けた**（PROPOSAL_playlog §4.1）。艦1 は確実に沈むが、
  // 積み直しが艦2 の接岸（約561秒）に間に合わず、上陸なしは 0/24・clear 8/24（この版は 15/24）。
  //
  // 搭載は人が 09-30 16:07 以降に選んだもの（A-3 に AAM-M×2・AGM×2・BOMB×2）。
  // **AGM 2発で艦（HP320・AGM 180）を沈めるには2発とも直撃が要る**。至近弾が1つ出ると残る
  // （ベンチの種101 で艦2 が HP21 で残り、上陸された）。0P の爆弾2発がその予備。
  // **§110 でこの前提は消えた**: 外れていたのは逆探知の座標で撃っていたから。今は素の AI のほうが速い（PROPOSAL_playlog §4.1）
  s5: {
    loadouts: {
      'ANVIL 1': ['AAM-M', 'AAM-M', 'AGM', 'AGM', 'BOMB', 'BOMB'],
      'ANVIL 2': ['AAM-M', 'AAM-M', 'AGM', 'AGM', 'BOMB', 'BOMB'],
    },
    steps: [
      { id: 'open', when: [{ type: 'time', seconds: 0 }], do: [
        { type: 'strike', units: ['ANVIL 2'], tag: 'lst1' },
        { type: 'strike', units: ['ANVIL 1'], tag: 'lst2' },
        { type: 'patrol', units: ['VIPER 1'], x: 38000, z: 24000, alt: 5000 },
        { type: 'patrol', units: ['HAMMER 1'], x: 38000, z: 36000, alt: 5000 },
      ] },
      // 片方の艦が沈んだら、手の空いた攻撃機は残った艦へ
      { id: 'lst1-down', when: [{ type: 'destroyed', tag: 'lst1' }], do: [
        { type: 'strike', units: ['ANVIL 1', 'ANVIL 2'], tag: 'lst2' },
      ] },
      { id: 'lst2-down', when: [{ type: 'destroyed', tag: 'lst2' }], do: [
        { type: 'strike', units: ['ANVIL 1', 'ANVIL 2'], tag: 'lst1' },
      ] },
      // 敵機を落としきったら、戦闘機は司令官AIに返す（攻撃機の護衛に付く）
      { id: 'air-clear', when: [{ type: 'destroyed', tag: 'cap' }], do: [
        { type: 'release', units: ['HAMMER 1', 'VIPER 1'] },
      ] },
    ],
  },
};
