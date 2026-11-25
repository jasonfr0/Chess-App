import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '..', '..');

describe('copy-stockfish', () => {
  it('ships Stockfish with its GPLv3 licence text', () => {
    execFileSync(process.execPath, [join(root, 'scripts', 'copy-stockfish.mjs')]);
    const dest = join(root, 'public', 'stockfish');
    for (const f of ['stockfish-19-lite-single.js', 'stockfish-19-lite-single.wasm', 'Copying.txt']) {
      expect(existsSync(join(dest, f))).toBe(true);
    }
    expect(readFileSync(join(dest, 'Copying.txt'), 'utf8')).toMatch(/GNU GENERAL PUBLIC LICENSE/);
  });
});
