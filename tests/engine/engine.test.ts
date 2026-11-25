import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createEngine } from '../../src/engine/engine';

type Listener = (e: { data?: unknown }) => void;

class FakeWorker {
  static instances: FakeWorker[] = [];
  static autoRespond = true;
  listeners: Record<string, Set<Listener>> = { message: new Set(), error: new Set() };
  sent: string[] = [];
  terminated = false;
  constructor(public url: string) { FakeWorker.instances.push(this); }
  addEventListener(t: string, l: Listener) { this.listeners[t].add(l); }
  removeEventListener(t: string, l: Listener) { this.listeners[t].delete(l); }
  emit(data: string) { for (const l of [...this.listeners.message]) l({ data }); }
  fail() { for (const l of [...this.listeners.error]) l({}); }
  terminate() { this.terminated = true; }
  postMessage(msg: string) {
    this.sent.push(msg);
    if (this.terminated || !FakeWorker.autoRespond) return;
    queueMicrotask(() => {
      if (this.terminated) return;
      if (msg === 'uci') this.emit('uciok');
      else if (msg === 'isready') this.emit('readyok');
      else if (msg.startsWith('go depth')) {
        const fen = this.sent.find((m) => m.startsWith('position fen '))!.slice(13);
        this.emit(`info depth 1 multipv 1 score cp 5 pv a2a3`);
        this.emit(`info depth 2 multipv 1 score cp 10 pv ${fen === 'B' ? 'b2b3' : 'e2e4'} e7e5`);
        this.emit('bestmove e2e4');
      }
    });
  }
}

beforeEach(() => {
  FakeWorker.instances = [];
  FakeWorker.autoRespond = true;
  vi.stubGlobal('Worker', FakeWorker);
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('createEngine', () => {
  it('returns deepest line per multipv', async () => {
    const e = createEngine('x.js');
    const a = await e.analyse('A', { multipv: 1, depth: 2 });
    expect(a).toEqual({ fen: 'A', depth: 2, lines: [{ uci: ['e2e4', 'e7e5'], cp: 10, mate: null }] });
    expect(FakeWorker.instances[0].sent).toContain('setoption name MultiPV value 1');
  });

  it('serialises calls and resolves in order', async () => {
    const e = createEngine('x.js');
    const order: string[] = [];
    const p = ['A', 'B', 'C'].map((f) => e.analyse(f, { multipv: 1, depth: 1 }).then(() => order.push(f)));
    await Promise.all(p);
    expect(order).toEqual(['A', 'B', 'C']);
    expect(FakeWorker.instances).toHaveLength(1);
  });

  it('stop() during init rejects and a later analyse still works', async () => {
    FakeWorker.autoRespond = false;
    const e = createEngine('x.js');
    const p1 = e.analyse('A', { multipv: 1, depth: 1 });
    const p2 = e.analyse('B', { multipv: 1, depth: 1 }); // queued
    const r1 = expect(p1).rejects.toThrow('stopped');
    const r2 = expect(p2).rejects.toThrow('stopped');
    await new Promise((r) => setTimeout(r, 0)); // let the worker start initialising
    e.stop();
    await r1; await r2;
    expect(FakeWorker.instances[0].terminated).toBe(true);
    FakeWorker.autoRespond = true;
    const a = await e.analyse('A', { multipv: 1, depth: 1 });
    expect(a.lines).toHaveLength(1);
    expect(FakeWorker.instances).toHaveLength(2);
  });

  it('busy() is true only while a search is queued or running', async () => {
    const e = createEngine('x.js');
    expect(e.busy()).toBe(false);
    const p = e.analyse('A', { multipv: 1, depth: 1 });
    expect(e.busy()).toBe(true);
    await p;
    expect(e.busy()).toBe(false);
    FakeWorker.autoRespond = false;
    const q = e.analyse('B', { multipv: 1, depth: 1 });
    const r = expect(q).rejects.toThrow('stopped');
    expect(e.busy()).toBe(true);
    e.stop();
    await r;
    expect(e.busy()).toBe(false);
  });

  it('stop() during a search rejects the pending call', async () => {
    const e = createEngine('x.js');
    await e.analyse('A', { multipv: 1, depth: 1 });
    FakeWorker.autoRespond = false;
    const p = e.analyse('B', { multipv: 1, depth: 1 });
    await new Promise((r) => setTimeout(r, 0));
    const r = expect(p).rejects.toThrow('stopped');
    e.stop();
    await r;
  });

  it('worker error rejects and the next analyse retries with a new worker', async () => {
    FakeWorker.autoRespond = false;
    const e = createEngine('x.js');
    const p = e.analyse('A', { multipv: 1, depth: 1 });
    const r = expect(p).rejects.toThrow('worker error');
    await new Promise((r) => setTimeout(r, 0));
    FakeWorker.instances[0].fail();
    await r;
    FakeWorker.autoRespond = true;
    await e.analyse('A', { multipv: 1, depth: 1 });
    expect(FakeWorker.instances).toHaveLength(2);
  });

  it('startup timeout rejects', async () => {
    vi.useFakeTimers();
    FakeWorker.autoRespond = false;
    const e = createEngine('x.js');
    const r = expect(e.analyse('A', { multipv: 1, depth: 1 })).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(16000);
    await r;
  });
});
