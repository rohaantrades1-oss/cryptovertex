// Virtual $100 paper wallet. There is deliberately NO import of any exchange client or authenticated endpoint here:
// this module cannot place real orders. All money movement is rows in the append-only `wallet_events` ledger.
import { randomUUID } from 'node:crypto';
import type { DB } from '../db.ts';
import { addNotification, getKv, logEvent } from '../db.ts';
import { STRATEGY_VERSION, type AppConfig } from '../config.ts';
import type { Candidate } from '../engine/scoring.ts';
import type { ContractInfo, Ticker } from '../mexc/types.ts';
import {
  estLiquidationPrice, floorToStep, fundingPayment, positionPnl, sizePosition, simulatedFillPrice, updateExcursion, grossRoiPct, type Direction,
} from '../calc/pnl.ts';

export interface PositionRow {
  id: string; symbol: string; direction: Direction; status: 'OPEN' | 'CLOSED'; contracts: number; contract_size: number; avg_entry: number;
  leverage: number; margin: number; entry_fees: number; funding_paid: number; realized_pnl: number; stop_price: number | null; target_price: number | null;
  est_liq_price: number | null; opened_at: number; closed_at: number | null; signal_id: string | null; strategy_version: string; config_version: number;
  last_funding_ts: number | null; mark_price: number | null; mfe_pct: number; mae_pct: number;
}

export interface Ctx {
  nowMs: number;
  cfg: AppConfig;
  cfgVersion: number;
  /** Health gate: new entries are only allowed when true. */
  actionable: boolean;
  contract: ContractInfo;
  ticker: Ticker;
  spreadBps?: number;
}

export type Notify = (n: { kind: string; title: string; body: string }) => void;

export interface OpenResult { ok: boolean; reason?: string; positionId?: string }

const EPS = 1e-9;
const FUNDING_SLOTS_UTC_H = [0, 8, 16];

export class PaperWallet {
  private db: DB;
  private notify: Notify;
  constructor(db: DB, notify: Notify = () => {}) { this.db = db; this.notify = notify; }

  initial(): number { return Number(getKv(this.db, 'wallet_initial') ?? 100); }

  cash(): number {
    const r = this.db.prepare('SELECT COALESCE(SUM(cash_delta),0) AS s FROM wallet_events').get() as { s: number };
    return this.initial() + r.s;
  }

  openPositions(): PositionRow[] {
    return this.db.prepare("SELECT * FROM positions WHERE status='OPEN'").all() as unknown as PositionRow[];
  }
  allPositions(limit = 200): PositionRow[] {
    return this.db.prepare('SELECT * FROM positions ORDER BY opened_at DESC LIMIT ?').all(limit) as unknown as PositionRow[];
  }
  position(id: string): PositionRow | undefined {
    return this.db.prepare('SELECT * FROM positions WHERE id=?').get(id) as unknown as PositionRow | undefined;
  }
  openPositionFor(symbol: string): PositionRow | undefined {
    return this.db.prepare("SELECT * FROM positions WHERE symbol=? AND status='OPEN'").get(symbol) as unknown as PositionRow | undefined;
  }

  private record(e: {
    ts: number; type: 'OPEN' | 'ADD' | 'REDUCE' | 'CLOSE' | 'REJECT' | 'FUNDING'; positionId?: string; symbol?: string; direction?: Direction; price?: number;
    contracts?: number; fees?: number; cashDelta?: number; realizedDelta?: number; reason: string; cfgVersion?: number; signalId?: string | null; inputs?: unknown;
  }): void {
    this.db.prepare(`INSERT INTO wallet_events (ts,type,position_id,symbol,direction,price,contracts,fees,cash_delta,realized_pnl_delta,reason,strategy_version,config_version,signal_id,inputs_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      e.ts, e.type, e.positionId ?? null, e.symbol ?? null, e.direction ?? null, e.price ?? null, e.contracts ?? null, e.fees ?? 0, e.cashDelta ?? 0,
      e.realizedDelta ?? 0, e.reason, STRATEGY_VERSION, e.cfgVersion ?? null, e.signalId ?? null, e.inputs === undefined ? null : JSON.stringify(e.inputs));
  }

  private reject(ctx: Ctx, c: Candidate, signalId: string | null, reason: string): OpenResult {
    this.record({ ts: ctx.nowMs, type: 'REJECT', symbol: c.symbol, direction: c.direction, price: ctx.ticker.last, reason, cfgVersion: ctx.cfgVersion, signalId, inputs: this.inputs(ctx, c) });
    return { ok: false, reason };
  }

  private inputs(ctx: Ctx, c?: Candidate) {
    return {
      ticker: { last: ctx.ticker.last, bid: ctx.ticker.bid1, ask: ctx.ticker.ask1, exchangeTs: ctx.ticker.exchangeTs, funding: ctx.ticker.fundingRate },
      spreadBps: ctx.spreadBps,
      candidate: c ? { score: c.score, state: c.state, reasons: c.reasons, metrics: c.metrics, risk: c.risk } : undefined,
    };
  }

  equity(marks: Map<string, number>): { cash: number; equity: number; unrealized: number; marginInUse: number; netEquityAfterExitFees: number } {
    const cash = this.cash();
    let margin = 0, unreal = 0, exitFees = 0;
    for (const p of this.openPositions()) {
      margin += p.margin;
      const mark = marks.get(p.symbol) ?? p.mark_price ?? p.avg_entry;
      const r = positionPnl({ direction: p.direction, contracts: p.contracts, contractSize: p.contract_size, entryPrice: p.avg_entry, markPrice: mark, leverage: p.leverage, entryFees: 0, exitFeeRate: 0, fundingPaid: 0 });
      unreal += r.grossPnl;
      exitFees += p.contract_size * p.contracts * mark * (this.takerRate(p.symbol));
    }
    return { cash, equity: cash + margin + unreal, unrealized: unreal, marginInUse: margin, netEquityAfterExitFees: cash + margin + unreal - exitFees };
  }

  private takerRates = new Map<string, number>();
  setTakerRate(symbol: string, rate: number) { this.takerRates.set(symbol, rate); }
  private takerRate(symbol: string): number { return this.takerRates.get(symbol) ?? 0; }

  /** Try to open (or add to) a virtual position for a CONFIRMED candidate. Every outcome is recorded. */
  tryOpen(c: Candidate, signalId: string | null, ctx: Ctx, marks: Map<string, number>): OpenResult {
    const { cfg } = ctx;
    this.takerRates.set(c.symbol, ctx.contract.takerFeeRate);
    if (!cfg.walletEnabled) return this.reject(ctx, c, signalId, 'wallet automation disabled in settings');
    if (c.state !== 'CONFIRMED_SETUP') return this.reject(ctx, c, signalId, `state ${c.state} is not actionable`);
    if (!ctx.actionable) return this.reject(ctx, c, signalId, 'data quality gate: feed is not LIVE');
    if (ctx.nowMs - ctx.ticker.receivedTs > cfg.dataQuality.delayedAfterMs) return this.reject(ctx, c, signalId, 'ticker older than freshness limit');
    if (!c.filters.passed) return this.reject(ctx, c, signalId, `filters failed: ${c.filters.failures.join('; ')}`);
    if (c.risk.level === 'HIGH') return this.reject(ctx, c, signalId, `risk level HIGH: ${c.risk.flags.join('; ')}`);
    if (c.stopPct === undefined || c.invalidation === undefined) return this.reject(ctx, c, signalId, 'no stop reference available');
    if (ctx.spreadBps !== undefined && ctx.spreadBps > cfg.thresholds.maxSpreadBps) return this.reject(ctx, c, signalId, `spread ${ctx.spreadBps.toFixed(1)} bps too wide`);

    const existing = this.openPositionFor(c.symbol);
    if (existing && existing.direction !== c.direction) return this.reject(ctx, c, signalId, `opposite ${existing.direction} position already open`);

    // Daily loss limit (UTC day), measured on realised net PnL.
    const dayStart = Math.floor(ctx.nowMs / 86_400_000) * 86_400_000;
    const day = this.db.prepare("SELECT COALESCE(SUM(realized_pnl_delta),0) AS s FROM wallet_events WHERE ts>=? AND type IN ('REDUCE','CLOSE')").get(dayStart) as { s: number };
    if (day.s <= -(cfg.risk.dailyLossLimitPct / 100) * this.initial()) return this.reject(ctx, c, signalId, `daily loss limit reached (${day.s.toFixed(2)} USD today)`);

    const open = this.openPositions();
    if (!existing && open.length >= cfg.risk.maxOpenPositions) return this.reject(ctx, c, signalId, `max open positions (${cfg.risk.maxOpenPositions}) reached`);

    const cd = cfg.risk.cooldownMinutesPerSymbol * 60_000;
    if (!existing) {
      const recent = this.db.prepare("SELECT closed_at FROM positions WHERE symbol=? AND status='CLOSED' ORDER BY closed_at DESC LIMIT 1").get(c.symbol) as { closed_at: number } | undefined;
      if (recent && ctx.nowMs - recent.closed_at < cd) return this.reject(ctx, c, signalId, 'symbol cooldown after recent close');
    }

    const fill = simulatedFillPrice(c.direction, 'OPEN', { bid: ctx.ticker.bid1, ask: ctx.ticker.ask1, last: ctx.ticker.last }, cfg.risk.slippageBps, ctx.contract.priceUnit);
    const eq = this.equity(marks);

    if (existing) {
      // Add only to a winner (>= 0.5R) and only with half the normal budget, never beyond the margin cap.
      const r = grossRoiPct(existing.direction, existing.avg_entry, ctx.ticker.last);
      const stopPct = Math.abs(existing.avg_entry - (existing.stop_price ?? existing.avg_entry)) / existing.avg_entry * 100;
      if (!(stopPct > 0) || r < 0.5 * stopPct) return this.reject(ctx, c, signalId, 'add rejected: position not yet >= 0.5R in profit');
      const room = eq.equity * cfg.risk.maxMarginFractionOfEquity - existing.margin;
      if (room <= 0) return this.reject(ctx, c, signalId, 'add rejected: per-position margin cap reached');
      const s = sizePosition({ spec: ctx.contract, price: fill, leverage: cfg.risk.leverage, availableBalance: Math.min(eq.cash, room), totalEquity: eq.equity, riskFractionOfEquity: cfg.risk.riskFractionOfEquity / 2, stopDistanceFrac: c.stopPct / 100, maxMarginFractionOfEquity: cfg.risk.maxMarginFractionOfEquity, feeRate: ctx.contract.takerFeeRate });
      if (!s.ok) return this.reject(ctx, c, signalId, `add rejected: ${s.reason}`);
      return this.applyAdd(existing, s.contracts, fill, ctx, c, signalId);
    }

    const s = sizePosition({ spec: ctx.contract, price: fill, leverage: cfg.risk.leverage, availableBalance: eq.cash, totalEquity: eq.equity, riskFractionOfEquity: cfg.risk.riskFractionOfEquity, stopDistanceFrac: c.stopPct / 100, maxMarginFractionOfEquity: cfg.risk.maxMarginFractionOfEquity, feeRate: ctx.contract.takerFeeRate });
    if (!s.ok) return this.reject(ctx, c, signalId, s.reason ?? 'sizing failed');
    if (s.margin + s.estEntryFee > eq.cash + EPS) return this.reject(ctx, c, signalId, 'insufficient virtual balance');

    const lev = Math.min(cfg.risk.leverage, ctx.contract.maxLeverage);
    const id = randomUUID();
    const margin = s.notional / lev;
    const fee = s.notional * ctx.contract.takerFeeRate;
    const stopPrice = fill * (1 - (c.direction === 'LONG' ? 1 : -1) * c.stopPct / 100);
    const targetPrice = fill * (1 + (c.direction === 'LONG' ? 1 : -1) * (c.stopPct * cfg.risk.targetRMultiple) / 100);
    const liq = estLiquidationPrice(c.direction, fill, lev, Number.isFinite(ctx.contract.maintenanceMarginRate) ? ctx.contract.maintenanceMarginRate : 0.01);
    this.db.exec('BEGIN');
    try {
      this.db.prepare(`INSERT INTO positions (id,symbol,direction,status,contracts,contract_size,avg_entry,leverage,margin,entry_fees,funding_paid,realized_pnl,stop_price,target_price,est_liq_price,opened_at,signal_id,strategy_version,config_version,last_funding_ts,mark_price)
        VALUES (?,?,?,'OPEN',?,?,?,?,?,?,0,0,?,?,?,?,?,?,?,?,?)`).run(id, c.symbol, c.direction, s.contracts, ctx.contract.contractSize, fill, lev, margin, fee, stopPrice, targetPrice, liq, ctx.nowMs, signalId, STRATEGY_VERSION, ctx.cfgVersion, ctx.nowMs, ctx.ticker.last);
      this.record({ ts: ctx.nowMs, type: 'OPEN', positionId: id, symbol: c.symbol, direction: c.direction, price: fill, contracts: s.contracts, fees: fee, cashDelta: -(margin + fee), reason: `Confirmed setup score ${c.score}: ${c.reasons.slice(0, 3).join(' | ')}`, cfgVersion: ctx.cfgVersion, signalId, inputs: { ...this.inputs(ctx, c), sizing: s, stop: stopPrice, target: targetPrice, estLiq: liq, leverage: lev } });
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    this.emit('POSITION_OPENED', `Opened ${c.direction} ${c.symbol}`, `${s.contracts} contracts @ ${fill} (margin $${margin.toFixed(2)}, fee $${fee.toFixed(4)}). Stop ${stopPrice.toPrecision(6)} / target ${targetPrice.toPrecision(6)}. Virtual only.`, ctx.nowMs);
    return { ok: true, positionId: id };
  }

  private applyAdd(p: PositionRow, contracts: number, fill: number, ctx: Ctx, c: Candidate, signalId: string | null): OpenResult {
    const notional = contracts * p.contract_size * fill;
    const margin = notional / p.leverage;
    const fee = notional * ctx.contract.takerFeeRate;
    const totalContracts = p.contracts + contracts;
    const avg = (p.avg_entry * p.contracts + fill * contracts) / totalContracts; // quantity-weighted (contract size constant)
    this.db.exec('BEGIN');
    try {
      this.db.prepare('UPDATE positions SET contracts=?, avg_entry=?, margin=margin+?, entry_fees=entry_fees+?, est_liq_price=? WHERE id=?')
        .run(totalContracts, avg, margin, fee, estLiquidationPrice(p.direction, avg, p.leverage, Number.isFinite(ctx.contract.maintenanceMarginRate) ? ctx.contract.maintenanceMarginRate : 0.01), p.id);
      this.record({ ts: ctx.nowMs, type: 'ADD', positionId: p.id, symbol: p.symbol, direction: p.direction, price: fill, contracts, fees: fee, cashDelta: -(margin + fee), reason: `Added to winner on new confirmed setup (score ${c.score})`, cfgVersion: ctx.cfgVersion, signalId, inputs: { ...this.inputs(ctx, c), newAvgEntry: avg } });
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    this.emit('POSITION_INCREASED', `Increased ${p.direction} ${p.symbol}`, `+${contracts} contracts @ ${fill}; new average entry ${avg.toPrecision(6)}.`, ctx.nowMs);
    return { ok: true, positionId: p.id };
  }

  /** Close `contracts` (default all) of a position at a simulated fill. Records REDUCE or CLOSE. */
  closePosition(positionId: string, contracts: number | undefined, reason: string, ctx: Ctx, opts: { forcedFill?: number; breakeven?: boolean } = {}): void {
    const p = this.position(positionId);
    if (!p || p.status !== 'OPEN') return;
    const qty = contracts === undefined ? p.contracts : Math.min(contracts, p.contracts);
    if (qty <= 0) return;
    const full = qty >= p.contracts - EPS;
    const fill = opts.forcedFill ?? simulatedFillPrice(p.direction, 'CLOSE', { bid: ctx.ticker.bid1, ask: ctx.ticker.ask1, last: ctx.ticker.last }, ctx.cfg.risk.slippageBps, ctx.contract.priceUnit);
    const frac = qty / p.contracts;
    const sign = p.direction === 'LONG' ? 1 : -1;
    const units = qty * p.contract_size;
    const gross = (fill - p.avg_entry) * units * sign;
    const exitFee = units * fill * ctx.contract.takerFeeRate;
    const marginReleased = p.margin * frac;
    const entryFeePart = p.entry_fees * frac;
    const fundingPart = p.funding_paid * frac;
    let cashDelta = marginReleased + gross - exitFee;
    // Isolated margin: a position can lose at most its allocated margin (plus fees already paid).
    if (cashDelta < 0) cashDelta = 0;
    const effectiveGross = cashDelta - marginReleased + exitFee;
    const realized = effectiveGross - exitFee - entryFeePart - fundingPart;
    this.db.exec('BEGIN');
    try {
      if (full) {
        this.db.prepare("UPDATE positions SET status='CLOSED', closed_at=?, contracts=0, margin=0, entry_fees=0, funding_paid=0, realized_pnl=realized_pnl+?, mark_price=? WHERE id=?").run(ctx.nowMs, realized, fill, p.id);
      } else {
        const stop = opts.breakeven ? p.avg_entry : p.stop_price;
        this.db.prepare('UPDATE positions SET contracts=contracts-?, margin=margin*(1-?), entry_fees=entry_fees*(1-?), funding_paid=funding_paid*(1-?), realized_pnl=realized_pnl+?, stop_price=? WHERE id=?')
          .run(qty, frac, frac, frac, realized, stop, p.id);
        if (opts.breakeven) logEvent(this.db, 'info', 'wallet', `stop for ${p.symbol} moved to breakeven ${p.avg_entry} after partial take-profit`, { positionId: p.id }, ctx.nowMs);
      }
      this.record({ ts: ctx.nowMs, type: full ? 'CLOSE' : 'REDUCE', positionId: p.id, symbol: p.symbol, direction: p.direction, price: fill, contracts: qty, fees: exitFee, cashDelta, realizedDelta: realized, reason, cfgVersion: ctx.cfgVersion, signalId: p.signal_id, inputs: { ...this.inputs(ctx), entry: p.avg_entry, gross: effectiveGross, entryFeePart, fundingPart } });
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    this.emit(full ? 'POSITION_CLOSED' : 'POSITION_REDUCED', `${full ? 'Closed' : 'Reduced'} ${p.direction} ${p.symbol}`, `${qty} contracts @ ${fill}; net realised $${realized.toFixed(3)}. Reason: ${reason}`, ctx.nowMs);
  }

  private emit(kind: string, title: string, body: string, ts: number): void {
    addNotification(this.db, kind, title, body, ts);
    this.notify({ kind, title, body });
  }

  /** Mark-to-market + rule-based management for one symbol. Called on each accepted ticker for that symbol. */
  manage(symbol: string, ctx: Ctx): void {
    const p = this.openPositionFor(symbol);
    if (!p) return;
    this.takerRates.set(symbol, ctx.contract.takerFeeRate);
    const price = ctx.ticker.last;
    const ex = updateExcursion(p.direction, p.avg_entry, price, { mfePct: p.mfe_pct, maePct: p.mae_pct });
    this.db.prepare('UPDATE positions SET mark_price=?, mfe_pct=?, mae_pct=? WHERE id=?').run(price, ex.mfePct, ex.maePct, p.id);

    this.settleFunding(p, ctx);

    const long = p.direction === 'LONG';
    if (p.est_liq_price !== null && (long ? price <= p.est_liq_price : price >= p.est_liq_price)) {
      this.closePosition(p.id, undefined, `estimated liquidation level ${p.est_liq_price.toPrecision(6)} breached (conservative estimate)`, ctx, { forcedFill: p.est_liq_price });
      return;
    }
    if (p.stop_price !== null && (long ? price <= p.stop_price : price >= p.stop_price)) { this.closePosition(p.id, undefined, `stop level ${p.stop_price.toPrecision(6)} reached`, ctx); return; }
    if (p.target_price !== null && (long ? price >= p.target_price : price <= p.target_price)) { this.closePosition(p.id, undefined, `target ${p.target_price.toPrecision(6)} reached`, ctx); return; }
    if (ctx.nowMs - p.opened_at >= ctx.cfg.risk.maxHoldMinutes * 60_000) { this.closePosition(p.id, undefined, `max hold time ${ctx.cfg.risk.maxHoldMinutes} min`, ctx); return; }

    // Documented partial rule: at +1R take half off once and move the stop to breakeven.
    const stopPct = p.stop_price !== null ? Math.abs(p.avg_entry - p.stop_price) / p.avg_entry * 100 : 0;
    const alreadyReduced = this.db.prepare("SELECT 1 FROM wallet_events WHERE position_id=? AND type='REDUCE' LIMIT 1").get(p.id);
    if (!alreadyReduced && stopPct > 0 && p.stop_price !== p.avg_entry) {
      const r = grossRoiPct(p.direction, p.avg_entry, price);
      const orig = this.originalStopPct(p);
      if (orig > 0 && r >= orig) {
        const half = floorToStep(p.contracts / 2, ctx.contract.volUnit);
        if (half >= ctx.contract.minVol && p.contracts - half >= ctx.contract.minVol) this.closePosition(p.id, half, `partial take-profit at +1R (${orig.toFixed(2)}%) then stop to breakeven`, ctx, { breakeven: true });
      }
    }
  }

  private originalStopPct(p: PositionRow): number {
    const ev = this.db.prepare("SELECT inputs_json FROM wallet_events WHERE position_id=? AND type='OPEN' LIMIT 1").get(p.id) as { inputs_json: string } | undefined;
    if (!ev?.inputs_json) return 0;
    const stop = JSON.parse(ev.inputs_json)?.stop;
    const open = this.db.prepare("SELECT price FROM wallet_events WHERE position_id=? AND type='OPEN' LIMIT 1").get(p.id) as { price: number } | undefined;
    return stop && open ? Math.abs(open.price - stop) / open.price * 100 : 0;
  }

  /** Funding is settled on the 00/08/16 UTC grid (assumption; interval per contract is not verified) using the ticker's current rate. */
  private settleFunding(p: PositionRow, ctx: Ctx): void {
    const rate = ctx.ticker.fundingRate;
    if (rate === undefined || p.last_funding_ts === null) return;
    const slots = fundingSlotsBetween(p.last_funding_ts, ctx.nowMs);
    if (!slots.length) return;
    for (const slot of slots) {
      const pay = fundingPayment(p.direction, p.contracts, p.contract_size, ctx.ticker.last, rate);
      this.db.exec('BEGIN');
      try {
        this.db.prepare('UPDATE positions SET funding_paid=funding_paid+?, last_funding_ts=? WHERE id=?').run(pay, slot, p.id);
        this.record({ ts: slot, type: 'FUNDING', positionId: p.id, symbol: p.symbol, direction: p.direction, price: ctx.ticker.last, contracts: p.contracts, cashDelta: -pay, reason: `Funding settlement (estimated: rate ${(rate * 100).toFixed(4)}% from ticker, assumes 8h UTC grid)`, cfgVersion: ctx.cfgVersion, signalId: p.signal_id });
        this.db.exec('COMMIT');
      } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    }
  }

  /** Independent recomputation: ledger cash vs cash implied by position records. */
  reconcile(): { ok: boolean; ledgerCash: number; positionsCash: number; diff: number; openPositions: number; details: string[] } {
    const ledgerCash = this.cash();
    const all = this.db.prepare('SELECT * FROM positions').all() as unknown as PositionRow[];
    let positionsCash = this.initial();
    for (const p of all) {
      positionsCash += p.realized_pnl;
      if (p.status === 'OPEN') positionsCash -= p.margin + p.entry_fees + p.funding_paid;
    }
    const diff = ledgerCash - positionsCash;
    const details: string[] = [];
    if (Math.abs(diff) > 1e-6) details.push(`cash mismatch ${diff}`);
    if (ledgerCash < -1e-6) details.push('negative cash');
    return { ok: details.length === 0, ledgerCash, positionsCash, diff, openPositions: all.filter((p) => p.status === 'OPEN').length, details };
  }

  activity(limit = 200): unknown[] {
    return this.db.prepare('SELECT * FROM wallet_events ORDER BY seq DESC LIMIT ?').all(limit);
  }

  summary(marks: Map<string, number>) {
    const e = this.equity(marks);
    const realized = (this.db.prepare('SELECT COALESCE(SUM(realized_pnl),0) AS s FROM positions').get() as { s: number }).s;
    return { initial: this.initial(), ...e, realizedPnl: realized, totalReturnPct: ((e.equity - this.initial()) / this.initial()) * 100, reconcile: this.reconcile() };
  }
}

export function fundingSlotsBetween(fromMs: number, toMs: number): number[] {
  const out: number[] = [];
  const dayStart = Math.floor(fromMs / 86_400_000) * 86_400_000;
  for (let d = dayStart; d <= toMs; d += 86_400_000) for (const h of FUNDING_SLOTS_UTC_H) {
    const t = d + h * 3_600_000;
    if (t > fromMs && t <= toMs) out.push(t);
  }
  return out;
}
