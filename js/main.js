// ANGELS TWENTY — エントリポイント
//
// 画面遷移: モード選択(タイトル) → ステージ選択 → ブリーフィング → 戦闘 → 戦果
// 戦闘はステージ定義（data/stages.js）から毎回組み立て直す。

import * as THREE from 'three';
import { Terrain, MAP_SIZE, CELLS } from './world/terrain.js';
import { SceneManager, attachCameraControls } from './world/scene.js';
import {
  createAircraftView, syncAircraftView, aircraftDisplayLength,
  createGroundView, syncGroundView, groundDisplayScale, makeLabelSprite,
} from './world/models.js';
import { ContactRenderer } from './world/contacts.js';
import { Effects } from './world/effects.js';
import { GameLoop, formatTime } from './core/loop.js';
import { makeRng } from './core/rng.js';
import { CloudField } from './world/clouds.js';
import { CloudView } from './world/cloudview.js';
import { buildObjectiveMarkers, scaleObjectiveLabels } from './world/objectives.js';
import { onDevServer } from './core/devserver.js';
import { loadProgress, markCleared, markRating, resetProgress, saveSettings } from './core/save.js';
import { evaluate, isBetterRank, RANKS } from './data/rating.js';
import { AudioManager } from './core/audio.js';
import * as telemetry from './core/telemetry.js';
import { VERSION } from './core/version.js';
import { Recorder, pickRecordingFile, parseRecording } from './core/recorder.js';
import { Aircraft } from './sim/aircraft.js';
import { GroundUnit, findFlatSpot } from './sim/ground.js';
import { Airbase, pickRunwayHeading, flattenRunway } from './sim/airbase.js';
import { DetectionSystem, Contact, LEVEL } from './sim/detection.js';
import { CombatSystem } from './sim/combat.js';
import { resetMissileIds } from './sim/missile.js';
import { Mission, MISSION, SideObjectives } from './sim/mission.js';
import { SIDE, resetUnitIds } from './sim/unit.js';
import { PilotAI } from './ai/pilot.js';
import * as tuning from './ui/tuning.js';
import { isDebug, setDebug } from './core/debug.js';
import { pruneFormations, resetFormationIds } from './ai/formation.js';
import { Commander } from './ai/commander.js';
import { CommandController } from './ui/commands.js';
import { Hud } from './ui/hud.js';
import { ScreenManager } from './ui/briefing.js';
import { notify, onAction } from './ui/actions.js';
import { TutorialRunner } from './ui/tutorial.js';
import { StageEditor } from './ui/editor.js';
import { getCustom } from './data/custom.js';
import { TUTORIALS, getTutorial } from './data/tutorials.js';
import { markTutorialDone } from './core/save.js';
import { isChangelogOpen, hideChangelog } from './ui/changelog.js';
import { ReviewScreen } from './ui/review.js';
import { ReplayPlayer } from './ui/replay.js';
import { STAGES, stageList } from './data/stages.js';
import { getType, defaultEnemyLoadout } from './data/aircraft.js';
import { loadoutCost } from './data/weapons.js';

const el = (id) => document.getElementById(id);

window.addEventListener('error', (e) => showFatal(e.error || e.message));
window.addEventListener('unhandledrejection', (e) => showFatal(e.reason));

let scene = null;
let screens = null;
let loop = null;
let commands = null;
let hud = null;
/** 雲の見た目（§88.9）。戦闘ごとに作り直す */
let cloudView = null;
let minimap = null;
/** 直近に終わった戦闘の記録（§23）。戦果画面の「振り返り」が使う */
let lastRecording = null;
/** 直近の戦果画面の中身。振り返りから戻ったときに出し直すために覚えておく */
let lastResult = null;
/** 振り返り画面をどこから開いたか。閉じたときの戻り先が変わる */
let viewingFrom = 'result';
/** いま見ている記録（3D再生から戻るときに使う） */
let viewingData = null;
let review = null;
let replay = null;
let updateCameraInput = null;
let progress = loadProgress();
let audio = null;

/** 現在の戦闘。ステージを開始するたびに作り直す。 */
let battle = null;

/** チュートリアル進行（§19）。通常のステージでは null。 */
let tutorial = null;

/** ステージエディタ（§66）。デバッグモードのときだけ開ける。 */
let editor = null;

boot().catch(showFatal);

function showFatal(err) {
  const box = el('loading');
  if (!box) return;
  box.classList.remove('hidden');
  const msg = box.querySelector('.loading-msg');
  if (msg) {
    msg.style.color = '#ff6a54';
    msg.style.whiteSpace = 'pre-wrap';
    msg.style.textAlign = 'left';
    msg.style.maxWidth = '80vw';
    msg.style.letterSpacing = '0';
    msg.textContent = String(err && err.stack ? err.stack : err);
  }
  console.error(err);
}

// ================================================================ 起動

async function boot() {
  await nextFrame();
  await nextFrame();

  scene = new SceneManager(el('viewport'), null);
  updateCameraInput = attachCameraControls(scene.rig, scene.canvas);

  screens = new ScreenManager({
    progress,
    onStart: (stage, loadouts) => startBattle(stage, loadouts),
    onStartTutorial: (t) => startBattle(t, null, t),
  });

  // ステージエディタ（§66）。試遊はブリーフィングを通さず直接出す ——
  // 作りかけの搭載をそのまま試したいので、組み直しの画面を挟まない。
  editor = new StageEditor({
    onPlaytest: (stage) => {
      const loadouts = (stage.friendly.aircraft || []).map((a) => (a.loadout || []).slice());
      startBattle(stage, loadouts);
    },
    onExit: () => screens.showTitle(),
  });
  screens.onEditor = (stage) => editor.open(stage);

  // チュートリアルは UI 側の操作通知だけで進む（§19.2）
  onAction((kind, detail) => {
    if (tutorial) tutorial.handleAction(kind, detail);
    // 「自分が何をしたから何が起きたのか」を並べて見るため、指示も残す（§23.2）。
    if (battle && !battle.finished && kind.startsWith('order:')) {
      const u = commands.selection[0];
      battle.recorder.event('order', loop.simTime, {
        unit: u, target: detail.target, pos: u ? u.pos : null,
        label: kind.slice(6),
      });
    }
  });
  screens.onReset = () => { progress = resetProgress(); screens.progress = progress; };

  review = new ReviewScreen(el('review'));
  screens.onReview = () => {
    if (!lastRecording) return;
    viewingFrom = 'result';
    viewingData = lastRecording;
    review.open(lastRecording);
  };
  // タイトルから、保存した記録を開く（§23.5）。
  // 戻り先はタイトル。戦果画面から開いたときと戻り先が違うので、来た場所を覚える。
  /** 読み込んだ記録を振り返り画面へ渡す。3か所から来るので1つにまとめてある */
  const openRecording = (data) => {
    if (!data) return;
    viewingFrom = 'title';
    viewingData = data;
    review.open(data);
  };
  const replayError = (err) => {
    screens.showTitle();
    pushLog(`記録を読み込めません: ${err.message}`);
    window.alert(`記録を読み込めません
${err.message}`);
  };

  /**
   * タイトルの「リプレイ」。
   *
   * **開発サーバなら `replays/` の一覧を出す**（§23.5）——
   * 記録が十数件あるとファイル選択では中身が分からない。
   * 一覧が取れない環境（公開版）では**従来どおりファイルを開く**ので、
   * 遊ぶ側の手順は変わらない。
   */
  screens.onOpenReplay = async () => {
    // **無い受け口は叩かない。** 公開版に一覧は無く、
    // 取りに行くと `try/catch` で握り潰してもコンソールに 404 が赤字で残る
    if (onDevServer()) {
      try {
        const res = await fetch('replays/index.json');
        if (res.ok) {
          const list = await res.json();
          if (Array.isArray(list) && list.length) { screens.showReplayList(list); return; }
        }
      } catch { /* 一覧が作れない。ファイル選択へ落とす */ }
    }
    screens.onPickReplayFile();
  };

  /**
   * 一覧から1件選んだ。
   *
   * **ファイルから開くときと同じ検査を通す**（`parseRecording`）——
   * 素の `JSON.parse` で読むと、形式の合わない記録が
   * **理由なく空の画面で開く**（§23.5 で弾くと決めてある）。
   */
  screens.onPickReplay = async (file) => {
    try {
      const res = await fetch('replays/' + encodeURIComponent(file));
      if (!res.ok) throw new Error(`${file} を開けません (${res.status})`);
      openRecording(parseRecording(await res.text()));
    } catch (err) { replayError(err); }
  };

  /** 一覧を使わずファイルから開く */
  screens.onPickReplayFile = async () => {
    try {
      openRecording(await pickRecordingFile());
    } catch (err) { replayError(err); }
  };
  // 同じ種で戦い直す（§24.3）。搭載も同じものを使う
  screens.onRerun = () => {
    if (!lastResult) return;
    startBattle(lastResult.stage, lastResult.loadouts.map((l) => l.slice()),
      false, lastResult.seed);
  };
  // 3D再生へ行くときに戦果画面を畳んでいるので、閉じたら出し直す。
  // 出し直さないと、何も無い画面に取り残される（実際にそうなった）。
  review.onClose = () => {
    if (replay && replay.isOpen) return;                 // 3D再生へ移るところ
    if (!el('screens').classList.contains('hidden')) return;
    if (viewingFrom === 'result' && lastResult) {
      screens.showResult(lastResult.stage, lastResult.result, lastResult.stats);
    } else {
      screens.showTitle();
    }
  };

  replay = new ReplayPlayer(el('replayBar'), scene);
  // 振り返り画面から3D再生へ。
  // 戦果画面(#screens)は開いたままなので、3Dを見せるには畳む必要がある。
  review.onReplay = (data) => {
    viewingData = data;
    review.close();
    screens.hide();
    el('hud').classList.add('hidden');
    replay.open(data);
  };
  // 再生を終えたら、来た場所（振り返り画面）へ戻す。
  // **いま見ていた記録**を開き直す。lastRecording を使うと、
  // ファイルから読んだ記録を見ていたのに直近の戦闘へすり替わる。
  replay.onClose = () => {
    scene.reset();
    if (viewingData) review.open(viewingData);
    else screens.showTitle();
  };

  audio = new AudioManager(progress.settings);
  setupAudioUi();

  loop = new GameLoop(fixedUpdate, render);
  setupTimeControls();

  setupPauseMenu();
  // 起動できたことを素のスクリプト側へ知らせる（§65）。
  // これが立たないまま10秒経つと、index.html の受け皿が
  // 「再読み込みしてください」を出す。
  window.AT_READY = true;
  el('loading').classList.add('hidden');
  screens.showTitle();
  audio.startMusic('menu');
  loop.start();

  // デバッグ・検証用のハンドル
  window.AT = {
    get battle() { return battle; },
    get commands() { return commands; },
    get hud() { return hud; },
    get minimap() { return minimap; },
    get tutorial() { return tutorial; },
    // ステージエディタ（§66）。検証から配置を組み立てるために出しておく
    get editor() { return editor; },
    scene, loop, screens, progress, audio, stages: STAGES, stageList, tutorials: TUTORIALS, telemetry,
    // ステージの調整パネル（§47）。コンソールからも戻せるようにしておく
    tuning,
    /**
     * デバッグモード（§47.2）。**入り口はここだけ。**
     * 画面にもURLにも出さないので、一般のプレイヤーが偶然入ることはない。
     */
    setDebug(v) { const on = setDebug(v); screens.showTitle(); return on ? 'debug on' : 'debug off'; },
    get debug() { return isDebug(); },
    // 司令官AI（§27）。いまは検証（tools/bench.js）から使う。
    // 敵に付けるかは種を固定して測ってから決める（§27.6）。
    Commander,
    get recording() { return lastRecording; },
    get review() { return review; },
    get replay() { return replay; },
    /**
     * 検証用: ステージを直接開始する（ブリーフィング既定の兵装で出撃）。
     * seed を渡すと同じ乱数で始められる（§24.3）。
     */
    // **検証用ステージも番号で呼べるようにする**（§51）。
    // デバッグモードのときだけ末尾に並ぶので、切っていれば従来どおり 0〜6。
    startStage(i, seed) {
      const list = stageList();
      screens.showBriefing(list[i]);
      startBattle(list[i], screens.loadouts.map((l) => l.slice()), false, seed);
    },
  };
}

// ================================================================ ループ

function fixedUpdate(dt) {
  if (!battle) return;
  const { world, detection, combat, pilotAI, mission } = battle;
  // 雲を風で流す（§88.15）。**いちばん先に置く** ——
  // このステップの探知も射撃も、同じ位置の雲を見る
  world.clouds?.advance(dt);
  for (const u of world.units) u.update(dt, world);
  detection.update(dt);
  pilotAI.update(dt);
  combat.update(dt);
  handleDeaths(world);
  pruneFormations(world);
  mission.update(dt);
  // 敵側の司令官（§27.6）。**任務の判定より後**に置く ——
  // 目標が達成された直後の1ステップで、達成済みの目標へ機体を送らないため。
  battle.enemyPlan?.update(dt);
  battle.enemyCommander?.update(dt);

  // 記録は**全部が動いたあと**に取る。途中で取ると、
  // 同じ時刻のはずのユニットとコンタクトが1ステップずれる。
  battle.recorder?.tick(loop.simTime);

  if (mission.state !== MISSION.ACTIVE && !battle.finished) finishBattle();
}

function render(alpha, realDt) {
  updateCameraInput(realDt);
  scene.update(realDt);

  // リプレイ中は戦闘が無い。記録から作った表示物だけを動かす（§23.4）
  if (replay && replay.isOpen) {
    replay.update(realDt);
    scene.render();
    return;
  }

  if (battle) {
    const { world, terrain, contacts } = battle;

    const focusOn = commands.selection.length
      ? commands.selection
      : world.units.filter((u) => u.alive && u.side === world.playerSide
          && u.kind === 'aircraft' && !u.onGround);
    if (focusOn.length) {
      let sum = 0;
      for (const u of focusOn) {
        sum += Math.max(0, u.pos.y - Math.max(0, terrain.heightAt(u.pos.x, u.pos.z)));
      }
      scene.rig.focusAltTarget = Math.min(7000, Math.max(400, sum / focusOn.length));
    }

    const size = aircraftDisplayLength(scene.rig.distance, scene.camera);
    // 雲の濃さはカメラの高さで決まる（§88.9）
    cloudView?.update(scene.camera, commands.mouseNdc);
    const cloudy = world.clouds && world.clouds.active;
    for (const u of world.units) {
      const mine = u.side === world.playerSide;
      const visible = mine || contacts.showsBody(u);
      if (u.kind === 'aircraft') {
        // カメラから見て雲の向こうにいるか。**当たり判定と同じ式**を使う
        const hidden = cloudy && visible
          && world.clouds.blocks(scene.camera.position, u.pos);
        syncAircraftView(u, terrain, size, commands.isSelected(u), visible, hidden);
      } else syncGroundView(u, groundDisplayScale(scene.rig.distance, scene.camera, u.spec.size), visible);
    }
    contacts.update(scene.camera, terrain, size, battle.detection.time);
    scaleObjectiveLabels(battle.objectiveMarkers, scene.camera);
    // 一時停止中は演出も止める（煙だけ流れ続けると停止しているように見えない）
    world.effects.update(loop.paused ? 0 : realDt, world, size);
    commands.update(scene.camera);
  }

  updateAudio(realDt);
  scene.render();

  if (battle) {
    minimap.draw();
    hud.update(realDt, loop);
    updateHudBar();
    // 一時停止を覚える手順があるので、ポーズ中も進める
    if (tutorial && !battle.finished) {
      tutorial.update({
        world: battle.world, commands, loop, rig: scene.rig,
      }, realDt);
    }
  }
}

// ================================================================ 音響

const _camPos = new THREE.Vector3();
const _camRight = new THREE.Vector3();
let audioScanT = 0;

/**
 * 音響を毎フレーム更新する。
 * - リスナーはカメラ。RTS 視点なので「見ている場所の音が聞こえる」のが自然。
 * - エンジン音は機体ごとに鳴らさず、カメラに一番近い自軍機 1 機ぶんだけ鳴らす。
 *   16機ぶん個別に鳴らすと音が団子になるうえ、ノード数が跳ね上がる。
 * - 警報とBGMの強度は毎フレームだと重いので 4Hz で走査する。
 */
function updateAudio(realDt) {
  audio.update(realDt);
  if (!battle) { audio.setEngine(0, 1); audio.setAlarm(0); return; }
  const { world } = battle;

  // 耳はカメラではなく注視点。減衰の基準はズーム量に比例させる。
  _camPos.copy(scene.rig._target);
  _camRight.setFromMatrixColumn(scene.camera.matrixWorld, 0).normalize();
  audio.setListener(_camPos, _camRight, scene.rig._distance * 0.34);

  let near = null;
  let nearD = Infinity;
  for (const u of world.units) {
    if (!u.alive || u.kind !== 'aircraft' || u.side !== world.playerSide || u.onGround) continue;
    const d = u.pos.distanceTo(_camPos);
    if (d < nearD) { nearD = d; near = u; }
  }
  if (near && !loop.paused) {
    const lv = Math.max(0, Math.min(1, 1 - (nearD - 1200) / (scene.rig._distance * 0.9)));
    audio.setEngine(lv, 0.72 + (near.speed / near.spec.cruiseSpeed) * 0.45);
  } else {
    audio.setEngine(0, 1);
  }

  audioScanT += realDt;
  if (audioScanT < 0.25) return;
  audioScanT = 0;

  // 警報。2 = ミサイル飛来、1 = 交戦可能な距離まで敵に照射されている。
  // 「敵に見つかっている」だけで鳴らすと、開始から終了までずっと鳴りっぱなしになる。
  let alarm = 0;
  const mine = [];
  for (const u of world.units) {
    if (!u.alive || u.side !== world.playerSide || u.kind !== 'aircraft' || u.onGround) continue;
    if (u.threats && u.threats.length) { alarm = 2; break; }
    mine.push(u);
  }
  if (alarm < 2 && mine.length) {
    outer:
    for (const e of world.units) {
      if (!e.alive || e.side === world.playerSide) continue;
      // 敵機は交戦距離(≒最長ミサイル射程)、SAM はレーダー距離を目安にする
      const range = e.kind === 'aircraft' ? 18000
        : e.kind === 'sam' ? (e.radarRange || 0) * 0.8 : 0;
      if (!range) continue;
      for (const u of mine) {
        if (e.pos.distanceTo(u.pos) < range) { alarm = 1; break outer; }
      }
    }
  }
  audio.setAlarm(loop.paused ? 0 : alarm);

  // BGM の強度: 0.6=静穏 1=索敵中 2=交戦中。
  // 完全に 0 にするとドローンだけになり、音が止まったように聞こえる。
  let intensity = 0.6;
  if (world.missiles.length || alarm >= 2) intensity = 2;
  else {
    if (world.detection) {
      for (const c of world.detection.contactsFor(SIDE.BLUE).values()) {
        if (c.detected && c.unit.side !== world.playerSide) { intensity = 1; break; }
      }
    }
    if (alarm >= 1) intensity = Math.max(intensity, 1.5);
  }
  audio.setMusicIntensity(intensity);
}

// ================================================================ 戦闘の構築

function startBattle(stage, loadouts, asTutorial, seed) {
  screens.hide();
  el('loading').classList.remove('hidden');
  el('loading').querySelector('.loading-msg').textContent = 'GENERATING TERRAIN...';

  // 生成が重いので、ローディング表示を確実に出してから作る
  // （nextFrame は rAF が止まるバックグラウンドタブでもタイマーで進む）
  nextFrame().then(() => nextFrame()).then(() => {
    try {
      buildBattle(stage, loadouts, asTutorial, seed);
      el('loading').classList.add('hidden');
      el('hud').classList.remove('hidden');
      audio.startMusic('battle');
    } catch (e) { showFatal(e); }
  });
}

/**
 * 戦闘ごとの乱数の種を引く（§24.2）。
 *
 * **ここは `Math.random()` を使ってよい唯一の場所**。
 * `core/rng.js` の「Math.random() は経由しない」という決まりは
 * シミュレーションの中の話で、その外側で出発点を1つ引くのは別。
 * 引いた種は記録に残すので、あとから同じ戦闘をやり直せる（§24.3）。
 */
function drawBattleSeed() {
  return (Math.random() * 0xffffffff) >>> 0;
}

/**
 * 出撃時の散らばりの大きさ（§70.11）。位置・高度・針路。
 *
 * **崖のある軸をわざと少しだけ跨ぐ大きさ**にしてある。
 * §41.4 の実測では初陣は会敵距離 +3km で 61%、+4.5km で 100% と急に変わる。
 * 両軍に ±1.2km 効くので会敵距離は最大 2.4km ぶん揺れ、
 * **同じ面でも毎回違う戦いになる**が、ミッションの構図は壊れない。
 */
const SPAWN_SPREAD_XZ = 1200;
const SPAWN_SPREAD_ALT = 400;
const SPAWN_SPREAD_HDG = 15 * (Math.PI / 180);

function buildBattle(stage, loadouts, asTutorial, seed) {
  // ID を振り直す。ID はレーダーの扇の分担や逆探知の誤差に効くので、
  // 通し番号のままだと「同じステージ・同じシードでも、その回までに何戦したか」で
  // 経過が変わる。同じ条件からは同じ戦闘が始まるようにしておく。
  resetUnitIds();
  resetMissileIds();
  resetFormationIds();

  const battleSeed = seed != null ? (seed >>> 0) : drawBattleSeed();

  const terrain = new Terrain(stage.terrain);
  scene.reset();
  scene.setTerrain(terrain);

  const world = {
    terrain,
    mapSize: MAP_SIZE,
    units: [],
    missiles: [],
    decoys: [],
    playerSide: SIDE.BLUE,
    rig: scene.rig,
    detection: null,
    effects: null,
    // 地形の種とは分ける。地形まで毎回変わると覚えた地形が使えず、
    // ミッションの個性も消える。**地図は同じ、戦闘の綾は毎回違う**（§24.2）。
    rng: makeRng(battleSeed),
    /**
     * 雲（§88）。**地形と同じで、戦闘の種から作る** ——
     * 1戦ごとに形が変わり、同じ種なら同じ雲になる。
     * `stage.weather` を書かなければ空（`active` が false）。
     */
    clouds: new CloudField(stage.weather, makeRng(battleSeed ^ 0x5c10d)),
    /**
     * ログを1行出す。**第2引数にユニットを渡すと、自軍のときだけ出る**（§71.2）。
     *
     * 「敵機が着陸した」「敵機が燃料切れで帰投する」といった**相手の内部事情**が
     * そのまま流れていた。ログは自分の部隊からの無線という体裁なので、
     * 敵の判断がここに出ると世界の成り立ちが崩れる。
     *
     * 陣営の判定を**呼ぶ側それぞれに書かせない**。書き忘れが漏れになるし、
     * 実際 `${unit.name} ...` の形をした行のうち4か所が忘れていた。
     * 撃墜・任務・妨害といった「こちらが観測した出来事」は
     * 従来どおり第2引数なしで出す（見えているかは呼ぶ側が判断済み）。
     */
    log(msg, unit) {
      if (unit && unit.side !== this.playerSide) return;
      pushLog(msg);
    },
    weaponPoints: stage.weaponPoints,
    weaponPointsMax: stage.weaponPoints,
    enemySkill: stage.enemy?.skill ?? 1,
    isVisibleToPlayer(u) {
      return this.detection ? this.detection.isVisible(this.playerSide, u) : true;
    },
    displayPosOf(u) {
      if (u.side === this.playerSide || !this.detection) return u.pos;
      const c = this.detection.contactsFor(this.playerSide).get(u.id);
      return c ? c.pos : u.pos;
    },
    /**
     * その陣営が「そこに居ると思っている」座標。**真の位置と一致するなら null**（§25.4）。
     *
     * null を返す形にしているのは、呼ぶ側に「ずれているのか」を必ず意識させるため。
     * 常に座標を返すと、正確に見えている相手にまで**座標を狙う兵装**を撃つことになり、
     * 動く目標を追えなくなる（実際にそうなっていた）。
     */
    believedPosOf(side, u) {
      if (u.side === side || !this.detection) return null;
      const c = this.detection.contactsFor(side).get(u.id);
      if (!c) return null;
      if (c.detected && !c.approx) return null;      // いま正確に見えている
      return c.pos;
    },
    spawn(unit) {
      this.units.push(unit);
      scene.add(unit.kind === 'aircraft' ? createAircraftView(unit) : createGroundView(unit));
      return unit;
    },
  };

  const spawned = spawnStage(world, stage, loadouts, terrain, asTutorial);

  scene.add(terrain.buildMesh());
  scene.add(buildMapBoundary());
  const objectiveMarkers = buildObjectiveMarkers(stage, terrain);
  for (const marker of objectiveMarkers) scene.add(marker);

  world.detection = new DetectionSystem(world);
  world.effects = new Effects(scene.world);
  const combat = new CombatSystem(world);
  const pilotAI = new PilotAI(world);
  world.formations = [];

  const mission = new Mission(world, stage);

  /**
   * **敵側の司令官AI**（§27.6）。`stage.enemy.objectives` を書いた面でだけ動く。
   *
   * 書かなければ何も起きない —— 既存の7面は1行も変わらない。
   * 敵機はこれまでどおりステージ定義の `aiMode` で動く。
   *
   * プレイヤーには付けない（指揮するのがこのゲームなので・§27.5）。
   */
  const enemyPlan = stage.enemy && stage.enemy.objectives && stage.enemy.objectives.length
    ? new SideObjectives(world, stage.enemy.objectives) : null;
  const enemyCommander = enemyPlan ? new Commander(world, SIDE.RED, enemyPlan) : null;
  world.spawnReinforcement = (airbase, type, index, tags) =>
    spawnReinforcement(world, airbase, type, index, tags);
  for (const { airbase, config } of spawned.reinforcements) {
    mission.registerReinforcement(airbase, config);
  }

  // ブリーフィングで判明していた敵は、開始時から記憶コンタクトとして地図に出す
  seedKnownContacts(world, spawned.known);
  // 敵側のブリーフィング（§27.6）。自軍側で `known: true` を付けたものが入る
  seedKnownContacts(world, spawned.knownToEnemy, SIDE.RED);

  world.effects.onExplosion = (pos, size, kind) => audio.explosion(pos, size, kind);

  world.onFire = (shooter, target, weapon, missile) => {
    world.recorder?.event('fire', loop.simTime,
      { unit: shooter, target, weapon: weapon.id, pos: shooter.pos });
    if (shooter.side === world.playerSide) {
      world.log(`${shooter.name} ${weapon.id} 発射`);
      telemetry.markShot(weapon.id);
      notify('fire', { weapon: weapon.id, shooter, target });
    }
    world.effects.launchFlash(shooter.pos, missile ? missile.dir : null);
    audio.missileLaunch(shooter.pos);
  };
  // `onDecoyed` は §70.5.1 で鳴らなくなった。フレアはシーカーを奪うのではなく
  // 狙点を引っ張るので、「効いた／効かなかった」という瞬間が存在しない。
  world.onDecoy = (unit, kind) => {
    // **撒いた事実を記録する**（§23.9）。無いと再生で
    // 「なぜミサイルが外れたのか」が画面から消える
    world.recorder?.event('decoy', loop.simTime, { unit, pos: unit.pos, kind });
    audio.flare(unit.pos);
  };
  // 増槽の投棄（§32.2）。自分の機体のときだけ知らせる
  world.onTankDropped = (unit) => {
    if (unit.side === world.playerSide) world.log(`${unit.name} 増槽を投棄`);
  };
  world.onMissileHit = (m, target, dist) => {
    world.recorder?.event('hit', loop.simTime,
      { unit: m.launcher, target, weapon: m.weapon.id, pos: m.pos,
        label: dist != null && dist > 25 ? '至近弾' : '直撃' });
    if (m.side === world.playerSide) telemetry.markHit(m.weapon.id);
  };
  // 機銃は実体弾（§22.2）。曳光は毎フレーム弾の位置から描かれるので、
  // ここでやるのは当たった瞬間の火花と音だけ。
  world.onBulletHit = (bullet, target) => {
    world.effects.impact(bullet.pos);
    audio.gunHit(target.pos);
  };
  world.onBulletGround = (bullet) => world.effects.impact(bullet.pos, true);
  // 機体の機銃と、地上の弾幕（§51.6）の両方がここへ来る。
  // 初速を渡して口径感を分ける（A-3 は 700m/s なので重く鳴る）。
  world.onGunFire = (shooter, target, n, muzzle) => {
    world.effects.muzzle(shooter.pos);
    audio.gunBurst(shooter.pos, shooter.id, muzzle
      || shooter.spec?.gunSpec?.muzzleSpeed
      || shooter.spec?.weapon?.muzzle
      || 1000);
  };

  const contacts = new ContactRenderer(scene.world, world.detection, SIDE.BLUE);
  cloudView?.dispose();
  cloudView = new CloudView(world.clouds, scene.world);

  // UI をこの戦闘に繋ぎ替える
  if (!commands) {
    commands = new CommandController({
      canvas: scene.canvas, camera: scene.camera, world, sceneRoot: scene.world,
    });
  } else {
    commands.setWorld(world);
    scene.world.add(commands.paths.object);
  }
  if (!hud) hud = new Hud({ world, commands });
  else hud.setWorld(world, commands);      // キャッシュごと繋ぎ替える（§80.1）

  minimap = new Minimap(el('minimap'), terrain, scene.rig, world, commands, stage);

  /**
   * 雲の形を切り替える（§88.12・**デバッグ限定**）。
   *
   *   AT.cloudLook('deck')    横に広く薄い板 → 層に見える
   *   AT.cloudLook('puffy')   ふっくらした塊（既定）
   *   AT.cloudLook('broad')   少数の巨大な塊
   *
   * **見た目と当たり判定は同じ形**なので、これは遊びも変える。
   * どれにするか決まったら `CLOUD_SHAPE` の既定を差し替えて、
   * 18種のベンチを取り直す。
   */
  /**
   * 雲の見え方を確かめる（§88.13・デバッグ限定）。
   *
   *   AT.cloudPeek()        いまの値を見る
   *   AT.cloudPeek(0.25)    カーソルの穴を**狭く**する（カメラ距離に対する割合）
   *   AT.cloudPeek(null, 900, 4200)   カメラ手前の透過（完全に透ける / 元へ戻る）
   *
   * **半径そのものは渡せない** —— 毎フレーム距離から計算し直すので上書きされる。
   */
  AT.cloudPeek = (frac, near0, near1) => {
    const sh = cloudView && cloudView._shader;
    if (!sh) return 'シェーダ未コンパイル（1フレーム描いてから）';
    if (frac != null) cloudView.cursorFrac = frac;
    if (near0 != null) sh.uniforms.uNear.value.set(near0, near1 ?? near0 * 4);
    return { 割合: cloudView.cursorFrac, いまの半径: Math.round(sh.uniforms.uCursorR.value),
      手前: sh.uniforms.uNear.value.toArray(),
      カーソル: sh.uniforms.uCursor.value.toArray().map(Math.round) };
  };

  /**
   * 雲の濃さを調整する（§88.9・デバッグ限定）。
   *
   *   AT.cloudDensity()          いまの値を見る
   *   AT.cloudDensity(0.85, 0.8) 層と同じ高さ / 遥か上から見下ろしたとき
   */
  AT.cloudDensity = (near, far) => {
    if (!cloudView || !cloudView.mesh) return '雲のあるステージで';
    if (near != null) cloudView.opacityNear = near;
    if (far != null) cloudView.opacityFar = far;
    return { 層と同高度: cloudView.opacityNear, 遥か上から: cloudView.opacityFar,
      いまの濃さ: Number(cloudView.mat.opacity.toFixed(3)) };
  };

  /** 雲を作り直す（デバッグ限定）。`over` で `weather` の一部を差し替える */
  const rebuildClouds = (over) => {
    if (!isDebug() || !stage.weather) return null;
    world.clouds = new CloudField({ ...stage.weather, ...over }, makeRng(battleSeed ^ 0x5c10d));
    cloudView?.dispose();
    cloudView = new CloudView(world.clouds, scene.world);
    return world.clouds;
  };

  AT.cloudLook = (shape) => {
    const c = rebuildClouds({ shape });
    if (!c) return '雲のあるステージをデバッグモードで';
    return `${c.shape}: 塊 ${c.blobs.length}`;
  };

  /**
   * 風を変えて雲を作り直す（§88.15・デバッグ限定）。
   *
   *   AT.cloudWind()          いまの風を見る
   *   AT.cloudWind(270)       西風（**吹いてくる方位**）
   *   AT.cloudWind(270, 25)   速さも変える
   *   AT.cloudWind(0, 0)      無風に戻す
   *
   * **撒く範囲が風向きで決まる**ので、向きを変えたら作り直す必要がある。
   */
  AT.cloudWind = (deg, speed) => {
    const now = world.clouds;
    if (deg == null && speed == null) {
      if (!now || !now.active) return '雲のあるステージで';
      return { 風向: `${Math.round(now.windDeg)}°（吹いてくる方位）`, 風速: `${now.windSpeed} m/s`,
        流れた量: `${Math.round(Math.hypot(now.offset.x, now.offset.z))} m`, 塊: now.blobs.length };
    }
    const c = rebuildClouds({ wind: { deg: deg ?? now?.windDeg, speed: speed ?? now?.windSpeed } });
    if (!c) return '雲のあるステージをデバッグモードで';
    return `風 ${Math.round(c.windDeg)}° / ${c.windSpeed} m/s: 塊 ${c.blobs.length}`;
  };

  logLines.length = 0;
  objectivesKey = null;
  // チュートリアルはプレイ記録に残さない（難易度調整の資料が濁る）
  if (!asTutorial) telemetry.begin(stage, loadouts, VERSION, battleSeed);
  pushLog(asTutorial ? `チュートリアル ${stage.name} 開始` : `任務 ${stage.name} 開始`);

  battle = {
    stage, world, terrain, detection: world.detection, combat, pilotAI,
    mission, enemyPlan, enemyCommander, contacts, objectiveMarkers, finished: false,
    kills: 0, losses: 0,
    seed: battleSeed,
    loadouts: (loadouts || []).map((l) => l.slice()),
    // 振り返り用の記録（§23）。チュートリアルでも取る — 手順の検証に使えるため。
    recorder: new Recorder(stage, world, battleSeed),
  };
  world.recorder = battle.recorder;
  battle.recorder.sample(0);          // 開始時の配置を1枚残す

  // 初期カメラ。**選択はしない**（§64）。
  //
  // 以前は先頭の機体を選んだ状態で始めていた。カメラを合わせるのはよいが、
  // **選ぶところまでやってしまうと、指揮官が最初に決めることを機械が決めてしまう。**
  // 実害もある —— 開始直後に Z/X（高度）や B（帰投）を押すと、
  // **自分で選んでいない機体に指示が入る。**
  // パネルには「ユニット未選択 — 機体をクリック、またはドラッグで範囲選択」が出る。
  //
  // `select([])` を明示するのは、前の戦闘の選択が残っているため。
  const lead = world.units.find((u) => u.side === SIDE.BLUE && u.kind === 'aircraft');
  if (lead) {
    scene.rig.lookAtPoint(lead.pos.x, lead.pos.z);
    scene.rig._target.set(lead.pos.x, lead.pos.y, lead.pos.z);
  }
  commands.select([]);
  scene.rig.distance = 16000;
  scene.rig._distance = 16000;

  el('missionName').textContent = `${stage.name} — ${stage.title}`;
  loop.simTime = 0;
  loop.setSpeed(1);
  loop.setPaused(false);
  renderObjectives();

  destroyTutorial();
  if (asTutorial) {
    tutorial = new TutorialRunner(asTutorial, {
      onFinish: () => finishTutorial(),
      onRestart: () => startBattle(asTutorial, null, asTutorial),
    });
  }
}

// ================================================================ チュートリアル

function destroyTutorial() {
  if (!tutorial) return;
  tutorial.destroy();
  tutorial = null;
}

/** 全手順を終えた。評価は付けず、受講済みとして記録するだけ（§19.1）。 */
function finishTutorial() {
  const t = tutorial && tutorial.tutorial;
  if (!t || !battle || battle.finished) return;
  battle.finished = true;
  progress = markTutorialDone(progress, t.id);
  screens.progress = progress;
  audio.setAlarm(0);
  audio.setEngine(0, 1);
  setTimeout(() => {
    destroyTutorial();
    el('hud').classList.add('hidden');
    battle = null;
    loop.setSpeed(1);
    loop.setPaused(false);
    audio.startMusic('menu');
    screens.showTutorialResult(t);
  }, 1600);
}

/** ステージ定義からユニットを並べる */
function spawnStage(world, stage, loadouts, terrain, asTutorial) {
  const known = [];
  /**
   * **敵に最初から見えているもの**（§27.6）。自軍側の `known: true` を拾う。
   *
   * 敵に司令官AIを付けるなら、敵にもブリーフィングが要る ——
   * 「自軍飛行場を叩け」という目標を与えても、
   * **どこにあるか知らなければ何も起きない**（`_groundTargets` は探知を通す）。
   * 攻める側が固定施設の位置を知っているのは自然でもある。
   */
  const knownToEnemy = [];
  const reinforcements = [];

  const placeAirbase = (o) => {
    // **空母は海に浮かぶ飛行場**（§69.3）。
    // 平坦な場所を探すのも滑走路を削るのも要らない —— 海面はもともと平ら。
    // 甲板は陸の滑走路より短くする。
    if (o.type === 'CARRIER') {
      return world.spawn(new Airbase({
        ...o, runwayHeading: o.runwayHeading ?? 0,
        runwayLength: o.runwayLength ?? 900, serviceSlots: o.serviceSlots ?? 2,
      }).groundTo(terrain));
    }
    const spot = findFlatSpot(terrain, o.x, o.z, 2000);
    const heading = pickRunwayHeading(terrain, spot.x, spot.z);
    const fieldAlt = Math.max(20, terrain.heightAt(spot.x, spot.z));
    flattenRunway(terrain, spot.x, spot.z, heading, fieldAlt);
    return world.spawn(new Airbase({
      ...o, x: spot.x, z: spot.z, runwayHeading: heading, serviceSlots: 2,
    }).groundTo(terrain));
  };

  /**
   * 出撃時の散らばり（§70.11）。**同じ面でも毎回まったく同じ戦いにならないように。**
   *
   * §70 で当否の抽選を全部消したら、**18種すべてが秒まで同一**になった（§70.10）。
   * 種が動かしていたのは実質ミサイルの抽選だけで、それが無くなったため。
   * 上の `rng` のコメントにある「**地図は同じ、戦闘の綾は毎回違う**」（§24.2）が、
   * 綾のほうを失って成立しなくなっていた。
   *
   * 地形の種は面ごとに固定のまま（ブリーフィングの地形読みが成立する条件・§3）。
   * **散らばりは初期配置のほうに持たせる。**
   * 実戦でも編隊がまったく同じ位置・同じ針路で会敵することはない。
   *
   * **決定論的な戦闘 × 揺れる初期条件** —— これで
   * 「運ではなく状況で勝敗が決まる」という形になる。
   *
   * **チュートリアルには掛けない。** 手順が特定の位置と距離を前提にしている。
   * ステージ側から `spread: 0` で切ることもできる。
   */
  const spread = asTutorial ? 0 : (stage.spread ?? 1);
  const jit = (amount) => (spread ? (world.rng() - 0.5) * 2 * amount * spread : 0);

  // --- 自軍 ---
  const f = stage.friendly;
  const base = placeAirbase({ name: '自軍飛行場', side: SIDE.BLUE, tags: ['home'], ...f.base });
  world.playerBase = base;
  if (f.base && f.base.known) knownToEnemy.push(base);

  for (const g of f.ground || []) {
    const u = world.spawn(new GroundUnit({ ...g, side: SIDE.BLUE }).groundTo(terrain));
    if (g.known) knownToEnemy.push(u);
  }

  f.aircraft.forEach((a, i) => {
    const loadout = (loadouts && loadouts[i]) || a.loadout;
    if (f.startAirborne) {
      // **出撃位置を指定できる**（§40）。敵側は最初から x/z を持っていたが、
      // 自軍は飛行場の近くに並べるだけだった。護衛のように
      // 「被護衛機より前に出た状態で始める」構図が作れない。
      const x = (a.x ?? (base.pos.x + 1500 + i * 1200)) + jit(SPAWN_SPREAD_XZ);
      const z = (a.z ?? (base.pos.z - 1500 - i * 900)) + jit(SPAWN_SPREAD_XZ);
      const ac = world.spawn(new Aircraft({
        type: a.type, name: a.name, side: SIDE.BLUE, loadout,
        x, z,
        alt: Math.max(0, terrain.heightAt(x, z)) + (f.startAlt || 4000) + jit(SPAWN_SPREAD_ALT),
        heading: Math.PI * 0.35 + jit(SPAWN_SPREAD_HDG),
      }));
      ac.airbase = base;
      ac.patrolArea = { x: ac.pos.x, z: ac.pos.z, alt: ac.pos.y, radius: 4500 };
      applyAutoWeapons(ac, a);
    } else {
      const ac = world.spawn(new Aircraft({
        type: a.type, name: a.name, side: SIDE.BLUE, loadout,
        x: base.pos.x, z: base.pos.z, alt: base.pos.y,
      }));
      ac.baseLoadout = loadout.slice();
      base.onArrive(ac);
      ac.state = 'ready';           // ブリーフィングで整備済みとして扱う
      base.queue = base.queue.filter((q) => q !== ac);
      applyAutoWeapons(ac, a);
    }
  });

  // 出撃前に消費した兵装ポイントを引く
  // **値段は `data/weapons.js` の1か所から取る**（§74.5）。
  //
  // ここには `WEAPON_COST` という**2つ目の値段表**があった。`AGM` だけ 5（正は 4）で、
  // ブリーフィングの表示（`loadoutCost`）と実際の消費が食い違い、
  // **帰投後の再装備だけがまた別の値段**（`airbase.js` は `getWeapon().cost` を見る）
  // という三重の食い違いになっていた。同じ数字を2か所に書くと必ずこうなる。
  world.weaponPoints = stage.weaponPoints - (loadouts || []).reduce(
    (n, l) => n + loadoutCost(l), 0);

  // --- 敵 ---
  const e = stage.enemy;
  for (const key of ['base', 'base2']) {
    const b = e[key];
    if (!b) continue;
    const ab = placeAirbase({ name: key === 'base' ? '敵飛行場' : '敵飛行場 2', side: SIDE.RED, ...b });
    if (b.known) known.push(ab);
    if (b.reinforce) reinforcements.push({ airbase: ab, config: b.reinforce });
  }

  for (const a of e.aircraft || []) {
    // 散らばりは**哨戒の中心もろとも**ずらす。配置だけ動かすと
    // 30秒ほどで元の周回に戻ってしまい、散らばりが消える。
    const ex = a.x + jit(SPAWN_SPREAD_XZ);
    const ez = a.z + jit(SPAWN_SPREAD_XZ);
    const u = world.spawn(new Aircraft({
      type: a.type, name: a.name, side: SIDE.RED, tags: a.tags,
      x: ex, z: ez,
      alt: Math.max(0, terrain.heightAt(ex, ez)) + (a.agl || 5000) + jit(SPAWN_SPREAD_ALT),
      heading: Math.PI + jit(SPAWN_SPREAD_HDG), loadout: a.loadout || defaultEnemyLoadout(a.type),
      // 練度はステージ既定 → 機体ごとの指定 の順で上書きできる
      skill: a.skill ?? stage.enemy?.skill ?? 1,
    }));
    u.aiMode = a.aiMode || 'PATROL';
    // **敵側にも効かせる**（§49）。チュートリアルの「無害な的」は
    // 機銃まで切らないと無害にならない — 機銃は搭載リストに載らない
    // 固定装備なので、`loadout: []` では黙ってくれない。
    applyAutoWeapons(u, a);
    // 敵もプレイヤーと同じ規則で電波管制を行う（§30.4）。
    //
    // §26.6 では保留にしていた。当時は自軍飛行場のレーダーが 60km あって
    // 戦域を丸ごと覆っていたので、**敵が黙っても何も起きなかった**（0/6）。
    // 射程を地図の縮尺に合わせた（§30.2）ら、進出距離の長いステージで
    // **6/6 の種が動く**ようになったので、規則を揃えた。
    u.radarMode = a.radarMode || 'auto';
    if (a.moveTo) {
      // 目的地を持つ敵機（支援機と同じ書き方）。哨戒ではなく一方向へ進む。
      const alt = Math.max(0, terrain.heightAt(a.moveTo.x, a.moveTo.z)) + (a.moveTo.agl || 4000);
      u.patrolArea = { x: a.moveTo.x, z: a.moveTo.z, alt, radius: 4500 };
      u.setOrder({ type: 'move', x: a.moveTo.x, z: a.moveTo.z, alt });
    } else {
      u.patrolArea = { x: ex, z: ez, alt: u.pos.y, radius: 4500 };
      u.setOrder({ type: 'orbit', x: ex, z: ez, alt: u.pos.y, radius: 4500 });
    }
    if (a.strikeTargetTag) u._strikeTargetTag = a.strikeTargetTag;
    if (a.known) known.push(u);
  }

  for (const g of e.ground || []) {
    const u = world.spawn(new GroundUnit({ ...g, side: SIDE.RED }).groundTo(terrain));
    if (g.known) known.push(u);
  }

  // 味方の支援機（輸送機など）
  for (const s of stage.friendly.support || []) {
    const u = world.spawn(new Aircraft({
      type: s.type, name: s.name, side: SIDE.BLUE, tags: s.tags, loadout: [],
      x: s.x, z: s.z, alt: Math.max(0, terrain.heightAt(s.x, s.z)) + (s.agl || 4000),
      heading: Math.PI * 0.35,
    }));
    u.aiMode = s.aiMode || 'TRANSIT';
    // **支援機はプレイヤーの指揮下に置かない**（§80.4）。
    //
    // ESCORT の輸送機は「守る対象」であって、動かす駒ではない。
    // 選べてしまうと、進路を変えたり降ろしたりして
    // **護衛そのものが成立しなくなる**（離脱地点へ行かせなければ終わらない面）。
    // ステージ側で `commandable: true` と書けば従来どおり操作できる。
    u.commandable = s.commandable === true;
    if (s.moveTo) {
      const alt = Math.max(0, terrain.heightAt(s.moveTo.x, s.moveTo.z)) + (s.moveTo.alt || 4000);
      u.setOrder({ type: 'move', x: s.moveTo.x, z: s.moveTo.z, alt });
      u.patrolArea = { x: s.moveTo.x, z: s.moveTo.z, alt, radius: 3000 };
    }
  }

  // 爆撃機の攻撃目標を解決する
  for (const u of world.units) {
    if (!u._strikeTargetTag) continue;
    const t = world.units.find((x) => x.tags.includes(u._strikeTargetTag));
    if (t) { u.strikeTarget = t; u.aiMode = 'STRIKE'; }
  }

  return { known, knownToEnemy, reinforcements };
}

/**
 * ステージ定義から自動使用の可否を写す（`autoWeapons: { ARM: false }`）。
 *
 * 兵装チュートリアルで要る。「攻撃を指示 → 兵装を指定 → 撃つ」という手順は、
 * AI が指定より先に撃ち尽くすと**兵装の欄からその兵装が消えて手順が進まなくなる**。
 * 射程22kmのARMは攻撃指示を出した時点でもう撃てるので、必ずそうなっていた。
 *
 * **敵側にも同じものを掛ける。** `GUN` を切れる口はここしかない。
 */
function applyAutoWeapons(ac, def) {
  if (!def.autoWeapons) return;
  for (const [id, on] of Object.entries(def.autoWeapons)) ac.autoWeapons[id] = on;
}

/** ブリーフィングで判明していた敵を、記憶コンタクトとして地図に載せる */
function seedKnownContacts(world, units, side = world.playerSide) {
  const map = world.detection.contactsFor(side);
  for (const u of units) {
    const c = new Contact(u, 0);
    c.level = LEVEL.DETAILED;
    c.ever = true;
    c.detected = false;
    c.exactNow = false;
    // ブリーフィングの座標は正確。誤差0で入れておけば、そのあと逆探知だけで
    // 捉え直しても**精度が落ちない**（§25.3 の「良かった測定を残す」が効く）。
    c.err = 0;
    c.pos.copy(u.pos);
    map.set(u.id, c);
  }
}

/**
 * 敵機の既定搭載。
 * 機種を見ずに一律で空対空を積むと、爆撃機が爆弾を1発も持たないまま
 * 目標上空へ飛んで対空砲に落ちるだけになる（実際そうなっていた）。
 */
/** 敵飛行場からの増援 */
function spawnReinforcement(world, airbase, type, index, tags) {
  const ac = world.spawn(new Aircraft({
    type, name: `増援 ${index}`, side: airbase.side, tags,
    x: airbase.pos.x, z: airbase.pos.z, alt: airbase.pos.y,
    // **機種に合った搭載を積む**（§74.2）。ここは長く
    // `['AAM-M','AAM-S','AAM-S']` の決め打ちだった —— `defaultEnemyLoadout` の
    // 注記が警告しているそのもので、**爆撃機の増援が爆弾を1発も持たない**。
    // 既存面の増援は J-7 だけなので同じ値になり、露見していなかった。
    loadout: defaultEnemyLoadout(type),
    skill: world.enemySkill ?? 1,
  }));
  ac.baseLoadout = ac.loadout.slice();
  airbase.onArrive(ac);
  ac.state = 'ready';
  airbase.queue = airbase.queue.filter((q) => q !== ac);
  airbase.launch(ac, world);
  ac.aiMode = 'PURSUIT';
  // 増援もステージ配置の敵と同じ扱い（§30.4）。既定が 'auto' なので明示は要らないが、
  // ここを書き忘れると**増援だけ規則が違う**という食い違いが起きる（実際に起きていた）。
  ac.radarMode = 'auto';
  if (airbase.side !== world.playerSide) {
    world.log(`敵飛行場から増援が発進しました`);
  }
}

// ================================================================ 戦闘終了

function finishBattle() {
  battle.finished = true;
  const { stage, mission, world } = battle;
  const clear = mission.state === MISSION.CLEAR;

  // クリア評価（§18）。失敗時は付けない。
  const pointsUsed = (stage.weaponPoints ?? 0) - (world.weaponPoints ?? 0);
  const rating = clear
    ? evaluate(stage, { sec: loop.simTime, pointsUsed, losses: battle.losses })
    : null;
  const bestBefore = progress.ratings[stage.id] || null;

  if (clear) {
    progress = markCleared(progress, stage.id);
    if (rating) progress = markRating(progress, stage.id, rating.rank, RANKS);
    screens.progress = progress;
  }

  telemetry.end(clear ? 'clear' : 'fail', {
    sec: loop.simTime, kills: battle.kills, losses: battle.losses,
    pointsLeft: world.weaponPoints,
    rank: rating ? rating.rank : null,
  });
  battle.recorder.sample(loop.simTime);        // 最後の配置を残す
  battle.recorder.finish(clear ? 'clear' : 'fail', {
    sec: Math.round(loop.simTime), kills: battle.kills, losses: battle.losses,
    pointsLeft: world.weaponPoints, rank: rating ? rating.rank : null,
  });
  lastRecording = battle.recorder.toJSON();
  audio.setAlarm(0);
  audio.setEngine(0, 1);
  setTimeout(() => {
    el('hud').classList.add('hidden');
    audio.startMusic('menu');
    lastResult = {
      stage,
      seed: battle.seed,
      loadouts: battle.loadouts || [],
      result: clear ? 'clear' : 'fail',
      stats: {
        reason: mission.failReason || (clear ? '全目標を達成' : ''),
        time: formatTime(loop.simTime),
        kills: battle.kills,
        losses: battle.losses,
        points: world.weaponPoints,
        rating,
        best: bestBefore,
        newBest: !!(rating && isBetterRank(rating.rank, bestBefore)),
      },
    };
    screens.showResult(lastResult.stage, lastResult.result, lastResult.stats);
    battle = null;
  }, 1800);
}

// ================================================================ 撃墜処理・ログ

function handleDeaths(world) {
  for (const u of world.units) {
    if (u.alive || u._deathHandled) continue;
    u._deathHandled = true;
    const mine = u.side === world.playerSide;

    telemetry.mark(u.deathCause === 'withdraw' ? 'withdraw' : (mine ? 'loss' : 'kill'),
      loop.simTime, u, { cause: u.deathCause || '被弾', kind: u.kind });
    battle?.recorder?.event(
      u.deathCause === 'withdraw' ? 'withdraw' : (mine ? 'loss' : 'kill'),
      loop.simTime, { unit: u, pos: u.pos, cause: u.deathCause || '被弾' });

    // 戦域離脱は撃墜ではない。爆発も戦果カウントもしない。
    if (u.deathCause === 'withdraw') {
      if (mine || playerSees(world, u)) world.log(`${u.name} 戦域を離脱`);
      continue;
    }

    const air = u.kind === 'aircraft';

    // **見えていない敵の爆発は描かない。**
    // ログは既に見えているものだけに絞っていたのに、演出は誰にでも見えていた。
    // 「記憶している目標を攻撃したが、当たったか分からない」（§3）という
    // せっかくの状態が、爆発が上がるかどうかで**一目でばれていた**。
    if (mine || playerSees(world, u)) {
      world.effects.explosion(u.pos, air ? 420 : 520, air ? 'air' : 'ground');
      if (air) {
        u.forward(_deathVel).multiplyScalar(u.speed);
        world.effects.wreck(u.pos, _deathVel, 'aircraft');
      } else {
        world.effects.wreck(u.pos, null, 'ground');
      }
    }
    if (battle) { if (mine) battle.losses++; else battle.kills++; }
    const cause = u.deathCause === 'fuel' ? '燃料切れ'
      : u.deathCause === 'terrain' ? '地形衝突' : '撃破';

    // 見えていない敵の撃破はログに出さない。
    // 出すと「戦果が出た＝そこに敵がいた」と分かってしまい、フォグ・オブ・ウォーが崩れる。
    // 勝敗判定は内部の真の状態で行うので、ログを出さなくてもクリア判定には影響しない（§12）。
    if (mine || playerSees(world, u)) {
      world.log(`${mine ? '【損失】' : '【戦果】'} ${u.name} ${cause}`);
      audio.radio(mine ? 'bad' : 'good');
    }
  }
}

const _deathVel = new THREE.Vector3();

/** プレイヤーが今この敵を見えているか（記憶ではなく、実際に探知中か） */
function playerSees(world, u) {
  if (!world.detection) return true;
  const c = world.detection.contactsFor(world.playerSide).get(u.id);
  return !!(c && c.detected);
}

const logLines = [];
function pushLog(msg) {
  logLines.push(msg);
  if (audio && !/【損失】|【戦果】/.test(msg)) {
    audio.radio(/失敗|不足|残少/.test(msg) ? 'warn' : 'info');
  }
  if (logLines.length > 8) logLines.shift();
  const box = el('eventLog');
  if (box) box.innerHTML = logLines.map((l) => `<div class="log-row">${l}</div>`).join('');
}

// ================================================================ HUD

let hudFrames = 0;
function updateHudBar() {
  el('missionTime').textContent = formatTime(loop.simTime);
  if (++hudFrames % 15 === 0) {
    // 要求どおりの倍率が出ていないときは、その旨を出す。
    // 黙って遅くなると「倍速が効かない」という分かりにくい症状になる。
    const slow = !loop.paused && loop.effectiveSpeed < loop.speed * 0.75;
    el('perf').textContent = slow
      ? `${loop.fps.toFixed(0)} fps · 実効 x${loop.effectiveSpeed.toFixed(1)}`
      : `${loop.fps.toFixed(0)} fps`;
    el('perf').classList.toggle('slow', slow);
    renderObjectives();
  }
  el('pauseOverlay').classList.toggle('hidden', !loop.paused);
  syncSpeedButtons();
  el('weaponPoints').textContent = `${battle.world.weaponPoints} / ${battle.world.weaponPointsMax}`;
}

let objectivesKey = null;
function renderObjectives() {
  const box = el('objectives');
  if (!box || !battle) return;
  const status = battle.mission.status();
  // 目標を持たないステージ（チュートリアル）では箱ごと出さない。
  // 空の OBJECTIVES 枠が残ると、手順パネルの置き場所と取り合いになる。
  if (status.length === 0) {
    if (objectivesKey !== 'none') { box.innerHTML = ''; objectivesKey = 'none'; }
    return;
  }
  // **自軍だけ数える**（§71.1）。陣営を見ていなかったので、敵の増援が
  // 飛行場で待機している間じゅう「全機発進」が出ていた。押すと
  // `u.airbase.launch()` がそのまま通り、**敵の増援を発進させていた**。
  const ready = battle.world.units.filter(
    (u) => u.state === 'ready' && u.side === battle.world.playerSide).length;
  // 内容が変わらないうちは作り直さない（作り直すとホバー中のボタンが点滅する）
  const key = status.map((s) => s.state).join(',') + '|' + ready;
  if (key === objectivesKey) return;
  objectivesKey = key;

  const rows = status.map((s) => {
    const icon = s.state === 'done' ? '✔' : s.state === 'failed' ? '✖' : '・';
    return `<div class="obj-row ${s.state}">${icon} ${s.label}</div>`;
  }).join('');
  box.innerHTML = `<div class="panel-title">OBJECTIVES</div>${rows}`
    + (ready ? `<button id="launchAll" class="go small">全機発進 (${ready})</button>` : '');
}

/** Escメニュー。戦闘中に何も選択していない状態で Esc を押すと開く。 */
function setupPauseMenu() {
  const menu = el('pauseMenu');

  // メニューを開く前が止まっていたかを覚えておく。
  // 常に動かし直すと、自分で止めてから Esc を押した人の状態を勝手に解いてしまう。
  let wasPaused = false;
  const edBtn = menu.querySelector('[data-menu="editor"]');
  const open = () => {
    if (!battle || battle.finished) return;
    wasPaused = loop.paused;
    loop.setPaused(true);
    // 「エディタに戻る」は**自作ステージを遊んでいるときだけ**（§66.9）。
    // 試遊してから直す、の往復がこれで閉じる。
    if (edBtn) {
      const custom = isDebug() && battle.stage && battle.stage.custom;
      edBtn.classList.toggle('hidden', !custom);
    }
    menu.classList.remove('hidden');
  };
  const close = () => {
    menu.classList.add('hidden');
    loop.setPaused(wasPaused);
  };
  const leave = () => {
    menu.classList.add('hidden');
    el('hud').classList.add('hidden');
    destroyTutorial();
    battle = null;
    loop.setSpeed(1);
    loop.setPaused(false);
    audio.setAlarm(0);
    audio.setEngine(0, 1);
    audio.startMusic('menu');
  };

  window.addEventListener('at:menu', () => {
    if (menu.classList.contains('hidden')) open(); else close();
  });

  menu.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-menu]');
    if (!b) return;
    const stage = battle && battle.stage;
    const asTutorial = !!tutorial;
    switch (b.dataset.menu) {
      case 'resume':   close(); break;
      case 'briefing':
        leave();
        if (asTutorial && stage) screens.showTutorialBriefing(stage);
        else if (stage) screens.showBriefing(stage);
        break;
      case 'select':
        leave();
        if (asTutorial) screens.showTutorialSelect(); else screens.showStageSelect();
        break;
      case 'editor':
        if (!isDebug() || !stage) break;
        leave();
        screens.hide();
        // 試遊の直前に保存しているので、保管庫の側が最新（§66.9）
        editor.open(getCustom(stage.id) || stage);
        break;
      case 'title':    leave(); screens.showTitle(); break;
      default: break;
    }
  });
}

/**
 * 音量設定のUI。HUDの外に置いてあるので、タイトル・ブリーフィング中でも操作できる。
 * 値は即座に localStorage へ保存する（設定画面を閉じる操作を作らないため）。
 */
let lastMaster = 0.8;
function setupAudioUi() {
  const btn = el('audioBtn');
  const panel = el('audioPanel');

  const sync = () => {
    for (const input of panel.querySelectorAll('input[data-vol]')) {
      const k = input.dataset.vol;
      input.value = String(Math.round(audio.vol[k] * 100));
      panel.querySelector(`b[data-volv="${k}"]`).textContent = input.value;
    }
    const muted = audio.vol.master < 0.01;
    btn.classList.toggle('muted', muted);
    btn.innerHTML = muted ? '&#10005;' : '&#9834;';
  };
  if (audio.vol.master >= 0.01) lastMaster = audio.vol.master;
  sync();

  btn.addEventListener('click', () => { panel.classList.toggle('hidden'); sync(); });
  panel.addEventListener('input', (e) => {
    const k = e.target.dataset.vol;
    if (!k) return;
    const v = Number(e.target.value) / 100;
    audio.setVolume(k, v);
    if (k === 'master' && v >= 0.01) lastMaster = v;
    saveSettings(progress, { [k]: v });
    sync();
  });

  // 更新履歴は Esc でも閉じられるようにする（戦闘中の Esc メニューとは独立）
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Escape' && isChangelogOpen()) {
      e.stopPropagation();
      hideChangelog();
    }
  }, true);

  window.addEventListener('keydown', (e) => {
    if (e.code !== 'KeyM' || e.ctrlKey || e.altKey || e.metaKey) return;
    if (e.target && /INPUT|TEXTAREA/.test(e.target.tagName)) return;
    const muted = audio.vol.master < 0.01;
    const v = muted ? lastMaster : 0;
    audio.setVolume('master', v);
    saveSettings(progress, { master: v });
    sync();
  });

  // ボタン類のクリック音。個別に付けて回るより取りこぼしが無い。
  document.addEventListener('click', (e) => {
    if (e.target.closest('button, .stage-card, .lo-slot')) audio.ui('click');
  }, true);
}

/**
 * 倍速ボタンと一時停止ボタンの表示。
 *
 * 押したときだけ更新すると、押していない経路で速度が変わったときに表示だけ取り残される。
 * 実際、前のミッションで x4 のまま次を始めると buildBattle が x1 に戻すのに
 * ボタンは x4 のままで、「x4 表示なのに等速」という状態になっていた。
 * 表示は常に loop の状態から作る。
 *
 * 速度と一時停止は別々に光る。止めているあいだも
 * 「再開したらこの速度」が分かるようにするため。
 */
let speedButtons = null;
let pauseButton = null;
function syncSpeedButtons() {
  if (speedButtons) {
    for (const b of speedButtons) b.classList.toggle('active', Number(b.dataset.speed) === loop.speed);
  }
  if (pauseButton) pauseButton.classList.toggle('paused', loop.paused);
}

function setupTimeControls() {
  const buttons = [...document.querySelectorAll('#speedCtl button[data-speed]')];
  speedButtons = buttons;
  pauseButton = el('btnPause');
  const sync = syncSpeedButtons;
  for (const b of buttons) {
    b.addEventListener('click', () => {
      const v = Number(b.dataset.speed);
      loop.setSpeed(v); sync();
      notify('speed', { speed: v });
    });
  }
  pauseButton.addEventListener('click', () => {
    loop.togglePause(); sync();
    notify('pause', { paused: loop.paused });
  });
  document.addEventListener('click', (e) => {
    if (e.target && e.target.id === 'launchAll' && battle) {
      let launched = false;
      for (const u of battle.world.units) {
        if (u.side !== battle.world.playerSide) continue;
        if (u.state === 'ready' && u.airbase) { u.airbase.launch(u, battle.world); launched = true; }
      }
      if (launched) notify('takeoff', {});
      renderObjectives();
    }
  });
  window.addEventListener('keydown', (e) => {
    if (e.target && /INPUT|TEXTAREA/.test(e.target.tagName)) return;
    switch (e.code) {
      case 'Space':
        // リプレイ中は再生の一時停止に使う（ui/replay.js が受ける）
        if (replay && replay.isOpen) break;
        e.preventDefault(); loop.togglePause(); sync();
        notify('pause', { paused: loop.paused });
        break;
      case 'BracketLeft':  loop.stepSpeed(-1); sync(); notify('speed', { speed: loop.speed }); break;
      case 'BracketRight': loop.stepSpeed(1); sync(); notify('speed', { speed: loop.speed }); break;
      case 'KeyH':         el('helpBox').classList.toggle('hidden'); break;
      default: break;
    }
  });
  sync();
}

// ================================================================ ミニマップ

class Minimap {
  constructor(canvas, terrain, rig, world, cmds, stage) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.terrain = terrain;
    this.rig = rig;
    this.world = world;
    this.commands = cmds;
    this.stage = stage;

    this.base = document.createElement('canvas');
    this.base.width = CELLS;
    this.base.height = CELLS;
    const bctx = this.base.getContext('2d');
    bctx.putImageData(terrain.buildMinimapImage(bctx), 0, 0);
    this.ctx.imageSmoothingEnabled = false;

    // **いまのミニマップを canvas 側に持たせる。**
    // 手続きは1度しか束ねないが、Minimap は戦闘ごとに作り直されるので、
    // 手続きが `this` を捕まえると**前の戦闘のミニマップを掴んだまま**になる
    canvas._minimap = this;
    if (!canvas._bound) {
      canvas._bound = true;
      canvas.addEventListener('mousedown', (e) => {
        const me = canvas._minimap;
        // 風の印の上では**視点を飛ばさない**。読もうとして押しただけで
        // 地図の隅へ飛ばされるのでは、なぞって読む道具にならない
        if (me && me.windBadge && me._onWindBadge(e)) return;
        const r = canvas.getBoundingClientRect();
        me.rig.lookAtPoint(
          ((e.clientX - r.left) / r.width) * MAP_SIZE,
          ((e.clientY - r.top) / r.height) * MAP_SIZE,
        );
      });
      // 風の印をなぞると方位と風速を出す（§88.15・プレイヤーの案）
      canvas.addEventListener('mousemove', (e) => {
        const me = canvas._minimap;
        if (!me) return;
        const on = !!(me.windBadge && me._onWindBadge(e));
        me.windHover = on;
        canvas.style.cursor = on ? 'help' : '';
        if (on) showWindInfo(me.world.clouds, e.clientX, e.clientY);
        else hideWindInfo();
      });
      canvas.addEventListener('mouseleave', () => {
        const me = canvas._minimap;
        if (me) me.windHover = false;
        canvas.style.cursor = '';
        hideWindInfo();
      });
    }
  }

  /** カーソルが風の印の上か。**描いた座標系（canvas の画素）で比べる** */
  _onWindBadge(e) {
    const b = this.windBadge;
    if (!b) return false;
    const r = this.canvas.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * this.canvas.width;
    const y = ((e.clientY - r.top) / r.height) * this.canvas.height;
    return Math.hypot(x - b.x, y - b.y) <= b.r;
  }

  draw() {
    const ctx = this.ctx;
    const W = this.canvas.width, H = this.canvas.height;
    ctx.drawImage(this.base, 0, 0, W, H);

    for (const u of this.world.units) {
      if (!u.alive || u.side !== this.world.playerSide) continue;
      const x = (u.pos.x / MAP_SIZE) * W, y = (u.pos.z / MAP_SIZE) * H;
      ctx.fillStyle = u.kind === 'aircraft' ? '#3d9bff' : '#4fc3ff';   // §80.9
      ctx.fillRect(x - 1.5, y - 1.5, 3, 3);
      if (this.commands.isSelected(u)) {
        ctx.strokeStyle = '#ffb648';
        ctx.lineWidth = 1;
        ctx.strokeRect(x - 3.5, y - 3.5, 7, 7);
      }
    }

    const det = this.world.detection;
    if (det) {
      for (const [, c] of det.contactsFor(this.world.playerSide)) {
        const x = (c.pos.x / MAP_SIZE) * W, y = (c.pos.z / MAP_SIZE) * H;
        ctx.globalAlpha = c.state === 'contact' ? 1 : c.state === 'memory' ? 0.55 : 0.7;
        ctx.fillStyle = c.level >= 1 ? '#ff4536' : '#e8e8e8';          // §80.9
        if (c.unit.static) {
          ctx.fillRect(x - 2, y - 2, 4, 4);
          if (c.state === 'memory') {
            ctx.strokeStyle = ctx.fillStyle;
            ctx.lineWidth = 1;
            ctx.strokeRect(x - 3.5, y - 3.5, 7, 7);
          }
        } else {
          ctx.beginPath();
          ctx.moveTo(x, y - 2.5); ctx.lineTo(x + 2.5, y);
          ctx.lineTo(x, y + 2.5); ctx.lineTo(x - 2.5, y);
          ctx.closePath(); ctx.fill();
        }
        ctx.globalAlpha = 1;
      }
    }

    // 到達目標（護衛の行き先など）
    for (const o of this.stage?.objectives || []) {
      if (o.type !== 'reach') continue;
      const x = (o.x / MAP_SIZE) * W, y = (o.z / MAP_SIZE) * H;
      const r = ((o.radius || 3000) / MAP_SIZE) * W;
      ctx.strokeStyle = '#ffb648';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(x, y, Math.max(3, r), 0, Math.PI * 2);
      ctx.stroke();
    }

    const t = this.rig.target;
    const px = (t.x / MAP_SIZE) * W, py = (t.z / MAP_SIZE) * H;
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(-this.rig.azimuth);
    const reach = (this.rig.distance / MAP_SIZE) * W * 1.1;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(-reach * 0.55, -reach);
    ctx.lineTo(reach * 0.55, -reach);
    ctx.closePath();
    ctx.fillStyle = 'rgba(255, 182, 72, 0.14)';
    ctx.fill();
    ctx.restore();

    // 風（§88.15）。**雲がどちらへ流れるか**を地図の向きのまま出す。
    // 数字ではなく矢印なのは、**読むのではなく見て分かる**ため ——
    // 数字（方位と風速）は**なぞったときだけ**出す（プレイヤーの案）。
    const cl = this.world.clouds;
    this.windBadge = null;
    if (cl && cl.active && cl.windSpeed > 0) {
      const bx = W - 22, by = H - 22, br = 14;
      // **描いた場所をそのまま当たり判定にする** —— 別に書くとずれる
      this.windBadge = { x: bx, y: by, r: br };
      const lit = this.windHover;
      ctx.save();
      ctx.translate(bx, by);
      ctx.fillStyle = lit ? 'rgba(10, 24, 30, 0.92)' : 'rgba(8, 16, 22, 0.6)';
      ctx.beginPath(); ctx.arc(0, 0, br, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = lit ? 'rgba(111, 216, 232, 0.9)' : 'rgba(111, 216, 232, 0.4)';
      ctx.lineWidth = 1; ctx.stroke();
      // 流れていく向き＝風向＋180。地図は北が上なので、そのまま回せばよい
      ctx.rotate((cl.windDeg + 180) * Math.PI / 180);
      ctx.strokeStyle = lit ? '#d8f4fb' : '#9fd8ea';
      ctx.fillStyle = lit ? '#d8f4fb' : '#9fd8ea';
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(0, 8); ctx.lineTo(0, -4); ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, -10); ctx.lineTo(-4.5, -2.5); ctx.lineTo(4.5, -2.5);
      ctx.closePath(); ctx.fill();
      ctx.restore();
    } else if (this.windHover) {
      this.windHover = false;
      hideWindInfo();
    }

    ctx.strokeStyle = 'rgba(111, 216, 232, 0.35)';
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, W - 1, H - 1);
  }
}

/** 8方位の呼び名。**方位を地図の向きへ読み替える手間**を省くために出す */
const COMPASS8 = ['北', '北東', '東', '南東', '南', '南西', '西', '北西'];
function compass8(deg) {
  return COMPASS8[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
}

/**
 * ミニマップの風の印をなぞったときに出す数字（§88.15・プレイヤーの案）。
 *
 * 矢印は**どちらへ流れるか**しか言わない。方位と風速はここで補う ——
 * **常時は出さない。** 常に画面にある数字は読まれなくなるし、
 * 知りたくなるのは「あとどれくらいで切れ目が来るか」を考える一瞬だけ。
 *
 * **10分でどれだけ動くか**も併せて出す。m/s のままでは
 * 「切れ目が目標の上に来るまで」を見積もるのに遠い。
 */
function showWindInfo(cl, px, py) {
  const box = el('hoverInfo');
  if (!box || !cl || !cl.active || !cl.windSpeed) return;
  const deg = Math.round(cl.windDeg);
  const km = (cl.windSpeed * 600 / 1000).toFixed(1);
  box.innerHTML = `風 ${String(deg).padStart(3, '0')}°（${compass8(deg)}）から ${cl.windSpeed} m/s`
    + `<br><span class="hi-dist">雲は ${compass8(deg + 180)} へ 10分で ${km}km</span>`;
  box.dataset.wind = '1';
  box.classList.remove('hidden');
  // 印は画面の右端にあるので、**そのまま右下に出すとはみ出す。**
  // 幅を測ってから、収まらない側は反対へ回す
  const left = px + 16 + box.offsetWidth > window.innerWidth ? px - 16 - box.offsetWidth : px + 16;
  const top = py + 16 + box.offsetHeight > window.innerHeight ? py - 16 - box.offsetHeight : py + 16;
  box.style.left = `${Math.max(4, left)}px`;
  box.style.top = `${Math.max(4, top)}px`;
}

/** 風の欄を閉じる。**ユニットの欄まで閉じない**ように出どころを見る */
function hideWindInfo() {
  const box = el('hoverInfo');
  if (!box || box.dataset.wind !== '1') return;
  delete box.dataset.wind;
  box.classList.add('hidden');
}

// ================================================================ その他


function buildMapBoundary() {
  const y = 60;
  const pts = [
    new THREE.Vector3(0, y, 0), new THREE.Vector3(MAP_SIZE, y, 0),
    new THREE.Vector3(MAP_SIZE, y, MAP_SIZE), new THREE.Vector3(0, y, MAP_SIZE),
    new THREE.Vector3(0, y, 0),
  ];
  const geo = new THREE.BufferGeometry().setFromPoints(pts);
  const mat = new THREE.LineBasicMaterial({ color: 0x6fd8e8, transparent: true, opacity: 0.35 });
  const line = new THREE.Line(geo, mat);
  line.name = 'mapBoundary';
  return line;
}

function nextFrame() {
  return new Promise((resolve) => {
    let done = false;
    const fire = () => { if (!done) { done = true; resolve(); } };
    requestAnimationFrame(fire);
    setTimeout(fire, 60);
  });
}
