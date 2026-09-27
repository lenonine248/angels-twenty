// c3 で「SAMから隠れられるか」の3回目。tools/_tossc3b.js の構造(loadStage/openScenario等)
// を必要な分だけ写して使う。ゲーム本体(js/)は一切変更しない。
//
// 問い: 高さを変えればSAMから隠れられたのか、道筋(どこを飛ぶか)を変えないと無理なのか。
//
// 測定A: 実際の航跡(T0・5か所×出発方位0/±15°の15本)で、SAMから見えた各瞬間について
//        同じx,zで高さだけ「地形+220m」にした点がSAMから見えるかを調べる(段階別)。
//        あわせて最初に見えた瞬間の詳細と、見えてから初弾発射までの秒数。
// 測定B: 目標の周り(距離2/3/4/5/6/8km×方位24方向)で、高さ「地形+220m」の点がSAMから
//        見えない方位を地形だけで調べる(本の実行なし)。
//
// 読み込み:
//   await fetch('/tools/_tossc3c.js').then(r => r.text()).then(eval);
// 実行(重いので直接awaitせず、fire-and-forgetしてポーリングで回収する):
//   window.__tc3cResult = null;
//   window.__tossC3cRun().then(r => window.__tc3cResult = r)
//     .catch(e => window.__tc3cResult = { error: String((e && e.stack) || e) });
// 回収:
//   window.__tc3cResult   // nullなら未完了
//
// 生ログは window.__tossC3cLastA / __tossC3cLastB に積む。
(() => {
  const DT = 1 / 30;
  const DEG = Math.PI / 180;
  const MAX_T = 260;
  const SAM_CLEARANCE = 8, SAM_STEP = 400; // hasLineOfSight(samPos, pos, 8, 400) を踏襲
  const RAISE = 220; // 「地形+220m」の検証高度

  const FALLBACK_STAGE = {
    id: 'c3', custom: true, name: 'NEW MISSION',
    terrain: { seed: 17878, mountainAmount: 0.8, coast: 'none', valleyDepth: 0.9, rivers: 2, baseAltitude: 400 },
    weaponPoints: 24,
    friendly: {
      base: { x: 10000, z: 40000 }, startAirborne: true, startAlt: 4500,
      aircraft: [{ type: 'A-3', name: 'test1', loadout: ['BOMB', 'BOMB', 'BOMB', 'BOMB'] }],
    },
    enemy: {
      skill: 0.6, aircraft: [],
      ground: [{ type: 'RADAR', name: '目標 1', x: 27393, z: 22711, tags: ['cap'], known: true }],
    },
  };

  function round(x, d = 0) { const k = 10 ** d; return x == null ? null : Math.round(x * k) / k; }
  function headingOf(dx, dz) { return Math.atan2(dx, -dz); }
  function offset(p, d, angle) { return { x: p.x + d * Math.sin(angle), z: p.z - d * Math.cos(angle) }; }
  function mean(arr) { const a = arr.filter((x) => x != null); return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null; }
  function median(arr) {
    const a = arr.filter((x) => x != null).slice().sort((x, y) => x - y);
    if (!a.length) return null;
    const mid = Math.floor(a.length / 2);
    return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
  }
  function sum(arr) { return arr.reduce((s, x) => s + (x || 0), 0); }
  // 目標を中心に、進入方位(bearing0)を0°、右90°、手前(基地側)180°、左270°とする角度系。
  // 正の向き = offset()のangle増加と同じ回転(コード内のS3=0°方向, S1=90°方向, S4=180°方向, S2=270°方向 と整合)。
  function thetaFromTarget(target0, bearing0, pos) {
    const dx = pos.x - target0.x, dz = pos.z - target0.z;
    const h = headingOf(dx, dz);
    let theta = (h - bearing0) / DEG;
    theta = ((theta % 360) + 360) % 360;
    return theta;
  }
  function circularMeanDeg(degs) {
    if (!degs.length) return { mean: null, R: null, n: 0 };
    let sx = 0, sy = 0;
    for (const d of degs) { sx += Math.cos(d * DEG); sy += Math.sin(d * DEG); }
    const n = degs.length;
    const R = Math.hypot(sx, sy) / n;
    let m = Math.atan2(sy / n, sx / n) / DEG;
    m = ((m % 360) + 360) % 360;
    return { mean: round(m, 0), R: round(R, 2), n };
  }
  // 連続したtrueの区間をまとめる(24方位・15°刻み・円環)。binsは長さ24のbool配列。
  function contiguousRanges(bins) {
    const n = bins.length;
    if (bins.every((b) => b)) return ['0-360(全周)'];
    if (bins.every((b) => !b)) return [];
    // trueでない先頭を探して回転し、単純な直線走査にする
    let start = 0;
    while (bins[start] && start < n) start++;
    if (start === n) return ['0-360(全周)'];
    const rotated = [];
    for (let i = 0; i < n; i++) rotated.push(bins[(start + i) % n]);
    const ranges = [];
    let i = 0;
    while (i < n) {
      if (rotated[i]) {
        let j = i;
        while (j < n && rotated[j]) j++;
        const a = ((start + i) % n) * 15;
        const b = ((start + j) % n) * 15; // exclusive end
        ranges.push(`${a}-${b === 0 ? 360 : b}`);
        i = j;
      } else i++;
    }
    return ranges;
  }

  async function loadStage() {
    try {
      const r = await fetch('/stages_out/new-mission-c3.json');
      if (r.ok) return await r.json();
    } catch (e) { /* fall through */ }
    return FALLBACK_STAGE;
  }

  function buildScenario(id, stage, base, extraGround) {
    const ground = (stage.enemy.ground || []).map((g) => ({ ...g }));
    if (extraGround) ground.push(...extraGround);
    return {
      id, group: '計測', name: 'TOSS C3C PROBE', title: '計測用（非表示）',
      battleSeed: 0xC30003,
      brief: '計測用の内部ステージ（c3の地形・配置を写す・SAM隠れ3回目）。', hint: '',
      terrain: { ...stage.terrain },
      weaponPoints: stage.weaponPoints || 24,
      noFail: true,
      friendly: {
        base: { ...base },
        startAirborne: true,
        startAlt: stage.friendly.startAlt,
        aircraft: stage.friendly.aircraft.map((a) => ({ ...a, autoWeapons: { BOMB: true } })),
      },
      enemy: { skill: stage.enemy.skill, aircraft: [], ground },
      steps: [{ text: '(計測用ダミー手順)', check: () => false }],
    };
  }

  async function openScenario(id, stage, base, extraGround) {
    if (!AT.tutorials.find((t) => t.id === id)) AT.tutorials.push(buildScenario(id, stage, base, extraGround));
    await __open(id);
    const b = AT.battle;
    const world = b.world;
    const u = world.units.find((x) => x.kind === 'aircraft' && x.side === world.playerSide);
    const target = world.units.find((x) => x.typeId === 'RADAR');
    const sams = world.units.filter((x) => x.typeId === 'SAM');
    return { world, u, target, sams };
  }

  // ================================================================= 測定A

  function runTrialA(ctx, cfg, target0, bearing0) {
    const { world, u, target, sams } = ctx;
    const sam = sams[0]; // このシナリオにはSAM1か所だけ
    const terrain = world.terrain;
    const targetXZ = { x: target.pos.x, z: target.pos.z };

    u.bombProfile = 'toss';
    u.setPlayerOrder({ type: 'attack', target });

    const samFireEvents = [];
    world.onFire = (shooter, tgt, weapon, m) => {
      if (sam && shooter === sam && weapon.kind === 'sam') samFireEvents.push({ t: AT.loop.simTime });
    };

    const stageKeys = ['farIn', 'nearIn', 'pull', 'out', 'evading', 'other'];
    const seenSec = {}, hiddenSec = {};
    for (const k of stageKeys) { seenSec[k] = 0; hiddenSec[k] = 0; }
    let firstSeen = null;
    const outThetas = [];

    let tick = 0;
    const maxTicks = Math.round(MAX_T / DT);
    for (; tick < maxTicks; tick++) {
      AT.loop.onFixedUpdate(DT);
      AT.loop.simTime += DT;
      const t = (tick + 1) * DT;
      const flat = Math.hypot(targetXZ.x - u.pos.x, targetXZ.z - u.pos.z);
      const phase = u.attackRun;

      if (phase === 'out') outThetas.push(thetaFromTarget(target0, bearing0, u.pos));

      if (sam && sam.alive) {
        const samFlat = Math.hypot(sam.pos.x - u.pos.x, sam.pos.z - u.pos.z);
        if (samFlat <= cfg.samRange && terrain.hasLineOfSight(sam.pos, u.pos, SAM_CLEARANCE, SAM_STEP)) {
          let stage;
          if (u.evading) stage = 'evading';
          else if (phase === 'in' && flat > 8000) stage = 'farIn';
          else if (phase === 'in' && flat <= 8000) stage = 'nearIn';
          else if (phase === 'pull') stage = 'pull';
          else if (phase === 'out') stage = 'out';
          else stage = 'other';

          seenSec[stage] += DT;
          const ground = terrain.heightAt(u.pos.x, u.pos.z);
          const raisedPos = { x: u.pos.x, y: ground + RAISE, z: u.pos.z };
          const hiddenIf220 = !terrain.hasLineOfSight(sam.pos, raisedPos, SAM_CLEARANCE, SAM_STEP);
          if (hiddenIf220) hiddenSec[stage] += DT;

          if (!firstSeen) {
            firstSeen = {
              t: round(t, 1), stage, flat: round(flat), alt: round(u.pos.y),
              agl: round(u.pos.y - ground), hiddenIf220,
            };
          }
        }
      }

      if (!u.alive) break;
      if (!target.alive && t - (firstSeen ? firstSeen.t : 0) > 40 && tick > 30 * 40) break; // 保険(通常はmaxTicksで抜ける)
    }
    world.onFire = null;

    const reactionT = (firstSeen && samFireEvents.length)
      ? round(samFireEvents[0].t - firstSeen.t, 1) : null;

    return { seenSec, hiddenSec, firstSeen, fired: samFireEvents.length, reactionT, outThetas };
  }

  window.__tossC3cRunA = async () => {
    const stage = await loadStage();
    const target0 = stage.enemy.ground.find((g) => g.type === 'RADAR');
    const base0 = stage.friendly.base;
    const bearing0 = headingOf(target0.x - base0.x, target0.z - base0.z);
    const distBaseTarget = Math.hypot(base0.x - target0.x, base0.z - target0.z);
    const perp = bearing0 + Math.PI / 2;

    const samDefs = {
      S0: offset(target0, 300, perp),
      S1: offset(target0, 1000, perp),
      S2: offset(target0, 1000, perp + Math.PI),
      S3: offset(target0, 1500, bearing0),
      S4: offset(target0, 1500, bearing0 + Math.PI),
    };
    const headingDefs = { h0: 0, hp15: 15 * DEG, hm15: -15 * DEG };
    function rotatedBase(offsetRad) {
      const brg = bearing0 + offsetRad;
      return { x: target0.x - distBaseTarget * Math.sin(brg), z: target0.z + distBaseTarget * Math.cos(brg) };
    }

    const weaponsMod = await import('/js/data/weapons.js');
    const samRange = weaponsMod.WEAPONS['SAM-M'].range;

    const samLabels = ['S0', 'S1', 'S2', 'S3', 'S4'];
    const headingLabels = ['h0', 'hp15', 'hm15'];
    const allRuns = {};

    for (const samLabel of samLabels) {
      for (const headingLabel of headingLabels) {
        const id = `tc3c_A_${samLabel}_${headingLabel}`;
        const base = rotatedBase(headingDefs[headingLabel]);
        const samXZ = samDefs[samLabel];
        const extraGround = [{ type: 'SAM', name: `SAM ${samLabel}`, x: round(samXZ.x), z: round(samXZ.z), known: true }];
        const ctx = await openScenario(id, stage, base, extraGround);
        const res = runTrialA(ctx, { samRange }, target0, bearing0);
        allRuns[`${samLabel}_${headingLabel}`] = res;
      }
    }

    // --- 集計: SAM位置別×段階の 見えた秒(合計)/220mなら隠れた秒(合計)、3方位分 ---
    const stageKeys = ['farIn', 'nearIn', 'pull', 'out', 'evading', 'other'];
    const bySam = samLabels.map((samLabel) => {
      const runs = headingLabels.map((h) => allRuns[`${samLabel}_${h}`]);
      const seenSum = {}, hiddenSum = {};
      for (const k of stageKeys) {
        seenSum[k] = round(sum(runs.map((r) => r.seenSec[k])), 1);
        hiddenSum[k] = round(sum(runs.map((r) => r.hiddenSec[k])), 1);
      }
      return { samLabel, seenSum, hiddenSum };
    });

    // --- 15本合計 ---
    const totalSeen = {}, totalHidden = {};
    for (const k of stageKeys) {
      totalSeen[k] = round(sum(bySam.map((s) => s.seenSum[k])), 1);
      totalHidden[k] = round(sum(bySam.map((s) => s.hiddenSum[k])), 1);
    }

    // --- 最初に見えた瞬間の要約 ---
    const allRunsList = Object.values(allRuns);
    const firstSeens = allRunsList.map((r) => r.firstSeen).filter(Boolean);
    const stageCounts = {};
    for (const k of stageKeys) stageCounts[k] = firstSeens.filter((f) => f.stage === k).length;
    const firstSeenSummary = {
      nRuns: allRunsList.length,
      nWithSighting: firstSeens.length,
      stageCounts,
      medianFlat: round(median(firstSeens.map((f) => f.flat)), 0),
      medianAlt: round(median(firstSeens.map((f) => f.alt)), 0),
      medianAgl: round(median(firstSeens.map((f) => f.agl)), 0),
      hiddenIf220Count: firstSeens.filter((f) => f.hiddenIf220).length,
    };

    // --- 発射までの反応時間 ---
    const reactionTimes = allRunsList.map((r) => r.reactionT).filter((x) => x != null);
    const reactionSummary = {
      nFired: allRunsList.filter((r) => r.fired > 0).length,
      nNoFire: allRunsList.filter((r) => r.fired === 0).length,
      medianReactionT: round(median(reactionTimes), 1),
      minReactionT: reactionTimes.length ? round(Math.min(...reactionTimes), 1) : null,
    };

    // --- outフェーズの実際の方位(目標から見て) ---
    const outThetasAll = [];
    for (const r of allRunsList) outThetasAll.push(...r.outThetas);
    const outBearingStats = circularMeanDeg(outThetasAll);

    window.__tossC3cLastA = { stage, target0, base0, bearing0: round(bearing0 / DEG, 1), samDefs, samRange, allRuns };

    return { bySam, totalSeen, totalHidden, firstSeenSummary, reactionSummary, outBearingStats };
  };

  // ================================================================= 測定B

  window.__tossC3cRunB = async () => {
    const stage = await loadStage();
    const target0 = stage.enemy.ground.find((g) => g.type === 'RADAR');
    const base0 = stage.friendly.base;
    const bearing0 = headingOf(target0.x - base0.x, target0.z - base0.z);
    const perp = bearing0 + Math.PI / 2;

    const samDefsXZ = {
      S0: offset(target0, 300, perp),
      S1: offset(target0, 1000, perp),
      S2: offset(target0, 1000, perp + Math.PI),
      S3: offset(target0, 1500, bearing0),
      S4: offset(target0, 1500, bearing0 + Math.PI),
    };
    const samLabels = ['S0', 'S1', 'S2', 'S3', 'S4'];
    const extraGround = samLabels.map((label) => ({
      type: 'SAM', name: `SAM ${label}`, x: round(samDefsXZ[label].x), z: round(samDefsXZ[label].z), known: true,
    }));

    const ctx = await openScenario('tc3c_B_probe', stage, base0, extraGround);
    const terrain = ctx.world.terrain;
    // sams配列とsamLabelsの対応づけ(名前で照合)
    const samByLabel = {};
    for (const label of samLabels) {
      const s = ctx.sams.find((x) => x.name === `SAM ${label}`);
      samByLabel[label] = s;
    }

    const distances = [2000, 3000, 4000, 5000, 6000, 8000];
    const angles = []; for (let a = 0; a < 360; a += 15) angles.push(a);

    const perSam = {};
    for (const label of samLabels) {
      const samPos = samByLabel[label].pos;
      const byDist = {};
      const hiddenBinsByDist = {};
      for (const d of distances) {
        const bins = angles.map((theta) => {
          const p = offset(target0, d, bearing0 + theta * DEG);
          const testPos = { x: p.x, y: terrain.heightAt(p.x, p.z) + RAISE, z: p.z };
          return !terrain.hasLineOfSight(samPos, testPos, SAM_CLEARANCE, SAM_STEP); // true=隠れる
        });
        hiddenBinsByDist[d] = bins;
        byDist[d] = { hiddenCount: bins.filter(Boolean).length, hiddenPct: round(100 * bins.filter(Boolean).length / bins.length, 0) };
      }
      // 4-6kmで一貫して隠れる方位帯(交差)
      const band = angles.map((_, i) => hiddenBinsByDist[4000][i] && hiddenBinsByDist[5000][i] && hiddenBinsByDist[6000][i]);
      const bandRanges = contiguousRanges(band);
      perSam[label] = {
        samXZ: { x: round(samDefsXZ[label].x), z: round(samDefsXZ[label].z) },
        byDist,
        hiddenRange4to6km: bandRanges,
      };
    }

    window.__tossC3cLastB = { stage, target0, bearing0: round(bearing0 / DEG, 1), samDefsXZ, perSam };

    return { bearingConvention: '0°=進入方位の延長(奥,S3方向)/90°=右(S1方向)/180°=手前・基地側(S4方向)/270°=左(S2方向)', perSam };
  };

  // ================================================================= 一括実行

  window.__tossC3cRun = async () => {
    const a = await window.__tossC3cRunA();
    const b = await window.__tossC3cRunB();
    return { A: a, B: b };
  };
})();
