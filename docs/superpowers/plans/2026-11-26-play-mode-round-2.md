# Play Mode Round 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pitch explanations at a ~350 beginner with real reasons. Add move history, a check highlight, board-pointing hints and attack lines. Make the mistake card spoiler-free, with Watch what happens.

**Architecture:**
- A new pure `reasons.ts` derives engine/fact-checked reasons: opening, fundamentals, concrete effect, and why the idea works. Templates state them, and Claude rewrites them under beginner rules plus a banned-jargon validator.
- Coach changes: mistake messages drop the better move; hints carry highlight squares; Play on and Show me produce a reveal; mistake messages carry a watch line.
- Pure `attacks.ts` and `attackLines.ts` handle the aid and its turn-off suggestion.
- UI adds board decorations, history navigation and a watch player.

**Tech Stack:** existing: Vite, React 19, TS strict, Vitest, Playwright, chess.js, react-chessboard 5, Stockfish WASM, @anthropic-ai/sdk.

**Spec:** `docs/superpowers/specs/2026-11-26-play-mode-round-2-design.md`, which builds on `2026-11-26-play-mode-socratic-coaching-design.md` and `2026-11-25-chess-coach-design.md`. Read all three.

## Global Constraints

- **No spoilers:** the better move must never show during a decision unless the move then counts as helped. This covers card text, Claude text, arrows, rings, history view and the watch player.
- **Truth rule:** every reason and every highlighted square comes from the engine or chess.js facts. Claude only rewrites given reasons.
- **Banned terms** (Claude output is discarded if any appear; templates must contain none): "outpost", "tempo", "prophylaxis", "initiative", "zwischenzug", "positional", "weakness complex", "pawn structure", "space advantage", "compensation", "dynamic", "static". Matching is case-insensitive and whole-word/phrase.
- **Copy, verbatim:**
  - Card titles: "✗ Mistake" / "✗ Blunder".
  - Ladder buttons: "Hint 1", "Hint 2", "Show me".
  - "▶ Watch what happens", "Back to the card", "Back to game", "Viewing move {N}", "New move — Back to game".
  - Setting label: "Show attack lines — moves made with this on count as helped".
  - Suggestion: "You've been spotting threats well — try turning attack lines off so your moves count toward your progress."
- **Helped (`assisted: true`) when any of:**
  - a nudge was used;
  - Show me was used;
  - the user replayed the shown best move after a take-back;
  - the user re-expanded "stronger option" and played that move;
  - attack lines were on for that move;
  - (after watch then Play on) the move equals the watched line's next user move while the game still follows the line.
- **Default model** stays Sonnet 5.5. No Claude call happens before a move.
- Every task leaves `npm test` and `npm run build` green and warning-free.
- Commit messages end with the session's attribution lines. Do not name a model elsewhere.

## Review Focus

1. **Better move leaks through the mistake card** (template, Claude rewrite or packet `allowedMoves`) before Play on or Show me. Expect never. Pinned in Task 3.
2. **History view leaks or allows play.** While viewing a past position: the board isn't draggable, and no attack lines, hint rings or green arrows from the live position show. Pinned in Task 7.
3. **Attack lines at the wrong time:** during the opponent's turn, in history view or in the watch player. Expect hidden. Pinned in Task 6.
4. **Watched-line accounting after the game leaves the line.** Later moves are independent again. Pinned in Task 7.
5. **Jargon in template text** across many positions. Expect none. Pinned in Task 2 (sweep).

---

## File Structure

```
src/coach/reasons.ts      (new) deriveReasons(), reasonText(), FUNDAMENTAL_WHY
src/coach/jargon.ts       (new) BANNED_TERMS, findJargon()
src/coach/watch.ts        (new) watchLine()
src/coach/attacks.ts      (new) attackMap()
src/profile/attackLines.ts(new) suggestLinesOff()
src/coach/templates.ts, postMove.ts, claude.ts, coach.ts (modify)
src/storage/db.ts         (modify) Settings.attackLines, SavedGame.attackLinesMoves/userMoves
src/ui/GameScreen.tsx, CoachPanel.tsx, MistakeCard.tsx, useGame.ts, SettingsScreen.tsx, styles.css (modify)
src/ui/HistoryBar.tsx, WatchPlayer.tsx (new)
```

---

### Task 1: Reasons

**Files:**
- Create: `src/coach/reasons.ts`, `src/coach/jargon.ts`
- Test: `tests/coach/reasons.test.ts`, `tests/coach/jargon.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type Fundamental = 'develops' | 'centre' | 'king_safety' | 'defends' | 'attacks' | 'check_threat'
    | 'wins_material' | 'trade_when_ahead' | 'passed_pawn' | 'king_activity';
  export interface Reasons { opening: { name: string; idea: string } | null; principle: string | null;
    fundamentals: Fundamental[]; effect: string | null }   // effect: concrete "attacks X on sq" / "defends …" / reply-based point
  export const FUNDAMENTAL_WHY: Record<Fundamental, string>; // one beginner sentence each
  export function deriveReasons(fenBefore: string, uci: string, opts: { book: BookHit | null; area: Area;
    line?: string[] /* engine line from fenBefore starting with uci */ }): Reasons;
  export function reasonText(san: string, r: Reasons): string; // ≤3 sentences: effect → opening/fundamental → why
  // jargon.ts
  export const BANNED_TERMS: readonly string[]; // exactly the Global Constraints list
  export function findJargon(text: string): string[];
  ```
- Fundamentals are detected with chess.js only (spec §1 list). `wins_material` uses the material count after the line's first exchange, using `positionFacts(...).material`. `principle` (when out of book in the opening) names the opening principle the move follows, e.g. "get your knights and bishops out before your queen".

- [ ] **Step 1: Write failing tests:**
  - `findJargon('a strong outpost and tempo')` returns `['outpost','tempo']`. Case-insensitive. `findJargon('a quiet move')` returns `[]`. Phrase "pawn structure" is matched.
  - From the start position, `deriveReasons(start,'g1f3',{book: lookup('w',['Nf3'])??null, area:'opening'})` has `fundamentals` containing `'develops'` and `'centre'`.
  - `reasonText('Nf3', r)` contains "knight" and has 3 sentences or fewer.
  - Castling `e1g1` gives `'king_safety'`.
  - A move defending an attacked piece gives `'defends'` (FEN fixture).
  - A capture winning a piece per `line` gives `'wins_material'`.
  - In the Italian book after 3.Bc4, `opening.name` contains "Italian".
  - **Sweep (Review Focus 5):** for every repertoire user-move position, plus 10 engine-line fixtures, `findJargon(reasonText(...))` is `[]` and `moveLeaks` is not required.
- [ ] **Step 2:** Run `npx vitest run tests/coach/reasons.test.ts tests/coach/jargon.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5:** Commit `feat: engine-checked move reasons and banned-jargon list`.

### Task 2: Templates and Claude use the reasons

**Files:**
- Modify: `src/coach/postMove.ts`, `src/coach/templates.ts`, `src/coach/claude.ts`
- Test: `tests/coach/postMove.test.ts`, `tests/coach/templates.test.ts`, `tests/coach/claude.test.ts`

**Interfaces:**
- Consumes: Task 1.
- `PostMoveContext` gains `reasons: Reasons` (for the played move) and `bestReasons: Reasons | null` (for the better move when not top). `postMoveTemplate` builds:
  - **top/book explanation:** `reasonText(move.san, reasons)`;
  - **"stronger option" explanation:** `reasonText(bestSan, bestReasons)` plus one sentence on what the played move gives up.
- `FactPacket` gains `reasons` (and `bestReasons` where allowed).
- The system prompt is rewritten for a ~350 player:
  - short sentences, everyday words, concrete pieces and squares;
  - one idea per sentence;
  - "explain only the given reasons";
  - one good example and one bad (jargon) example;
  - the banned-terms list, stated.
- `explainWithClaude` returns `{ ok:false, reason:'invalid' }` when `findJargon` finds anything in any output field.

- [ ] **Step 1: Write failing tests:**
  - The top-move explanation for 1.Nf3 contains "knight" and none of `BANNED_TERMS`.
  - The "stronger option" explanation contains `bestSan` and a `FUNDAMENTAL_WHY` sentence.
  - A Claude output containing "tempo" → `explainWithClaude` returns not ok, and the template stays.
  - The system prompt contains every banned term and the phrase "about 350".
  - Existing truth-rule tests are still green.
- [ ] **Step 2:** Run `npx vitest run tests/coach`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npx vitest run tests/coach`. Expected: PASS.
- [ ] **Step 5:** Commit `feat: explanations state real reasons for a beginner`.

### Task 3: Spoiler-free mistakes, hint highlights and reveals

**Files:**
- Modify: `src/coach/templates.ts` (mistakeTemplate), `src/coach/coach.ts`, `src/coach/questions.ts` (nudge highlight), `src/coach/claude.ts` (mistake packet)
- Test: `tests/coach/coach.test.ts`, `tests/coach/templates.test.ts`, `tests/coach/questions.test.ts`, `tests/coach/claude.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface HintStep { text: string; highlight: string[] }       // squares to ring; [] when none named
  // Coach
  hint(step: 1 | 2): HintStep;                // 1: lesson habit (+FUNDAMENTAL/lesson why), no highlight; 2: "Look at your <piece> on <sq>", highlight [sq]
  showMe(): CoachMessage | null;              // reveal: kind 'post_move', summary "The better move was <bestSan>.", explanation from bestReasons, green arrow; marks nothing itself (UI marks assisted)
  playOnReveal(): CoachMessage | null;        // same reveal message, used after Play on
  // PreMoveCoaching / pre_move CoachMessage gain: nudgeHighlight: string[]
  ```
  - **Mistake message:** `explanation.better` is removed, there is no green arrow, the title severity is in `verdict.severity`, and `explanation.whatHappened` comes from the reply plus reasons.
  - **Mistake packet:** `allowedMoves = [move.san, reply]`, with no `bestSan`.
  - **Reveal packet:** a separate `kind: 'post_move'` packet built only by `showMe` or `playOnReveal`.
  - **Remove** the old `hint(3)`.

- [ ] **Step 1: Write failing tests:**
  - **(Review Focus 1)** The mistake message on the hanging-knight fixture:
    - `JSON.stringify(message.explanation)` does not contain `verdict.bestSan`;
    - the arrows have no green;
    - `buildPacket('mistake', …).allowedMoves` does not contain `bestSan`;
    - a Claude rewrite naming `bestSan` is rejected (template kept).
  - `hint(1).highlight` is `[]`. `hint(2)` gives text `"Look at your <piece> on <from>."` with highlight `[from]`.
  - `showMe()` gives summary "The better move was <bestSan>.", a green arrow from→to, and an explanation with no banned terms.
  - `playOnReveal()` gives the same.
  - A nudge "Look at your knight on f6." has `nudgeHighlight ['f6']`. A plan-text nudge has `[]`. Every square named in a nudge is in its highlight.
- [ ] **Step 2:** Run `npx vitest run tests/coach`. Expected: FAIL.
- [ ] **Step 3:** Implement. Keep the old fields optional if the UI still reads them; Task 7 removes UI use.
- [ ] **Step 4:** Run `npx vitest run tests/coach && npm run build`. Expected: PASS.
- [ ] **Step 5:** Commit `feat: mistake card keeps the better move hidden; hints point at squares`.

### Task 4: Watch what happens line

**Files:**
- Create: `src/coach/watch.ts`
- Modify: `src/coach/coach.ts` (mistake message gains `watch`)
- Test: `tests/coach/watch.test.ts`, `tests/coach/coach.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface WatchPly { uci: string; san: string; fen: string; by: 'opponent' | 'user' }
  export function watchLine(fenAfter: string, line: string[] /* after-analysis best line uci */, mover: Color): WatchPly[] | null;
  // null unless: line ends in mate (chess.js isCheckmate at some ply), or mover's material at the last shown ply < after ply 1.
  // Shown length: through mate, or through the last ply where the material count changes; cap 8 plies.
  // CoachMessage (mistake) gains: watch?: WatchPly[]
  ```

- [ ] **Step 1: Write failing tests:**
  - A back-rank mate-in-2 line (the existing classify fixture) gives plies ending in checkmate, with `by` alternating starting 'opponent'.
  - A single capture (material lost at ply 1, unchanged after) gives `null`.
  - A line losing a piece at ply 3 gives plies through ply 3.
  - A 12-ply line is capped at 8.
  - Coach: the mistake message on the mate fixture has `watch.length > 0`.
- [ ] **Step 2:** Run `npx vitest run tests/coach/watch.test.ts tests/coach/coach.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5:** Commit `feat: watch-what-happens line for multi-move consequences`.

### Task 5: Attack map, settings and the turn-off suggestion

**Files:**
- Create: `src/coach/attacks.ts`, `src/profile/attackLines.ts`
- Modify: `src/storage/db.ts` (`Settings.attackLines: boolean` default false; `SavedGame.attackLinesMoves?: number`, `SavedGame.userMoves?: number`; import schema accepts them)
- Test: `tests/coach/attacks.test.ts`, `tests/profile/attackLines.test.ts`, `tests/storage/db.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function attackMap(fen: string, by: Color): { squares: string[]; lines: { from: string; to: string }[] };
  // squares: all squares attacked by `by` (pawns diagonal only; pinned pieces count); lines: attacker→each enemy piece standing on an attacked square
  export const SUGGEST_LINES_OFF: string; // the verbatim suggestion copy
  export function suggestLinesOff(lastGames: SavedGame[]): boolean;
  // true iff the 3 most recent finished games with userMoves ≥ 10 all have attackLinesMoves/userMoves ≥ 0.8
  // and no verdict among the user's moves with flagged theme in {hanging_piece, ignored_threat, allowed_fork}; missing fields = lines off
  ```

- [ ] **Step 1: Write failing tests:**
  - From the start position, `attackMap(start,'b').squares` includes the rank-6 squares and not e5 (pawn pushes don't count). `lines` is empty.
  - A FEN with a black bishop attacking a white knight gives a line bishop→knight, even when the knight is defended.
  - A pinned black knight still attacks its squares.
  - `suggestLinesOff`:
    - true for 3 qualifying games;
    - false if one game was at 70%;
    - false if one had `hanging_piece` flagged;
    - false with only 2 games;
    - old games without the fields count as off.
  - db: settings default `attackLines: false`; a backup without the new fields imports.
- [ ] **Step 2:** Run `npx vitest run tests/coach/attacks.test.ts tests/profile tests/storage`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5:** Commit `feat: attack map, attack-lines setting and turn-off suggestion`.

### Task 6: Board decorations: check, hint rings, attack lines

**Files:**
- Modify: `src/ui/GameScreen.tsx`, `src/ui/useGame.ts`, `src/ui/SettingsScreen.tsx`, `src/ui/CoachPanel.tsx`, `src/ui/styles.css`
- Test: `tests/ui/GameScreen.test.tsx`, `tests/ui/SettingsScreen.test.tsx`

**Interfaces:**
- Consumes: Tasks 3 and 5.
- A pure helper in GameScreen:
  ```ts
  boardDecorations(input: { fen: string; userColor: Color; isUserTurn: boolean; viewing: boolean; watching: boolean;
    attackLines: boolean; rings: string[] }): { squareStyles: Record<string, CSSProperties>; arrows: BoardArrow[] }
  ```
  - **Check:** the king square gets a red background whenever `isCheck()`, live or not.
  - **Rings:** a yellow inset ring on `rings`, only when not viewing and not watching.
  - **Attack lines:** only when `attackLines && isUserTurn && !viewing && !watching`. Opponent-attacked squares get a faint red tint, and red arrows show `lines`.
  - Expose `data-squares` (marked squares with their kind) on the board for tests, like `data-arrows`.
- `useGame`:
  - A move played with `settings.attackLines` on gets `assisted: true` and increments `attackLinesMoves`.
  - `userMoves` is counted per game.
  - At game end, if `suggestLinesOff(last games)`, `view.linesOffSuggestion = true`, rendered as the suggestion copy with a dismiss button.
- Ring sources:
  - the pre_move `nudgeHighlight` once the nudge is revealed;
  - the latest revealed `HintStep.highlight`.
  - They clear on the next move or on a take-back to a different FEN.
- Settings: the toggle with the label verbatim.

- [ ] **Step 1: Write failing tests:**
  - Check FEN: `data-squares` marks the king square `check` on both sides' turns.
  - Nudge revealed with highlight f6: `data-squares` marks f6 `ring`. Before reveal: no ring.
  - Attack lines on during the user's turn: red arrows plus tinted squares. **(Review Focus 3)** During the opponent's turn: none.
  - A move with lines on is recorded assisted, and `attackLinesMoves` increments.
  - Game end with 3 qualifying saved games shows the suggestion copy.
  - Settings shows the toggle label verbatim, and toggling saves `attackLines`.
- [ ] **Step 2:** Run `npx vitest run tests/ui`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npx vitest run tests/ui && npm run build`. Expected: PASS.
- [ ] **Step 5:** Commit `feat: check highlight, hint rings and attack lines on the board`.

### Task 7: Mistake card flow, history and watch player

**Files:**
- Create: `src/ui/HistoryBar.tsx`, `src/ui/WatchPlayer.tsx`
- Modify: `src/ui/MistakeCard.tsx`, `src/ui/useGame.ts`, `src/ui/GameScreen.tsx`, `src/ui/CoachPanel.tsx`, `e2e/smoke.spec.ts`
- Test: `tests/ui/MistakeCard.test.tsx`, `tests/ui/GameScreen.test.tsx`

**Interfaces:**
- Consumes: Tasks 3, 4 and 6.
- `GameView` gains:
  - `viewPly: number | null`: a past ply being viewed; null means live.
  - `watching: { plies: WatchPly[]; index: number } | null`.
  - `watchedLine: WatchPly[] | null`: kept after Play on for accounting.
  - `reveal: CoachMessage | null`: the Show me / Play on reveal, shown in "Your last move".
- `GameActions` gains `viewPly(n: number | null)`, `stepView(delta: -1 | 1)`, `watch()`, `stepWatch(delta: -1 | 1)`, `closeWatch()` and `showMe()`. Remove `nextHint` in favour of `hint(1 | 2)`.
- **MistakeCard:**
  - Title "✗ Mistake" or "✗ Blunder" from severity.
  - "What happened" and "The lesson" sections, the recommendation badge, and the "Take it back" / "Play on" buttons.
  - "▶ Watch what happens" when `message.watch` is set.
  - No better-move section.
- **After Take it back:** buttons "Hint 1", "Hint 2" and "Show me". Show me calls `coach.showMe()`, sets `reveal`, and marks the next move from that FEN assisted.
- **After Play on:** `reveal = coach.playOnReveal()`, shown expanded in "Your last move". The existing fold rule applies to its green arrow.
- **Watch player:**
  - The board shows `watching.plies[index].fen` with that ply's arrow and ◀ ▶ controls, plus "Back to the card".
  - Not draggable.
  - No attack lines or rings.
  - If the user watched, then Play on: set `watchedLine`. Each user move that equals the next `by:'user'` ply while the game still matches the line's previous plies is assisted. After any mismatch, clear `watchedLine`.
- **History:**
  - HistoryBar ◀ ▶ buttons, plus tappable moves in the list. Viewing shows that ply's FEN, read-only, with the label "Viewing move {N}" and "Back to game".
  - The coach panel content is hidden while viewing.
  - If the opponent moves while viewing, show "New move — Back to game".
  - Viewing never alters assisted state.

- [ ] **Step 1: Write failing tests:**
  - The MistakeCard renders "✗ Blunder", "What happened" and "The lesson", has no "Better move" text, and shows "▶ Watch what happens" only when `watch` is set.
  - GameScreen with a fake coach:
    - Take it back shows Hint 1, Hint 2 and Show me. Show me reveals "The better move was d4." and then playing d4 is assisted.
    - Play on shows the reveal in "Your last move".
    - Watch → the board FEN equals the ply FEN, ◀ ▶ step, Back to the card returns.
    - Watch, then Play on, then the user plays the line's user move: assisted. **(Review Focus 4)** The user deviates once, then later plays a move from the old line: not assisted.
    - **(Review Focus 2)** viewPly(0) during the user's turn:
      - the board is not draggable;
      - `data-arrows` has no green;
      - `data-squares` has no ring or attack tint (even with lines on and a nudge revealed);
      - "Viewing move 1" and "Back to game" show.
    - Back to game restores the live position.
  - e2e:
    - the mistake card shows no better move;
    - Take it back → Show me reveals it;
    - history ◀ then "Back to game" works;
    - existing checks stay green.
- [ ] **Step 2:** Run `npx vitest run tests/ui`. Expected: FAIL.
- [ ] **Step 3:** Implement, and remove the now-unused old hint/better fields left optional in Task 3.
- [ ] **Step 4:** Run `npm test && npm run build && npm run e2e`. Expected: all pass, warning-free.
- [ ] **Step 5:** Screenshot at 360×740, light and dark: the mistake card, watch player, history view, attack lines and check. Fix any layout problems.
- [ ] **Step 6:** Commit `feat: spoiler-free mistake flow, move history and watch player`.
