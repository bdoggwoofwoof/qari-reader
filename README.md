# Qari Reader

A personal replacement for Speechify: read PDFs and EPUBs aloud with word-by-word highlighting, tap any word to look it up, and save words (with their sentence) for Anki.

## What it does (v0.1)

- **Library** – add PDFs, EPUBs, Word (.docx) files, saved web pages, text files, pasted text, web articles by link, or photos of pages. Everything is stored on the device (IndexedDB) unless you turn on sync.
- **PDF clean-up** – drops running headers, page numbers, footnotes and footnote markers; re-joins hyphenated words and paragraphs split across pages; splits into sections using the PDF outline, or its headings, or 10-page groups.
- **EPUB** – reads the spine and table of contents, skips footnotes; detects DRM-protected books and says so.
- **Read aloud** – the device's own voices (free). Sentence-by-sentence playback, current sentence tinted and current word highlighted, speed 0.5–3×, skip by sentence, remembers your place, keeps the screen awake while playing, lock-screen controls where supported.
- **Languages** – English, Arabic, French and German out of the box (plus Spanish, Italian, Portuguese, Dutch, Persian, Hebrew, Russian, Greek, Turkish, Urdu). Book language is detected; Arabic-script paragraphs inside a non-Arabic book switch to the Arabic voice automatically and display right-to-left.
- **Word lookup** – double-tap a word: playback pauses, and picks up again from that word when you close the lookup. English definitions come from Wiktionary. Arabic lookups strip harakat and try likely base forms (ال، و، ب، ـها، ـات …); French elisions (l’homme) and inflected forms (“plural of …”) are followed to the base word. Links to Almaany / WordReference / Merriam-Webster; for Arabic also Lughatuna (Living Arabic Project, Levantine and Egyptian dictionaries), which copies the word without vowel marks so you can paste it into its search, and Google Translate for the sentence.
- **Saved words** – list by language, hear them, export a tab-separated file that Anki imports directly (word, meaning, sentence with the word in bold, source, language tag).
- **Installable** – works as an app on iPhone/Android (Add to Home Screen) and desktop; opens offline once loaded.

- **Player** – time left in the section, a progress bar you can tap to jump, a sleep timer (15–60 min or end of section), and a “Back to reading” button when you scroll away.
- **Practice** – speed per language, pause or repeat after each sentence, a repeat button, and a switch to hide Arabic vowel marks (the voice still reads them).
- **Cleaner listening** – skips in-text citations like “(Smith, 2019)”, “[12]” and web addresses; a pronunciation list for names and terms.
- **Lookups** – Arabic lookups also show Levantine, Iraqi and Egyptian entries.
- **Library** – voice check on first launch, search, rename, folders by course (adding a book while a folder is open puts it there).
- **More ways in** – *Add a web link* fetches the page through `api/article.ts` and keeps only the article (Mozilla Readability), with redirects checked and private network addresses refused. On Android, *Share → Qari* from any app opens it with the link filled in. *Scan pages* reads photos with text recognition (Tesseract) on the device, in English, Arabic, French or German; scanned PDFs are detected and read the same way, keeping their page numbers and the original-page view. The recognizer and its language data are copied from npm into `public/ocr` at build time and served by the app itself, so nothing goes to a third party and it works offline after the first use.
- **Language tools** – in languages you’re learning (Arabic, French and German to start; change it in reading settings), words you haven’t marked known get a dotted underline and saved words a solid one. Mark a word known from its lookup, or a whole section at once; each book shows how many new words it has. Select several words to look them up as a phrase; translate a phrase or the sentence. Translation uses the free MyMemory service from the device (about 5,000 characters a day per device), or, if you set `ANTHROPIC_API_KEY` and `QARI_ACCESS_CODE` (a random passphrase of 20+ characters; also set a monthly spend limit on the key in the Anthropic Console) in Vercel and enter the code in reading settings, Claude through `api/translate.ts`, which explains meaning in context and says whether Arabic is Shami, Egyptian or Fusha.
- **Send to Anki** – from a computer with Anki and the AnkiConnect add-on (2055492159): words go to their own “Qari::Language” deck with a “Qari Language” note type that speaks with Anki’s built-in text-to-speech. Already-sent words are remembered (and synced), so words saved on the phone are sent once from the laptop. The file export still works anywhere.
- **School tools** – select text to highlight it or add a note; each highlight keeps the PDF’s printed page number. Notes panel per book with copy-all and a Markdown download, quotes formatted as “…” (Author, p. 45). Full-text search inside a book that ignores accents, Arabic vowel marks and alif/ya variants. Page markers between paragraphs (in the margin on wide screens); tap one to see the original PDF page for tables and figures.
- **Sync** – books, reading position, saved words and settings follow you between devices. Turn it on from the cloud button, then scan the QR code on your other device. Everything is encrypted on the device (AES-GCM, key derived from the sync code) before upload; the server stores only ciphertext in a private Vercel Blob store via `api/sync.ts`. If you read further on another device, the open book offers to jump there.

- **Tour** – on first launch a six-step tour shows the library and, on a short sample, the reader. Take it again from the ⋯ menu in the library, which also holds sync, voices, light/dark mode and backups.
- **Backups** – *Download a backup* saves every book, original PDF, note and saved word in one file; *Restore from a backup* adds back anything missing. If the library is only on this device and the browser could clear it (Safari does after a while unless Qari is on the Home Screen), the library says so once and offers sync or a backup.

- **Easier reading** – reading settings offer fonts made for dyslexia (OpenDyslexic, Lexend, Atkinson Hyperlegible) with their own spacing, and *Bold word starts* (bionic reading) for Latin-script text. **Speed read** (above the play button) shows one word at a time in a fixed spot with a red focus letter, 100–1000 words a minute, pausing longer at commas and full stops; closing it puts your place on the last word shown. Pause (tap anywhere) to look up the word on screen or any word in this sentence or the one before; *Read aloud* lets the voice read along and set the pace. All of these work for every kind of book.

Gestures: tap a word to read from there (or to mark where Play starts), double-tap it to look it up.
Keyboard: Space = play/pause, ← / → = previous / next sentence, R = repeat sentence.

## Run it

```bash
npm install
npm run dev      # http://localhost:5173
npm test         # unit tests (Vitest)
npm run check    # typecheck + tests
npm run build    # production build in dist/
```

## Deploy (Vercel)

Push to a GitHub repo, import it in Vercel, framework preset **Vite**. For sync, connect a **private** Blob store to the project (Storage › Create › Blob); Vercel adds `BLOB_READ_WRITE_TOKEN` automatically. Without it the app works, and sync shows that storage isn't set up.

## Known limits

- Voices are whatever the device has. Quality varies a lot: Apple “Enhanced/Premium” and Microsoft Edge “Natural” voices are good; some Android voices don’t report word timing, so the highlight is estimated from reading pace.
- iPhone stops speech when the screen locks (the app keeps the screen awake while playing to avoid this).
- Text recognition is good on clean print and weaker on handwriting, curved pages, poor light and large bold Arabic headings. Photos aren’t kept, so the original-page view is only for PDFs.
- Arabic PDFs are read in the right order, including English words and numbers inside Arabic lines; PDFs with unusual layouts (several columns, tables) can still come out jumbled — EPUB, Word and scanned Arabic are the most reliable.
- Web articles behind a login or paywall can’t be fetched; use Paste text.

## Roadmap ideas

2. Premium voices (pay-per-use API) as an option per language.

## Status log

This is the central doc for Qari: each working session adds a dated entry here.

### Oct 27, 2026
- **Changed:** added speed reading (one word at a time in a fixed spot with a red focus letter, 100–1000 words a minute, longer pauses at punctuation; closing it puts your place on the last word shown). Added dyslexia-friendly fonts (OpenDyslexic, Lexend, Atkinson Hyperlegible) and *Bold word starts* (bionic reading) in reading settings. These work in every book, whether EPUB, PDF, Word, web or scan. The tour gained a Speed read step.
- **Decisions:** speed reading runs silently at its own speed rather than following the voice. Bionic reading and the dyslexia font's size and spacing apply to left-to-right text only; Arabic keeps its own font, because letter spacing breaks Arabic letter joining. The new settings sync between devices.
- **Status:** live at qari-reader.vercel.app; tested on a phone-sized screen with a PDF and an EPUB.
- **Open:** iPhone web apps can only use Apple's pre-installed (basic) voices, so getting good voices on the phone needs voices built into Qari (Piper/Kokoro, free) or Azure (free tier, then paid). Newt hasn't chosen yet. Earlier this week: only natural-sounding voices are listed, there's a light/dark switch, a guided tour, and light and dark icons.

### Oct 27, 2026 (later)
- **Changed:** in the speed reader, pausing now lets you look up the word on screen or any word in the current or previous sentence, using the same lookup as the page. Nothing extra shows while it's playing. A *Read aloud* switch lets the voice read along: the word on screen follows the voice, and the speed controls change the voice speed.
- **Status:** good iPhone voices are still blocked by Apple (web apps only get the pre-installed basic voices). Waiting on Newt's choice: voices built into Qari, or Azure.

### Oct 27, 2026 (tap change)
- **Changed:** tapping a word now sets where reading starts. If the voice is reading, it carries on from that word; if paused, the word is marked and Play starts there. Double-tapping a word looks it up, or opens its highlight. The tour, tips and README now say so.

### Oct 27, 2026 (placemark)
- **Changed:** each book has one placemark, shared by listening, the speed reader and reading by scrolling. It saves the exact word: where the voice paused, the word you tapped, or the last word the speed reader showed (even if you leave the app without closing it). Reading by scrolling only moves the placemark after you say yes when Qari asks (see the next entry). On reopening, the placemark sentence is tinted, even when it's the first sentence of a paragraph (before, those showed no mark). It syncs between devices like before.

### Oct 27, 2026 (scroll reading asks first)
- **Changed:** scrolling no longer moves the placemark by itself. If you scroll slowly and steadily past a couple of paragraphs (reading pace, about 55 characters a second or less, for at least 8 seconds), Qari asks once: "Reading as you scroll?" Choosing *Follow my place* keeps the placemark at the top of the screen as you scroll, with a small chip to turn it off. Choosing *No, just looking* means it won't ask again until you reopen the book. Fast scrolling, like looking for something or checking where the section ends, never asks and never moves the placemark.
- **Decision (Newt):** scrolling ahead to search or peek must never move the placemark without asking.
