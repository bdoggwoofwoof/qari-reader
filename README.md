# Qari Reader

A personal replacement for Speechify: read PDFs and EPUBs aloud with word-by-word highlighting, tap any word to look it up, and save words (with their sentence) for Anki.

## What it does (v0.1)

- **Library** – add PDFs, EPUBs, text files, or pasted text. Everything is stored on the device (IndexedDB); nothing is uploaded.
- **PDF clean-up** – drops running headers, page numbers, footnotes and footnote markers; re-joins hyphenated words and paragraphs split across pages; splits into sections using the PDF outline, or its headings, or 10-page groups.
- **EPUB** – reads the spine and table of contents, skips footnotes; detects DRM-protected books and says so.
- **Read aloud** – the device's own voices (free). Sentence-by-sentence playback, current sentence tinted and current word highlighted, speed 0.5–3×, skip by sentence, remembers your place, keeps the screen awake while playing, lock-screen controls where supported.
- **Languages** – English, Arabic, French and German out of the box (plus Spanish, Italian, Portuguese, Dutch, Persian, Hebrew, Russian, Greek, Turkish, Urdu). Book language is detected; Arabic-script paragraphs inside a non-Arabic book switch to the Arabic voice automatically and display right-to-left.
- **Word lookup** – tap a word: playback pauses and English definitions come from Wiktionary. Arabic lookups strip harakat and try likely base forms (ال، و، ب، ـها، ـات …); French elisions (l’homme) and inflected forms (“plural of …”) are followed to the base word. Links to Almaany / WordReference / Merriam-Webster and Google Translate for the sentence.
- **Saved words** – list by language, hear them, export a tab-separated file that Anki imports directly (word, meaning, sentence with the word in bold, source, language tag).
- **Installable** – works as an app on iPhone/Android (Add to Home Screen) and desktop; opens offline once loaded.

- **Player** – time left in the section, a progress bar you can tap to jump, a sleep timer (15–60 min or end of section), and a “Back to reading” button when you scroll away.
- **Practice** – speed per language, pause or repeat after each sentence, a repeat button, and a switch to hide Arabic vowel marks (the voice still reads them).
- **Cleaner listening** – skips in-text citations like “(Smith, 2019)”, “[12]” and web addresses; a pronunciation list for names and terms.
- **Lookups** – Arabic lookups also show Levantine, Iraqi and Egyptian entries.
- **Library** – voice check on first launch, search, rename.

Gestures: tap a word to look it up, double-tap it to read from there.
Keyboard: Space = play/pause, ← / → = previous / next sentence, R = repeat sentence.

## Run it

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # production build in dist/
```

## Deploy (Vercel)

Push to a GitHub repo, import it in Vercel, framework preset **Vite**. No environment variables needed.

## Known limits

- Voices are whatever the device has. Quality varies a lot: Apple “Enhanced/Premium” and Microsoft Edge “Natural” voices are good; some Android voices don’t report word timing, so the highlight is estimated from reading pace.
- iPhone stops speech when the screen locks (the app keeps the screen awake while playing to avoid this).
- Scanned PDFs (images of pages) need OCR, which isn’t built yet. Arabic text extracted from some PDFs can come out in the wrong order; EPUB Arabic is reliable.
- Library and saved words live on each device separately; sync between phone and laptop is a planned next step.

## Roadmap ideas

1. Sync library, position and saved words across devices.
2. Premium voices (pay-per-use API) as an option per language.
3. OCR for scanned pages and photos.
4. Better Arabic dictionary (dialect-aware, root lookup) and direct Anki deck sync.
5. Web article import by link.
