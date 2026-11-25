import type { Analysis, EngineLine } from '../types';
import { parseInfo } from './uci';

export interface Engine {
  analyse(fen: string, opts: { multipv: number; depth: number }): Promise<Analysis>;
  stop(): void;
  /** True while a search is queued or running (stop() is only needed then). */
  busy(): boolean;
}

const DEFAULT_WORKER = `${import.meta.env.BASE_URL}stockfish/stockfish-19-lite-single.js`;

const INIT_TIMEOUT_MS = 15000;

export function createEngine(workerUrl: string = DEFAULT_WORKER): Engine {
  let worker: Worker | null = null;
  let ready: Promise<Worker> | null = null;
  let queue: Promise<unknown> = Promise.resolve();
  let generation = 0;
  const pending = new Set<(e: Error) => void>();

  // Resolves with the first message line satisfying `match`; rejects on worker error or timeout.
  const waitFor = (w: Worker, match: (l: string) => boolean, timeoutMs = INIT_TIMEOUT_MS): Promise<void> =>
    new Promise((resolve, reject) => {
      const done = () => {
        clearTimeout(timer);
        w.removeEventListener('message', on);
        w.removeEventListener('error', onError);
      };
      const on = (e: MessageEvent) => {
        if (match(String(e.data))) { done(); resolve(); }
      };
      const onError = () => { done(); reject(new Error('engine worker error')); };
      const timer = setTimeout(() => { done(); reject(new Error('engine start timed out')); }, timeoutMs);
      w.addEventListener('message', on);
      w.addEventListener('error', onError);
    });

  const discardWorker = () => {
    worker?.terminate();
    worker = null;
    ready = null;
  };

  const start = (): Promise<Worker> => {
    if (!ready) {
      const w = new Worker(workerUrl);
      worker = w;
      const p = (async () => {
        const uciok = waitFor(w, (l) => l === 'uciok');
        w.postMessage('uci');
        await uciok;
        const readyok = waitFor(w, (l) => l === 'readyok');
        w.postMessage('isready');
        await readyok;
        return w;
      })();
      ready = p;
      p.catch(() => { if (ready === p) discardWorker(); }); // next analyse retries
    }
    return ready;
  };

  const run = async (fen: string, opts: { multipv: number; depth: number }, gen: number): Promise<Analysis> => {
    const w = await start();
    if (gen !== generation) throw new Error('engine stopped');
    return new Promise<Analysis>((resolve, reject) => {
      const best = new Map<number, { depth: number; line: EngineLine }>();
      const cleanup = () => {
        w.removeEventListener('message', on);
        w.removeEventListener('error', onError);
      };
      const onError = () => {
        cleanup();
        if (worker === w) discardWorker();
        reject(new Error('engine worker error'));
      };
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
      w.addEventListener('error', onError);
      w.postMessage(`setoption name MultiPV value ${opts.multipv}`);
      w.postMessage(`position fen ${fen}`);
      w.postMessage(`go depth ${opts.depth}`);
    });
  };

  return {
    analyse(fen, opts) {
      const gen = generation;
      let rejectOuter!: (e: Error) => void;
      const outer = new Promise<Analysis>((resolve, reject) => {
        rejectOuter = reject;
        pending.add(reject);
        queue
          .then(() => {
            if (gen !== generation) throw new Error('engine stopped');
            return run(fen, opts, gen);
          })
          .then(resolve, reject);
      });
      // Chain on the outer promise so stop() (which rejects it) also unblocks the queue.
      const done = () => { pending.delete(rejectOuter); };
      queue = outer.then(done, done);
      return outer;
    },
    busy() {
      return pending.size > 0;
    },
    stop() {
      // Terminate rather than send `stop`: a late `bestmove` from the aborted search
      // would otherwise be mistaken for the next search's result.
      generation++;
      discardWorker();
      const rejects = [...pending];
      pending.clear();
      for (const reject of rejects) reject(new Error('engine stopped'));
    },
  };
}
