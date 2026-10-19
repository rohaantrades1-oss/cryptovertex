import type { Candle, ContractInfo, DepthSnapshot, Interval, Ticker } from './mexc/types.ts';
import { INTERVAL_SECONDS } from './mexc/types.ts';
import { isEligible } from './mexc/parse.ts';

export interface Snapshot { ts: number; last: number; vol24?: number; hold?: number; funding?: number; bid?: number; ask?: number }

export interface IngestStats { accepted: number; duplicates: number; outOfOrder: number; badTimestamp: number; merged: number }

/**
 * In-memory market state. All ingestion goes through ingestTicker/mergeCandles so duplicate and out-of-order
 * events are rejected in one place and counted.
 */
export class MarketStore {
  contracts = new Map<string, ContractInfo>();
  eligible = new Set<string>();
  tickers = new Map<string, Ticker>();
  history = new Map<string, Snapshot[]>();
  candles = new Map<string, Map<Interval, Candle[]>>();
  candleFetchedAt = new Map<string, number>();
  depth = new Map<string, DepthSnapshot>();
  stats: IngestStats = { accepted: 0, duplicates: 0, outOfOrder: 0, badTimestamp: 0, merged: 0 };
  lastAcceptedReceivedTs: number | null = null;
  contractsLoadedAt: number | null = null;
  historyMinGapMs = 10_000;
  historyMax = 720;

  private maxClockSkewMs: number;
  constructor(maxClockSkewMs = 60_000) { this.maxClockSkewMs = maxClockSkewMs; }

  setContracts(list: ContractInfo[]): void {
    this.contracts = new Map(list.map((c) => [c.symbol, c]));
    this.eligible = new Set(list.filter((c) => isEligible(c).ok).map((c) => c.symbol));
    this.contractsLoadedAt = Date.now();
  }

  /** Returns true if the ticker changed state. */
  ingestTicker(t: Ticker, now = t.receivedTs): boolean {
    if (Math.abs(t.exchangeTs - now) > this.maxClockSkewMs) { this.stats.badTimestamp++; return false; }
    const prev = this.tickers.get(t.symbol);
    if (prev) {
      if (t.exchangeTs < prev.exchangeTs) { this.stats.outOfOrder++; return false; }
      if (t.exchangeTs === prev.exchangeTs && t.last === prev.last && t.volume24 === prev.volume24 && t.holdVol === prev.holdVol) {
        this.stats.duplicates++;
        return false;
      }
    }
    // Merge: a partial WS push must not erase REST-only fields (holdVol, bid/ask) with undefined.
    const merged: Ticker = prev ? { ...prev, ...stripUndefined(t) } : t;
    this.tickers.set(t.symbol, merged);
    this.stats.accepted++;
    this.lastAcceptedReceivedTs = Math.max(this.lastAcceptedReceivedTs ?? 0, t.receivedTs);
    this.pushHistory(merged);
    return true;
  }

  private pushHistory(t: Ticker): void {
    let h = this.history.get(t.symbol);
    if (!h) { h = []; this.history.set(t.symbol, h); }
    const last = h[h.length - 1];
    if (last && t.exchangeTs - last.ts < this.historyMinGapMs) {
      // Update in place within the sampling window so the latest value is never lost.
      last.last = t.last; last.vol24 = t.volume24; last.hold = t.holdVol; last.funding = t.fundingRate; last.bid = t.bid1; last.ask = t.ask1;
      return;
    }
    h.push({ ts: t.exchangeTs, last: t.last, vol24: t.volume24, hold: t.holdVol, funding: t.fundingRate, bid: t.bid1, ask: t.ask1 });
    if (h.length > this.historyMax) h.splice(0, h.length - this.historyMax);
  }

  getCandles(symbol: string, interval: Interval): Candle[] {
    return this.candles.get(symbol)?.get(interval) ?? [];
  }

  /** Merge fetched candles: dedupe by open time, newer data wins, keep ascending, cap length. */
  mergeCandles(symbol: string, interval: Interval, incoming: Candle[], cap = 600, now = Date.now()): number {
    let m = this.candles.get(symbol);
    if (!m) { m = new Map(); this.candles.set(symbol, m); }
    const byT = new Map<number, Candle>((m.get(interval) ?? []).map((c) => [c.t, c]));
    let changed = 0;
    for (const c of incoming) {
      const old = byT.get(c.t);
      if (!old || old.c !== c.c || old.v !== c.v || old.h !== c.h || old.l !== c.l) changed++;
      byT.set(c.t, c);
    }
    const arr = [...byT.values()].sort((a, b) => a.t - b.t);
    if (arr.length > cap) arr.splice(0, arr.length - cap);
    m.set(interval, arr);
    this.candleFetchedAt.set(`${symbol}|${interval}`, now);
    this.stats.merged += changed;
    return changed;
  }

  /** Candles whose period has fully ended at `nowSec` (excludes the forming candle): prevents partial-candle confirmation. */
  closedCandles(symbol: string, interval: Interval, nowSec: number): Candle[] {
    const sec = INTERVAL_SECONDS[interval];
    return this.getCandles(symbol, interval).filter((c) => c.t + sec <= nowSec);
  }

  /** Nearest snapshot at or before `ts`; undefined when history does not reach back that far. */
  snapshotAtOrBefore(symbol: string, ts: number, maxGapMs: number): Snapshot | undefined {
    const h = this.history.get(symbol);
    if (!h || !h.length) return undefined;
    let found: Snapshot | undefined;
    for (let i = h.length - 1; i >= 0; i--) if (h[i].ts <= ts) { found = h[i]; break; }
    if (!found || ts - found.ts > maxGapMs) return undefined;
    return found;
  }

  /** USD turnover estimate from documented units: contracts x contractSize x price. */
  estQuoteVolume24h(symbol: string): number | undefined {
    const t = this.tickers.get(symbol);
    const c = this.contracts.get(symbol);
    if (!t || !c || t.volume24 === undefined) return undefined;
    return t.volume24 * c.contractSize * t.last;
  }

  spreadBps(symbol: string): number | undefined {
    const t = this.tickers.get(symbol);
    if (!t?.bid1 || !t.ask1 || t.ask1 < t.bid1) return undefined;
    const mid = (t.bid1 + t.ask1) / 2;
    return ((t.ask1 - t.bid1) / mid) * 10_000;
  }
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  const out: any = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out;
}
