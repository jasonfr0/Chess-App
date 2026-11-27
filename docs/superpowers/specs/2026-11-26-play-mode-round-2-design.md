# Play Mode Round 2: Level-Pitched Explanations, Board Aids, Spoiler-Free Mistakes — Design

Date: 2026-11-26
Status: approved
Builds on, and stays bound by unless changed here:
- `docs/superpowers/specs/2026-11-25-chess-coach-design.md`
- `docs/superpowers/specs/2026-11-26-play-mode-socratic-coaching-design.md`

## Intent and the why

After playing the questions-first Play mode, the user (rated about 350) asked for six changes, plus a seventh while we talked:

1. **Explanations don't fit their level.** On Sonnet they were full of positional jargon and didn't say why a move was best *in this game*. Opus was better but still not pitched to a beginner. When the reason is an opening or a fundamental, the coach should name it and say why it works.
2. **Move history.** Step back and forth through the game to look at it.
3. **Check.** Highlight a checked king's square in red.
4. **Hints point at the board.** A nudge or hint highlights the square or piece it mentions, and nothing when it names none.
5. **Mistake card spoiler.** The card gives the best engine move straight away, which makes the take-back hints pointless. The card should still stop the game, say mistake or blunder, explain why, and recommend take back or play on, but without revealing the move.
6. **Attack lines.** A setting that shows what the opponent's pieces attack while the user chooses a move.
7. **Watch what happens.** When the card describes a multi-move consequence ("checkmate in 3"), let the user see that sequence play out on the board.

**Root cause of (1), found in recon.** Claude may only rephrase the template's reasons, and those are thin ("Nf3 was the engine's top choice here"). It fills the gap with jargon. The fix is richer, engine-checked reasons plus strict beginner-language rules.

## Goals

- Every after-move and mistake explanation says, in beginner words, what the move does **in this game**. Where it applies, it names the opening and its idea, or the fundamental at work, and why that works.
- The user can step through the game's history. Viewing history is read-only and changes nothing.
- A checked king's square is red, for either side, live and in history.
- Nudges and hints that name a square or piece highlight it on the board.
- The mistake card never shows the better move before the user decides. The hints stay useful. "Show me" is the last-resort reveal.
- An optional attack-lines aid, with honest skill accounting and a coach nudge to wean off it.
- Multi-move consequences can be watched step by step.

## Non-goals

- Teaching mode. It is next and gets its own design.
- Changing the opponent, the opening repertoire coverage, storage or the PWA.
- Free-form reasoning from Claude (approach B was rejected).

## Anti-goals

- **False chess.** Every reason and every highlighted square comes from engine or verified facts.
- **Spoilers.** The better move must not show during a decision unless the move then counts as helped. This covers the card, highlights, history view and Watch-what-happens.
- **Jargon.** Banned terms (see §1) must never appear in shown text.
- **Clutter.** Attack lines must stay readable on a phone screen.

## Approaches considered

For (1); the other items have one sensible build each.

| | Approach | Trade-off |
|---|---|---|
| **A (chosen)** | The app derives real, engine-checked reasons (opening and idea, fundamental, concrete effect). Templates state them plainly. Claude only rewrites them under strict beginner rules and a banned-jargon list. | Same cost as now, works offline, truth guaranteed. Claude can't add insight beyond the facts. |
| B | As A, but Claude may add reasons of its own | Richer, but unverified chess claims: the false-lesson risk |
| C | Make Opus the default | About 2× cost, and still pitched wrong, because the reasons it gets are thin |

The user picked **A**. The model stays selectable in Settings (Sonnet 5.5 default).

## The design

### 1. Explanations pitched to the player (approach A)

**Reason derivation.** A new pure module produces a `Reasons` object for a move in its position. Every field is fact- or engine-checked:
- **Opening:** if the position is in the repertoire, its line name plus the node idea. Out of book but in the opening phase, the named principle.
- **Fundamentals,** detected with chess.js on the move:
  - develops a knight or bishop off its home square;
  - occupies or attacks a centre square (d4, d5, e4, e5);
  - castles or otherwise improves king safety;
  - defends a piece that was attacked;
  - attacks an enemy piece, or creates a check or mate threat;
  - wins material per the engine line's first exchange;
  - trades when ahead;
  - pushes a passed pawn;
  - activates the king in the endgame.
- **Concrete effect in this game:** what the move attacks or defends now, and the engine's first reply when it explains the point.
- **Why the principle works:** a fixed, beginner-plain sentence per fundamental. Example: "Developing knights and bishops early gets more of your army into the fight before your opponent's." These live in a table, like `THEME_LESSONS`.

**Templates** build explanations from `Reasons` in the order "what it does here → which idea or opening → why that idea works". At most 3 sentences per field.

Example: "Nf3 brings a knight out and attacks the pawn on e5. That's the Italian Game's first step. Getting knights out early lets you fight for the centre before your opponent does."

**Claude prompt:**
- Rewrite only the given reasons, for a player rated about 350.
- Short sentences, everyday words, concrete pieces and squares.
- One idea per sentence, no stacking clauses.
- Include one good example and one bad example (jargon-heavy) in the prompt.
- **Banned terms**, enforced by a validator that discards the output (and keeps the template) if any appear: "outpost", "tempo", "prophylaxis", "initiative", "zwischenzug", "positional", "weakness complex", "pawn structure" (allowed only if the template used it), "space advantage", "compensation", "dynamic", "static". The builder finalises the list in one constant.

**Where it applies:**
- After-move feedback: top or book Explain, and "a stronger option".
- The mistake card: why it was a mistake.
- After Play on: why the better move is better.

### 2. Move history

- ◀ ▶ buttons under the board. Any move in the move list is tappable.
- While viewing a past position:
  - the board is read-only;
  - a **Back to game** button returns to the live position;
  - the viewed move is highlighted in the list;
  - the coach panel shows "Viewing move N" and nothing that could hint at the live position.
- History view is available during the user's turn, the opponent's turn and after the game. If the opponent moves while the user is viewing, the app stays on the viewed position and shows a small "New move — Back to game" cue.
- Viewing history never counts toward skill and never changes the game. Only *past* positions are shown, which reveals nothing new.

### 3. Check highlight

The checked king's square gets a red background, for either side, in the live game, in history view and in Watch-what-happens. It is derived from chess.js `isCheck()` and the king's square.

### 4. Hints point at the board

- Nudge and hint text keeps naming squares and pieces as today.
- Each nudge or hint carries an optional `highlight: { square: string; kind: 'look' }[]`, built from the same fact the text uses (`Look at your knight on f6` → f6). Text that names no square has no highlight.
- **Look:** a yellow ring on the square. It is shown while that nudge or hint is visible, and cleared on the next move or a take-back to a different position.
- A test checks every square named in a nudge or hint is in its `highlight`, and that no highlight exists without a named square.

### 5. Spoiler-free mistake card

The card shows:
- **The title:** "✗ Mistake" or "✗ Blunder".
- **What happened:** what the move allows, using the opponent's reply and §1 reasons. Example: "Your bishop on c4 can now be taken by their pawn on b5."
- **The lesson:** the theme habit, with its why (§1).
- **The recommendation badge**, and the **Take it back** and **Play on** buttons.
- **No better move,** and no green arrow. The red arrow (the opponent's reply) stays.

**Take it back → hint ladder:**
- **Hint 1:** the lesson habit, with no highlight.
- **Hint 2:** "Look at your <piece> on <square>", which rings that square (§4).
- **Show me** (renamed from Hint 3): reveals the better move with a green arrow and the §1 explanation. A move played after it counts as helped, as today.

**Play on:** the better move and its §1 explanation are revealed straight away in "Your last move", together with the green arrow. That arrow follows the existing rule: it is folded away and hidden once the opponent replies.

Template and Claude mistake text must not name the better move. The packet's `allowedMoves` for the card is `[move.san, reply]`, and the Play-on reveal is a separate post-decision packet.

### 6. Attack lines (setting)

- **Setting:** "Show attack lines — moves made with this on count as helped". Off by default.
- **When shown:** only during the user's turn in the live game. Not during the opponent's turn, history view or Watch-what-happens.
- **What is drawn:**
  - each of the user's pieces under attack gets a red arrow from each attacker. No square tinting (changed 2026-11-27 at the user's request: tinting every attacked square was correct but not useful).
- Attacks are pseudo-legal attacks by the opponent's pieces, including pinned pieces, since they still attack. Facts come from chess.js.
- **Skill accounting:** any move made while attack lines are on is recorded as **helped** (`assisted: true`).
- **Coach recommendation:**
  - **When:** at game end, if the last 3 finished games were played with attack lines on (on for at least 80% of the user's moves) and none had a flagged `hanging_piece`, `ignored_threat` or `allowed_fork` theme.
  - **What it shows:** "You've been spotting threats well — try turning attack lines off so your moves count toward your progress."
  - **Repeats:** after each later game that still meets the rule.
  - Track per game whether lines were on, as a fraction of user moves, in the saved game.

### 7. Watch what happens

- **When it appears:** a **▶ Watch what happens** button shows on the mistake card when the consequence takes more than one move to show. That means the refutation line is a forced mate, or the mover's material loss appears only after ply 1. The line comes from the engine's best line after the user's move.
- **How it plays:**
  - The line plays on the board one move at a time, with ◀ ▶ step controls and an arrow per move.
  - Its length is up to the mate, or until the material loss is complete, capped at 8 plies.
  - **Back to the card** returns to the decision.
  - The live game is untouched.
- **Skill accounting:** if the user watched and then chose **Play on**, any of their next moves that match the watched line's moves for their side count as **helped**. Taking it back is unaffected, since that position never happens.
- **Exception to the earlier ruling:** the earlier ruling limited mistake packets to the opponent's first reply (one ply). That still applies to text. Watch-what-happens is the one place the full line is shown, behind an explicit tap, with the accounting above.

## Settled details (my calls)

- **Banned jargon list:** owned by one exported constant, with tests.
  - It applies to Claude output: the output is discarded if a banned term appears.
  - Templates are tested against the same list and must contain none of the terms. There is no "pawn structure" exception; it is simply banned.
- **Watch-what-happens: the line.** The engine's analysis of the position after the user's move already carries the full principal variation (`afterAnalysis.lines[0].uci`), so no engine interface change is needed.
  - **When the button shows:** when the line contains a mate, or when the mover's material loss is not complete after ply 1. That is, the static material count (`positionFacts(...).material`) at the end of the shown line is lower for the mover than after ply 1. This replaces "≥ 3 plies".
  - **Shown length:** up to the mate, or up to the ply where the material count stops changing, capped at 8 plies.
- **Watch-what-happens: skill accounting.** The watched line alternates the opponent's moves and the user's best replies. After **Play on**, while the real game follows the watched line exactly, each user move that equals the watched line's next user move is recorded as helped. Once the game leaves the line (any move differs), the rule stops.
  - **Play on's reveal of the better move** needs no accounting. That move belonged to a position that no longer exists.
- **Hint 2:** it rings the piece the better move starts from. It names no destination.
- **Hint highlights also apply to the pre-move nudge,** which already names squares ("Look at your knight on f6"), with the same rule: ring the named square, and highlight nothing if no square is named.
- **Attack map definition:**
  - An attacked square is one an opponent piece attacks. Pawns attack diagonally only; pushes don't count. Pinned pieces still attack.
  - A red line is drawn to every user piece that stands on an attacked square, from each attacker, whether or not the piece is defended. The aid shows attacks, not judgements.
- **Turn-off recommendation trigger:**
  - Look at the last 3 finished games with at least 10 user moves each. Each must have attack lines on for at least 80% of the user's moves, and none may have a flagged `hanging_piece`, `ignored_threat` or `allowed_fork` among the user's moves.
  - Games saved before this change, with no usage data, count as lines off.
  - `SavedGame` gains an optional `attackLinesMoves: number` alongside the existing move count.
- **Opening phase** means `areaOf(...) === 'opening'` (in book, or fewer than 20 plies), the same as the rest of the app.
- **History view during decisions:**
  - It is allowed in any phase, including while the mistake card is open; the board is read-only anyway.
  - The "New move — Back to game" cue only says that a move happened. It reveals no evaluation or threat.
- **Hint 2:** it rings the piece the better move starts from. It names no destination.
- **Attack-line colours:** tints are low-opacity so pieces stay readable. Lines use the existing arrow component in red.
- **History view and the clock:** opening history view doesn't pause the clock (timed games are a later opt-in feature).

## Left to the builder

- Detection details for each fundamental, within "fact-checked only".
- The exact wording of the "why it works" sentences (beginner-plain, ≤ 1 sentence each).
- Component structure for history, attack lines and the watch player.
- How the saved game stores attack-line usage.
