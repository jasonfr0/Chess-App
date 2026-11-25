import type { EngineLine } from '../types';

export function parseInfo(line: string): { multipv: number; depth: number; line: EngineLine } | null {
  const t = line.trim().split(/\s+/);
  if (t[0] !== 'info') return null;
  const pvAt = t.indexOf('pv');
  const scoreAt = t.indexOf('score');
  const depthAt = t.indexOf('depth');
  if (pvAt < 0 || pvAt === t.length - 1 || scoreAt < 0 || depthAt < 0) return null;
  if (t.includes('lowerbound') || t.includes('upperbound')) return null;
  const kind = t[scoreAt + 1];
  const value = Number(t[scoreAt + 2]);
  if ((kind !== 'cp' && kind !== 'mate') || !Number.isFinite(value)) return null;
  const mpAt = t.indexOf('multipv');
  return {
    multipv: mpAt >= 0 ? Number(t[mpAt + 1]) : 1,
    depth: Number(t[depthAt + 1]),
    line: {
      uci: t.slice(pvAt + 1),
      cp: kind === 'cp' ? value : null,
      mate: kind === 'mate' ? value : null,
    },
  };
}

export function parseBestMove(line: string): string | null {
  const t = line.trim().split(/\s+/);
  if (t[0] !== 'bestmove' || !t[1] || t[1] === '(none)') return null;
  return t[1];
}
