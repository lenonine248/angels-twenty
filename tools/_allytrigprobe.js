// 友軍側のトリガー（§102 A2）の動作確認。**開発用**。ブラウザのコンソールで:
//
//   AT.setDebug(true)
//   fetch('/tools/bench.js').then(r=>r.text()).then(eval)
//   fetch('/tools/_allytrigprobe.js').then(r=>r.text()).then(eval)
//   await AT.allytrigprobe.run([11, 22, 33, 44])
//
// d4 ALLY TEST を写して、友軍飛行場・タグ・友軍のトリガーを足した面で回す（`_trigprobe.js` の友軍版）。
// 元の定義は回し終わったら戻す。
//
// 見るもの:
// - 各トリガーが実行された時刻（`mission.allyTriggers.log`）と、その瞬間の友軍機の aiMode・持ち場・guardHome
// - **敵のタグ**の破壊で成立するか（`destroyed` の `target`・`cap`）
// - `launch` が共用の飛行場（`home`）から**友軍機**を出し、`loadout` がそのまま載るか
// - 友軍の増援が「トリガーで開始」まで湧かず、`reinforce.loadout` が載るか（`main.js` の引数の取りこぼしを直した）
// - **プレイヤーの機体は動かない** —— HAMMER 1 に友軍と同じタグ `eagle` を付けておき、`defend` が触らないことを見る
// - タグなしの `below` が友軍機だけを数えるか（`a_below3` が t0 に成立する）
// - `restore` で友軍機が司令官の手へ戻るか（`a_restore` の6秒後の aiMode）

(function () {
  const STAGE_ID = 'd4';

  function patch(s) {
    s.friendly.aircraft[0].tags = ['eagle', 'hammer'];     // プレイヤーの機体。友軍のタグと重ねて、動かないことを見る
    s.friendly.aircraft[1].tags = ['hammer'];
    s.ally.base = { x: 6000, z: 47000,
      reinforce: { every: 60, max: 4, burst: 2, types: ['F-1'], tags: ['awave'], after: 'trigger',
        loadout: ['AAM-S', 'AAM-S'] } };
    s.ally.aircraft[0].tags = ['eagle'];
    s.ally.aircraft[1].tags = ['eagle'];
    s.ally.aircraft[2].tags = ['bison'];
    s.ally.aircraft[2].base = 'home';
    s.ally.triggers = [
      { id: 'a_time', when: [{ type: 'time', seconds: 30 }],
        do: [{ type: 'notice', text: 'A30' },
          { type: 'launch', base: 'home', aircraft: 'F-1', n: 2, tag: 'alate', loadout: ['AAM-M', 'AAM-S'] }] },
      { id: 'a_guard', when: [{ type: 'fired', id: 'a_time' }], delay: 5,
        do: [{ type: 'guard', tag: 'alate', x: 20000, z: 32000, alt: 4000, r: 5000 }] },
      // 敵のタグ（補給施設 1か所）で成立 → 友軍の戦闘機を友軍飛行場の防空へ・友軍の増援を開始
      { id: 'a_target', when: [{ type: 'destroyed', tag: 'target', count: 1 }],
        do: [{ type: 'defend', tag: 'eagle', base: 'base' }, { type: 'reinforce', base: 'base', on: true }] },
      { id: 'a_cap', when: [{ type: 'destroyed', tag: 'cap', count: 1 }], do: [{ type: 'notice', text: 'cap1' }] },
      { id: 'a_detect', when: [{ type: 'detected' }], do: [{ type: 'notice', text: 'detected' }] },
      { id: 'a_enter', when: [{ type: 'enter', x: 31000, z: 19000, r: 12000 }], do: [{ type: 'notice', text: 'enter' }] },
      // タグなし below は**友軍機だけ**を数える。開始時は EAGLE 2・BISON 1 の3機なので t0 に成立する
      // （プレイヤーの HAMMER 2機まで数えると5機で成立しない）
      { id: 'a_below3', when: [{ type: 'below', n: 3 }], do: [{ type: 'notice', text: 'ally<=3' }] },
      // 元に戻す。陣取らせた alate と、防空に回した eagle を司令官の手へ返す
      { id: 'a_restore', when: [{ type: 'time', seconds: 220 }],
        do: [{ type: 'restore', tag: 'eagle' }, { type: 'restore', tag: 'alate' }] },
    ];
    return s;
  }

  const snap = (w, tag) => w.units
    .filter((u) => u.kind === 'aircraft' && u.tags && u.tags.includes(tag) && u.alive)
    .map((u) => `${u.name}${u.owner === 'ally' ? '' : '(P)'}:${u.aiMode}${u.guardHome ? '/gh' : ''}${u._trigSaved ? '/sv' : ''}@${u.patrolArea
      ? Math.round(u.patrolArea.x / 100) / 10 + ',' + Math.round(u.patrolArea.z / 100) / 10 : '-'}`);

  async function run(seeds = [11, 22, 33, 44]) {
    const i = AT.stageList().findIndex((s) => s.id === STAGE_ID);
    const live = AT.stageList()[i];
    const orig = JSON.parse(JSON.stringify(live));
    const out = [];
    try {
      const p = patch(JSON.parse(JSON.stringify(orig)));
      for (const k of Object.keys(live)) delete live[k];
      Object.assign(live, p);
      for (const seed of seeds) {
        const rec = { seed, fired: [], spawns: [], hammerTouched: 0 };
        const r = await AT.bench.runOne(i, false, {
          seed,
          setup(b) {
            const w = b.world;
            const tr = b.mission.allyTriggers;
            rec.hasTriggers = !!tr;
            rec.enemyTriggers = !!b.mission.triggers;
            if (!tr) return;
            const upd = tr.update.bind(tr);
            tr.update = (time) => {
              const before = tr.log.length;
              upd(time);
              // restore の6秒後（司令官が2秒ごとに割り当てるので、拾い直したかが見える）
              const rs = tr.log.find((e) => e.id === 'a_restore');
              if (rec.after == null && rs && time >= rs.t + 6) {
                rec.after = { t: Math.round(time), eagle: snap(w, 'eagle'), alate: snap(w, 'alate') };
              }
              for (const e of tr.log.slice(before)) {
                rec.fired.push({ id: e.id, t: Math.round(e.t),
                  eagle: snap(w, 'eagle'), alate: snap(w, 'alate'),
                  allyAir: w.units.filter((u) => u.alive && u.kind === 'aircraft' && u.owner === 'ally').length });
              }
              // プレイヤーの機体にトリガーの手が付いていないか（毎拍）
              for (const u of w.units) {
                if (u.kind === 'aircraft' && u.side === w.playerSide && u.owner !== 'ally' && (u._trigSaved || u.guardHome)) {
                  rec.hammerTouched++;
                }
              }
            };
            const spawn = w.spawnReinforcement;
            w.spawnReinforcement = (ab, type, idx, tags, owner, loadout) => {
              const before = w.units.length;
              const res = spawn(ab, type, idx, tags, owner, loadout);
              const u = w.units[w.units.length - 1];
              rec.spawns.push({ t: Math.round(b.mission.time), idx: String(idx), base: ab.name,
                tags: (tags || []).join(','), owner: w.units.length > before ? u.owner : '?',
                loadout: w.units.length > before ? u.loadout.join('+') : '?' });
              return res;
            };
          },
        });
        rec.result = `${r.state} ${Math.round(r.sec)}s kills ${r.kills} losses ${r.losses} ally ${r.allyLosses}`;
        out.push(rec);
      }
    } finally {
      for (const k of Object.keys(live)) delete live[k];
      Object.assign(live, orig);
    }
    return out;
  }

  AT.allytrigprobe = { run, patch };
})();
