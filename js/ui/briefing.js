// ステージ選択・ブリーフィング・戦果画面。仕様書 §11 / §13。
//
// ブリーフィングで見せるもの:
//   ・ステージ目標
//   ・地形（固定シードで生成されるので、ここで見た地形がそのまま戦場になる）
//   ・判明している敵の配置（known:true のユニットのみ）
//   ・出撃編成と兵装（兵装ポイントの範囲内で自由に組める）

import { STAGES, isUnlocked, stageList } from '../data/stages.js';
import { TUTORIALS, getTutorial } from '../data/tutorials.js';
import { VERSION, VERSION_DATE } from '../core/version.js';
import { showChangelog } from './changelog.js';
import { ratingTargets } from '../data/rating.js';
import { loadoutCost, loadoutFits } from '../data/weapons.js';
import { getType } from '../data/aircraft.js';
import { Terrain, CELLS, MAP_SIZE } from '../world/terrain.js';
import * as tuning from './tuning.js';
import { isDebug } from '../core/debug.js';
import { inline, block } from './markup.js';
import * as custom from '../data/custom.js';

import { loadoutRow, removeOne, pylonLabel, LOADOUT_HINT } from './loadout.js';

export class ScreenManager {
  /**
   * @param {object} o
   * @param {(stage, loadouts, terrain)=>void} o.onStart 出撃
   */
  constructor(o) {
    this.onStart = o.onStart;
    this.onStartTutorial = o.onStartTutorial;
    this.progress = o.progress;
    this.root = document.getElementById('screens');
    this._terrainCache = new Map();
    /** ステージIDごとに、最後に組んだ搭載を覚えておく（ブリーフィングに戻っても消えない） */
    this._lastLoadouts = new Map();
    this.loadouts = null;
    this.stage = null;

    this.root.addEventListener('click', (e) => this._onClick(e));
    // 調整パネルの数値入力（§47）
    this.root.addEventListener('change', (e) => {
      if (!this._tuneOpen || !isDebug() || !this.stage || !e.target.dataset.tn) return;
      if (tuning.handleInput(this.stage.id, e.target)) {
        this.stage = STAGES.find((x) => x.id === this.stage.id);
        this._renderBriefing();
      }
    });
  }

  // -------------------------------------------------------------- 画面

  hide() { this.root.classList.add('hidden'); this.root.innerHTML = ''; }

  /**
   * タイトル＝モード選択（仕様 §17）。
   *
   * モードはここに並べるだけで増やせる形にしてある。
   * キャンペーンを実装するときはカードを1枚足すだけで済む。
   */
  /** 「進行状況をリセット」を1回押した状態か（§80.6） */
  _resetArmed = false;

  showTitle() {
    const cleared = this.progress.cleared.length;
    const done = this.progress.tutorial.length;

    const modes = [
      {
        act: 'tutorial',
        name: 'チュートリアル',
        sub: '操作と仕組みを覚える',
        state: TUTORIALS.length ? `${done} / ${TUTORIALS.length}` : '準備中',
        ready: TUTORIALS.length > 0,
      },
      {
        act: 'select',
        name: 'ステージモード',
        sub: 'ミッションを1つずつ攻略する',
        state: `クリア済み ${cleared} / ${STAGES.length}`,
        ready: true,
      },
      {
        act: 'openReplay',
        name: 'リプレイ',
        sub: '保存した記録を読み込んで見返す',
        state: 'ファイルを開く',
        ready: true,
      },
      {
        act: '',
        name: 'キャンペーン',
        sub: '連続したミッションを戦い抜く',
        state: '準備中',
        ready: false,
      },
    ];

    // ステージエディタ（§66）。**デバッグモードのときだけ並べる**（§47.2 と同じ）。
    // 作りかけの面が一般のプレイヤーの一覧に出ないようにする。
    if (isDebug()) {
      modes.push({
        act: 'editor',
        name: 'ステージエディタ',
        sub: '地形・配置・目標を組んで試遊する',
        state: `自作 ${custom.customStages().length} 件`,
        ready: true,
      });
    }

    const cards = modes.map((m) => `
      <div class="mode-card${m.ready ? '' : ' locked'}"
           ${m.ready ? `data-act="${m.act}"` : ''}>
        <div class="mc-name">${m.name}</div>
        <div class="mc-sub">${m.sub}</div>
        <div class="mc-state">${m.state}</div>
      </div>`).join('');

    this._show(`
      <div class="screen-inner title-screen">
        <h1 class="game-title">ANGELS TWENTY</h1>
        <div class="screen-sub">戦闘機による空戦／対地 リアルタイム戦略シミュレーション</div>
        <div class="mode-grid">${cards}</div>
      </div>
      <button class="version-tag" data-act="changelog" title="更新履歴を見る">
        ${VERSION}<span>${VERSION_DATE}</span>
      </button>`);
  }

  showStageSelect() {
    const cleared = this.progress.cleared;
    const ratings = this.progress.ratings || {};
    // デバッグモードのときだけ検証用ステージが末尾に並ぶ（§51）
    const list = stageList();
    const cards = list.map((s, i) => {
      const unlocked = isUnlocked(s, cleared);
      const done = cleared.includes(s.id);
      const rank = ratings[s.id];
      return `<div class="stage-card${unlocked ? '' : ' locked'}${done ? ' cleared' : ''}${s.debug ? ' dbg' : ''}"
                   ${unlocked ? `data-stage="${s.id}"` : ''}>
        <div class="sc-no">${s.debug ? 'DEBUG' : `MISSION ${String(i + 1).padStart(2, '0')}`}</div>
        ${rank ? `<div class="sc-rank rank-${rank}">${rank}</div>` : ''}
        <div class="sc-name">${s.name}</div>
        <div class="sc-title">${s.title}</div>
        <div class="sc-state">${done ? 'CLEARED' : unlocked ? '出撃可能' : 'LOCKED'}</div>
      </div>`;
    }).join('');

    this._show(`
      <div class="screen-inner">
        <h1 class="game-title">ANGELS TWENTY</h1>
        <div class="screen-sub">STAGE MODE — ステージモード</div>
        <div class="stage-grid">${cards}</div>
        <div class="screen-foot list">
          ${this._resetArmed
    ? `<span class="foot-warn">クリア状況と最高評価をすべて消します。戻せません</span>
             <button data-act="resetNo" class="ghost">やめる</button>
             <button data-act="resetYes">消す</button>`
    : `<span>クリアすると次のミッションが解禁されます</span>
             <button data-act="title" class="ghost">モード選択へ</button>
             <button data-act="reset" class="ghost">進行状況をリセット</button>`}
        </div>
      </div>`);
  }

  /**
   * 保存した記録の一覧（§23.5）。
   *
   * **開発サーバが `replays/` を読んで組み立てたものを並べる**ので、
   * ファイルを選ぶ手間が要らない。一覧が取れないとき（公開版など）は
   * 呼ばれないので、従来どおりファイルを開く。
   */
  showReplayList(items) {
    // **新しい版の記録から並べる。** 古い版も開けるが、混ざったまま並ぶと
    // 「いまの動き」を見たいときに探すことになる。
    //
    // **「いまの版と一致するか」では切らない** —— 版を1つ上げただけで
    // 手元の記録が全部「古い」に落ち、そのたびに録り直すことになる（実際なった）。
    // **一番新しい版**を基準にすれば、録り直さなくても上に残る。
    const sorted = [...items].sort((a, b) => verNum(b.version) - verNum(a.version));
    const top = sorted.length ? verNum(sorted[0].version) : 0;
    const now = sorted.filter((r) => verNum(r.version) === top);
    const old = sorted.filter((r) => verNum(r.version) !== top);
    const card = (r) => {
      const ok = r.result === 'clear';
      const sec = r.sec != null ? `${Math.round(r.sec)}秒` : '';
      const kl = r.kills != null ? `撃墜 ${r.kills} / 損失 ${r.losses}` : '';
      const ver = r.version && verNum(r.version) !== top ? r.version : '';
      return `<div class="stage-card${ok ? ' cleared' : ''}" data-replay="${r.file}">
        <div class="sc-no">${ok ? 'CLEAR' : 'FAILED'}${ver ? ` · ${ver}` : ''}</div>
        <div class="sc-name">${r.stage}</div>
        <div class="sc-title">${ok ? (r.title || '') : (r.reason || r.title || '')}</div>
        <div class="sc-state">${[sec, kl].filter(Boolean).join(' · ')}</div>
      </div>`;
    };

    this._show(`
      <div class="screen-inner">
        <h1 class="game-title">ANGELS TWENTY</h1>
        <div class="screen-sub">REPLAY — 保存した記録</div>
        <div class="stage-grid">${now.map(card).join('')}</div>
        ${old.length ? `<div class="screen-sub">それより前の版の記録</div>
        <div class="stage-grid">${old.map(card).join('')}</div>` : ''}
        <div class="screen-foot list">
          <span>${items.length} 件（<code>replays/</code> にあるもの）</span>
          <button data-act="title" class="ghost">モード選択へ</button>
          <button data-act="replayFile" class="ghost">ファイルを開く</button>
        </div>
      </div>`);
  }

  /**
   * チュートリアル選択（仕様 §19）。
   * 中身は P12 で入れる。ここが空のあいだはタイトルから入れない。
   */
  showTutorialSelect() {
    const done = this.progress.tutorial;
    // 本数が増えたので種類ごとに束ねる。1列に並べると縦に収まらない。
    const groups = [];
    for (const t of TUTORIALS) {
      const key = t.group || 'その他';
      let g = groups.find((x) => x.key === key);
      if (!g) { g = { key, items: [] }; groups.push(g); }
      g.items.push(t);
    }
    const GROUP_SUB = {
      基本: '操作と仕組み',
      兵装: '1兵装ずつ、特性と使い方',
      詳細: '踏み込んだ仕組みと任せ方',
    };
    const GROUP_TAG = { 基本: 'BASIC', 兵装: 'WEAPON', 詳細: 'DETAIL' };
    const sections = groups.map((g) => {
      const n = g.items.filter((t) => done.includes(t.id)).length;
      const cards = g.items.map((t, i) => `
        <div class="stage-card tut${done.includes(t.id) ? ' cleared' : ''}" data-tutorial="${t.id}">
          <div class="sc-no">${GROUP_TAG[g.key] || 'BASIC'} ${String(i + 1).padStart(2, '0')}</div>
          ${done.includes(t.id) ? '<div class="sc-rank done-mark">✔</div>' : ''}
          <div class="sc-name">${t.name}</div>
          <div class="sc-title">${t.title}</div>
        </div>`).join('');
      return `<div class="tut-group">
          <div class="bf-section">${g.key}<span class="tg-sub">${GROUP_SUB[g.key] || ''}</span>
            <span class="tg-count">${n} / ${g.items.length}</span></div>
          <div class="tut-grid">${cards}</div>
        </div>`;
    }).join('');

    this._show(`
      <div class="screen-inner">
        <h1 class="game-title">ANGELS TWENTY</h1>
        <div class="screen-sub">TUTORIAL — チュートリアル</div>
        ${sections || '<div class="panel-empty">準備中</div>'}
        <div class="screen-foot list">
          <span>好きな順番で、何度でも受けられます</span>
          <button data-act="title" class="ghost">モード選択へ</button>
          <button data-act="select" class="ghost">ステージモードへ</button>
        </div>
      </div>`);
  }

  /**
   * チュートリアルのブリーフィング。
   * ステージと違って兵装は組ませない（覚えることを1本に絞るため）。
   * 何をする回なのかと、手順の全体像だけを先に見せる。
   */
  showTutorialBriefing(t) {
    this.stage = t;
    const done = this.progress.tutorial.includes(t.id);
    const steps = t.steps.map((s, i) =>
      `<li><span class="tb-no">${i + 1}</span>${inline(s.text)}</li>`).join('');

    this._show(`
      <div class="screen-inner briefing tutorial-brief">
        <div class="bf-top">
          <div>
            <div class="screen-sub">TUTORIAL</div>
            <h1 class="bf-name">${t.name}<small>${t.title}</small></h1>
          </div>
          <div class="bf-points">${done ? '<span class="bf-best">受講済み</span>' : ''}</div>
        </div>

        <div class="bf-body">
          <div class="bf-left">
            <div class="bf-section">この回で覚えること</div>
            <p class="bf-text">${block(t.brief)}</p>
            ${t.hint ? `<div class="bf-section">補足</div><p class="bf-hint">${block(t.hint)}</p>` : ''}
            <div class="bf-section">手順</div>
            <ol class="tb-steps">${steps}</ol>
          </div>
          <div class="bf-right">
            <div class="bf-section">戦域図</div>
            <canvas id="bfMap" width="${CELLS}" height="${CELLS}"></canvas>
            <div class="bf-legend">
              <span class="lg blue">■</span> 自軍飛行場
              <span class="lg red">■</span> 判明している敵
              <span class="lg dim">□</span> 未確認地域
            </div>
            <div class="bf-legend">失敗はありません。何度でもやり直せます</div>
          </div>
        </div>

        <div class="screen-foot">
          <button data-act="tutorial" class="ghost">戻る</button>
          <button data-act="startTutorial" class="go">開始</button>
        </div>
      </div>`);

    this._drawMap(t);
  }

  /** 全手順を終えたときの画面。評価は付けない（§19.1）。 */
  showTutorialResult(t) {
    const i = TUTORIALS.indexOf(t);
    const next = TUTORIALS[i + 1];
    const done = this.progress.tutorial.length;
    this._show(`
      <div class="screen-inner result">
        <div class="res-badge clear">TUTORIAL COMPLETE</div>
        <h1 class="bf-name">${t.name}<small>${t.title}</small></h1>
        <div class="res-reason">すべての手順を終えました（受講済み ${done} / ${TUTORIALS.length}）</div>
        ${next ? `<div class="res-next">次は「${next.name} — ${next.title}」です</div>` : `
        <div class="res-next">これで全部です。ステージモードへ進んでください</div>`}
        <div class="screen-foot">
          <button data-act="tutorial" class="ghost">チュートリアル一覧へ</button>
          ${next ? `<button data-act="nextTutorial" data-id="${next.id}" class="go">次へ</button>`
            : '<button data-act="select" class="go">ステージモードへ</button>'}
        </div>
      </div>`);
  }

  showBriefing(stage) {
    this.stage = stage;
    this._tuneOpen = false;
    this._tuneOutShown = false;
    // 前回このステージで組んだ搭載があればそれを復元する。
    // 出撃 → 途中でブリーフィングに戻る、を繰り返すたびに組み直しになると煩わしい。
    const saved = this._lastLoadouts.get(stage.id);
    this.loadouts = saved
      ? saved.map((l) => l.slice())
      : stage.friendly.aircraft.map((a) => a.loadout.slice());
    // 機体数が変わった場合（ステージ定義の更新）は初期値に戻す
    if (this.loadouts.length !== stage.friendly.aircraft.length) {
      this.loadouts = stage.friendly.aircraft.map((a) => a.loadout.slice());
    }
    this._renderBriefing();
  }

  /**
   * 調整結果を `stages.js` に写せる形で出す（§47・§47.4）。
   *
   * 味方の搭載を含めるかは `tuning.wantsLoadouts()`。**搭載を持っているのはこちら**
   * （調整パネルは味方に触らない）なので、写しを渡す。
   */
  _showTuneOut() {
    const out = document.getElementById('tnOut');
    if (!out || !this.stage) return;
    const loads = tuning.wantsLoadouts() && this.loadouts
      ? this.loadouts.map((l) => l.slice())
      : null;
    out.textContent = tuning.snippet(this.stage.id, loads);
    out.classList.remove('hidden');
    this._tuneOutShown = true;
  }

  /** 現在の搭載を記憶する（出撃時・変更時） */
  _rememberLoadouts() {
    if (!this.stage || !this.loadouts) return;
    this._lastLoadouts.set(this.stage.id, this.loadouts.map((l) => l.slice()));
  }

  /** 搭載の記憶を初期値へ戻す */
  resetLoadouts(stage) {
    this._lastLoadouts.delete(stage.id);
  }

  _renderBriefing() {
    const stage = this.stage;
    const spent = this.loadouts.reduce((n, l) => n + loadoutCost(l), 0);
    const left = stage.weaponPoints - spent;

    const roster = stage.friendly.aircraft.map((a, i) => {
      const spec = getType(a.type);
      const load = this.loadouts[i];
      const row = loadoutRow({
        loadout: load, spec, points: left,
        add: (id) => `data-add="${i}:${id}"`,
        del: (id) => `data-del="${i}:${id}"`,
      });
      return `<div class="bf-plane">
        <div class="bf-head"><b>${a.name}</b><span>${spec.name}</span>
          <span class="bf-slots${loadoutFits(load, spec) ? '' : ' bad'}">${pylonLabel(load, spec)}</span></div>
        <div class="bf-load"><span class="ld-hint">${LOADOUT_HINT}</span></div>
        <div class="bf-add">${row}</div>
      </div>`;
    }).join('');

    // **調整中であることを必ず見せる**（§47）。
    // 印が無いと、触った値のままベンチの数字を読んでしまう。
    const tuned = tuning.isTuned(stage.id) ? '<span class="tn-flag">調整中</span>' : '';

    const objectives = stage.objectives.map((o) =>
      `<li class="${o.fail ? 'obj-fail' : ''}">${inline(o.label)}${o.fail ? '（失敗条件）' : ''}</li>`).join('');

    // 評価基準は出撃前に見せる。終わってから明かすのでは狙いようがない。
    // ただしブリーフィングは元から縦に詰まっていて、表を足すと 720px の画面で
    // 出撃ボタンが画面外へ出る。そこで見出しの下に1行で並べる。
    const targets = ratingTargets(stage);
    const best = (this.progress.ratings || {})[stage.id];
    const ratingLine = targets ? targets.map((t) =>
      `<span title="${t.desc}"><em>${t.label}</em>`
      + `<b class="rt-good">◎${t.good}</b><b class="rt-ok">○${t.ok}</b></span>`).join('') : '';

    this._show(`
      <div class="screen-inner briefing">
        <div class="bf-top">
          <div>
            <div class="screen-sub">BRIEFING</div>
            <h1 class="bf-name">${stage.name}<small>${stage.title}</small>${tuned}</h1>
          </div>
          <div class="bf-points">
            ${best ? `<span class="bf-best">最高評価 <b class="rank-${best}">${best}</b></span>` : ''}
            兵装ポイント <b class="${left < 0 ? 'bad' : ''}">${left}</b> / ${stage.weaponPoints}</div>
        </div>
        ${targets ? `<div class="bf-rating">評価基準${ratingLine}</div>` : ''}

        <div class="bf-body">
          <div class="bf-left">
            <div class="bf-section">任務</div>
            <p class="bf-text">${block(stage.brief)}</p>
            <div class="bf-section">目標</div>
            <ul class="bf-obj">${objectives}</ul>
            <div class="bf-section">助言</div>
            <p class="bf-hint">${block(stage.hint || '')}</p>
          </div>
          <div class="bf-right">
            <div class="bf-section">戦域図</div>
            <canvas id="bfMap" width="${CELLS}" height="${CELLS}"></canvas>
            <div class="bf-legend">
              <span class="lg blue">■</span> 自軍飛行場
              <span class="lg red">■</span> 判明している敵
              <span class="lg dim">□</span> 未確認地域
            </div>
          </div>
        </div>

        <div class="bf-section">出撃編成</div>
        <div class="bf-roster">${roster}</div>

        <div class="screen-foot">
          <button data-act="back" class="ghost">戻る</button>
          ${isDebug() ? (stage.custom
            ? '<button data-act="backToEditor" data-id="' + stage.id + '" class="ghost">エディタで編集</button>'
            : '<button data-act="tune" class="ghost">難易度調整</button>'
              + '<button data-act="editCopy" class="ghost">複製して編集</button>') : ''}
          <button data-act="launch" class="go"${left < 0 ? ' disabled' : ''}>出撃</button>
        </div>
      </div>
      ${this._tuneOpen && isDebug() ? tuning.render(stage.id) : ''}`);

    this._drawMap(stage);
  }

  showResult(stage, result, stats) {
    // **ここで覚え直す。** エディタの試遊はブリーフィングを通らないので、
    // `this.stage` が別のステージのまま残っている（§66.9）。
    // 「もう一度」がそれを開いてしまう。
    this.stage = stage;
    const clear = result === 'clear';
    // 検証用ステージ（§47.2）は STAGES に無い。indexOf が -1 を返すので、
    // そのまま +1 すると**先頭のステージが「次の任務」として出てしまう**。
    const at = STAGES.indexOf(stage);
    const next = at >= 0 ? STAGES[at + 1] : null;
    const r = stats.rating;

    // 評価（§18）。クリアしたときだけ出す。
    // 各軸に「◎の基準」を添える。あと何秒・何ポイント足りなかったのかが
    // 分からないと、もう一度やる理由にならない。
    const rating = r ? `
      <div class="res-rating">
        <div class="rr-rank rank-${r.rank}">
          <label>総合評価</label><b>${r.rank}</b>
          ${stats.newBest && stats.best ? '<i>自己ベスト更新</i>'
            : stats.newBest ? '<i>初クリア</i>'
            : `<i class="dim">最高評価 ${stats.best}</i>`}
        </div>
        <table class="rr-axes">
          ${r.axes.map((a) => `<tr class="mark-${a.mark === '◎' ? 'good' : a.mark === '○' ? 'ok' : 'poor'}">
            <th>${a.label}</th>
            <td class="rr-mark">${a.mark}</td>
            <td class="rr-val">${a.text}</td>
            <td class="rr-desc">${a.desc}${a.target ? `（◎ は ${a.target} まで）` : ''}</td>
          </tr>`).join('')}
        </table>
      </div>` : '';

    this._show(`
      <div class="screen-inner result">
        <div class="res-badge ${clear ? 'clear' : 'fail'}">${clear ? 'MISSION COMPLETE' : 'MISSION FAILED'}</div>
        <h1 class="bf-name">${stage.name}<small>${stage.title}</small></h1>
        <div class="res-reason">${stats.reason || ''}</div>
        <div class="res-stats">
          <div><label>経過時間</label><b>${stats.time}</b></div>
          <div><label>撃墜</label><b>${stats.kills}</b></div>
          <div><label>喪失</label><b>${stats.losses}</b></div>
          <div><label>残兵装P</label><b>${stats.points}</b></div>
        </div>
        ${rating}
        ${clear && next ? `<div class="res-next">次の任務「${next.name}」が解禁されました</div>` : ''}
        <div class="screen-foot">
          <button data-act="select" class="ghost">ステージモードへ</button>
          <button data-act="review" class="ghost">戦闘を振り返る</button>
          ${isDebug() && stage.custom
            ? `<button data-act="backToEditor" data-id="${stage.id}" class="ghost">エディタに戻る</button>`
            : ''}
          ${isDebug() ? `<button data-act="rerun" class="ghost"
            title="同じ乱数の種で、まったく同じ状況をもう一度">同じ条件で</button>` : ''}
          <button data-act="retry" class="${clear && next ? 'ghost' : 'go'}">${clear ? 'もう一度' : '再挑戦'}</button>
          ${clear && next ? `<button data-act="next" data-id="${next.id}" class="go">次のステージへ</button>` : ''}
        </div>
      </div>`);
  }

  // -------------------------------------------------------------- 内部

  _show(html) {
    this.root.innerHTML = html;
    this.root.classList.remove('hidden');
  }

  _onClick(e) {
    const card = e.target.closest('[data-stage]');
    if (card) { this.showBriefing(stageList().find((s) => s.id === card.dataset.stage)); return; }

    const tut = e.target.closest('[data-tutorial]');
    if (tut) { this.showTutorialBriefing(getTutorial(tut.dataset.tutorial)); return; }

    const rep = e.target.closest('[data-replay]');
    if (rep) { this.onPickReplay?.(rep.dataset.replay); return; }

    const add = e.target.closest('[data-add]');
    if (add && !add.classList.contains('disabled')) {
      const [i, id] = add.dataset.add.split(':');
      this.loadouts[Number(i)].push(id);
      this._rememberLoadouts();
      this._renderBriefing();
      return;
    }
    const del = e.target.closest('[data-del]');
    if (del && !del.classList.contains('disabled')) {
      const [i, id] = del.dataset.del.split(':');
      this.loadouts[Number(i)] = removeOne(this.loadouts[Number(i)], id);
      this._rememberLoadouts();
      this._renderBriefing();
      return;
    }

    // 調整パネル（§47）。開いている間だけ拾う
    if (this._tuneOpen && isDebug() && this.stage && tuning.handle(this.stage.id, e)) {
      this.stage = STAGES.find((x) => x.id === this.stage.id);
      this._renderBriefing();
      return;
    }

    const act = e.target.closest('[data-act]');
    if (!act) return;
    switch (act.dataset.act) {
      case 'tune':
        if (!isDebug()) break;
        this._tuneOpen = true;
        this._renderBriefing();
        break;
      case 'tuneClose':
        this._tuneOpen = false;
        this._tuneOutShown = false;
        this._renderBriefing();
        break;
      case 'tuneReset':
        tuning.reset(this.stage.id);
        this.stage = STAGES.find((x) => x.id === this.stage.id);
        this.resetLoadouts(this.stage);
        this.showBriefing(this.stage);
        this._tuneOpen = true;
        this._renderBriefing();
        break;
      // 出力に味方の搭載を含めるかの切り替え（§47.4）。
      // **調整パネルは味方に触らない**ので、搭載はこちらが持っているものを渡す
      case 'tuneLoadouts':
        if (!isDebug()) break;
        tuning.toggleLoadouts();
        this._renderBriefing();
        // 出しっぱなしなら出し直す。切り替えた結果がその場で見えないと、
        // どちらの状態で出力したのか分からなくなる
        if (this._tuneOutShown) this._showTuneOut();
        break;
      case 'tuneCopy':
        this._showTuneOut();
        break;
      case 'editor':
        if (isDebug()) this.onEditor?.(null);
        break;
      // 試遊から作りかけへ戻る（§66.9）。
      // **保管庫の側が最新** —— 試遊の直前に保存している。
      case 'backToEditor': {
        if (!isDebug()) break;
        const c = custom.getCustom(act.dataset.id) || this.stage;
        this.hide();
        this.onEditor?.(c);
        break;
      }
      // 既存ステージを下敷きにする（§66.2）。**複製してから編集する**ので、
      // `stages.js` の定義には触らない。
      case 'editCopy': {
        if (!isDebug() || !this.stage) break;
        const copy = custom.duplicate(this.stage);
        custom.save(copy);
        this.onEditor?.(copy);
        break;
      }
      case 'changelog': showChangelog(); break;
      case 'review': this.onReview?.(); break;
      case 'back':   this.showStageSelect(); break;
      case 'title':  this.showTitle(); break;
      case 'select': this.showStageSelect(); break;
      case 'tutorial': this.showTutorialSelect(); break;
      case 'startTutorial':
        if (this.onStartTutorial) this.onStartTutorial(this.stage);
        break;
      case 'nextTutorial':
        this.showTutorialBriefing(getTutorial(act.dataset.id));
        break;
      case 'launch':
        if (!act.hasAttribute('disabled')) {
          this._rememberLoadouts();
          this.onStart(this.stage, this.loadouts.map((l) => l.slice()), this._terrainFor(this.stage));
        }
        break;
      case 'retry':
        this.showBriefing(this.stage);
        break;
      // 次のステージへ。クリアした直後だけ出る
      case 'next': {
        const s = STAGES.find((x) => x.id === act.dataset.id);
        if (s) this.showBriefing(s);
        break;
      }
      // 同じ種でやり直す（§24.3）。運が違うと、指示を変えた効果を比べられない。
      // 調べるための道具なので、デバッグモードでだけ出す（§47.2）
      case 'rerun':
        if (!isDebug()) break;
        this.onRerun?.();
        break;
      // タイトルから、保存した記録を開く（§23.5）
      case 'openReplay':
        this.onOpenReplay?.();
        break;
      // 一覧からファイル選択へ逃がす（一覧に無い記録を開きたいとき）
      case 'replayFile':
        this.onPickReplayFile?.();
        break;
      // **1回では消さない**（§80.6）。押し間違いで全部消えるボタンが、
      // 「モード選択へ」の隣に無防備に並んでいた。
      case 'reset':
        this._resetArmed = true;
        this.showStageSelect();
        break;
      case 'resetNo':
        this._resetArmed = false;
        this.showStageSelect();
        break;
      case 'resetYes':
        this._resetArmed = false;
        if (this.onReset) this.onReset();
        this._lastLoadouts.clear();
        this.showStageSelect();
        break;
      default: break;
    }
  }

  /** ステージの地形（プレビュー用。戦闘側は同じシードで作り直す） */
  _terrainFor(stage) {
    if (!this._terrainCache.has(stage.id)) {
      this._terrainCache.set(stage.id, new Terrain(stage.terrain));
    }
    return this._terrainCache.get(stage.id);
  }

  /** 戦域図。地形と、判明している配置だけを描く。 */
  _drawMap(stage) {
    const canvas = document.getElementById('bfMap');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const terrain = this._terrainFor(stage);
    ctx.putImageData(terrain.buildMinimapImage(ctx), 0, 0);

    const px = (x) => (x / MAP_SIZE) * CELLS;
    const mark = (x, z, color, size = 5) => {
      ctx.fillStyle = color;
      ctx.fillRect(px(x) - size / 2, px(z) - size / 2, size, size);
    };

    // 自軍
    if (stage.friendly.base) mark(stage.friendly.base.x, stage.friendly.base.z, '#5aa9ff', 7);
    for (const g of stage.friendly.ground || []) mark(g.x, g.z, '#5aa9ff', 5);

    // 判明している敵だけ
    const enemy = stage.enemy;
    for (const key of ['base', 'base2']) {
      const b = enemy[key];
      if (b && b.known) mark(b.x, b.z, '#ff5b44', 7);
    }
    for (const g of enemy.ground || []) if (g.known) mark(g.x, g.z, '#ff5b44', 5);

    // 到達目標（チュートリアルには目標が無い）
    for (const o of stage.objectives || []) {
      if (o.type !== 'reach') continue;
      ctx.strokeStyle = '#ffb648';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(px(o.x), px(o.z), Math.max(4, px(o.radius || 3000)), 0, Math.PI * 2);
      ctx.stroke();
    }
  }
}

/** 「Beta 2.93」を並べ替えられる数にする。読めなければ 0（いちばん古い扱い）*/
function verNum(v) {
  const m = /(\d+)\.(\d+)/.exec(v || '');
  return m ? Number(m[1]) * 1000 + Number(m[2]) : 0;
}
