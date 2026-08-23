// ANGELS TWENTY — 音響。Web Audio API による完全な手続き生成（音源ファイルを持たない）。
//
// 設計上の要点:
// - ブラウザの自動再生制限があるため AudioContext は最初のユーザー操作で作る。
//   それ以前の再生要求は捨てる（キューに溜めると解禁の瞬間に全部鳴って破綻する）。
// - 効果音はカメラからの距離で減衰し、カメラ右方向への射影でパンする。
//   RTS 視点なので「見ている場所の音が聞こえる」のが正しい。
// - 同時発音数に上限を置く。乱戦では機銃だけで毎秒数十発になり、
//   上限が無いと音が割れるうえノード生成でフレームが落ちる。
// - BGM は先読みスケジューラ（25ms ごとに 0.25 秒先まで予約）で鳴らす。
//   setTimeout の揺れをそのまま音符の位置にしないための定石。
// - 音の距離減衰は物理的な逆二乗ではなく「聞こえてほしい範囲」で決めている。
//   実スケール（1マス50km）で正しくやると、ほぼ何も聞こえない。

const REF_DIST = 5000;        // これ以内はほぼ減衰しない（ズームに応じて可変）
const MAX_DIST = 30000;       // これを超えたら鳴らさない
const MAX_VOICES = 22;        // 同時発音数の上限
const SPEED_OF_SOUND = 40000; // 見かけの音速（遅延をわずかに付けるためだけの値）

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// D マイナー系。半音単位。
// 和音は鳴らさない。根音のドローンが約20秒ごとにこの順で移るだけ。
const BASE_HZ = 73.416;                       // D2
const PROGRESSION = [0, 8, 3, 10];            // D → B♭ → F → C
const PENTA = [0, 3, 5, 7, 10, 12, 15];
const semi = (n) => BASE_HZ * Math.pow(2, n / 12);

export class AudioManager {
  constructor(settings = {}) {
    this.ctx = null;
    this.ready = false;

    this.vol = {
      master: clamp(settings.master ?? 0.8, 0, 1),
      music: clamp(settings.music ?? 0.32, 0, 1),
      sfx: clamp(settings.sfx ?? 0.85, 0, 1),
    };

    // リスナー（カメラ）。right はステレオ定位に使うカメラ右方向。
    this._lx = 0; this._ly = 0; this._lz = 0;
    this._rx = 1; this._ry = 0; this._rz = 0;
    this._ref = REF_DIST;

    this._voices = 0;
    this._cool = new Map();      // 発音元ごとの連射抑制
    this._coolGc = 0;

    this._engine = null;
    this._engineTarget = { level: 0, pitch: 1 };

    this._alarm = 0;             // 0=なし 1=ロック警報 2=ミサイル警報
    this._alarmT = 0;

    this._music = null;

    this._onGesture = () => this.unlock();
    for (const ev of ['pointerdown', 'keydown', 'touchstart']) {
      window.addEventListener(ev, this._onGesture, { passive: true });
    }
  }

  // ------------------------------------------------------------ 起動

  /** 最初のユーザー操作で呼ばれる。以降は何度呼んでも安全。 */
  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      try { this.ctx = new AC(); } catch (e) { console.warn('[audio] 初期化に失敗', e); return; }
      this._build();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    this.ready = true;
    if (this._pendingMusic) { const m = this._pendingMusic; this._pendingMusic = null; this.startMusic(m); }
  }

  _build() {
    const ctx = this.ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.vol.master;
    this.master.connect(ctx.destination);

    // 全体をわずかに潰す。爆発が重なったときの歪みを防ぐ。
    if (ctx.createDynamicsCompressor) {
      this.comp = ctx.createDynamicsCompressor();
      this.comp.threshold.value = -14;
      this.comp.knee.value = 22;
      this.comp.ratio.value = 5;
      this.comp.attack.value = 0.004;
      this.comp.release.value = 0.22;
      this.comp.connect(this.master);
    }
    const out = this.comp || this.master;

    this.sfxBus = ctx.createGain();
    this.sfxBus.gain.value = this.vol.sfx;
    this.sfxBus.connect(out);

    this.musicBus = ctx.createGain();
    this.musicBus.gain.value = 0;                 // フェードインさせる
    this.musicBus.connect(out);

    // コックピット音（警報）は距離に関係なく鳴るので別バス
    this.cockpitBus = ctx.createGain();
    this.cockpitBus.gain.value = this.vol.sfx * 0.75;
    this.cockpitBus.connect(out);

    // 使い回すノイズ源
    const len = Math.floor(ctx.sampleRate * 2);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.noiseBuf = buf;
  }

  setVolume(kind, v) {
    v = clamp(v, 0, 1);
    this.vol[kind] = v;
    if (!this.ctx) return;
    if (kind === 'master') this.master.gain.value = v;
    if (kind === 'sfx') { this.sfxBus.gain.value = v; this.cockpitBus.gain.value = v * 0.75; }
    if (kind === 'music' && this._music) this.musicBus.gain.value = v;
  }

  dispose() {
    for (const ev of ['pointerdown', 'keydown', 'touchstart']) {
      window.removeEventListener(ev, this._onGesture);
    }
    this.stopMusic();
    this.stopEngine();
    if (this.ctx) this.ctx.close().catch(() => {});
    this.ctx = null;
  }

  // ------------------------------------------------------------ 定位

  /**
   * 聞く位置を決める。
   * カメラそのものではなく「カメラの注視点」を耳の位置にする。
   * RTS 視点だとカメラは常に十数km 離れているので、カメラ位置を耳にすると
   * 画面中央で起きたことまで遠くの音になってしまう。
   * @param {{x,y,z}} pos   注視点
   * @param {{x,y,z}} right カメラ右方向（正規化済み。定位に使う）
   * @param {number} [ref]  減衰の基準距離。ズームアウトすると広く聞こえるようにする。
   */
  setListener(pos, right, ref) {
    this._lx = pos.x; this._ly = pos.y; this._lz = pos.z;
    this._rx = right.x; this._ry = right.y; this._rz = right.z;
    if (ref) this._ref = clamp(ref, 1800, 12000);
  }

  /** 距離減衰・パン・遅延を求める。遠すぎるときは null。 */
  _place(pos) {
    const dx = pos.x - this._lx, dy = pos.y - this._ly, dz = pos.z - this._lz;
    const d = Math.hypot(dx, dy, dz);
    if (d > MAX_DIST) return null;
    const ref = this._ref;
    const g = ref / (ref + Math.max(0, d - ref) * 2.2);
    if (g < 0.012) return null;
    const pan = clamp((dx * this._rx + dy * this._ry + dz * this._rz) / Math.max(900, d), -1, 1) * 0.85;
    return {
      g,
      pan,
      lp: 800 + 13000 * g * g,             // 遠いほど高音が落ちる
      delay: Math.min(0.55, d / SPEED_OF_SOUND),
    };
  }

  /** 発音枠を取る。取れなければ false。 */
  _take(dur) {
    if (!this.ready || this._voices >= MAX_VOICES) return false;
    this._voices++;
    setTimeout(() => { this._voices--; }, Math.min(4000, dur * 1000 + 120));
    return true;
  }

  /** 同じ発生源の連射を間引く */
  _throttle(key, sec) {
    const now = this.ctx ? this.ctx.currentTime : 0;
    const last = this._cool.get(key);
    if (last != null && now - last < sec) return false;
    this._cool.set(key, now);
    if (this._cool.size > 200 && now - this._coolGc > 5) {
      this._coolGc = now;
      for (const [k, t] of this._cool) if (now - t > 5) this._cool.delete(k);
    }
    return true;
  }

  _noise(t0, dur) {
    const s = this.ctx.createBufferSource();
    s.buffer = this.noiseBuf;
    s.loop = true;
    s.playbackRate.value = 0.85 + Math.random() * 0.3;
    // バッファ内の開始位置を毎回変える。同じ音の繰り返しに聞こえないように。
    s.start(t0, Math.random() * 1.5);
    s.stop(t0 + dur);
    return s;
  }

  /**
   * 効果音の共通後段を作る。
   * 信号経路は lp → g(エンベロープ) → pan → out → bus。
   * 独自のエンベロープを持つ追加の音源は pan に繋ぐ（定位は共有する）。
   */
  _chain(place, t0, bus) {
    const ctx = this.ctx;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = place ? place.lp : 16000;
    const g = ctx.createGain();
    g.gain.value = 0;
    const out = ctx.createGain();
    out.gain.value = 1;
    let pan = out;
    if (ctx.createStereoPanner) {
      pan = ctx.createStereoPanner();
      pan.pan.value = place ? place.pan : 0;
      pan.connect(out);
    }
    lp.connect(g);
    g.connect(pan);
    out.connect(bus || this.sfxBus);
    return { lp, g, pan, out };
  }

  // ------------------------------------------------------------ 効果音

  /**
   * 爆発・撃墜。`size` は演出の爆発半径(m)と同じ尺度。
   *
   * **4層で作る**（§52）。以前は「帯域を落としていくノイズ＋正弦波の低音」の
   * 2層だった。立ち上がりが 12ms と鈍く、頭に破裂が無いまま中域から始まるので、
   * 爆発というより**フィルタを閉じたノイズ**に聞こえていた。
   * 低音も純粋な正弦波で、シンセのサブベースそのものだった。
   *
   * | 層 | 何を出すか |
   * |---|---|
   * | リップ | **1.2ms** で立ち上がる高域。起爆の裂ける瞬間 |
   * | ボディ | 帯域を落としていくノイズ。爆風の本体 |
   * | 突き上げ | 三角波の低音。倍音があるぶん正弦波より体に来る |
   * | 破片 | 不規則に揺れる中低域の尾。1秒前後くすぶる |
   *
   * @param {string} [kind] 'air' なら空中撃墜。金属の裂ける成分を足し、
   *   全体を短く明るくする。'ground' は低音寄りで尾が長い（地面に伝わる）。
   *   **`world.effects.onExplosion` は前から渡していたのに、受け側が捨てていた。**
   */
  explosion(pos, size = 260, kind = 'ground') {
    if (!this.ready) return;
    const p = this._place(pos);
    if (!p) return;
    const big = clamp(size / 420, 0.5, 1.6);
    const air = kind === 'air';
    const dur = (air ? 0.75 : 1.05) + big * (air ? 0.7 : 1.0);
    if (!this._take(dur + p.delay)) return;

    const ctx = this.ctx;
    const t0 = ctx.currentTime + p.delay;
    const amp = p.g * (0.4 + big * 0.28);

    const ch = this._chain(p, t0);
    const { lp, g } = ch;

    // --- 1. リップ（起爆の裂ける音）
    // ここが無いと「破裂した」と聞こえない。**1.2ms で立ち上げる**。
    // 遠いところは共通の低域通過で落ちるので、近いときだけ効く。
    const rip = this._noise(t0, 0.16);
    const rhp = ctx.createBiquadFilter();
    rhp.type = 'highpass';
    rhp.frequency.setValueAtTime(air ? 1900 : 1300, t0);
    rhp.frequency.exponentialRampToValueAtTime(320, t0 + 0.1);
    const rg = ctx.createGain();
    rg.gain.value = 0;
    rg.gain.setValueAtTime(0, t0);
    rg.gain.linearRampToValueAtTime(amp * 1.3, t0 + 0.0012);
    rg.gain.exponentialRampToValueAtTime(0.0006, t0 + (air ? 0.1 : 0.15));
    // **`lp` には繋がない。** `_chain` の `lp` の先には共通のゲイン `g` があり、
    // そこにはボディの包絡が載っている。通すとリップまで一緒に鈍らされ、
    // せっかくの 1.2ms が 4ms に伸びる（実測で頭の破裂が消えていた）。
    // 距離による高域落ちだけ自前で掛けて `pan` へ直接出す。
    const rdl = ctx.createBiquadFilter();
    rdl.type = 'lowpass';
    rdl.frequency.value = p.lp;
    rip.connect(rhp); rhp.connect(rdl); rdl.connect(rg); rg.connect(ch.pan);

    // --- 2. ボディ（帯域を落としていくノイズ）
    const src = this._noise(t0, dur);
    src.connect(lp);
    lp.frequency.setValueAtTime(Math.min(p.lp, (air ? 3200 : 2600) * big), t0);
    lp.frequency.exponentialRampToValueAtTime(Math.max(80, 110 / big), t0 + dur);
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(amp, t0 + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0008, t0 + dur);

    // --- 3. 突き上げ。**三角波にする** — 純粋な正弦波は電子音に聞こえる
    const o = ctx.createOscillator();
    o.type = 'triangle';
    const og = ctx.createGain();
    og.gain.value = 0;
    o.frequency.setValueAtTime((air ? 165 : 190) * big, t0);
    o.frequency.exponentialRampToValueAtTime(air ? 34 : 26, t0 + 0.42 * big);
    og.gain.setValueAtTime(0, t0);
    og.gain.linearRampToValueAtTime(amp * 1.15, t0 + 0.008);
    og.gain.exponentialRampToValueAtTime(0.0008, t0 + (air ? 0.45 : 0.62) * big);
    o.connect(og); og.connect(ch.pan);
    o.start(t0); o.stop(t0 + 0.7 * big + 0.05);

    // --- 4. 破片の尾。**不規則に揺らす**のが要点。
    // なめらかに減衰させると、どこまでも作り物に聞こえる。
    const debStart = 0.05;
    const deb = this._noise(t0 + debStart, dur - debStart);
    const dbp = ctx.createBiquadFilter();
    dbp.type = 'bandpass';
    dbp.frequency.value = air ? 760 : 480;
    dbp.Q.value = 0.7;
    const dg = ctx.createGain();
    dg.gain.value = 0;
    dg.gain.setValueAtTime(0.0008, t0 + debStart);
    for (let t = debStart; t < dur - 0.05; t += 0.055) {
      const fade = 1 - t / dur;
      dg.gain.setValueAtTime(
        Math.max(0.0008, amp * 0.3 * (0.2 + Math.random() * 0.8) * fade * fade),
        t0 + t,
      );
    }
    dg.gain.exponentialRampToValueAtTime(0.0006, t0 + dur);
    deb.connect(dbp); dbp.connect(dg); dg.connect(ch.pan);

    // --- 5. 空中撃墜のときだけ: 金属の裂ける成分
    // 「爆発した」ではなく「機体が壊れた」と聞こえるようにするため。
    if (air) {
      const tear = this._noise(t0 + 0.02, 0.4);
      const tbp = ctx.createBiquadFilter();
      tbp.type = 'bandpass';
      tbp.frequency.setValueAtTime(2400 + Math.random() * 800, t0 + 0.02);
      tbp.frequency.exponentialRampToValueAtTime(600, t0 + 0.34);
      tbp.Q.value = 2.6;
      const tg = ctx.createGain();
      tg.gain.value = 0;
      tg.gain.setValueAtTime(0, t0 + 0.02);
      tg.gain.linearRampToValueAtTime(amp * 0.5, t0 + 0.035);
      tg.gain.exponentialRampToValueAtTime(0.0006, t0 + 0.38);
      const tdl = ctx.createBiquadFilter();
      tdl.type = 'lowpass';
      tdl.frequency.value = p.lp;
      tear.connect(tbp); tbp.connect(tdl); tdl.connect(tg); tg.connect(ch.pan);
    }
  }

  /** ミサイル発射（噴射音） */
  missileLaunch(pos) {
    if (!this.ready) return;
    const p = this._place(pos);
    if (!p) return;
    const dur = 1.5;
    if (!this._take(dur + p.delay)) return;

    const ctx = this.ctx;
    const t0 = ctx.currentTime + p.delay;
    const { lp, g } = this._chain(p, t0);
    const src = this._noise(t0, dur);

    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 1.1;
    bp.frequency.setValueAtTime(260, t0);
    bp.frequency.exponentialRampToValueAtTime(1500, t0 + 0.16);
    bp.frequency.exponentialRampToValueAtTime(340, t0 + dur);
    src.connect(bp); bp.connect(lp);

    const amp = p.g * 0.42;
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(amp, t0 + 0.05);
    g.gain.setValueAtTime(amp, t0 + 0.35);
    g.gain.exponentialRampToValueAtTime(0.0008, t0 + dur);
  }

  /**
   * 機銃・弾幕の連射。key で発射源ごとに間引く。
   *
   * **1発を3層で作る**（§52）。以前は帯域を絞ったノイズ1本を 40ms 周期で
   * 開け閉めするだけだった。どの発も同じ音・同じ長さ・同じ間隔なので、
   * 耳には**25Hz で断続する1つの音**として届く ── 電子音に聞こえる原因はここ。
   *
   * | 層 | 何を出すか |
   * |---|---|
   * | クラック | 1.5ms で立ち上がる高域。銃口の破裂そのもの |
   * | ボディ | 中低域。**発の間隔(40ms)より短く切る** — 溶けると粒が消える |
   * | サンプ | 120→42Hz の短い低音。腹に来る成分 |
   *
   * その下に**持続する唸り**を別の層として敷く。粒だけだと間が無音になり、
   * 尾を伸ばして埋めると今度は粒が溶ける（実測で変調の深さ 0.17）。
   * **粒と唸りは別々に作る** ── これが実録音の構造。
   *
   * 距離は共通の低域通過（`p.lp`）が面倒を見る。遠いとクラックが落ちて
   * ボディとサンプだけが残り、**遠雷のような鳴り方**に自然に変わる。
   * だから遠いときはクラックの枝を作らない（音にも出ないし、ノードも無駄）。
   *
   * @param {number} [muzzle] 初速(m/s)。遅い砲ほど重い音にする（A-3 は 700）
   */
  gunBurst(pos, key, muzzle = 1000) {
    if (!this.ready) return;
    if (!this._throttle('g' + key, 0.26)) return;
    const p = this._place(pos);
    if (!p) return;
    const dur = 0.3;
    if (!this._take(dur + p.delay)) return;

    const ctx = this.ctx;
    const t0 = ctx.currentTime + p.delay;
    const { lp, g, pan } = this._chain(p, t0);
    // 音量は発ごとのゲインで作るので、共通のゲインは開けたままにする
    g.gain.setValueAtTime(1, t0);

    // 口径感。弾速の遅い砲ほど大きく重く鳴らす
    const heavy = clamp(1000 / muzzle, 1, 1.5);
    const near = p.g > 0.3;

    // ノイズは1本を共有して、層ごとにフィルタで枝分かれさせる。
    // 同じ破裂の別の帯域を聞いている、という形になるので位相も噛み合う。
    const src = this._noise(t0, dur + 0.12);
    const body = ctx.createBiquadFilter();
    body.type = 'lowpass';
    body.frequency.value = 900 / heavy;
    body.Q.value = 0.9;
    src.connect(body);
    let hp = null;
    if (near) {
      hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 2600 / heavy;
      src.connect(hp);
    }

    // **持続音を別に敷く。** 発ごとの粒だけだと、間が完全に無音になって
    // 「点が並んでいる」音になる。実録音は鋭い粒の下に低い唸りが途切れず鳴っている。
    // ここを1発ずつの減衰で作ろうとして尾を伸ばすと、粒が溶けて roar だけになる
    // （実測: 変調の深さが 0.17 まで落ちた）ので、**層を分ける**。
    const roar = ctx.createGain();
    roar.gain.value = 0;
    const rlp = ctx.createBiquadFilter();
    rlp.type = 'lowpass';
    rlp.frequency.value = 520 / heavy;
    body.connect(rlp); rlp.connect(roar); roar.connect(lp);
    roar.gain.setValueAtTime(0, t0);
    roar.gain.linearRampToValueAtTime(p.g * 0.3 * 0.5, t0 + 0.03);
    roar.gain.setValueAtTime(p.g * 0.3 * 0.5, t0 + dur - 0.02);
    roar.gain.exponentialRampToValueAtTime(0.0005, t0 + dur + 0.09);

    const amp = p.g * 0.3;
    for (let t = 0; t < dur; t += 0.04) {          // 毎秒 25 発
      // 揺らぎは小さく。機関砲は機械的に規則正しいので、
      // 大きく散らすと「連射」ではなく「複数が乱射している」音になる。
      const ts = t0 + t + (Math.random() - 0.5) * 0.003;
      const v = 0.7 + Math.random() * 0.6;

      if (near) {
        // **初期値を 0 にしてから予約する。** GainNode の既定は 1 なので、
        // `setValueAtTime(0, ts)` だけだと **ts までは開きっぱなし**になる。
        // 発ごとにノードを作るこの作りでは、全部の枝が最初から鳴り続けて
        // 粒が完全に潰れる（実測で変調の深さ 0.19）。
        const cg = ctx.createGain();
        cg.gain.value = 0;
        cg.gain.setValueAtTime(0, ts);
        cg.gain.linearRampToValueAtTime(amp * 0.9 * v, ts + 0.0015);
        cg.gain.exponentialRampToValueAtTime(0.0005, ts + 0.016 * heavy);
        hp.connect(cg); cg.connect(lp);
      }

      const bg = ctx.createGain();
      bg.gain.value = 0;
      bg.gain.setValueAtTime(0, ts);
      bg.gain.linearRampToValueAtTime(amp * 1.15 * v, ts + 0.004);
      bg.gain.exponentialRampToValueAtTime(0.0004, ts + 0.024 * heavy);
      body.connect(bg); bg.connect(lp);

      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.setValueAtTime((120 + Math.random() * 25) / heavy, ts);
      o.frequency.exponentialRampToValueAtTime(42 / heavy, ts + 0.05);
      const og = ctx.createGain();
      og.gain.value = 0;
      og.gain.setValueAtTime(0, ts);
      og.gain.linearRampToValueAtTime(amp * 0.55 * v, ts + 0.003);
      og.gain.exponentialRampToValueAtTime(0.0004, ts + 0.035 * heavy);
      o.connect(og); og.connect(pan);
      o.start(ts); o.stop(ts + 0.05 * heavy);
    }
  }

  /**
   * 機銃の被弾（金属音）。
   *
   * 矩形波を 1800→700Hz へ落とすだけだった。**音程のある減衰音**なので、
   * 金属が鳴るというより電子音の「ピュン」に聞こえていた。
   * 高いところに共振を置いたノイズを短く切る形に変える —
   * 金属の打撃音は倍音が噛み合っておらず、音程として聞こえないのが本来。
   */
  gunHit(pos) {
    if (!this.ready) return;
    if (!this._throttle('hit', 0.09)) return;
    const p = this._place(pos);
    if (!p || p.g < 0.09) return;
    if (!this._take(0.2 + p.delay)) return;

    const ctx = this.ctx;
    const t0 = ctx.currentTime + p.delay;
    const { lp, g } = this._chain(p, t0);
    const src = this._noise(t0, 0.14);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(3400 + Math.random() * 1400, t0);
    bp.frequency.exponentialRampToValueAtTime(1200, t0 + 0.07);
    bp.Q.value = 2.2;
    src.connect(bp); bp.connect(lp);

    // **帯域を絞るとノイズの実効量が大きく落ちる。** 矩形波1本だった頃と
    // 同じ 0.16 のままにしたら、機銃の 1/14 の音量になっていた（実測）。
    const amp = p.g * 1.1;
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(amp, t0 + 0.001);
    g.gain.exponentialRampToValueAtTime(0.0006, t0 + 0.11);
  }

  /** フレア／チャフ投射 */
  flare(pos) {
    if (!this.ready) return;
    const p = this._place(pos);
    if (!p || p.g < 0.08) return;
    if (!this._take(0.5 + p.delay)) return;

    const ctx = this.ctx;
    const t0 = ctx.currentTime + p.delay;
    const { lp, g } = this._chain(p, t0);
    const src = this._noise(t0, 0.45);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 1600;
    src.connect(hp); hp.connect(lp);
    const amp = p.g * 0.22;
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(amp, t0 + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0006, t0 + 0.45);
  }

  /** 離陸・着陸などの機体挙動音（低い唸り） */
  whoosh(pos, dur = 1.2) {
    if (!this.ready) return;
    const p = this._place(pos);
    if (!p || p.g < 0.1) return;
    if (!this._take(dur + p.delay)) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime + p.delay;
    const { lp, g } = this._chain(p, t0);
    const src = this._noise(t0, dur);
    src.connect(lp);
    lp.frequency.setValueAtTime(300, t0);
    lp.frequency.linearRampToValueAtTime(900, t0 + dur * 0.4);
    lp.frequency.linearRampToValueAtTime(260, t0 + dur);
    const amp = p.g * 0.3;
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(amp, t0 + dur * 0.3);
    g.gain.exponentialRampToValueAtTime(0.0006, t0 + dur);
  }

  // ------------------------------------------------------------ コックピット音

  /** 無線・通知の短いブリップ。kind: info | good | bad | warn */
  radio(kind = 'info') {
    if (!this.ready) return;
    if (!this._throttle('radio', 0.12)) return;
    const table = {
      info: [660, 880], good: [740, 1108], bad: [420, 300], warn: [520, 520],
    };
    const [f1, f2] = table[kind] || table.info;
    const ctx = this.ctx;
    const t0 = ctx.currentTime;
    const g = ctx.createGain();
    g.gain.value = 0;
    g.connect(this.cockpitBus);
    const o = ctx.createOscillator();
    o.type = 'square';
    o.frequency.setValueAtTime(f1, t0);
    o.frequency.setValueAtTime(f2, t0 + 0.055);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 2400;
    o.connect(lp); lp.connect(g);
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(0.075, t0 + 0.006);
    g.gain.setValueAtTime(0.075, t0 + 0.05);
    g.gain.linearRampToValueAtTime(0.0, t0 + 0.115);
    o.start(t0); o.stop(t0 + 0.13);
  }

  /** UI のクリック音 */
  ui(kind = 'click') {
    if (!this.ready) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime;
    const g = ctx.createGain();
    g.connect(this.cockpitBus);
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.value = kind === 'back' ? 420 : kind === 'confirm' ? 980 : 720;
    o.connect(g);
    g.gain.setValueAtTime(0.055, t0);
    g.gain.exponentialRampToValueAtTime(0.0005, t0 + 0.07);
    o.start(t0); o.stop(t0 + 0.09);
  }

  /**
   * 警報の状態。0=なし 1=レーダーロック 2=ミサイル飛来。
   * 実際のビープは update() が刻む（状態だけを外から与える）。
   */
  setAlarm(level) {
    if (level !== this._alarm) {
      this._alarm = level;
      this._alarmT = 99;     // 状態が変わったら即座に鳴らす
    }
  }

  _beep(freq, dur, amp) {
    const ctx = this.ctx;
    const t0 = ctx.currentTime;
    const g = ctx.createGain();
    g.connect(this.cockpitBus);
    const o = ctx.createOscillator();
    o.type = 'square';
    o.frequency.value = freq;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = freq * 3.2;
    o.connect(lp); lp.connect(g);
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(amp, t0 + 0.004);
    g.gain.setValueAtTime(amp, t0 + dur * 0.7);
    g.gain.linearRampToValueAtTime(0, t0 + dur);
    o.start(t0); o.stop(t0 + dur + 0.02);
  }

  // ------------------------------------------------------------ エンジン音

  /**
   * 自軍機のエンジン音。機体ごとに鳴らすと重いので、
   * 「カメラに一番近い機体との距離」で 1 本のベッドを鳴らす。
   * @param {number} level 0..1（0 で無音）
   * @param {number} pitch 0.7..1.5
   */
  setEngine(level, pitch) {
    this._engineTarget.level = clamp(level, 0, 1);
    this._engineTarget.pitch = clamp(pitch, 0.6, 1.6);
    if (!this.ready) return;
    if (!this._engine && level > 0.01) this._startEngine();
  }

  _startEngine() {
    const ctx = this.ctx;
    const g = ctx.createGain();
    g.gain.value = 0;
    g.connect(this.sfxBus);

    // 吸気（広帯域ノイズ）
    const noise = ctx.createBufferSource();
    noise.buffer = this.noiseBuf;
    noise.loop = true;
    const nlp = ctx.createBiquadFilter();
    nlp.type = 'lowpass'; nlp.frequency.value = 420;
    const nhp = ctx.createBiquadFilter();
    nhp.type = 'highpass'; nhp.frequency.value = 90;
    noise.connect(nhp); nhp.connect(nlp); nlp.connect(g);
    noise.start();

    // 燃焼（低い倍音）
    const oscs = [];
    for (const [f, gain, type] of [[62, 0.5, 'sawtooth'], [93, 0.28, 'sawtooth'], [148, 0.14, 'triangle']]) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = f;
      const og = ctx.createGain();
      og.gain.value = gain;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 520;
      o.connect(og); og.connect(lp); lp.connect(g);
      o.start();
      oscs.push({ o, base: f });
    }
    this._engine = { g, noise, nlp, oscs };
  }

  stopEngine() {
    if (!this._engine) return;
    const { g, noise, oscs } = this._engine;
    try {
      g.gain.cancelScheduledValues(this.ctx.currentTime);
      g.gain.setTargetAtTime(0, this.ctx.currentTime, 0.08);
      noise.stop(this.ctx.currentTime + 0.4);
      for (const { o } of oscs) o.stop(this.ctx.currentTime + 0.4);
    } catch (e) { /* 既に止まっている */ }
    this._engine = null;
    this._engineTarget.level = 0;
  }
  // ------------------------------------------------------------ BGM
  //
  // 音のイメージは「マッハを超えて飛んでいる戦闘機の中」。
  // 曲を聴かせるのではなく機内にいる感じを作るのが目的なので、
  // 打楽器も進行感のあるコードも置かず、常時鳴る3層＋まばらなパッドで構成する。
  //
  //   1. 機体の低周波（サブ）  … わずかにデチューンした正弦波のうなり
  //   2. キャノピー外の気流    … 帯域を絞ったノイズ。ゆっくり掃引する
  //   3. タービンの高音        … ごく小さい高域の正弦波。ゆらぎを持たせる
  //   4. パッド（音楽的な要素）… 数秒に1音だけ、長い立ち上がりで薄く重ねる
  //
  // 音量は控えめ。効果音と警報が主役で、BGM はその下に敷くもの。

  /** mode: 'menu' | 'battle' | null（停止） */
  startMusic(mode) {
    if (!this.ready) { this._pendingMusic = mode; return; }
    if (this._music && this._music.mode === mode) return;
    this.stopMusic();
    if (!mode) return;

    const ctx = this.ctx;
    const now = ctx.currentTime;

    const bed = ctx.createGain();
    bed.gain.value = 0;
    bed.connect(this.musicBus);

    // --- 1. 機体の低周波
    const subGain = ctx.createGain();
    subGain.gain.value = 0.26;
    const subLp = ctx.createBiquadFilter();
    subLp.type = 'lowpass';
    // 30Hz台まで下げると多くのスピーカーで再生されず、音量計だけが振れて
    // 実際には何も聞こえない。聞こえる帯域に置いて、そのぶん小さく鳴らす。
    subLp.frequency.value = 240;
    subGain.connect(subLp);
    subLp.connect(bed);
    const subs = [];
    for (const [mul, det] of [[1, 0], [1, 7], [2, -5]]) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = BASE_HZ * mul;
      o.detune.value = det;
      const g = ctx.createGain();
      g.gain.value = mul === 2 ? 0.22 : 0.5;
      o.connect(g); g.connect(subGain);
      o.start(now);
      subs.push({ o, mul });
    }

    // --- 2. キャノピー外の気流
    const airGain = ctx.createGain();
    airGain.gain.value = 0.10;
    const airBp = ctx.createBiquadFilter();
    airBp.type = 'bandpass';
    airBp.frequency.value = 320;
    airBp.Q.value = 0.7;
    const airLp = ctx.createBiquadFilter();
    airLp.type = 'lowpass';
    airLp.frequency.value = 900;
    const air = ctx.createBufferSource();
    air.buffer = this.noiseBuf;
    air.loop = true;
    air.playbackRate.value = 0.6;
    air.connect(airBp); airBp.connect(airLp); airLp.connect(airGain); airGain.connect(bed);
    air.start(now);

    // 気流の帯域をゆっくり掃引する（同じ音が続くと耳が張り付く）
    const airLfo = ctx.createOscillator();
    airLfo.type = 'sine';
    airLfo.frequency.value = 0.035;
    const airLfoG = ctx.createGain();
    airLfoG.gain.value = 150;
    airLfo.connect(airLfoG); airLfoG.connect(airBp.frequency);
    airLfo.start(now);

    // --- 3. タービンの高音
    const whineGain = ctx.createGain();
    whineGain.gain.value = 0.009;
    whineGain.connect(bed);
    const whine = ctx.createOscillator();
    whine.type = 'sine';
    whine.frequency.value = 1870;
    whine.connect(whineGain);
    whine.start(now);
    const whineLfo = ctx.createOscillator();
    whineLfo.type = 'sine';
    whineLfo.frequency.value = 0.09;
    const whineLfoG = ctx.createGain();
    whineLfoG.gain.value = 26;
    whineLfo.connect(whineLfoG); whineLfoG.connect(whine.frequency);
    whineLfo.start(now);
    // 高音は出っぱなしだと耳が疲れるので、ゆっくり出入りさせる
    const whineAmp = ctx.createOscillator();
    whineAmp.type = 'sine';
    whineAmp.frequency.value = 0.021;
    const whineAmpG = ctx.createGain();
    whineAmpG.gain.value = 0.008;
    whineAmp.connect(whineAmpG); whineAmpG.connect(whineGain.gain);
    whineAmp.start(now);

    this._music = {
      mode,
      intensity: mode === 'battle' ? 0.6 : 0.4,
      wantIntensity: mode === 'battle' ? 0.6 : 0.4,
      bed, subs, air, airBp, airLfo, whine, whineLfo, whineAmp, whineGain,
      step: 0,
      nextTime: now + 0.2,
      // 1ステップ = 数秒。音符ではなく「間」を刻む
      stepDur: mode === 'battle' ? 2.4 : 3.2,
      seed: 0x9e3779b1,
      timer: setInterval(() => this._schedule(), 60),
    };

    bed.gain.setTargetAtTime(1, now, 2.5);
    this.musicBus.gain.cancelScheduledValues(now);
    this.musicBus.gain.setValueAtTime(this.musicBus.gain.value, now);
    this.musicBus.gain.linearRampToValueAtTime(this.vol.music, now + 3.0);
  }

  stopMusic() {
    const m = this._music;
    this._pendingMusic = null;
    if (!m) return;
    this._music = null;
    clearInterval(m.timer);
    const ctx = this.ctx;
    const now = ctx.currentTime;
    this.musicBus.gain.cancelScheduledValues(now);
    this.musicBus.gain.setValueAtTime(this.musicBus.gain.value, now);
    this.musicBus.gain.linearRampToValueAtTime(0, now + 1.2);
    const stop = (n) => { try { n.stop(now + 1.3); } catch (e) { /* 既に停止済み */ } };
    for (const s of m.subs) stop(s.o);
    stop(m.air); stop(m.airLfo); stop(m.whine); stop(m.whineLfo); stop(m.whineAmp);
  }

  /** 0.6=静穏 1=索敵中 2=交戦中。実際の変化はゆっくり追従する。 */
  setMusicIntensity(n) {
    if (this._music) this._music.wantIntensity = clamp(n, 0, 2);
  }

  _rand() {
    // 音選びに使う決定的な乱数（毎回同じにならず、かつ調から外れない）
    const m = this._music;
    m.seed = (m.seed * 1664525 + 1013904223) >>> 0;
    return m.seed / 4294967296;
  }

  _schedule() {
    const m = this._music;
    if (!m || !this.ctx) return;
    const ctx = this.ctx;
    // 強度はゆっくり追従（急に密度が変わると不自然）
    m.intensity += clamp(m.wantIntensity - m.intensity, -0.012, 0.012);

    while (m.nextTime < ctx.currentTime + 0.4) {
      this._step(m.step, m.nextTime);
      m.nextTime += m.stepDur;
      m.step++;
    }
  }

  /** 1ステップぶんを予約する */
  _step(step, t) {
    const m = this._music;
    const root = PROGRESSION[Math.floor(step / 8) % PROGRESSION.length];
    const inten = m.intensity;

    // 8ステップごと（約20秒）に根音を差し替える。和声の動きはこれだけ。
    if (step % 8 === 0) {
      for (const d of m.subs) {
        d.o.frequency.setTargetAtTime(semi(root) * d.mul, t, 3.0);
      }
      // 速度感: 強度が上がるほど気流の帯域と再生速度を上げる
      m.airBp.frequency.setTargetAtTime(300 + inten * 90, t, 4.0);
      m.air.playbackRate.setTargetAtTime(0.55 + inten * 0.22, t, 4.0);
    }

    // パッド。強度が上がるほど鳴る頻度が上がる。
    const chance = 0.28 + inten * 0.26;
    if (this._rand() < chance) {
      const n = PENTA[Math.floor(this._rand() * PENTA.length)];
      const oct = this._rand() < 0.35 ? 3 : 2;
      this._pad(semi(root + n + 12 * oct), t, 0.022 + inten * 0.010);
    }

    // 交戦中だけ、下に低いパルスを置く。打楽器ではなく圧のような音。
    if (inten > 1.3 && step % 2 === 0) {
      this._pulse(semi(root), t, 0.040 * clamp(inten - 1.3, 0, 0.7));
    }
  }

  /** 長い立ち上がりで薄く重なる音。BGM の音楽的な要素はこれだけ。 */
  _pad(freq, t, amp) {
    const ctx = this.ctx;
    const dur = 5.5;
    const g = ctx.createGain();
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(freq * 2.6, t);
    lp.frequency.linearRampToValueAtTime(freq * 1.2, t + dur);
    lp.connect(g);
    g.connect(this.musicBus);

    for (const [mul, det, a] of [[1, 0, 1], [1, 9, 0.7], [2, -6, 0.25]]) {
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = freq * mul;
      o.detune.value = det;
      const og = ctx.createGain();
      og.gain.value = a;
      o.connect(og); og.connect(lp);
      o.start(t); o.stop(t + dur + 0.1);
    }

    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(amp, t + 1.6);          // ゆっくり立ち上げる
    g.gain.linearRampToValueAtTime(amp * 0.7, t + dur * 0.6);
    g.gain.linearRampToValueAtTime(0, t + dur);
  }

  /** 交戦中の低いパルス。鼓動のような圧を出すだけで、拍は作らない。 */
  _pulse(freq, t, amp) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(freq * 1.4, t);
    o.frequency.exponentialRampToValueAtTime(freq, t + 0.5);
    const g = ctx.createGain();
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 180;
    o.connect(lp); lp.connect(g); g.connect(this.musicBus);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(amp, t + 0.25);
    g.gain.exponentialRampToValueAtTime(0.0004, t + 1.6);
    o.start(t); o.stop(t + 1.7);
  }

  // ------------------------------------------------------------ 毎フレーム

  update(dt) {
    if (!this.ready) return;

    // 警報のビープ
    if (this._alarm > 0) {
      this._alarmT += dt;
      const period = this._alarm >= 2 ? 0.3 : 1.35;
      if (this._alarmT >= period) {
        this._alarmT = 0;
        if (this._alarm >= 2) {
          this._beep(1240, 0.1, 0.085);
          setTimeout(() => { if (this._alarm >= 2) this._beep(1240, 0.09, 0.075); }, 120);
        } else {
          this._beep(760, 0.14, 0.038);
        }
      }
    }

    // エンジン音の追従
    const e = this._engine;
    if (e) {
      const t = this.ctx.currentTime;
      const lv = this._engineTarget.level;
      // 常時鳴っている音なので控えめに。大きいと会話も警報も潰す。
      e.g.gain.setTargetAtTime(lv * 0.17, t, 0.25);
      const p = this._engineTarget.pitch;
      for (const o of e.oscs) o.o.frequency.setTargetAtTime(o.base * p, t, 0.3);
      e.nlp.frequency.setTargetAtTime(300 + 420 * p, t, 0.3);
      if (lv < 0.005) this.stopEngine();
    }
  }
}
