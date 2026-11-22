import en from '../locale/en.json' with { type: 'json' }
import zh from '../locale/zh.json' with { type: 'json' }

/** Locale JSON is the single copy source; the browser build inlines it. */
export const copy = { en: en.trash, zh: zh.trash }
export type CopyKey = keyof typeof copy.en
