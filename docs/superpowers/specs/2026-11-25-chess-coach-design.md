# Chess Coach — Design

Date: 2026-11-25
Status: approved

## Intent and the why

A personal chess app, for one user only, that coaches **during a real game against the computer**, not in scripted lessons or after the game.

The user is a beginner (Chess.com ~255 bullet, ~350 rapid). They know the rules and some basics, and the endgame is their relative strength. Their struggle is real time: seeing threats and finding good moves while the game is happening.

What existing tools get wrong for them:

- **Lichess lessons** teach openings and topics well, but with set moves. They never show an opening in a live game where the opponent can deviate.
- **Chess.com post-game review** works by hindsight. Seeing the mistake afterwards doesn't help the user find the right move next time over the board.

So the coaching must happen in the moment: "the computer played this; here are your choices and what each does." It starts heavy and **weans off** as the user improves, until they're playing mostly on their own.

## Goals

1. Coach in real time during games against a computer opponent pitched near the user's level.
2. Before the user moves, explain the computer's last move and lay out the user's reasonable choices.
3. When the user makes a mistake, pause and explain:
   - the better move and why,
   - what the mistake does to the game (concretely),
   - a recommendation: take back or play on.
   The user always makes the final choice.
4. Teach at two levels: the **instance** (this position) and the **overall** lesson (the general principle and the user's recurring pattern).
5. Teach a **small opening repertoire** through ideas, in live games.
6. **Wean off** automatically per area of the game, with manual override.
7. Work offline in a reduced form.

## Non-goals

- Multiplayer, online play, accounts, social features.
- A Play Store release or support for other users.
- Broad or deep opening theory.
- A full post-game review screen (that's the hindsight model this app is replacing). A short end-of-game recap is in scope.
- A separate puzzle or lesson library.

## Anti-goals (failure even if it "works")

- **The coach states false chess.** It invents a tactic, a line or an evaluation. A wrong explanation is worse than none for a beginner. Every concrete claim must come from the engine or from verified pattern code.
- **Coaching so heavy or slow that playing is a chore.** Long waits per move, walls of text, or stopping on every small inaccuracy.
- **The coaching never fades.** If the user can't graduate to playing alone, the app has failed its purpose.
- **Hindsight-only teaching.** Lessons that only make sense after the game.

## Constraints

- Runs on the user's Android phone. Single user, no backend server.
- Built and tested from a Linux cloud container (no Android device or emulator available to the builder).
- The Claude API needs internet and the user's own API key. Usage is paid per token.
- The user is a beginner. Explanations must use plain words, name the pieces and squares, and stay short.

## Approaches considered

| | Approach | Trade-off |
|---|---|---|
| A | Fully offline: Stockfish, pattern-detection code and written templates | Free, works offline. But the before-move "here are your choices" coaching is thin and repetitive, and the overall lessons are only as good as the templates. |
| **B (chosen)** | **Stockfish and pattern code establish the facts; Claude turns them into coaching** | Rich, coach-like explanations that can refer to the user's own history. Needs internet, an API key and a per-game cost. Falls back to A-style templates when offline. |
| C | Mostly offline, with Claude only on an "explain more" tap | Cheaper, but the default coaching stays thin. That works against heavy coaching at the start. |

**The user picked B.** One rule holds regardless: **the engine decides what is true; Claude only explains facts it is given.**

Platform (builder's call, stated to the user, not objected to): an **installable web app (PWA)** with Stockfish running in the browser, added to the Android home screen. The builder can fully build and test it from the container. The user can ask for a native APK instead.

## The design

### 1. Game setup

- New game: pick a colour (or random). Untimed by default.
- The computer opponent plays **human-like at a target strength a little above the user**. It chooses among engine candidate moves with weighted randomness and makes occasional realistic mistakes (leaving a piece loose, missing a tactic) that the user can learn to punish. It must not be a perfect engine that has been crippled. Stockfish's built-in Elo limiter bottoms out far above 350, so this needs custom move selection. The target strength rises as the user improves.
- The opponent steers toward the repertoire (see §4) often enough that the user gets practice, but not always. Deviations are part of learning.

### 2. Before the user's move (pre-move coaching)

After the computer moves, the coach panel shows:

1. **What their move does:** its idea or threat in one or two sentences, for example "Their bishop now attacks your knight on f6, which is only defended once."
2. **Your choices:** two or three reasonable candidate moves (from the engine's top lines, filtered to moves a beginner would understand), each with one line on what it does and leads to. The coach may mark one as best. In the opening, this names the line and the idea ("This is the Italian; Bc4 aims at f7").
3. **Blunder check prompt** (early coaching levels): "Before you move: what does their last move attack? Is anything of yours undefended?" The user can tap to reveal the answer.

The panel is collapsible. The user can always move without reading it.

### 3. When the user makes a mistake

The game pauses and the coach shows:

- **The better move:** what to play here and why.
- **What it costs:** what the mistake allows, shown concretely. The refutation is played out or drawn on the board as arrows, for example "Bxf6 then Qxd5 wins a piece."
- **The overall lesson:** the general principle, plus the user's own pattern when relevant ("Third game in a row a piece got left undefended after a capture. Habit: after every capture, check what's loose.").
- **A recommendation:** "Take it back" (material loss, missed mate, big swing; the lesson is worth practising now) or "Play on" (small slip; handling the worse position is good practice).

Then the user chooses:

- **Take back:** the move is undone. The coach does **not** reveal the answer outright. The user tries again with a hint ladder: area or theme first, then the piece, then the move.
- **Play on:** the game continues. The coach remembers the refutation. If it later actually happens ("here's where that loose knight costs you"), the coach links back to the original mistake. This connects "it was a mistake" to "this is what it did to the game."

**What counts as a mistake** depends on the user's level and the coaching level. At the start, the coach stops for:
- pieces left hanging,
- simple tactics missed or allowed (forks, pins, skewers, one-move captures),
- missed checkmates, or allowing one,
- broken opening principles (early queen moves, neglecting development, king left in the centre, needless pawn moves).

Small inaccuracies are not flagged. Thresholds scale up as the user improves, so positional slips start being flagged later.

### 4. Opening repertoire

A small set, taught by ideas rather than memorised lines:

- **White:** Italian Game (1.e4 e5 2.Nf3 Nc6 3.Bc4).
- **Black vs 1.e4:** 1...e5. This mirrors the Italian, so knowledge transfers between colours.
- **Black vs 1.d4:** Queen's Gambit Declined.
- **Anything else** the computer plays is coached by principles, not named theory.

This is stored as a curated **repertoire tree** (move-by-move, with an idea or explanation at each node and the common deviations). It is authored once, can be drafted with Claude's help, and is checked against the engine before shipping. Book explanations work offline and are consistent. New branches unlock as the user reaches them in play.

### 5. Overall lessons and the learner profile

- Every flagged mistake is tagged with a **theme** from a fixed list, for example: hanging piece, ignored threat, missed fork, missed pin, missed mate, early queen, undeveloped pieces, king safety, bad trade, endgame technique. The builder finalises the list.
- The profile stores, per theme, the count, the recent trend and example positions from the user's own games.
- Claude receives the relevant profile summary with each explanation, so it can say "this keeps happening" and teach the general habit.
- A **"My patterns"** screen lists the top recurring themes. Each has a short lesson and links to the user's own positions where it happened.
- An **end-of-game recap** of two or three lines: the main theme of this game, one thing done well, one habit to work on. This is not a full review.

### 6. Weaning off

Coaching is tracked per area: **openings, middlegame/tactics, endgame**. Each area has a level:

| Level | Pre-move coaching | Stops on mistakes |
|---|---|---|
| Full | Opponent's idea, your choices, blunder-check prompt | Yes, low threshold |
| Guided | Opponent's idea only; choices on tap | Yes |
| Light | Nothing unless asked | Only clear blunders |
| Solo | Nothing | No; recap at the end only |

- **Starting levels:** openings and tactics start at **Full**. Endgame starts at **Light** (the user's strength).
- **Auto-adjust:** a rolling measure of how often the user finds good moves on their own in each area (not flagged, and close to engine best when choices were hidden or ignored). The level steps down when the user is consistently doing well and steps back up if mistakes return. Changes are announced ("You've been spotting threats well. I'll stop showing your choices in the middlegame.").
- **Manual override** per area in settings.
- **The clock:** games start untimed. As levels drop, the app suggests timed games so the user practises finding moves under time pressure, which is the user's stated weakness. The user turns the clock on.

### 7. Offline and failure behaviour

- With no network, no API key, or an API error, the coach falls back to template explanations built from the same verified facts: best move, what the mistake allows, theme lesson text. The repertoire tree works offline.
- The game is never blocked waiting for Claude. If an explanation is slow, the board stays usable and the explanation fills in when it arrives.

### 8. How Claude is used (the truth rule)

- For each coaching moment, code assembles a **fact packet**: the position, the move played, the engine's evaluation and top lines, detected tactical facts (what hangs, what's attacked, the refutation line), the repertoire node if in book, the theme, and the profile summary.
- Claude is asked to explain **only** those facts, in plain beginner language, briefly, and returns structured output (explanation text, recommendation, theme confirmation).
- Moves or squares Claude mentions are checked against the fact packet and legality. If Claude refers to a move that isn't in the packet, that output is discarded and the template fallback is used.
- The API key is entered once in settings and stored on the device only.

### 9. Model and cost

- Default model: **Claude Sonnet 5.5** (`claude-sonnet-5-5`, $2 input / $10 output per million tokens), chosen by the user. Claude's job is explaining facts it is given, not calculating chess, so Opus-level reasoning would mostly go unused.
- Rough estimate: about 30–60 coaching calls per game at ~2K input and ~500 output tokens each comes to roughly **$0.25–$0.50 per game** before prompt caching (which cuts the input side).
- The model is a setting. Opus 5.5 (`claude-opus-5-5`, ~$0.50–1/game) and Haiku 5.5 (`claude-haiku-5-5`, ~1–3¢/game) are selectable alternatives behind the same prompt and output schema.

### 10. Data

- Everything is stored locally on the phone (games, profile, settings, key).
- Export and import a backup file, since browser storage can be cleared.

## Left to the builder

- Framework, libraries and code structure (TypeScript is assumed; chess rules and board UI libraries; a Stockfish WebAssembly build in a web worker).
- The human-like opponent's move-selection algorithm and its strength calibration.
- Exact mistake thresholds, the skill metric for weaning, and the step-down rules (within the behaviour described above).
- The final theme list and lesson texts.
- Prompt design and structured output schema.
- Visual design (mobile-first, board-dominant, coach panel below the board).
- Hosting for the installable app.

## Open questions

None.
