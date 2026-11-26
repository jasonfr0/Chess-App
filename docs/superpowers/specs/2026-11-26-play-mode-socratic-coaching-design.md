# Play Mode: Coach by Questions, Explain After — Design

Date: 2026-11-26
Status: draft, awaiting approval
Builds on: `docs/superpowers/specs/2026-11-25-chess-coach-design.md` (the original spec stays binding except where this document changes it)

## Intent and the why

After playing the deployed app, the user found that Play mode **gives away the answer**. At the Full level the coach panel lists candidate moves, marks one "best", and draws a green arrow on the board. The opening notes say things like "Take it with exd5" or "bring your knight to f3".

This defeats the app's purpose in two ways:

1. **It isn't teaching.** Following an arrow builds no skill for real games, and that skill is the user's whole reason for the app.
2. **It corrupts assessment.** Play mode is where the app measures the user's skill and decides when to wean. Moves copied from a suggestion make the user look stronger than they are. A controller ruling in the first build (Full→Guided counting assisted moves) made this worse.

The user's direction: **before a move, coach with questions and guidance but never name or mark the move. After the move, reveal and explain.** Spelling out good moves ahead of time belongs in a separate **Teaching mode** (future work, see Non-goals), not in the game.

## Goals

1. Before the user moves, the coach never names, lists, marks or draws a move for the user. It describes what the computer's move does and asks guiding questions.
2. An optional **"Need a nudge?"** gives one more specific hint, still without naming a move. A move played after a nudge counts as **helped** for skill tracking.
3. After every user move the coach responds:
   - **The engine's top move:** "That's the top move" plus a prompt asking whether the user understood why, with **[Yes, I got it]** and **[Explain it]**. Yes continues; Explain shows why it works.
   - **Not the top move but not a mistake:** an explanation by default of what was better and why, compared with the move played.
   - **A flagged mistake:** unchanged. The game pauses with the mistake card (better move, what it costs, lesson, take back / play on).
4. Skill tracking counts every move as the user's own unless the user asked for help (nudge, Hint 3, or replaying the mistake card's shown move after a take-back).
5. Claude cost stays about where it is now, roughly 25–50¢ a game on Sonnet.

## Non-goals

- **Teaching mode.** A separate mode that breaks down good moves before they happen against unknown computer moves, with no effect on skill tracking. The user wants it, but it will get its own design afterwards.
- Changing the mistake card, the take-back hint ladder, the opponent, openings coverage, storage or the PWA.

## Anti-goals

- **Leaking the answer before the move**, through any channel: question text, opening notes, arrows, highlighted squares, a nudge, or Claude.
- **Asking misleading questions.** A question must not imply something false (for example "Which of your pieces is under attack?" when none is). Generic habit questions are fine, but a question that presupposes a fact must be backed by the engine or the facts.
- **Tedium.** After-move feedback for a top move must be one line plus two buttons. Explanations stay short.
- **Assessment counting help as skill.**

## Approaches considered

| | Who writes what | Trade-off |
|---|---|---|
| A | Claude writes both the before-move questions and the after-move explanations | Best questions, about 2× Claude calls (~$0.50–1/game) |
| **B (chosen)** | **Templates write the before-move questions; Claude writes the after-move explanations** | **Cost about the same as now; the questions are built from engine facts but are more formulaic** |
| C | Templates by default; Claude only on "Need a nudge?" or "Explain it" | Cheapest; coaching is thin unless the user asks |

**The user picked B.**

## The design

### 1. Before the user's move (pre-move panel)

What shows depends on the coaching level:

| Level | What shows |
|---|---|
| Full | What their move does, plus a "Think about" list of questions, plus "Need a nudge?" |
| Guided | What their move does. Questions are behind a "Show questions" tap. "Need a nudge?" |
| Light | Nothing unless "Ask the coach" is tapped. Asking shows the Full content |
| Solo | Nothing |

The old candidate list, "best" tag, "Show choices" button and green best-move arrow are all **removed** from the pre-move panel. The blue arrow showing the computer's last move stays.

**"What their move does"** comes from templates (Claude is not used before the move). It describes the computer's move from verified facts: what it attacks, any check, the opening idea behind it. It must not tell the user what to play.

**Think-about questions** are generated from verified facts. Show 2–3, chosen by priority:
- **The user is in check:** "You're in check. What are all the ways to get out of it?"
- **The user has a piece hanging** (from `facts.hanging`, with the reason): "One of your pieces is under attack and not safely protected. Can you find it?" It must not name the piece; the nudge does that.
- **The user has a mate available** (the engine's best line is mate): "There's a way to win right now. Look at every check you can give."
- **The opponent has a piece hanging:** "Is there anything of theirs you can win?"
- **A fork is available** for the user's piece (from the engine's best move: `positionFacts` after the best move shows a fork by the moved piece): "Can one of your pieces attack two things at once?"
- **In the opening** (book or move ≤ 12): a plan question from the repertoire's new move-free `plan` text (see §4), or a principle question ("Which pieces haven't moved yet?" / "Is your king safe yet?") backed by `principleViolations` data.
- **Fallback habit questions,** always true: "What does their last move attack?" and "What's your most useful move: does it develop, defend or attack?"

The **blunder check** is folded into this list; it is no longer a separate box.

**"Need a nudge?"** gives one more specific, fact-backed hint and never names a move. The hint comes from the top-priority question:
- Hanging own piece: "Look at your knight on f6."
- Win available: "Look at their bishop on b4."
- Fork: "Look at what your knight could reach."
- Mate: "Look at checks with your queen."
- Opening: the `plan` text.

It is one-shot per position. A move played after the nudge is recorded as **helped**.

**Truth check for pre-move text.** The template output passes a validator that rejects any move token (SAN, or a piece-to-square phrase like "knight to f3") other than the opponent's last move. Covered by tests over many positions, including every repertoire node.

### 2. After the user's move (post-move feedback)

The move is classified as today (`classifyMove`). Then:

- **Top move.** The move is the engine's best, or within **20 cp** of it (my call; tighter than the current 60 cp "not a mistake" window, so "top move" means top). The panel shows "✓ That's the top move. Do you see why it works?" with **[Yes, I got it]** and **[Explain it]**.
  - Explain shows a short explanation of why the move works: Claude if a key is set, otherwise a template built from the engine line and facts. Claude is called **only on tap**.
  - The game does not wait. The computer replies right away, and the buttons stay in the "Your last move" section until the user's next move.
- **Good but not top.** Not flagged, and more than 20 cp worse than best. The panel shows "Your move: Nf3. A stronger option was d4." plus why d4 is better and what the played move gives up. Template first, upgraded by Claude (this is the default Claude call). The game continues while it shows.
- **Flagged mistake.** Unchanged: the game pauses with the mistake card.

**Panel layout** while the game continues: a **"Your last move"** section (post-move feedback, collapsible) sits above a **"Now"** section (the pre-move questions for the new position). Only the latest move's feedback is kept; it is replaced on the next move.

Post-move explanations may name moves freely; the move has already been played. They are still truth-validated as today: moves must come from the engine line, and pieces and squares are checked.

**Arrows after the move:** a green arrow shows the best move from the position before the user's move. It is shown only while the "Your last move" section is expanded, and only on the explanation, never during the next decision.

### 3. Skill tracking and weaning

- `MoveRecord.assisted` is set **only** when the user used a nudge, played after Hint 3, or replayed the mistake card's shown better move after a take-back. Nothing else is shown before a move, so everything else is independent.
- **Revert the Full→Guided special rule** (final-review ruling #11, follow-up F1). All step-downs use the same rule: the last 40 non-helped records, all after the last level change, at least 80% good. Step-ups are unchanged (bad moves, helped or not, over the last 20 records after the last change).
- Level-change wording: full→guided becomes "You've been finding good moves in the middlegame. I'll hide the questions there — tap Show questions if you want them." The others stay as they are.

### 4. Opening notes (repertoire content)

The repertoire's `idea` texts currently mix two jobs. For the computer's moves, they recommend the user's reply ("Attack the pawn on e5 by bringing your knight to f3"). For the user's own moves, they describe the move.

- Add a **`plan`** field on each opponent-move node. It is a move-free statement of what the user should be aiming for ("Get a knight out to attack their centre pawn"). It must not name or describe a specific move or destination square.
- The opponent node's `idea` is rewritten to describe **only** what their move does.
- The user-move node's `idea` is used **after** the user plays it, as the post-move explanation for book moves ("Your knight jumps toward the centre and attacks e5…").
- Tests: no `plan` or opponent `idea` contains a move token or a "piece to square" phrase. All existing repertoire tests keep passing.

### 5. Claude usage

| When | Claude? |
|---|---|
| Pre-move | Never |
| Post-move, "good but not top" | Yes, by default (template shown first) |
| Post-move, "top move" | Only when Explain is tapped |
| Mistake card | Yes, as today |

The expected cost is about the same as now, or slightly lower, because the pre-move call goes away.

## Settled details (my calls, from the builder check)

1. **Empty states.** When there is no computer move yet (the user is White on move 1), the Full panel shows only "Think about" questions: the repertoire root `plan` plus the habit questions. While the engine is still analysing, the habit questions show straight away, and fact-backed questions replace them when the analysis arrives (the same stale guards as today). Light and Solo stay empty until "Ask the coach" is tapped (Light only).
2. **Nudge availability.** "Need a nudge?" appears only when a specific fact-backed hint or a `plan` text exists for this position. Otherwise it is hidden. Using it always marks the move as helped.
3. **Book moves win.** If the user's move is a repertoire book move, it gets the top-move treatment ("✓ Book move. Do you see why?" with [Yes, I got it] and [Explain it]) whatever its cp gap. Explain shows that node's `idea` text, with no Claude call. The 20 cp rule applies only outside the book.
4. **Existing profiles.** Old `assisted` records were marked because choices were shown, so those moves really were helped. They stay excluded from step-downs, which is correct. On first load after this update, levels reset **once** to the starting levels (opening full, middlegame full, endgame light, overrides kept) and `levelChangedAt` is cleared, because any step-down made under the old rule may be inflated. Theme history is kept. A one-line notice explains the reset.
5. **Helped moves.** A helped move never counts as good for step-downs. A bad move counts toward step-ups whether or not it was helped.
6. **Post-move explanations: failure and stale results.**
   - **Failure:** when Claude fails or times out, the template text simply stays. The offline dot follows today's rules.
   - **Caching:** each explanation is cached per move, so re-expanding the section or tapping Explain again never re-bills.
   - **Stale results:** a Claude result for an earlier move is dropped once a newer move exists, using the coach's existing message-id/epoch guard.
7. **What the pre-move validator allows and rejects.**
   - **Allowed:** piece-on-square references that describe the current position ("your knight on f6", "their bishop on b4"), checked against the position.
   - **Rejected:**
     - SAN tokens other than the opponent's last move;
     - "piece to/onto <square>" phrases;
     - capture phrasing with a target ("take/capture … on <square>", "…xd5");
     - castling wording ("castle", "O-O") when it is an instruction rather than a question about king safety. The builder defines the grammar with tests.
   - **Plan texts:** they describe goals ("get a knight out", "attack their centre pawn", "get your king safe") without destination squares or named moves.
8. **Repertoire scope.** Every opponent-move node gets a required `plan` and a rewritten `idea`, and so does the root (move 1 as White). Out of book, the fact-backed and habit questions apply.
9. **Post-move arrow.**
   - **Top move:** no green arrow, since the move is already on the board.
   - **"Good but not top":** a green arrow for the stronger move while "Your last move" is expanded. It disappears when the section is collapsed or the user taps Yes, and always once the next move is played.

## Left to the builder

- Exact question and nudge wording within the rules above, and how many questions show (2–3).
- How the pre-move move-token validator is built. Reuse the Claude validator's regexes where possible.
- Panel styling for the two sections.
- Template wording for "why the top move works" when there is no key.
- Rewriting the repertoire `idea` and `plan` texts. They must stay chess-correct and beginner-plain; run the engine check script.
