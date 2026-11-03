# Qari interface system

The rules every screen follows. Tokens live in `src/index.css`; shared controls live in `src/components/ui.tsx`. Use these instead of writing a new button style in a component.

## Type
Interface (Instrument Sans), five sizes:

| Class | Size | Use |
|---|---|---|
| `text-xs` | 12px | Captions, status, badges |
| `text-sm` | 14px | Buttons, hints, meta lines |
| `text-base` | 16px | Body, toggle titles, serif snippets (quotes, definitions) |
| `text-lg` | 18px | Sheet titles |
| `text-xl` | 20px | Book titles in lists |

Display sizes (`text-2xl` and up) are only for a single word: the looked-up word, the speed-reader word, the wordmark. The reading text has its own size (14–32px, set by the reader) and is never tied to this scale. Weights: regular, semibold (600). Section titles inside sheets are 16px semibold with a hairline above (`Section`).

## Heights
- `h-11` 44px: every button and input by default.
- `h-9` 36px: compact inline controls (chips, buttons inside rows and status lines). `Button compact`.
- `h-14` 56px: the play button only.

## Radii
- `rounded-full`: buttons, chips, round icon buttons.
- `rounded-xl` 12px: inputs, choice tiles, boxes, segmented controls.
- `rounded-2xl` 16px: sheets and dialogs.
- Exceptions: the player card (28px, waiting on a style decision) and text marks inside the reading surface (2–3px).

## Shadows
- `shadow-float`: anything floating over the page (player, selection toolbar, status pills).
- `shadow-sheet`: sheets, dialogs and the tour card.

## Spacing
- One phone gutter: 20px (`px-5`) in the library, reader, saved words and sheets.
- Rows in lists have hairline dividers (`divide-line`), not boxes.

## Color roles
- `moss` green: actions and selection. One filled (primary) button per view at most.
- `mark` yellow: only text you're attending to (the spoken word, saved highlights).
- `wash`: the spoken sentence and selected tiles; also text selection.
- `edge`: borders of interactive controls (inputs, outline buttons, tiles). `line`: hairline dividers. `edge` currently equals `line`; the 3:1 values are waiting on approval.
- `focus` red (#d9342b): the speed reader's focus letter, nothing else.

## Shared controls (ui.tsx)
- `Button` (`primary`, `secondary`, `quiet`, `danger`; `compact`): every labelled button.
- `IconButton`: 44px round icon button with an aria-label.
- `Choices`: one choice from a few (After each sentence, Page).
- `Segmented`: tabs that switch a view in place (reading settings, book panel).
- `Chip`: on/off, several can be on (languages you're learning).
- `Toggle`: an on/off setting with title and hint; the whole row is the target.
- `Section`: a titled group inside a sheet.
- `ActionList` + `ActionRow`: a list of actions with icon, title and one line (Add, the ⋯ menu, book options, Anki).
- `Sheet`: every dialog. Focus moves into it, Tab stays inside, and focus returns on close.
- `ask()` + `ConfirmHost`: "Are you sure?" as a sheet. Never use the browser's `confirm()`.

## Organization
- Reading settings has three tabs: Listening (speed, after each sentence, voices, follow along, skip citations, pronunciations), Reading (page, text size, reading font, bold word starts, line focus), Languages (language of the book, languages you're learning, Arabic, Claude translation). The last tab used is remembered.
- The reader header has four controls: back, search, contents and notes, settings. Saved words are reached from the library or from the Notes tab.
- In the player, status (time left) is plain text; actions (Speed read, Sleep) are 44px buttons.
- The library leads with the book in progress (Continue reading) when there's more than one book and you're not searching or in a folder.
