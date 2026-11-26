# Play Mode Socratic Coaching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Play mode stops giving away moves. Before the user moves, the coach asks fact-backed questions and offers an optional nudge. After the move, it reveals and explains. Skill tracking counts only the user's own moves.

**Architecture:**
- A new pure module `src/coach/questions.ts` builds before-move questions and the nudge from engine facts.
- A new `src/coach/leaks.ts` checks that no before-move text gives away a move.
- `src/coach/postMove.ts` builds after-move feedback ("top/book move" or "a stronger option was…").
- The Coach orchestrator emits `pre_move` messages with questions (no Claude) and `post_move` messages (Claude by default for "better", on tap for "top").
- Weaning drops the Full-level special rule. A one-time profile migration resets levels.
- The UI shows "Your last move" above "Now".

**Tech Stack:** existing: Vite, React 19, TypeScript strict, Vitest, Playwright, chess.js, Stockfish WASM, @anthropic-ai/sdk.

**Spec:** `docs/superpowers/specs/2026-11-26-play-mode-socratic-coaching-design.md`. It builds on `docs/superpowers/specs/2026-11-25-chess-coach-design.md`; read both.

## Global Constraints

- Before the user moves, no text, arrow or highlight names, lists, marks or draws a move for the user. The only exception is the opponent's last move (blue arrow and its SAN).
- Before-move text comes from templates only. No Claude call happens before a move.
- "Top move" means the played move is the engine's best, or within **20 cp** of it, outside the book. A repertoire book move always gets the top-move treatment, labelled "Book move".
- `MoveRecord.assisted` is true only for: nudge used in that position, Hint 3 used, or replaying the mistake card's shown better move after a take-back.
- Step-downs at every level use the same rule: the last 40 non-assisted records, all after the last level change, at least 80% `good`. Step-ups are unchanged.
- The levels reset once to opening full, middlegame full, endgame light. Overrides and theme history are kept, `levelChangedAt` is cleared, and a one-line notice is shown.
- Copy, used verbatim:
  - "✓ That's the top move. Do you see why it works?"
  - "✓ Book move. Do you see why?"
  - Buttons "Yes, I got it" and "Explain it"
  - "Need a nudge?", "Show questions", "Think about"
  - Section headers "Your last move" and "Now"
  - full→guided level text: "You've been finding good moves in {area}. I'll hide the questions there — tap Show questions if you want them."
  - The reset notice is in Task 6.
- Truth rule as before: post-move and mistake explanations name only engine/fact-backed moves, pieces and squares (`validateExplanation` + `validateClaims`).
- Commit messages end with the session's attribution lines. Do not name a model elsewhere.

## Review Focus

1. **Before-move text leaks a move** through a repertoire `plan`, an opponent `idea`, a nudge or a fallback question. Expected: never. Pinned in Tasks 2 and 3 (sweep every repertoire position plus engine fixtures).
2. **A question presupposes something false**, e.g. "One of your pieces is under attack…" when nothing of the user's is hanging. Expected: the question appears only when the fact holds. Pinned in Task 3.
3. **A stale post-move result** (Claude, or the Explain tap) lands after the user's next move or a take-back. Expected: it is dropped. Pinned in Task 5.
4. **Nudge state across take-back and new positions.** A nudge marks only moves played from that same position. A take-back to the same position keeps it. A new position clears it. Pinned in Task 7.
5. **The migration runs more than once, or wipes overrides or themes on reload or import.** Expected: exactly once, keeping overrides and themes. Pinned in Task 6.

---

## File Structure

```
src/coach/leaks.ts           (new) moveLeaks(): detect move-giving text
src/coach/questions.ts       (new) preMoveCoaching(): their-move line, questions, nudge
src/coach/postMove.ts        (new) topMoveKind(), postMoveTemplate()
src/coach/coach.ts           (modify) pre_move/post_move messages, explainTopMove(), nudge()
src/coach/claude.ts          (modify) FactPacket kind 'post_move' replaces 'pre_move'
src/coach/templates.ts       (modify) delete preMoveTemplate/candidate code
src/openings/repertoire.json (modify) plan on root + every opponent node; opponent ideas rewritten
src/openings/repertoire.ts   (modify) RepertoireNode.plan?: string; rootPlan(color)
src/profile/weaning.ts       (modify) one step-down rule; new copy
src/profile/profile.ts       (modify) migrateProfile()
src/types.ts / src/storage/db.ts (modify) ProfileData.version?: number
src/ui/CoachPanel.tsx, useGame.ts, GameScreen.tsx, App.tsx (modify)
tests mirror src/; e2e/smoke.spec.ts (modify)
```

---

### Task 1: Move-leak detector

**Files:**
- Create: `src/coach/leaks.ts`
- Test: `tests/coach/leaks.test.ts`

**Interfaces:**
- Produces: `export function moveLeaks(text: string, allowedSan?: string[]): string[]`. It returns the offending fragments; an empty array means safe. Reuse the SAN regex and normalisation (0-0→O-O, case-insensitive piece letter, `=` promotions) from `src/coach/claude.ts`; export them there if needed.
- Flags:
  1. SAN tokens not in `allowedSan`, using the same token rules as `validateExplanation` (bare squares are not moves).
  2. `\b(pawn|knight|bishop|rook|queen|king)s?\s+(to|onto|into)\s+[a-h][1-8]\b` (i).
  3. `\b(take|takes|capture|captures|grab|win)\b[^.?!]*\bon\s+[a-h][1-8]\b` (i).
  4. `\b(play|push|move|bring|put)\b[^.?!]*\b[a-h][1-8]\b` (i).
  5. Castling instructions `\b(castle|castling)\b` (i) when the sentence doesn't end in "?".
- Allowed:
  - Piece-on-square descriptions ("your knight on f6", "their bishop on b4").
  - Questions about king safety ("Is your king safe yet?", "Can you castle soon?").

- [ ] **Step 1: Write failing tests** in `tests/coach/leaks.test.ts`.
  - These return non-empty:
    - `'Take it with exd5.'`
    - `'Bring your knight to f3.'`
    - `'Play d4 to grab the centre.'`
    - `'Push the pawn to e5.'`
    - `'Castle now.'`
    - `'Nf3 is strong.'`
    - `'capture the pawn on e5'`
  - These return `[]`:
    - `'Look at your knight on f6.'`
    - `'Black played d5, challenging your pawn on e4.'` (with `allowedSan: ['d5']`)
    - `'Can you castle soon?'`
    - `'Is your king safe yet?'`
    - `'Get a knight out to attack their centre pawn.'`
    - `'What does their last move attack?'`
- [ ] **Step 2:** Run `npx vitest run tests/coach/leaks.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3:** Implement `moveLeaks` in `src/coach/leaks.ts`.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5:** Commit `feat: detect move-giving text before a move`.

### Task 2: Repertoire plans and move-free opponent ideas

**Files:**
- Modify: `src/openings/repertoire.json`, `src/openings/repertoire.ts`
- Test: `tests/openings/repertoire.test.ts`

**Interfaces:**
- Consumes: `moveLeaks` (Task 1).
- Produces:
  - `RepertoireNode.plan?: string`, required by test on opponent-move nodes.
  - `export function rootPlan(color: Color): string`, the move-1 plan when the user is White. It comes from a new top-level JSON field `"whitePlan"`. For Black, return the plan of the opponent's first move node.
- Content rules (beginner-plain, chess-correct):
  - Every **opponent-move** node gets `plan`: what the user should aim for next, with no move and no destination square. Example: "Get a knight out so it attacks their centre pawn."
  - Its `idea` is rewritten to describe **only** what the opponent's move does.
  - User-move nodes keep their `idea`, which is shown after the user plays it.

- [ ] **Step 1: Write failing tests:**
  - Every opponent-move node (walk the tree, using whose turn the node is) has a non-empty `plan` of 220 chars or fewer.
  - `moveLeaks(node.plan)` is `[]`.
  - `moveLeaks(node.idea, [node.san])` is `[]` for opponent nodes.
  - `moveLeaks(rootPlan('w'))` is `[]`.
  - Existing tests keep passing (legal replay, lookup names, claims check).
- [ ] **Step 2:** Run `npx vitest run tests/openings`. Expected: FAIL (plans missing).
- [ ] **Step 3:** Write the plans, rewrite the opponent ideas and add `rootPlan`. Run `npx tsx scripts/check-repertoire.ts`. Expected: no output.
- [ ] **Step 4:** Run `npx vitest run tests/openings`. Expected: PASS.
- [ ] **Step 5:** Commit `feat: move-free opening plans for before-move coaching`.

### Task 3: Before-move questions and nudge

**Files:**
- Create: `src/coach/questions.ts`
- Modify: `src/coach/templates.ts` (delete `preMoveTemplate`, `Candidate` generation, `PreMoveContext.level`; keep `Explanation` with `candidates` removed)
- Test: `tests/coach/questions.test.ts`

**Interfaces:**
- Consumes: `positionFacts`, `principleViolations`, `pins` (facts.ts); `Analysis`; `BookHit`, `rootPlan`, `lookup` (repertoire); `moveLeaks`.
- Produces:
  ```ts
  export interface PreMoveContext { fen: string; lastMove: PlayedMove | null; history: PlayedMove[];
    userColor: Color; facts: PositionFacts; analysis: Analysis | null; book: BookHit | null }
  export interface PreMoveCoaching { theirMove: string | null; questions: string[]; nudge: string | null }
  export function preMoveCoaching(ctx: PreMoveContext): PreMoveCoaching;
  export const HABIT_QUESTIONS: readonly [string, string]; // the two fallback questions, verbatim from the spec
  ```
- Rules:
  - `theirMove` (null when `lastMove` is null) describes the opponent's move from facts: the book `idea` when in book; otherwise what the moved piece attacks (`attackedBy`), check (`inCheck`), or a capture.
  - `questions` holds 2–3 items, in the spec §1 priority: check, own piece hanging, mate available (`analysis.lines[0].mate > 0`), opponent piece hanging, fork available after `analysis.lines[0].uci[0]` by the moved piece, opening plan or principle question, then habit questions to fill.
  - `nudge` is the top fact-backed question's specific hint (spec §1), or the book `plan`. Otherwise null.
  - When `analysis` is null, use only facts-derived and habit questions.
  - Every output string must pass `moveLeaks(s, lastMove ? [lastMove.san] : [])`. Also guard at runtime: drop any string that fails.

- [ ] **Step 1: Write failing tests** with FEN fixtures:
  - In check gives the first question "You're in check. What are all the ways to get out of it?"
  - Own knight hanging (undefended) gives the question "One of your pieces is under attack and not safely protected. Can you find it?" and the nudge "Look at your knight on <sq>."
  - **No** own piece hanging means that question is absent (Review Focus 2).
  - Analysis mate-in-2 gives the "There's a way to win right now. Look at every check you can give." question.
  - An opponent piece hanging gives "Is there anything of theirs you can win?"
  - A quiet position with no analysis gives exactly the two `HABIT_QUESTIONS`, and `nudge === null`.
  - Move 1 as White (`lastMove: null`) gives `theirMove === null` and a first question equal to `rootPlan('w')`.
  - **Sweep (Review Focus 1):** for every repertoire position where the user is to move (walk both trees), `preMoveCoaching` with `analysis: null` has `moveLeaks` empty for `theirMove`, every question and `nudge`. Do the same for 10 engine fixtures whose `analysis.lines[0]` is a capture.
- [ ] **Step 2:** Run `npx vitest run tests/coach/questions.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement, and delete the dead pre-move code in `templates.ts`. Fix its tests: drop the pre-move candidate tests and keep the mistake tests.
- [ ] **Step 4:** Run `npx vitest run tests/coach`. Expected: PASS.
- [ ] **Step 5:** Commit `feat: before-move questions and nudge from engine facts`.

### Task 4: After-move feedback templates and Claude packet

**Files:**
- Create: `src/coach/postMove.ts`
- Modify: `src/coach/claude.ts` (`FactPacket.kind: 'post_move' | 'mistake'`; overload `buildPacket('post_move', ctx: PostMoveContext, t, p)`; system prompt line for post_move: "explain why the played move works (top) or why the stronger move is better than the played one (better); short, plain")
- Test: `tests/coach/postMove.test.ts`, `tests/coach/claude.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type TopKind = 'book' | 'top' | null;
  export function topMoveKind(before: Analysis, moveUci: string, inBook: boolean): TopKind; // 20 cp rule, side-to-move POV, mate lines handled as in classify
  export interface PostMoveContext { verdict: Verdict; move: PlayedMove; kind: TopKind;
    bookIdea: string | null; lineName: string | null; factsAfter: PositionFacts }
  export function postMoveTemplate(ctx: PostMoveContext): { summary: string; explanation: Explanation };
  ```
- Copy:
  - **book:** `summary` = "✓ Book move. Do you see why?", `explanation.whatHappened` = bookIdea.
  - **top:** `summary` = "✓ That's the top move. Do you see why it works?", `explanation.whatHappened` = a fact-backed reason (captures X, gives check, defends the attacked piece on sq, develops, or "It keeps the engine's preferred plan going: <first two SAN of the engine line>.").
  - **null (better):** `summary` = "Your move: ${move.san}. A stronger option was ${verdict.bestSan}.", `explanation.better` from the existing `betterReason` logic, plus what the played move gives up from `refutationSan`.
- `allowedMoves` for a post_move packet: move.san, bestSan, refutationSan and engine-line SANs. `validateClaims` uses fen = fenBefore and fenAfter.

- [ ] **Step 1: Write failing tests:**
  - `topMoveKind` returns `'top'` when the move is `lines[0]`, and `'top'` when it's another line 15 cp below. It returns `null` at 25 cp below, and `null` when the move is absent from the lines. With `inBook` it returns `'book'` regardless.
  - `postMoveTemplate` gives the exact summaries above.
  - In the 'better' case the explanation mentions `bestSan`.
  - `buildPacket('post_move', …)` contains `kind: 'post_move'` and fenAfter, and its `allowedMoves` include the move, bestSan and the refutation.
  - Requests never include temperature/top_p/top_k/thinking (existing test still green).
- [ ] **Step 2:** Run `npx vitest run tests/coach/postMove.test.ts tests/coach/claude.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement, and remove the `'pre_move'` packet path and its tests.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5:** Commit `feat: after-move feedback templates and post_move packets`.

### Task 5: Coach orchestrator

**Files:**
- Modify: `src/coach/coach.ts`
- Test: `tests/coach/coach.test.ts`

**Interfaces:**
- Consumes: Tasks 3–4.
- Produces:
  ```ts
  export interface CoachMessage { id: string;
    kind: 'pre_move' | 'post_move' | 'mistake' | 'consequence' | 'recap' | 'level_change';
    explanation: Explanation; arrows: Arrow[]; source: 'template' | 'claude'; verdict?: Verdict;
    questions?: string[]; nudge?: string | null; theirMove?: string | null; // pre_move
    summary?: string; topKind?: TopKind; explained?: boolean }              // post_move
  class Coach {
    preMove(game: GameState, opts?: { force?: boolean }): Promise<CoachMessage | null>;
    onUserMove(game, move): Promise<{ verdict: Verdict; message: CoachMessage | null }>; // message: mistake or post_move
    explainTopMove(messageId: string): Promise<void>; // top/book Explain tap; emits onUpdate with explained: true
  }
  ```
- `preMove`:
  - Works on move 1 as White (no `lastMove`). It no longer returns null for that case.
  - Level gating as before (light/solo give null unless forced; analysis is still prefetched).
  - Emits `pre_move` with `theirMove`, `questions` and `nudge`.
  - Empty-state rule (spec settled detail 1): the method returns at once a `pre_move` built with `analysis: null` (facts and habit questions). When the analysis arrives, it emits an `onUpdate` for the same id with the full questions, guarded by epoch, FEN and history length. Test: the first message has the habit questions, and the update replaces them.
  - Arrows: only the blue last-move arrow.
  - **No** `publish` to Claude. `blunderCheck` is removed.
- `onUserMove`:
  - When flagged: unchanged (mistake message).
  - Otherwise: `topKind = topMoveKind(...)`, then a `post_move` message from `postMoveTemplate`.
  - For `topKind === null`, publish to Claude (`buildPacket('post_move')`) and add a green arrow for `bestUci`.
  - For top or book: no Claude call and no arrow. `explanation` stays hidden until `explainTopMove`.
- `explainTopMove(id)`:
  - Returns immediately if `id` is not the current post_move or it is already explained (cached).
  - Otherwise marks it `explained: true`, emits the template explanation, then tries Claude for 'top'. Book moves stay template-only.
  - The epoch and current-id guards drop stale results.

- [ ] **Step 1: Write failing tests** (fake engine, fake explain):
  - preMove on move 1 as White gives `kind 'pre_move'` with questions and no green arrows.
  - preMove after an opponent move: arrows contain only blue, and `explain` is **never** called.
  - onUserMove playing best gives `post_move`, `topKind 'top'`, no explain call. Then `explainTopMove(id)` calls explain once, and a second `explainTopMove(id)` makes no extra call.
  - Playing a move 40 cp worse (not flagged) gives `topKind null`, explain called once, and a green arrow for bestUci.
  - A book move gives `topKind 'book'`, and `explainTopMove` never calls explain.
  - **Stale (Review Focus 3):** explain resolves after the next onUserMove, or after `cancelPending()`, and onUpdate is not fired for the old message.
  - The existing mistake, hint, consequence and recap tests stay green.
- [ ] **Step 2:** Run `npx vitest run tests/coach/coach.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npx vitest run tests/coach`. Expected: PASS.
- [ ] **Step 5:** Commit `feat: coach asks before the move and explains after`.

### Task 6: Weaning rule, copy and one-time reset

**Files:**
- Modify: `src/profile/weaning.ts`, `src/profile/profile.ts`, `src/types.ts`, `src/storage/db.ts` (schema accepts `version`)
- Test: `tests/profile/weaning.test.ts`, `tests/profile/profile.test.ts`, `tests/storage/db.test.ts`

**Interfaces:**
- Produces:
  - `ProfileData.version?: number`.
  - `export const PROFILE_VERSION = 2`.
  - `export function migrateProfile(p: ProfileData): { profile: ProfileData; reset: boolean }`. When `(p.version ?? 1) < 2`: set levels to `{opening:'full', middlegame:'full', endgame:'light'}`, delete `levelChangedAt`, set `version: 2`, `reset: true`. Otherwise return it unchanged with `reset: false`. Themes and moves are kept.
  - `export const RESET_NOTICE = "Coaching levels were reset: earlier games showed suggested moves, so they couldn't measure your own play."`
  - `emptyProfile()` returns `version: 2`.
- `reviewLevels`: delete the `idx === 0` branch. Every level uses the non-assisted, post-change, 80%-good-of-40 rule.
- `levelChangeText`:
  - full→guided: the spec text verbatim.
  - The step-up text becomes "A few more slips lately in {area} — I'll show the questions again for a while."

- [ ] **Step 1: Write failing tests:**
  - At full, 40 good **assisted** records do not step down. 40 good non-assisted records do.
  - The full→guided text matches verbatim.
  - `migrateProfile` on a v1 profile with levels `guided`, themes count 3 and `levelChangedAt` gives starting levels, themes intact, no `levelChangedAt`, `reset: true`.
  - Migrating that result again gives `reset: false` and the same object (Review Focus 5).
  - `emptyProfile().version === 2`.
  - db: importing a backup without `version`, then `getProfile`, then `migrateProfile` gives `reset: true`. A profile with `version: 2` round-trips through export/import.
- [ ] **Step 2:** Run `npx vitest run tests/profile tests/storage`. Expected: FAIL.
- [ ] **Step 3:** Implement. Remove the obsolete F1 tests.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5:** Commit `feat: one step-down rule for all levels and a one-time level reset`.

### Task 7: Coach panel and game flow

**Files:**
- Modify: `src/ui/CoachPanel.tsx`, `src/ui/useGame.ts`, `src/ui/GameScreen.tsx`, `src/ui/App.tsx`, `src/ui/styles.css`, `e2e/smoke.spec.ts`
- Test: `tests/ui/GameScreen.test.tsx`, and a new `tests/ui/CoachPanel.test.tsx`

**Interfaces:**
- Consumes: Tasks 5–6.
- `GameView` changes:
  - Remove `choicesShownFor`.
  - Add `lastMove: CoachMessage | null` (the post_move message), `lastMoveOpen: boolean`, `questionsShownFor: string | null` and `nudgeFor: string | null`. `nudgeFor` holds the FEN in which the nudge was used.
- `GameActions` changes:
  - Remove `showChoices`.
  - Add `showQuestions()`, `nudge()`, `explainLastMove()`, `ackLastMove()` (Yes: collapses the section) and `toggleLastMove()`.
- Panel:
  - "Your last move" section (post_move: summary, plus Yes/Explain buttons for top/book or the explanation for 'better'; collapsible) above the "Now" section.
  - "Now" shows `theirMove`, a "Think about" list (Full: shown; Guided: behind "Show questions"; Light: "Ask the coach" shows Full content), and "Need a nudge?" when `nudge` is non-null. Tapping it reveals the nudge text and sets `nudgeFor = game.fen()`.
  - Remove the candidates UI and the blunder-check box.
- Arrows:
  - Board arrows = the blue pre-move arrow, plus the post_move green arrow only while `lastMoveOpen` and `topKind === null`.
  - Mistake arrows are unchanged.
- `userMove` assisted = `nudgeFor === fen before the move` || Hint 3 || replaying the shown best move after a take-back (keep the existing logic). Delete `shownMoves`. A new position clears `nudgeFor`, and a take-back keeps it.
- App: on load, run `migrateProfile`. If `reset`, save the profile and show `RESET_NOTICE` once as a dismissible line above the board.

- [ ] **Step 1: Write failing tests:**
  - CoachPanel: a pre_move message renders "Think about" with the questions, and contains no `best` text or candidate list.
  - At guided, the questions are hidden until "Show questions".
  - "Need a nudge?" is absent when `nudge` is null.
  - A top post_move renders "✓ That's the top move. Do you see why it works?" with "Yes, I got it" and "Explain it". Clicking Explain calls `onExplain`.
  - GameScreen with a fake coach:
    - After the opponent's move, the board arrows contain no green arrow.
    - Tap "Need a nudge?" and play: the record is assisted.
    - Play without a nudge: not assisted.
    - **Nudge, then a mistake, then take back and retry from the same position:** assisted (Review Focus 4).
    - After a new opponent move, the nudge is cleared.
    - A v1 profile on load shows the reset notice once. After a reload with the saved v2 profile, no notice.
  - Update `e2e/smoke.spec.ts`:
    - After the opponent's reply, the coach panel shows "Think about" and the page has no "best" text.
    - In a `?fen=` mate-in-1 position, playing the mate shows the game-over recap. In a `?fen=` position with a single obviously best capture (verify it with Node Stockfish when writing the test), playing it shows "That's the top move".
    - Keep the mistake / take-back, offline, resume and scrollWidth checks.
- [ ] **Step 2:** Run `npx vitest run tests/ui`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npm test && npm run build && npm run e2e`. Expected: all pass, and the build is warning-free.
- [ ] **Step 5:** Screenshot the pre-move and post-move panels at 360×740, light and dark, and look at them. Fix any layout problems.
- [ ] **Step 6:** Commit `feat: play mode asks before the move and explains after`.
