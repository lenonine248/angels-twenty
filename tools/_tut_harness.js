// チュートリアルの通し検証用ハーネス。仕様書 §19.4。
//
// rAF はブラウザのペインが隠れていると絞られるので、時間の進行はここで自前に回す。
// ブラウザのコンソールで次のように読み込む:
//   fetch('/tools/_tut_harness.js').then(r => r.text()).then(eval)
(() => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** 指定秒ぶん、シミュレーションを手で進める */
  window.__fast = (seconds) => {
    const DT = 1 / 30;
    const b = AT.battle;
    if (!b) return 'no battle';
    for (let i = 0, n = Math.round(seconds / DT); i < n; i++) {
      for (const u of b.world.units) if (u.alive) u.update(DT, b.world);
      b.world.detection.update(DT);
      b.pilotAI.update(DT);
      b.combat.update(DT);
      b.mission.update(DT);
      AT.loop.simTime += DT;
      b.recorder?.tick(AT.loop.simTime);      // 手で進めるときも記録を取る（§23）
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
