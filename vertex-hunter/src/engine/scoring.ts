// Explainable scoring engine. `evaluate` is a pure function of its inputs: same inputs => same output.
import type { AppConfig } from '../config.ts';
import type { Direction } from '../calc/pnl.ts';
import type { Candle, DepthSnapshot, Interval, Ticker } from '../mexc/types.ts';
import { INTERVAL_SECONDS } from '../mexc/types.ts';
import type { ContractInfo } from '../mexc/types.ts';
import {
  atr, atrPct, clamp, highest, lowest, retOverBars, retPrevWindow, robustZ, median, wasCompressed, wickShares,
} from './indicators.ts';

export type SetupState = 'LONG_WATCH' | 'SHORT_WATCH' | 'CONFIRMED_SETUP' | 'INVALIDATED_SETUP';
export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH';

export interface EvalInput {
  symbol: string;
  contract: ContractInfo;
  ticker: Ticker;
  /** Candles including the forming bar as the last element; ascending. */
  candles: Partial<Record<Interval, Candle[]>>;
  /** Open-interest and price change vs ~30 minutes ago from our own snapshots; undefined if history is too short. */
  oiChange30m?: { oiPct: number; pricePct: number };
  /** Order book, only if fresh. */
  depth?: DepthSnapshot;
  usdVolume24h?: number;
  spreadBps?: number;
  /** Exchange-reported 24h change as a percent. */
  change24hPct?: number;
  nowMs: number;
}

export interface Component {
  key: 'volume' | 'momentum' | 'volatility' | 'breakout' | 'openInterest' | 'orderBook' | 'funding' | 'liquidity';
  available: boolean;
  /** 0..100 */
  score: number;
  weight: number;
  detail: string;
}

export interface Candidate {
  symbol: string;
  direction: Direction;
  state: SetupState;
  score: number;
  /** Score before penalties. */
  rawScore: number;
  components: Component[];
  penalties: Array<{ key: string; points: number; detail: string }>;
  reasons: string[];
  unavailable: string[];
  filters: { passed: boolean; failures: string[] };
  risk: { level: RiskLevel; flags: string[] };
  entryRef: number;
  invalidation?: number;
  target?: number;
  stopPct?: number;
  metrics: Record<string, number | string | boolean | undefined>;
  confirmed: boolean;
  evaluatedAt: number;
}

const sign = (d: Direction) => (d === 'LONG' ? 1 : -1);

function closedOnly(c: Candle[] | undefined, interval: Interval, nowSec: number): Candle[] {
  if (!c) return [];
  const sec = INTERVAL_SECONDS[interval];
  return c.filter((x) => x.t + sec <= nowSec);
}

/** Candles are usable only if the newest bar is recent; otherwise we have a gap and must not trade on it. */
function isFresh(c: Candle[] | undefined, interval: Interval, nowSec: number): boolean {
  if (!c || !c.length) return false;
  return c[c.length - 1].t >= nowSec - 2 * INTERVAL_SECONDS[interval] - 90;
}

export interface EvalOutput {
  long?: Candidate;
  short?: Candidate;
  best?: Candidate;
  skipped?: string;
}

export function evaluate(inp: EvalInput, cfg: AppConfig): EvalOutput {
  const nowSec = inp.nowMs / 1000;
  const m5 = inp.candles.Min5;
  const m15 = inp.candles.Min15;
  const m60 = inp.candles.Min60;
  if (!isFresh(m5, 'Min5', nowSec) || !isFresh(m15, 'Min15', nowSec)) return { skipped: 'candle data missing or stale' };
  const c5 = closedOnly(m5, 'Min5', nowSec);
  const c15 = closedOnly(m15, 'Min15', nowSec);
  if (c5.length < cfg.thresholds.minCandlesRequired || c15.length < 20) return { skipped: `insufficient candles (${c5.length}/${cfg.thresholds.minCandlesRequired} Min5)` };

  const long = scoreDirection('LONG', inp, cfg, c5, c15, closedOnly(m60, 'Min60', nowSec));
  const short = scoreDirection('SHORT', inp, cfg, c5, c15, closedOnly(m60, 'Min60', nowSec));
  const margin = 10; // directional ambiguity guard: winner must beat the other side by this many points
  let best: Candidate | undefined;
  if (long.state !== 'INVALIDATED_SETUP' && long.score >= short.score + margin) best = long;
  else if (short.state !== 'INVALIDATED_SETUP' && short.score >= long.score + margin) best = short;
  return { long, short, best };
}

function scoreDirection(d: Direction, inp: EvalInput, cfg: AppConfig, c5: Candle[], c15: Candle[], c60: Candle[]): Candidate {
  const s = sign(d);
  const th = cfg.thresholds;
  const nowSec = inp.nowMs / 1000;
  const price = inp.ticker.last;
  const comps: Component[] = [];
  const unavailable: string[] = [];
  const reasons: string[] = [];
  const penalties: Candidate['penalties'] = [];
  const flags: string[] = [];
  const metrics: Candidate['metrics'] = {};
  const enabled = cfg.strategies;
  const add = (key: Component['key'], available: boolean, score: number, detail: string, strategyOn = true) => {
    const on = available && strategyOn;
    if (!available) unavailable.push(`${key}: ${detail}`);
    comps.push({ key, available: on, score: on ? clamp(score, 0, 100) : 0, weight: cfg.weights[key], detail: strategyOn ? detail : `${detail} (strategy disabled)` });
  };

  const forming5 = inp.candles.Min5![inp.candles.Min5!.length - 1];
  const atr5 = atrPct(c5, 14);
  const atr15 = atrPct(c15, 14);
  metrics.atrPct5 = atr5 !== undefined ? +(atr5 * 100).toFixed(3) : undefined;
  metrics.atrPct15 = atr15 !== undefined ? +(atr15 * 100).toFixed(3) : undefined;

  // ---- directional alignment of the latest bars (used to avoid crediting volume spikes that go the wrong way)
  const r1 = retOverBars(c5, 1);
  const r2 = retOverBars(c5, 2);
  const aligned = r1 !== undefined && r2 !== undefined ? ((r1 * s > 0 && r2 * s > 0) ? 1 : (r1 * s >= 0 ? 0.5 : 0.15)) : 0.5;

  // ---- VOLUME ANOMALY (Min5, forming bar time-normalised, closed bar used for confirmation)
  {
    const base = c5.slice(-25, -1).map((c) => c.v);
    const lastClosed = c5[c5.length - 1];
    const zClosed = base.length >= 12 ? robustZ(lastClosed.v, base) : NaN;
    const elapsed = clamp((nowSec - forming5.t) / INTERVAL_SECONDS.Min5, 0, 1);
    // The forming bar's volume is projected to a full bar only once at least half of it has elapsed, and the projection is
    // capped so an early-bar burst cannot dominate. The reason text always says which bar produced the number.
    const med = median(base);
    const zFormingRaw = elapsed >= 0.5 && base.length >= 12 && forming5.t > lastClosed.t ? robustZ(forming5.v / elapsed, base) : NaN;
    const zForming = Number.isFinite(zFormingRaw) ? Math.min(zFormingRaw, th.volumeZ * 2) : NaN;
    const useForming = Number.isFinite(zForming) && (!Number.isFinite(zClosed) || zForming > zClosed);
    const z = useForming ? zForming : zClosed;
    metrics.volumeZ = Number.isFinite(z) ? +z.toFixed(2) : undefined;
    metrics.volumeRatioClosed = med > 0 ? +(lastClosed.v / med).toFixed(2) : undefined;
    const formingRatio = med > 0 && elapsed >= 0.5 ? +(forming5.v / elapsed / med).toFixed(2) : undefined;
    metrics.volumeRatioForming = useForming ? formingRatio : undefined;
    const which = useForming ? `forming 5m bar projected ${formingRatio}x median (${(elapsed * 100).toFixed(0)}% elapsed)` : `last closed 5m bar ${metrics.volumeRatioClosed}x median`;
    if (Number.isFinite(z)) {
      const raw = clamp(z / th.volumeZ, 0, 1) * 100 * aligned;
      add('volume', true, raw, `volume robust-z ${z.toFixed(1)} vs 2h baseline: ${which}; direction alignment x${aligned}`, enabled.volumeAnomaly.enabled);
      if (z >= 2 && aligned >= 0.5) reasons.push(`Abnormal volume: robust z ${z.toFixed(1)} (${which})`);
    } else add('volume', false, 0, 'not enough baseline bars');
  }

  // ---- MOMENTUM & ACCELERATION across Min5 / Min15 / Min60
  {
    const parts: Array<{ w: number; v: number }> = [];
    const mom = (c: Candle[], n: number, a: number | undefined, w: number, label: string) => {
      const r = retOverBars(c, n);
      if (r === undefined || a === undefined || a <= 0) return;
      const z = (r * s) / (a * Math.sqrt(n));
      metrics[`ret${label}`] = +(r * 100).toFixed(3);
      parts.push({ w, v: clamp(z / 2, 0, 1) });
    };
    mom(c5, 3, atr5, 0.4, 'Min5x3');
    mom(c15, 3, atr15, 0.3, 'Min15x3');
    const atr60 = atrPct(c60, 14);
    mom(c60, 3, atr60, 0.15, 'Min60x3');
    const a1 = retOverBars(c5, 3);
    const a0 = retPrevWindow(c5, 3);
    if (a1 !== undefined && a0 !== undefined && atr5) {
      const accZ = ((a1 - a0) * s) / (atr5 * Math.sqrt(3));
      metrics.accelZ = +accZ.toFixed(2);
      parts.push({ w: 0.15, v: clamp(accZ / 1.5, 0, 1) });
    }
    if (parts.length >= 2) {
      const wsum = parts.reduce((a, p) => a + p.w, 0);
      const score = (parts.reduce((a, p) => a + p.w * p.v, 0) / wsum) * 100;
      add('momentum', true, score, `ATR-normalised multi-timeframe momentum (${parts.length} inputs): ret5m(3)=${metrics.retMin5x3 ?? 'n/a'}%, ret15m(3)=${metrics.retMin15x3 ?? 'n/a'}%, accel z=${metrics.accelZ ?? 'n/a'}`, enabled.momentumAcceleration.enabled);
      if (score >= 40) reasons.push(`${d === 'LONG' ? 'Upward' : 'Downward'} momentum across timeframes (score ${score.toFixed(0)}; 5m ${metrics.retMin5x3 ?? 'n/a'}%, 15m ${metrics.retMin15x3 ?? 'n/a'}%)`);
    } else add('momentum', false, 0, 'insufficient candles');
  }

  // ---- VOLATILITY EXPANSION after compression
  {
    const aS = atr(c5, 5);
    const aL = atr(c5, 30);
    if (aS !== undefined && aL !== undefined && aL > 0) {
      const ratio = aS / aL;
      const compressed = wasCompressed(c5, 6);
      metrics.atrExpansion = +ratio.toFixed(2);
      metrics.priorCompression = compressed;
      const raw = clamp((ratio - 1) / 1.0, 0, 1) * 100 * (compressed === true ? 1 : 0.7) * (aligned >= 0.5 ? 1 : 0.5);
      add('volatility', true, raw, `ATR(5)/ATR(30) = ${ratio.toFixed(2)}${compressed === true ? ', following a compression phase' : compressed === false ? ', no prior compression' : ''}`, enabled.volatilityExpansion.enabled);
      if (ratio >= 1.4) reasons.push(`Volatility expansion: ATR(5)/ATR(30) ${ratio.toFixed(2)}${compressed ? ' after compression' : ''}`);
    } else add('volatility', false, 0, 'insufficient candles');
  }

  // ---- BREAKOUT PROXIMITY with candle-close confirmation (Min5, 48-bar level)
  let level: number | undefined;
  let closeConfirmed = false;
  {
    const N = 48;
    const lastClosed = c5[c5.length - 1];
    level = d === 'LONG' ? highest(c5, N, 1) : lowest(c5, N, 1);
    if (level !== undefined && atr5) {
      const distFrac = d === 'LONG' ? (level - price) / price : (price - level) / price;
      const broke = distFrac <= 0;
      closeConfirmed = d === 'LONG' ? lastClosed.c > level : lastClosed.c < level;
      metrics.breakoutLevel = level;
      metrics.distToLevelPct = +(distFrac * 100).toFixed(3);
      metrics.closeConfirmed = closeConfirmed;
      let raw = 0;
      if (broke) raw = closeConfirmed ? 100 : 70;
      else raw = clamp(1 - distFrac / (1.5 * atr5), 0, 1) * 100;
      add('breakout', true, raw, broke ? `price beyond the ${N}-bar ${d === 'LONG' ? 'high' : 'low'} (${closeConfirmed ? 'candle close confirmed' : 'not yet close-confirmed'})` : `${(distFrac * 100).toFixed(2)}% from ${N}-bar ${d === 'LONG' ? 'high' : 'low'} (${(distFrac / atr5).toFixed(2)} ATR)`, enabled.breakoutProximity.enabled);
      if (raw >= 60) reasons.push(broke ? `Breakout of the ${N}-bar ${d === 'LONG' ? 'high' : 'low'} ${closeConfirmed ? 'with a confirmed 5m close' : '(close not yet confirmed)'}` : `Approaching the ${N}-bar ${d === 'LONG' ? 'high' : 'low'}: ${(distFrac * 100).toFixed(2)}% away`);
    } else add('breakout', false, 0, 'insufficient candles');
  }

  // ---- OPEN INTEREST vs PRICE
  {
    const oc = inp.oiChange30m;
    if (oc && Number.isFinite(oc.oiPct) && Number.isFinite(oc.pricePct)) {
      metrics.oiChange30mPct = +(oc.oiPct * 100).toFixed(2);
      metrics.price30mPct = +(oc.pricePct * 100).toFixed(2);
      const priceWith = oc.pricePct * s > 0;
      const oiUp = oc.oiPct > 0;
      let raw = 0;
      let txt = '';
      if (priceWith && oiUp) { raw = clamp(oc.oiPct / 0.03, 0, 1) * 100; txt = `OI +${(oc.oiPct * 100).toFixed(1)}% with price moving ${d === 'LONG' ? 'up' : 'down'}: new ${d === 'LONG' ? 'longs' : 'shorts'} entering`; }
      else if (priceWith && !oiUp) { raw = 25; txt = `price ${d === 'LONG' ? 'up' : 'down'} while OI ${(oc.oiPct * 100).toFixed(1)}%: covering move, weaker conviction`; }
      else { raw = 0; txt = `OI ${(oc.oiPct * 100).toFixed(1)}% while price moves against ${d}`; }
      add('openInterest', true, raw, txt, enabled.oiDivergence.enabled);
      if (raw >= 50) reasons.push(txt);
    } else add('openInterest', false, 0, 'open-interest history unavailable (needs ~30 min of snapshots)');
  }

  // ---- ORDER BOOK IMBALANCE (only when a fresh book exists)
  {
    const dp = inp.depth;
    if (dp && inp.nowMs - dp.receivedTs < 15_000) {
      const top = (rows: Array<[number, number]>) => rows.slice(0, 10).reduce((a, [p, q]) => a + p * q, 0);
      const b = top(dp.bids);
      const a = top(dp.asks);
      const imb = (b - a) / (b + a);
      metrics.bookImbalance = +imb.toFixed(3);
      add('orderBook', true, clamp((imb * s) / 0.5, 0, 1) * 100, `top-10 bid/ask notional imbalance ${(imb * 100).toFixed(0)}% (spoofable; low weight)`);
      if (imb * s > 0.3) reasons.push(`Order book leaning ${d === 'LONG' ? 'bid' : 'ask'} side (${(imb * 100).toFixed(0)}% imbalance)`);
    } else add('orderBook', false, 0, 'no fresh order-book snapshot');
  }

  // ---- FUNDING / crowding
  {
    const fr = inp.ticker.fundingRate;
    if (fr !== undefined) {
      metrics.fundingRate = fr;
      const pays = fr * s; // positive => this direction pays funding (crowded)
      const raw = pays <= 0 ? 100 : (1 - clamp(pays / th.maxAbsFundingRate, 0, 1)) * 100;
      add('funding', true, raw, `funding ${(fr * 100).toFixed(4)}% (${pays > 0 ? `${d} side pays; crowding risk` : `${d} side receives or neutral`})`);
      if (pays >= th.maxAbsFundingRate) flags.push('crowded positioning: funding strongly against this direction');
    } else add('funding', false, 0, 'funding rate not provided');
  }

  // ---- LIQUIDITY
  {
    const v = inp.usdVolume24h;
    if (v !== undefined && v > 0) {
      metrics.usdVolume24h = Math.round(v);
      const raw = clamp(Math.log10(v / th.minLiquidityUsd24h) / 1.5, 0, 1) * 100;
      add('liquidity', true, raw, `est. 24h turnover $${(v / 1e6).toFixed(1)}M${inp.spreadBps !== undefined ? `, spread ${inp.spreadBps.toFixed(1)} bps` : ', spread unavailable'}`);
    } else add('liquidity', false, 0, 'volume not available');
  }

  // ---- weighted score over AVAILABLE, ENABLED components only
  const active = comps.filter((c) => c.available);
  const wsum = active.reduce((a, c) => a + c.weight, 0);
  const rawScore = wsum > 0 ? active.reduce((a, c) => a + c.weight * c.score, 0) / wsum : 0;

  // ---- reversal / exhaustion penalties (strategy: reversalExhaustion)
  let failedBreakout = false;
  if (enabled.reversalExhaustion.enabled) {
    const lastClosed = c5[c5.length - 1];
    const prevClosed = c5[c5.length - 2];
    const lvl = d === 'LONG' ? highest(c5, 48, 2) : lowest(c5, 48, 2);
    if (lvl !== undefined && prevClosed) {
      const pokedAndRejected = d === 'LONG'
        ? (prevClosed.h > lvl && prevClosed.c < lvl) || (lastClosed.h > lvl && lastClosed.c < lvl && price < lvl)
        : (prevClosed.l < lvl && prevClosed.c > lvl) || (lastClosed.l < lvl && lastClosed.c > lvl && price > lvl);
      if (pokedAndRejected) { failedBreakout = true; penalties.push({ key: 'failed_breakout', points: 35, detail: `a recent bar broke the 48-bar ${d === 'LONG' ? 'high' : 'low'} but closed back inside` }); }
    }
    const look = th.lateEntryLookbackBars;
    const move = retOverBars(c5, look);
    if (move !== undefined && move * s * 100 > th.lateEntryMovePct * 0.6) {
      const w = wickShares(lastClosed);
      const wick = d === 'LONG' ? w.upper : w.lower;
      const volFade = c5.length >= 3 && c5[c5.length - 1].v < c5[c5.length - 2].v && c5[c5.length - 2].v < c5[c5.length - 3].v;
      if (wick > 0.5 || volFade) penalties.push({ key: 'momentum_exhaustion', points: 20, detail: `already ${(move * s * 100).toFixed(1)}% in ${look} bars with ${wick > 0.5 ? 'a long rejection wick' : 'fading volume'}` });
    }
  }
  const penaltyPts = penalties.reduce((a, p) => a + p.points, 0);
  for (const p of penalties) flags.push(`${p.key}: ${p.detail}`);
  const score = clamp(rawScore - penaltyPts, 0, 100);

  // ---- hard filters (late-entry, liquidity, spread, 24h chase, funding crowding)
  const failures: string[] = [];
  if (inp.usdVolume24h !== undefined && inp.usdVolume24h < th.minLiquidityUsd24h) failures.push(`24h turnover below minimum ($${(inp.usdVolume24h / 1e6).toFixed(2)}M < $${(th.minLiquidityUsd24h / 1e6).toFixed(1)}M)`);
  if (inp.usdVolume24h === undefined) failures.push('liquidity unknown');
  if (inp.spreadBps !== undefined && inp.spreadBps > th.maxSpreadBps) failures.push(`spread ${inp.spreadBps.toFixed(1)} bps above max ${th.maxSpreadBps}`);
  const lateMove = retOverBars(c5, th.lateEntryLookbackBars);
  if (lateMove !== undefined) {
    metrics.moveLookbackPct = +(lateMove * 100).toFixed(2);
    if (lateMove * s * 100 > th.lateEntryMovePct) failures.push(`late entry: already ${(lateMove * s * 100).toFixed(1)}% in the last ${th.lateEntryLookbackBars} x 5m bars (max ${th.lateEntryMovePct}%)`);
  }
  if (inp.change24hPct !== undefined) {
    metrics.change24hPct = +inp.change24hPct.toFixed(2);
    if (Math.abs(inp.change24hPct) > th.max24hMovePct) failures.push(`24h move ${inp.change24hPct.toFixed(1)}% exceeds ${th.max24hMovePct}% chase limit`);
  }
  if (flags.some((f) => f.startsWith('crowded'))) failures.push('funding crowding against direction');

  // ---- stop / target
  const atrRef = atr15 ?? atr5;
  let invalidation: number | undefined;
  let target: number | undefined;
  let stopPct: number | undefined;
  if (atrRef) {
    const rawStop = clamp(atrRef * cfg.risk.stopAtrMultiple * 100, cfg.risk.minStopPct, cfg.risk.maxStopPct);
    stopPct = rawStop;
    invalidation = price * (1 - (s * rawStop) / 100);
    target = price * (1 + (s * rawStop * cfg.risk.targetRMultiple) / 100);
  }

  // ---- risk level (measurable flags only)
  let riskPts = 0;
  if (inp.spreadBps !== undefined && inp.spreadBps > 10) { riskPts++; flags.push(`wide spread ${inp.spreadBps.toFixed(1)} bps`); }
  if (atr15 !== undefined && atr15 > 0.04) { riskPts += 2; flags.push(`very high volatility (ATR15 ${(atr15 * 100).toFixed(1)}%)`); }
  else if (atr15 !== undefined && atr15 > 0.02) { riskPts++; flags.push(`elevated volatility (ATR15 ${(atr15 * 100).toFixed(1)}%)`); }
  if (inp.usdVolume24h !== undefined && inp.usdVolume24h < 5_000_000) { riskPts++; flags.push('thin 24h liquidity'); }
  riskPts += penalties.length;
  if (unavailable.length >= 3) { riskPts++; flags.push(`${unavailable.length} inputs unavailable`); }
  const riskLevel: RiskLevel = riskPts >= 4 ? 'HIGH' : riskPts >= 2 ? 'MEDIUM' : 'LOW';

  // ---- state
  const passed = failures.length === 0;
  const volClosedOk = (metrics.volumeRatioClosed as number | undefined) !== undefined && (metrics.volumeRatioClosed as number) >= 1.8;
  const confirmed = passed && score >= th.confirmScore && closeConfirmed && volClosedOk && !failedBreakout;
  let state: SetupState;
  if (failedBreakout) state = 'INVALIDATED_SETUP';
  else if (confirmed) state = 'CONFIRMED_SETUP';
  else state = d === 'LONG' ? 'LONG_WATCH' : 'SHORT_WATCH';

  return {
    symbol: inp.symbol, direction: d, state, score: +score.toFixed(1), rawScore: +rawScore.toFixed(1),
    components: comps, penalties, reasons, unavailable,
    filters: { passed, failures }, risk: { level: riskLevel, flags },
    entryRef: price, invalidation, target, stopPct, metrics, confirmed, evaluatedAt: inp.nowMs,
  };
}

/** A candidate is shown on the scanner shortlist when it passes filters and reaches the watch score. */
export function qualifies(c: Candidate, cfg: AppConfig): boolean {
  return c.filters.passed && c.score >= cfg.thresholds.watchScore && c.state !== 'INVALIDATED_SETUP';
}
