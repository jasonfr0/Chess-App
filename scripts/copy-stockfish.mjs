// Copies the single-threaded lite Stockfish build (js + wasm, same basename) and its GPLv3 licence
// (Copying.txt) into public/stockfish/, so the licence ships alongside the engine.
import { cpSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'node_modules', 'stockfish', 'bin');
const dest = join(root, 'public', 'stockfish');
mkdirSync(dest, { recursive: true });
for (const f of ['stockfish-19-lite-single.js', 'stockfish-19-lite-single.wasm']) {
  cpSync(join(src, f), join(dest, f));
}
cpSync(join(root, 'node_modules', 'stockfish', 'Copying.txt'), join(dest, 'Copying.txt'));
