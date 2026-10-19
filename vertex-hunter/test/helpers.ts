// SYNTHETIC candle generator shared by tests. Not market data.
import type { Candle, ContractInfo } from '../src/mexc/types.ts';

export const NOW_MS = 1_800_000_150_000; // 150s into a 5m bar (1_800_000_000 is a multiple of 300)
export const NOW_S = NOW_MS / 1000;

function lcg(seed: number) {
  let s = seed;
  return () => { s = (s * 1664525 + 1013904223) & 0x7fffffff; return s / 0x7fffffff; };
}

export interface Shape { surge?: 'up' | 'down' | 'none'; noise?: number; lateRunPct?: number }

/** Build 5m candles ending with a forming bar at NOW_S-150. */
export function build5m(shape: Shape = {}): Candle[] {
  const rnd = lcg(42);
  const n = 130;
  const out: Candle[] = [];
  let p = 100;
  const noise = shape.noise ?? 0.0006;
  for (let i = 0; i < n; i++) {
    const t = NOW_S - 150 - (n - 1 - i) * 300;
    const idxFromEnd = n - 1 - i; // 0 = forming
    const compression = idxFromEnd > 3 && idxFromEnd < 40 ? 0.5 : 1; // compressed range before the move
    const o = p;
    let c = o * (1 + (rnd() - 0.5) * noise * 2 * compression);
    let v = 1000 * (0.9 + rnd() * 0.2);
    if (shape.lateRunPct && idxFromEnd >= 1 && idxFromEnd <= 12) c = o * (1 + shape.lateRunPct / 100 / 12);
    if (shape.surge === 'up' && idxFromEnd === 1) { c = o * 1.012; v = 6000; }
    if (shape.surge === 'up' && idxFromEnd === 0) { c = o * 1.003; v = 3500; }
    if (shape.surge === 'down' && idxFromEnd === 1) { c = o * 0.988; v = 6000; }
    if (shape.surge === 'down' && idxFromEnd === 0) { c = o * 0.997; v = 3500; }
    const h = Math.max(o, c) * (1 + 0.0002);
    const l = Math.min(o, c) * (1 - 0.0002);
    out.push({ t, o, h, l, c, v });
    p = c;
  }
  return out;
}

export function aggregate(c5: Candle[], per: number, sec: number): Candle[] {
  const m = new Map<number, Candle>();
  for (const c of c5) {
    const t = Math.floor(c.t / sec) * sec;
    const a = m.get(t);
    if (!a) m.set(t, { ...c, t });
    else { a.h = Math.max(a.h, c.h); a.l = Math.min(a.l, c.l); a.c = c.c; a.v += c.v; }
  }
  return [...m.values()].sort((a, b) => a.t - b.t);
}

export const contract: ContractInfo = {
  symbol: 'SYN_USDT', contractSize: 1, volUnit: 1, minVol: 1, maxVol: 1e9, priceUnit: 0.0001, takerFeeRate: 0.0002, makerFeeRate: 0,
  maxLeverage: 20, maintenanceMarginRate: 0.005, baseCoin: 'SYN', quoteCoin: 'USDT', settleCoin: 'USDT', state: 0, futureType: 1, isNew: false,
};

