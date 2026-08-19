// 進行状況の保存。仕様書 §15 / §17.1。
// 保存するのは進行状況と設定だけ。戦闘中のセーブは行わない。
//
// モードごとに独立して持つ。ステージモードのクリア状況とチュートリアルの進捗は
// 互いに影響しない。古い保存データ（cleared と settings だけ）もそのまま読める。

const KEY = 'angels_twenty_save_v1';

const DEFAULT = {
  cleared: [],        // ステージモードでクリアしたステージID
  ratings: {},        // ステージIDごとの最高評価（§18・P11で使う）
  tutorial: [],       // 終えたチュートリアルID
  settings: { speed: 1, master: 0.8, music: 0.32, sfx: 0.85 },
};

/** 既定値と同じ形の空の進行状況（参照を共有しないよう毎回作る） */
function fresh() {
  return { cleared: [], ratings: {}, tutorial: [], settings: { ...DEFAULT.settings } };
}

export function loadProgress() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return fresh();
    const p = JSON.parse(raw);
    return {
      cleared: Array.isArray(p.cleared) ? p.cleared : [],
      ratings: (p.ratings && typeof p.ratings === 'object') ? { ...p.ratings } : {},
      tutorial: Array.isArray(p.tutorial) ? p.tutorial : [],
      settings: { ...DEFAULT.settings, ...(p.settings || {}) },
    };
  } catch (e) {
    console.warn('[save] 読み込みに失敗しました', e);
    return fresh();
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

/** チュートリアルを終えた記録（ステージモードのクリア状況とは別枠） */
export function markTutorialDone(progress, tutorialId) {
  if (!progress.tutorial.includes(tutorialId)) progress.tutorial.push(tutorialId);
  saveProgress(progress);
  return progress;
}

/** ステージの評価を記録する。良いほうだけ残す（§18・P11で使う） */
export function markRating(progress, stageId, rank, order) {
  const prev = progress.ratings[stageId];
  if (!prev || order.indexOf(rank) < order.indexOf(prev)) {
    progress.ratings[stageId] = rank;
    saveProgress(progress);
  }
  return progress;
}

export function resetProgress() {
  try { localStorage.removeItem(KEY); } catch (e) { /* ignore */ }
  return fresh();
}
