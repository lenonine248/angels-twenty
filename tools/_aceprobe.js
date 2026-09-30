// エースの振る舞い候補4つの効きを測る（PROPOSAL_ace §2）。
//
//   fetch('/tools/bench.js').then(r => r.text()).then(eval)
//   fetch('/tools/_aceprobe.js').then(r => r.text()).then(eval)
//   AT.ace.start({ formats: ['1v1', '2v2'], variants: [...], seeds: AT.ace.SEEDS })  // 走らせっぱなし
//   AT.ace.state        // { done, total, running, error }
//   AT.ace.report()     // 形式×振る舞いの集計だけ返す
//   AT.ace.paired('1v1', 'A1b')   // 同じ種で基準と比べた勝ち負けの入れ替わり
//
// 面は初陣（CLEAN SWEEP）の配置を下敷きにした空戦だけの面。
// 自軍は F-1（AAM-M×2・AAM-S×2）を司令官AIが指揮、敵は J-7（AAM-M・AAM-S×2・練度1・PURSUIT）。
// **エースは敵の先頭の1機**（2v2 の2機目は並の僚機）。`A3b` だけ2機ともエース。
// 振る舞いは本体を書き換えず、機体ごとに差し込む（`steerHook`・`_evade`・`_decoyStartTti`・`fireThreshold`）。
//
// 振る舞い（E9 の4候補を、いまの AI からの差分として具体化したもの）:
//   N    並の敵（基準）
//   A1a  ① デコイを早く撒く（残り 11秒 → 18秒）
//   A1b  ① 電波誘導弾に対して最初からビーム（「逃げる」を使わない）
//   A1c  ① 電波誘導弾に対して必ず逃げから入る（遠近を問わない）
//   A1d  ① デコイ2倍（振る舞いではなく持ち物 —— 比べる物差しとして）
//   A2a  ② 撃つ位置: 12km まで相手＋2,500m を保って入る（速度は全開）
//   A2b  ② 撃つ判断: 期待度「高」（0.40）でだけ撃つ
//   A2c  ② A2a＋A2b
//   A3a  ③ 側面へ回る: 15km より遠いうちは相手の方位から 50° ずらして入る（僚機はまっすぐ＝囮）
//   A3b  ③ 挟み撃ち: 2機とも左右へ 45° ずつ割れて入る
//   A4   ④ 引き際: 弾をかわした直後に速度が落ちていれば 25秒離れて立て直す／
//         見えている敵機が味方より多ければ 40秒離れる。そのあと戦い直す
//   ---- 2回目（§2.2）: 1回目で効かなかった ③④ の形を変えたもの ----
//   A3c  ③′ 囮が先に撃つ: 僚機は期待度「低」で遠くから撃つ。エースは並
//   A3d  ③′ A3c＋エースは相手が回避中なら「低」、そうでなければ「高」でだけ撃つ（詰めて撃つ）
//   A3e  ③′ A3c＋エースは A2a の高さ
//   A4b  ④′ F-pole: 自分の電波誘導弾が飛んでいる間、相手を扇の縁（クランク）に置いて詰めない
//   A4c  ④′ A4b＋A2a の高さ
//   A4d  ④′ 警報が鳴ったら背を向けて逃げ切る（ビームに移らない）。弾が消えて15秒後に戻る
//   ---- 3回目（§2.3 用）: 3つ目の候補（持ち物か機体か）を同じ物差しで測る ----
//   P1   持ち物: J-7 のまま、AAM-M を AAM-A に差し替える（AAM-S×2 は残す。振る舞いは並）
//   P2   P1（AAM-A 持ち）＋ A2a の高さ
//   P3   P1（AAM-A 持ち）＋ A4d の逃げ切り
//   K1   機体: J-13（ステルス・rcs 0.3）に並の搭載（AAM-M・AAM-S×2）。レーダーは auto。振る舞いは並
//   K2   K1 ＋ radarMode を 'off' に固定（黙って寄る）
//   K3   K1 の機体＋ P1 の搭載（AAM-A・AAM-S×2）＋ radarMode 'off'
//   機体・搭載・レーダーの差し替えは `duelStage()` でステージ定義に入れる（spawn 前）。
//   振る舞い（steerHook 等）はいままでどおり VARIANTS で spawn 後に差し込む。
//   ---- 4回目: J-13 の長所を生かす運用（追加依頼分） ----
//   K4   近づいて AAM-S: J-13、搭載は AAM-S×3（J-7既定の3スロットぶんを埋める）、radarMode 'off' 固定。
//        AAM-S は赤外線誘導で発射条件が自機レーダーを見ない（`sim/combat.js` inEnvelope の 'ir' 分岐・
//        `inRadarFan` を通らない）ので、振る舞いは並のまま撃てるかを確かめる
//   K5   AAM-A をデータリンクで: J-13＋ P1 の搭載（AAM-A）、radarMode 'off' 固定、振る舞いは並。
//        AAM-A は `datalink: true` で、`datalinkSource()`（`sim/combat.js`）が「陣営の別機が照らしていれば
//        自機のレーダーが無くても撃てる」経路を持つ（`js/data/tutorials.js` w4 と同じ仕組み）。
//        設定としては K3 と同一（1v1 は僚機が無いので K3 と一致するはずの確認、2v2 は僚機 J-7 のレーダーが
//        データリンク源になる）
//   K6   撃つ時だけレーダー ON: J-13＋ P1 の搭載（AAM-A）、既定 radarMode 'off'。
//        自機の（既存の検出経路で分かっている）目標が AAM-A の表記射程 20,000m
//        （`js/data/weapons.js` WEAPONS['AAM-A'].range。高度補正した実効射程ではなく素の値）以内に
//        入ったら 'on' にして詰める。撃ったら直ちに 'off' に戻し、警報が鳴れば A4d と同じく
//        照射源に背を向けて逃げ切る（弾が消えて 15秒後に再開）
//
// どの振る舞いでも、エースに向かった弾を1発ずつ記録する（①′: 2発目がなぜ当たるか）。
// K系（J-13）だけ、エースのレーダー点灯時間の割合・自軍の初探知（距離・目視かレーダーか）・
// 自軍との最接近距離も記録する（`AT.ace.report()` の radarOnFrac / detDist / detVia / minRange）。
// K6 だけ、レーダーを入れてから撃つまでの秒数も記録する（`onToFireSec`）。
//
//   ---- 5回目（§2.4）: AAM-A に対策があるか。自軍の側に対策を強制する ----
//   変種名は 'P1/D3' のように「エースの振る舞い/自軍の対策」。対策は自軍の全機に掛ける。
//   D0   対策なし（= P1 と同じ。基準）
//   D1   回避優先: AAM-A に対してだけ「照射を保つ（_worthHoldingLock）」「扇の縁で止める（クランク）」を外す
//   D1c  D1 のうちクランクだけ外す（照射の保持は残す。§2.5 の1: E14 の外す形を決める）
//   D2   D1＋警報と同時にチャフ（撒き始めを残り 11秒 → 警報の瞬間）
//   D3  逃げ切り: AAM-A の警報で弾に背を向けて全速で逃げ続ける（ビーム・ブレイクなし。チャフは既定の時機）
//   D4   D2＋警報から低空（地表＋200m）へ降りてビーム（見下ろし＋地面の背景でノッチを成立させる）
//   D5   D4＋入りから低空（地表＋300m）で寄る（撃たれる前から見下ろさせる）
//   D6   D2＋入りを高く（12km まで相手＋2,500m。A2a を自軍側に）
//   D7   D2＋入りをクランク（12km まで相手を機首から 60° に置く。詰める速さを落とす）
//   D8   先に撃つ: 自軍の fireThreshold を 'low'（遠くから AAM-M を撃ってエースを回避に入らせる）
//   ---- 6回目（§2.5 の2）: E14 の規則は敵にも掛かる。向きを逆にしてプレイヤーの AAM-A の効きを測る ----
//   'N/B0' 自軍が AAM-A×1・AAM-S×2、敵は並 ／ 'N/B1' B0＋敵の全機に D1 ／ 'N/B1c' 同 D1c。`AT.ace.blueArh('1v1')` で並べる
// エースが撃った弾は1発ずつ記録する（`AT.ace.outgoing()`）: 発射距離・シーカーが入った距離・警報の距離・
// 警報から終わりまでの秒・警報中に回避していなかった秒（照射を保った）・妨害の最大値・中途で位置をもらえなかった割合。

(function () {
  const IDX = 0;
  const SEEDS = Array.from({ length: 36 }, (_, i) => 11 * (i + 1));   // 11〜396
  const rows = [];
  const state = { done: 0, total: 0, running: false, error: null };

  const deg = Math.PI / 180;
  const headingOf = (dx, dz) => Math.atan2(dx, -dz);

  // P系: 持ち物だけ変える（AAM-M → AAM-A）。K系: 機体を J-13 に差し替え、必要なら搭載・レーダーも変える
  const ACE_LOADOUT = {
    P1: ['AAM-A', 'AAM-S', 'AAM-S'], P2: ['AAM-A', 'AAM-S', 'AAM-S'], P3: ['AAM-A', 'AAM-S', 'AAM-S'],
    K1: ['AAM-M', 'AAM-S', 'AAM-S'], K2: ['AAM-M', 'AAM-S', 'AAM-S'],
    K3: ['AAM-A', 'AAM-S', 'AAM-S'],
    K4: ['AAM-S', 'AAM-S', 'AAM-S'],                    // J-7既定(AAM-M+AAM-S×2=3スロット)と同じ枠数
    K5: ['AAM-A', 'AAM-S', 'AAM-S'], K6: ['AAM-A', 'AAM-S', 'AAM-S'],
  };
  const ACE_TYPE = { K1: 'J-13', K2: 'J-13', K3: 'J-13', K4: 'J-13', K5: 'J-13', K6: 'J-13' };
  const ACE_RADAR = { K2: 'off', K3: 'off', K4: 'off', K5: 'off', K6: 'off' };
  // §2.5 の2: 規則が敵にも掛かるので、向きを逆にして測る。変種名は 'N/B0' のように書く
  //   B0  自軍が AAM-A を持つ（敵は並）。E14 の前
  //   B1  B0＋敵の全機に D1（AAM-A に対してクランクと照射の保持を外す）。E14 の後の見込み
//   B1c B0＋敵の全機に D1c（クランクだけ外す。どちらが効いているかを分ける）
  //   B0x B0＋敵の全機で E14 を切る（aircraft.js の一時スイッチ `__e14off`。§2.5.5 の測定用。スイッチが無ければ B0 と同じ）
  const BLUE_ARH = new Set(['B0', 'B1', 'B1c', 'B0x']);
  const AAM_A_RANGE = 20000;   // js/data/weapons.js WEAPONS['AAM-A'].range（素の表記射程。高度補正なし）

  // 'P1/D3' → ['P1', 'D3']。対策の付かない名前は D0
  const split = (v) => { const [a, d] = String(v).split('/'); return [a, d || 'D0']; };

  function duelStage(n, full) {
    const [variant, defense] = split(full);
    const s = JSON.parse(JSON.stringify(AT.__aceBase));
    s.id = 'acetest';
    s.name = 'ACE TEST';
    s.friendly.aircraft = s.friendly.aircraft.slice(0, n);
    // B系（§2.5 の2）: 自軍が AAM-A を持つ（AAM-M×2 → AAM-A×1。エースの P1 と同じ組）
    if (BLUE_ARH.has(defense)) {
      s.friendly.aircraft = s.friendly.aircraft.map((a) => ({ ...a, loadout: ['AAM-A', 'AAM-S', 'AAM-S'] }));
    }
    // **敵は PURSUIT**（交戦 30km）。初陣の PATROL は 14km まで寄らないと向かって来ず、
    // 先に撃たれて回避に入ったまま一度も撃たない（種11で確認）。エースは狩る側として測る
    s.enemy.aircraft = s.enemy.aircraft.slice(0, n).map((a) => ({ ...a, aiMode: 'PURSUIT' }));
    // 先頭(index 0)がエース。P系/K系は spawn 前に持ち物・機体・レーダーを差し替える
    if (s.enemy.aircraft[0]) {
      const ace = s.enemy.aircraft[0];
      if (ACE_LOADOUT[variant]) ace.loadout = ACE_LOADOUT[variant].slice();
      if (ACE_TYPE[variant]) ace.type = ACE_TYPE[variant];
      if (ACE_RADAR[variant]) ace.radarMode = ACE_RADAR[variant];
    }
    delete s.ally;
    return s;
  }

  // ---- 振る舞い ----

  function airTarget(u) {
    const o = u.order;
    const t = o && o.type === 'attack' ? o.target : null;
    return t && t.alive && t.kind === 'aircraft' && !t.onGround ? t : null;
  }

  function knownEnemies(u, w) {
    const out = [];
    for (const [, ct] of w.detection.contactsFor(u.side)) {
      if (ct.detected && ct.unit && ct.unit.alive && ct.unit.side !== u.side
        && ct.unit.kind === 'aircraft' && !ct.unit.onGround) out.push(ct.unit);
    }
    return out;
  }

  const VARIANTS = {
    N: () => {},
    A1a: (u) => { u._decoyStartTti = () => 18; },
    A1b: (u) => {
      const orig = u._evade;
      u._evade = function (w, dt) {
        const m = this.threats[0];
        if (m && this._evadeTactic == null) this._evadeTactic = 'beam';
        return orig.call(this, w, dt);
      };
    },
    A1c: (u) => {
      const orig = u._evade;
      u._evade = function (w, dt) {
        const m = this.threats[0];
        const radar = m && (m.guidance === 'sarh' || m.guidance === 'arh' || m.guidance === 'command');
        if (radar && this._evadeTactic == null) { this._evadeTactic = 'run'; this._runFor = 0; }
        return orig.call(this, w, dt);
      };
    },
    A1d: (u) => { u.flares *= 2; u.chaff *= 2; },
    A2a: (u) => perch(u),
    A2b: (u) => { u.fireThreshold = 'high'; },
    A2c: (u) => { perch(u); u.fireThreshold = 'high'; },
    A3a: (u) => flank(u, 50),
    A3b: (u, k) => flank(u, k === 0 ? 45 : -45),
    A4: (u) => disengage(u),
    A3c: () => {},                        // 囮の設定は setup() で僚機に入れる
    A3d: (u) => { closeIn(u); },
    A3e: (u) => perch(u),
    A4b: (u) => fpole(u, null),
    A4c: (u) => { perch(u); fpole(u, u.steerHook); },
    A4d: (u) => drag(u),
    // ---- 3回目: 持ち物(P)・機体(K) ----
    P1: () => {},                         // 持ち物だけ（AAM-A）。振る舞いは並
    P2: (u) => perch(u),                  // 持ち物(AAM-A) + A2a の高さ
    P3: (u) => drag(u),                   // 持ち物(AAM-A) + A4d の逃げ切り
    K1: () => {},                         // J-13・並搭載・auto・振る舞いは並
    K2: () => {},                         // K1 + radarMode off（duelStage 側で設定）
    K3: () => {},                         // J-13 + AAM-A + radarMode off（duelStage 側で設定）
    // ---- 4回目: J-13 の長所を生かす運用 ----
    K4: () => {},                         // J-13 + AAM-S×3 + radarMode off。振る舞いは並（IRは自機レーダー不要）
    K5: () => {},                         // J-13 + AAM-A + radarMode off。振る舞いは並（データリンクで撃てるかの確認）
    K6: (u) => k6(u),                     // J-13 + AAM-A + radarMode off。射程内で ON→撃つ→即 OFF、警報で逃げ切る
  };
  const DECOY_LEAD = new Set(['A3c', 'A3d', 'A3e']);

  // 相手が回避中なら「低」、そうでなければ「高」で撃つ（fireThreshold を毎フレーム差し替える）
  function closeIn(u) {
    u.steerHook = function () {
      const t = airTarget(this);
      this.fireThreshold = t && t.evading ? 'low' : 'high';
      return null;
    };
  }

  // 自分の電波誘導弾が飛んでいる間、相手を扇の縁に置く（詰めない）。inner は先に聞く差し込み（高さ）
  function fpole(u, inner) {
    u.steerHook = function (w, dt, d) {
      const base = inner ? inner.call(this, w, dt, d) : null;
      if (d.evading) return base;
      const m = this._mySarh(w);
      const t = m && m.target;
      if (!t || !t.alive) return base;
      const toT = headingOf(t.pos.x - this.pos.x, t.pos.z - this.pos.z);
      const lockFov = this.spec.radarLockFovH ?? this.spec.radarFovH ?? 60;
      const lim = lockFov * 0.45 * deg;
      const cur = base ? base.heading : d.heading;
      const off = Math.atan2(Math.sin(cur - toT), Math.cos(cur - toT));
      this.__ace.overSec += dt;
      return { heading: toT + (off >= 0 ? lim : -lim), alt: base ? base.alt : d.alt, speed: this.altitudeMaxSpeed };
    };
  }

  // 警報が鳴ったら照射源（なければ弾）に背を向けて逃げ切る。弾が消えて15秒後に戻る
  function drag(u) {
    let until = -1, from = null;
    u.steerHook = function (w, dt, d) {
      const t = w.__aceT;
      const m = this.threats[0];
      if (m && m.alive) {
        if (until < t) this.__ace.triggers.energy = (this.__ace.triggers.energy || 0) + 1;
        const src = this._illuminatorOf(m) || m;
        from = { x: src.pos.x, z: src.pos.z };
        until = t + 15;
      }
      if (t >= until || !from) return null;
      this.__ace.overSec += dt;
      // 赤外線弾だけは背を向けない（排気を見せる）。回避に任せる
      if (m && m.alive && m.guidance === 'ir') return null;
      return { heading: headingOf(this.pos.x - from.x, this.pos.z - from.z), alt: d.alt, speed: this.altitudeMaxSpeed };
    };
  }

  // 撃つ時だけレーダー ON。目標（既存の airTarget/believedPosOf 経路で分かっているものだけ）が
  // AAM-A の表記射程（AAM_A_RANGE）内に入ったら 'on'。撃ったら直ちに 'off' に戻す。
  // 警報中は drag() と同じ要領で照射源に背を向けて逃げる（弾が消えて 15秒後に再開）。
  function k6(u) {
    let dragUntil = -1, dragFrom = null, radarOnAt = null, firedSoFar = 0;
    u.steerHook = function (w, dt, d) {
      const t = w.__aceT;
      const a = this.__ace;
      const m = this.threats[0];
      if (m && m.alive) {
        if (dragUntil < t) a.triggers.energy = (a.triggers.energy || 0) + 1;
        const src = this._illuminatorOf(m) || m;
        dragFrom = { x: src.pos.x, z: src.pos.z };
        dragUntil = t + 15;
        this.radarMode = 'off';
        radarOnAt = null;
      }
      if (t < dragUntil) {
        a.overSec += dt;
        if (m && m.alive && m.guidance === 'ir') return null;   // IR弾は背を向けない（drag() と同じ）
        if (dragFrom) return { heading: headingOf(this.pos.x - dragFrom.x, this.pos.z - dragFrom.z), alt: d.alt, speed: this.altitudeMaxSpeed };
        return null;
      }
      const tgt = airTarget(this);
      if (!tgt) { this.radarMode = 'off'; radarOnAt = null; return null; }
      const aim = this.believedPosOf(tgt, w) || tgt.pos;
      const flat = Math.hypot(aim.x - this.pos.x, aim.z - this.pos.z);
      if (flat <= AAM_A_RANGE) {
        if (this.radarMode !== 'on') { this.radarMode = 'on'; radarOnAt = t; }
        const shotsNow = Object.values(a.shots).reduce((s, v) => s + v, 0);
        if (shotsNow > firedSoFar) {
          firedSoFar = shotsNow;
          if (radarOnAt != null) { a.onToFireSec.push(+(t - radarOnAt).toFixed(1)); }
          this.radarMode = 'off';   // 撃ったらすぐ黙る
          radarOnAt = null;
        }
      } else {
        this.radarMode = 'off';
        radarOnAt = null;
      }
      return null;
    };
  }

  function perch(u) {
    u.steerHook = function (w, dt, d) {
      if (d.evading) return null;
      const t = airTarget(this);
      if (!t) return null;
      const aim = this.believedPosOf(t, w);
      if (!aim) return null;
      const flat = Math.hypot(aim.x - this.pos.x, aim.z - this.pos.z);
      if (flat < 12000) return null;
      this.__ace.overSec += dt;
      return { heading: d.heading, alt: Math.min(11000, aim.y + 2500), speed: this.altitudeMaxSpeed };
    };
  }

  function flank(u, offDeg) {
    u.steerHook = function (w, dt, d) {
      if (d.evading) return null;
      const t = airTarget(this);
      if (!t) return null;
      const aim = this.believedPosOf(t, w);
      if (!aim) return null;
      const dx = aim.x - this.pos.x, dz = aim.z - this.pos.z;
      if (Math.hypot(dx, dz) < 15000) return null;
      this.__ace.overSec += dt;
      return { heading: headingOf(dx, dz) + offDeg * deg, alt: d.alt, speed: d.speed };
    };
  }

  function disengage(u) {
    let prevThreat = 0, until = -1, cool = 0, from = null;
    u.steerHook = function (w, dt, d) {
      const a = this.__ace;
      const t = w.__aceT;
      const nThreat = this.threats.length;
      const justDefended = prevThreat > 0 && nThreat === 0;
      prevThreat = nThreat;
      if (d.evading) return null;
      const foes = knownEnemies(this, w);
      if (t >= until && t >= cool && foes.length) {
        const mates = w.units.filter((x) => x.alive && x.side === this.side && x.kind === 'aircraft' && !x.onGround).length;
        let why = null;
        if (justDefended && this.speed < this.altitudeMaxSpeed * 0.85) why = 'energy';
        else if (foes.length > mates) why = 'outnumbered';
        if (why) {
          until = t + (why === 'energy' ? 25 : 40);
          cool = until + 30;
          a.triggers[why] = (a.triggers[why] || 0) + 1;
        }
      }
      if (t >= until || !foes.length) return null;
      let near = null, best = Infinity;
      for (const f of foes) {
        const p = this.believedPosOf(f, w) || f.pos;
        const r = Math.hypot(p.x - this.pos.x, p.z - this.pos.z);
        if (r < best) { best = r; near = p; }
      }
      a.overSec += dt;
      from = near;
      return { heading: headingOf(this.pos.x - from.x, this.pos.z - from.z), alt: d.alt, speed: this.altitudeMaxSpeed };
    };
  }

  // ---- 自軍側の対策（§2.4）----

  const isArh = (m) => !!m && m.alive && m.guidance === 'arh';
  const lowAlt = (w, u, agl) => w.terrain.heightAt(u.pos.x, u.pos.z) + agl;

  // AAM-A に対してだけ「照射を保つ」「扇の縁で止める」を外す（keepHold: 照射の保持は残す＝D1c）
  function evadeFirst(u, keepHold = false) {
    const hold = u._worthHoldingLock, crank = u._crankHeading;
    if (!keepHold) u._worthHoldingLock = function (w, m) { return isArh(m) ? false : hold.call(this, w, m); };
    u._crankHeading = function (w, h) {
      if (isArh(this.threats[0])) { this.cranking = false; return h; }
      return crank.call(this, w, h);
    };
  }
  // AAM-A の警報と同時に撒き始める（チャフは逃げ・ビームに入ってからしか撒かない仕組みはそのまま）
  function chaffAtOnce(u) {
    const orig = u._decoyStartTti;
    u._decoyStartTti = function () { return isArh(this.threats[0]) ? 99 : orig.call(this); };
  }
  function runAway(u) {
    const orig = u._evade;
    u._evade = function (w, dt) {
      const m = this.threats[0];
      if (!isArh(m)) return orig.call(this, w, dt);
      const dx = m.pos.x - this.pos.x, dz = m.pos.z - this.pos.z;
      this.running = true; this.beaming = false;
      this._maybeDeployDecoy(w, dt, m, Math.hypot(dx, dz) / Math.max(60, m.speed));
      return { heading: headingOf(-dx, -dz), alt: this.pos.y, speed: this.altitudeMaxSpeed };
    };
  }
  function lowBeam(u, agl) {
    const orig = u._evade;
    u._evade = function (w, dt) {
      const o = orig.call(this, w, dt);
      if (!o || !isArh(this.threats[0])) return o;
      return { ...o, alt: Math.min(o.alt, lowAlt(w, this, agl)) };
    };
  }
  // 入り方（撃たれる前）。相手はエース（真の位置ではなく自軍が信じている位置）
  function approach(u, aces, mode) {
    let side = 0;
    u.steerHook = function (w, dt, d) {
      if (d.evading) return null;
      const ace = aces.find((a) => a.alive);
      if (!ace) return null;
      const p = this.believedPosOf(ace, w);
      if (!p) return null;
      const dx = p.x - this.pos.x, dz = p.z - this.pos.z;
      const r = Math.hypot(dx, dz);
      if (mode === 'low') {
        if (r < 5000) return null;
        return { heading: d.heading, alt: lowAlt(w, this, 300), speed: d.speed };
      }
      if (r < 12000) return null;
      if (mode === 'high') return { heading: d.heading, alt: Math.min(11000, p.y + 2500), speed: this.altitudeMaxSpeed };
      // crank: 左右は最初に近いほうを選んで保つ
      const brg = headingOf(dx, dz);
      if (!side) side = Math.sin(this.heading - brg) >= 0 ? 1 : -1;
      return { heading: brg + side * 60 * deg, alt: d.alt, speed: d.speed };
    };
  }

  const DEFENSES = {
    D0: () => {},
    D1: (u) => { evadeFirst(u); },
    D1c: (u) => { evadeFirst(u, true); },
    D2: (u) => { evadeFirst(u); chaffAtOnce(u); },
    D3: (u) => { runAway(u); },
    D4: (u) => { evadeFirst(u); chaffAtOnce(u); lowBeam(u, 200); },
    D5: (u, aces) => { evadeFirst(u); chaffAtOnce(u); lowBeam(u, 200); approach(u, aces, 'low'); },
    D6: (u, aces) => { evadeFirst(u); chaffAtOnce(u); approach(u, aces, 'high'); },
    D7: (u, aces) => { evadeFirst(u); chaffAtOnce(u); approach(u, aces, 'crank'); },
    D8: (u) => { u.fireThreshold = 'low'; },
    B0: () => {},                           // 搭載は duelStage()、敵側の差し込みは setup()
    B1: () => {},
    B1c: () => {},
    B0x: () => {},
    D0x: () => {},   // 自軍の全機で E14 を切る（E14 の前の P1/D0 の再現。aircraft.js の一時スイッチ `__e14off`。PROPOSAL_ace §2.5.7。スイッチが無ければ D0 と同じ）
  };

  // ---- 計装 ----

  // bench の step() が `w.onFire` などを上書きするので、代入を受けて両方を呼ぶ形にする
  function chain(w, name, mine) {
    let theirs = w[name] || null;
    Object.defineProperty(w, name, {
      configurable: true,
      get: () => (...args) => { mine(...args); return theirs ? theirs(...args) : undefined; },
      set: (f) => { theirs = f; },
    });
  }

  function setup(format, full) {
    const [variant, defense] = split(full);
    return (b) => {
      const w = b.world;
      w.__aceT = 0;
      const det = w.detection;
      const origDet = det.update.bind(det);
      const track = new Map();   // 弾 → 記録（エースに向かった弾だけ）
      const outTrack = new Map();   // 弾 → 記録（エースが撃った弾・§2.4）
      const out = [];
      let acesRef = null, bluesRef = null, redsRef = null;
      const blueArhOn = BLUE_ARH.has(defense);
      const blueArh = new Map();   // 自軍の AAM-A → { done, hit, end }
      const redArh = { sec: 0, crank: 0, noEvade: 0 };   // 敵が AAM-A を筆頭の脅威にしていた秒
      const acesMeta = new Map();   // ace → { radarSec, aliveSec, minRange, det:{t,dist,via}|null }
      det.update = (dt) => {
        w.__aceT += dt; origDet(dt);
        if (acesRef) {
          for (const ace of acesRef) {
            const meta = acesMeta.get(ace);
            if (!meta || !ace.alive) continue;
            meta.aliveSec += dt;
            if (ace.radarActive) meta.radarSec += dt;
            let near = Infinity;
            if (bluesRef) {
              for (const bl of bluesRef) {
                if (!bl.alive) continue;
                const r = bl.pos.distanceTo(ace.pos);
                if (r < near) near = r;
              }
            }
            if (near < meta.minRange) meta.minRange = near;
            if (!meta.det) {
              const c = det.contactsFor(w.playerSide).get(ace.id);
              if (c && c.detected) meta.det = { t: w.__aceT, dist: Math.round(near), via: c.level === 2 ? 'visual' : 'radar' };
            }
          }
        }
        for (const m of w.missiles || []) {
          const tg = m.target;
          if (!tg || !tg.__ace || track.has(m)) continue;
          const a = tg.__ace;
          const prev = a.inc.length ? a.inc[a.inc.length - 1] : null;
          const rec = {
            k: a.inc.length + 1, w: m.weapon && m.weapon.id, g: m.guidance,
            t0: w.__aceT, gap: prev ? Math.round(w.__aceT - prev.t0) : null,
            prevAlive: prev ? !prev.done : null,
            r0: Math.round(m.pos.distanceTo(tg.pos) / 100) / 10,
            v0: Math.round(tg.speed), y0: Math.round(tg.pos.y),
            busy0: !!tg.evading, vmin: tg.speed, done: false,
          };
          a.inc.push(rec);
          track.set(m, { rec, tg });
        }
        for (const [m, o] of track) {
          const { rec, tg } = o;
          if (rec.done) continue;
          if (tg.alive) rec.vmin = Math.min(rec.vmin, tg.speed);
          if (m.alive && tg.alive) { rec.tac = tg._evadeTactic || rec.tac || null; continue; }
          rec.done = true;
          rec.end = m.alive ? 'tgtDead' : (m.endReason || '?');
          rec.hit = !!m.__hit;
          rec.sec = Math.round(w.__aceT - rec.t0);
          rec.v1 = Math.round(tg.speed); rec.y1 = Math.round(tg.pos.y);
          rec.vmin = Math.round(rec.vmin);
        }
        // 自軍が撃った AAM-A（§2.5 の2）と、それを受けた敵の動き（全機・エースに限らない）
        if (blueArhOn) {
          for (const m of w.missiles || []) {
            if (m.guidance !== 'arh' || !m.launcher || m.launcher.side !== w.playerSide || blueArh.has(m)) continue;
            const tg = m.target;
            blueArh.set(m, {
              done: false, hit: false, end: null, tg,
              r0: tg ? Math.round(m.pos.distanceTo(tg.pos) / 100) / 10 : null,
              dy: tg ? Math.round(m.launcher.pos.y - tg.pos.y) : null,
              guiding0: !!(tg && tg._guidingSarh && tg._guidingSarh(w)),
              crankSec: 0, evSec: 0, warnSec: 0, activeR: null,
            });
          }
          for (const [m, rec] of blueArh) {
            if (rec.done) continue;
            if (m.alive) {
              const tg = rec.tg;
              if (tg && tg.alive) {
                if (rec.activeR == null && m.active === true) rec.activeR = Math.round(m.pos.distanceTo(tg.pos) / 100) / 10;
                if (tg.threats && tg.threats.includes(m)) {
                  rec.warnSec += dt;
                  if (tg.threats[0] === m) { if (tg.cranking) rec.crankSec += dt; if (tg.evading) rec.evSec += dt; }
                }
              }
              continue;
            }
            rec.done = true; rec.hit = !!m.__hit; rec.end = rec.hit ? 'hit' : (m.endReason || '?');
            // §2.5.5: `spent` を wpncost.js と同じ規則で割る（失速・通過・寿命）。誘導喪失は lostReason
            let why = rec.hit ? '命中' : (m.lostReason || rec.end);
            if (why === 'spent') {
              if (m.speed < m.weapon.speed * 0.35) why = '失速';
              else if (m._openingFor >= 0.5) why = '通過';
              else why = '寿命';
            }
            rec.why = why;
            rec.minDist = m._minDist == null ? null : Math.round(m._minDist);
            rec.vr = Math.round(m.speed / m.weapon.speed * 100) / 100;
            rec.tof = Math.round((m.age || 0) * 10) / 10;
            rec.jam = Math.round((m._jamPeak || 0) * 100) / 100;
            rec.crankSec = Math.round(rec.crankSec * 10) / 10; rec.evSec = Math.round(rec.evSec * 10) / 10;
            rec.warnSec = Math.round(rec.warnSec * 10) / 10;
            rec.tgDead = !!(rec.tg && !rec.tg.alive);
            rec.tg = null;
          }
          for (const u of redsRef || []) {
            if (!u.alive || !isArh(u.threats && u.threats[0])) continue;
            redArh.sec += dt;
            if (u.cranking) redArh.crank += dt;
            if (!u.evading) redArh.noEvade += dt;
          }
        }
        // エースが撃った弾（§2.4）
        for (const m of w.missiles || []) {
          if (!m.launcher || !m.launcher.__ace || outTrack.has(m)) continue;
          const tg = m.target;
          if (!tg || tg.side === m.launcher.side) continue;
          const rec = {
            w: m.weapon && m.weapon.id, t0: w.__aceT,
            r0: Math.round(m.pos.distanceTo(tg.pos) / 100) / 10,
            dy: Math.round(m.launcher.pos.y - tg.pos.y), y0: Math.round(tg.pos.y),
            activeR: null, warnR: null, warnT: null, holdSec: 0, evSec: 0, tac: null,
            mc: 0, mcMiss: 0, chaff0: tg.chaff ?? 0, done: false,
          };
          if (m.guidance === 'arh' && typeof m._midcourseFix === 'function') {
            const mf = m._midcourseFix;
            m._midcourseFix = function (ww) { const ok = mf.call(this, ww); rec.mc++; if (!ok) rec.mcMiss++; return ok; };
          }
          out.push(rec);
          outTrack.set(m, { rec, tg });
        }
        for (const [m, o] of outTrack) {
          const { rec } = o;
          if (rec.done) continue;
          const tg = m.target || o.tg;
          if (m.alive && tg && tg.alive) {
            const r = m.pos.distanceTo(tg.pos);
            if (rec.activeR == null && m.active === true) rec.activeR = Math.round(r / 100) / 10;
            if (tg.threats && tg.threats.includes(m)) {
              if (rec.warnT == null) { rec.warnT = w.__aceT; rec.warnR = Math.round(r / 100) / 10; }
              if (tg.threats[0] === m) {
                if (tg.evading) rec.evSec += dt; else rec.holdSec += dt;
                rec.tac = tg._evadeTactic || rec.tac;
              }
            }
            continue;
          }
          rec.done = true;
          rec.end = m.alive ? 'tgtDead' : (m.endReason || '?');
          rec.hit = !!m.__hit;
          rec.sec = Math.round(w.__aceT - rec.t0);
          rec.warnSec = rec.warnT == null ? null : Math.round((w.__aceT - rec.warnT) * 10) / 10;
          rec.jam = Math.round((m._jamPeak || 0) * 100) / 100;
          rec.chaffUsed = rec.chaff0 - ((o.tg && o.tg.chaff) ?? 0);
          rec.y1 = o.tg ? Math.round(o.tg.pos.y) : null;
          rec.agl1 = o.tg ? Math.round(o.tg.pos.y - w.terrain.heightAt(o.tg.pos.x, o.tg.pos.z)) : null;
          rec.holdSec = Math.round(rec.holdSec * 10) / 10; rec.evSec = Math.round(rec.evSec * 10) / 10;
        }
      };

      const reds = w.units.filter((u) => u.side !== w.playerSide && u.kind === 'aircraft');
      const aces = variant === 'A3b' ? reds.slice(0, 2) : reds.slice(0, 1);
      if (DECOY_LEAD.has(variant) && reds[1]) reds[1].fireThreshold = 'low';
      aces.forEach((u, k) => {
        u.__ace = {
          inc: [], overSec: 0, triggers: {}, shots: {}, hits: 0, shotAt: 0, hitBy: 0,
          fireAlt: [], fireRange: [], shotAtByWeapon: {}, firstShotAtRange: null, onToFireSec: [],
        };
        acesMeta.set(u, { radarSec: 0, aliveSec: 0, minRange: Infinity, det: null });
        VARIANTS[variant](u, k);
      });
      const blues = w.units.filter((u) => u.side === w.playerSide && u.kind === 'aircraft');
      for (const u of blues) DEFENSES[defense](u, aces);
      if (defense === 'B1') for (const u of reds) evadeFirst(u);
      if (defense === 'B1c') for (const u of reds) evadeFirst(u, true);
      if (defense === 'B0x') for (const u of reds) u.__e14off = true;
      if (defense === 'D0x') for (const u of blues) u.__e14off = true;
      acesRef = aces; bluesRef = blues; redsRef = reds;
      b.__ace = { format, variant: full, aces, reds, blues, firstShot: null, acesMeta, out, blueArh, redArh };

      chain(w, 'onFire', (sh, tg, wp) => {
        sh.__shots = (sh.__shots || 0) + 1;
        if (b.__ace.firstShot == null) b.__ace.firstShot = w.__aceT;
        if (sh.__ace) {
          sh.__ace.shots[wp.id] = (sh.__ace.shots[wp.id] || 0) + 1;
          sh.__ace.fireAlt.push(sh.pos.y - tg.pos.y);
          sh.__ace.fireRange.push(sh.pos.distanceTo(tg.pos));
        }
        if (tg && tg.__ace) {
          tg.__ace.shotAt++;
          tg.__ace.shotAtByWeapon[wp.id] = (tg.__ace.shotAtByWeapon[wp.id] || 0) + 1;
          if (tg.__ace.firstShotAtRange == null) tg.__ace.firstShotAtRange = Math.round(sh.pos.distanceTo(tg.pos));
        }
      });
      chain(w, 'onMissileHit', (m, tg) => {
        m.__hit = true;
        if (m.launcher && m.launcher.__ace) m.launcher.__ace.hits++;
        if (tg && tg.__ace) tg.__ace.hitBy++;
      });
    };
  }

  function runOne(format, variant, seed) {
    const n = format === '2v2' ? 2 : 1;
    const orig = AT.stages[IDX];
    AT.stages[IDX] = duelStage(n, variant);
    let holder = null;
    const su = setup(format, variant);
    return AT.bench.runOne(IDX, false, { seed, setup: (b) => { holder = b; su(b); } })
      .then((r) => {
        AT.stages[IDX] = orig;
        const x = holder.__ace;
        const ace = x.aces[0];
        const meta = x.acesMeta.get(ace);
        const sum = (f) => x.aces.reduce((s, u) => s + f(u), 0);
        const sumObj = (f) => {
          const o = {};
          for (const u of x.aces) for (const [k, v] of Object.entries(f(u))) o[k] = (o[k] || 0) + v;
          return o;
        };
        rows.push({
          format, variant, seed,
          state: r.state, sec: r.sec,
          blueLost: x.blues.filter((u) => !u.alive).length,
          redLost: x.reds.filter((u) => !u.alive && u.deathCause !== 'withdraw').length,
          aceDied: sum((u) => (!u.alive && u.deathCause !== 'withdraw' ? 1 : 0)),
          aceShots: sum((u) => Object.values(u.__ace.shots).reduce((s, v) => s + v, 0)),
          aceM: sum((u) => u.__ace.shots['AAM-M'] || 0),
          aceHits: sum((u) => u.__ace.hits),
          shotAt: sum((u) => u.__ace.shotAt),
          hitBy: sum((u) => u.__ace.hitBy),
          overSec: sum((u) => u.__ace.overSec),
          trigE: sum((u) => u.__ace.triggers.energy || 0),
          trigO: sum((u) => u.__ace.triggers.outnumbered || 0),
          fireAlt: ace.__ace.fireAlt.map(Math.round),
          fireRange: ace.__ace.fireRange.map((v) => Math.round(v / 100) / 10),
          firstShot: x.firstShot == null ? null : Math.round(x.firstShot),
          inc: ace.__ace.inc,
          mateShots: x.reds[1] ? x.reds[1].__shots || 0 : 0,
          // ---- P/K系の検証・計装 ----
          aceType: ace.typeId || null,
          aceRcs: ace.spec ? (ace.spec.rcs ?? null) : null,
          aceRadarRange: ace.spec ? (ace.spec.radarRange ?? null) : null,
          aceLoadout: ace.baseLoadout ? ace.baseLoadout.slice() : (ace.loadout || []).slice(),
          radarOnFrac: meta && meta.aliveSec > 0 ? +(meta.radarSec / meta.aliveSec).toFixed(3) : null,
          detDist: meta && meta.det ? meta.det.dist : null,
          detVia: meta && meta.det ? meta.det.via : null,
          minRange: meta && isFinite(meta.minRange) ? Math.round(meta.minRange) : null,
          shotsByWeapon: sumObj((u) => u.__ace.shots),
          shotAtByWeapon: sumObj((u) => u.__ace.shotAtByWeapon),
          firstShotAtRange: ace.__ace.firstShotAtRange,
          engageSec: x.firstShot == null ? null : Math.round(r.sec - x.firstShot),
          onToFireSec: ace.__ace.onToFireSec.slice(),
          out: x.out,
          // ---- B系（§2.5 の2）----
          blueArh: [...x.blueArh.values()].map((r) => (r.done ? r.end : 'flying')),
          blueArhRec: [...x.blueArh.values()].map((r) => { const { tg, ...o } = r; return o; }),
          redArhSec: Math.round(x.redArh.sec * 10) / 10,
          redArhCrank: Math.round(x.redArh.crank * 10) / 10,
          redArhNoEvade: Math.round(x.redArh.noEvade * 10) / 10,
        });
      })
      .catch((e) => { AT.stages[IDX] = orig; throw e; });
  }

  async function start(opts = {}) {
    if (state.running) return 'running';
    if (!AT.__aceBase) AT.__aceBase = JSON.parse(JSON.stringify(AT.stages[0]));
    const formats = opts.formats || ['1v1', '2v2'];
    const variants = opts.variants || Object.keys(VARIANTS);
    const seeds = opts.seeds || SEEDS;
    const jobs = [];
    for (const f of formats) for (const v of variants) for (const s of seeds) {
      if (f === '1v1' && v === 'A3b') continue;
      jobs.push([f, v, s]);
    }
    state.total += jobs.length;
    state.running = true;
    state.error = null;
    (async () => {
      try {
        for (const [f, v, s] of jobs) { await runOne(f, v, s); state.done++; }
      } catch (e) { state.error = String(e && e.stack || e); }
      state.running = false;
    })();
    return `started ${jobs.length}`;
  }

  const avg = (a) => (a.length ? +(a.reduce((s, v) => s + v, 0) / a.length).toFixed(2) : null);
  const med = (a) => { if (!a.length) return null; const b = [...a].sort((x, y) => x - y); return b[Math.floor(b.length / 2)]; };
  const sumCnt = (rs, f) => { const o = {}; for (const r of rs) for (const [k, v] of Object.entries(f(r) || {})) o[k] = (o[k] || 0) + v; return o; };

  function report() {
    const g = new Map();
    for (const r of rows) {
      const k = r.format + ' ' + r.variant;
      if (!g.has(k)) g.set(k, []);
      g.get(k).push(r);
    }
    const out = [];
    for (const [k, rs] of g) {
      out.push({
        k, n: rs.length,
        勝: rs.filter((r) => r.state === 'clear').length,
        負: rs.filter((r) => r.state === 'fail').length,
        続: rs.filter((r) => r.state === 'active').length,
        エース被撃墜: avg(rs.map((r) => r.aceDied)),
        自軍損失: avg(rs.map((r) => r.blueLost)),
        敵損失: avg(rs.map((r) => r.redLost)),
        エース発射: avg(rs.map((r) => r.aceShots)),
        エース命中: avg(rs.map((r) => r.aceHits)),
        僚機発射: avg(rs.map((r) => r.mateShots)),
        被発射: avg(rs.map((r) => r.shotAt)),
        被命中: avg(rs.map((r) => r.hitBy)),
        秒中央: med(rs.map((r) => r.sec)),
        交戦秒中央: med(rs.map((r) => r.engageSec).filter((v) => v != null)),
        差込秒: avg(rs.map((r) => r.overSec)),
        離脱E: avg(rs.map((r) => r.trigE)),
        離脱O: avg(rs.map((r) => r.trigO)),
        発射高度差中央: med(rs.flatMap((r) => r.fireAlt)),
        発射距離中央km: med(rs.flatMap((r) => r.fireRange)),
        エース弾種: sumCnt(rs, (r) => r.shotsByWeapon),
        被弾種: sumCnt(rs, (r) => r.shotAtByWeapon),
        自軍初撃距離中央: med(rs.map((r) => r.firstShotAtRange).filter((v) => v != null)),
        'ON→発射秒中央': med(rs.flatMap((r) => r.onToFireSec || [])),
        // ---- K系のみ意味を持つ列（P系・N等は null） ----
        機体: [...new Set(rs.map((r) => r.aceType))],
        レーダー点灯率: avg(rs.map((r) => r.radarOnFrac).filter((v) => v != null)),
        初探知距離中央: med(rs.map((r) => r.detDist).filter((v) => v != null)),
        初探知内訳: sumCnt(rs, (r) => (r.detVia ? { [r.detVia]: 1 } : {})),
        最接近距離中央: med(rs.map((r) => r.minRange).filter((v) => v != null)),
      });
    }
    return out;
  }

  // エースに向かった弾を、何発目かで割って並べる（①′）
  function incoming(format, variant) {
    const g = new Map();
    for (const r of rows) {
      if (r.format !== format || r.variant !== variant) continue;
      for (const m of r.inc || []) {
        const k = m.k >= 3 ? '3+' : String(m.k);
        if (!g.has(k)) g.set(k, []);
        g.get(k).push(m);
      }
    }
    const cnt = (a, f) => { const o = {}; for (const x of a) { const v = f(x); o[v] = (o[v] || 0) + 1; } return o; };
    const out = [];
    for (const [k, ms] of [...g].sort()) {
      out.push({
        k, n: ms.length, 命中: ms.filter((m) => m.hit).length,
        弾: cnt(ms, (m) => m.w), 終わり: cnt(ms, (m) => m.end),
        戦法: cnt(ms, (m) => m.tac || '-'),
        前の弾が飛行中: ms.filter((m) => m.prevAlive).length,
        発射時に回避中: ms.filter((m) => m.busy0).length,
        間隔秒中央: med(ms.filter((m) => m.gap != null).map((m) => m.gap)),
        距離km中央: med(ms.map((m) => m.r0)),
        速度_発射時: med(ms.map((m) => m.v0)), 速度_最低: med(ms.map((m) => m.vmin)), 速度_終わり: med(ms.map((m) => m.v1)),
        高度_発射時: med(ms.map((m) => m.y0)), 高度_終わり: med(ms.map((m) => m.y1)),
        命中の速度_終わり: med(ms.filter((m) => m.hit).map((m) => m.v1)),
        外れの速度_終わり: med(ms.filter((m) => !m.hit).map((m) => m.v1)),
      });
    }
    return out;
  }

  // 同じ種で基準（N）と比べて、自軍の損失とエースの生死がどちらへ動いたか
  function paired(format, variant, baseName = 'N') {
    const base = new Map(rows.filter((r) => r.format === format && r.variant === baseName).map((r) => [r.seed, r]));
    const t = { n: 0, 自軍損失増: 0, 自軍損失減: 0, エース生還化: 0, エース撃墜化: 0, 勝敗反転: 0 };
    for (const r of rows) {
      if (r.format !== format || r.variant !== variant) continue;
      const b = base.get(r.seed);
      if (!b) continue;
      t.n++;
      if (r.blueLost > b.blueLost) t.自軍損失増++;
      if (r.blueLost < b.blueLost) t.自軍損失減++;
      if (r.aceDied < b.aceDied) t.エース生還化++;
      if (r.aceDied > b.aceDied) t.エース撃墜化++;
      if ((r.state === 'clear') !== (b.state === 'clear')) t.勝敗反転++;
    }
    return t;
  }

  // エースが撃った弾を、弾種ごとに割って並べる（§2.4）
  function outgoing(format, variant) {
    const g = new Map();
    for (const r of rows) {
      if (r.format !== format || r.variant !== variant) continue;
      for (const m of r.out || []) {
        if (!g.has(m.w)) g.set(m.w, []);
        g.get(m.w).push(m);
      }
    }
    const cnt = (a, f) => { const o = {}; for (const x of a) { const v = f(x); o[v] = (o[v] || 0) + 1; } return o; };
    const out = [];
    for (const [k, ms] of g) {
      const fin = ms.filter((m) => m.done);
      const mc = fin.reduce((s, m) => s + m.mc, 0), miss = fin.reduce((s, m) => s + m.mcMiss, 0);
      out.push({
        弾: k, n: ms.length, 命中: fin.filter((m) => m.hit).length, 終わり: cnt(fin, (m) => m.end),
        戦法: cnt(fin, (m) => m.tac || '-'),
        発射距離km中央: med(ms.map((m) => m.r0)), 発射高度差中央: med(ms.map((m) => m.dy)),
        シーカー距離km中央: med(fin.filter((m) => m.activeR != null).map((m) => m.activeR)),
        警報あり: fin.filter((m) => m.warnT != null).length,
        警報距離km中央: med(fin.filter((m) => m.warnR != null).map((m) => m.warnR)),
        警報から終わり秒中央: med(fin.filter((m) => m.warnSec != null).map((m) => m.warnSec)),
        保った秒平均: avg(fin.map((m) => m.holdSec)), 回避秒平均: avg(fin.map((m) => m.evSec)),
        妨害最大中央: med(fin.map((m) => m.jam)), 妨害あり: fin.filter((m) => m.jam > 0).length,
        中途の見失い率: mc ? +(miss / mc).toFixed(2) : null,
        チャフ平均: avg(fin.map((m) => m.chaffUsed)),
        終わりAGL中央: med(fin.map((m) => m.agl1).filter((v) => v != null)),
      });
    }
    return out;
  }

  // 自軍の AAM-A が敵に当たる率（§2.5 の2）。B0 と B1 を並べ、同じ種での入れ替わりも出す
  function blueArh(format) {
    const cnt = (a) => { const o = {}; for (const v of a) o[v] = (o[v] || 0) + 1; return o; };
    const out = [];
    for (const v of ['N/B0', 'N/B1', 'N/B1c', 'N/B0x']) {
      const rs = rows.filter((r) => r.format === format && r.variant === v);
      if (!rs.length) continue;
      const ms = rs.flatMap((r) => r.blueArh || []);
      out.push({
        k: format + ' ' + v, n: rs.length,
        勝: rs.filter((r) => r.state === 'clear').length,
        自軍損失: avg(rs.map((r) => r.blueLost)), 敵損失: avg(rs.map((r) => r.redLost)),
        AAMA発射: ms.length, AAMA命中: ms.filter((e) => e === 'hit').length, 終わり: cnt(ms),
        敵がAAMAを筆頭にした秒: +rs.reduce((s, r) => s + r.redArhSec, 0).toFixed(1),
        うちクランク秒: +rs.reduce((s, r) => s + r.redArhCrank, 0).toFixed(1),
        うち回避なし秒: +rs.reduce((s, r) => s + r.redArhNoEvade, 0).toFixed(1),
      });
    }
    const b0 = new Map(rows.filter((r) => r.format === format && r.variant === 'N/B0').map((r) => [r.seed, r]));
    for (const vv of ['N/B1', 'N/B1c', 'N/B0x']) {
    if (!rows.some((r) => r.format === format && r.variant === vv)) continue;
    const t = { n: 0, 命中増: 0, 命中減: 0, 勝敗反転: 0, 全列一致: 0 };
    for (const r of rows) {
      if (r.format !== format || r.variant !== vv) continue;
      const b = b0.get(r.seed);
      if (!b) continue;
      t.n++;
      const h1 = (r.blueArh || []).filter((e) => e === 'hit').length, h0 = (b.blueArh || []).filter((e) => e === 'hit').length;
      if (h1 > h0) t.命中増++;
      if (h1 < h0) t.命中減++;
      if ((r.state === 'clear') !== (b.state === 'clear')) t.勝敗反転++;
      if (r.state === b.state && r.sec === b.sec && r.blueLost === b.blueLost && r.redLost === b.redLost
        && JSON.stringify(r.blueArh) === JSON.stringify(b.blueArh)) t.全列一致++;
    }
    out.push({ k: format + ' 対の比較 ' + vv + '−B0', ...t });
    }
    return out;
  }

  // 自軍の AAM-A の終わり方を割る（§2.5.5）。終わり方ごとに、最接近・終わりの速さ・飛んだ秒・受け手の動きの中央値
  function blueArhEnd(format, variant) {
    const ms = rows.filter((r) => r.format === format && r.variant === variant).flatMap((r) => r.blueArhRec || []);
    const g = new Map();
    for (const m of ms) {
      const k = m.done ? m.why : 'flying';
      if (!g.has(k)) g.set(k, []);
      g.get(k).push(m);
    }
    const out = [];
    for (const [k, a] of g) {
      out.push({
        k: format + ' ' + variant + ' ' + k, n: a.length,
        最接近m中央: med(a.map((m) => m.minDist).filter((v) => v != null)),
        最接近m最小: a.some((m) => m.minDist != null) ? Math.min(...a.map((m) => m.minDist).filter((v) => v != null)) : null,
        終わり速さ比中央: med(a.map((m) => m.vr).filter((v) => v != null)),
        飛行秒中央: med(a.map((m) => m.tof).filter((v) => v != null)),
        発射km中央: med(a.map((m) => m.r0)), 発射高度差中央: med(a.map((m) => m.dy)),
        シーカーkm中央: med(a.map((m) => m.activeR).filter((v) => v != null)),
        発射時に相手が誘導中: a.filter((m) => m.guiding0).length,
        警報秒中央: med(a.map((m) => m.warnSec)), クランク秒中央: med(a.map((m) => m.crankSec)),
        回避秒中央: med(a.map((m) => m.evSec)), 妨害あり: a.filter((m) => m.jam > 0).length,
        妨害最大中央: med(a.map((m) => m.jam)), 相手が先に死亡: a.filter((m) => m.tgDead).length,
      });
    }
    return out;
  }

  window.AT.ace = { start, state, report, paired, incoming, outgoing, blueArh, blueArhEnd, rows, SEEDS, VARIANTS: Object.keys(VARIANTS), runOne };
})();
