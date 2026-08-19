// 進行状況の保存。仕様書 §15。
// 保存するのはクリア済みステージと設定だけ。戦闘中のセーブは行わない。

const KEY = 'angels_twenty_save_v1';

const DEFAULT = {
  cleared: [],
  settings: { speed: 1, master: 0.8, music: 0.32, sfx: 0.85 },
};

export function loadProgress() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT, cleared: [] };
    const p = JSON.parse(raw);
    return {
      cleared: Array.isArray(p.cleared) ? p.cleared : [],
      settings: { ...DEFAULT.settings, ...(p.settings || {}) },
    };
  } catch (e) {
    console.warn('[save] 読み込みに失敗しました', e);
    return { ...DEFAULT, cleared: [] };
  }
}

export function saveProgress(progress) {
  try {
    localStorage.setItem(KEY, JSON.stringify(progress));
  } catch (e) {
    console.warn('[save] 保存に失敗しました', e);
  }
}

/** 設定だけを書き換えて保存する（クリア状況は触らない） */
export function saveSettings(progress, patch) {
  progress.settings = { ...progress.settings, ...patch };
  saveProgress(progress);
  return progress.settings;
}

export function markCleared(progress, stageId) {
  if (!progress.cleared.includes(stageId)) progress.cleared.push(stageId);
  saveProgress(progress);
  return progress;
}

export function resetProgress() {
  try { localStorage.removeItem(KEY); } catch (e) { /* ignore */ }
  return { ...DEFAULT, cleared: [] };
}
