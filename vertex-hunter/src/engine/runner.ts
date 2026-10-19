// Orchestrates feed -> store -> scanner -> signals -> paper wallet. All market inputs come from MarketStore (live data only).
import type { DB } from '../db.ts';
import { activeConfig, addNotification, logEvent } from '../db.ts';
import type { AppConfig } from '../config.ts';
import { computeHealth, type Health } from '../health.ts';
import type { MarketStore } from '../market.ts';
import type { MexcRest } from '../mexc/rest.ts';
import type { MexcWs } from '../mexc/ws.ts';
import type { Interval, Ticker } from '../mexc/types.ts';
import { INTERVAL_SECONDS } from '../mexc/types.ts';
import { evaluate, qualifies, type Candidate } from './scoring.ts';
import { SignalTracker } from '../signals.ts';
import { PaperWallet } from '../wallet/paper.ts';

export interface ShortlistEntry {
  candidate: Candidate;
  firstSeenAt: number;
  lastQualifiedAt: number;
  misses: number;
  scoreHistory: Array<{ ts: number; score: number }>;
  signalId?: string;
  status: 'ACTIVE' | 'DETERIORATING' | 'INVALIDATED';
  previousState?: string;
}

type Job = { symbol: string; interval: Interval };

const PERIOD_MS: Record<'Min5hot' | 'Min5' | 'Min15' | 'Min60', number> = { Min5hot: 10_000, Min5: 120_000, Min15: 300_000, Min60: 900_000 };
const BARS: Record<'Min5' | 'Min15' | 'Min60', number> = { Min5: 220, Min15: 120, Min60: 60 };

export interface RunnerDeps {
  db: DB;
  store: MarketStore;
  rest: MexcRest;
  ws?: MexcWs;
  wallet: PaperWallet;
  tracker: SignalTracker;
  now?: () => number;
  onChange?: (topic: 'shortlist' | 'health' | 'notification' | 'wallet' | 'signals') => void;
}

export class Runner {
  readonly shortlist = new Map<string, ShortlistEntry>();
  health: Health = { state: 'DISCONNECTED', actionable: false, ageMs: null, reason: 'starting' };
  restConsecutiveFailures = 0;
  lastRestTickerOk: number | null = null;
  lastScanMs: number | null = null;
  lastScanDurationMs = 0;
  scans = 0;
  skippedReasons = new Map<string, number>();
  evaluated = 0;
  changeUnitFactor = 1;
  private deps: RunnerDeps;
  private timers: Array<ReturnType<typeof setInterval>> = [];
  private stopped = false;
  private lastHealthState = '';
  private depthBusy = false;
  private loaderBusy = false;
  private cfgCache?: { version: number; config: AppConfig };

  constructor(deps: RunnerDeps) { this.deps = deps; }

  private now(): number { return (this.deps.now ?? Date.now)(); }
  get cfg(): { version: number; config: AppConfig } {
    return this.cfgCache ?? (this.cfgCache = activeConfig(this.deps.db));
  }
  reloadConfig(): void { this.cfgCache = undefined; }

  // ------------------------------------------------------------------ lifecycle
  async start(): Promise<void> {
    const { rest, ws } = this.deps;
    ws?.start();
    void this.loadContracts();
    this.timers.push(setInterval(() => void this.pollTickers(), 4_000));
    this.timers.push(setInterval(() => void this.runLoader(), 300));
    this.timers.push(setInterval(() => void this.scanOnce(), 3_000));
    this.timers.push(setInterval(() => void this.refreshDepth(), 6_000));
    this.timers.push(setInterval(() => void this.loadContracts(), 30 * 60_000));
    this.timers.push(setInterval(() => this.snapshotEquity(), 30_000));
    void this.pollTickers();
    void rest;
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    this.deps.ws?.stop();
  }

  async loadContracts(): Promise<void> {
    try {
      const { contracts, dropped } = await this.deps.rest.contracts();
      if (!contracts.length) throw new Error('contract list empty');
      this.deps.store.setContracts(contracts);
      for (const c of contracts) this.deps.wallet.setTakerRate(c.symbol, c.takerFeeRate);
      logEvent(this.deps.db, 'info', 'feed', `Loaded ${contracts.length} contracts (${this.deps.store.eligible.size} eligible, ${dropped} malformed rows dropped)`);
    } catch (e: any) {
      logEvent(this.deps.db, 'error', 'feed', `contract load failed: ${e?.message}`);
    }
  }

  /** REST reconciliation: full ticker snapshot. Also the only data source if the WebSocket is down. */
  async pollTickers(): Promise<void> {
    if (this.stopped) return;
    try {
      const { tickers, dropped } = await this.deps.rest.tickers();
      this.restConsecutiveFailures = 0;
      this.lastRestTickerOk = this.now();
      if (dropped) this.deps.store.stats.badTimestamp += 0;
      this.ingest(tickers);
    } catch (e: any) {
      this.restConsecutiveFailures++;
      logEvent(this.deps.db, 'warn', 'feed', `REST ticker poll failed (${this.restConsecutiveFailures}x): ${e?.message}`);
    }
    this.updateHealth();
  }

  ingest(tickers: Ticker[]): void {
    const { store, tracker, wallet } = this.deps;
    const nowMs = this.now();
    const watched = new Set<string>([...tracker.openSymbols(), ...wallet.openPositions().map((p) => p.symbol)]);
    const cfg = this.cfg;
    for (const t of tickers) {
      if (!store.eligible.has(t.symbol) && store.contracts.size > 0) continue;
      const accepted = store.ingestTicker(t, nowMs);
      if (accepted && watched.has(t.symbol)) {
        const tk = store.tickers.get(t.symbol)!;
        tracker.onPrice(t.symbol, tk.last, tk.exchangeTs, cfg.config);
        const contract = store.contracts.get(t.symbol);
        if (contract) wallet.manage(t.symbol, { nowMs, cfg: cfg.config, cfgVersion: cfg.version, actionable: this.health.actionable, contract, ticker: tk, spreadBps: store.spreadBps(t.symbol) });
      }
    }
    this.updateHealth();
    if (watched.size) { this.deps.onChange?.('wallet'); this.deps.onChange?.('signals'); }
  }

  updateHealth(): Health {
    const { store, ws } = this.deps;
    const q = this.cfg.config.dataQuality;
    const h = computeHealth({
      wsConnected: ws?.connected ?? false,
      lastTickerReceivedTs: store.lastAcceptedReceivedTs,
      restConsecutiveFailures: this.restConsecutiveFailures,
      contractsLoaded: store.contractsLoadedAt !== null,
    }, q, this.now());
    if (h.state !== this.lastHealthState) {
      logEvent(this.deps.db, h.actionable ? 'info' : 'warn', 'health', `Feed state ${this.lastHealthState || '-'} -> ${h.state}: ${h.reason}`);
      this.lastHealthState = h.state;
      this.deps.onChange?.('health');
    }
    this.health = h;
    return h;
  }

  // ------------------------------------------------------------------ candle loader
  private pickJob(): Job | undefined {
    const { store } = this.deps;
    const nowMs = this.now();
    let best: { job: Job; urgency: number } | undefined;
    const hot = this.hotSymbols();
    for (const symbol of store.eligible) {
      const t = store.tickers.get(symbol);
      if (!t) continue;
      const usd = store.estQuoteVolume24h(symbol);
      if (usd !== undefined && usd < this.cfg.config.thresholds.minLiquidityUsd24h * 0.5) continue; // illiquid: never a candidate
      const plan: Array<[Interval, number]> = [['Min5', hot.has(symbol) ? PERIOD_MS.Min5hot : PERIOD_MS.Min5], ['Min15', PERIOD_MS.Min15], ['Min60', PERIOD_MS.Min60]];
      for (const [interval, period] of plan) {
        const fetchedAt = store.candleFetchedAt.get(`${symbol}|${interval}`);
        const age = fetchedAt === undefined ? Infinity : nowMs - fetchedAt;
        if (age < period) continue;
        const urgency = (fetchedAt === undefined ? 1e9 : age / period) * (interval === 'Min5' ? 1.5 : 1) * (hot.has(symbol) ? 3 : 1);
        if (!best || urgency > best.urgency) best = { job: { symbol, interval }, urgency };
      }
    }
    return best?.job;
  }

  private hotSymbols(): Set<string> {
    const s = new Set<string>([...this.deps.tracker.openSymbols(), ...this.deps.wallet.openPositions().map((p) => p.symbol), ...this.shortlist.keys()]);
    const nowMs = this.now();
    for (const [symbol] of this.deps.store.tickers) {
      const old = this.deps.store.snapshotAtOrBefore(symbol, nowMs - 120_000, 150_000);
      const cur = this.deps.store.tickers.get(symbol)!;
      if (old && Math.abs(cur.last / old.last - 1) > 0.004) s.add(symbol);
    }
    return s;
  }

  async runLoader(): Promise<void> {
    if (this.loaderBusy || this.stopped) return;
    if (this.health.state === 'DISCONNECTED') return;
    this.loaderBusy = true;
    try {
      // a few jobs per tick; the REST limiter bounds the real request rate
      for (let i = 0; i < 4; i++) {
        const job = this.pickJob();
        if (!job) break;
        await this.fetchCandles(job);
      }
    } finally { this.loaderBusy = false; }
  }

  async fetchCandles(job: Job): Promise<void> {
    const { rest, store } = this.deps;
    const nowSec = Math.floor(this.now() / 1000);
    const sec = INTERVAL_SECONDS[job.interval];
    const bars = BARS[job.interval as 'Min5' | 'Min15' | 'Min60'];
    // mark as attempted first so a failing symbol cannot starve the queue
    store.candleFetchedAt.set(`${job.symbol}|${job.interval}`, this.now());
    try {
      const { candles } = await rest.klines(job.symbol, job.interval, { start: nowSec - bars * sec, end: nowSec + sec });
      if (candles.length) store.mergeCandles(job.symbol, job.interval, candles, 600, this.now());
    } catch (e: any) {
      logEvent(this.deps.db, 'warn', 'feed', `kline ${job.symbol} ${job.interval} failed: ${e?.message}`);
    }
  }

  async refreshDepth(): Promise<void> {
    if (this.depthBusy || this.stopped || this.health.state === 'DISCONNECTED') return;
    this.depthBusy = true;
    try {
      const top = [...this.shortlist.values()].sort((a, b) => b.candidate.score - a.candidate.score).slice(0, 8);
      for (const e of top) {
        try {
          const d = await this.deps.rest.depth(e.candidate.symbol, 20);
          if (d) this.deps.store.depth.set(e.candidate.symbol, d);
        } catch { /* order-book simply stays unavailable for this symbol */ }
      }
    } finally { this.depthBusy = false; }
  }

  // ------------------------------------------------------------------ scanning
  change24hPct(symbol: string): number | undefined {
    const t = this.deps.store.tickers.get(symbol);
    return t?.riseFallRate === undefined ? undefined : t.riseFallRate * 100 * this.changeUnitFactor;
  }

  /**
   * Cross-check the exchange's riseFallRate unit (fraction vs percent) against our own 24h change from hourly candles.
   * Documentation does not state the unit, so we measure it instead of assuming.
   */
  calibrateChangeUnit(): { checked: number; factor: number } {
    const { store } = this.deps;
    const votes = { fraction: 0, percent: 0 };
    let checked = 0;
    for (const [symbol, t] of store.tickers) {
      const c = store.getCandles(symbol, 'Min60');
      if (c.length < 26 || t.riseFallRate === undefined) continue;
      const ref = c[c.length - 25]?.c;
      if (!ref) continue;
      const own = ((t.last - ref) / ref) * 100;
      if (Math.abs(own) < 3) continue; // need a decent move to discriminate units
      checked++;
      const errFrac = Math.abs(own - t.riseFallRate * 100);
      const errPct = Math.abs(own - t.riseFallRate);
      if (errFrac < errPct) votes.fraction++; else votes.percent++;
      if (checked >= 25) break;
    }
    if (checked >= 5) {
      const factor = votes.percent > votes.fraction ? 0.01 : 1;
      if (factor !== this.changeUnitFactor) logEvent(this.deps.db, 'warn', 'feed', `riseFallRate unit auto-detected as ${factor === 1 ? 'fraction' : 'percent'} (${checked} symbols checked)`);
      this.changeUnitFactor = factor;
    }
    return { checked, factor: this.changeUnitFactor };
  }

  oiChange30m(symbol: string, nowMs: number): { oiPct: number; pricePct: number } | undefined {
    const { store } = this.deps;
    const cur = store.tickers.get(symbol);
    const old = store.snapshotAtOrBefore(symbol, nowMs - 30 * 60_000, 8 * 60_000);
    if (!cur || !old || !cur.holdVol || !old.hold || old.hold <= 0 || old.last <= 0) return undefined;
    return { oiPct: cur.holdVol / old.hold - 1, pricePct: cur.last / old.last - 1 };
  }

  async scanOnce(nowMsOverride?: number): Promise<void> {
    if (this.stopped && nowMsOverride === undefined) return;
    const started = Date.now();
    const nowMs = nowMsOverride ?? this.now();
    this.updateHealth();
    const { store, tracker, wallet, db } = this.deps;
    const { config, version } = this.cfg;
    const seen = new Set<string>();
    this.skippedReasons.clear();
    this.evaluated = 0;
    if (this.scans % 20 === 0) this.calibrateChangeUnit();

    for (const symbol of store.eligible) {
      const ticker = store.tickers.get(symbol);
      const contract = store.contracts.get(symbol);
      if (!ticker || !contract) continue;
      const res = evaluate({
        symbol, contract, ticker,
        candles: { Min5: store.getCandles(symbol, 'Min5'), Min15: store.getCandles(symbol, 'Min15'), Min60: store.getCandles(symbol, 'Min60') },
        oiChange30m: this.oiChange30m(symbol, nowMs),
        depth: store.depth.get(symbol),
        usdVolume24h: store.estQuoteVolume24h(symbol),
        spreadBps: store.spreadBps(symbol),
        change24hPct: this.change24hPct(symbol),
        nowMs,
      }, config);
      if (res.skipped) { const k = res.skipped.replace(/\(.*\)/, '').trim(); this.skippedReasons.set(k, (this.skippedReasons.get(k) ?? 0) + 1); continue; }
      this.evaluated++;

      // Invalidation of existing setups: failed breakout on either side closes open signals for that direction.
      for (const cand of [res.long, res.short]) {
        if (cand?.state === 'INVALIDATED_SETUP') {
          for (const s of tracker.openSignals().filter((x) => x.symbol === symbol && x.direction === cand.direction)) tracker.close(s.id, 'INVALIDATED', 'FAILED_BREAKOUT', ticker.last, nowMs);
        }
      }

      const best = res.best;
      if (best && qualifies(best, config)) {
        seen.add(symbol);
        this.upsertShortlist(best, nowMs, ticker, symbol);
      }
    }

    // age out entries that no longer qualify (3 consecutive misses), show deterioration first
    for (const [symbol, e] of this.shortlist) {
      if (seen.has(symbol)) continue;
      e.misses++;
      if (e.status === 'ACTIVE') { e.status = 'DETERIORATING'; e.previousState = e.candidate.state; }
      if (e.misses >= 3 && nowMs - e.lastQualifiedAt > 60_000) this.shortlist.delete(symbol);
    }

    this.scans++;
    this.lastScanMs = nowMs;
    this.lastScanDurationMs = Date.now() - started;
    this.deps.onChange?.('shortlist');
    void db; void wallet; void version;
  }

  private upsertShortlist(c: Candidate, nowMs: number, ticker: Ticker, symbol: string): void {
    const { store, tracker, wallet, db } = this.deps;
    const { config, version } = this.cfg;
    const contract = store.contracts.get(symbol)!;
    const prev = this.shortlist.get(symbol);
    const entry: ShortlistEntry = prev ?? { candidate: c, firstSeenAt: nowMs, lastQualifiedAt: nowMs, misses: 0, scoreHistory: [], status: 'ACTIVE' };
    const stateBefore = prev?.candidate.state;
    entry.candidate = c; entry.lastQualifiedAt = nowMs; entry.misses = 0; entry.status = 'ACTIVE';
    entry.scoreHistory.push({ ts: nowMs, score: c.score });
    if (entry.scoreHistory.length > 40) entry.scoreHistory.shift();
    this.shortlist.set(symbol, entry);
    if (!this.health.actionable) return; // never create new signals or paper entries on non-LIVE data

    const fundingRate = ticker.fundingRate;
    if (c.state === 'CONFIRMED_SETUP') {
      // Promote: close the open WATCH signal(s) for this symbol/direction, then record a new CONFIRMED signal at the current price.
      for (const s of tracker.openSignals().filter((x) => x.symbol === symbol && x.direction === c.direction && x.state !== 'CONFIRMED_SETUP')) tracker.close(s.id, 'PROMOTED', 'PROMOTED_TO_CONFIRMED', ticker.last, nowMs);
      const id = tracker.create(c, config, version, contract, fundingRate, nowMs);
      if (id) {
        entry.signalId = id;
        addNotification(db, 'SIGNAL_CONFIRMED', `Confirmed ${c.direction} setup: ${symbol}`, `Score ${c.score}. Reference entry ${c.entryRef}. Hypothetical only.`, nowMs);
        this.deps.onChange?.('notification');
        const res = wallet.tryOpen(c, id, { nowMs, cfg: config, cfgVersion: version, actionable: this.health.actionable, contract, ticker, spreadBps: store.spreadBps(symbol) }, this.marks());
        void res;
        this.deps.onChange?.('wallet');
      }
    } else if (stateBefore !== c.state || !entry.signalId) {
      const id = tracker.create(c, config, version, contract, fundingRate, nowMs);
      if (id) entry.signalId = id;
    }
  }

  /** Record mark-to-market equity so the wallet curve is real history, not a reconstruction. Skipped when data is not LIVE. */
  snapshotEquity(): void {
    if (this.health.state === 'DISCONNECTED') return;
    const e = this.deps.wallet.equity(this.marks());
    const ts = Math.floor(this.now() / 30_000) * 30_000;
    this.deps.db.prepare('INSERT OR REPLACE INTO equity_snapshots (ts,equity,cash,margin,unrealized) VALUES (?,?,?,?,?)').run(ts, e.equity, e.cash, e.marginInUse, e.unrealized);
  }

  marks(): Map<string, number> {
    const m = new Map<string, number>();
    for (const [s, t] of this.deps.store.tickers) m.set(s, t.last);
    return m;
  }

  status() {
    const { store, rest, ws } = this.deps;
    return {
      health: this.health,
      ws: ws ? { connected: ws.connected, reconnects: ws.reconnects, messages: ws.messages, lastMessageTs: ws.lastMessageTs, lastError: ws.lastError } : null,
      rest: { ...rest.stats, consecutiveTickerFailures: this.restConsecutiveFailures, lastTickerOk: this.lastRestTickerOk },
      ingest: store.stats,
      contracts: { total: store.contracts.size, eligible: store.eligible.size, tickers: store.tickers.size },
      scan: { scans: this.scans, lastScanMs: this.lastScanMs, durationMs: this.lastScanDurationMs, evaluated: this.evaluated, skipped: Object.fromEntries(this.skippedReasons), changeUnitFactor: this.changeUnitFactor },
      lastTickerReceivedTs: store.lastAcceptedReceivedTs,
    };
  }
}
