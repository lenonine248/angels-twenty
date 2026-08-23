// ミサイルとデコイ。仕様書 §5.0 / §5.4 / §6.2。
//
// ミサイルは実体としてシミュレートする。確率で当否を決めないので、
//   ・急旋回で振り切れる（シーカーの旋回率に上限がある）
//   ・射程ギリギリでは失速して失推する（推進終了後は減速し続ける）
//   ・山陰に入るとシーカーが見失う
//   ・セミアクティブ(AAM-M)は発射機がレーダーで照射し続けないと誘導が切れる
// といった挙動が自然に出る。回避AIもこの実体に対して機動する。

import * as THREE from 'three';
import { clamp } from '../core/rng.js';
import { missileDragFactor, turnFactor } from '../core/atmosphere.js';
import { angleDiff } from './unit.js';

/**
 * 直撃と判定する距離(m)。**目標の大きさを足して使う**（`hitRadii`）。
 *
 * 航空機なら全長15m前後なので、この値そのままでよい。
 * だが地上目標は桁が違う（レーダーサイト220m・飛行場900m）。
 * 中心から25mでしか直撃にしないと、220mの施設のど真ん中に落ちた弾が
 * 「至近弾」に化ける。実測で ARM 2発が命中して 97 ダメージしか出ず、
 * 120HP のレーダーサイトが生き残っていた（直撃なら1発160で落ちる）。
 *
 * 目標の大きさの扱いは、爆風(`_blast`)も機銃(`sim/bullet.js`)も
 * `spec.size * 0.25` で揃えている。ここだけ無視していた。
 */
const DIRECT_HIT = 25;
/** 近接信管の作動半径(m)。同じく目標の大きさを足して使う。 */
const PROXIMITY = 90;
/**
 * 推進終了後の慣性飛行時間(秒)の目安。
 * 減速量はこれを使って設計速度から決める。固定値にすると、
 * 低速な対地ミサイル(320m/s)が数秒で失速して射程の半分も飛べなくなる。
 */
const COAST_TIME = 35;
/**
 * 誘導を失ってから自爆するまで(秒)。
 *
 * 外した弾を寿命いっぱい飛ばし続ける必要は無い。AAM-M なら減速して
 * 寿命判定に掛かるまで**約32秒**あり、その間ずっと明後日の方向へ飛んでいた。
 * 実弾は外れたら自爆するし、残しておく利点も無い。
 */
const LOST_SELF_DESTRUCT = 5;

/**
 * 目標を通り過ぎたと判断するまで（§28.1）。
 *
 * **最接近点を過ぎて離れ始めたら自爆する。** これが無いと、外した弾が
 * 寿命（AAM-M で約103秒）まで目標を追い続け、**その周りを回り始める**。
 *
 * 1フレームの揺れで誤爆しないよう、距離と時間の両方で見る。
 * 加速中は判定しない — 発射直後は母機の速度しか無いので、
 * 逃げる目標に対して**一時的に離される**（それを通過と誤認する）。
 */
const OVERSHOOT_SEC = 0.5;
const OVERSHOOT_MARGIN = 150;

/**
 * ドップラー欺瞞（§35.1）。**ビーム機動・地面クラッター・チャフを一つにまとめた。**
 *
 * 真横を向くと接近速度が消え、レーダーは地面と同じ「動いていないもの」として
 * 捨てる。だから**紛れる先が要る** — 地面か、チャフの雲か。
 * 見上げる形でビームを取っても、背景は空で紛れる先が無い。
 *
 * 低空へ降りるのは、この「紛れる先」を手に入れるため。
 * 代わりに機銃にも対空砲にも無防備になる。
 * **確率が低くても選ぶ価値がある**、という関係にしたい。
 */
const DECEPTION_CHANCE_PER_SEC = 0.9;
/** これだけ見下ろしていれば満額（tan）。0.3 ≒ 17度 */
const LOOKDOWN_FULL = 0.12;
/** 背を向けて逃げていると言える角度（§35.2）。これを超えると雲が視線から外れる */
const SCREEN_TOLERANCE = 35 * (Math.PI / 180);
/** チャフの雲が「背景」として働く半径(m)（§35.2） */
const CHAFF_COVER_RADIUS = 700;
/** 目標の対地高度がこれを超えると、地面には紛れられない(m) */
const CLUTTER_MAX_AGL = 300;
/** ビームと言える角度。真横からこれだけ外れると効かない */
export const NOTCH_TOLERANCE = 20 * (Math.PI / 180);

/**
 * アクティブレーダー弾のシーカーが目標を探し続ける時間(秒)（§28.13）。
 * これを過ぎても視界に何も入らなければ諦める。
 */
const SEEKER_SEARCH_SEC = 6;

/**
 * セミアクティブ弾が照射切れに耐える**合計**時間(秒)（§28.13）。
 * この間は最後に分かっていた場所へ飛ぶ。照射が戻れば誘導を続ける。
 */
const SARH_COAST_SEC = 2;
/**
 * この速度を下回ると失推（設計速度に対する割合）。
 *
 * **0.35 は「回避する目標に追いつけるか」の値**で、空対空弾のためのもの。
 */
const MIN_SPEED_RATIO = 0.35;
/**
 * **動かない目標を狙っているときの下限**（§42.3）。
 *
 * 陣地や施設は逃げないので、遅くなった弾でも届いて当たる。
 * 0.35 のままだと **AGM は表記射程14kmに対して実際には7〜8kmしか届かず**、
 * AI の発射上限（約12.6km）と逆転して「撃てるのに届かない」兵装になっていた
 * — P9 で ARM と AGM が同じ状態になり、一度直したはずの不具合の再発。
 *
 * §42.1 とまったく同じ形の誤り。**「どの誘導方式か」ではなく
 * 「何を狙っているか」で切る。**
 */
const MIN_SPEED_RATIO_GROUND = 0.15;
/**
 * 地上目標に対して**シーカーの視線を要求し始める距離(m)**（§43）。
 * ここより遠いあいだは、座標へ向かって飛んでいるだけとみなす。
 */
const GROUND_LOS_RANGE = 2500;

/**
 * ミサイルのコーナー速度（設計速度に対する割合）（§33.6）。
 *
 * 機体と同じ考え方（§29.2）。これを下回ると**動圧が足りず、
 * 定格のGを引けなくなる**。機体では巡航の6割あたりに置いているが、
 * ミサイルは翼が小さく速度に頼っているので、もっと高いところに置く。
 */
const CORNER_FRACTION = 0.8;

/**
 * 旋回による減速（§33.6）。定格Gいっぱいで曲がっているときに、
 * 1秒あたり設計速度の何割を失うか。
 *
 * 機体には既に誘導抗力がある（`TURN_DRAG`）のに、ミサイルには無かった。
 * **曲げられた弾ほど遅くなる**ようにすると、回避機動そのものが報われる。
 */
const TURN_DRAG = 0.03;

/**
 * 比例航法の航法定数（§34.2）。
 *
 * 指令加速度 = N × 接近速度 × 視線角速度。実機の誘導弾は 3〜5 を使う。
 * **視線角速度がゼロ（＝衝突コースに乗っている）なら舵を切らない**ので、
 * 少ないGで当たる。従来の先行追尾は「目標が直進する前提の未来位置」を
 * 毎フレーム狙い直すので、目標が曲がるたびに狙点が振られて舵を無駄に使っていた。
 */
const NAV_CONSTANT = 3.5;

/**
 * 視線へ寄せる動きに切り替える角度（§34.2）。
 * これより機首が外れているか、離れつつある間は比例航法が成立しない。
 */
const GATHER_ANGLE = 60 * (Math.PI / 180);
/** 誘導に必要な視線を確認する間隔(秒) */
const LOS_INTERVAL = 0.25;
/** ARM が電波を失ったときの慣性誘導の誤差（残距離に対する割合） */
const ARM_MEMORY_ERROR = 0.018;
/** 目標の大きさのうち、爆風判定で「当たり」とみなす割合 */
const SIZE_FOOTPRINT = 0.25;
/**
 * 地上目標へ向かうときに、目標の真上を飛ぶ高さ(m)と、そこから降ろし始める距離(m)。
 *
 * 地上目標は地表そのものにいるので、そこへ真っ直ぐ狙うと**着弾までの数kmを
 * 地面すれすれで飛ぶ**ことになる。目標が斜面の下にあると、あいだの尾根が
 * ちょうど照準線まで迫り上がってきて、途中の起伏に必ず引っかかる。
 * 実測では AGM が目標の 214m 手前で接地し、爆風の届かない距離で消えていた
 * （レーダーサイト 120HP に対し、2発撃って 77 ダメージ）。
 *
 * 終末までは目標の上を狙い、近づいてから落とす。実際の対地ミサイルと同じ挙動で、
 * 途中の地形から離れられるうえ、突っ込む角度も急になって命中が安定する。
 */
const GROUND_APPROACH_ALT = 220;
/** 上を狙うのをやめる距離。ここから内側は目標そのものを狙う */
const GROUND_DIVE_END = 150;
/** ここより遠いあいだは目標の上を飛ぶ */
const GROUND_DIVE_START = 1200;

let nextId = 1;

/** ID を振り直す（`sim/unit.js` の `resetUnitIds` と同じ理由） */
export function resetMissileIds() { nextId = 1; }

export class Missile {
  constructor({ weapon, launcher, target, world }) {
    this.id = nextId++;
    this.weapon = weapon;
    this.side = launcher.side;
    this.launcher = launcher;
    this.target = target;        // 本来の目標
    this.seekTarget = target;    // シーカーが今追っているもの（デコイに移ることがある）

    this.pos = launcher.pos.clone();
    this.prevPos = this.pos.clone();

    // 発射時は母機の速度と向きを引き継ぐ
    const f = launcher.forward();
    this.dir = new THREE.Vector3(f.x, Math.sin(launcher.pitch || 0), f.z).normalize();
    this.speed = launcher.speed || 200;

    this.age = 0;
    this.alive = true;
    this.lost = false;            // 誘導喪失（以後は直進し、少し飛んでから自爆）
    this.lostAt = 0;
    this._minDist = null;         // 目標への最接近距離（§28.1）
    this._openingFor = 0;         // 離れ続けている秒数
    this._decoyTries = 0;         // この弾に対して撒かれたデコイの数（§28.13）
    this._searchSince = null;     // 終末シーカーが探し始めた時刻（§28.13）
    this._coastFor = 0;           // 照射が切れていた合計秒数（§28.13）
    this._turnLoad = 0;           // 直近フレームで引いたGの割合（§33.6）
    this._prevTargetPos = null;   // 比例航法で目標の速度を差分から取るため（§34.2）
    this._prevTargetRef = null;   // その位置を測った相手。入れ替わったら測り直す

    // アクティブレーダー弾の終末誘導（§28.2）。
    // 中途は発射機の索敵レーダーから位置をもらい、**相手に警報は出ない**。
    // 予測位置まで詰めたところでシーカーを入れ、そこで初めて気づかれる。
    this.active = weapon.guidance !== 'arh';   // arh 以外は最初から「見えている」扱い
    /**
     * いま発射機に照らされているか（§37.2）。
     *
     * セミアクティブ誘導が成立している＝**追尾波が出続けている**ということ。
     * 目標の逆探知はそれを聞くので、**距離に関係なく警報が出る**
     * （`sim/combat.js` の `_assignThreats`）。照射が切れれば警報も消える。
     */
    this.painting = weapon.guidance === 'sarh';
    this._midcourseTimer = 0;
    this.lastKnown = target ? target.pos.clone() : this.pos.clone();

    // ロケットモーターは短時間で燃え尽き、以後は慣性で飛ぶ。
    // 射程の限界は「燃焼後にどこまで速度を保てるか」で自然に決まる。
    this.boostTime = clamp((weapon.range * 0.35) / Math.max(1, weapon.speed), 1.5, 20);
    // 高空では抵抗が減って慣性飛行が伸びるため、寿命は余裕をもって取る
    this.lifetime = (weapon.range / Math.max(1, weapon.speed)) * 4 + 30;
    this.accel = (weapon.speed - this.speed) / Math.max(0.5, this.boostTime * 0.6);
    // 慣性飛行の減速。**兵装ごとに変えられる**（§44）。
    // 大型で低速な対地弾は、断面積のわりに重いので慣性が長い。
    this.drag = weapon.speed / (weapon.coastTime ?? COAST_TIME);

    this._losTimer = 0;
    this._losOk = true;
    this.trail = [this.pos.clone()];
  }

  get guidance() { return this.weapon.guidance; }
  get isBomb() { return this.weapon.kind === 'bomb'; }

  update(dt, world) {
    if (!this.alive) return;
    this.age += dt;
    this.prevPos.copy(this.pos);

    if (this.isBomb) this._updateBomb(dt, world);
    else this._updateMissile(dt, world);

    if (!this.alive) return;

    // 軌跡（描画用）
    if (this.trail.length === 0 || this.trail[this.trail.length - 1].distanceTo(this.pos) > 120) {
      this.trail.push(this.pos.clone());
      if (this.trail.length > 40) this.trail.shift();
    }

    this._checkImpact(world);
  }

  // ------------------------------------------------------------ 飛翔

  _updateMissile(dt, world) {
    // 推進 → 慣性
    if (this.age < this.boostTime) {
      this.speed = Math.min(this.weapon.speed, this.speed + this.accel * dt);
    } else {
      // ロケットモーターは空気を必要としないので推力は高度で落ちないが、
      // 慣性飛行中の減速は空気密度に比例する。高空ほど遠くまで届く。
      this.speed = Math.max(0, this.speed - this.drag * missileDragFactor(this.pos.y) * dt);
    }

    // 旋回による減速（§33.6）。**曲げられた弾ほど遅くなる。**
    // 機体には既に誘導抗力があるのに、ミサイルには無かった。
    // これがあると、早くから機動させた弾は終末に着く頃には曲がれなくなる
    // — 回避機動そのものが報われる。推進中は推力が打ち消すので効かせない。
    //
    // **動かない目標には効かせない**（§43）。この項の目的は「回避機動を報いる」
    // ことなので、逃げない陣地を撃つときには意味が無い。
    // 実測では、8,500m から 22km 先の陣地へ降りていく ARM が
    // **旋回負荷 0.5〜1.0 のまま30秒**飛び、抵抗が倍になって
    // 8km 手前で失速していた（本来の飛翔距離は 27km）。
    // 一定の降下角で降りているだけなのに、毎フレーム舵を使い切っている扱いになる。
    if (this.age >= this.boostTime && this._turnLoad > 0 && !this._vsGround()) {
      this.speed = Math.max(0,
        this.speed - this.weapon.speed * TURN_DRAG * this._turnLoad
          * missileDragFactor(this.pos.y) * dt);
    }

    // 失推・寿命切れ。
    // 発射時は母機の速度しか無いので、燃焼が終わるまでは失推判定をしない。
    //
    // **失推の下限は「何を狙っているか」で変わる**（§42.3）。
    // 回避する相手には速度が要るが、動かない陣地には遅い弾でも届く。
    const floor = this._vsGround() ? MIN_SPEED_RATIO_GROUND : MIN_SPEED_RATIO;
    const spent = this.age > this.boostTime
      && this.speed < this.weapon.speed * floor;
    const lostTooLong = this.lost && this.age - this.lostAt > LOST_SELF_DESTRUCT;
    if (spent || lostTooLong || this.age > this.lifetime || this._overshot(dt)) {
      // **力尽きた対地弾は落ちて起爆する**（§43）。
      //
      // 空対空弾は速度を失えば当たらないので消してよいが、対地弾は違う
      // — 弾頭を積んだまま落ちるので、近ければ効く。
      // 実測で **53m 手前で力尽きた AGM が何も起こさずに消えて**いた
      // （爆風は60m あるので、落ちていれば当たっている距離）。
      //
      // 落下の弾道までは追わず、力尽きた地点で起爆させる近似にしてある。
      // 遠くで力尽きた弾は、そこに何も無いので結果的に無害になる。
      if (spent && this.weapon.kind === 'agm') this._blast(world);
      this.destroy(world, 'spent');
      return;
    }

    this._updateGuidance(dt, world);

    if (!this.lost && this.seekTarget) {
      // 動かない目標（地上）は従来の追尾で足りる。進入高度の細工もそちらにある。
      // 動く目標には比例航法を使う（§34.2）
      if (isGroundTarget(this.seekTarget)) {
        this._steerTowards(this._leadPoint(), dt);
      } else {
        this._targetDist = this.pos.distanceTo(this.seekTarget.pos);
        this._guide(dt, this.seekTarget);
      }
    }

    this.pos.addScaledVector(this.dir, this.speed * dt);
  }

  _updateBomb(dt, world) {
    // 無誘導。速度ベクトルを素直に積分して放物線を描く。
    // 空気抵抗は入れない。投下点の計算（sim/combat.js）が解析的な弾道解なので、
    // ここに抵抗を足すと必ず手前に落ちる。
    if (!this.vel) {
      this.vel = this.dir.clone().multiplyScalar(this.speed);
      // 投下高度に比例した散布界。低空ならほぼ命中、高空ではまず当たらない。
      const r = this.bombDispersion || 0;
      if (r > 0) {
        const rnd = () => (world.rng ? world.rng() : Math.random()) - 0.5;
        this.vel.x += rnd() * 2 * r;
        this.vel.z += rnd() * 2 * r;
        this.vel.y += rnd() * r;
      }
    }
    this.vel.y -= 9.8 * dt;
    this.pos.addScaledVector(this.vel, dt);
    this.speed = this.vel.length();
    this.dir.copy(this.vel).normalize();
    if (this.age > 60) this.destroy(world, 'spent');
  }

  /**
   * 視線判定に使う目標点。
   * 地上目標は地表にいるため、その一点を狙うと着弾直前に必ず
   * 「地形に遮られている」と判定されてしまう。少し持ち上げて判定する。
   */
  _losPoint(t) {
    // **`isGroundTarget` と同じ判定を使う**（§42）。
    // 「最後に分かっていた座標」(isPoint) は `kind` を持たないので、
    // ここだけ持ち上げから漏れていた。地表ちょうどの点を視線判定に使うと、
    // 低空から撃ったときに終末で「地形に遮られている」と誤判定する。
    if (isGroundTarget(t)) return _v6.set(t.pos.x, t.pos.y + 40, t.pos.z);
    return t.pos;
  }

  /** 誘導が成立しているかを判定し、切れたら lost にする */
  _updateGuidance(dt, world) {
    const t = this.seekTarget;
    if (!t || t.alive === false) {
      // 静止目標なら最後に分かっていた場所へ突っ込む（実体ではなく座標を狙う）
      if (this.target && this.target.static) {
        this.seekTarget = { pos: this.lastKnown, alive: true, speed: 0, isPoint: true };
      }
      else this._goStupid('目標消失');
      return;
    }
    // セミアクティブは、照射が切れているあいだ目標の位置を知り続けられない。
    // 位置の記憶を更新してよいのは照らせているときだけなので、
    // 他の誘導方式より先にここで見る（§28.13）。
    if (this.guidance === 'sarh') {
      // 発射機がレーダーで照射し続けている必要がある
      const l = this.launcher;
      if (!l || !l.alive) { this.painting = false; this._goStupid('発射機喪失'); return; }
      if (!illuminates(l, this.target, world, true)) {
        this.painting = false;
        // **一瞬切れただけで諦めない**（§28.13）。
        //
        // 実測で AAM-M の失敗理由は照射切れが最も多く（21件中15件）、
        // 切れた瞬間の幾何は**すべて水平40°ちょうど** — ロック扇の縁だった。
        // 撃った本人が回避に入って目標が扇から滑り出る。
        // 「誘導を優先」を全機に強制すると SCRAMBLE は 10/12 → 2/12 に落ちるので、
        // 回避を選ぶ AI の判断は正しい。**扇の縁を出入りするたびに
        // 弾が死ぬ**という作りのほうが行き過ぎている。
        //
        // 数秒のあいだ最後に分かっていた場所へ飛び、その間に照射が戻れば続ける。
        // 戻らなければ諦める。記憶は更新されないので、逃げ続ければ必ず外れる。
        // 猶予は**1発につき合計**で数える。戻っても使った分は返らない。
        // 切れるたびに満額の猶予を与えると、扇を出たり入ったりするだけで
        // いつまでも飛び続ける（撃ちっぱなしと変わらなくなる）。
        this._coastFor += dt;
        if (this._coastFor > SARH_COAST_SEC) { this._goStupid('照射切れ'); return; }
        this.seekTarget = { pos: this.lastKnown, alive: true, speed: 0, isPoint: true };
        return;
      }
      this.painting = true;
      this.seekTarget = this.target;      // 慣性飛行から戻ったら掴み直す
    }

    this.lastKnown.copy(this.seekTarget.pos);

    switch (this.guidance) {
      case 'sarh': break;                 // 上で見た
      case 'arh': {
        // 終末に入っていれば、掴んだ目標をそのまま追う（下の共通処理へ）
        if (this.active) break;
        this._midcourse(dt, world);
        return;
      }
      case 'arm': {
        // 目標が電波を止めたら誘導が切れる。ただし完全に諦めるのではなく、
        // 最後に捉えた放射源の位置へ慣性で向かう（_armMemory）。
        if (!this.target.emitting) { this._armMemory(world); return; }
        break;
      }
      default: break;
    }

    // ノッチ（§28.5）と地面クラッター（§28.6）。どちらも真横を向くのが条件。
    if (this._deceived(dt, world, t)) { this._goStupid('ビーム欺瞞'); return; }
    if (this._screened(dt, world, t)) { this._goStupid('チャフ遮蔽'); return; }

    // シーカーの視線（地形に遮られたら見失う）。
    //
    // **動かない目標に対しては終末だけ見る**（§43）。
    // 座標へ飛ぶ撃ちっぱなしの弾は、途中に丘があっても失探しない
    // — 見えている必要があるのは、シーカーが掴みにいく最後の数kmだけ。
    // 終始要求していたため、**AGM は低空から撃つと発射直後に視線が切れて
    // 1.4km 先で自爆**していた（実測で 12発中12発）。
    //
    // 途中の地形を無視しても山を抜けられるわけではない。
    // 高度が地表を割れば `_checkImpact` が地形との衝突として処理する。
    if (!this._vsGround() || this.pos.distanceTo(t.pos) < GROUND_LOS_RANGE) {
      this._losTimer -= dt;
      if (this._losTimer <= 0) {
        this._losTimer = LOS_INTERVAL;
        this._losOk = world.terrain.hasLineOfSight(this.pos, this._losPoint(t), 6, 200);
      }
      if (!this._losOk) this._goStupid('地形遮蔽');
    } else {
      this._losOk = true;
    }
  }

  /**
   * **動かない目標を撃っているか**（§43）。
   *
   * 判定は `seekTarget` ではなく**本当の目標**で行う。
   * `isPoint`（最後に分かっていた座標）は
   * **照射切れ中のセミアクティブ弾が航空機に対しても作る**ので、
   * そちらで見ると対地用の緩和が空対空へ漏れる
   * — 実際に漏らして、護衛の損失が 1.61 → 1.94 に動いた。
   */
  _vsGround() {
    return isGroundTarget(this.target || this.seekTarget);
  }

  /**
   * 目標を通り過ぎたか（§28.1）。
   *
   * 最接近距離を覚えておき、そこから `OVERSHOOT_MARGIN` 以上離れた状態が
   * `OVERSHOOT_SEC` 続いたら通過とみなす。
   */
  _overshot(dt) {
    if (this.age < this.boostTime) return false;      // 加速中は判定しない
    const t = this.seekTarget && this.seekTarget.pos ? this.seekTarget : this.target;
    if (!t || !t.pos) return false;
    const d = this.pos.distanceTo(t.pos);
    if (this._minDist == null || d < this._minDist) {
      this._minDist = d;
      this._openingFor = 0;
      return false;
    }
    if (d > this._minDist + OVERSHOOT_MARGIN) this._openingFor += dt;
    else this._openingFor = 0;
    return this._openingFor >= OVERSHOOT_SEC;
  }

  /**
   * アクティブレーダー弾の中途誘導（§28.2）。
   *
   * 発射機の**索敵レーダー**（ロックではない）から、粗い間隔で位置をもらう。
   * 更新が粗いぶん予測位置がずれるので、**ノッチとドラッグが効く**。
   *
   * 発射機が黙る・死ぬ・扇から外れると、もらった最後の位置へ飛ぶ。
   * つまり**空に向かって飛ぶ**ことがある。撃ちっぱなしの弾に初めて弱点ができる。
   */
  _midcourse(dt, world) {
    const w = this.weapon;

    // 発射機が見えている間だけ位置を更新する（間隔は粗く）
    this._midcourseTimer -= dt;
    if (this._midcourseTimer <= 0) {
      this._midcourseTimer = w.midcourseInterval || 2;
      const l = this.launcher;
      if (l && l.alive && this.target && this.target.alive
          && illuminates(l, this.target, world)) {
        this.lastKnown.copy(this.target.pos);
      }
    }

    // 予測位置まで詰めたらシーカーを入れる
    if (this.pos.distanceTo(this.lastKnown) <= (w.activeRange || 10000)) {
      this._goActive(world);
      return;
    }
    // まだ中途。記憶した位置へ向かう
    this.seekTarget = { pos: this.lastKnown, alive: true, speed: 0, isPoint: true };
  }

  /**
   * シーカーを入れる。予測位置に最も近い**敵機**を掴む。
   *
   * 味方は掴まない。いまの AI は射線に味方が居るかを見ないので、
   * 含めると自軍を撃ち続けることになる（§28.2）。
   *
   * **掴めるまで探し続ける**（§28.13）。1回の走査で視界に何も無くても、
   * そこで諦めるのは早い。実測では AAM-A の**発射6発すべて**が
   * 「終末で捕捉できず」で失われていた。原因は幾何で、
   * `activeRange`(10km) をわずかに超える 10.1km から撃つと
   * **発射 0.5 秒でシーカーが入る**。そのとき弾はまだ発射機の機首方向を
   * 向いていて（ロックは ±40° まで許されるので目標は最大でそれだけ外れる）、
   * 視界 ±30° に目標が入っていない。旋回して機首が向いた頃には
   * とっくに誘導喪失している。
   *
   * 探し続ける間は中途誘導のまま、記憶した位置へ飛ぶ。
   * `SEEKER_SEARCH_SEC` を過ぎても掴めなければ諦める
   * — **空に向かって飛ぶ**という撃ちっぱなしの弱点は残す。
   */
  _goActive(world) {
    const w = this.weapon;
    const fov = (w.seekerFov || 30) * (Math.PI / 180);
    const reach = w.seekerRange || 12000;

    let best = null;
    let bestD = Infinity;
    for (const u of world.units) {
      if (!u.alive || u.kind !== 'aircraft' || u.onGround) continue;
      if (u.side === this.side) continue;                 // 味方は掴まない
      const d = this.pos.distanceTo(u.pos);
      if (d > reach) continue;
      // シーカーの視界内か（弾の向きから測る）
      const to = _v7.copy(u.pos).sub(this.pos).normalize();
      if (this.dir.angleTo(to) > fov) continue;
      // 予測位置に最も近いものを選ぶ
      const score = u.pos.distanceTo(this.lastKnown);
      if (score < bestD) { bestD = score; best = u; }
    }

    if (!best) {
      if (this._searchSince == null) this._searchSince = this.age;
      if (this.age - this._searchSince > SEEKER_SEARCH_SEC) {
        this._goStupid('終末で捕捉できず');
        return;
      }
      // まだ探す。記憶した位置へ向かい続ける
      this.seekTarget = { pos: this.lastKnown, alive: true, speed: 0, isPoint: true };
      return;
    }
    this.active = true;
    this.target = best;
    this.seekTarget = best;
    this._minDist = null;            // 掴み直したので最接近の記録も入れ替える
    this._openingFor = 0;
    world.onMissileActive?.(this, best);
  }

  /**
   * ドップラー欺瞞（§35.1）。**ノッチと地面クラッターを一つの理屈にまとめた。**
   *
   * 照射源に対して真横を向くと接近速度が消え、レーダーは「動いていないもの」
   * として捨てる。**ただしそれは、背景に「動いていないもの」がある場合だけ。**
   * 見上げる形でビームを取っても、背景は空で紛れる先が無い。
   *
   * 3つが同時に要る。
   *
   * | | 何を見るか |
   * |---|---|
   * | ビーム | 照射源に対して真横を向いているか |
   * | 見下ろし | 照射源が目標を**見下ろしている**か。見上げていれば成立しない |
   * | 背景 | 地面が近いか、チャフの雲があるか |
   *
   * 以前は「ノッチ（10%/秒・無条件）」と「地面クラッター（8%/秒・低空限定）」に
   * 分かれていて、**高高度で見上げながらのビームでも追尾が切れていた**。
   * 低空へ降りる意味も、クラッター側だけの話になっていた。
   *
   * 見るのは**照射しているもの**。セミアクティブなら発射機、
   * アクティブの終末なら弾自身。赤外線には効かない。
   */
  _deceived(dt, world, t) {
    if (this.guidance !== 'sarh' && this.guidance !== 'arh'
        && this.guidance !== 'command') return false;
    // **地上・水上目標は欺瞞しない**（§42）。
    //
    // ドップラー欺瞞は「動いている目標が、真横を向いて接近速度を消し、
    // 地面と同じ“動かないもの”に紛れる」という仕組み。
    // **最初から動かないものには意味が無い。**
    //
    // ところが地上目標では3条件がすべて自動的に成立していた —
    // 見下ろしは機体が必ず上にいるので常に真、紛れる背景は対地高度0なので常に満額、
    // ビームは `heading` が固定値0のまま**進入方位だけで決まって**いた。
    // その結果、AGM（`command`）は進入方向が帯に入ると **0.9/秒で誘導を失い**、
    // 目標のはるか手前で自爆していた（実測: 9km から撃って 3km 先で喪失）。
    if (isGroundTarget(t)) return false;
    if (!t.heading && t.heading !== 0) return false;

    let src = null;
    if (this.guidance === 'sarh' || this.guidance === 'command') src = this.launcher;
    else src = this.active ? this : this.launcher;
    if (!src || src.alive === false || !src.pos) return false;

    // 1. ビーム。真横ほど強い
    const dx = t.pos.x - src.pos.x, dz = t.pos.z - src.pos.z;
    const flat = Math.hypot(dx, dz);
    const los = Math.atan2(dx, -dz);
    const off = Math.abs(Math.abs(angleDiff(los, t.heading)) - Math.PI / 2);
    if (off > NOTCH_TOLERANCE) return false;
    const beam = 1 - off / NOTCH_TOLERANCE;

    // 2. 見下ろし。**見上げている間は成立しない**
    const depression = (src.pos.y - t.pos.y) / Math.max(1, flat);
    if (depression <= 0) return false;
    const look = clamp(depression / LOOKDOWN_FULL, 0, 1);

    // 3. 紛れる背景。地面か、チャフの雲か（§35.2）
    const ground = Math.max(0, world.terrain.heightAt(t.pos.x, t.pos.z));
    const byGround = clamp(1 - (t.pos.y - ground) / CLUTTER_MAX_AGL, 0, 1);
    const cover = clamp(byGround + chaffCover(world, t), 0, 1);
    if (cover <= 0) return false;

    const rng = world.rng ? world.rng() : Math.random();
    return rng < DECEPTION_CHANCE_PER_SEC * beam * look * cover * dt;
  }

  /**
   * チャフの壁で見失うか（§35.2）。
   *
   * **背を向けて逃げるとき、撒いたチャフは追う側との間に残る。**
   * 電波を通さない雲が視線上に立つので、レーダーは目標を掴めなくなる。
   * こちらはビームでも見下ろし角でもなく、**遮蔽**そのもの。
   *
   * 逃げる向きが視線と揃っているほど強い。真横に逃げれば雲は視線から外れる
   * （そちらは上の `_deceived` のドップラー欺瞞が引き受ける）。
   */
  _screened(dt, world, t) {
    if (this.guidance !== 'sarh' && this.guidance !== 'arh'
        && this.guidance !== 'command') return false;
    // 地上・水上目標はチャフを撒かないので元から成立しないが、
    // `_deceived` と同じ理由で明示的に外す（§42）。
    if (isGroundTarget(t)) return false;
    if (!t.heading && t.heading !== 0) return false;
    let src = null;
    if (this.guidance === 'sarh' || this.guidance === 'command') src = this.launcher;
    else src = this.active ? this : this.launcher;
    if (!src || src.alive === false || !src.pos) return false;

    const cover = chaffCover(world, t);
    if (cover <= 0) return false;

    // 照射源から見た視線と、目標の進む向きが揃っているか（＝背を向けて逃げている）
    const los = Math.atan2(t.pos.x - src.pos.x, -(t.pos.z - src.pos.z));
    const away = Math.abs(angleDiff(los, t.heading));
    if (away > SCREEN_TOLERANCE) return false;
    const align = 1 - away / SCREEN_TOLERANCE;

    const rng = world.rng ? world.rng() : Math.random();
    return rng < DECEPTION_CHANCE_PER_SEC * align * cover * dt;
  }

  _goStupid(reason = '?') {
    if (this.lost) return;
    this.lost = true;
    this.lostReason = reason;      // 何で切れたか（較正で内訳を割るため）
    this.lostAt = this.age;
    this.seekTarget = null;
  }

  /**
   * ARM の慣性記憶。
   *
   * 「沈黙されたら必ず外れる」にすると、SAM は ARM に気づいてから
   * 2.5秒で沈黙できるので、ARM は理屈のうえで一度も当たらない兵装になる。
   * 逆に「最後の座標へ必ず当たる」にすると相手は静止目標なので沈黙が無意味になる。
   *
   * そこで、電波が消えた時点の残距離に比例した誤差を持つ座標へ向かわせる。
   * 早く沈黙すれば外れ、気づくのが遅れれば食らう——という駆け引きになる。
   */
  _armMemory(world) {
    if (this.seekTarget && this.seekTarget.isPoint) return;    // すでに記憶飛行中
    const dist = this.pos.distanceTo(this.lastKnown);
    const err = clamp(dist * ARM_MEMORY_ERROR, 12, 500);
    const rnd = () => ((world.rng ? world.rng() : Math.random()) - 0.5) * 2;
    this.seekTarget = {
      pos: new THREE.Vector3(
        this.lastKnown.x + rnd() * err,
        this.lastKnown.y,
        this.lastKnown.z + rnd() * err,
      ),
      alive: true, speed: 0, isPoint: true,
    };
  }

  /**
   * 会合点（目標の未来位置）を反復して求める。
   * 一回だけの見積もりだと終末で毎回ずれて至近弾ばかりになるため、
   * 「予測位置までの飛翔時間」を3回収束させる。
   */
  _leadPoint() {
    const t = this.seekTarget;
    this._targetDist = this.pos.distanceTo(t.pos);

    const aim = _v2.copy(t.pos);

    // 地上目標は上から降ろす（GROUND_APPROACH_ALT）。
    // 命中判定は本物の座標(t.pos)で行うので、狙点をずらしても当たり判定は変わらない。
    if (isGroundTarget(t)) {
      // 終末は狙点を目標そのものへ戻す。最後まで上を狙い続けると、
      // 追尾の遅れのぶんだけ高いまま通り過ぎて至近弾になる（実測で 42m 上を通過）。
      aim.y += GROUND_APPROACH_ALT * clamp(
        (this._targetDist - GROUND_DIVE_END) / (GROUND_DIVE_START - GROUND_DIVE_END), 0, 1);
    }

    if (!t.forward || !t.speed) return aim;

    const f = t.forward(_v3);
    let tof = this._targetDist / Math.max(50, this.speed);
    for (let i = 0; i < 3; i++) {
      aim.set(t.pos.x + f.x * t.speed * tof, t.pos.y, t.pos.z + f.z * t.speed * tof);
      tof = this.pos.distanceTo(aim) / Math.max(50, this.speed);
    }
    return aim;
  }

  /**
   * その速度・高度で引ける角速度(rad/s)（§33.6）。
   *
   * **機体と同じ形にしてある**（§29.2 の `effectiveTurnRate`）。
   * 以前は `turnRate`(deg/s) を固定値として持ち、速度比と
   * 「終末は2.4倍」という補正を掛けていた。測ると、
   * **20km 飛んで最も消耗した弾でも終末で 40.9°/s** 出ていて、
   * これは設計値 28°/s より速かった（§33.3）。
   * 結果、振り切れる境目が**発射距離にまったく依存しなかった**。
   *
   * 2本の限界の小さいほうを取る。
   *
   * | 限界 | 何で決まるか | 形 |
   * |---|---|---|
   * | 構造 | 機体強度＝**最大G** | ω = nG / V（速いほど角速度は小さい） |
   * | 空力 | 動圧＝ρV²。使えるGがこれに比例 | ω ∝ ρ^0.5 · V（遅いと引けない） |
   *
   * 2本はコーナー速度で交わる。ここが最も曲がれる点で、
   * **そこを下回ると急速に鈍る** — 長く飛んで速度を失った弾は曲がれない。
   */
  turnRateAt(speed) {
    const g = 9.81;
    const w = this.weapon;
    const vd = Math.max(1, w.speed);
    const v = Math.max(60, speed);
    const vc = vd * (w.cornerFraction ?? CORNER_FRACTION);
    // `maxG` を持たない兵装（対地弾）は、設計速度での `turnRate` から逆算する。
    // 動かない目標を撃つので、ここが効く場面はそもそも無い
    const maxG = w.maxG ?? (w.turnRate * (Math.PI / 180) * vd) / g;
    const base = (maxG * g) / vd;                    // 設計速度での角速度(rad/s)
    const structural = base * (vd / v);
    const aero = base * (vd / (vc * vc)) * turnFactor(this.pos.y) * v;
    return Math.min(structural, aero);
  }

  /**
   * 比例航法（§34.2）。
   *
   * **指令加速度 = N × 接近速度 × 視線角速度**、向きは視線に垂直。
   * 視線角速度がゼロ＝衝突コースに乗っているときは舵を切らないので、
   * 少ないGで当たる。これが無いと、実機どおりのG（20〜30）では当たらない。
   *
   * 従来は「目標が直進する前提の未来位置」を毎フレーム狙い直していた。
   * 目標が曲がるたびに狙点が振られ、舵を無駄に使って速度を捨てていた。
   *
   * 発射直後に機首が目標から外れていても、そのぶん視線角速度が大きく出るので
   * 同じ式で寄っていく。掴み直しのための別の場合分けは要らない。
   */
  _guide(dt, t) {
    const r = _v4.copy(t.pos).sub(this.pos);
    const dist = r.length();
    if (dist < 1 || dt <= 0) return;
    const rHat = _v5.copy(r).divideScalar(dist);

    // 目標の速度は位置の差分から取る。機体・デコイ・座標のどれでも同じ扱いになる。
    //
    // **誘導対象が入れ替わったら測り直す。** デコイに移った・掴み直した・
    // 照射が切れて座標を追い始めた、のいずれでも前の目標の位置が残っていると、
    // 1フレームだけ**とんでもない速度**が出て弾が明後日へ飛ぶ。
    const tv = _v6.set(0, 0, 0);
    if (this._prevTargetRef === t && this._prevTargetPos) {
      tv.copy(t.pos).sub(this._prevTargetPos).divideScalar(dt);
    }
    if (!this._prevTargetPos) this._prevTargetPos = new THREE.Vector3();
    this._prevTargetPos.copy(t.pos);
    this._prevTargetRef = t;

    const mv = _v7.copy(this.dir).multiplyScalar(this.speed);   // 自分の速度
    const vRel = _v8.copy(tv).sub(mv);

    // 視線角速度ベクトル ω = (r × vRel) / |r|²
    const omega = _v9.copy(r).cross(vRel).divideScalar(dist * dist);
    const vc = -vRel.dot(rHat);            // 接近速度

    // **比例航法は「近づいている」ことを前提にした式**なので、
    // 機首が目標から大きく外れている間は成立しない（指令がゼロになって向き直れない）。
    // 発射直後に視線へ寄せる動きは、実機でも誘導とは別に行う。
    const off = this.dir.angleTo(rHat);
    if (vc <= 0 || off > GATHER_ANGLE) {
      const maxTurn = this.turnRateAt(this.speed) * dt;
      if (off > 1e-6) {
        const axis = _v10.crossVectors(this.dir, rHat).normalize();
        this.dir.applyAxisAngle(axis, Math.min(off, maxTurn)).normalize();
      }
      this._turnLoad = 1;
      return;
    }

    // 指令加速度 a = N · vc · (ω × r̂)
    const aCmd = _v10.copy(omega).cross(rHat).multiplyScalar(NAV_CONSTANT * vc);

    // 引ける横加速度の上限は ω_max × V（最大Gと動圧から決まる・§33.6）
    const maxA = this.turnRateAt(this.speed) * this.speed;
    const mag = aCmd.length();
    this._turnLoad = maxA > 0 ? clamp(mag / maxA, 0, 1) : 0;
    if (mag > maxA && mag > 1e-6) aCmd.multiplyScalar(maxA / mag);

    // 速度ベクトルを曲げる
    mv.addScaledVector(aCmd, dt);
    this.dir.copy(mv).normalize();
  }

  /** 旋回率の上限内で目標方向へ向きを寄せる（動かない目標用） */
  _steerTowards(aim, dt) {
    const desired = _v4.copy(aim).sub(this.pos).normalize();
    const angle = this.dir.angleTo(desired);
    if (angle < 1e-4) return;

    const omega = this.turnRateAt(this.speed);
    const maxTurn = omega * dt;

    if (angle <= maxTurn) {
      this.dir.copy(desired);
      this._turnLoad = angle / Math.max(1e-6, maxTurn);
    } else {
      const axis = _v5.crossVectors(this.dir, desired).normalize();
      this.dir.applyAxisAngle(axis, maxTurn).normalize();
      this._turnLoad = 1;                            // 目一杯引いている
    }
  }

  // ------------------------------------------------------------ 命中判定

  _checkImpact(world) {
    // 目標判定を地形判定より先に行う。
    // 地上目標は地表にいるため、順序が逆だと着弾直前に必ず地面と判定されてしまう。
    if (this._checkTargetImpact(world)) return;

    // 地形
    const ground = Math.max(0, world.terrain.heightAt(this.pos.x, this.pos.z));
    if (this.pos.y <= ground) {
      this.pos.y = ground;
      this._blast(world);
      this.destroy(world, 'ground');
    }
  }

  _checkTargetImpact(world) {
    // 移動区間と目標の最接近で判定する（1フレーム29m進むのですり抜け防止が要る）。
    //
    // 注意: 単に「近接信管圏に入ったら起爆」にすると、接近中の最初のフレーム
    // （＝ちょうど信管半径の距離）で必ず起爆してしまい、永遠に至近弾になる。
    // 最接近点を通過した(seg.t < 1)ときに、その最接近距離で判定する。
    const t = this.seekTarget && this.seekTarget.pos ? this.seekTarget : this.target;
    if (!t || t.alive === false) return false;
    const seg = closestApproach(t.pos, this.prevPos, this.pos);
    const d = seg.dist;
    const [direct, prox] = hitRadii(t);
    if (d > prox) return false;
    const passed = seg.t < 0.999;
    if (!passed && d > direct) return false;          // まだ近づいている最中

    // デコイに当たった場合は消えるだけ
    if (t.isDecoy) { this.destroy(world, 'decoy'); return true; }

    // 実体ではなく「最後に分かっていた座標」を狙っている場合は爆発だけ起こす
    if (t.isPoint) {
      this._blast(world);
      this.destroy(world, 'hit');
      return true;
    }

    const rng = world.rng;
    if (d <= direct) {
      t.damage(this.weapon.damage, this);
    } else {
      // かすり被弾。生き残ることがある。
      t.damage(40 + rng() * 30, this);
    }
    world.onMissileHit?.(this, t, d);
    this.destroy(world, 'hit');
    return true;
  }

  /**
   * 爆弾・対地ミサイルの爆風（範囲ダメージ）。
   *
   * 距離は目標の大きさを差し引いて測る。中心からの距離だけで減衰させると、
   * 全長900mの飛行場に100m外れただけの爆弾がほとんど効かない、という
   * 実態と合わない結果になる（爆撃機が飛行場を壊せない原因だった）。
   */
  _blast(world) {
    const radius = this.weapon.blastRadius;
    if (!radius) return;
    for (const u of world.units) {
      if (!u.alive || u.side === this.side) continue;
      if (u.kind === 'aircraft') continue;
      const footprint = (u.spec && u.spec.size ? u.spec.size : 0) * SIZE_FOOTPRINT;
      const d = Math.max(0, u.pos.distanceTo(this.pos) - footprint);
      if (d > radius) continue;
      u.damage(this.weapon.damage * (1 - d / radius), this);
    }
  }

  destroy(world, reason) {
    if (!this.alive) return;
    this.alive = false;
    this.endReason = reason;
    // 地表付近での炸裂は衝撃波と土煙を伴う演出にする
    const ground = world.terrain
      && this.pos.y - Math.max(0, world.terrain.heightAt(this.pos.x, this.pos.z)) < 70;
    world.effects?.explosion(this.pos, reason === 'hit' ? 260 : 140, ground ? 'ground' : 'air');
  }
}

/**
 * その目標の [直撃半径, 近接信管半径]。
 * 大きな施設ほど「当たった」と言える範囲が広い。
 */
function hitRadii(t) {
  const size = t.spec && t.spec.size ? t.spec.size : 0;
  const footprint = t.kind === 'aircraft' ? 0 : size * SIZE_FOOTPRINT;
  return [DIRECT_HIT + footprint, PROXIMITY + footprint];
}

/**
 * 地表にいる目標か。
 * 「最後に分かっていた座標」(isPoint) は静止した地上目標のためだけに作られるので、
 * これも地上として扱う。
 */
function isGroundTarget(t) {
  if (t.isPoint) return true;
  return !!t.kind && t.kind !== 'aircraft';
}

/** 発射機が目標をレーダーで照射し続けているか（セミアクティブ誘導の条件） */
/**
 * @param {boolean} lock ロック（STT）として見るか（§28.7）。
 *   セミアクティブの誘導は**ロックの扇**（狭い）で見る。
 *   アクティブの中途誘導は**索敵の扇**（広い）で見る — こちらは
 *   ロックしていないからこそ相手に警報が出ない（§28.2）。
 */
function illuminates(launcher, target, world, lock = false) {
  if (!launcher.spec || !target) return false;

  // 地上発射（SAM）は全方位レーダー。沈黙すれば誘導が切れる。
  if (launcher.kind !== 'aircraft') {
    if (!launcher.radarRange) return false;
    if (launcher.pos.distanceTo(target.pos) > launcher.radarRange) return false;
    return world.terrain.hasLineOfSight(launcher.pos, target.pos, 8, 400);
  }

  const dx = target.pos.x - launcher.pos.x;
  const dz = target.pos.z - launcher.pos.z;
  const dy = target.pos.y - launcher.pos.y;
  const flat = Math.hypot(dx, dz);
  const dist = Math.hypot(flat, dy);
  // 切っていれば誘導できない（§26.4）
  if (dist > (launcher.radarRange || 0)) return false;

  if (!launcher.spec.omniRadar) {
    const bearing = Math.atan2(dx, -dz);
    let diff = bearing - launcher.heading;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    const fovH = lock
      ? (launcher.spec.radarLockFovH ?? launcher.spec.radarFovH ?? 60)
      : (launcher.spec.radarFovH || 60);
    const fovV = lock
      ? (launcher.spec.radarLockFovV ?? launcher.spec.radarFovV ?? 30)
      : (launcher.spec.radarFovV || 30);
    if (Math.abs(diff) > fovH * (Math.PI / 180)) return false;
    if (Math.abs(Math.atan2(dy, Math.max(1, flat))) > fovV * (Math.PI / 180)) return false;
  }
  return world.terrain.hasLineOfSight(launcher.pos, target.pos, 8, 400);
}

// ---------------------------------------------------------------- デコイ

/**
 * 目標の周りにあるチャフの濃さ（0〜1）（§35.2）。
 *
 * チャフは**電波を通さない雲**。ミサイルから見て目標と重なる位置にあれば、
 * 地面と同じ「動かない背景」になり、真横を向いた機体はそこへ紛れる。
 * 高空には地面が無いので、**チャフが唯一の紛れる先**になる。
 */
function chaffCover(world, t) {
  const list = world.decoys;
  if (!list || !list.length) return 0;
  let n = 0;
  for (const d of list) {
    if (!d.alive || d.kind !== 'chaff' || d.side !== t.side) continue;
    if (d.pos.distanceTo(t.pos) <= CHAFF_COVER_RADIUS) n++;
  }
  // 1発でほぼ満額。数は「どれだけ長く覆えるか」で効く
  return n ? clamp(0.7 + 0.15 * (n - 1), 0, 1) : 0;
}

let decoyId = 1;

/** フレア／チャフ。ミサイルのシーカーを引き付ける囮。 */
export class Decoy {
  constructor({ kind, pos, vel, side }) {
    this.id = decoyId++;
    this.isDecoy = true;
    this.kind = kind;             // 'flare' | 'chaff'
    this.side = side;
    this.pos = pos.clone();
    this.vel = vel.clone();
    this.life = 6;
    this.alive = true;
    this.speed = 0;
  }

  update(dt) {
    this.pos.addScaledVector(this.vel, dt);
    this.vel.multiplyScalar(1 - 1.2 * dt);
    this.vel.y -= 6 * dt;
    this.life -= dt;
    if (this.life <= 0) this.alive = false;
  }

  damage() { /* デコイは撃破されない */ }
}

/** 誘導方式とデコイ種別の相性 */
export function decoyMatches(guidance, kind) {
  if (kind === 'flare') return guidance === 'ir';
  if (kind === 'chaff') return guidance === 'sarh' || guidance === 'arh';
  return false;
}

// ---------------------------------------------------------------- 補助

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _v5 = new THREE.Vector3();
const _v6 = new THREE.Vector3();
const _v7 = new THREE.Vector3();
const _v8 = new THREE.Vector3();
const _v9 = new THREE.Vector3();
const _v10 = new THREE.Vector3();
const _sa = new THREE.Vector3();
const _sb = new THREE.Vector3();

/** 点と線分の最接近。dist=距離, t=線分上の位置(0..1) */
function closestApproach(p, a, b) {
  _sa.copy(b).sub(a);
  const len2 = _sa.lengthSq();
  if (len2 < 1e-6) return { dist: p.distanceTo(a), t: 1 };
  _sb.copy(p).sub(a);
  const t = clamp(_sb.dot(_sa) / len2, 0, 1);
  _sa.multiplyScalar(t).add(a);
  return { dist: p.distanceTo(_sa), t };
}
