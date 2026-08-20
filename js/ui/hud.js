// HUD: 左の自軍機リスト（ロースター）と下の選択機詳細。
//
// 描画方針:
//   DOMを毎回 innerHTML で作り直すと、カーソルを合わせているボタンが
//   毎フレーム作り直されて :hover が点滅し、クリック判定も安定しない。
//   そこで「構造」と「数値」を分け、構造は内容が変わったときだけ作り直し、
//   数値はキャッシュした要素へ書き込む。

import { formatTime } from '../core/loop.js';
import { altitudeProfile } from '../core/atmosphere.js';
import { WEAPONS, loadoutSlots, loadoutCost } from '../data/weapons.js';
import { AI_MODES } from '../ai/pilot.js';
import { notify } from './actions.js';

const REFRESH_INTERVAL = 1 / 10;

/** 詳細パネルに並べるAIモード */
const MODE_BUTTONS = ['PATROL', 'PURSUIT', 'COORDINATE', 'EVADE', 'ESCORT', 'STRIKE'];
/** 搭載パネルに並べる兵装（SAM弾は地上専用なので除く） */
const LOADABLE = ['AAM-S', 'AAM-M', 'AAM-A', 'AGM', 'ARM', 'BOMB', 'TANK'];

const ORDER_LABEL = {
  move: '移動', orbit: '待機旋回', attack: '攻撃', follow: '随伴', hold: '保持',
};
const STATE_LABEL = {
  flying: '飛行中', landing: '着陸進入', parked: '駐機',
  servicing: '整備中', ready: '発進待ち', takeoff: '離陸中',
};
const ALT_PRESETS = [[600, '低空'], [2000, '中低'], [4000, '中高'], [7000, '高々度'], [10000, '最大']];

export class Hud {
  constructor({ world, commands }) {
    this.world = world;
    this.commands = commands;
    this.roster = document.getElementById('rosterBody');
    this.detail = document.getElementById('detailBody');
    this._accum = 99;
    this._rosterKey = null;
    this._detailKey = null;
    this._d = {};          // 詳細パネルの数値要素キャッシュ

    this.roster.addEventListener('mousedown', (e) => {
      const row = e.target.closest('.unit-row');
      if (!row) return;
      const u = this.world.units.find((x) => x.id === Number(row.dataset.id));
      if (!u) return;
      if (e.ctrlKey || e.shiftKey) this.commands.toggle(u);
      else this.commands.select([u]);
      if (e.detail === 2) this.commands.centerOnSelection();
      this._detailKey = null;      // 選択が変わったので構造を作り直す
    });

    this.detail.addEventListener('click', (e) => {
      const alt = e.target.closest('button[data-alt]');
      if (alt) { this.commands.setAltitude(Number(alt.dataset.alt)); this._detailKey = null; return; }
      const mode = e.target.closest('button[data-mode]');
      if (mode) { this._setMode(mode.dataset.mode); this._detailKey = null; return; }
      const cmd = e.target.closest('button[data-cmd]');
      if (cmd) { this._runCommand(cmd.dataset.cmd); this._detailKey = null; return; }
      const add = e.target.closest('button[data-load-add]');
      if (add) { this._editLoadout(add.dataset.loadAdd, null); this._detailKey = null; return; }
      const del = e.target.closest('button[data-load-del]');
      if (del) { this._editLoadout(null, Number(del.dataset.loadDel)); this._detailKey = null; return; }

      // 使用兵装の指定（クリックで選択／再クリックで解除）
      const pick = e.target.closest('button[data-pick]');
      if (pick) {
        const u = this.commands.selection[0];
        if (u) {
          u.selectedWeapon = u.selectedWeapon === pick.dataset.pick ? null : pick.dataset.pick;
          if (u.selectedWeapon) notify('weapon', { weapon: u.selectedWeapon, unit: u });
        }
        this._detailKey = null;
        return;
      }
      // 兵装ごとの自動使用 ON/OFF
      const auto = e.target.closest('button[data-auto]');
      if (auto) {
        for (const u of this.commands.selection) {
          const id = auto.dataset.auto;
          u.autoWeapons[id] = u.autoWeapons[id] === false;
        }
        this._detailKey = null;
        return;
      }
      // 誘導中に回避するか
      const guard = e.target.closest('button[data-guard]');
      if (guard) {
        for (const u of this.commands.selection) u.evadeWhileGuiding = !u.evadeWhileGuiding;
        notify('guard', {});
        this._detailKey = null;
        return;
      }
      // 自動発射のしきい値
      const thr = e.target.closest('button[data-thr]');
      if (thr) {
        for (const u of this.commands.selection) u.fireThreshold = thr.dataset.thr;
        notify('threshold', { value: thr.dataset.thr });
        this._detailKey = null;
        return;
      }
      // 射撃指示の取消
      const ct = e.target.closest('button[data-cleartask]');
      if (ct) {
        for (const u of this.commands.selection) u.fireTasks.length = 0;
        this._detailKey = null;
      }
    });
  }

  update(dt) {
    this._accum += dt;
    if (this._accum < REFRESH_INTERVAL) return;
    this._accum = 0;
    this._renderRoster();
    this._renderDetail();
  }

  // -------------------------------------------------------------- 操作

  _setMode(mode) {
    if (this.commands.selection.length) notify('aimode', { mode });
    for (const u of this.commands.selection) {
      if (u.formation) u.formation.setMode(mode);
      else u.aiMode = mode;
      u._winchester = false;
      if (mode === 'PATROL' || mode === 'PURSUIT' || mode === 'COORDINATE') {
        u.patrolArea = { x: u.pos.x, z: u.pos.z, alt: u.desiredAlt, radius: 4500 };
      }
    }
  }

  _runCommand(cmd) {
    const sel = this.commands.selection;
    if (!sel.length) return;
    switch (cmd) {
      case 'clear': for (const u of sel) u.clearOrders(); break;
      case 'rtb':
        for (const u of sel) {
          if (u.onGround) continue;
          const ab = u.nearestBase(this.world);
          if (ab) u.setOrder({ type: 'rtb', airbase: ab, player: true });
        }
        notify('order:rtb', {});
        break;
      case 'launch':
        for (const u of sel) if (u.airbase) u.airbase.launch(u, this.world);
        notify('takeoff', {});
        break;
      default: break;
    }
  }

  _editLoadout(addId, delIndex) {
    const u = this.commands.selection[0];
    if (!u || !u.onGround) return;
    const plan = (u.plannedLoadout ?? u.baseLoadout ?? []).slice();
    if (addId) {
      const w = WEAPONS[addId];
      if (loadoutSlots(plan) + w.slots > u.spec.hardpoints) return;
      plan.push(addId);
    } else if (delIndex != null) {
      plan.splice(delIndex, 1);
    }
    u.plannedLoadout = plan;
    if (u.airbase) u.airbase.replan(u, this.world);
    notify('loadout', { unit: u, plan });
  }

  // -------------------------------------------------------------- ロースター

  _renderRoster() {
    const mine = this.world.units.filter(
      (u) => u.side === this.world.playerSide && u.kind === 'aircraft');
    if (!mine.length) {
      if (this._rosterKey !== 'empty') {
        this.roster.innerHTML = '<div class="panel-empty">機体なし</div>';
        this._rosterKey = 'empty';
      }
      return;
    }

    // 構造が変わるときだけ作り直す。
    // 「実行内容」は指示が変わるたびに変わる“値”なので、ここ（構造のキー）には入れない。
    // 入れないまま値の更新もしないと、指示を変えても表示が古いまま残る（実際に起きた）。
    const key = mine.map((u) => `${u.id}${u.alive ? 1 : 0}${u.state}${this.commands.isSelected(u) ? 1 : 0}`
      + `${u.aiMode}${u.formation ? u.formation.number : 0}${u.threats.length ? 1 : 0}`).join('|');
    if (key !== this._rosterKey) {
      this._rosterKey = key;
      this.roster.innerHTML = mine.map((u) => this._rosterRow(u)).join('');
    }

    // 数値だけ毎回更新する
    for (const u of mine) {
      const row = this.roster.querySelector(`.unit-row[data-id="${u.id}"]`);
      if (!row) continue;
      const meta = row.querySelector('.ur-meta');
      if (meta) meta.textContent = `${u.typeId} · ${fmtAlt(u.pos.y)} · ${Math.round(u.speed)}m/s`;
      const fuel = row.querySelector('.bar.fuel i');
      if (fuel) {
        const r = Math.round(u.fuelRatio * 100);
        fuel.style.width = `${r}%`;
        fuel.parentElement.className = `bar fuel${r < 25 ? ' low' : r < 45 ? ' warn' : ''}`;
      }
      const hp = row.querySelector('.bar.hp i');
      if (hp) hp.style.width = `${Math.round(u.hpRatio * 100)}%`;
      const st = row.querySelector('.ur-state');
      if (st) {
        const html = rosterState(u);
        if (st.innerHTML !== html) st.innerHTML = html;
      }
    }
  }

  _rosterRow(u) {
    const sel = this.commands.isSelected(u) ? ' selected' : '';
    const dead = u.alive ? '' : ' dead';
    const threat = u.alive && u.threats.length ? ' threat' : '';
    const state = rosterState(u);
    const mode = u.alive && !u.onGround
      ? ` · <span class="ur-mode">${(AI_MODES[u.aiMode] || {}).label || ''}</span>` : '';
    const fm = u.formation
      ? ` · <span class="ur-fm">${u.formation.name}</span>` : '';
    return `<div class="unit-row${sel}${dead}${threat}" data-id="${u.id}">
      <div class="ur-top"><span class="ur-name">${u.name}</span><span class="ur-state">${state}</span></div>
      <div class="ur-meta"></div>
      <div class="ur-sub">${mode}${fm}</div>
      <div class="ur-bars">
        <div class="bar fuel"><i></i></div>
        <div class="bar hp"><i></i></div>
      </div>
    </div>`;
  }

  // -------------------------------------------------------------- 詳細

  _renderDetail() {
    const sel = this.commands.selection;
    if (!sel.length) {
      if (this._detailKey !== 'none') {
        this.detail.innerHTML = '<div class="panel-empty">ユニット未選択 — 機体をクリック、またはドラッグで範囲選択</div>';
        this._detailKey = 'none';
      }
      return;
    }
    if (sel.length > 1) {
      const key = 'multi' + sel.map((u) => u.id).join(',');
      if (key !== this._detailKey) {
        this._detailKey = key;
        this.detail.innerHTML = `
          <div class="dt-multi">${sel.length} 機を選択中</div>
          <div class="dt-multi-sub">${sel.map((u) => u.name).join(', ')}</div>
          ${this._modeButtons(sel[0])}
          ${this._altButtons(sel[0])}`;
      }
      return;
    }

    const u = sel[0];
    const key = [
      u.id, u.state, u.aiMode, u.loadout.join(','), (u.plannedLoadout || []).join(','),
      u.onGround && u.airbase ? (u.airbase.pendingService(u)?.kinds.join('') ?? '') : '',
      u.formation ? u.formation.number : 0, Math.round(u.desiredAlt / 250), u.onGround ? 1 : 0,
      u.selectedWeapon || '', u.evadeWhileGuiding ? 1 : 0, u.fireThreshold,
      u.autoWeapons.GUN === false ? 1 : 0,
      (u.fireTasks || []).map((t) => t.weapon + (t.target ? t.target.id : '')).join(','),
      Object.entries(u.autoWeapons).map(([k, v]) => k + v).join(''),
    ].join('|');

    if (key !== this._detailKey) {
      this._detailKey = key;
      this._buildDetail(u);
    }
    this._updateDetailValues(u);
  }

  _buildDetail(u) {
    this.detail.innerHTML = `
      <div class="dt-head">
        <span class="dt-name">${u.name}</span>
        <span class="dt-type">${u.spec.name}</span>
        <span class="dt-order" id="dv-order"></span>
      </div>
      <div class="dt-grid">
        <div><label>速度</label><b id="dv-spd"></b> m/s</div>
        <div><label>高度</label><b id="dv-alt"></b> m</div>
        <div><label>対地</label><b id="dv-agl"></b> m</div>
        <div><label>方位</label><b id="dv-hdg"></b></div>
        <div><label>燃料</label><b id="dv-fuel"></b> 分</div>
        <div><label>機銃</label><b id="dv-gun"></b> 発</div>
        <div><label>FLR/CHF</label><b id="dv-dec"></b></div>
        <div><label>HP</label><b id="dv-hp"></b></div>
      </div>
      <div class="dt-perf"><label>高度性能</label><span id="dv-perf"></span></div>
      ${u.onGround ? this._groundPanel(u) : this._weaponPanel(u)}
      ${u.onGround ? '' : this._modeButtons(u)}
      ${this._altButtons(u)}`;

    this._d = {};
    for (const id of ['order', 'spd', 'alt', 'agl', 'hdg', 'fuel', 'gun', 'dec', 'hp', 'perf', 'svc']) {
      this._d[id] = document.getElementById('dv-' + id);
    }
  }

  _updateDetailValues(u) {
    const d = this._d;
    if (!d.spd) return;
    const agl = Math.max(0, u.pos.y - Math.max(0, this.world.terrain.heightAt(u.pos.x, u.pos.z)));

    d.order.innerHTML = u.threats.length
      ? `<span class="ur-warn">⚠ ミサイル警報 ×${u.threats.length}${u.evading ? '（回避中）' : ''}</span>`
      : orderLabel(u);
    d.spd.textContent = Math.round(u.speed);
    d.alt.textContent = Math.round(u.pos.y);
    d.agl.textContent = Math.round(agl);
    d.hdg.textContent = fmtHeading(u.heading);
    d.fuel.textContent = formatTime(Math.round(u.fuel));
    d.gun.textContent = Math.floor(u.gun);          // 端数は出さない
    d.dec.textContent = `${u.flares}/${u.chaff}`;
    d.hp.textContent = `${Math.round(u.hp)}/${u.maxHp}`;

    const p = altitudeProfile(u.pos.y);
    const cls = (v) => (v >= 0.8 ? 'good' : v >= 0.6 ? 'mid' : 'bad');
    d.perf.innerHTML =
      `<span class="pf ${cls(p.thrust)}">推力 ${Math.round(p.thrust * 100)}%</span>`
      + `<span class="pf ${cls(p.turn)}">旋回 ${Math.round(p.turn * 100)}%</span>`
      + `<span class="pf ${p.missileRange >= 1.3 ? 'good' : 'mid'}">ミサイル射程 ×${p.missileRange.toFixed(2)}</span>`;

    if (d.svc && u.airbase) {
      const pr = u.airbase.serviceProgress(u);
      d.svc.textContent = pr
        ? `${pr.current} 残 ${Math.ceil(pr.remainingSec)}秒`
        : (u.state === 'ready' ? '整備完了' : '順番待ち');
    }
  }

  /**
   * 飛行中の兵装パネル。
   * 兵装を選ぶと、その後の右クリック攻撃はその兵装を使う（選択解除でAI任せ）。
   * 「自動」を切ると、AIがその兵装を勝手に使わなくなる（高価な兵装の温存）。
   */
  _weaponPanel(u) {
    if (!u.loadout.length) {
      return '<div class="dt-load"><label>兵装</label><span class="chip empty">なし</span></div>';
    }
    const chips = u.loadout.map((id, i) => {
      const on = u.selectedWeapon === id ? ' picked' : '';
      return `<button class="chip pick${on}" data-pick="${id}" data-i="${i}"
        title="この兵装を指定して攻撃する">${id}</button>`;
    }).join('');

    const kinds = [...new Set(u.loadout)];
    const autos = kinds.map((id) => {
      const off = u.autoWeapons[id] === false;
      return `<button class="autow${off ? ' off' : ''}" data-auto="${id}"
        title="AIがこの兵装を自動で使うか">${id}${off ? ' 停止' : ' 自動'}</button>`;
    }).join('')
      // 機銃は搭載品ではないが、自動使用の可否はミサイルと同じように扱う。
      // 弾を温存したい／近づかせたくない、という判断があるため。
      + `<button class="autow${u.autoWeapons.GUN === false ? ' off' : ''}" data-auto="GUN"
        title="AIが機銃を自動で使うか">機銃${u.autoWeapons.GUN === false ? ' 停止' : ' 自動'}</button>`;

    const guard = `<button class="autow${u.evadeWhileGuiding ? '' : ' off'}" data-guard="1"
      title="AAM-M誘導中にミサイルが飛んできたとき、回避するか誘導を続けるか">
      ${u.evadeWhileGuiding ? '誘導中も回避' : '誘導を優先'}</button>`;

    // AIが自動発射に踏み切る命中期待度
    const th = ['low', 'mid', 'high'];
    const thLabel = { low: '低', mid: '中', high: '高' };
    const thBtns = th.map((k) => `<button class="autow${u.fireThreshold === k ? '' : ' off'}"
      data-thr="${k}" title="この期待度を下回るとAIは自動発射しない">${thLabel[k]}</button>`).join('');

    const tasks = (u.fireTasks || []).filter((t) => t.target && t.target.alive);
    const taskRow = tasks.length
      ? `<div class="dt-load"><label>射撃指示</label>${tasks.map((t) =>
          `<span class="chip task">${t.weapon} → ${t.target.name}</span>`).join('')}
          <button class="autow off" data-cleartask="1">取消</button></div>`
      : '';

    return `<div class="dt-load"><label>兵装</label>${chips}
        ${u.selectedWeapon ? `<span class="svc-meta pickinfo">${u.selectedWeapon} 指定中 — 敵を右クリックで射撃指示</span>` : ''}
      </div>
      ${taskRow}
      <div class="dt-add">${autos}${guard}
        <span class="svc-meta">自動発射</span>${thBtns}</div>`;
  }

  _groundPanel(u) {
    const plan = u.plannedLoadout ?? u.baseLoadout ?? [];
    const used = loadoutSlots(plan);
    const cost = loadoutCost(plan);
    const points = this.world.weaponPoints ?? 0;

    const chips = plan.length
      ? plan.map((id, i) =>
          `<button class="chip load" data-load-del="${i}" title="降ろす">${id}<i>×</i></button>`).join('')
      : '<span class="chip empty">なし</span>';
    const adds = LOADABLE.map((id) => {
      const w = WEAPONS[id];
      const room = used + w.slots <= u.spec.hardpoints;
      return `<button class="addw${room ? '' : ' disabled'}" data-load-add="${id}"
        title="${w.name} / ${w.slots}スロット / コスト${w.cost}">+${id}</button>`;
    }).join('');

    return `<div class="dt-service">
      <div class="svc-row"><label>整備</label><b id="dv-svc"></b>
        <span class="svc-slot">${u.airbase ? u.airbase.name : '—'}</span></div>
      <div class="dt-load"><label>搭載</label>${chips}
        <span class="svc-meta ${used > u.spec.hardpoints ? 'bad' : ''}">${used}/${u.spec.hardpoints}スロット</span>
        <span class="svc-meta ${cost > points ? 'bad' : ''}">コスト ${cost} / 残${points}</span>
      </div>
      <div class="dt-add">${adds}</div>
    </div>`;
  }

  _modeButtons(u) {
    const cur = u ? u.aiMode : null;
    const btns = MODE_BUTTONS.map((id) => {
      const m = AI_MODES[id];
      return `<button data-mode="${id}" class="${cur === id ? 'active' : ''}" title="${m.desc}">${m.label}</button>`;
    }).join('');
    const f = u && u.formation
      ? `<span class="fm-tag">${u.formation.name} #${(u.formationSlot ?? 0) + 1}</span>` : '';
    return `<div class="dt-mode"><label>AI</label>${btns}${f}</div>`;
  }

  _altButtons(u) {
    const cur = u ? Math.round(u.desiredAlt) : null;
    const btns = ALT_PRESETS.map(([alt, label]) => {
      const active = cur != null && Math.abs(cur - alt) < 250 ? ' active' : '';
      const p = altitudeProfile(alt);
      return `<button data-alt="${alt}" class="${active}"
        title="推力${Math.round(p.thrust * 100)}% 旋回${Math.round(p.turn * 100)}% 射程×${p.missileRange.toFixed(2)}">
        ${label}<i>${alt}m</i><em>推${Math.round(p.thrust * 100)}/旋${Math.round(p.turn * 100)}</em></button>`;
    }).join('');
    const ground = u && u.onGround;
    // 整備が終わっていない機体を発進させると、そのぶん補給されないまま出る
    // （それ自体は部分補給として許している）。事故と区別できるよう警告を出す。
    const pend = ground && u.airbase ? u.airbase.pendingService(u) : null;
    const warn = pend
      ? `<div class="dt-warn">${pend.waiting
        ? '整備の順番待ちです。このまま発進すると補給を受けずに出ます'
        : `整備中（${pend.kinds.join('・')} 残り ${Math.ceil(pend.remainingSec)}秒）。`
          + 'このまま発進すると、残りは補給されません'}</div>`
      : '';
    const actions = ground
      ? `<button data-cmd="launch" class="wide go${pend ? ' warn' : ''}">発進</button>${warn}`
      : '<button data-cmd="rtb" class="wide">帰投</button><button data-cmd="clear">指示解除</button>';
    return `<div class="dt-alt"><label>目標高度</label>${btns}
      <span class="dt-spacer"></span>${actions}</div>`;
  }
}

// -------------------------------------------------------------- 表示ヘルパ

/**
 * ロースター1行の「実行内容」。
 * 指示が変わるたびに変わるので、構造ではなく値として毎フレーム書き込む。
 */
function rosterState(u) {
  if (!u.alive) return '撃墜';
  if (u.threats.length) return `<span class="ur-warn">⚠ ミサイル×${u.threats.length}</span>`;
  if (u.onGround || u.state === 'landing') return STATE_LABEL[u.state] || u.state;
  return orderLabel(u);
}

function orderLabel(u) {
  const o = u.order;
  if (!o) return '—';
  if (o.type === 'rtb') return `帰投: ${o.airbase ? o.airbase.name : '—'}`;
  const base = ORDER_LABEL[o.type] || o.type;
  if (o.type === 'attack' || o.type === 'follow') {
    return `${base}: ${o.target && o.target.alive ? o.target.name : '—'}`;
  }
  if (o.type === 'move') return `${base} → ${(o.x / 1000).toFixed(1)}/${(o.z / 1000).toFixed(1)}`;
  return base + (u.queue.length ? ` (+${u.queue.length})` : '');
}

function fmtAlt(y) {
  return y >= 1000 ? `${(y / 1000).toFixed(1)}km` : `${Math.round(y)}m`;
}

function fmtHeading(rad) {
  let deg = (rad * 180 / Math.PI) % 360;
  if (deg < 0) deg += 360;
  return String(Math.round(deg)).padStart(3, '0');
}
