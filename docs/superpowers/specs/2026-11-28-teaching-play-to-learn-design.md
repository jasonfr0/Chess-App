# Teaching mode, piece 1: Play to learn — design

Date: 2026-11-28. Status: awaiting the user's approval.

## Intent and why

Play mode now hides good moves until after the user has moved, because it measures the user's own
play. That leaves no place where the coach shows best practice *before* a move. The user (about
255 bullet / 350 rapid on Chess.com, strongest in endgames) wants that place: a real game against
the computer where the coach breaks down the position before each of their moves, against replies
that are not scripted.

Teaching mode was described by the user as four pieces. This document covers only the first; the
other three get their own design later and all reuse this one's per-turn coaching.

1. **Play to learn** (this document).
2. Learn an opening: a step-by-step lesson, then a Play-to-learn game in that opening.
3. Patterns page covering every area, with "Work on this" starting targeted teaching.
4. Import Chess.com games and have the coach walk through them.

## Goals

- A "Play to learn" game: a full game against the same computer opponent as Play mode.
- Before each user move the coach explains the position and, to begin with, shows good moves with
  reasons and arrows. The user picks one or plays their own move.
- When the position is in the user's repertoire, the coaching follows that opening's lines and
  plan. Otherwise it teaches fundamentals.
- Progressive: per topic, the coach moves from showing moves to guidance only, and back if needed.
- Nothing in a teaching game changes the Play-mode skill assessment, coaching levels, or opponent
  strength.
- Mistakes made in teaching games still appear on the Patterns page, labelled as from teaching.

## Non-goals (this piece)

- Opening lessons, the opening picker, "Work on this", Chess.com import (pieces 2–4).
- Recognising openings outside the existing repertoire file. Piece 2 expands opening content.
- A clock in teaching games.

## Anti-goals

- A teaching game leaking into the Play-mode assessment in any way.
- The coach stating anything about the position that the engine or chess.js has not checked.
- Jargon. All text stays at the level set in the round-2 design (name the fundamental and why it
  works).
- Play mode's behaviour changing at all.

## Constraints

- Existing truth rule: the engine and chess.js decide facts; Claude only rewords checked text and
  its output passes the existing validators. Everything must work offline from templates.
- Phone-first PWA, one Stockfish worker, analysis at the existing depth 14 / multipv 3.
- Saved data from before this change must keep loading (new fields optional or migrated).

## Approaches

- **A. A mode flag on the existing game (chosen).** `useGame`, `Coach`, the board and storage serve
  both modes. Teaching logic lives in new pure modules. History navigation, check highlight, Watch,
  attack lines and saved games work unchanged. Cost: branches in shared code; isolation from the
  assessment must be tested.
- **B. A separate teaching screen and game hook.** Full isolation, but duplicates about 600 lines of
  game handling and doubles future maintenance.
- **C. Claude decides what to teach.** Richer text, but breaks the truth rule, fails offline, and can
  teach wrong moves.

The user left technical choices to the builder; A is the builder's call.

## What the user sees

Decided with the user unless marked *(builder's call)*.

### Starting

Where a new game is started today, there are two choices: **Play** (existing) and **Play to learn**.
A teaching game shows a persistent label, e.g. "Teaching game · doesn't count toward your level".
Colour choice and opponent strength are the same as Play mode. No clock *(builder's call)*.
A teaching game resumes as a teaching game after closing the app.

### Each turn, before the user moves

```
Computer played: Bc5                      [Teaching game · doesn't count]

Coach: Their bishop now aims at f2, the weak square next to
your king. You're still in the Italian Game: the plan is to
castle and then push in the centre.

Good options:                              (arrows on the board)
 1. Castle  – gets your king safe before anything opens up
 2. c3      – prepares to push d4 and take the centre

[Watch option 1]  [Watch option 2]
```

Parts of the turn message:

1. **Their move** — what the computer's move did (existing text from Play mode's pre-move coaching).
2. **The position** — one or two sentences on what matters now: threats against the user, what the
   user can win, and the opening's name and plan when in the repertoire.
3. **Options** — in *show* mode, up to three good moves, each with a one-sentence reason and a
   board arrow. Each has a **Watch** button that plays a few moves of the engine's line on the
   existing watch player.
4. In *guide* mode, parts 1–2 plus Play mode's existing questions and nudge (which never name a
   move), and a **Show me options** button that reveals part 3 for this turn.

### After the user moves

- **Good move** (not flagged by the existing classifier): a short confirmation. If the move was not
  one of the shown options, the confirmation says why it is also fine, using its checked reasons.
  No "do you see why?" question in teaching games *(builder's call)*.
- **Mistake or blunder**: the game stops as in Play mode, but the card shows the better move and its
  explanation immediately. "Watch what happens" stays. The user takes back or plays on. Take-backs
  are unlimited, as today.

### End of game

A teaching recap: result, which topics came up, and any topic that moved between showing and
guiding. No level changes, no clock or attack-line suggestions.

## How options are chosen *(builder's call, within the truth rule)*

For the position before the user's move, using the existing analysis:

- **In the repertoire**: the options are the repertoire's moves for this position (main line first),
  with the node's `idea` as the reason and the line's plan in "The position". The engine's best
  move is not added if the repertoire does not list it. Watch uses the engine's line when the
  option is among the analysed lines; otherwise the repertoire's main continuation when it runs at
  least two more moves; otherwise that option has no Watch button. No extra engine search per option.
- **Otherwise**: engine lines whose score is within a small margin of the best line (constant,
  suggested 50 centipawns; a forced mate only pairs with other forced mates), best first, at most
  three. Each reason comes from the existing `deriveReasons` / `reasonText`.
- Outside the repertoire the best move is always shown. If no checked reason can be derived for a move, the best move gets
  an honest plain line ("This is the strongest move here. Watch the line to see where it leads.")
  and other reasonless moves are dropped.
- Claude may reword the turn text when a key is set, under the existing validators: the SAN
  allow-list is the shown options; in guide mode, before options are opened, the text must pass the
  existing move-leak check. On any failure, the template text is used.

## How showing fades to guiding *(builder's proposal, accepted by the user in outline)*

Each turn has one **topic**, taken from the main checked reason for the best move:

| Topic | When |
|---|---|
| opening | the position is in the repertoire |
| safety | the best move saves or defends a piece of the user's that is under attack |
| captures | the best move wins material |
| checks | the best move gives mate, or a check or threat that wins something |
| development | bringing pieces out, the centre, castling, outside the repertoire |
| endgame | the position is an endgame (existing `areaOf`) and none of the above applies |
| other | none of the above |

Each topic has a mode, **show** or **guide**, stored in the profile:

- Every topic starts in *show* except **endgame**, which starts in *guide* (the user's strength).
- After 5 shown turns on a topic, it switches to *guide* as a trial.
- In *guide*, a turn is a **success** if the user plays a non-flagged move without opening the
  options. It is a **miss** if the move is flagged, or the options were opened.
- Two misses within the last four guide turns of a topic send it back to *show*; after 3 more
  shown turns it tries *guide* again.
- "other" always stays in *show*.

Each position counts once, by the user's first attempt. After a take-back, the retry changes
neither the shown-turn count nor the success/miss record. The taken-back mistake still adds to the
teaching theme count, as it does in Play.

Play mode's coaching levels and the Settings level override do not apply in a teaching game. The
classifier always runs at full strictness (mistakes and blunders are both flagged, in every area),
and in guide mode the questions are always visible. *(builder's call)*

The numbers are named constants in one place. This state is separate from Play mode's coaching
levels and neither affects the other.

## Keeping teaching out of the assessment

- `SavedGame` gains `mode?: 'play' | 'teach'` (absent = play).
- In a teaching game: no `recordMove` into `profile.moves`; no `reviewLevels`; no opponent rating
  adjustment; no clock or attack-line suggestions.
- Every place that reads past games for the assessment (last-five score for opponent rating,
  attack-line suggestion, games-played counts used for levels) ignores teaching games.
- Theme counts: `ThemeStat` gains a separate teaching count and teaching examples *(builder's
  call on exact field names)*. Play mode's coach text ("this is the third time…") uses only the
  Play count. The Patterns page shows both, e.g. "3 in games · 2 while learning".
- Profile gains the per-topic teaching state. Export/import and the zod schema accept the new
  optional fields; old data loads with defaults.

## Structure *(builder's call)*

- New pure modules under `src/teach/`: choosing options, deciding the topic, and the fade rules.
  Each is unit-tested without the UI or engine worker (analysis passed in).
- `Coach` gains a teaching pre-move path that returns a new message kind (e.g. `teach`) carrying
  their-move text, position text, options (san, uci, reason, watch line), mode, and the existing
  guide fields. In teaching games the mistake path returns the card with the reveal already
  attached.
- `useGame` takes the game's mode and skips the assessment calls listed above.
- `CoachPanel` renders the teach message; arrows for shown options use the existing arrow support
  (green), and only while options are visible.
- Attack lines, history navigation, check highlight and the promotion picker behave as in Play.

## Testing

- Unit: option selection (repertoire, engine margin, mate, missing reasons), topic choice, fade
  rules (trial, success, miss, fall back, endgame start, "other").
- Isolation: after a full teaching game, `profile.moves`, levels, opponent rating and Play theme
  counts are unchanged; teaching theme counts and topic state did change.
- Play levels set to `solo` or overridden in Settings do not change what a teaching game flags or shows.
- Take-back: a retry does not change the fade counts; the mistake still counts as a teaching theme.
- Guide mode: turn text names no move before "Show me options"; arrows absent until then.
- Storage: old profiles and games load; export/import round-trips the new fields.
- e2e: start a Play-to-learn game, see options and arrows, play one, see confirmation; make a
  mistake and see the better move at once.
- Play mode's existing tests pass unchanged.

## Left to the builder

Exact wording of templates, layout and styling of the options list, field names, the constants'
final values, and how the start-of-game choice is laid out.
