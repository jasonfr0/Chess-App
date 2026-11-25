# Chess Coach Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an installable chess web app for one beginner. It coaches in real time during games against a human-like computer opponent, explaining moves and mistakes with engine-verified facts, and weans off as the user improves.

**Architecture:** A static React PWA with no backend.
- Stockfish (WebAssembly, in a Web Worker) supplies all chess truth.
- Pure TypeScript modules turn engine output into facts, verdicts, opponent moves and weaning decisions.
- A coach orchestrator shows a template explanation immediately and upgrades it with a Claude Sonnet 5.5 explanation when one arrives. Claude only rephrases the fact packet it is given.
- All data lives in IndexedDB on the phone.

**Tech Stack:**
- Vite, React 18, TypeScript (strict)
- Vitest, @testing-library/react, fake-indexeddb; Playwright (pre-installed, do not reinstall)
- chess.js (rules), react-chessboard (board UI)
- `stockfish` npm package, **lite single-threaded build** (needs no SharedArrayBuffer, so no COOP/COEP headers)
- idb (IndexedDB), zod, @anthropic-ai/sdk, vite-plugin-pwa

Pin exact versions in `package.json` when installing.

**Spec:** `docs/superpowers/specs/2026-11-25-chess-coach-design.md`

## Global Constraints

- One user, no backend server, no accounts. All data is stored on the device.
- **Truth rule:** every concrete chess claim shown to the user (moves, what hangs, lines, evaluations) comes from the engine or verified pattern code. Claude output that mentions a move not in the fact packet is discarded and the template is used instead.
- **Claude settings:**
  - Default model `claude-sonnet-5-5`. Selectable alternatives: `claude-opus-5-5` and `claude-haiku-5-5`.
  - `output_config: { effort: "low", format: zodOutputFormat(...) }`.
  - Server-side refusal fallback: `betas: ["server-side-fallback-2026-07-01"]`, `fallbacks: "default"`. Send it only for Sonnet and Opus, never for Haiku.
  - Browser client: `new Anthropic({ apiKey, dangerouslyAllowBrowser: true })`.
  - Never send `temperature`, `top_p`, `top_k`, assistant prefill, or `thinking: {type:"disabled"}`.
- The game is never blocked waiting for Claude. Input is disabled only while the engine opponent is choosing its move.
- Explanations use beginner language and name the piece and square ("your knight on f6"). Template text stays at 3 sentences or fewer per section.
- **Repertoire:** White plays the Italian (1.e4 e5 2.Nf3 Nc6 3.Bc4). Black plays 1...e5 against 1.e4 and the Queen's Gambit Declined (1.d4 d5 2.c4 e6) against 1.d4. Anything else is coached by principles.
- **Starting coach levels:** opening `full`, middlegame `full`, endgame `light`.
- Games are untimed by default. The clock is opt-in.
- Mobile-first layout that works at a 360×740 viewport: board on top, coach panel below, no horizontal scroll.
- Commit messages end with the session's attribution lines and never name a model.

## Review Focus

1. **Claude unavailable mid-game** (no key, offline, 401, timeout, refusal): the template explanation stays on screen, the game keeps going, and the user sees one small "coach offline" indicator instead of an error dialog. Pinned in Task 9.
2. **Claude output that breaks the truth rule** (mentions an unlisted move, malformed or null `parsed_output`): it's discarded silently and the template is shown. Pinned in Task 8.
3. **Special moves and game end:**
   - Promotion lets the user choose the piece.
   - Castling and en passant work.
   - Checkmate, stalemate, threefold repetition, the 50-move rule and insufficient material all end the game with the right result.
   - The coach never analyses or flags a move in a finished position.
   Pinned in Tasks 1 and 12.
4. **Takeback edge cases:** a takeback after the computer has already replied undoes both plies. A takeback at move 1 is unavailable. Repeated takebacks never desync the board, the engine and the coach state. Pinned in Tasks 1 and 9.
5. **App closed or reloaded mid-game:** the game in progress resumes exactly. A corrupt or foreign backup file is rejected and existing data is kept. Pinned in Task 10.

---

## File Structure

```
index.html
vite.config.ts                  # React + PWA plugin, base path for Pages
public/stockfish/               # copied lite-single engine .js + .wasm
src/types.ts                    # shared types (Task 1)
src/game/gameState.ts           # chess.js wrapper: moves, undo, result
src/engine/uci.ts               # pure UCI line parsing
src/engine/engine.ts            # worker wrapper: analyse(fen, opts)
src/openings/repertoire.json    # curated repertoire tree
src/openings/repertoire.ts      # lookup + steering helpers
src/opponent/selectMove.ts      # human-like move choice
src/coach/facts.ts              # hanging/attacked pieces, material, principles
src/coach/classify.ts           # area, mistake verdict, theme, recommendation
src/coach/templates.ts          # offline explanation text
src/coach/claude.ts             # fact packet -> Claude -> validated text
src/coach/coach.ts              # orchestrator: preMove, onUserMove, hints, consequences, recap
src/profile/profile.ts          # theme stats, examples, per-area move records
src/profile/weaning.ts          # level step-down/up rules
src/storage/db.ts               # IndexedDB, export/import
src/ui/App.tsx, GameScreen.tsx, CoachPanel.tsx, MistakeCard.tsx,
      PromotionPicker.tsx, SettingsScreen.tsx, PatternsScreen.tsx, RecapCard.tsx
tests/... mirrors src/
e2e/smoke.spec.ts               # Playwright, real Stockfish, 360x740
.github/workflows/deploy.yml    # build + GitHub Pages
```

---

### Task 1: Scaffold and game state

**Files:**
- Create: `package.json`, `vite.config.ts`, `tsconfig.json`, `index.html`, `src/main.tsx`, `src/types.ts`, `src/game/gameState.ts`
- Test: `tests/game/gameState.test.ts`

**Interfaces:**
- Produces, in `src/types.ts`:
  ```ts
  export type Color = 'w' | 'b';
  export type Area = 'opening' | 'middlegame' | 'endgame';
  export type CoachLevel = 'full' | 'guided' | 'light' | 'solo';
  export type Theme = 'hanging_piece' | 'ignored_threat' | 'missed_fork' | 'missed_pin'
    | 'missed_mate' | 'allowed_mate' | 'early_queen' | 'undeveloped' | 'king_safety'
    | 'bad_trade' | 'endgame_technique' | 'other';
  export type GameResult = { winner: Color | null; reason: 'checkmate' | 'stalemate'
    | 'repetition' | 'fifty_move' | 'insufficient' | 'resign' | 'timeout' };
  export interface PlayedMove { san: string; uci: string; fenBefore: string; fenAfter: string; color: Color }
  ```
- Produces, in `src/game/gameState.ts`:
  ```ts
  export class GameState {
    constructor(userColor: Color, startFen?: string, moves?: string[] /* uci */);
    readonly userColor: Color;
    fen(): string; turn(): Color; history(): PlayedMove[]; isUserTurn(): boolean;
    legalMovesFrom(square: string): string[];             // uci
    needsPromotion(from: string, to: string): boolean;
    play(uci: string): PlayedMove;                         // throws on illegal
    canTakeBack(): boolean;                                // false if user has no move yet
    takeBackUserMove(): PlayedMove[];                      // undoes 1 ply, or 2 if opponent already replied
    result(): GameResult | null;
    toJSON(): { userColor: Color; moves: string[] };
  }
  ```

- [ ] **Step 1:** Scaffold Vite React-TS, add Vitest (`npm test` = `vitest run`) and the dependencies from Tech Stack. Run `npm run build`. Expected: build succeeds.
- [ ] **Step 2: Write failing tests** in `tests/game/gameState.test.ts`:
  - `play('e2e4')` then `history()[0].san === 'e4'`. Illegal `play('e2e5')` throws.
  - Castling: from FEN `r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1`, `play('e1g1')` gives SAN `O-O`.
  - En passant: from `4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1`, `play('e5d6')` removes the d5 pawn.
  - Promotion: from `4k3/P7/8/8/8/8/8/4K3 w - - 0 1`, `needsPromotion('a7','a8') === true`, and `play('a7a8n')` puts a knight on a8.
  - Results:
    - Fool's mate (`f2f3 e7e5 g2g4 d8h4`) gives `{winner:'b', reason:'checkmate'}`.
    - Stalemate FEN `7k/5Q2/6K1/8/8/8/8/8 b - - 0 1` gives `reason:'stalemate'`.
    - `4k3/8/8/8/8/8/8/4K3 w - - 0 1` gives `'insufficient'`.
    - Knights shuffling `g1f3 g8f6 f3g1 f6g8` ×2 gives `'repetition'`.
  - Takeback:
    - User white with history `e2e4 e7e5`: `takeBackUserMove()` returns 2 moves, and `fen()` is the start position.
    - With only `e2e4`, it returns 1 move.
    - On a fresh game, `canTakeBack() === false`.
    - Three alternating play/takeback cycles end at the same FEN they started from.
  - `new GameState('w', undefined, game.toJSON().moves).fen() === game.fen()`.
- [ ] **Step 3:** Run `npm test -- gameState`. Expected: FAIL (module missing).
- [ ] **Step 4:** Implement `GameState` over chess.js.
- [ ] **Step 5:** Run `npm test -- gameState`. Expected: PASS.
- [ ] **Step 6:** Commit `feat: scaffold app and game state`.

### Task 2: Engine wrapper

**Files:**
- Create: `src/engine/uci.ts`, `src/engine/engine.ts`, `public/stockfish/*` (copied by a `postinstall` script from `node_modules/stockfish`)
- Test: `tests/engine/uci.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // src/types.ts additions
  export interface EngineLine { uci: string[]; cp: number | null; mate: number | null } // side-to-move POV
  export interface Analysis { fen: string; depth: number; lines: EngineLine[] }           // lines[0] = best
  // src/engine/uci.ts
  export function parseInfo(line: string): { multipv: number; depth: number; line: EngineLine } | null;
  export function parseBestMove(line: string): string | null;
  // src/engine/engine.ts
  export interface Engine { analyse(fen: string, opts: { multipv: number; depth: number }): Promise<Analysis>; stop(): void }
  export function createEngine(workerUrl?: string): Engine;   // default '/stockfish/<lite-single>.js' under Vite base
  ```
- Calls are serialised: a new `analyse` waits for the previous one. `stop()` rejects any pending call.
- Depth defaults used by callers: analysis of the user's move `depth 14, multipv 3`; opponent move `depth 10, multipv 5`.

- [ ] **Step 1: Write failing tests:**
  - `parseInfo('info depth 12 seldepth 18 multipv 2 score cp -35 nodes 1 pv e7e5 g1f3')` gives `{multipv:2, depth:12, line:{uci:['e7e5','g1f3'], cp:-35, mate:null}}`.
  - A `score mate -3` line gives `mate:-3, cp:null`.
  - A line with no `pv` gives `null`.
  - `parseBestMove('bestmove e2e4 ponder e7e5') === 'e2e4'`. `'bestmove (none)'` gives `null`.
- [ ] **Step 2:** Run `npm test -- uci`. Expected: FAIL.
- [ ] **Step 3:** Implement the parser. Implement `createEngine` (it sends `uci`, `isready`, `setoption name MultiPV`, `position fen`, `go depth`, keeps the deepest line per multipv, and resolves on `bestmove`).
- [ ] **Step 4:** Run `npm test -- uci`. Expected: PASS. Worker integration is verified in the Task 12 e2e.
- [ ] **Step 5:** Commit `feat: stockfish worker wrapper`.

### Task 3: Repertoire tree

**Files:**
- Create: `src/openings/repertoire.json`, `src/openings/repertoire.ts`, `scripts/check-repertoire.ts`
- Test: `tests/openings/repertoire.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface RepertoireNode { san: string; name?: string; idea: string; children: RepertoireNode[]; main?: boolean }
  export interface BookHit { node: RepertoireNode; lineName: string; inBook: true }
  export function lookup(userColor: Color, sanHistory: string[]): BookHit | null; // node for the LAST move
  export function bookReplies(userColor: Color, sanHistory: string[]): RepertoireNode[]; // next-move children
  ```
- JSON shape: `{ white: RepertoireNode[] /* from start */, black: RepertoireNode[] }`. Black's root holds both `e4` and `d4` subtrees.
- **Content** (4–8 plies deep, with each node's `idea` at most 2 sentences in beginner language):
  - **White Italian:** after 3.Bc4, cover 3...Bc5 (4.c3 and 4.O-O plans), 3...Nf6 (4.d3 quiet line), and 3...d6 / 3...Be7 by principle notes. Also include the common deviations at moves 1–2: 1...c5, 1...e6, 1...d5, 2...d6, 2...Nf6. Each gets a short principle node and then exits the book.
  - **Black vs 1.e4 e5:** cover 2.Nf3 Nc6 3.Bc4 Bc5 (the mirror), 3.Bb5 a6 4.Ba4 Nf6, 3.d4 exd4, plus 2.Nc3, 2.Bc4 and 2.f4 by principle notes.
  - **Black vs 1.d4 d5:** cover 2.c4 e6 3.Nc3 Nf6 4.Bg5 Be7, 2.Nf3 Nf6, and 2.Bf4 (London) Nf6 3.e3 e6 by principle notes.

- [ ] **Step 1: Write failing tests:**
  - Every path in the JSON replays legally through chess.js (walk the whole tree).
  - `lookup('w', ['e4','e5','Nf3','Nc6','Bc4'])?.lineName` contains `"Italian"`.
  - `lookup('b', ['d4','d5','c4','e6'])?.lineName` contains `"Queen's Gambit Declined"`.
  - `lookup('w', ['a3'])` is `null`.
  - `bookReplies('b', ['e4'])` contains `san:'e5'`.
  - Every `idea` is non-empty and at most 300 chars.
- [ ] **Step 2:** Run `npm test -- repertoire`. Expected: FAIL.
- [ ] **Step 3:** Write the JSON and `repertoire.ts`. Write `scripts/check-repertoire.ts`: it runs Node Stockfish over every book move and prints any move worse than −60cp for the side playing it. Fix or remove any line it prints.
- [ ] **Step 4:** Run `npm test -- repertoire` (expected: PASS), then `npx tsx scripts/check-repertoire.ts` (expected: no lines printed).
- [ ] **Step 5:** Commit `feat: opening repertoire tree`.

### Task 4: Human-like opponent

**Files:**
- Create: `src/opponent/selectMove.ts`
- Test: `tests/opponent/selectMove.test.ts`

**Interfaces:**
- Consumes: `Analysis` (Task 2), `bookReplies` (Task 3).
- Produces:
  ```ts
  export interface OpponentConfig { rating: number; bookChance: number /* default 0.7 */ }
  export function selectOpponentMove(fen: string, analysis: Analysis, sanHistory: string[],
    userColor: Color, cfg: OpponentConfig, rng: () => number): string; // uci
  export function adjustOpponentRating(current: number, userScoreLastFive: number /* 0..5 */): number;
  ```
- Algorithm:
  1. **Book:** if `bookReplies` is non-empty and `rng() < bookChance`, play a book reply. `main` nodes are weighted ×2.
  2. **Blunder roll:** with probability `pBlunder = clamp(0.25 - rating/4000, 0.02, 0.2)`, play a random legal non-best move that drops 150–500cp (from the multipv lines first; if none, any legal move evaluated by line order). Never one that loses to mate-in-1.
  3. **Otherwise:** softmax over the multipv lines on cp with `temperature = clamp(400 - rating/5, 30, 300)` cp. Mate scores map to ±10000.
- `adjustOpponentRating`:
  - Start at 600.
  - +50 if `userScoreLastFive ≥ 3.5`, −50 if `≤ 1.5`, otherwise unchanged.
  - Clamp to 400–2000.

- [ ] **Step 1: Write failing tests** (seeded rng, e.g. mulberry32):
  - Over 1000 trials at rating 600 on a fixture analysis (best +50, then +20, −10, −200, −600), the best move is chosen 35–80% of the time, and a non-best move is chosen at least 10% of the time.
  - At rating 2000, the best move is chosen at least 85% of the time.
  - In a position where one candidate allows mate-in-1 (fixture), it is never chosen in 1000 trials.
  - With `bookChance: 1` after `['e4','e5','Nf3','Nc6']` with user Black, the opponent always plays a book move.
  - `adjustOpponentRating(600, 4) === 650`, `(400, 0) === 400`, `(600, 2.5) === 600`.
- [ ] **Step 2:** Run `npm test -- selectMove`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npm test -- selectMove`. Expected: PASS.
- [ ] **Step 5:** Commit `feat: human-like opponent move selection`.

### Task 5: Position facts

**Files:**
- Create: `src/coach/facts.ts`
- Test: `tests/coach/facts.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface PieceRef { square: string; piece: 'p'|'n'|'b'|'r'|'q'|'k'; color: Color }
  export interface PositionFacts {
    material: { w: number; b: number };          // p1 n3 b3 r5 q9
    hanging: PieceRef[];                          // attacked and (undefended or attacked by lower value)
    attackedBy(lastMoveUci: string): PieceRef[];  // enemy pieces the last-moved piece now attacks
    forks: { attacker: PieceRef; targets: PieceRef[] }[];  // one piece attacking ≥2 pieces worth ≥3 or king
    inCheck: boolean;
  }
  export function positionFacts(fen: string): PositionFacts;
  export function principleViolations(history: PlayedMove[], color: Color):
    ('early_queen' | 'undeveloped' | 'king_safety' | 'pawn_moves')[];
  export function uciLineToSan(fen: string, uci: string[]): string[];
  ```
- `principleViolations` applies only within the first 12 moves of `color`:
  - `early_queen`: the queen moved before move 5 while two or more minor pieces are undeveloped.
  - `undeveloped`: at move 10 or later, two or more minor pieces are still on their home squares.
  - `king_safety`: at move 10 or later, not castled, the king is on e1/e8, and the e- or d-file is open.
  - `pawn_moves`: four or more pawn moves among the first six moves.

- [ ] **Step 1: Write failing tests** with FEN fixtures:
  - Knight on f6, attacked by a bishop on g5 and undefended, is in `hanging`. The same knight defended by the e7 pawn and attacked by a bishop of equal value is *not* hanging.
  - A queen attacked by a pawn is hanging even if defended.
  - A knight fork on c7 of a king and a rook appears in `forks`.
  - `material` from the start position gives `{w:39, b:39}`.
  - `uciLineToSan(startFen, ['e2e4','e7e5'])` gives `['e4','e5']`.
  - `principleViolations` for White moves `e4 Qh5 Qxf7…` (queen moved at move 2) includes `early_queen`.
- [ ] **Step 2:** Run `npm test -- facts`. Expected: FAIL.
- [ ] **Step 3:** Implement with chess.js `attackers()` and board scanning.
- [ ] **Step 4:** Run `npm test -- facts`. Expected: PASS.
- [ ] **Step 5:** Commit `feat: position facts`.

### Task 6: Mistake classification

**Files:**
- Create: `src/coach/classify.ts`
- Test: `tests/coach/classify.test.ts`

**Interfaces:**
- Consumes: `Analysis`, `PositionFacts`, `principleViolations`, `lookup`.
- Produces:
  ```ts
  export function areaOf(fen: string, plyCount: number, inBook: boolean): Area;
  // opening if inBook or plyCount < 20; endgame if non-pawn material (both sides, excl. kings) ≤ 13; else middlegame
  export interface Verdict {
    flagged: boolean; severity: 'ok' | 'inaccuracy' | 'mistake' | 'blunder';
    cpLoss: number; area: Area; theme: Theme;
    recommendation: 'take_back' | 'play_on';
    bestUci: string; bestSan: string;
    refutationSan: string[];   // engine best line after the user's move, ≤ 4 plies
  }
  export function classifyMove(input: {
    fenBefore: string; move: PlayedMove; before: Analysis; after: Analysis;
    history: PlayedMove[]; level: CoachLevel; plyCount: number; inBook: boolean;
  }): Verdict;
  ```
- `cpLoss` = best eval before − eval after, both from the mover's POV. A mate for the mover counts as +10000, and a mate against as −10000. Cap at 2000.
- Severity:
  - `blunder` if cpLoss ≥ 300, or the move allows mate, or it misses mate-in-≤3.
  - `mistake` if cpLoss ≥ 150.
  - `inaccuracy` if cpLoss ≥ 60.
  - otherwise `ok`.
- `flagged` by level:
  - `full`, `guided`: `mistake` or `blunder`, or an opening principle violation with cpLoss ≥ 60.
  - `light`: `blunder` only.
  - `solo`: never.
- Book moves are never flagged.
- If the eval before the move is already ±800 or more for either side, flag only mate-related blunders.
- Theme priority:
  1. `allowed_mate`
  2. `missed_mate`
  3. `hanging_piece` (the user's piece is hanging after the move)
  4. `ignored_threat` (a piece was hanging before the move and still is)
  5. `missed_fork` (the best move creates a fork)
  6. `missed_pin`
  7. principle themes (`early_queen`, `undeveloped`, `king_safety`)
  8. `bad_trade` (net material loss in the refutation line, with no hanging piece)
  9. `endgame_technique` (area is endgame)
  10. `other`
- Recommendation: `take_back` for `blunder`, or when the theme is `hanging_piece`/`ignored_threat`/`allowed_mate`/`missed_mate`. Otherwise `play_on`.

- [ ] **Step 1: Write failing tests** with synthetic `Analysis` fixtures and real FENs:
  - Leaving a knight en prise (cpLoss 310) gives a flagged blunder, theme `hanging_piece`, `take_back`.
  - cpLoss 160 with no tactic gives a flagged mistake, `play_on`.
  - cpLoss 160 at level `light` is not flagged.
  - cpLoss 40 is `ok` and not flagged.
  - A move allowing mate-in-2 gives `allowed_mate` and `take_back` at every level except `solo`.
  - Eval before is +900 and cpLoss is 200: not flagged.
  - A book move with cpLoss 70 is not flagged.
  - `areaOf(startFen, 0, false) === 'opening'`. A king-and-rook vs king-and-rook position at ply 60 is `endgame`.
  - `refutationSan.length ≤ 4`.
- [ ] **Step 2:** Run `npm test -- classify`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npm test -- classify`. Expected: PASS.
- [ ] **Step 5:** Commit `feat: mistake classification and themes`.

### Task 7: Offline templates

**Files:**
- Create: `src/coach/templates.ts`
- Test: `tests/coach/templates.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface Candidate { san: string; uci: string; note: string; best: boolean }
  export interface Explanation { // shared by templates and Claude
    whatHappened: string;   // pre-move: opponent idea; mistake: what your move allows
    better?: string;        // mistake only: the better move and why
    lesson?: string;        // overall lesson / habit
    candidates?: Candidate[];
  }
  export const THEME_LESSONS: Record<Theme, { title: string; habit: string }>;
  export function preMoveTemplate(ctx: PreMoveContext): Explanation;
  export function mistakeTemplate(ctx: MistakeContext): Explanation;
  export interface PreMoveContext { fen: string; lastMove: PlayedMove; facts: PositionFacts;
    analysis: Analysis; book: BookHit | null; level: CoachLevel }
  export interface MistakeContext { verdict: Verdict; move: PlayedMove; factsAfter: PositionFacts;
    themeCount: number /* times this theme seen before */ }
  ```
- Pre-move candidates:
  - The top 3 engine moves within 150cp of best, converted to SAN.
  - If in book, book replies come first, with their `idea` as the note.
  - Notes are template phrases, such as "captures the knight on e5", "develops your bishop", "defends the pawn on e4", "gives check", or "castles to safety".
- `THEME_LESSONS` habits (exact copy):
  - `hanging_piece`: "After every move — yours and theirs — ask: what is undefended?"
  - `ignored_threat`: "Before you move, look at what their last move attacks."
  - `missed_fork`: "Look for one piece that can attack two things at once."
  - `missed_pin`: "When two of their pieces line up, look for a pin."
  - `missed_mate`: "Always check every check first — it might be mate."
  - `allowed_mate`: "Before you move, ask: can they give a check that I can't answer?"
  - `early_queen`: "Develop knights and bishops before the queen."
  - `undeveloped`: "Get every minor piece out before starting an attack."
  - `king_safety`: "Castle early, and keep the pawns in front of your king."
  - `bad_trade`: "Count what you give and what you get before trading."
  - `endgame_technique`: "In the endgame, activate your king and push passed pawns."
  - `other`: "Compare your move with the alternatives before you play it."
- When `themeCount ≥ 2`, `lesson` is prefixed with `"This keeps coming up (${themeCount + 1} times). "`.

- [ ] **Step 1: Write failing tests:**
  - The hanging-knight verdict fixture gives a `whatHappened` that mentions the refutation's first SAN move and the hanging square. `better` mentions `bestSan`.
  - With `themeCount: 2`, `lesson` starts with "This keeps coming up (3 times)".
  - Pre-move in the Italian book gives candidates where the first is a book move with a non-empty note.
  - Pre-move with no book gives at most 3 candidates, all within 150cp of best, with exactly one `best: true`.
  - Every `THEME_LESSONS` key exists for every `Theme`.
- [ ] **Step 2:** Run `npm test -- templates`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npm test -- templates`. Expected: PASS.
- [ ] **Step 5:** Commit `feat: offline coaching templates`.

### Task 8: Claude explanations

**Files:**
- Create: `src/coach/claude.ts`
- Test: `tests/coach/claude.test.ts`

**Interfaces:**
- Consumes: `Explanation`, `PreMoveContext`, `MistakeContext`, `ProfileSummary` (Task 11 type; define the type in `src/types.ts` here: `{ topThemes: { theme: Theme; count: number }[]; gamesPlayed: number }`).
- Produces:
  ```ts
  export type ModelId = 'claude-sonnet-5-5' | 'claude-opus-5-5' | 'claude-haiku-5-5';
  export interface FactPacket { kind: 'pre_move' | 'mistake'; fen: string; sanHistory: string[];
    allowedMoves: string[]; /* every SAN Claude may mention */ facts: Record<string, unknown>;
    template: Explanation; profile: ProfileSummary }
  export function buildPacket(kind: 'pre_move', ctx: PreMoveContext, t: Explanation, p: ProfileSummary): FactPacket;
  export function buildPacket(kind: 'mistake', ctx: MistakeContext, t: Explanation, p: ProfileSummary): FactPacket;
  export function validateExplanation(e: Explanation, allowed: string[]): boolean;
  export interface ClaudeClientLike { beta: { messages: { parse(req: unknown, opts?: { signal?: AbortSignal }): Promise<any> } } }
  export function explainWithClaude(packet: FactPacket, opts: { client: ClaudeClientLike;
    model: ModelId; signal?: AbortSignal; timeoutMs?: number /* default 15000 */ }): Promise<Explanation | null>;
  export function makeClient(apiKey: string): ClaudeClientLike; // new Anthropic({ apiKey, dangerouslyAllowBrowser: true })
  ```
- The zod schema mirrors `Explanation`. The prompt goes in `system` (static, with `cache_control: {type:'ephemeral'}`) and covers:
  - the role ("patient chess coach for a ~400-rated beginner"),
  - the truth rule ("mention only moves in allowedMoves; never calculate new lines; never contradict the facts"),
  - the style (plain words, name piece and square, at most 3 sentences per field, encouraging but direct),
  - and "use the profile to connect this to recurring habits".
  The packet goes as JSON in the user message.
- Request: `model`, `max_tokens: 2000`, `output_config: { effort: 'low', format: zodOutputFormat(schema) }`. For Sonnet and Opus, add `betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default'`.
- `explainWithClaude` returns `null` when:
  - `stop_reason === 'refusal'`,
  - `parsed_output` is null,
  - `validateExplanation` fails,
  - the call times out or aborts,
  - or the call throws.
  It never throws itself.
- `validateExplanation`: extract SAN-like tokens with `/\b(O-O(-O)?|[KQRBN]?[a-h]?[1-8]?x?[a-h][1-8](=[QRBN])?[+#]?)\b/g` from every string field, then require each (with `+#` stripped) to be in `allowed` (also stripped). Bare squares like "e5" in prose count as squares, not moves: only tokens that start with a piece letter, contain `x`, or are castling are checked.

- [ ] **Step 1: Write failing tests** with a fake `ClaudeClientLike`:
  - A valid parsed output is returned as-is.
  - The request uses model `claude-sonnet-5-5`, `effort: 'low'` and `fallbacks: 'default'`, and has no `temperature`.
  - For `claude-haiku-5-5`, the request has no `fallbacks` and no `betas`.
  - Output mentioning `Qxh7` when it's not in `allowedMoves` gives `null`.
  - Prose "control the e5 square" passes validation.
  - `parsed_output: null` gives `null`. `stop_reason: 'refusal'` gives `null`.
  - A client that rejects with a 401-shaped error gives `null`. A client that never resolves gives `null` after `timeoutMs: 50`.
  - `buildPacket('mistake', …).allowedMoves` includes the user's move, `bestSan` and every refutation SAN.
- [ ] **Step 2:** Run `npm test -- claude`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npm test -- claude`. Expected: PASS.
- [ ] **Step 5:** Commit `feat: claude explanations with truth validation`.

### Task 9: Coach orchestrator

**Files:**
- Create: `src/coach/coach.ts`
- Test: `tests/coach/coach.test.ts`

**Interfaces:**
- Consumes: Tasks 2–8, and `levelFor(area)` plus the profile summary from Task 11 (pass them in as functions; no direct import).
- Produces:
  ```ts
  export type Arrow = { from: string; to: string; color: 'green' | 'red' | 'blue' };
  export interface CoachMessage { id: string; kind: 'pre_move' | 'mistake' | 'consequence' | 'recap' | 'level_change';
    explanation: Explanation; arrows: Arrow[]; source: 'template' | 'claude';
    verdict?: Verdict; blunderCheck?: { prompt: string; answer: string } }
  export interface CoachDeps { engine: Engine; explain: (p: FactPacket) => Promise<Explanation | null>;
    levelFor: (a: Area) => CoachLevel; profile: () => ProfileSummary; themeCount: (t: Theme) => number }
  export class Coach {
    constructor(deps: CoachDeps);
    onUpdate(cb: (m: CoachMessage) => void): void;  // fired when a message upgrades to claude
    preMove(game: GameState): Promise<CoachMessage | null>;              // after opponent's move
    onUserMove(game: GameState, move: PlayedMove): Promise<{ verdict: Verdict; message: CoachMessage | null }>;
    hint(step: 1 | 2 | 3): string;   // after take back: theme habit → piece square → best SAN
    playOn(): void;                  // arm consequence tracker with the refutation
    checkConsequence(game: GameState): CoachMessage | null; // after each ply
    recap(game: GameState, verdicts: Verdict[]): CoachMessage;
    cancelPending(): void;           // on takeback/new game
  }
  ```
- `preMove` by level:
  - `full`: `whatHappened`, candidates and `blunderCheck`.
  - `guided`: `whatHappened` only. Candidates are computed but hidden behind a "show choices" button in the UI.
  - `light` and `solo`: returns `null`.
- `blunderCheck.answer` is derived from `attackedBy(lastMove)` plus `hanging`. Example: "Their bishop now attacks your knight on f6. Nothing else of yours is undefended."
- Every message is returned with `source:'template'` first. `explain` runs in the background; if it returns non-null and the message is still current, `onUpdate` fires with `source:'claude'`. `cancelPending()` makes stale results get dropped.
- Arrows:
  - mistake: red for the first refutation move, green for the best move;
  - pre-move: blue for the opponent's last move, green for the best candidate.
- Consequence tracker: after `playOn()`, if within the next 6 plies the played sequence matches the refutation's opponent moves, or the user loses material equal to the refutation's net gain, it emits one `consequence` message linking back ("Here's where leaving the knight on f6 costs you…"). It then disarms.
- Recap:
  - The most frequent flagged theme of the game, or "no big mistakes".
  - One thing done well: the best user move, meaning the largest positive eval swing, or the longest stretch without a flag.
  - The theme's habit.
  - At most 3 lines.

- [ ] **Step 1: Write failing tests** with a fake engine (fixed analyses) and a fake `explain`:
  - `onUserMove` on a hanging-knight fixture returns a flagged verdict and a template message, then `onUpdate` fires with `source:'claude'`.
  - When `explain` resolves `null`, `onUpdate` never fires and the template message remains.
  - When `explain` rejects, `onUserMove` still resolves and nothing throws.
  - `cancelPending()` before `explain` resolves means `onUpdate` never fires.
  - `preMove` at level `light` gives `null`. At level `full`, `blunderCheck` is present.
  - `hint(1)` contains the theme habit, `hint(2)` contains the piece's square, and `hint(3)` contains `bestSan`.
  - Consequence: after `playOn()`, playing the refutation moves emits exactly one consequence message, and a second check emits none.
  - `onUserMove` on a game where `result() !== null` resolves with `flagged:false` and makes no engine call.
  - The recap has at most 3 lines.
- [ ] **Step 2:** Run `npm test -- coach.test`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npm test -- coach.test`. Expected: PASS.
- [ ] **Step 5:** Commit `feat: coach orchestrator`.

### Task 10: Storage

**Files:**
- Create: `src/storage/db.ts`
- Test: `tests/storage/db.test.ts` (uses `fake-indexeddb/auto`)

**Interfaces:**
- Produces:
  ```ts
  export interface Settings { apiKey: string; model: ModelId; levelOverride: Partial<Record<Area, CoachLevel>>;
    clockMinutes: number | null; opponentRating: number }
  export const DEFAULT_SETTINGS: Settings; // apiKey '', model 'claude-sonnet-5-5', {}, null, 600
  export interface SavedGame { id: string; startedAt: number; userColor: Color; moves: string[];
    verdicts: Verdict[]; result: GameResult | null }
  export interface Db {
    getSettings(): Promise<Settings>; saveSettings(s: Settings): Promise<void>;
    saveGame(g: SavedGame): Promise<void>; getGame(id: string): Promise<SavedGame | undefined>;
    listGames(): Promise<SavedGame[]>; currentGameId(): Promise<string | null>; setCurrentGame(id: string | null): Promise<void>;
    getProfile(): Promise<ProfileData>; saveProfile(p: ProfileData): Promise<void>;
    exportAll(): Promise<string>;                    // JSON {app:'chess-coach', version:1, ...}; apiKey excluded
    importAll(json: string): Promise<void>;          // validates with zod; throws ImportError, leaves data untouched
  }
  export function openDb(name?: string): Promise<Db>;
  ```
- `ProfileData` is defined in Task 11. Declare the type in `src/types.ts` here: `{ themes: Record<Theme, ThemeStat>; moves: Record<Area, MoveRecord[]>; levels: Record<Area, CoachLevel> }`, with `ThemeStat = { count: number; lastSeen: number; examples: { gameId: string; ply: number; fen: string }[] }` and `MoveRecord = { good: boolean; flagged: boolean; at: number }`.
- The game in progress is saved after every ply.

- [ ] **Step 1: Write failing tests:**
  - Settings round-trip. A fresh database returns `DEFAULT_SETTINGS`.
  - `saveGame`, `setCurrentGame`, then reopening the database gives back the same game moves from `currentGameId()`.
  - `exportAll` then `importAll` into a fresh database gives the same games and profile. The export does not contain the apiKey string.
  - `importAll('{"foo":1}')` and `importAll('not json')` both throw `ImportError`, and the existing games are unchanged.
- [ ] **Step 2:** Run `npm test -- db`. Expected: FAIL.
- [ ] **Step 3:** Implement with `idb`, using one transaction per import (clear and write together).
- [ ] **Step 4:** Run `npm test -- db`. Expected: PASS.
- [ ] **Step 5:** Commit `feat: local storage with backup`.

### Task 11: Learner profile and weaning

**Files:**
- Create: `src/profile/profile.ts`, `src/profile/weaning.ts`
- Test: `tests/profile/profile.test.ts`, `tests/profile/weaning.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // profile.ts
  export function emptyProfile(): ProfileData; // levels: opening full, middlegame full, endgame light
  export function recordMove(p: ProfileData, v: Verdict, ctx: { gameId: string; ply: number; fen: string; at: number }): ProfileData;
  // good = !flagged && cpLoss < 50; flagged moves add a theme example (keep the 10 newest)
  export function summary(p: ProfileData): ProfileSummary;   // top 3 themes by count in last 30 days
  export function levelFor(p: ProfileData, s: Settings, a: Area): CoachLevel; // override wins
  // weaning.ts
  export const ORDER: CoachLevel[]; // ['full','guided','light','solo']
  export function reviewLevels(p: ProfileData): { profile: ProfileData; changes: { area: Area; from: CoachLevel; to: CoachLevel }[] };
  export function levelChangeText(c: { area: Area; from: CoachLevel; to: CoachLevel }): string;
  export function suggestClock(p: ProfileData): boolean; // true when no area is 'full'
  ```
- `reviewLevels` runs between games only. Per area:
  - **Step down** one level when the last 40 records have `good` ≥ 80% and no level change happened in that area in the last 40 records.
  - **Step up** one level when 25% or more of the last 20 records are flagged.
  - Never step past `solo` or `full`.
  - Track the last change with a marker in `moves`, or a `levelChangedAt` map in `ProfileData`; the implementer picks.
- Level-change copy, for example: "You've been spotting threats well in the middlegame. I'll stop showing your choices there — tap the coach if you want them." A step up reads: "A few more slips lately in the opening — I'll show your choices again for a while."

- [ ] **Step 1: Write failing tests:**
  - `emptyProfile().levels` equals `{opening:'full', middlegame:'full', endgame:'light'}`.
  - 40 good middlegame records step middlegame from `full` to `guided`. Running `reviewLevels` again right away gives no change.
  - 5 flagged out of the last 20 opening records step `guided` up to `full`.
  - 39 records give no change.
  - `levelFor` with `levelOverride.endgame = 'solo'` returns `solo`.
  - `recordMove` keeps at most 10 examples per theme.
  - `summary` orders themes by count.
  - `suggestClock` is false initially and true when all areas are at `guided` or below.
- [ ] **Step 2:** Run `npm test -- profile weaning`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npm test -- profile weaning`. Expected: PASS.
- [ ] **Step 5:** Commit `feat: learner profile and weaning`.

### Task 12: Game screen and UI

**Files:**
- Create: `src/ui/App.tsx`, `src/ui/GameScreen.tsx`, `src/ui/CoachPanel.tsx`, `src/ui/MistakeCard.tsx`, `src/ui/PromotionPicker.tsx`, `src/ui/RecapCard.tsx`, `src/ui/SettingsScreen.tsx`, `src/ui/PatternsScreen.tsx`, `src/ui/styles.css`
- Test: `tests/ui/MistakeCard.test.tsx`, `tests/ui/GameScreen.test.tsx`, `e2e/smoke.spec.ts`

**Interfaces:**
- Consumes everything above. `App` owns the `Db`, `Engine`, `Coach`, profile and settings. Navigation is tab-like between Play, My patterns and Settings, using simple state with no router.
- **Game flow:**
  1. New game: choose a colour (White, Black or Random).
  2. Opponent turn:
     - lock input;
     - `engine.analyse` at depth 10, multipv 5;
     - `selectOpponentMove`;
     - `play`, then save;
     - `coach.checkConsequence`;
     - `coach.preMove`;
     - unlock.
  3. User turn: on drop, if `needsPromotion`, show `PromotionPicker` (Q/R/B/N). Then `play`, save and `coach.onUserMove`.
     - If the verdict is flagged, pause by showing `MistakeCard`, which has the sections "Better move", "What it costs", "The lesson", the recommendation badge, and the buttons **Take it back** / **Play on**.
       - Take back: `takeBackUserMove()`, `cancelPending()`, and a hint ladder with three buttons.
       - Play on: `coach.playOn()`, and the opponent moves.
     - If not flagged, the opponent moves.
     - `recordMove` into the profile for every user move. Book moves count as good.
  4. Game end: `RecapCard`, then `reviewLevels`, show level-change messages, `adjustOpponentRating`, and save. If `suggestClock` and the clock is off, show a one-line suggestion with a "Turn on 15-minute clock" button.
- `CoachPanel` is collapsible. It shows the latest message, candidates (hidden behind "Show choices" at `guided`), a blunder-check reveal button, and a small "coach offline" dot when the last explanation came from a template because Claude failed or no key is set.
- The board shows arrows from `CoachMessage.arrows`. Board size is `min(100vw - 16px, 60vh)`.
- **Clock (when on):** minutes per side, shown above and below the board. On timeout, `result` is `{reason:'timeout'}`. The clock pauses while `MistakeCard` is open.
- **Settings:**
  - API key (a password field) with a "Test key" button that makes a 1-token call;
  - model select (Sonnet 5.5 default, Opus 5.5, Haiku 5.5) with the per-game cost hints from the spec;
  - per-area level overrides with an "Auto" option;
  - clock minutes (Off, 10, 15, 30);
  - Export and Import backup.
- **My patterns:** the top themes, each with its title, habit and count, plus a list of example positions. Tapping one shows that position on a static board with the stored FEN.
- On load, `currentGameId()` resumes an unfinished game.

- [ ] **Step 1: Write failing component tests:**
  - `MistakeCard` renders "Better move", "What it costs" and "The lesson". Clicking "Take it back" calls `onTakeBack`, and "Play on" calls `onPlayOn`. The recommended button has `aria-describedby` pointing at the recommendation text.
  - `GameScreen` with fake engine and coach: on a promotion move, `PromotionPicker` appears and choosing N plays `…n`. While the opponent is thinking, a board drop is ignored. After checkmate, `RecapCard` shows and the board is not draggable.
- [ ] **Step 2:** Run `npm test -- ui`. Expected: FAIL.
- [ ] **Step 3:** Implement the components and wire `App`.
- [ ] **Step 4:** Run `npm test -- ui`. Expected: PASS.
- [ ] **Step 5: Write `e2e/smoke.spec.ts`** (Playwright, viewport 360×740, real Stockfish, `npm run build && npx vite preview`, no API key):
  - Start a game as White and play `e2e4`. The opponent replies within 10s, and the coach panel shows pre-move text.
  - Play a hanging move scripted from a known reply, for example `Ba6` as White when it's attacked. `MistakeCard` appears, and "Take it back" restores the previous FEN.
  - Reload the page: the game resumes with the same move list.
  - `document.documentElement.scrollWidth <= 360`.
  - Run: `npx playwright test --trace off`. Expected: all pass.
- [ ] **Step 6:** Take a screenshot at deviceScaleFactor 1, check the layout by eye, and fix any problems.
- [ ] **Step 7:** Commit `feat: game screen, coaching UI, settings and patterns`.

### Task 13: PWA, offline and deploy

**Files:**
- Modify: `vite.config.ts` (vite-plugin-pwa: manifest name "Chess Coach", standalone display, portrait, icons; precache including `stockfish/*.wasm`; `base: '/Chess-App/'` for Pages)
- Create: `public/icons/*` (simple generated knight icon, 192 and 512 PNG), `.github/workflows/deploy.yml`
- Test: `e2e/offline.spec.ts`

**Interfaces:**
- Consumes: the built app.

- [ ] **Step 1: Write `e2e/offline.spec.ts`:** load the preview once, wait for the service worker to activate, set `context.setOffline(true)`, and reload. The board renders, a move gets an opponent reply, and the coach shows template text with the offline dot.
- [ ] **Step 2:** Run `npx playwright test e2e/offline.spec.ts --trace off`. Expected: FAIL (no service worker yet).
- [ ] **Step 3:** Configure the PWA plugin and icons. Write `deploy.yml`: on push to `main`, run `npm ci`, `npm test`, `npm run build`, then `actions/upload-pages-artifact` and `actions/deploy-pages`.
- [ ] **Step 4:** Run `npm test && npx playwright test --trace off`. Expected: all pass. Then run `npm run build`; the Lighthouse-style manifest check must pass (manifest has name, icons and `start_url`).
- [ ] **Step 5:** Commit `feat: installable offline PWA and Pages deploy`.
- [ ] **Step 6:** Report to the user: the Pages URL needs Pages enabled in the repo settings ("GitHub Actions" source). If the repo is private and the plan doesn't allow Pages, propose Cloudflare Pages or Netlify instead. Include install steps for Android (open the URL in Chrome, then ⋮ → Add to Home screen) and where to paste the API key.
