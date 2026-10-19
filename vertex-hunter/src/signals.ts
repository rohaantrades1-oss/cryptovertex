import { randomUUID } from 'node:crypto';
import type { DB } from './db.ts';
import { logEvent } from './db.ts';
import type { AppConfig } from './config.ts';
import { STRATEGY_VERSION } from './config.ts';
import type { Candidate } from './engine/scoring.ts';
import { grossRoiPct, updateExcursion, type Direction } from './calc/pnl.ts';
import type { ContractInfo } from './mexc/types.ts';

export const WATCH_EXPIRY_MS = 60 * 60_000;
const MARK_INTERVAL_MS = 60_000;
const FUNDING_PERIOD_MS = 8 * 3600_000;

export interface SignalRow {
  id: string; symbol: string; direction: Direction; state: string; created_at: number; entry_price: number;
  strategy_version: string; config_version: number; score: number; components_json: string; reasons_json: string; market_json: string;
  invalidation_price: number | null; target_price: number | null; status: string; closed_at: number | null; exit_price: number | null;
  outcome: string | null; last_price: number | null; last_update: number | null; mfe_pct: number; mae_pct: number;
  est_roundtrip_cost_pct: number; funding_rate_at_entry: number | null;
}

export interface SignalView {
  id: string; symbol: string; direction: Direction; state: string; status: string; outcome: string | null;
  createdAt: number; entryPrice: number; lastPrice: number | null; lastUpdate: number | null; exitPrice: number | null; closedAt: number | null;
  elapsedMs: number; score: number; strategyVersion: string; configVersion: number;
  grossRoiPct: number | null; estNetRoiPct: number | null; estCostPct: number; estFundingPct: number;
  mfePct: number; maePct: number; invalidation: number | null; target: number | null;
  reasons: string[]; components: unknown; market: unknown;
}

export class SignalTracker {
  private lastMark = new Map<string, number>();
  private db: DB;
  constructor(db: DB) { this.db = db; }

  /** Creates a signal with the entry price taken from data available NOW. Returns undefined if a duplicate/cooldown applies. */
  create(c: Candidate, cfg: AppConfig, cfgVersion: number, contract: ContractInfo, fundingRate: number | undefined, nowMs: number): string | undefined {
    const open = this.db.prepare("SELECT id FROM signals WHERE symbol=? AND direction=? AND state=? AND status='OPEN'").get(c.symbol, c.direction, c.state);
    if (open) return undefined;
    const cd = cfg.risk.cooldownMinutesPerSymbol * 60_000;
    const recent = this.db.prepare("SELECT id FROM signals WHERE symbol=? AND direction=? AND state=? AND created_at > ?").get(c.symbol, c.direction, c.state, nowMs - cd);
    if (recent) return undefined;
    if (!(c.entryRef > 0)) return undefined;
    const id = randomUUID();
    const costPct = 2 * contract.takerFeeRate * 100 + (2 * cfg.risk.slippageBps) / 100;
    this.db.prepare(`INSERT INTO signals (id,symbol,direction,state,created_at,entry_price,strategy_version,config_version,score,components_json,reasons_json,market_json,invalidation_price,target_price,status,last_price,last_update,est_roundtrip_cost_pct,funding_rate_at_entry)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'OPEN',?,?,?,?)`).run(
      id, c.symbol, c.direction, c.state, nowMs, c.entryRef, STRATEGY_VERSION, cfgVersion, c.score,
      JSON.stringify({ components: c.components, penalties: c.penalties, unavailable: c.unavailable }),
      JSON.stringify(c.reasons),
      JSON.stringify({ metrics: c.metrics, risk: c.risk, filters: c.filters, rawScore: c.rawScore }),
      c.invalidation ?? null, c.target ?? null, c.entryRef, nowMs, costPct, fundingRate ?? null);
    logEvent(this.db, 'info', 'signal', `${c.state} ${c.direction} ${c.symbol} @ ${c.entryRef} score ${c.score}`, { id, reasons: c.reasons }, nowMs);
    return id;
  }

  openSignals(): SignalRow[] {
    return this.db.prepare("SELECT * FROM signals WHERE status='OPEN'").all() as unknown as SignalRow[];
  }

  openSymbols(): Set<string> {
    return new Set(this.openSignals().map((s) => s.symbol));
  }

  close(id: string, status: string, outcome: string, price: number, nowMs: number): void {
    this.db.prepare("UPDATE signals SET status=?, outcome=?, exit_price=?, closed_at=?, last_price=?, last_update=? WHERE id=? AND status='OPEN'")
      .run(status, outcome, price, nowMs, price, nowMs, id);
    logEvent(this.db, 'info', 'signal', `signal ${id} ${status} (${outcome}) @ ${price}`, undefined, nowMs);
  }

  /** Update every open signal for `symbol` with a new observed price and apply resolution rules. */
  onPrice(symbol: string, price: number, nowMs: number, cfg: AppConfig): void {
    const rows = this.db.prepare("SELECT * FROM signals WHERE symbol=? AND status='OPEN'").all(symbol) as unknown as SignalRow[];
    for (const s of rows) {
      const ex = updateExcursion(s.direction, s.entry_price, price, { mfePct: s.mfe_pct, maePct: s.mae_pct });
      this.db.prepare('UPDATE signals SET last_price=?, last_update=?, mfe_pct=?, mae_pct=? WHERE id=?').run(price, nowMs, ex.mfePct, ex.maePct, s.id);
      const lm = this.lastMark.get(s.id) ?? 0;
      if (nowMs - lm >= MARK_INTERVAL_MS) {
        this.db.prepare('INSERT OR IGNORE INTO signal_marks (signal_id, ts, price) VALUES (?,?,?)').run(s.id, nowMs, price);
        this.lastMark.set(s.id, nowMs);
      }
      const long = s.direction === 'LONG';
      // Resolve on the first OBSERVED price beyond a level (no assumption we got filled exactly at the level).
      if (s.invalidation_price !== null && (long ? price <= s.invalidation_price : price >= s.invalidation_price)) { this.close(s.id, 'INVALIDATED', 'INVALIDATION_LEVEL_BREACHED', price, nowMs); continue; }
      if (s.target_price !== null && s.state === 'CONFIRMED_SETUP' && (long ? price >= s.target_price : price <= s.target_price)) { this.close(s.id, 'TARGET', 'TARGET_REACHED', price, nowMs); continue; }
      const limit = s.state === 'CONFIRMED_SETUP' ? cfg.risk.maxHoldMinutes * 60_000 : WATCH_EXPIRY_MS;
      if (nowMs - s.created_at >= limit) this.close(s.id, 'EXPIRED', 'TIME_LIMIT', price, nowMs);
    }
  }

  view(s: SignalRow, nowMs: number): SignalView {
    const price = s.status === 'OPEN' ? s.last_price : (s.exit_price ?? s.last_price);
    const gross = price ? grossRoiPct(s.direction, s.entry_price, price) : null;
    const endTs = s.closed_at ?? nowMs;
    const sign = s.direction === 'LONG' ? 1 : -1;
    // Funding estimate is pro-rata over elapsed time assuming an 8h interval; clearly an estimate.
    const estFundingPct = s.funding_rate_at_entry !== null ? s.funding_rate_at_entry * 100 * sign * ((endTs - s.created_at) / FUNDING_PERIOD_MS) : 0;
    return {
      id: s.id, symbol: s.symbol, direction: s.direction, state: s.state, status: s.status, outcome: s.outcome,
      createdAt: s.created_at, entryPrice: s.entry_price, lastPrice: s.last_price, lastUpdate: s.last_update, exitPrice: s.exit_price, closedAt: s.closed_at,
      elapsedMs: endTs - s.created_at, score: s.score, strategyVersion: s.strategy_version, configVersion: s.config_version,
      grossRoiPct: gross, estNetRoiPct: gross === null ? null : gross - s.est_roundtrip_cost_pct - estFundingPct,
      estCostPct: s.est_roundtrip_cost_pct, estFundingPct, mfePct: s.mfe_pct, maePct: s.mae_pct,
      invalidation: s.invalidation_price, target: s.target_price,
      reasons: JSON.parse(s.reasons_json), components: JSON.parse(s.components_json), market: JSON.parse(s.market_json),
    };
  }

  list(opts: { symbol?: string; limit?: number; status?: string } = {}, nowMs = Date.now()): SignalView[] {
    const where: string[] = []; const args: any[] = [];
    if (opts.symbol) { where.push('symbol=?'); args.push(opts.symbol); }
    if (opts.status) { where.push('status=?'); args.push(opts.status); }
    const rows = this.db.prepare(`SELECT * FROM signals ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT ?`).all(...args, opts.limit ?? 200) as unknown as SignalRow[];
    return rows.map((r) => this.view(r, nowMs));
  }

  get(id: string, nowMs = Date.now()): (SignalView & { marks: Array<{ ts: number; price: number }> }) | undefined {
    const r = this.db.prepare('SELECT * FROM signals WHERE id=?').get(id) as unknown as SignalRow | undefined;
    if (!r) return undefined;
    const marks = this.db.prepare('SELECT ts, price FROM signal_marks WHERE signal_id=? ORDER BY ts').all(id) as unknown as Array<{ ts: number; price: number }>;
    return { ...this.view(r, nowMs), marks };
  }
}
