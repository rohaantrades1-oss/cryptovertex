// Walk-forward backtester over REAL historical candles fetched from MEXC (or any candle arrays passed in).
// Honest scope: historical open interest, funding, order-book depth and spread are NOT available here, so those
// components are reported as unavailable (the engine then scores without them) and funding is NOT charged.
import type { AppConfig } from './config.ts';
import { evaluate, qualifies, type Candidate } from './engine/scoring.ts';
import type { Candle, ContractInfo, Interval } from './mexc/types.ts';
import { INTERVAL_SECONDS } from './mexc/types.ts';
import type { MexcRest } from './mexc/rest.ts';

export interface SymbolSeries { symbol: string; contract: ContractInfo; c5: Candle[]; c15: Candle[]; c60: Candle[] }

export interface Trade {
  symbol: string; direction: 'LONG' | 'SHORT'; state: string; score: number;
  signalT: number; entryT: number; exitT: number; entry: number; exit: number;
  exitReason: 'STOP' | 'TARGET' | 'TIME' | 'DATA_END';
  stopPct: number; grossPct: number; costPct: number; netPct: number; rMultiple: number; barsHeld: number; regime: string;
}

export interface Metrics {
  trades: number; wins: number; losses: number; winRatePct: number | null;
  avgWinPct: number | null; avgLossPct: number | null; expectancyPct: number | null; expectancyR: number | null;
  profitFactor: number | null; netReturnPct: number; maxDrawdownPct: number; endEquity: number;
  /** True only if the sample is large enough to say anything at all. */
  sufficientSample: boolean;
}

export interface BacktestOptions {
  /** Which setup states generate trades. */
  states?: Array<'CONFIRMED_SETUP' | 'LONG_WATCH' | 'SHORT_WATCH'>;
  warmupBars?: number;
  /** Fraction of the timeline used as in-sample; the remainder is the unseen validation window. */
  inSampleFraction?: number;
  startEquity?: number;
  minTradesForEvidence?: number;
}

export const MIN_TRADES_FOR_EVIDENCE = 30;

function closedUpTo(arr: Candle[], interval: Interval, tSec: number): Candle[] {
  const sec = INTERVAL_SECONDS[interval];
  let lo = 0, hi = arr.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid].t + sec <= tSec) lo = mid + 1; else hi = mid; }
  return arr.slice(0, lo);
}

/** Decide, using ONLY bars closed at the end of bar `i`, whether a setup exists. Pure w.r.t. candles after i. */
export function decideAt(s: SymbolSeries, i: number, cfg: AppConfig): Candidate | undefined {
  const bar = s.c5[i];
  const T = bar.t + INTERVAL_SECONDS.Min5; // decision time = close of bar i
  const hist5 = s.c5.slice(0, i + 1);
  const vol24 = hist5.slice(-288).reduce((a, c) => a + c.v, 0) * s.contract.contractSize * bar.c;
  const back = hist5[hist5.length - 289];
  const res = evaluate({
    symbol: s.symbol, contract: s.contract,
    ticker: { symbol: s.symbol, last: bar.c, exchangeTs: T * 1000, receivedTs: T * 1000, source: 'rest' },
    candles: { Min5: hist5, Min15: closedUpTo(s.c15, 'Min15', T), Min60: closedUpTo(s.c60, 'Min60', T) },
    usdVolume24h: vol24 > 0 ? vol24 : undefined,
    change24hPct: back ? ((bar.c - back.c) / back.c) * 100 : undefined,
    nowMs: T * 1000,
  }, cfg);
  return res.best && qualifies(res.best, cfg) ? res.best : undefined;
}

function regimeAt(btc: Candle[] | undefined, tSec: number): string {
  if (!btc || btc.length < 26) return 'unknown';
  const c = closedUpTo(btc, 'Min60', tSec);
  if (c.length < 25) return 'unknown';
  const r = (c[c.length - 1].c - c[c.length - 25].c) / c[c.length - 25].c;
  return r > 0.01 ? 'btc_up' : r < -0.01 ? 'btc_down' : 'btc_range';
}

export function simulateTrade(s: SymbolSeries, i: number, cand: Candidate, cfg: AppConfig, regime: string): Trade | undefined {
  const next = s.c5[i + 1];
  if (!next || cand.stopPct === undefined) return undefined;
  const sg = cand.direction === 'LONG' ? 1 : -1;
  const slip = cfg.risk.slippageBps / 10_000;
  const fee = s.contract.takerFeeRate;
  const entry = next.o * (1 + sg * slip); // conservative: next bar open, worse by slippage
  const stop = entry * (1 - (sg * cand.stopPct) / 100);
  const target = entry * (1 + (sg * cand.stopPct * cfg.risk.targetRMultiple) / 100);
  const maxBars = Math.floor((cfg.risk.maxHoldMinutes * 60) / INTERVAL_SECONDS.Min5);
  let exit = NaN, reason: Trade['exitReason'] = 'TIME', exitIdx = i + 1;
  for (let j = i + 1; j < s.c5.length && j <= i + 1 + maxBars; j++) {
    const b = s.c5[j];
    exitIdx = j;
    const stopHit = sg === 1 ? b.l <= stop : b.h >= stop;
    const targetHit = sg === 1 ? b.h >= target : b.l <= target;
    if (stopHit) { // stop wins ties: we cannot know intrabar order, so assume the worse outcome
      const gapped = sg === 1 ? b.o < stop : b.o > stop;
      exit = (gapped ? b.o : stop) * (1 - sg * slip); reason = 'STOP'; break;
    }
    if (targetHit) { exit = target * (1 - sg * slip); reason = 'TARGET'; break; }
    if (j === i + 1 + maxBars) { exit = b.c * (1 - sg * slip); reason = 'TIME'; }
    if (j === s.c5.length - 1) { exit = b.c * (1 - sg * slip); reason = 'DATA_END'; }
  }
  if (!Number.isFinite(exit)) return undefined;
  const grossPct = ((exit - entry) / entry) * 100 * sg;
  const costPct = 2 * fee * 100; // slippage is already inside entry/exit prices
  const netPct = grossPct - costPct;
  return {
    symbol: s.symbol, direction: cand.direction, state: cand.state, score: cand.score,
    signalT: s.c5[i].t, entryT: next.t, exitT: s.c5[exitIdx].t, entry, exit, exitReason: reason,
    stopPct: cand.stopPct, grossPct, costPct, netPct, rMultiple: netPct / cand.stopPct, barsHeld: exitIdx - i, regime,
  };
}

export function collectTrades(series: SymbolSeries[], cfg: AppConfig, opts: BacktestOptions = {}): { trades: Trade[]; signals: number } {
  const states = new Set(opts.states ?? ['CONFIRMED_SETUP']);
  const warm = opts.warmupBars ?? Math.max(cfg.thresholds.minCandlesRequired, 130);
  const btc = series.find((x) => x.symbol === 'BTC_USDT')?.c60;
  const trades: Trade[] = [];
  let signals = 0;
  for (const s of series) {
    let blockedUntil = -1;
    for (let i = warm; i < s.c5.length - 1; i++) {
      if (i <= blockedUntil) continue;
      const cand = decideAt(s, i, cfg);
      if (!cand || !states.has(cand.state as any)) continue;
      signals++;
      const tr = simulateTrade(s, i, cand, cfg, regimeAt(btc, s.c5[i].t + 300));
      if (tr) {
        trades.push(tr);
        const exitIdx = i + tr.barsHeld;
        blockedUntil = exitIdx + Math.ceil((cfg.risk.cooldownMinutesPerSymbol * 60) / INTERVAL_SECONDS.Min5);
      }
    }
  }
  trades.sort((a, b) => a.entryT - b.entryT);
  return { trades, signals };
}

/** Portfolio-level metrics with compounding virtual equity, concurrency cap and risk-based sizing. */
export function computeMetrics(trades: Trade[], cfg: AppConfig, startEquity = 100, minTrades = MIN_TRADES_FOR_EVIDENCE): Metrics {
  let equity = startEquity, peak = startEquity, maxDd = 0;
  const open: Array<{ exitT: number; pnl: number }> = [];
  const taken: Array<{ pnlUsd: number; netPct: number }> = [];
  const settle = (upToT: number) => {
    open.sort((a, b) => a.exitT - b.exitT);
    while (open.length && open[0].exitT <= upToT) {
      const o = open.shift()!;
      equity += o.pnl;
      peak = Math.max(peak, equity);
      maxDd = Math.max(maxDd, ((peak - equity) / peak) * 100);
    }
  };
  for (const t of trades) {
    settle(t.entryT);
    if (open.length >= cfg.risk.maxOpenPositions) continue;
    const lev = cfg.risk.leverage;
    const unitLoss = t.stopPct / 100 + t.costPct / 100;
    const notional = Math.min((equity * cfg.risk.riskFractionOfEquity) / unitLoss, equity * cfg.risk.maxMarginFractionOfEquity * lev);
    const pnl = Math.max(-notional / lev, (notional * t.netPct) / 100); // isolated margin: loss capped at margin
    open.push({ exitT: t.exitT, pnl });
    taken.push({ pnlUsd: pnl, netPct: t.netPct });
  }
  settle(Infinity);
  const wins = taken.filter((x) => x.pnlUsd > 0);
  const losses = taken.filter((x) => x.pnlUsd <= 0);
  const gp = wins.reduce((a, x) => a + x.pnlUsd, 0);
  const gl = Math.abs(losses.reduce((a, x) => a + x.pnlUsd, 0));
  const n = taken.length;
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const takenTrades = trades.filter((_, idx) => idx >= 0).slice(0, 0); void takenTrades;
  return {
    trades: n, wins: wins.length, losses: losses.length,
    winRatePct: n ? (wins.length / n) * 100 : null,
    avgWinPct: mean(wins.map((x) => x.netPct)), avgLossPct: mean(losses.map((x) => x.netPct)),
    expectancyPct: mean(taken.map((x) => x.netPct)),
    expectancyR: null,
    profitFactor: gl > 0 ? gp / gl : gp > 0 ? Infinity : null,
    netReturnPct: ((equity - startEquity) / startEquity) * 100,
    maxDrawdownPct: maxDd, endEquity: equity, sufficientSample: n >= minTrades,
  };
}

export interface BacktestResult {
  kind: 'REAL_HISTORICAL_BACKTEST';
  generatedAt: number;
  params: { symbols: string[]; days: number; states: string[]; strategyVersion: string };
  dataRange: { from: number; to: number; splitAt: number };
  signals: number;
  all: Metrics; inSample: Metrics; outOfSample: Metrics;
  byState: Record<string, Metrics>;
  byRegime: Record<string, Metrics>;
  byExitReason: Record<string, number>;
  timeframe: string;
  verdict: { label: 'INSUFFICIENT_EVIDENCE' | 'NOT_PROFITABLE_OUT_OF_SAMPLE' | 'POSITIVE_OUT_OF_SAMPLE_UNPROVEN'; text: string };
  limitations: string[];
  trades: Trade[];
}

export const LIMITATIONS = [
  'Only contracts currently listed were tested: delisted/failed contracts are missing (survivorship bias).',
  'Historical open interest, funding, order-book depth and spread are unavailable here; those inputs were NOT used and funding was NOT charged.',
  'Fills assume next-bar open plus configured slippage; stop wins if stop and target trade in the same 5m bar.',
  'The thresholds are defaults chosen a priori, not fitted to this data, but the sample is short: one market regime at most.',
  'A positive result is not evidence of future profitability.',
];

export function runBacktest(series: SymbolSeries[], cfg: AppConfig, params: { days: number }, opts: BacktestOptions = {}, strategyVersion = ''): BacktestResult {
  const { trades, signals } = collectTrades(series, cfg, opts);
  const allT = series.flatMap((s) => s.c5.map((c) => c.t));
  const from = Math.min(...allT), to = Math.max(...allT);
  const warmEnd = from + 130 * 300;
  const splitAt = Math.floor(warmEnd + ((to - warmEnd) * (opts.inSampleFraction ?? 0.7)));
  const minT = opts.minTradesForEvidence ?? MIN_TRADES_FOR_EVIDENCE;
  const se = opts.startEquity ?? 100;
  const insT = trades.filter((t) => t.entryT < splitAt);
  const oosT = trades.filter((t) => t.entryT >= splitAt);
  const group = (key: (t: Trade) => string) => {
    const g: Record<string, Trade[]> = {};
    for (const t of trades) (g[key(t)] ??= []).push(t);
    return Object.fromEntries(Object.entries(g).map(([k, v]) => [k, computeMetrics(v, cfg, se, minT)]));
  };
  const oos = computeMetrics(oosT, cfg, se, minT);
  const verdict: BacktestResult['verdict'] = !oos.sufficientSample
    ? { label: 'INSUFFICIENT_EVIDENCE', text: `Only ${oos.trades} out-of-sample trades (need >= ${minT}). No conclusion can be drawn.` }
    : oos.netReturnPct > 0 && (oos.profitFactor ?? 0) > 1.2
      ? { label: 'POSITIVE_OUT_OF_SAMPLE_UNPROVEN', text: `Positive net result on the unseen window (${oos.netReturnPct.toFixed(1)}%, PF ${(oos.profitFactor ?? 0).toFixed(2)}), but a single short sample is not proof.` }
      : { label: 'NOT_PROFITABLE_OUT_OF_SAMPLE', text: `Net ${oos.netReturnPct.toFixed(1)}% on the unseen window after costs.` };
  const byExit: Record<string, number> = {};
  for (const t of trades) byExit[t.exitReason] = (byExit[t.exitReason] ?? 0) + 1;
  return {
    kind: 'REAL_HISTORICAL_BACKTEST', generatedAt: Date.now(),
    params: { symbols: series.map((s) => s.symbol), days: params.days, states: [...(opts.states ?? ['CONFIRMED_SETUP'])], strategyVersion },
    dataRange: { from, to, splitAt }, signals,
    all: computeMetrics(trades, cfg, se, minT), inSample: computeMetrics(insT, cfg, se, minT), outOfSample: oos,
    byState: group((t) => t.state), byRegime: group((t) => t.regime), byExitReason: byExit,
    timeframe: 'decisions on closed 5m bars; 15m/60m context', verdict, limitations: LIMITATIONS, trades,
  };
}

/** Download history for a symbol with paging (kline endpoint returns at most 2000 points per request). */
export async function loadHistory(rest: MexcRest, symbol: string, interval: Interval, days: number, nowSec = Math.floor(Date.now() / 1000)): Promise<Candle[]> {
  const sec = INTERVAL_SECONDS[interval];
  const from = nowSec - days * 86_400;
  const out = new Map<number, Candle>();
  const span = 1900 * sec;
  for (let start = from; start < nowSec; start += span) {
    const { candles } = await rest.klines(symbol, interval, { start, end: Math.min(nowSec, start + span) });
    for (const c of candles) out.set(c.t, c);
  }
  return [...out.values()].sort((a, b) => a.t - b.t);
}
