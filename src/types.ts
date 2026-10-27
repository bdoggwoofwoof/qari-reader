export type Lang = string // BCP-47 base code: 'en', 'ar', 'fr', 'de', ...

export interface Chapter {
  title: string
  blocks: string[] // paragraphs / headings, plain text
  headings?: number[] // indexes of blocks that are headings
  pages?: string[] // printed page label(s) for each block, e.g. "45" or "45–46" (PDFs)
  pageIdx?: number[] // 0-based PDF page index where each block starts (for "Show original page")
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
  kind: 'pdf' | 'epub' | 'text' | 'docx' | 'web' | 'scan'
  source?: string // web address, for articles added by link
  lang: Lang
  addedAt: number
  openedAt: number
  position: Position
  chapterCount: number
  charCount: number
  charsBefore: number[] // cumulative char count at start of each chapter (for progress)
  progress?: number // 0..1
  folder?: string
  vocab?: { unique: number; fresh: number; at: number } // distinct words / new words, for languages you're learning
  updatedAt?: number // title, language, folder and other edits
  positionAt?: number // when the reading position last moved
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
  updatedAt?: number
  ankiAt?: number // when it was sent to Anki (synced, so a word saved on the phone is sent once, from the laptop)
  phrase?: boolean
}

export interface Highlight {
  id: string
  docId: string
  chapter: number
  startBlock: number
  start: number // char offset in startBlock
  endBlock: number
  end: number // char offset in endBlock (exclusive)
  text: string
  note: string
  page?: string
  createdAt: number
  updatedAt: number
}

export interface Settings {
  rate: number
  voices: Record<Lang, string> // lang -> voiceURI
  fontSize: number
  theme: 'light' | 'sepia' | 'dark'
  autoScroll: boolean
  arabicFont: ArabicFont
  rates: Record<Lang, number> // speed per language; falls back to rate
  afterSentence: 'continue' | 'pause' | 'repeat'
  showHarakat: boolean
  readFont?: ReadFont
  bionic?: boolean // bold the start of each word
  speedWpm?: number // speed reader, words per minute
  skipCitations: boolean
  pronunciations: Pronunciation[]
  voiceCheckDone: boolean
  showAllVoices?: boolean // per device: list basic voices too
  tourDone?: boolean // per device: the guided tour has been offered
  learning: Lang[] // languages you're learning: new words are marked in their books
  ankiDecks: Record<Lang, string> // deck to send each language's words to
  translateCode?: string // access code for the optional Claude translation on your Vercel deployment
  updatedAt?: number // when a synced setting last changed
}

export interface Pronunciation {
  from: string
  to: string
}

export type ArabicFont = 'readex' | 'noto-sans' | 'naskh'
export type ReadFont = 'literata' | 'opendyslexic' | 'lexend' | 'atkinson'

/** Fonts for reading Latin-script text. The last three are designed to be easier to read with dyslexia. */
export const READ_FONTS: Record<ReadFont, { label: string; hint: string; family: string; size: string; leading: string; spacing: string; wordSpacing: string }> = {
  literata: { label: 'Literata', hint: 'Book', family: "'Literata Variable'", size: '1em', leading: '1.68', spacing: '0', wordSpacing: '0' },
  opendyslexic: { label: 'OpenDyslexic', hint: 'Weighted letters', family: "'OpenDyslexic'", size: '0.88em', leading: '1.8', spacing: '0', wordSpacing: '0' },
  lexend: { label: 'Lexend', hint: 'Wide, even', family: "'Lexend Variable'", size: '0.97em', leading: '1.8', spacing: '0.01em', wordSpacing: '0.08em' },
  atkinson: { label: 'Atkinson', hint: 'Clear shapes', family: "'Atkinson Hyperlegible Next Variable'", size: '1.02em', leading: '1.75', spacing: '0.01em', wordSpacing: '0.06em' },
}

export const ARABIC_FONTS: Record<ArabicFont, { label: string; family: string; size: string; leading: string }> = {
  readex: { label: 'Readex Pro', family: "'Readex Pro Variable'", size: '1.04em', leading: '1.95' },
  'noto-sans': { label: 'Noto Sans', family: "'Noto Sans Arabic Variable'", size: '1.1em', leading: '1.95' },
  naskh: { label: 'Naskh', family: "'Noto Naskh Arabic Variable'", size: '1.15em', leading: '2.05' },
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
