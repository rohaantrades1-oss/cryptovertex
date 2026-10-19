// Pure indicator helpers over arrays of candles / numbers. No I/O.
import type { Candle } from '../mexc/types.ts';

export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

export function median(xs: number[]): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Robust z-score of `x` against a baseline sample using median/MAD (MAD floored to 25% of median so quiet markets don't explode). */
export function robustZ(x: number, baseline: number[]): number {
  const med = median(baseline);
  if (!(med >= 0)) return NaN;
  const mad = median(baseline.map((b) => Math.abs(b - med)));
  const scale = Math.max(1.4826 * mad, 0.25 * med, 1e-12);
  return (x - med) / scale;
}

/** True range of candle i using previous close. */
function tr(c: Candle, prevClose: number | undefined): number {
  const hl = c.h - c.l;
  if (prevClose === undefined) return hl;
  return Math.max(hl, Math.abs(c.h - prevClose), Math.abs(c.l - prevClose));
}

/** Simple-average ATR over the last n candles (needs n+1 candles for a full window). */
export function atr(candles: Candle[], n: number): number | undefined {
  if (candles.length < n + 1) return undefined;
  let sum = 0;
  for (let i = candles.length - n; i < candles.length; i++) sum += tr(candles[i], candles[i - 1].c);
  return sum / n;
}

/** ATR as a fraction of price. */
export function atrPct(candles: Candle[], n: number): number | undefined {
  const a = atr(candles, n);
  const last = candles[candles.length - 1];
  return a === undefined || !last ? undefined : a / last.c;
}

/** Return (fraction) from close `n` candles ago to the latest close. */
export function retOverBars(candles: Candle[], n: number): number | undefined {
  if (candles.length < n + 1) return undefined;
  const a = candles[candles.length - 1 - n].c;
  const b = candles[candles.length - 1].c;
  return (b - a) / a;
}

/** Return over bars [-2n, -n] -> previous window of n bars (for acceleration). */
export function retPrevWindow(candles: Candle[], n: number): number | undefined {
  if (candles.length < 2 * n + 1) return undefined;
  const a = candles[candles.length - 1 - 2 * n].c;
  const b = candles[candles.length - 1 - n].c;
  return (b - a) / a;
}

export function highest(candles: Candle[], n: number, skipLast = 0): number | undefined {
  const end = candles.length - skipLast;
  if (end - n < 0 || n <= 0) return undefined;
  let m = -Infinity;
  for (let i = end - n; i < end; i++) m = Math.max(m, candles[i].h);
  return m;
}

export function lowest(candles: Candle[], n: number, skipLast = 0): number | undefined {
  const end = candles.length - skipLast;
  if (end - n < 0 || n <= 0) return undefined;
  let m = Infinity;
  for (let i = end - n; i < end; i++) m = Math.min(m, candles[i].l);
  return m;
}

/** Range width (high-low)/close over a window ending `skipLast` bars before the end. */
export function rangeWidth(candles: Candle[], n: number, skipLast = 0): number | undefined {
  const h = highest(candles, n, skipLast);
  const l = lowest(candles, n, skipLast);
  if (h === undefined || l === undefined) return undefined;
  const ref = candles[candles.length - 1 - skipLast].c;
  return (h - l) / ref;
}

/** Percentile rank (0..1) of `value` within `sample`. */
export function percentileRank(value: number, sample: number[]): number {
  if (!sample.length) return NaN;
  let below = 0;
  for (const s of sample) if (s < value) below++;
  return below / sample.length;
}

/** Was volatility compressed `lag` bars ago? Compares that 20-bar range width with its trailing history. */
export function wasCompressed(candles: Candle[], lag: number, window = 20, history = 60): boolean | undefined {
  if (candles.length < window + lag + history) return undefined;
  const now = rangeWidth(candles, window, lag);
  if (now === undefined) return undefined;
  const sample: number[] = [];
  for (let k = lag + 1; k <= lag + history; k += 3) {
    const w = rangeWidth(candles, window, k);
    if (w !== undefined) sample.push(w);
  }
  if (sample.length < 8) return undefined;
  return percentileRank(now, sample) <= 0.3;
}

/** Upper/lower wick share of the candle's total range. */
export function wickShares(c: Candle): { upper: number; lower: number } {
  const range = c.h - c.l;
  if (range <= 0) return { upper: 0, lower: 0 };
  return { upper: (c.h - Math.max(c.o, c.c)) / range, lower: (Math.min(c.o, c.c) - c.l) / range };
}
