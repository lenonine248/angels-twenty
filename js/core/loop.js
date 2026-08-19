// 固定タイムステップのゲームループ。
// 「リアルタイム進行だが任意で一時停止・倍速できる」という要件の中核。
//
// - シミュレーションは常に FIXED_DT (1/30秒) 刻みで進む → 再現性が保てる
// - 倍速は「1フレームあたりのステップ回数」を増やして実現する
// - 一時停止中もレンダリングは回る（カメラは動かせる／指示は出せる）

export const FIXED_DT = 1 / 30;

/** 1フレームで消化する最大ステップ数（重い環境でスパイラルしないための上限） */
const MAX_STEPS_PER_FRAME = 12;

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
    const steps = [1, 2, 4];
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

    if (this.speed > 0) {
      this._accum += realDt * this.speed;
      let steps = 0;
      while (this._accum >= FIXED_DT && steps < MAX_STEPS_PER_FRAME) {
        this.onFixedUpdate(FIXED_DT);
        this.simTime += FIXED_DT;
        this._accum -= FIXED_DT;
        steps++;
      }
      // 消化しきれなかった分は捨てる（低速環境ではスローモーションになる）
      if (steps >= MAX_STEPS_PER_FRAME) this._accum = 0;
    } else {
      this._accum = 0;
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
