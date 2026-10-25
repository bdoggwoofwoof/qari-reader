export type Lang = string // BCP-47 base code: 'en', 'ar', 'fr', 'de', ...

export interface Chapter {
  title: string
  blocks: string[] // paragraphs / headings, plain text
  headings?: number[] // indexes of blocks that are headings
}

export interface Position {
  chapter: number
  block: number
  offset: number // character offset inside the block
}

export interface DocMeta {
  id: string
  title: string
  author?: string
  kind: 'pdf' | 'epub' | 'text'
  lang: Lang
  addedAt: number
  openedAt: number
  position: Position
  chapterCount: number
  charCount: number
  charsBefore: number[] // cumulative char count at start of each chapter (for progress)
  progress?: number // 0..1
}

export interface DocContent {
  id: string
  chapters: Chapter[]
}

export interface SavedWord {
  id: string
  word: string
  lemma?: string
  lang: Lang
  definition: string
  sentence: string
  source: string
  addedAt: number
}

export interface Settings {
  rate: number
  voices: Record<Lang, string> // lang -> voiceURI
  fontSize: number
  theme: 'light' | 'sepia' | 'dark'
  autoScroll: boolean
}

export const LANG_NAMES: Record<string, string> = {
  en: 'English',
  ar: 'Arabic',
  fr: 'French',
  de: 'German',
  es: 'Spanish',
  it: 'Italian',
  pt: 'Portuguese',
  tr: 'Turkish',
  fa: 'Persian',
  ur: 'Urdu',
  he: 'Hebrew',
  ru: 'Russian',
  nl: 'Dutch',
  el: 'Greek',
}

export const RTL_LANGS = new Set(['ar', 'fa', 'ur', 'he'])
