# Teaching Mode: Play to Learn — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A "Play to learn" game in which the coach explains the position and shows good moves before each user move, fades to guidance per topic, and never touches the Play-mode assessment.

**Architecture:** A `mode` on each game (`'play' | 'teach'`). New pure modules in `src/teach/` choose the options, the topic, the position text and the fade state. `Coach` gains a teaching pre-move path and a strict, reveal-at-once mistake path; `useGame` routes by mode and skips every assessment call in teaching games.

**Tech Stack:** TypeScript strict, React 19, Vitest (+ Testing Library, fake-indexeddb), Playwright, chess.js, zod v4. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-28-teaching-play-to-learn-design.md` — read it first.

## Global Constraints

- Truth rule: every statement about the position comes from chess.js, `positionFacts`, the repertoire file, or the engine analysis. Claude only rewords checked text and its output passes validators; on any failure the template is used. Everything works offline.
- No jargon: all user-facing text must pass `findJargon` (`src/coach/jargon.ts`) with no hits.
- Play mode's behaviour and its existing tests do not change. Do not edit an existing test's expectations except where a task says so.
- Old saved profiles, games and backups keep loading: every new stored field is optional.
- Analysis stays at the existing depth 14 / multipv 3; no extra engine search per option.
- Commands: `npx vitest run <file>` for one file, `npm test` for all, `npm run build` (must be warning-free), `npm run e2e`. Never run `playwright install`.
- Commit after each task. End every commit message with the two trailer lines used by the latest commits on this branch (`git log -1`).
- Repo artifacts never name an AI model outside commit trailers.

## Review Focus

1. Engine analysis fails or is stopped during a teaching turn → the turn still shows their-move and position text with no options and no crash; the move is not counted for the fade.
2. A teaching game is resumed after reload → it is still a teaching game (label, options, no assessment writes).
3. User opens "Show me options", takes a move back later and replays → fade counts unchanged by the retry.
4. A position with one legal move, or where the best line is the only analysed line → exactly one option, no duplicate.
5. A backup exported before this change (no `mode`, no `teaching`, no `teachCount`) → imports and plays; Patterns shows only game counts.

Each is pinned by a named test in the owning task below.

## File Structure

| File | Responsibility |
|---|---|
| `src/types.ts` (modify) | `GameMode`, `TeachTopic`, `TeachMode`, `TopicState`, `TeachState`; optional fields on `ThemeStat`, `ProfileData` |
| `src/storage/db.ts` (modify) | `SavedGame.mode`; zod accepts the new fields |
| `src/profile/profile.ts` (modify) | `recordTeachTheme` |
| `src/profile/games.ts` (create) | `playGames` — the one filter every assessment reader uses |
| `src/teach/fade.ts` (create) | fade constants and state machine |
| `src/teach/topic.ts` (create) | `topicOf`, `TOPIC_LABEL` |
| `src/teach/options.ts` (create) | `teachOptions`, `previewLine` |
| `src/teach/position.ts` (create) | `positionText` |
| `src/coach/coach.ts` (modify) | `setMode`, `teachTurn`, `openOptions`, teaching branch of `onUserMove`, `teachRecap` |
| `src/coach/claude.ts` (modify) | `buildTeachPacket` |
| `src/ui/useGame.ts` (modify) | mode routing, assessment isolation, fade recording |
| `src/ui/TeachPanel.tsx` (create) | renders a teach message |
| `src/ui/GameScreen.tsx`, `MistakeCard.tsx`, `PatternsScreen.tsx`, `RecapCard.tsx`, `App.tsx`, `styles.css` (modify) | start choice, label, arrows, counts |
| `e2e/teach.spec.ts` (create) | end-to-end teaching turn |

Tests mirror sources under `tests/` (`tests/teach/*.test.ts`, etc.).

---

### Task 1: Data model, storage, and the play-games filter

**Files:**
- Modify: `src/types.ts`, `src/storage/db.ts`, `src/profile/profile.ts`, `src/profile/attackLines.ts`, `src/ui/useGame.ts` (only `lastFiveScore`), `src/ui/App.tsx` (only the games count)
- Create: `src/profile/games.ts`
- Test: `tests/storage/db.test.ts`, `tests/profile/profile.test.ts`, `tests/profile/games.test.ts`, `tests/profile/attackLines.test.ts`

**Interfaces — Produces:**

```ts
// src/types.ts
export type GameMode = 'play' | 'teach';
export type TeachTopic = 'opening' | 'safety' | 'captures' | 'checks' | 'development' | 'endgame' | 'other';
export type TeachMode = 'show' | 'guide';
/** shown: shown turns since entering show. need: shown turns required before the next trial. recent: guide turns, true = success, newest last. */
export interface TopicState { mode: TeachMode; shown: number; need: number; recent: boolean[] }
export interface TeachState { gamesFinished: number; topics: Partial<Record<TeachTopic, TopicState>> }
// ThemeStat gains:   teachCount?: number; teachExamples?: { gameId: string; ply: number; fen: string }[];
// ProfileData gains: teaching?: TeachState;

// src/storage/db.ts — SavedGame gains:  mode?: GameMode;   // absent = 'play'

// src/profile/games.ts
export function playGames(games: SavedGame[]): SavedGame[];   // those with mode !== 'teach'

// src/profile/profile.ts
/** Adds a flagged teaching-game verdict to the theme's teachCount / teachExamples (last 10). Touches nothing else. */
export function recordTeachTheme(p: ProfileData, v: Verdict, ctx: { gameId: string; ply: number; fen: string; at: number }): ProfileData;
```

- [ ] **Step 1: Write failing tests**
  - `games.test.ts` — `playGames drops teaching games and keeps games with no mode`.
  - `profile.test.ts` — `recordTeachTheme`: flagged verdict raises `teachCount` to 1 and adds an example; `count`, `examples`, `moves`, `levels` are deep-equal to before; `lastSeen` unchanged; an unflagged verdict returns an equal profile; 11 calls keep 10 `teachExamples`.
  - `db.test.ts` — `imports a backup with no teaching fields` (Review Focus 5: an existing-format backup round-trips, `getProfile().teaching` is undefined, game `mode` undefined); `round-trips mode, teaching and teachCount through export/import`; `rejects mode: 'other'`.
  - `attackLines.test.ts` — `ignores teaching games`: three qualifying play games plus a newer non-qualifying teach game still returns true.
- [ ] **Step 2: Run them, confirm they fail** — `npx vitest run tests/profile tests/storage`
- [ ] **Step 3: Implement.** Types as above. zod: `gameSchema.mode: z.enum(['play','teach']).optional()`; `themeStatSchema` add optional `teachCount` (number) and `teachExamples` (same shape as `examples`); `profileSchema.teaching` optional object `{ gamesFinished: number, topics: partialRecord(topicEnum, { mode: enum, shown: number, need: number, recent: boolean[] }) }`. `suggestLinesOff` and `lastFiveScore` apply `playGames` first; `App.tsx` counts `playGames(g).length` in both places it reads `listGames()` for `gamesCount`.
- [ ] **Step 4: Run all tests** — `npm test` passes, nothing existing changed.
- [ ] **Step 5: Commit** — `feat: teaching data model and play-games filter`

---

### Task 2: Fade state machine

**Files:** Create `src/teach/fade.ts`; Test `tests/teach/fade.test.ts`

**Interfaces — Produces:**

```ts
export const FADE = { FREE_GAMES: 3, SHOWN_BEFORE_TRIAL: 5, SHOWN_AFTER_FALL_BACK: 3, WINDOW: 4, MISSES_TO_FALL_BACK: 2 } as const;
export function emptyTeachState(): TeachState;                                   // { gamesFinished: 0, topics: {} }
export function modeFor(s: TeachState | undefined, topic: TeachTopic): TeachMode;
/** One counted turn. `mode` is the mode the turn was presented in. */
export function recordTurn(s: TeachState | undefined, topic: TeachTopic,
  turn: { mode: TeachMode; flagged: boolean; openedOptions: boolean }): TeachState;
export function finishGame(s: TeachState | undefined): TeachState;              // gamesFinished + 1
/** Topics whose mode differs between two states (by modeFor), for the recap. */
export function topicChanges(before: TeachState | undefined, after: TeachState): { topic: TeachTopic; to: TeachMode }[];
```

Rules (the spec's "How showing fades to guiding"):
- `modeFor`: `'show'` when `gamesFinished < FREE_GAMES`, or topic is `opening` or `other`. Otherwise the stored mode; with no stored state, `endgame` is `'guide'` and every other topic `'show'`.
- `recordTurn` returns `s` unchanged (or `emptyTeachState()` for undefined) when `gamesFinished < FREE_GAMES` or topic is `opening`/`other`.
- Show turn: `shown + 1`; when `shown >= need` → `{ mode: 'guide', shown: 0, need, recent: [] }`. Initial `need` is `SHOWN_BEFORE_TRIAL`.
- Guide turn: push `!flagged && !openedOptions` onto `recent`, keep the last `WINDOW`; when it holds `MISSES_TO_FALL_BACK` falses → `{ mode: 'show', shown: 0, need: SHOWN_AFTER_FALL_BACK, recent: [] }`.
- `topicChanges`: for each topic except `opening`/`other`, report it when `modeFor(before, topic) !== modeFor(after, topic)`, with `to` = the mode in `after`.

- [ ] **Step 1: Write failing tests** (state helper: `const live = { gamesFinished: 3, topics: {} }`)
  - `everything is show in the first 3 games` — `modeFor({gamesFinished: 2, topics: {endgame: {mode:'guide',shown:0,need:5,recent:[]}}}, 'endgame') === 'show'`; `recordTurn` on that state returns it deep-equal.
  - `opening and other never leave show` — 10 show turns on each: `modeFor` still `'show'`, `topics` empty.
  - `endgame starts in guide once fading begins` — `modeFor(live, 'endgame') === 'guide'`, `modeFor(live, 'safety') === 'show'`.
  - `5 shown turns start a guide trial` — 4 turns: show; 5th: guide.
  - `two misses in the last four guide turns fall back` — guide turns success, miss, success, miss → show with `need === 3`; then 3 shown turns → guide.
  - `a miss ages out of the window` — miss, success ×4, miss → still guide.
  - `opening the options is a miss even with a good move` — `{flagged:false, openedOptions:true}` twice → show.
  - `finishGame counts from undefined` → `gamesFinished === 1`.
  - `topicChanges reports safety → guide` after the 5th shown turn; empty when nothing changed.
- [ ] **Step 2: Run, confirm fail** — `npx vitest run tests/teach/fade.test.ts`
- [ ] **Step 3: Implement** the five functions; pure, no mutation of inputs.
- [ ] **Step 4: Run, confirm pass**
- [ ] **Step 5: Commit** — `feat: teaching fade rules`

---

### Task 3: Options, topic and position text

**Files:** Create `src/teach/options.ts`, `src/teach/topic.ts`, `src/teach/position.ts`; Test `tests/teach/options.test.ts`, `tests/teach/topic.test.ts`, `tests/teach/position.test.ts`

**Interfaces:**
- Consumes: `bookReplies`, `lookup`, `BookHit` (`src/openings/repertoire.ts`); `deriveReasons`, `reasonText`, `Reasons` (`src/coach/reasons.ts`); `lineScore` (`src/coach/classify.ts`); `positionFacts`, `uciLineToSan` (`src/coach/facts.ts`); `WatchPly` (`src/coach/watch.ts`); `NAMES` (`src/coach/templates.ts`).
- Produces:

```ts
// options.ts
export interface TeachOption { uci: string; san: string; reason: string; watch: WatchPly[] | null }
export const OPTION_MARGIN_CP = 50;
export const MAX_OPTIONS = 3;
export const PREVIEW_PLIES = 6;
export const NO_REASON = 'This is the strongest move here. Watch the line to see where it leads.';
/** Replays `line` from `fen` (user to move): first ply by 'user', alternating. Null when fewer than 2 plies replay. Capped at PREVIEW_PLIES. */
export function previewLine(fen: string, line: string[]): WatchPly[] | null;
export interface TeachChoice {
  inBook: boolean;
  options: TeachOption[];
  /** Checked reasons of options[0]; null when there are no options. */
  bestReasons: Reasons | null;
}
/** `analysis` null = the engine gave nothing: book options still work; out of book returns no options. */
export function teachOptions(input: { fen: string; userColor: Color; sanHistory: string[]; area: Area; analysis: Analysis | null }): TeachChoice;

// topic.ts
export const TOPIC_LABEL: Record<TeachTopic, string> = {
  opening: 'Opening moves', safety: 'Keeping your pieces safe', captures: 'Winning material',
  checks: 'Checks and threats', development: 'Getting your pieces out', endgame: 'Endgames', other: 'Other positions',
};
export function topicOf(input: { inBook: boolean; area: Area; reasons: Reasons | null }): TeachTopic;

// position.ts
/** "The position": 1–2 sentences. In guide mode it never points at a piece the user can win. */
export function positionText(input: {
  fen: string; userColor: Color; mode: TeachMode; topic: TeachTopic;
  lineName: string | null; plan: string | null;
}): string;
```

Rules:
- **In book** (`bookReplies(userColor, sanHistory).length > 0` with the user to move): options are those nodes, `main` first, at most `MAX_OPTIONS`. Reason: `reasonText(san, deriveReasons(fen, uci, { book: lookup(userColor, [...sanHistory, san]), area, line }))`, falling back to the node's `idea`. `line` = the analysis line starting with that uci, if any. Watch: `previewLine` of that analysis line; else `previewLine` of the move followed by the repertoire's continuation (follow `main` children, else the first child); else null. The engine's best move is not added.
- **Out of book**: analysis lines in order; keep a line when `lineScore(best) - lineScore(line) <= OPTION_MARGIN_CP`; when the best line is a forced mate for the user, keep only lines that are also forced mates for the user. Dedupe by `uci[0]`. Reason from `deriveReasons`/`reasonText` with `line: line.uci`; a non-best line with a null reason is dropped; the best line with a null reason gets `NO_REASON`. At most `MAX_OPTIONS`. Watch: `previewLine(fen, line.uci)`.
- **`topicOf`**, first match wins: `inBook` → `opening`; `reasons === null` → `endgame` if `area === 'endgame'` else `other`; `reasons.checkmate` → `checks`; by `reasons.fundamentals[0]`: `defends` → `safety`; `wins_material` → `captures`; `check_threat` or `attacks` → `checks`; `develops`, `centre`, `king_safety` → `development`; then `area === 'endgame'` → `endgame`; else `other`.
- **`positionText`** sentences, in order, joined by a space; keep the first two:
  1. Each of the user's pieces in `positionFacts(fen).hanging`: `Your {piece} on {square} can be taken for free.` (one sentence; several pieces joined with "and").
  2. Show mode only — an opponent piece in `hanging`: `Their {piece} on {square} is not guarded.`
  3. In book with a `lineName`: `You're in the {lineName}.` followed by `plan` when present.
  4. If nothing above applied: the topic's focus line from a `TOPIC_FOCUS: Record<TeachTopic, string>` constant in this file — plain-language, one sentence each, e.g. development: `Nothing is under attack, so use the move to bring a new piece into the game.` Write all seven; each must pass `findJargon` and `moveLeaks` with no hits.

- [ ] **Step 1: Write failing tests**
  - `options.test.ts`
    - `in the repertoire, the options are the book moves, main line first` — start position, user White, `analysis: null`: `inBook` true, `options[0].san` equals the `san` of the `main` (or first) node from `bookReplies('w', [])`, every option has a non-empty reason, length ≤ 3.
    - `the engine's favourite is not added in book` — same position with an analysis whose best line is `a2a3`: no option has `uci === 'a2a3'`.
    - `a forced mate only pairs with forced mates` — FEN `r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5Q2/PPPP1PPP/RNB1K1NR w KQkq - 0 1`, `userColor: 'w'`, `sanHistory: ['h3', 'h6']` (not in the repertoire; assert `inBook === false`), analysis `[{uci:['f3f7'],cp:null,mate:1},{uci:['d2d3'],cp:300,mate:null}]` → exactly one option, `f3f7`.
    - `drops lines more than 50 worse` — non-book middlegame FEN of your choice with lines at cp 80, 40, 20 → two options (80 and 40), in that order.
    - `one analysed line gives one option` (Review Focus 4) — lines `[A]` and duplicate-first-move `[A']` → length 1.
    - `the best move with no checked reason gets the honest line` — stub: pick a quiet king shuffle in a bare-kings-and-pawns FEN where `reasonText` returns null (assert that precondition in the test), expect `options[0].reason === NO_REASON`.
    - `no analysis out of book gives no options` (Review Focus 1) — `options` is `[]`, `bestReasons` null.
    - `previewLine`: 1 ply → null; 8 plies → 6 plies, `by` alternates starting `'user'`, each `fen` equals chess.js replay; an illegal third move → 2 plies.
  - `topic.test.ts` — one case per branch above, including `in book wins over everything` and `no reasons in an endgame is endgame`.
  - `position.test.ts`
    - `names the user's attacked piece` — FEN with a hanging user knight: text contains `Your knight on` and the square.
    - `guide mode does not point at a free enemy piece` — FEN with a hanging enemy piece: show text contains `Their`, guide text does not, and `moveLeaks(guideText)` is `[]`.
    - `in book it names the line and plan`.
    - `every focus line is plain` — for all 7 topics on a quiet FEN: `findJargon(text)` and `moveLeaks(text)` are both empty.
- [ ] **Step 2: Run, confirm fail** — `npx vitest run tests/teach`
- [ ] **Step 3: Implement** the three modules per the rules.
- [ ] **Step 4: Run, confirm pass**
- [ ] **Step 5: Commit** — `feat: teaching options, topics and position text`

---

### Task 4: Coach teaching paths

**Files:** Modify `src/coach/coach.ts`; Test `tests/coach/coachTeach.test.ts` (new; reuse the fake-engine helpers pattern from `tests/coach/coach.test.ts`)

**Interfaces:**
- Consumes: Task 2 `modeFor` (through a dep), Task 3 `teachOptions`, `topicOf`, `positionText`, `TeachOption`.
- Produces:

```ts
// CoachMessage.kind gains 'teach'. CoachMessage gains:
teach?: { topic: TeachTopic; mode: TeachMode; position: string; options: TeachOption[]; optionsOpen: boolean; inBook: boolean };
// CoachDeps gains:
teachModeFor: (t: TeachTopic) => TeachMode;

class Coach {
  setMode(mode: GameMode): void;                       // default 'play'; also cancelPending()
  /** Teaching pre-move message. Waits for the analysis (unlike preMove). Null when it is not the user's turn or the game is over. */
  teachTurn(game: GameState): Promise<CoachMessage | null>;
  /** "Show me options" in guide mode: the same message with optionsOpen true and the green arrows; null for a stale id. */
  openOptions(messageId: string): CoachMessage | null;
  teachRecap(verdicts: Verdict[], topics: TeachTopic[], changes: { topic: TeachTopic; to: TeachMode }[]): CoachMessage;
}
```

Behaviour:
- `teachTurn`: `theirMove`, `questions`, `nudge`, `nudgeHighlight` come from the existing `preMoveFields` (so guide mode reuses Play's move-free questions). `area` from `areaOf`; analysis via the existing `analyse` cache; if it rejects, build the message with `analysis: null`. `topic = topicOf(...)`, `mode = options.length === 0 ? 'show' : deps.teachModeFor(topic)`, `optionsOpen = mode === 'show'`. `position` from `positionText` with `lineName`/`plan` from `lookup` (`node.plan`, and `rootPlan` on the user's first move exactly as `planText` in `questions.ts` does — export that helper and reuse it). `arrows`: blue for their last move, plus one green per option only while `optionsOpen`. `explanation.whatHappened = position`. `source: 'template'`.
- `onUserMove` in teach mode: level is always `'full'` (ignore `deps.levelFor`). Unflagged → a `post_move` with `explained: true` built by the existing `postMove` path. Flagged → the existing mistake message, but with the reveal attached at once: `explanation.better` and `lesson` from `revealTemplate`, a green arrow for `verdict.bestUci` added to the red one, `reveal: true`, and no `withoutBetter` / `revealsMove` filtering on the Claude upgrade. `themeCount` passed to the mistake template is 0 in teach mode (the "nth time" line counts Play games only).
- In play mode, every existing code path is byte-for-byte the same behaviour.
- `teachRecap`: `kind: 'recap'`; `whatHappened`: `Topics this game: {labels, comma-joined}.` (or `A short game: no topics came up.`); `better`: one sentence per change — to guide: `{label}: I'll stop showing moves here and ask you first.`; to show: `{label}: I'll go back to showing moves for a while.`; omitted when none; `lesson`: the habit line built as `recap` builds it from the flagged verdicts, or `No big mistakes this game.`

- [ ] **Step 1: Write failing tests**
  - `show mode lists options with green arrows` — out-of-book FEN, fake analysis with two close lines, `teachModeFor: () => 'show'`: `kind === 'teach'`, `teach.optionsOpen`, two green arrows matching the options' from/to.
  - `guide mode hides options and names no move` — `teachModeFor: () => 'guide'`: no green arrows; `moveLeaks` is `[]` for `teach.position`, every question, and the nudge; `openOptions(id)` returns `optionsOpen: true` with the green arrows; `openOptions('nope')` is null.
  - `engine failure still gives a turn` (Review Focus 1) — engine rejects: message has `teach.options` `[]`, `mode === 'show'`, non-empty `position`.
  - `teaching ignores Play levels` — `levelFor: () => 'solo'`, a 200cp mistake → `verdict.flagged === true`; same deps with `setMode('play')` → not flagged.
  - `a teaching mistake shows the better move at once` — flagged move: `message.kind === 'mistake'`, `message.reveal === true`, `explanation.better` contains `verdict.bestSan`, arrows include green for `bestUci`.
  - `a good move gets an explained post_move` — `explained === true`.
  - `play mode mistake still hides the better move` — after `setMode('play')`: `explanation.better` undefined, no green arrow (guards the regression).
  - `teachRecap` — with `['opening','safety']` and `[{topic:'safety',to:'guide'}]`: `whatHappened` contains both labels; `better` contains `Keeping your pieces safe`; `findJargon` empty on all fields.
- [ ] **Step 2: Run, confirm fail** — `npx vitest run tests/coach/coachTeach.test.ts`
- [ ] **Step 3: Implement.** Add `teachModeFor` to every existing `CoachDeps` construction (`App.tsx`, test helpers) — in `App.tsx` as `(t) => modeFor(profileRef.current!.teaching, t)`.
- [ ] **Step 4: Run** `npm test` — all pass.
- [ ] **Step 5: Commit** — `feat: coach teaching turn and reveal-at-once mistakes`

---

### Task 5: Claude rewording of the teaching turn

**Files:** Modify `src/coach/claude.ts`, `src/coach/coach.ts`; Test `tests/coach/claude.test.ts`, `tests/coach/coachTeach.test.ts`

**Interfaces:**
- Consumes: Task 4 `teach` fields; existing `publish`, `validateExplanation`, `validateClaims`, `findJargon`, `moveLeaks`.
- Produces: `export function buildTeachPacket(input: { fen: string; position: string; options: { san: string; reason: string }[]; optionsOpen: boolean }, p: ProfileSummary): FactPacket;`

Behaviour: after `teachTurn` returns its template message, the coach asks Claude (through the existing `publish`) to reword only `explanation.whatHappened` (the position text). The packet's allowed SAN list is the shown options' SANs when `optionsOpen`, else empty. Accept the result only if it passes the existing validators and, when options are not open, `moveLeaks(text)` is `[]`. On acceptance the same message id is re-emitted with `teach.position` and `explanation.whatHappened` replaced and `source: 'claude'`. Option reasons are never reworded (they are checked text). A message superseded by a move, take-back or `openOptions` is not upgraded.

- [ ] **Step 1: Write failing tests**
  - `buildTeachPacket allows only the shown options` — open: allowed list equals the options' SANs; closed: empty.
  - `Claude's wording replaces the position text` — fake explainer returns clean text: an update with the same id, `source === 'claude'`, options unchanged.
  - `a guide-mode rewrite that names a move is rejected` — explainer returns text containing `Nf3`: no update is emitted.
  - `a rewrite with jargon is rejected`.
  - `no key / explainer returns null keeps the template`.
- [ ] **Step 2: Run, confirm fail**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test`
- [ ] **Step 5: Commit** — `feat: Claude rewording for teaching turns`

---

### Task 6: Game loop — mode routing and isolation

**Files:** Modify `src/ui/useGame.ts`; Test `tests/ui/useGameTeach.test.tsx` (new; follow how `tests/ui/GameScreen.test.tsx` builds `GameDeps` with a fake db/engine/coach)

**Interfaces:**
- Consumes: Task 1 `recordTeachTheme`, `playGames`, `SavedGame.mode`; Task 2 `recordTurn`, `finishGame`, `topicChanges`, `modeFor`; Task 4 `setMode`, `teachTurn`, `openOptions`, `teachRecap`.
- Produces:

```ts
// CoachApi adds: 'setMode' | 'teachTurn' | 'openOptions' | 'teachRecap'
// GameView adds:
mode: GameMode;
// GameActions changes/adds:
start(choice: Color | 'random', mode?: GameMode): void;   // default 'play'
showOptions(): void;                                       // guide mode "Show me options"
watchOption(index: number): void;                          // plays options[index].watch in the existing watch player
```

Behaviour in a teaching game (`mode === 'teach'`), everything else unchanged:
- `load`/`start`/resume: `coach.setMode(mode)` before the first coach call; `SavedGame.mode` is saved and read; `clock` is always null.
- Pre-move: `coach.teachTurn(game)` instead of `preMove`; the result goes in `coachMsg`; `teach` updates replace `coachMsg` by id (add `'teach'` to the subscriber).
- `showOptions`: `coach.openOptions(coachMsg.id)` → `coachMsg`; remember the FEN in a ref `optionsOpenedFor`.
- `watchOption(i)`: sets `watching` to that option's `watch` plies at index 0; `closeWatch` returns to the turn. No `watchedLine` / assisted bookkeeping in teach mode.
- After the user's move (`checkUserMove`): never call `recordMove`. If the verdict is flagged, `setProfile(recordTeachTheme(...))`. Fade: a ref `countedFens: Set<string>`; if `move.fenBefore` is not in it and the turn message had at least one option and the verdict is analysed, add it and `setProfile({ ...p, teaching: recordTurn(p.teaching, topic, { mode, flagged, openedOptions: optionsOpenedFor === fenBefore }) })`, where `topic`/`mode` are those of the turn message shown for that position. Keep a per-game list of topics seen.
- Mistake phase: the message already carries the reveal; `playOn` does not add a second reveal; `showMe` and hints are not offered (Task 7 hides them).
- `endGame`: `coach.teachRecap(verdicts, topicsSeen, topicChanges(teachingAtStart, afterFinish))`; `setProfile` with `teaching: finishGame(...)`; no `reviewLevels`, no `adjustOpponentRating`, `levelNotes: []`, `clockSuggestion: false`, `linesOffSuggestion: false`. `teachingAtStart` is the `teaching` state captured when the game was loaded.
- Assisted flags, `attackLinesMoves` and `userMoves` are not tracked for teaching games.

- [ ] **Step 1: Write failing tests**
  - `a teaching game never touches the assessment` — play 4 user moves including one flagged, then resign, with `settings.opponentRating: 600`, profile levels `solo` and five prior lost play games in the fake db: afterwards `profile.moves` and `profile.levels` are deep-equal to the start, every theme's `count`/`examples` unchanged, `onSettings` never called, the flagged theme's `teachCount === 1`, `teaching.gamesFinished === 1`, `levelNotes` is `[]`, both suggestions false, and the saved game has `mode: 'teach'`.
  - `resuming keeps the mode` (Review Focus 2) — fake db holds a current unfinished game with `mode: 'teach'`: after mount `view.mode === 'teach'` and the coach's `teachTurn` (not `preMove`) was called.
  - `a retry after take-back is not counted again` (Review Focus 3) — profile `teaching: { gamesFinished: 3, topics: {} }`, fake coach reporting topic `safety`, mode `show`, flagged on the first try: after take-back and a good retry, `teaching.topics.safety.shown === 1`.
  - `opening the options counts as a miss` — guide-mode turn, `showOptions()`, good move: `teaching.topics.safety.recent` is `[false]`.
  - `a turn with no options is not counted` (Review Focus 1) — teach message with `options: []`: `teaching` unchanged after the move.
  - `teaching games have no clock` — `settings.clockMinutes: 5` → `view.clock === null`.
  - `a play game after a teaching game still records moves` — start `'play'`: `recordMove` effects appear as before and the coach was `setMode('play')`.
- [ ] **Step 2: Run, confirm fail** — `npx vitest run tests/ui/useGameTeach.test.tsx`
- [ ] **Step 3: Implement.** Add the new methods to any existing fake coach used by other UI tests so they type-check.
- [ ] **Step 4: Run** `npm test`
- [ ] **Step 5: Commit** — `feat: teaching games in the game loop, kept out of the assessment`

---

### Task 7: Screens

**Files:** Create `src/ui/TeachPanel.tsx`; Modify `src/ui/GameScreen.tsx`, `src/ui/MistakeCard.tsx`, `src/ui/PatternsScreen.tsx`, `src/ui/RecapCard.tsx`, `src/ui/styles.css`; Test `tests/ui/TeachPanel.test.tsx` (new), `tests/ui/GameScreen.test.tsx`, `tests/ui/MistakeCard.test.tsx`, `tests/ui/PatternsScreen.test.tsx`

**Interfaces:**
- Consumes: Task 4 message shape; Task 6 `view.mode`, `actions.start(choice, mode)`, `showOptions`, `watchOption`.
- Produces: `TeachPanel` props `{ message: CoachMessage; lastMove: CoachMessage | null; offline: boolean; onShowOptions: () => void; onWatch: (index: number) => void }`.

Exact copy:
- Setup card: a two-button choice above the colour buttons, `Play` (selected by default) and `Play to learn`, as a radio group labelled `Game type`; under `Play to learn` the note `The coach shows you good moves before you play. These games don't count toward your level.`
- Label during a teaching game: `Teaching game · doesn't count toward your level`
- TeachPanel: `Computer played` text = `message.theirMove` (omitted when null); heading `The position`; heading `Good options` with an ordered list, each item `{san} – {reason}` and a button `Watch` with `aria-label="Watch option {n}"` only when `watch` is non-null; with no options: `The coach has no checked options for this position. Play the move you think is best.`
- Guide mode, options closed: the questions list, then a button `Show me options`. The existing nudge button is not shown in teaching games.
- After a good move: the `post_move` summary and explanation under `Your last move`, with no `Explain it` / `Yes, I got it` buttons.
- MistakeCard in a teaching game: the better move and its explanation are visible on the card (`explanation.better`); `Show me` and the hint buttons are absent; `Take it back`, `Play on` and `Watch what happens` stay.
- Patterns: a theme is listed when `count > 0 || (teachCount ?? 0) > 0`; the count reads `×{count} in games` and, when `teachCount > 0`, ` · {teachCount} while learning`. A theme with only game counts keeps its current text exactly (`×{count}`). Teaching examples are listed under a sub-heading `While learning`.
- RecapCard: a teaching recap shows its three lines under the title `Teaching game`.

Board: in a teaching game the shown arrows are `coachMsg.arrows` (blue and, when open, green) outside the mistake card; attack lines, history view, check highlight and promotion behave as in Play.

- [ ] **Step 1: Write failing tests**
  - `TeachPanel`: `lists options with reasons and Watch buttons` (two options, one with `watch: null` → one Watch button; clicking calls `onWatch(0)`); `guide mode shows questions and Show me options, no option text` (the options' SANs are not in the document; click calls `onShowOptions`); `no options shows the fallback line`.
  - `GameScreen`: `choosing Play to learn starts a teaching game` (label visible, fake coach `teachTurn` called); `default start is a play game` (label absent — existing behaviour); `green option arrows only while options are open` (via `data-arrows`).
  - `MistakeCard`: `teaching card shows the better move and no Show me`; the existing `does not reveal the best move` test still passes untouched.
  - `PatternsScreen`: `shows game and learning counts` (`×3 in games · 2 while learning`); `a learning-only theme is listed`; `a theme with no learning count keeps ×3` (Review Focus 5).
- [ ] **Step 2: Run, confirm fail** — `npx vitest run tests/ui`
- [ ] **Step 3: Implement**, matching the existing card and button classes in `styles.css`; the options list must fit a 360px-wide screen without horizontal scroll.
- [ ] **Step 4: Run** `npm test` and `npm run build` (no warnings).
- [ ] **Step 5: Commit** — `feat: Play to learn screens`

---

### Task 8: End-to-end and final check

**Files:** Create `e2e/teach.spec.ts`

- [ ] **Step 1: Write the e2e tests** (same conventions as `e2e/smoke.spec.ts`: `page.goto('./?seed=7')`, real engine)
  - `plays a teaching turn` — choose `Play to learn`, start as White: the label is visible; `Good options` lists at least one option; the board's `data-arrows` contains `green`; play the first option's move on the board; `Your last move` appears; after the reply a new `Good options` list appears; reload → the label is still visible.
  - `a teaching mistake shows the better move at once` — `./?seed=7&fen=<HANGING_FEN from smoke.spec.ts>`, choose `Play to learn`, play the hanging move: the mistake card is visible, contains better-move text (the card's `better` section is non-empty), and has no `Show me` button; `Take it back` returns to the turn with options.
  - `fits a 360px screen` — at 360×740 the page has no horizontal scroll during a teaching turn.

  `?fen=` games are not saved, so the first test must not use it.
- [ ] **Step 2: Run** `npm run e2e` — the new tests and the 5 existing ones pass.
- [ ] **Step 3: Full check** — `npm test`, `npm run build` (warning-free), `npm run e2e` all green.
- [ ] **Step 4: Commit** — `test: end-to-end teaching game`
