// Dev check: runs Node Stockfish over every book move the user is taught to play
// (White's moves in the white tree, Black's in the black tree) and prints any that
// leaves the user worse than -60cp. Opponent moves are skipped: they are in the
// tree because the user will meet them, and some sound ones (1.e4 d5) score below
// -60 at this depth. Run: npx tsx scripts/check-repertoire.ts
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { Chess } from 'chess.js';
import { parseInfo } from '../src/engine/uci';
import type { EngineLine } from '../src/types';
import data from '../src/openings/repertoire.json';
import type { RepertoireNode } from '../src/openings/repertoire';

const DEPTH = 12;
const THRESHOLD = -60;
const enginePath = fileURLToPath(new URL('../node_modules/stockfish/bin/stockfish-19-lite-single.js', import.meta.url));

const engine = spawn(process.execPath, [enginePath], { stdio: ['pipe', 'pipe', 'inherit'] });
const lines = createInterface({ input: engine.stdout });
let waiter: ((line: string) => void) | null = null;
lines.on('line', (line) => waiter?.(line));

function send(cmd: string): void { engine.stdin.write(cmd + '\n'); }

function until<T>(onLine: (line: string) => T | undefined): Promise<T> {
  return new Promise((resolve) => {
    waiter = (line) => {
      const done = onLine(line);
      if (done !== undefined) { waiter = null; resolve(done); }
    };
  });
}

/** Score in centipawns from the side-to-move's point of view (mate mapped to ±100000). */
async function evaluate(uciMoves: string[]): Promise<number> {
  let best: EngineLine | null = null;
  send(`position startpos moves ${uciMoves.join(' ')}`);
  send(`go depth ${DEPTH}`);
  await until((line) => {
    const info = parseInfo(line);
    if (info && info.multipv === 1) best = info.line;
    return line.startsWith('bestmove') ? true : undefined;
  });
  const line = best as EngineLine | null;
  if (!line) throw new Error(`no score for: ${uciMoves.join(' ')}`);
  if (line.mate !== null) return line.mate > 0 ? 100000 : -100000;
  return line.cp ?? 0;
}

async function check(side: 'white' | 'black', nodes: RepertoireNode[], sans: string[], ucis: string[]): Promise<number> {
  let bad = 0;
  for (const node of nodes) {
    const chess = new Chess();
    for (const san of sans) chess.move(san);
    const move = chess.move(node.san);
    const nextSans = [...sans, node.san];
    const nextUcis = [...ucis, move.from + move.to + (move.promotion ?? '')];
    if (move.color === side[0]) {
      // The engine scores for the side to move now, i.e. the opponent of whoever played node.san.
      const forMover = -(await evaluate(nextUcis));
      if (forMover < THRESHOLD) {
        console.log(`[${side}] ${nextSans.join(' ')}: ${forMover}cp for ${side}`);
        bad++;
      }
    }
    bad += await check(side, node.children, nextSans, nextUcis);
  }
  return bad;
}

send('uci');
await until((line) => (line === 'uciok' ? true : undefined));
send('isready');
await until((line) => (line === 'readyok' ? true : undefined));
const bad = (await check('white', data.white, [], [])) + (await check('black', data.black, [], []));
send('quit');
engine.stdin.end();
process.exitCode = bad > 0 ? 1 : 0;
