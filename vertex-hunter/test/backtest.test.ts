// Backtest mechanics on SYNTHETIC candles. These verify the engine's no-look-ahead guarantees and metric maths;
// they say nothing about real-market profitability.
import test from 'node:test';
import assert from 'node:assert/strict';
import { decideAt, simulateTrade, computeMetrics, runBacktest, type SymbolSeries, type Trade } from '../src/backtest.ts';
import { DEFAULT_CONFIG, mergeConfig } from '../src/config.ts';
import { contract, build5m, aggregate } from './helpers.ts';
import type { Candle } from '../src/mexc/types.ts';

function series(): SymbolSeries {
  const c5 = build5m({ surge: 'up' });
  // extend with 40 flat-ish bars after the surge so a trade can play out
  const last = c5[c5.length - 1];
  const extra: Candle[] = [];
  let p = last.c;
  for (let k = 1; k <= 40; k++) {
    const o = p; const c = o * 1.0015;
    extra.push({ t: last.t + k * 300, o, h: c * 1.0003, l: o * 0.9998, c, v: 1500 });
    p = c;
  }
  const all = [...c5, ...extra];
  return { symbol: 'SYN_USDT', contract, c5: all, c15: aggregate(all, 3, 900), c60: aggregate(all, 12, 3600) };
}

test('NO LOOK-AHEAD: the decision at bar i is identical whether or not future bars exist', () => {
  const s = series();
  const i = 128; // the confirmed surge bar region
  const full = decideAt(s, i, DEFAULT_CONFIG);
  const truncated: SymbolSeries = { ...s, c5: s.c5.slice(0, i + 1), c15: s.c15.filter((c) => c.t <= s.c5[i].t), c60: s.c60.filter((c) => c.t <= s.c5[i].t) };
  const trunc = decideAt(truncated, i, DEFAULT_CONFIG);
  assert.deepEqual(trunc, full);
  // mutate the future wildly: decision must not change
  const mutated: SymbolSeries = { ...s, c5: s.c5.map((c, k) => (k > i ? { ...c, c: c.c * 5, h: c.h * 5, v: c.v * 100 } : c)) };
  assert.deepEqual(decideAt(mutated, i, DEFAULT_CONFIG), full);
});

test('decisions for every bar are invariant to bars after them (property check over a range)', () => {
  const s = series();
  const cut = 100;
  const prefix: SymbolSeries = { ...s, c5: s.c5.slice(0, cut + 1) };
  for (let i = 60; i <= cut; i += 7) {
    const a = decideAt(s, i, DEFAULT_CONFIG);
    const b = decideAt({ ...prefix, c15: s.c15, c60: s.c60 }, i, DEFAULT_CONFIG);
    assert.deepEqual(a?.score, b?.score, `bar ${i}`);
  }
});

test('trade entry uses the NEXT bar open (not the signal bar close) and includes slippage and fees', () => {
  const s = series();
  const cand = decideAt(s, 128, DEFAULT_CONFIG);
  assert.ok(cand, 'synthetic surge must produce a candidate');
  const t = simulateTrade(s, 128, cand!, DEFAULT_CONFIG, 'unknown')!;
  assert.equal(t.entryT, s.c5[129].t);
  const slip = DEFAULT_CONFIG.risk.slippageBps / 10000;
  const long = cand!.direction === 'LONG';
  assert.ok(Math.abs(t.entry - s.c5[129].o * (1 + (long ? 1 : -1) * slip)) < 1e-9);
  assert.ok(t.costPct > 0);
  assert.ok(t.netPct < t.grossPct);
});

test('when stop and target are both touched in one bar, the stop is assumed first', () => {
  const s = series();
  const cand = decideAt(s, 128, DEFAULT_CONFIG)!;
  const entryBar = s.c5[129];
  const wild: Candle = { ...entryBar, h: entryBar.o * 1.5, l: entryBar.o * 0.5 };
  const s2: SymbolSeries = { ...s, c5: s.c5.map((c, k) => (k === 129 ? wild : c)) };
  const t = simulateTrade(s2, 128, cand, DEFAULT_CONFIG, 'x')!;
  assert.equal(t.exitReason, cand.direction === 'LONG' ? 'STOP' : 'STOP');
  assert.ok(t.netPct < 0);
});

const mk = (netPct: number, entryT: number, stopPct = 2): Trade => ({
  symbol: 'A', direction: 'LONG', state: 'CONFIRMED_SETUP', score: 70, signalT: entryT - 300, entryT, exitT: entryT + 600, entry: 1, exit: 1,
  exitReason: netPct > 0 ? 'TARGET' : 'STOP', stopPct, grossPct: netPct + 0.04, costPct: 0.04, netPct, rMultiple: netPct / stopPct, barsHeld: 2, regime: 'btc_range',
});

test('metrics: win rate, profit factor, expectancy, drawdown on a known trade list', () => {
  const cfg = mergeConfig(DEFAULT_CONFIG, { risk: { maxOpenPositions: 5 } });
  const trades = [mk(4, 1000), mk(-2, 2000), mk(4, 3000), mk(-2, 4000), mk(-2, 5000)];
  const m = computeMetrics(trades, cfg, 100, 3);
  assert.equal(m.trades, 5);
  assert.equal(m.wins, 2);
  assert.equal(m.losses, 3);
  assert.ok(Math.abs(m.winRatePct! - 40) < 1e-9);
  assert.ok(Math.abs(m.expectancyPct! - (4 + -2 + 4 - 2 - 2) / 5) < 1e-9);
  assert.ok(m.profitFactor! > 1 && m.profitFactor! < 2.5);
  assert.ok(m.maxDrawdownPct > 0);
  assert.ok(m.sufficientSample);
  assert.equal(computeMetrics(trades.slice(0, 2), cfg, 100, 30).sufficientSample, false);
});

test('metrics: empty trade list gives nulls, not fabricated zeros', () => {
  const m = computeMetrics([], DEFAULT_CONFIG);
  assert.equal(m.trades, 0);
  assert.equal(m.winRatePct, null);
  assert.equal(m.expectancyPct, null);
  assert.equal(m.profitFactor, null);
  assert.equal(m.netReturnPct, 0);
});

test('concurrency cap skips overlapping trades', () => {
  const cfg = mergeConfig(DEFAULT_CONFIG, { risk: { maxOpenPositions: 1 } });
  const a = { ...mk(4, 1000), exitT: 5000 };
  const b = { ...mk(4, 2000), exitT: 3000 };
  assert.equal(computeMetrics([a, b], cfg, 100, 1).trades, 1);
});

test('runBacktest labels results and refuses to call a tiny sample evidence', () => {
  const r = runBacktest([series()], DEFAULT_CONFIG, { days: 1 }, {}, 'vh-test');
  assert.equal(r.kind, 'REAL_HISTORICAL_BACKTEST');
  assert.equal(r.verdict.label, 'INSUFFICIENT_EVIDENCE');
  assert.ok(r.limitations.length >= 4);
  assert.ok(r.dataRange.splitAt > r.dataRange.from && r.dataRange.splitAt < r.dataRange.to);
  assert.equal(r.inSample.trades + r.outOfSample.trades <= r.all.trades + 0, true);
});
