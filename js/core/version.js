// バージョン情報。ここが唯一の出どころ。
//
// 表示・更新履歴（CHANGELOG.md）・不具合報告のいずれもこの値を指すようにして、
// 「画面に出ている版」と「履歴に書いてある版」がずれないようにする。

/** 画面に出す版名 */
export const VERSION = 'Beta 2.46';

/** この版を切った日 */
export const VERSION_DATE = '2026-08-24';

/** 表示用（例: "Beta 1 (2026-08-20)"） */
export const VERSION_LABEL = `${VERSION} (${VERSION_DATE})`;
