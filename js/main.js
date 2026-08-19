// ANGELS TWENTY — エントリポイント
//
// 画面遷移: ミッション選択 → ブリーフィング → 戦闘 → 戦果
// 戦闘はステージ定義（data/stages.js）から毎回組み立て直す。

import * as THREE from 'three';
import { Terrain, MAP_SIZE, CELLS } from './world/terrain.js';
import { SceneManager, attachCameraControls } from './world/scene.js';
import {
  createAircraftView, syncAircraftView, aircraftDisplayLength,
  createGroundView, syncGroundView, groundDisplayScale,
} from './world/models.js';
import { ContactRenderer } from './world/contacts.js';
import { Effects } from './world/effects.js';
import { GameLoop, formatTime } from './core/loop.js';
import { makeRng } from './core/rng.js';
import { loadProgress, markCleared, resetProgress, saveSettings } from './core/save.js';
import { AudioManager } from './core/audio.js';
import * as telemetry from './core/telemetry.js';
import { Aircraft } from './sim/aircraft.js';
import { GroundUnit, findFlatSpot } from './sim/ground.js';
import { Airbase, pickRunwayHeading } from './sim/airbase.js';
import { DetectionSystem, Contact, LEVEL } from './sim/detection.js';
import { CombatSystem } from './sim/combat.js';
import { Mission, MISSION } from './sim/mission.js';
import { SIDE } from './sim/unit.js';
import { PilotAI } from './ai/pilot.js';
import { pruneFormations } from './ai/formation.js';
import { CommandController } from './ui/commands.js';
import { Hud } from './ui/hud.js';
import { ScreenManager } from './ui/briefing.js';
import { isChangelogOpen, hideChangelog } from './ui/changelog.js';
import { STAGES } from './data/stages.js';
import { getType } from './data/aircraft.js';

const el = (id) => document.getElementById(id);

window.addEventListener('error', (e) => showFatal(e.error || e.message));
window.addEventListener('unhandledrejection', (e) => showFatal(e.reason));

let scene = null;
let screens = null;
let loop = null;
let commands = null;
let hud = null;
let minimap = null;
let updateCameraInput = null;
let progress = loadProgress();
let audio = null;

/** 現在の戦闘。ステージを開始するたびに作り直す。 */
let battle = null;

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
  });
  screens.onReset = () => { progress = resetProgress(); screens.progress = progress; };

  audio = new AudioManager(progress.settings);
  setupAudioUi();

  loop = new GameLoop(fixedUpdate, render);
  setupTimeControls();

  setupPauseMenu();
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
    scene, loop, screens, progress, audio, stages: STAGES, telemetry,
    /** 検証用: ステージを直接開始する（ブリーフィング既定の兵装で出撃） */
    startStage(i) { screens.showBriefing(STAGES[i]); startBattle(STAGES[i], screens.loadouts.map((l) => l.slice())); },
  };
}

// ================================================================ ループ

function fixedUpdate(dt) {
  if (!battle) return;
  const { world, detection, combat, pilotAI, mission } = battle;
  for (const u of world.units) u.update(dt, world);
  detection.update(dt);
  pilotAI.update(dt);
  combat.update(dt);
  handleDeaths(world);
  pruneFormations(world);
  mission.update(dt);

  if (mission.state !== MISSION.ACTIVE && !battle.finished) finishBattle();
}

function render(alpha, realDt) {
  updateCameraInput(realDt);
  scene.update(realDt);

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
    for (const u of world.units) {
      const mine = u.side === world.playerSide;
      const visible = mine || contacts.showsBody(u);
      if (u.kind === 'aircraft') syncAircraftView(u, terrain, size, commands.isSelected(u), visible);
      else syncGroundView(u, groundDisplayScale(scene.rig.distance, scene.camera, u.spec.size), visible);
    }
    contacts.update(scene.camera, terrain, size, battle.detection.time);
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

function startBattle(stage, loadouts) {
  screens.hide();
  el('loading').classList.remove('hidden');
  el('loading').querySelector('.loading-msg').textContent = 'GENERATING TERRAIN...';

  // 生成が重いので、ローディング表示を確実に出してから作る
  // （nextFrame は rAF が止まるバックグラウンドタブでもタイマーで進む）
  nextFrame().then(() => nextFrame()).then(() => {
    try {
      buildBattle(stage, loadouts);
      el('loading').classList.add('hidden');
      el('hud').classList.remove('hidden');
      audio.startMusic('battle');
    } catch (e) { showFatal(e); }
  });
}

function buildBattle(stage, loadouts) {
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
    rng: makeRng((stage.terrain.seed ^ 0x7f3d9a) >>> 0),
    log: pushLog,
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
    spawn(unit) {
      this.units.push(unit);
      scene.add(unit.kind === 'aircraft' ? createAircraftView(unit) : createGroundView(unit));
      return unit;
    },
  };

  const spawned = spawnStage(world, stage, loadouts, terrain);

  scene.add(terrain.buildMesh());
  scene.add(buildMapBoundary());

  world.detection = new DetectionSystem(world);
  world.effects = new Effects(scene.world);
  const combat = new CombatSystem(world);
  const pilotAI = new PilotAI(world);
  world.formations = [];

  const mission = new Mission(world, stage);
  world.spawnReinforcement = (airbase, type, index) =>
    spawnReinforcement(world, airbase, type, index);
  for (const { airbase, config } of spawned.reinforcements) {
    mission.registerReinforcement(airbase, config);
  }

  // ブリーフィングで判明していた敵は、開始時から記憶コンタクトとして地図に出す
  seedKnownContacts(world, spawned.known);

  world.effects.onExplosion = (pos, size, kind) => audio.explosion(pos, size, kind);

  world.onFire = (shooter, target, weapon, missile) => {
    if (shooter.side === world.playerSide) {
      world.log(`${shooter.name} ${weapon.id} 発射`);
      telemetry.markShot(weapon.id);
    }
    world.effects.launchFlash(shooter.pos, missile ? missile.dir : null);
    audio.missileLaunch(shooter.pos);
  };
  world.onDecoyed = (m) => {
    if (m.target && m.target.side === world.playerSide) world.log(`${m.target.name} デコイ有効`);
  };
  world.onDecoy = (unit) => audio.flare(unit.pos);
  world.onMissileHit = (m) => {
    if (m.side === world.playerSide) telemetry.markHit(m.weapon.id);
  };
  // 機銃の命中にも曳光弾の演出を出す（当たっているのが見えないと分からない）
  world.onGunHit = (shooter, target) => {
    if (world.rng() < 0.3) world.effects.tracer(shooter.pos, target.pos, shooter.side);
    audio.gunHit(target.pos);
  };
  world.onGunFire = (shooter) => {
    world.effects.muzzle(shooter.pos);
    audio.gunBurst(shooter.pos, shooter.id);
  };

  const contacts = new ContactRenderer(scene.world, world.detection, SIDE.BLUE);

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
  else { hud.world = world; hud.commands = commands; }

  minimap = new Minimap(el('minimap'), terrain, scene.rig, world, commands);

  logLines.length = 0;
  objectivesKey = null;
  telemetry.begin(stage, loadouts);
  pushLog(`任務 ${stage.name} 開始`);

  battle = {
    stage, world, terrain, detection: world.detection, combat, pilotAI,
    mission, contacts, finished: false,
    kills: 0, losses: 0,
  };

  // 初期カメラ
  const lead = world.units.find((u) => u.side === SIDE.BLUE && u.kind === 'aircraft');
  if (lead) {
    scene.rig.lookAtPoint(lead.pos.x, lead.pos.z);
    scene.rig._target.set(lead.pos.x, lead.pos.y, lead.pos.z);
    commands.select([lead]);
  }
  scene.rig.distance = 16000;
  scene.rig._distance = 16000;

  el('missionName').textContent = `${stage.name} — ${stage.title}`;
  loop.simTime = 0;
  loop.setSpeed(1);
  renderObjectives();
}

/** ステージ定義からユニットを並べる */
function spawnStage(world, stage, loadouts, terrain) {
  const known = [];
  const reinforcements = [];

  const placeAirbase = (o) => {
    const spot = findFlatSpot(terrain, o.x, o.z, 2000);
    const heading = pickRunwayHeading(terrain, spot.x, spot.z);
    const fieldAlt = Math.max(20, terrain.heightAt(spot.x, spot.z));
    const dir = { x: Math.sin(heading), z: -Math.cos(heading) };
    terrain.flattenStrip(
      spot.x - dir.x * 2400, spot.z - dir.z * 2400,
      spot.x + dir.x * 1500, spot.z + dir.z * 1500,
      650, fieldAlt, 900,
    );
    return world.spawn(new Airbase({
      ...o, x: spot.x, z: spot.z, runwayHeading: heading, serviceSlots: 2,
    }).groundTo(terrain));
  };

  // --- 自軍 ---
  const f = stage.friendly;
  const base = placeAirbase({ name: '自軍飛行場', side: SIDE.BLUE, tags: ['home'], ...f.base });
  world.playerBase = base;

  for (const g of f.ground || []) {
    world.spawn(new GroundUnit({ ...g, side: SIDE.BLUE }).groundTo(terrain));
  }

  f.aircraft.forEach((a, i) => {
    const loadout = (loadouts && loadouts[i]) || a.loadout;
    if (f.startAirborne) {
      const x = base.pos.x + 1500 + i * 1200;
      const z = base.pos.z - 1500 - i * 900;
      const ac = world.spawn(new Aircraft({
        type: a.type, name: a.name, side: SIDE.BLUE, loadout,
        x, z, alt: Math.max(0, terrain.heightAt(x, z)) + (f.startAlt || 4000),
        heading: Math.PI * 0.35,
      }));
      ac.airbase = base;
      ac.patrolArea = { x: ac.pos.x, z: ac.pos.z, alt: ac.pos.y, radius: 4500 };
    } else {
      const ac = world.spawn(new Aircraft({
        type: a.type, name: a.name, side: SIDE.BLUE, loadout,
        x: base.pos.x, z: base.pos.z, alt: base.pos.y,
      }));
      ac.baseLoadout = loadout.slice();
      base.onArrive(ac);
      ac.state = 'ready';           // ブリーフィングで整備済みとして扱う
      base.queue = base.queue.filter((q) => q !== ac);
    }
  });

  // 出撃前に消費した兵装ポイントを引く
  world.weaponPoints = stage.weaponPoints
    - (loadouts || []).reduce((n, l) => n + l.reduce((m, id) => m + (WEAPON_COST[id] || 0), 0), 0);

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
    const u = world.spawn(new Aircraft({
      type: a.type, name: a.name, side: SIDE.RED, tags: a.tags,
      x: a.x, z: a.z, alt: Math.max(0, terrain.heightAt(a.x, a.z)) + (a.agl || 5000),
      heading: Math.PI, loadout: a.loadout || defaultEnemyLoadout(a.type),
      // 練度はステージ既定 → 機体ごとの指定 の順で上書きできる
      skill: a.skill ?? stage.enemy?.skill ?? 1,
    }));
    u.aiMode = a.aiMode || 'PATROL';
    u.patrolArea = { x: a.x, z: a.z, alt: u.pos.y, radius: 4500 };
    u.setOrder({ type: 'orbit', x: a.x, z: a.z, alt: u.pos.y, radius: 4500 });
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

  return { known, reinforcements };
}

/** 兵装コスト（data/weapons.js を都度importしないための表） */
const WEAPON_COST = { 'AAM-S': 0, 'AAM-M': 2, 'AAM-A': 6, AGM: 5, ARM: 6, BOMB: 0, TANK: 0 };

/** ブリーフィングで判明していた敵を、記憶コンタクトとして地図に載せる */
function seedKnownContacts(world, units) {
  const map = world.detection.contactsFor(world.playerSide);
  for (const u of units) {
    const c = new Contact(u, 0);
    c.level = LEVEL.DETAILED;
    c.ever = true;
    c.detected = false;
    c.exactNow = false;
    c.pos.copy(u.pos);
    map.set(u.id, c);
  }
}

/**
 * 敵機の既定搭載。
 * 機種を見ずに一律で空対空を積むと、爆撃機が爆弾を1発も持たないまま
 * 目標上空へ飛んで対空砲に落ちるだけになる（実際そうなっていた）。
 */
function defaultEnemyLoadout(type) {
  const spec = getType(type);
  if (!spec || spec.hardpoints === 0) return [];
  if (spec.role === '爆撃') return ['BOMB', 'BOMB', 'BOMB', 'BOMB', 'BOMB', 'BOMB', 'AAM-S'];
  if (spec.role === '対地') return ['AGM', 'AGM', 'AAM-S'];
  return ['AAM-M', 'AAM-S', 'AAM-S'];
}

/** 敵飛行場からの増援 */
function spawnReinforcement(world, airbase, type, index) {
  const ac = world.spawn(new Aircraft({
    type, name: `増援 ${index}`, side: airbase.side,
    x: airbase.pos.x, z: airbase.pos.z, alt: airbase.pos.y,
    loadout: ['AAM-M', 'AAM-S', 'AAM-S'],
    skill: world.enemySkill ?? 1,
  }));
  ac.baseLoadout = ac.loadout.slice();
  airbase.onArrive(ac);
  ac.state = 'ready';
  airbase.queue = airbase.queue.filter((q) => q !== ac);
  airbase.launch(ac, world);
  ac.aiMode = 'PURSUIT';
  if (airbase.side !== world.playerSide) world.log(`敵飛行場から増援が発進しました`);
}

// ================================================================ 戦闘終了

function finishBattle() {
  battle.finished = true;
  const { stage, mission, world } = battle;
  const clear = mission.state === MISSION.CLEAR;
  if (clear) { progress = markCleared(progress, stage.id); screens.progress = progress; }

  telemetry.end(clear ? 'clear' : 'fail', {
    sec: loop.simTime, kills: battle.kills, losses: battle.losses,
    pointsLeft: world.weaponPoints,
  });
  audio.setAlarm(0);
  audio.setEngine(0, 1);
  setTimeout(() => {
    el('hud').classList.add('hidden');
    audio.startMusic('menu');
    screens.showResult(stage, clear ? 'clear' : 'fail', {
      reason: mission.failReason || (clear ? '全目標を達成' : ''),
      time: formatTime(loop.simTime),
      kills: battle.kills,
      losses: battle.losses,
      points: world.weaponPoints,
    });
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

    // 戦域離脱は撃墜ではない。爆発も戦果カウントもしない。
    if (u.deathCause === 'withdraw') {
      if (mine || playerSees(world, u)) world.log(`${u.name} 戦域を離脱`);
      continue;
    }

    const air = u.kind === 'aircraft';
    world.effects.explosion(u.pos, air ? 420 : 520, air ? 'air' : 'ground');
    if (air) {
      u.forward(_deathVel).multiplyScalar(u.speed);
      world.effects.wreck(u.pos, _deathVel, 'aircraft');
    } else {
      world.effects.wreck(u.pos, null, 'ground');
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
    const slow = loop.speed > 0 && loop.effectiveSpeed < loop.speed * 0.75;
    el('perf').textContent = slow
      ? `${loop.fps.toFixed(0)} fps · 実効 x${loop.effectiveSpeed.toFixed(1)}`
      : `${loop.fps.toFixed(0)} fps`;
    el('perf').classList.toggle('slow', slow);
    renderObjectives();
  }
  el('pauseOverlay').classList.toggle('hidden', !loop.paused);
  el('weaponPoints').textContent = `${battle.world.weaponPoints} / ${battle.world.weaponPointsMax}`;
}

let objectivesKey = null;
function renderObjectives() {
  const box = el('objectives');
  if (!box || !battle) return;
  const status = battle.mission.status();
  const ready = battle.world.units.filter((u) => u.state === 'ready').length;
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

  const open = () => {
    if (!battle || battle.finished) return;
    loop.setSpeed(0);
    menu.classList.remove('hidden');
  };
  const close = () => {
    menu.classList.add('hidden');
    if (loop.paused) loop.setSpeed(loop.lastSpeed || 1);
  };
  const leave = () => {
    menu.classList.add('hidden');
    el('hud').classList.add('hidden');
    battle = null;
    loop.setSpeed(1);
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
    switch (b.dataset.menu) {
      case 'resume':   close(); break;
      case 'briefing': leave(); if (stage) screens.showBriefing(stage); break;
      case 'select':   leave(); screens.showStageSelect(); break;
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

function setupTimeControls() {
  const buttons = [...document.querySelectorAll('#speedCtl button')];
  const sync = () => {
    for (const b of buttons) b.classList.toggle('active', Number(b.dataset.speed) === loop.speed);
  };
  for (const b of buttons) {
    b.addEventListener('click', () => { loop.setSpeed(Number(b.dataset.speed)); sync(); });
  }
  document.addEventListener('click', (e) => {
    if (e.target && e.target.id === 'launchAll' && battle) {
      for (const u of battle.world.units) {
        if (u.state === 'ready' && u.airbase) u.airbase.launch(u, battle.world);
      }
      renderObjectives();
    }
  });
  window.addEventListener('keydown', (e) => {
    if (e.target && /INPUT|TEXTAREA/.test(e.target.tagName)) return;
    switch (e.code) {
      case 'Space':        e.preventDefault(); loop.togglePause(); sync(); break;
      case 'BracketLeft':  loop.stepSpeed(-1); sync(); break;
      case 'BracketRight': loop.stepSpeed(1); sync(); break;
      case 'KeyH':         el('helpBox').classList.toggle('hidden'); break;
      default: break;
    }
  });
  sync();
}

// ================================================================ ミニマップ

class Minimap {
  constructor(canvas, terrain, rig, world, cmds) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.terrain = terrain;
    this.rig = rig;
    this.world = world;
    this.commands = cmds;

    this.base = document.createElement('canvas');
    this.base.width = CELLS;
    this.base.height = CELLS;
    const bctx = this.base.getContext('2d');
    bctx.putImageData(terrain.buildMinimapImage(bctx), 0, 0);
    this.ctx.imageSmoothingEnabled = false;

    if (!canvas._bound) {
      canvas._bound = true;
      canvas.addEventListener('mousedown', (e) => {
        const r = canvas.getBoundingClientRect();
        this.rig.lookAtPoint(
          ((e.clientX - r.left) / r.width) * MAP_SIZE,
          ((e.clientY - r.top) / r.height) * MAP_SIZE,
        );
      });
    }
  }

  draw() {
    const ctx = this.ctx;
    const W = this.canvas.width, H = this.canvas.height;
    ctx.drawImage(this.base, 0, 0, W, H);

    for (const u of this.world.units) {
      if (!u.alive || u.side !== this.world.playerSide) continue;
      const x = (u.pos.x / MAP_SIZE) * W, y = (u.pos.z / MAP_SIZE) * H;
      ctx.fillStyle = u.kind === 'aircraft' ? '#5aa9ff' : '#8fd0ff';
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
        ctx.fillStyle = c.level >= 1 ? '#ff5b44' : '#e8e8e8';
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

    ctx.strokeStyle = 'rgba(111, 216, 232, 0.35)';
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, W - 1, H - 1);
  }
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
