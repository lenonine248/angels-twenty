// 更新履歴の表示。
//
// 内容は CHANGELOG.md をそのまま読み込んで組み立てる。
// ゲーム内用にデータを別途持つと必ず片方だけ更新されて食い違うので、
// 「履歴の出どころは CHANGELOG.md ひとつ」という形を崩さない。
//
// 対応する記法は CHANGELOG.md で実際に使っているものだけ:
//   ## 版名 — 日付   版の区切り
//   ### 見出し
//   **小見出し**     太字だけの行
//   - 箇条書き
//   段落
//   **強調** / `コード` / [文字](リンク)

const SOURCE = 'CHANGELOG.md';

let cache = null;      // パース済みの版一覧
let el = null;
let current = 0;

export function isChangelogOpen() {
  return !!el && !el.classList.contains('hidden');
}

export async function showChangelog() {
  el = document.getElementById('changelog');
  if (!el) return;
  el.classList.remove('hidden');

  if (!cache) {
    el.innerHTML = '<div class="cl-box"><div class="cl-loading">読み込み中...</div></div>';
    try {
      const res = await fetch(SOURCE, { cache: 'no-store' });
      if (!res.ok) throw new Error(`${res.status}`);
      cache = parseChangelog(await res.text());
    } catch (e) {
      cache = null;
      el.innerHTML = `<div class="cl-box">
        <div class="cl-head"><div class="cl-title">更新履歴</div>
          <button class="cl-close" data-cl="close">閉じる</button></div>
        <div class="cl-body"><p class="cl-err">${SOURCE} を読み込めませんでした（${escapeHtml(String(e.message))}）</p></div>
      </div>`;
      bind();
      return;
    }
  }
  current = 0;
  render();
  bind();
}

export function hideChangelog() {
  if (el) el.classList.add('hidden');
}

function bind() {
  if (el._bound) return;
  el._bound = true;
  el.addEventListener('click', (e) => {
    // 枠の外側をクリックしたら閉じる
    if (e.target === el) { hideChangelog(); return; }
    const b = e.target.closest('[data-cl]');
    if (!b) return;
    if (b.dataset.cl === 'close') { hideChangelog(); return; }
    const i = Number(b.dataset.cl);
    if (Number.isInteger(i)) { current = i; render(); }
  });
}

function render() {
  if (!cache || !cache.length) return;
  const tabs = cache.map((v, i) => `<button class="cl-tab${i === current ? ' active' : ''}"
      data-cl="${i}">${escapeHtml(v.version)}<span>${escapeHtml(v.date)}</span></button>`).join('');

  const v = cache[current];
  const body = v.blocks.map((b) => {
    switch (b.type) {
      case 'h':   return `<h3>${inline(b.text)}</h3>`;
      case 'sub': return `<h4>${inline(b.text)}</h4>`;
      case 'ul':  return `<ul>${b.items.map((t) => `<li>${inline(t)}</li>`).join('')}</ul>`;
      default:    return `<p>${inline(b.text)}</p>`;
    }
  }).join('');

  el.innerHTML = `<div class="cl-box">
    <div class="cl-head">
      <div class="cl-title">更新履歴</div>
      <button class="cl-close" data-cl="close">閉じる</button>
    </div>
    <div class="cl-tabs">${tabs}</div>
    <div class="cl-body">
      <div class="cl-ver">${escapeHtml(v.version)}<span>${escapeHtml(v.date)}</span></div>
      ${body}
    </div>
  </div>`;
}

// ---------------------------------------------------------------- パース

/** CHANGELOG.md を版ごとに分解する。最初の "## " より前（書き方のルール）は捨てる。 */
export function parseChangelog(text) {
  const versions = [];
  let cur = null;
  let list = null;

  const flushList = () => {
    if (list && list.items.length) cur.blocks.push(list);
    list = null;
  };

  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+$/, '');

    const ver = /^##\s+(.+)$/.exec(line);
    if (ver && !line.startsWith('###')) {
      flushList();
      // "Beta 1 — 2026-08-20" / "Beta 1 - 2026-08-20" のどちらでも拾う
      const m = /^(.*?)\s*[—–-]\s*(\d{4}-\d{2}-\d{2})\s*$/.exec(ver[1]);
      cur = {
        version: (m ? m[1] : ver[1]).trim(),
        date: m ? m[2] : '',
        blocks: [],
      };
      versions.push(cur);
      continue;
    }
    if (!cur) continue;                       // 版が始まるまでは読み飛ばす

    if (!line || /^-{3,}$/.test(line)) { flushList(); continue; }

    const h = /^###\s+(.+)$/.exec(line);
    if (h) { flushList(); cur.blocks.push({ type: 'h', text: h[1] }); continue; }

    // 太字だけの行は小見出し扱い
    const sub = /^\*\*(.+)\*\*$/.exec(line);
    if (sub) { flushList(); cur.blocks.push({ type: 'sub', text: sub[1] }); continue; }

    const li = /^[-*]\s+(.+)$/.exec(line);
    if (li) {
      if (!list) list = { type: 'ul', items: [] };
      list.items.push(li[1]);
      continue;
    }

    // 箇条書きの続き（インデントされた行）は直前の項目に足す
    if (list && /^\s+\S/.test(raw)) {
      list.items[list.items.length - 1] += ' ' + line.trim();
      continue;
    }

    flushList();
    cur.blocks.push({ type: 'p', text: line.trim() });
  }
  flushList();
  return versions;
}

// ---------------------------------------------------------------- 整形

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/** **強調** / `コード` / [文字](リンク) だけを変換する */
function inline(s) {
  return escapeHtml(s)
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')     // リンクは文字だけ残す
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}
