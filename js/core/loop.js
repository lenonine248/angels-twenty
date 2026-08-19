// 固定タイムステップのゲームループ。
// 「リアルタイム進行だが任意で一時停止・倍速できる」という要件の中核。
//
// - シミュレーションは常に FIXED_DT (1/30秒) 刻みで進む → 再現性が保てる
// - 倍速は「1フレームあたりのステップ回数」を増やして実現する
// - 一時停止中もレンダリングは回る（カメラは動かせる／指示は出せる）

export const FIXED_DT = 1 / 30;

/**
 * 選べる倍率。
 * 固定タイムステップなので、倍率を上げても1ステップの刻みは 1/30秒 のまま。
 * 変わるのは「1フレームで何ステップ進めるか」だけで、物理の精度は落ちない。
 * x8 は補給待ちや進出中の待ち時間を飛ばすためのもの。
 */
export const SPEED_STEPS = [1, 2, 4, 8];

/**
 * 1フレームで固定更新に使ってよい実時間(ms)。
 *
 * 以前は「1フレーム最大12ステップ」という固定回数で頭打ちにしていたが、
 * それだと倍速が上がるほど足りなくなる。x4 では realDt が 0.1秒 を超えた時点で
 * 必要ステップ数が12を超え、超過分を捨てるので**実効速度が落ちたまま戻らない**。
 * 「4倍速にしたのに等速になる」のはこれで起きうる。
 *
 * 回数ではなく時間で区切れば、速い環境では捨てずに済み、
 * 遅い環境でもフレームが延びすぎない（スパイラルもしない）。
 */
const STEP_BUDGET_MS = 10;
/** それでも念のための回数上限（無限ループ防止） */
const MAX_STEPS_PER_FRAME = 60;

export class GameLoop {
  /**
   * @param {(dt:number)=>void} onFixedUpdate シミュレーション1ステップ
   * @param {(alpha:number, realDt:number)=>void} onRender 描画（alpha=補間係数）
   */
  constructor(onFixedUpdate, onRender) {
    this.onFixedUpdate = onFixedUpdate;
    this.onRender = onRender;

    this.speed = 1;          // 0 = 一時停止, 1 / 2 / 4
    this.lastSpeed = 1;      // 一時停止解除時に戻す速度
    this.simTime = 0;        // ミッション経過時間（秒）
    this.running = false;

    this._accum = 0;
    this._lastTs = 0;
    this._rafId = 0;

    // 実測FPS
    this.fps = 0;
    this._fpsAccum = 0;
    this._fpsFrames = 0;

    /** 実際に出ている倍率。要求(speed)より低ければ処理が追いついていない。 */
    this.effectiveSpeed = 1;
    this._rateWall = 0;
    this._rateSim = 0;
    this._starved = false;

    this._tick = this._tick.bind(this);
  }

  start() {
    if (this.running) return;
    this.running = true;
    this._lastTs = performance.now();
    this._rafId = requestAnimationFrame(this._tick);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this._rafId);
  }

  get paused() { return this.speed === 0; }

  setSpeed(s) {
    if (s > 0) this.lastSpeed = s;
    this.speed = s;
  }

  togglePause() {
    this.setSpeed(this.paused ? this.lastSpeed : 0);
  }

  /** [ ] キー用: 速度を一段ずつ変える */
  stepSpeed(dir) {
    const steps = SPEED_STEPS;
    if (this.paused) {
      if (dir > 0) this.setSpeed(steps[0]);
      return;
    }
    const i = steps.indexOf(this.speed);
    const ni = Math.min(steps.length - 1, Math.max(0, i + dir));
    this.setSpeed(steps[ni]);
  }

  _tick(ts) {
    if (!this.running) return;
    this._rafId = requestAnimationFrame(this._tick);

    let realDt = (ts - this._lastTs) / 1000;
    this._lastTs = ts;
    // タブ復帰などで巨大な dt が来たときの保護
    if (realDt > 0.25) realDt = 0.25;

    // FPS計測（0.5秒平均）
    this._fpsAccum += realDt;
    this._fpsFrames++;
    if (this._fpsAccum >= 0.5) {
      this.fps = this._fpsFrames / this._fpsAccum;
      this._fpsAccum = 0;
      this._fpsFrames = 0;
    }

    const simBefore = this.simTime;
    if (this.speed > 0) {
      this._accum += realDt * this.speed;
      const budgetEnd = performance.now() + STEP_BUDGET_MS;
      let steps = 0;
      while (this._accum >= FIXED_DT && steps < MAX_STEPS_PER_FRAME) {
        this.onFixedUpdate(FIXED_DT);
        this.simTime += FIXED_DT;
        this._accum -= FIXED_DT;
        steps++;
        if (performance.now() > budgetEnd) break;
      }
      // 予算内に消化しきれなかった分は捨てる（低速環境ではスローモーションになる）
      if (this._accum >= FIXED_DT) { this._accum = 0; this._starved = true; }
    } else {
      this._accum = 0;
    }

    // 実効倍率の計測（要求どおり進んでいるかを画面に出すため）
    this._rateWall += realDt;
    this._rateSim += this.simTime - simBefore;
    if (this._rateWall >= 0.5) {
      this.effectiveSpeed = this._rateSim / this._rateWall;
      this._rateWall = 0;
      this._rateSim = 0;
      this._starved = false;
    }

    const alpha = this.speed > 0 ? this._accum / FIXED_DT : 0;
    this.onRender(alpha, realDt);
  }
}

/** 秒 → "MM:SS" */
export function formatTime(sec) {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  return String(m).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
}
