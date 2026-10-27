# Qari Reader

A personal replacement for Speechify: read PDFs and EPUBs aloud with word-by-word highlighting, tap any word to look it up, and save words (with their sentence) for Anki.

## What it does (v0.1)

- **Library** – add PDFs, EPUBs, Word (.docx) files, saved web pages, text files, pasted text, web articles by link, or photos of pages. Everything is stored on the device (IndexedDB) unless you turn on sync.
- **PDF clean-up** – drops running headers, page numbers, footnotes and footnote markers; re-joins hyphenated words and paragraphs split across pages; splits into sections using the PDF outline, or its headings, or 10-page groups.
- **EPUB** – reads the spine and table of contents, skips footnotes; detects DRM-protected books and says so.
- **Read aloud** – the device's own voices (free). Sentence-by-sentence playback, current sentence tinted and current word highlighted, speed 0.5–3×, skip by sentence, remembers your place, keeps the screen awake while playing, lock-screen controls where supported.
- **Languages** – English, Arabic, French and German out of the box (plus Spanish, Italian, Portuguese, Dutch, Persian, Hebrew, Russian, Greek, Turkish, Urdu). Book language is detected; Arabic-script paragraphs inside a non-Arabic book switch to the Arabic voice automatically and display right-to-left.
- **Word lookup** – tap a word: playback pauses, and picks up again from that word when you close the lookup. English definitions come from Wiktionary. Arabic lookups strip harakat and try likely base forms (ال، و، ب، ـها، ـات …); French elisions (l’homme) and inflected forms (“plural of …”) are followed to the base word. Links to Almaany / WordReference / Merriam-Webster; for Arabic also Lughatuna (Living Arabic Project, Levantine and Egyptian dictionaries), which copies the word without vowel marks so you can paste it into its search, and Google Translate for the sentence.
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

- **Easier reading** – reading settings offer fonts made for dyslexia (OpenDyslexic, Lexend, Atkinson Hyperlegible) with their own spacing, and *Bold word starts* (bionic reading) for Latin-script text. **Speed read** (above the play button) shows one word at a time in a fixed spot with a red focus letter, 100–1000 words a minute, pausing longer at commas and full stops; closing it puts your place on the last word shown. All of these work for every kind of book.

Gestures: tap a word to look it up, double-tap it to read from there.
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
