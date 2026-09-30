// チュートリアルの通し検証用ハーネス。仕様書 §19.4。
//
// rAF はブラウザのペインが隠れていると絞られるので、時間の進行はここで自前に回す。
// ブラウザのコンソールで次のように読み込む:
//   fetch('/tools/_tut_harness.js').then(r => r.text()).then(eval)
//
// **1回の通しは1回の呼び出しの中で回す**（§93.12）。`__fast` は刻みを自分で呼ぶが、
// 本体の rAF ループ（`core/loop.js` の `_tick`）も止まってはいない。止める手順が済んで
// 再開したまま呼び出しを分けると、**呼び出しの合間の実時間ぶん本体が戦闘を進める**
// （止めずに2秒待つと simTime が2秒進んだ）。1本の async 関数の中で `__open` から最後まで回せば、
// 待つのは `__open` の中だけなので混ざらない。
(() => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** 指定秒ぶん、シミュレーションを手で進める */
  window.__fast = (seconds) => {
    const DT = 1 / 30;
    const b = AT.battle;
    if (!b) return 'no battle';
    for (let i = 0, n = Math.round(seconds / DT); i < n; i++) {
      // **本体の固定刻みをそのまま呼ぶ**（`main.js` の `fixedUpdate`）。
      // 以前は刻みの中身を写していたが、雲の流れ（§88.15）・撃墜の処理・編隊の掃除・
      // 敵の司令官AI が抜けていた。雲の本（k1）と防衛の本（k2）はそこに頼るので、
      // 写しのままでは本体と違う動きで通すことになる
      // （§88.16 の「写しは1つではなかった」と同じ形）。記録も中で取る。
      // 時刻を足す順も本体（`core/loop.js`）に合わせる —— 刻みのあとで足す
      AT.loop.onFixedUpdate(DT);
      AT.loop.simTime += DT;
      if (AT.tutorial && !AT.tutorial.finished) {
        AT.tutorial.update({
          world: b.world, commands: AT.commands, loop: AT.loop, rig: AT.scene.rig,
        }, DT);
      }
      if (AT.tutorial && AT.tutorial.finished) break;
    }
    return { t: Math.round(AT.loop.simTime), idx: AT.tutorial && AT.tutorial.index };
  };

  /** チュートリアルを開いて一時停止状態にする */
  window.__open = async (id) => {
    const prev = AT.battle;
    AT.screens.showTutorialBriefing(AT.tutorials.find((t) => t.id === id));
    document.querySelector('[data-act="startTutorial"]').click();
    for (let i = 0; i < 80 && (!AT.battle || AT.battle === prev); i++) await sleep(100);
    await sleep(400);
    AT.loop.setPaused(true);
    return !!AT.battle;
  };

  /**
   * カメラの注視高度を、本体の描画ループと同じ式で入れる（`main.js` の `focusAltTarget`）。
   *
   * **ペインが隠れていると rAF が1回も回らない**（2026-09-29 実測: 1秒に0回）。
   * 注視高度は描画ループが選択機の対地高度から毎フレーム入れているので、
   * 回らないと初期値 2200m のまま。w4 では寄ったカメラが高度 4,850m、
   * 的が 6,500m で、**的がカメラより上＝画面外**になり、右クリックが的を拾えなかった
   * （地面への指示に落ち、選択機は待機旋回のまま）。§94.5 で通っていたのはペインが出ていたから。
   */
  function syncFocusAlt() {
    const b = AT.battle, sel = AT.commands.selection;
    const focusOn = sel.length ? sel : b.world.units.filter((u) => u.alive
      && u.side === b.world.playerSide && u.owner !== 'ally' // isPlayerOwned
      && u.kind === 'aircraft' && !u.onGround);
    if (!focusOn.length) return;
    let sum = 0;
    for (const u of focusOn) sum += Math.max(0, u.pos.y - Math.max(0, b.world.terrain.heightAt(u.pos.x, u.pos.z)));
    AT.scene.rig.focusAltTarget = Math.min(7000, Math.max(400, sum / focusOn.length));
  }

  window.__u = (name) => AT.battle.world.units.find((u) => u.name === name);
  window.__sel = (name) => { const u = __u(name); AT.commands.select([u]); return u.name; };

  /**
   * 目標を右クリックする。
   * **開いた直後は使えない**。まだレーダーが一度も回っておらず、
   * 敵が未探知だと画面に出ないので、地面への移動指示に落ちる。
   * 先に `__fast(5)` で走査を一周させること。
   */
  window.__rclick = (target) => {
    AT.scene.rig.lookAtPoint(target.pos.x, target.pos.z);
    // 引きの画のままだと的が数ピクセルになり、拾えずに地面への移動指示へ落ちる。
    // 寄ってから撃つ。人が操作するときも同じことをしている。
    AT.scene.rig.distance = AT.scene.rig.minDistance * 3;
    syncFocusAlt();
    for (let i = 0; i < 60; i++) AT.scene.update(0.15);
    AT.scene.render();
    const p = AT.commands._project(AT.battle.world.displayPosOf(target));
    if (!p) return false;
    AT.commands._issueOrderAt(p.x, p.y, false);
    // 拾えたか（拾えていなければ移動指示になっている）
    return AT.commands.selection.every((u) => u.order && u.order.target === target);
  };

  /** 地面を右クリックして移動を指示する */
  window.__moveTo = (x, z) => {
    AT.scene.rig.lookAtPoint(x, z);
    syncFocusAlt();
    for (let i = 0; i < 40; i++) AT.scene.update(0.15);
    AT.scene.render();
    const y = Math.max(0, AT.battle.world.terrain.heightAt(x, z));
    const v = AT.commands.selection[0].pos.clone(); v.set(x, y, z);
    const p = AT.commands._project(v);
    if (!p) return false;
    AT.commands._issueOrderAt(p.x, p.y, false);
    return true;
  };

  /** SELECTED パネルのボタンを押す（毎回組み直されるので描画してから引く） */
  window.__btn = (sel) => {
    AT.hud._detailKey = null;
    AT.hud.update(1);
    const b = document.querySelector(sel);
    if (b) b.click();
    return !!b;
  };

  /** いま何手目まで進んでいるか */
  window.__report = (id) => {
    const t = AT.tutorial;
    if (!t) return `${id} ?`;
    return `${id} ${t.index}/${t.steps.length} ${t.finished ? '完了' : '未完'} `
      + `t=${Math.round(AT.loop.simTime)}s`
      + (t.finished ? '' : ` 手前="${t.steps[t.index].text}"`);
  };

  return 'harness ready';
})();
