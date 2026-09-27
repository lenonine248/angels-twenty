// トリガー（§12.3）と撃墜の記録（P0）の動作確認。ブラウザのコンソールで:
//
//   fetch('/tools/bench.js').then(r=>r.text()).then(eval)
//   fetch('/tools/_trigprobe.js').then(r=>r.text()).then(eval)
//   await AT.trigprobe.run([11, 22, 33])
//
// IRON UMBRELLA（STAGES の添字 3）を写して、敵飛行場とトリガーを足した面で回す。
// 元の定義は回し終わったら戻す。
//
// 見るもの:
// - 各トリガーが実行された時刻（`mission.triggers.log`）
// - 実行した瞬間の、タグの機体の aiMode・持ち場・guardHome
// - 増援が「トリガーで開始」まで湧かないこと
// - 撃墜に攻撃者と兵装が載ること（`lastHit`）

(function () {
  const IDX = 3;

  function testStage(orig) {
    const s = JSON.parse(JSON.stringify(orig));
    s.id = 'trigtest';
    s.enemy.aircraft.push(
      { type: 'J-7', name: 'BANDIT 2', x: 37000, z: 19000, agl: 5000, aiMode: 'PATROL', tags: ['cap'] });
    s.enemy.base = { x: 42000, z: 16000, tags: ['ebase'],
      reinforce: { every: 60, max: 4, burst: 2, types: ['J-7'], tags: ['wave'], after: 'trigger' } };
    s.enemy.triggers = [
      { id: 't_time', when: [{ type: 'time', seconds: 30 }],
        do: [{ type: 'notice', text: 'T30' }, { type: 'launch', base: 'base', aircraft: 'J-7', n: 2, tag: 'late' }] },
      { id: 't_guard', when: [{ type: 'fired', id: 't_time' }], delay: 5,
        do: [{ type: 'guard', tag: 'late', x: 30000, z: 24000, alt: 4000, r: 5000 }] },
      { id: 't_sam', when: [{ type: 'destroyed', tag: 'air-defense', count: 1 }],
        do: [{ type: 'defend', tag: 'cap', base: 'base' }, { type: 'reinforce', base: 'base', on: true }] },
      { id: 't_detect', when: [{ type: 'detected' }], do: [{ type: 'notice', text: 'detected' }] },
      { id: 't_enter', when: [{ type: 'enter', x: 30000, z: 24000, r: 9000 }], do: [{ type: 'notice', text: 'enter' }] },
      { id: 't_below', match: 'any', when: [{ type: 'below', tag: 'late', n: 1 }, { type: 'time', seconds: 600 }],
        do: [{ type: 'restore', tag: 'late' }] },
    ];
    return s;
  }

  const snap = (w, tag) => w.units
    .filter((u) => u.side === 'red' && u.kind === 'aircraft' && u.tags && u.tags.includes(tag) && u.alive)
    .map((u) => `${u.name}:${u.aiMode}${u.guardHome ? '/gh' : ''}@${u.patrolArea
      ? Math.round(u.patrolArea.x / 100) / 10 + ',' + Math.round(u.patrolArea.z / 100) / 10 : '-'}`);

  async function run(seeds = [11, 22, 33]) {
    const orig = AT.stages[IDX];
    const out = [];
    try {
      AT.stages[IDX] = testStage(orig);
      for (const seed of seeds) {
        const rec = { seed, fired: [], spawns: [], kills: [], firstWave: null };
        const r = await AT.bench.runOne(IDX, false, {
          seed,
          setup(b) {
            const w = b.world;
            const tr = b.mission.triggers;
            rec.hasTriggers = !!tr;
            if (!tr) return;
            const upd = tr.update.bind(tr);
            tr.update = (time) => {
              const before = tr.log.length;
              upd(time);
              for (const e of tr.log.slice(before)) {
                rec.fired.push({ id: e.id, t: Math.round(e.t),
                  cap: snap(w, 'cap'), late: snap(w, 'late') });
              }
            };
            const spawn = w.spawnReinforcement;
            w.spawnReinforcement = (ab, type, idx, tags) => {
              rec.spawns.push({ t: Math.round(b.mission.time), idx: String(idx), tags: (tags || []).join(',') });
              if (tags && tags.includes('wave') && rec.firstWave == null) rec.firstWave = Math.round(b.mission.time);
              return spawn(ab, type, idx, tags);
            };
            rec.world = w;
          },
        });
        const w = rec.world;
        delete rec.world;
        rec.result = r.result || r.outcome;
        const hitWho = { withBy: 0, noBy: 0, byTerrainEtc: 0 };
        for (const u of w ? w.units : []) {
          if (u.alive) continue;
          const k = AT.killedBy(u);
          if (k) {
            hitWho.withBy++;
            if (rec.kills.length < 6) rec.kills.push(`${u.name}←${k.by.name}(${k.weapon})`);
          } else if (u.deathCause) hitWho.byTerrainEtc++;
          else hitWho.noBy++;
        }
        rec.hitWho = hitWho;
        out.push(rec);
      }
    } finally {
      AT.stages[IDX] = orig;
    }
    return out;
  }

  AT.trigprobe = { run, testStage };
})();
