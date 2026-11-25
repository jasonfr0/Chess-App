import type { Analysis, EngineLine } from '../types';
import { parseInfo } from './uci';

export interface Engine {
  analyse(fen: string, opts: { multipv: number; depth: number }): Promise<Analysis>;
  stop(): void;
}

const DEFAULT_WORKER = `${import.meta.env.BASE_URL}stockfish/stockfish-19-lite-single.js`;

export function createEngine(workerUrl: string = DEFAULT_WORKER): Engine {
  let worker: Worker | null = null;
  let ready: Promise<Worker> | null = null;
  let queue: Promise<unknown> = Promise.resolve();
  let cancelPending: (() => void) | null = null;

  // Resolves with the first message line satisfying `match`.
  const waitFor = (w: Worker, match: (l: string) => boolean): Promise<void> =>
    new Promise((resolve) => {
      const on = (e: MessageEvent) => {
        if (match(String(e.data))) { w.removeEventListener('message', on); resolve(); }
      };
      w.addEventListener('message', on);
    });

  const start = (): Promise<Worker> => {
    if (!ready) {
      const w = new Worker(workerUrl);
      worker = w;
      ready = (async () => {
        const uciok = waitFor(w, (l) => l === 'uciok');
        w.postMessage('uci');
        await uciok;
        const readyok = waitFor(w, (l) => l === 'readyok');
        w.postMessage('isready');
        await readyok;
        return w;
      })();
    }
    return ready;
  };

  const run = async (fen: string, opts: { multipv: number; depth: number }): Promise<Analysis> => {
    const w = await start();
    return new Promise<Analysis>((resolve, reject) => {
      const best = new Map<number, { depth: number; line: EngineLine }>();
      const cleanup = () => { w.removeEventListener('message', on); cancelPending = null; };
      const on = (e: MessageEvent) => {
        const text = String(e.data);
        const info = parseInfo(text);
        if (info) {
          const prev = best.get(info.multipv);
          if (!prev || info.depth >= prev.depth) best.set(info.multipv, { depth: info.depth, line: info.line });
          return;
        }
        if (text.startsWith('bestmove')) {
          cleanup();
          const entries = [...best.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
          resolve({
            fen,
            depth: entries.reduce((d, v) => Math.max(d, v.depth), 0),
            lines: entries.map((v) => v.line),
          });
        }
      };
      w.addEventListener('message', on);
      cancelPending = () => { cleanup(); reject(new Error('engine stopped')); };
      w.postMessage(`setoption name MultiPV value ${opts.multipv}`);
      w.postMessage(`position fen ${fen}`);
      w.postMessage(`go depth ${opts.depth}`);
    });
  };

  return {
    analyse(fen, opts) {
      const result = queue.then(() => run(fen, opts));
      queue = result.catch(() => undefined);
      return result;
    },
    stop() {
      // Terminate rather than send `stop`: a late `bestmove` from the aborted search
      // would otherwise be mistaken for the next search's result.
      const cancel = cancelPending;
      worker?.terminate();
      worker = null;
      ready = null;
      cancel?.();
    },
  };
}
