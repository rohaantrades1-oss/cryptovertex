// End-to-end paper-trading flow over SYNTHETIC feed data (no network): store -> scanner -> signal -> wallet -> exit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.ts';
import { MarketStore } from '../src/market.ts';
import { Runner } from '../src/engine/runner.ts';
import { PaperWallet } from '../src/wallet/paper.ts';
import { SignalTracker } from '../src/signals.ts';
import { NOW_MS, build5m, aggregate, contract } from './helpers.ts';

function setup(opts: { now?: () => number; wsConnected?: boolean; seedOi?: boolean } = {}) {
  const db = openDb(':memory:');
  const store = new MarketStore(60_000);
  store.setContracts([contract]);
  const c5 = build5m({ surge: 'up' });
  const last = c5[c5.length - 1].c;
  store.mergeCandles('SYN_USDT', 'Min5', c5);
  store.mergeCandles('SYN_USDT', 'Min15', aggregate(c5, 3, 900));
  store.mergeCandles('SYN_USDT', 'Min60', aggregate(c5, 12, 3600));
  if (opts.seedOi !== false) store.history.set('SYN_USDT', [{ ts: NOW_MS - 30 * 60_000, last: last / 1.012, hold: 1_000_000 / 1.03, vol24: 1 }]);
  const tk = (price: number, ts: number) => ({ symbol: 'SYN_USDT', last: price, bid1: price * 0.9999, ask1: price * 1.0001, volume24: 300_000, holdVol: 1_000_000, fundingRate: 0.00005, riseFallRate: 0.02, exchangeTs: ts, receivedTs: ts, source: 'ws' as const });
  const notes: string[] = [];
  const wallet = new PaperWallet(db, (n) => notes.push(n.kind));
  const tracker = new SignalTracker(db);
  const clock = { t: NOW_MS };
  const runner = new Runner({
    db, store, wallet, tracker, rest: {} as any,
    ws: { connected: opts.wsConnected ?? true } as any,
    now: opts.now ?? (() => clock.t),
  });
  return { db, store, wallet, tracker, runner, tk, clock, notes, last };
}

test('LIVE feed: confirmed setup creates a persisted signal and a virtual position, then target exit is recorded', async () => {
  const s = setup();
  s.runner.ingest([s.tk(s.last, NOW_MS)]);
  assert.equal(s.runner.health.state, 'LIVE');
  await s.runner.scanOnce(NOW_MS);

  const entry = s.runner.shortlist.get('SYN_USDT');
  assert.ok(entry, 'candidate on shortlist');
  assert.equal(entry!.candidate.state, 'CONFIRMED_SETUP', JSON.stringify(entry!.candidate.filters));
  const sigs = s.tracker.list({ symbol: 'SYN_USDT' }, NOW_MS);
  const confirmed = sigs.find((x) => x.state === 'CONFIRMED_SETUP')!;
  assert.ok(confirmed, 'signal persisted');
  assert.equal(confirmed.entryPrice, s.last, 'entry price is the live price at signal time');
  assert.ok(confirmed.reasons.length > 0);

  const pos = s.wallet.openPositionFor('SYN_USDT');
  assert.ok(pos, 'paper position opened: ' + JSON.stringify(s.wallet.activity(3)));
  assert.equal(pos!.signal_id, confirmed.id, 'wallet action traceable to the signal');
  assert.deepEqual(s.notes, ['POSITION_OPENED']);

  // price reaches target -> signal and position both resolve through the normal ingest path
  const target = confirmed.target!;
  s.clock.t = NOW_MS + 30_000;
  s.runner.ingest([s.tk(target * 1.001, NOW_MS + 30_000)]);
  assert.equal(s.tracker.get(confirmed.id)!.status, 'TARGET');
  assert.equal(s.wallet.openPositions().length, 0);
  assert.ok(s.wallet.cash() > 100, 'winning trade grows the virtual balance');
  assert.ok(s.wallet.reconcile().ok);
  assert.ok(s.notes.includes('POSITION_CLOSED') || s.notes.includes('POSITION_REDUCED'));
});

test('NOT LIVE (websocket down): shortlist may update but no signals and no paper entries are created', async () => {
  const s = setup({ wsConnected: false });
  s.runner.ingest([s.tk(s.last, NOW_MS)]);
  assert.notEqual(s.runner.health.state, 'LIVE');
  assert.equal(s.runner.health.actionable, false);
  await s.runner.scanOnce(NOW_MS);
  assert.equal(s.tracker.list().length, 0);
  assert.equal(s.wallet.openPositions().length, 0);
  assert.equal(s.wallet.cash(), 100);
});

test('STALE feed: no actionable signals', async () => {
  const clock = { t: NOW_MS };
  const s = setup({ now: () => clock.t });
  s.runner.ingest([s.tk(s.last, NOW_MS)]);
  clock.t = NOW_MS + 60_000;
  s.runner.updateHealth();
  assert.equal(s.runner.health.state, 'STALE');
  await s.runner.scanOnce(NOW_MS + 60_000);
  assert.equal(s.tracker.list().length, 0);
});

test('missing open-interest history: scored without it and reported unavailable (no invented value)', async () => {
  const s = setup({ seedOi: false });
  s.runner.ingest([s.tk(s.last, NOW_MS)]);
  await s.runner.scanOnce(NOW_MS);
  const c = s.runner.shortlist.get('SYN_USDT')!.candidate;
  assert.ok(c.unavailable.some((u) => u.startsWith('openInterest')));
  assert.equal(c.components.find((x) => x.key === 'openInterest')!.available, false);
});

test('restart recovery: signals, positions and balance survive; reconciliation still passes', async () => {
  const s = setup();
  s.runner.ingest([s.tk(s.last, NOW_MS)]);
  await s.runner.scanOnce(NOW_MS);
  const cash = s.wallet.cash();
  const sigCount = s.tracker.list().length;
  const posId = s.wallet.openPositionFor('SYN_USDT')!.id;
  // "restart": new wallet/tracker objects over the same database
  const wallet2 = new PaperWallet(s.db);
  const tracker2 = new SignalTracker(s.db);
  assert.equal(wallet2.cash(), cash);
  assert.equal(tracker2.list().length, sigCount);
  assert.equal(wallet2.openPositionFor('SYN_USDT')!.id, posId);
  assert.ok(wallet2.reconcile().ok);
});

test('duplicate ticker events do not duplicate signals or positions', async () => {
  const s = setup();
  for (let i = 0; i < 3; i++) s.runner.ingest([s.tk(s.last, NOW_MS)]);
  await s.runner.scanOnce(NOW_MS);
  await s.runner.scanOnce(NOW_MS + 3000);
  assert.equal(s.tracker.list().filter((x) => x.state === 'CONFIRMED_SETUP').length, 1);
  assert.equal(s.wallet.openPositions().length, 1);
  assert.equal(s.store.stats.duplicates, 2);
});
