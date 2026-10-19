// Synthetic candidates / tickers: these tests exercise accounting and risk logic, not market behaviour.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, logEvent } from '../src/db.ts';
import { PaperWallet, fundingSlotsBetween, type Ctx } from '../src/wallet/paper.ts';
import { SignalTracker } from '../src/signals.ts';
import { DEFAULT_CONFIG, mergeConfig } from '../src/config.ts';
import type { Candidate } from '../src/engine/scoring.ts';
import type { ContractInfo, Ticker } from '../src/mexc/types.ts';

const T0 = Date.UTC(2026, 9, 18, 9, 0, 0); // 09:00 UTC, after the 08:00 funding slot

const contract: ContractInfo = {
  symbol: 'SYN_USDT', contractSize: 1, volUnit: 1, minVol: 1, maxVol: 1e9, priceUnit: 0.0001, takerFeeRate: 0.0002, makerFeeRate: 0,
  maxLeverage: 20, maintenanceMarginRate: 0.005, baseCoin: 'SYN', quoteCoin: 'USDT', settleCoin: 'USDT', state: 0, futureType: 1, isNew: false,
};

function ticker(last: number, ts = T0, over: Partial<Ticker> = {}): Ticker {
  return { symbol: 'SYN_USDT', last, bid1: last * 0.9999, ask1: last * 1.0001, fundingRate: 0.0001, exchangeTs: ts, receivedTs: ts, source: 'ws', ...over };
}
function ctx(price: number, ts = T0, over: Partial<Ctx> = {}, tk: Partial<Ticker> = {}): Ctx {
  return { nowMs: ts, cfg: DEFAULT_CONFIG, cfgVersion: 1, actionable: true, contract, ticker: ticker(price, ts, tk), spreadBps: 2, ...over };
}
function cand(direction: 'LONG' | 'SHORT' = 'LONG', over: Partial<Candidate> = {}): Candidate {
  const entry = 10;
  const s = direction === 'LONG' ? 1 : -1;
  return {
    symbol: 'SYN_USDT', direction, state: 'CONFIRMED_SETUP', score: 80, rawScore: 80, components: [], penalties: [], reasons: ['synthetic reason'], unavailable: [],
    filters: { passed: true, failures: [] }, risk: { level: 'LOW', flags: [] }, entryRef: entry, invalidation: entry * (1 - s * 0.02), target: entry * (1 + s * 0.04),
    stopPct: 2, metrics: {}, confirmed: true, evaluatedAt: T0, ...over,
  };
}
const marks = new Map<string, number>();
const close = (a: number, b: number, e = 1e-7) => assert.ok(Math.abs(a - b) < e, `${a} !~ ${b}`);

test('new wallet starts at exactly $100.00 and reconciles', () => {
  const db = openDb(':memory:');
  const w = new PaperWallet(db);
  assert.equal(w.cash(), 100);
  const r = w.reconcile();
  assert.ok(r.ok);
  assert.equal(w.summary(marks).equity, 100);
});

test('open long: debits margin+fee, records an OPEN event and a notification, respects risk budget', () => {
  const db = openDb(':memory:');
  const seen: string[] = [];
  const w = new PaperWallet(db, (n) => seen.push(n.kind));
  const res = w.tryOpen(cand(), null, ctx(10), marks);
  assert.ok(res.ok, res.reason);
  const p = w.openPositionFor('SYN_USDT')!;
  assert.ok(Number.isInteger(p.contracts));
  assert.ok(p.avg_entry >= 10, 'long fills at or above ask');
  const notional = p.contracts * p.avg_entry;
  close(p.margin, notional / 5, 1e-6);
  close(w.cash(), 100 - p.margin - p.entry_fees, 1e-6);
  const riskAtStop = notional * (0.02 + 2 * 0.0002);
  assert.ok(riskAtStop <= 2.0001, `risk ${riskAtStop}`);
  assert.ok(p.margin <= 25.0001);
  assert.deepEqual(seen, ['POSITION_OPENED']);
  assert.equal((db.prepare("SELECT COUNT(*) c FROM wallet_events WHERE type='OPEN'").get() as any).c, 1);
  assert.ok(w.reconcile().ok);
  const row = db.prepare("SELECT * FROM wallet_events WHERE type='OPEN'").get() as any;
  assert.equal(row.strategy_version, 'vh-1.0.0');
  assert.ok(JSON.parse(row.inputs_json).ticker.last === 10);
});

test('rejections are recorded and leave balance untouched', () => {
  const db = openDb(':memory:');
  const w = new PaperWallet(db);
  assert.equal(w.tryOpen(cand(), null, ctx(10, T0, { actionable: false }), marks).ok, false);
  assert.equal(w.tryOpen(cand('LONG', { filters: { passed: false, failures: ['late entry'] } }), null, ctx(10), marks).ok, false);
  assert.equal(w.tryOpen(cand('LONG', { risk: { level: 'HIGH', flags: ['x'] } }), null, ctx(10), marks).ok, false);
  assert.equal(w.tryOpen(cand('LONG', { state: 'LONG_WATCH' }), null, ctx(10), marks).ok, false);
  assert.equal(w.tryOpen(cand(), null, ctx(10, T0, { cfg: mergeConfig(DEFAULT_CONFIG, { walletEnabled: false }) }), marks).ok, false);
  assert.equal(w.tryOpen(cand(), null, ctx(10, T0 + 60_000, {}, { receivedTs: T0 - 60_000 }), marks).ok, false);
  assert.equal(w.cash(), 100);
  assert.equal((db.prepare("SELECT COUNT(*) c FROM wallet_events WHERE type='REJECT'").get() as any).c, 6);
  assert.equal(w.openPositions().length, 0);
});

test('minimum order size rejection for large-contract-size markets', () => {
  const db = openDb(':memory:');
  const w = new PaperWallet(db);
  const big: ContractInfo = { ...contract, contractSize: 0.01, minVol: 1 };
  const res = w.tryOpen(cand('LONG', { entryRef: 70000 }), null, { ...ctx(70000), contract: big }, marks);
  assert.equal(res.ok, false);
  assert.match(res.reason ?? '', /minimum/);
  assert.equal(w.cash(), 100);
});

test('stop-out realises a loss; wallet reconciles; position closed with CLOSE event', () => {
  const db = openDb(':memory:');
  const w = new PaperWallet(db);
  w.tryOpen(cand(), null, ctx(10), marks);
  const p = w.openPositionFor('SYN_USDT')!;
  w.manage('SYN_USDT', ctx(9.79, T0 + 60_000)); // just through the stop; the fill includes spread + slippage
  assert.equal(w.openPositions().length, 0);
  const closed = w.position(p.id)!;
  assert.equal(closed.status, 'CLOSED');
  assert.ok(closed.realized_pnl < 0);
  close(w.cash(), 100 + closed.realized_pnl, 1e-6);
  assert.ok(Math.abs(closed.realized_pnl) <= 2.6, `loss bounded near risk budget (slippage makes it exceed 2.0): ${closed.realized_pnl}`);
  assert.ok(Math.abs(closed.realized_pnl) > 2.0, 'realistic fills lose slightly more than the nominal risk budget');
  assert.ok(w.reconcile().ok);
  assert.equal((db.prepare("SELECT COUNT(*) c FROM wallet_events WHERE type='CLOSE'").get() as any).c, 1);
});

test('partial take-profit at +1R reduces half and moves stop to breakeven; then target closes the rest', () => {
  const db = openDb(':memory:');
  const seen: string[] = [];
  const w = new PaperWallet(db, (n) => seen.push(n.kind));
  w.tryOpen(cand(), null, ctx(10), marks);
  const p0 = w.openPositionFor('SYN_USDT')!;
  w.manage('SYN_USDT', ctx(10.25, T0 + 60_000));
  const p1 = w.openPositionFor('SYN_USDT')!;
  assert.ok(p1.contracts < p0.contracts && p1.contracts >= 1);
  assert.equal(p1.stop_price, p0.avg_entry);
  assert.ok(p1.realized_pnl > 0);
  assert.ok(w.reconcile().ok, JSON.stringify(w.reconcile()));
  w.manage('SYN_USDT', ctx(10.5, T0 + 120_000));
  assert.equal(w.openPositions().length, 0);
  assert.deepEqual(seen, ['POSITION_OPENED', 'POSITION_REDUCED', 'POSITION_CLOSED']);
  assert.ok(w.cash() > 100);
  assert.ok(w.reconcile().ok);
});

test('short position profits when price falls and is stopped when it rises', () => {
  const db = openDb(':memory:');
  const w = new PaperWallet(db);
  w.tryOpen(cand('SHORT'), null, ctx(10), marks);
  const p = w.openPositionFor('SYN_USDT')!;
  assert.ok(p.avg_entry <= 10, 'short fills at or below bid');
  w.manage('SYN_USDT', ctx(9.5, T0 + 60_000));
  assert.equal(w.openPositions().length, 0);
  assert.ok(w.position(p.id)!.realized_pnl > 0);
  assert.ok(w.reconcile().ok);
});

test('funding settles once per 8h slot, long pays on positive rate, ledger reconciles', () => {
  const db = openDb(':memory:');
  const w = new PaperWallet(db);
  const cfg = mergeConfig(DEFAULT_CONFIG, { risk: { maxHoldMinutes: 2000 } });
  w.tryOpen(cand(), null, ctx(10, T0, { cfg }), marks);
  const before = w.cash();
  w.manage('SYN_USDT', ctx(10.01, Date.UTC(2026, 9, 18, 16, 0, 5), { cfg }));
  const p = w.openPositionFor('SYN_USDT')!;
  assert.ok(p.funding_paid > 0);
  assert.ok(w.cash() < before);
  w.manage('SYN_USDT', ctx(10.01, Date.UTC(2026, 9, 18, 16, 0, 9), { cfg }));
  assert.equal((db.prepare("SELECT COUNT(*) c FROM wallet_events WHERE type='FUNDING'").get() as any).c, 1);
  assert.ok(w.reconcile().ok);
  assert.deepEqual(fundingSlotsBetween(Date.UTC(2026, 9, 18, 7), Date.UTC(2026, 9, 19, 1)).map((t) => new Date(t).getUTCHours()), [8, 16, 0]);
});

test('max open positions, opposite-direction and cooldown rules', () => {
  const db = openDb(':memory:');
  const cfg = mergeConfig(DEFAULT_CONFIG, { risk: { maxOpenPositions: 1 } });
  const w = new PaperWallet(db);
  assert.ok(w.tryOpen(cand(), null, ctx(10, T0, { cfg }), marks).ok);
  const other: Candidate = { ...cand(), symbol: 'OTH_USDT' };
  const r = w.tryOpen(other, null, { ...ctx(10, T0, { cfg }), ticker: { ...ticker(10), symbol: 'OTH_USDT' }, contract: { ...contract, symbol: 'OTH_USDT' } }, marks);
  assert.equal(r.ok, false);
  assert.match(r.reason ?? '', /max open/);
  assert.equal(w.tryOpen(cand('SHORT'), null, ctx(10, T0, { cfg }), marks).ok, false);
  w.manage('SYN_USDT', ctx(9.5, T0 + 1000, { cfg }));
  const again = w.tryOpen(cand(), null, ctx(10, T0 + 2000, { cfg }), marks);
  assert.equal(again.ok, false);
  assert.match(again.reason ?? '', /cooldown/);
});

test('daily loss limit blocks new entries', () => {
  const db = openDb(':memory:');
  const cfg = mergeConfig(DEFAULT_CONFIG, { risk: { dailyLossLimitPct: 1, cooldownMinutesPerSymbol: 0 } });
  const w = new PaperWallet(db);
  w.tryOpen(cand(), null, ctx(10, T0, { cfg }), marks);
  w.manage('SYN_USDT', ctx(9.5, T0 + 1000, { cfg }));
  const r = w.tryOpen(cand(), null, ctx(10, T0 + 5000, { cfg }), marks);
  assert.equal(r.ok, false);
  assert.match(r.reason ?? '', /daily loss/);
});

test('add-to-winner only when >= 0.5R in profit; average entry is quantity-weighted', () => {
  const db = openDb(':memory:');
  const cfg = mergeConfig(DEFAULT_CONFIG, { risk: { riskFractionOfEquity: 0.01, maxMarginFractionOfEquity: 0.6 } });
  const w = new PaperWallet(db);
  w.tryOpen(cand(), null, ctx(10, T0, { cfg }), marks);
  const rej = w.tryOpen(cand(), null, ctx(10, T0 + 1000, { cfg }), marks);
  assert.equal(rej.ok, false);
  assert.match(rej.reason ?? '', /0\.5R/);
  const p0 = w.openPositionFor('SYN_USDT')!;
  const res = w.tryOpen(cand('LONG', { entryRef: 10.15 }), null, ctx(10.15, T0 + 2000, { cfg }), marks);
  assert.ok(res.ok, res.reason);
  const p1 = w.openPositionFor('SYN_USDT')!;
  assert.ok(p1.contracts > p0.contracts);
  assert.ok(p1.avg_entry > p0.avg_entry && p1.avg_entry < 10.17);
  assert.ok(w.reconcile().ok);
});

test('estimated liquidation clips the loss at allocated margin and still reconciles', () => {
  const db = openDb(':memory:');
  const cfg = mergeConfig(DEFAULT_CONFIG, { risk: { leverage: 20, minStopPct: 6, maxStopPct: 6 } });
  const w = new PaperWallet(db);
  assert.ok(w.tryOpen(cand('LONG', { stopPct: 6, invalidation: 9.4 }), null, ctx(10, T0, { cfg }), marks).ok);
  const p = w.openPositionFor('SYN_USDT')!;
  w.manage('SYN_USDT', ctx(8, T0 + 1000, { cfg }));
  const closed = w.position(p.id)!;
  assert.equal(closed.status, 'CLOSED');
  assert.ok(closed.realized_pnl >= -(p.margin + p.entry_fees + 1e-6));
  assert.ok(w.reconcile().ok);
  assert.ok(w.cash() > 0);
});

test('ledger and audit tables are append-only', () => {
  const db = openDb(':memory:');
  const w = new PaperWallet(db);
  w.tryOpen(cand(), null, ctx(10), marks);
  logEvent(db, 'info', 'test', 'row so the trigger has something to block');
  assert.throws(() => db.exec("UPDATE wallet_events SET price=1"), /append-only/);
  assert.throws(() => db.exec('DELETE FROM wallet_events'), /append-only/);
  assert.throws(() => db.exec("UPDATE events SET message='x'"), /append-only/);
});

test('wallet and history survive a restart (file-backed DB)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vh-'));
  try {
    const path = join(dir, 'vh.db');
    let db = openDb(path);
    let w = new PaperWallet(db);
    w.tryOpen(cand(), null, ctx(10), marks);
    const cashBefore = w.cash();
    const pBefore = w.openPositionFor('SYN_USDT')!;
    db.close();
    db = openDb(path);
    w = new PaperWallet(db);
    assert.equal(w.cash(), cashBefore);
    const pAfter = w.openPositionFor('SYN_USDT')!;
    assert.equal(pAfter.id, pBefore.id);
    assert.equal(pAfter.avg_entry, pBefore.avg_entry);
    assert.equal(w.initial(), 100, 'initial balance not reset by restart');
    assert.ok(w.reconcile().ok);
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('no wallet code path imports an exchange/trading client', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/wallet/paper.ts', import.meta.url), 'utf8');
  assert.equal(/from ['"][^'"]*mexc[^'"]*['"]/.test(src.replace(/import type[^\n]*\n/g, '')), false, 'only type imports from mexc types are allowed');
  assert.equal(/fetch\(|WebSocket|api[_-]?key|secret/i.test(src), false);
});

// ---------------------------------------------------------------- signals

test('signal ROI uses recorded entry; gross vs net; excursions; immutability', () => {
  const db = openDb(':memory:');
  const st = new SignalTracker(db);
  const id = st.create(cand('LONG', { state: 'CONFIRMED_SETUP' }), DEFAULT_CONFIG, 1, contract, 0.0001, T0)!;
  assert.ok(id);
  st.onPrice('SYN_USDT', 10.1, T0 + 1000, DEFAULT_CONFIG);
  st.onPrice('SYN_USDT', 9.9, T0 + 2000, DEFAULT_CONFIG);
  st.onPrice('SYN_USDT', 10.05, T0 + 3000, DEFAULT_CONFIG);
  const v = st.get(id, T0 + 3000)!;
  close(v.entryPrice, 10);
  close(v.grossRoiPct!, 0.5, 1e-9);
  assert.ok(v.estNetRoiPct! < v.grossRoiPct!);
  close(v.mfePct, 1, 1e-9);
  close(v.maePct, -1, 1e-9);
  assert.throws(() => db.prepare('UPDATE signals SET entry_price=9 WHERE id=?').run(id), /immutable/);
  assert.throws(() => db.prepare('UPDATE signals SET created_at=1 WHERE id=?').run(id), /immutable/);
});

test('short signal ROI sign and resolution at invalidation / target', () => {
  const db = openDb(':memory:');
  const st = new SignalTracker(db);
  const a = st.create(cand('SHORT'), DEFAULT_CONFIG, 1, contract, undefined, T0)!;
  st.onPrice('SYN_USDT', 9.5, T0 + 1000, DEFAULT_CONFIG);
  const va = st.get(a, T0 + 1000)!;
  close(va.grossRoiPct!, 5, 1e-9);
  assert.equal(va.status, 'TARGET');
  const b = st.create(cand('SHORT'), DEFAULT_CONFIG, 1, contract, undefined, T0 + 7_200_000)!;
  st.onPrice('SYN_USDT', 10.3, T0 + 7_201_000, DEFAULT_CONFIG);
  assert.equal(st.get(b)!.status, 'INVALIDATED');
  assert.ok(st.get(b)!.grossRoiPct! < 0);
});

test('duplicate signals and cooldown are suppressed; expiry works', () => {
  const db = openDb(':memory:');
  const st = new SignalTracker(db);
  assert.ok(st.create(cand(), DEFAULT_CONFIG, 1, contract, undefined, T0));
  assert.equal(st.create(cand(), DEFAULT_CONFIG, 1, contract, undefined, T0 + 1000), undefined, 'open duplicate');
  st.onPrice('SYN_USDT', 10.5, T0 + 2000, DEFAULT_CONFIG); // target hit -> closed
  assert.equal(st.create(cand(), DEFAULT_CONFIG, 1, contract, undefined, T0 + 3000), undefined, 'inside cooldown');
  assert.ok(st.create(cand(), DEFAULT_CONFIG, 1, contract, undefined, T0 + 2 * 3600_000), 'allowed after cooldown');
  st.onPrice('SYN_USDT', 10, T0 + 8 * 3600_000, DEFAULT_CONFIG);
  assert.equal(st.list({ status: 'EXPIRED' }).length, 1);
});

test('signals persist across restart and keep their entry price', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vh-'));
  try {
    const path = join(dir, 'vh.db');
    let db = openDb(path);
    const id = new SignalTracker(db).create(cand(), DEFAULT_CONFIG, 1, contract, undefined, T0)!;
    db.close();
    db = openDb(path);
    const v = new SignalTracker(db).get(id)!;
    assert.equal(v.entryPrice, 10);
    assert.equal(v.createdAt, T0);
    assert.equal(v.status, 'OPEN');
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
