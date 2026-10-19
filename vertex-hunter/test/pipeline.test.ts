// NOTE: all payloads in this file are SYNTHETIC fixtures written to match MEXC's documented response shapes.
// They are not recorded exchange data. Live validation is done by `npm run probe` against the real API.
import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { parseContracts, parseTickers, parseKlines, parseDepth, unwrap, isEligible, ApiError } from '../src/mexc/parse.ts';
import { MexcRest, RateLimiter } from '../src/mexc/rest.ts';
import { MexcWs, type WsLike } from '../src/mexc/ws.ts';
import { computeHealth } from '../src/health.ts';
import { MarketStore } from '../src/market.ts';

const NOW = 1_800_000_000_000;

test('parseContracts drops rows missing precision data and flags eligibility', () => {
  const { contracts, dropped } = parseContracts([
    { symbol: 'AAA_USDT', contractSize: 1, volUnit: 1, minVol: 1, maxVol: 1e6, priceUnit: 0.0001, takerFeeRate: 0.0002, makerFeeRate: 0, maxLeverage: 50, maintenanceMarginRate: 0.005, baseCoin: 'AAA', quoteCoin: 'USDT', settleCoin: 'USDT', state: 0, futureType: 1 },
    { symbol: 'BAD_USDT', contractSize: 0, volUnit: 1, minVol: 1, priceUnit: 0.1 },
    { symbol: 'OFF_USDT', contractSize: 1, volUnit: 1, minVol: 1, priceUnit: 0.1, takerFeeRate: 0.0002, baseCoin: 'OFF', quoteCoin: 'USDT', settleCoin: 'USDT', state: 4, futureType: 1 },
  ]);
  assert.equal(contracts.length, 2);
  assert.equal(dropped, 1);
  assert.equal(isEligible(contracts[0]).ok, true);
  assert.equal(isEligible(contracts[1]).ok, false);
});

test('missing taker fee makes a contract ineligible rather than guessed', () => {
  const { contracts } = parseContracts([{ symbol: 'X_USDT', contractSize: 1, volUnit: 1, minVol: 1, priceUnit: 0.1, baseCoin: 'X', quoteCoin: 'USDT', settleCoin: 'USDT', state: 0, futureType: 1 }]);
  assert.match(isEligible(contracts[0]).reason ?? '', /fee/);
});

test('parseTickers keeps unavailable fields undefined, not zero', () => {
  const { tickers, dropped } = parseTickers([
    { symbol: 'A_USDT', lastPrice: 1.5, timestamp: NOW },
    { symbol: 'B_USDT', lastPrice: -1, timestamp: NOW },
    { symbol: 'C_USDT', lastPrice: 2 },
  ], NOW, 'ws');
  assert.equal(tickers.length, 1);
  assert.equal(dropped, 2);
  assert.equal(tickers[0].holdVol, undefined);
  assert.equal(tickers[0].bid1, undefined);
});

test('parseKlines sorts, dedupes and drops malformed candles', () => {
  const { candles, dropped } = parseKlines({
    time: [300, 60, 60, 120, 180],
    open: [1, 1, 1.1, 1, 1], high: [2, 2, 2, 0.5, 2], low: [0.5, 0.5, 0.5, 0.6, 0.5], close: [1.5, 1.2, 1.3, 1, 1], vol: [10, 5, 6, 7, -1],
  });
  assert.deepEqual(candles.map((c) => c.t), [60, 300]);
  assert.equal(candles[0].c, 1.3, 'later duplicate wins');
  assert.equal(dropped, 2); // bad high<low and negative volume
});

test('parseDepth reads [price, orders, qty] rows and rejects empty books', () => {
  const d = parseDepth('A_USDT', { bids: [[1, 3, 100]], asks: [[1.1, 2, 50]], timestamp: NOW }, NOW);
  assert.equal(d?.bids[0][1], 100);
  assert.equal(parseDepth('A_USDT', { bids: [], asks: [] }, NOW), undefined);
});

test('unwrap throws retryable error on MEXC rate-limit code', () => {
  assert.throws(() => unwrap({ success: false, code: 510, message: 'too frequent' }), (e: any) => e instanceof ApiError && e.retryable);
  assert.throws(() => unwrap({ success: false, code: 600 }), (e: any) => e instanceof ApiError && !e.retryable);
  assert.deepEqual(unwrap({ success: true, code: 0, data: [1] }), [1]);
});

test('RateLimiter never exceeds max calls per window', async () => {
  let t = 0;
  const sleeps: number[] = [];
  const rl = new RateLimiter(3, 1000, () => t, async (ms) => { sleeps.push(ms); t += ms; });
  const stamps: number[] = [];
  for (let i = 0; i < 7; i++) { await rl.acquire(); stamps.push(t); }
  for (let i = 3; i < stamps.length; i++) assert.ok(stamps[i] - stamps[i - 3] >= 1000, `window violated at ${i}`);
});

test('REST retries 5xx then succeeds; reports stats', async () => {
  let calls = 0;
  const rest = new MexcRest({
    baseUrl: 'http://x',
    sleep: async () => {},
    fetchImpl: (async () => {
      calls++;
      if (calls < 3) return new Response('err', { status: 503 });
      return new Response(JSON.stringify({ success: true, code: 0, data: [{ symbol: 'A_USDT', lastPrice: 1, timestamp: Date.now() }] }), { status: 200 });
    }) as any,
  });
  const r = await rest.tickers();
  assert.equal(r.tickers.length, 1);
  assert.equal(calls, 3);
  assert.equal(rest.stats.retries, 2);
  assert.ok(rest.stats.lastOkTs);
});

test('REST gives up on non-retryable errors and surfaces them', async () => {
  const rest = new MexcRest({ baseUrl: 'http://x', sleep: async () => {}, fetchImpl: (async () => new Response('nope', { status: 404 })) as any });
  await assert.rejects(rest.tickers(), /HTTP 404/);
  assert.match(rest.stats.lastError ?? '', /404/);
});

test('REST gives up after maxRetries on persistent 429', async () => {
  let calls = 0;
  const rest = new MexcRest({ baseUrl: 'http://x', maxRetries: 2, sleep: async () => {}, fetchImpl: (async () => { calls++; return new Response('', { status: 429 }); }) as any });
  await assert.rejects(rest.tickers(), /429/);
  assert.equal(calls, 3);
  assert.equal(rest.stats.rateLimited, 3);
});

test('health state machine', () => {
  const lim = { delayedAfterMs: 5000, staleAfterMs: 20000 };
  const base = { wsConnected: true, lastTickerReceivedTs: NOW, restConsecutiveFailures: 0, contractsLoaded: true };
  assert.equal(computeHealth(base, lim, NOW + 1000).state, 'LIVE');
  assert.equal(computeHealth(base, lim, NOW + 1000).actionable, true);
  assert.equal(computeHealth(base, lim, NOW + 8000).state, 'DELAYED');
  assert.equal(computeHealth(base, lim, NOW + 25000).state, 'STALE');
  assert.equal(computeHealth({ ...base, wsConnected: false }, lim, NOW + 1000).state, 'DELAYED');
  assert.equal(computeHealth({ ...base, wsConnected: false, restConsecutiveFailures: 3 }, lim, NOW + 1000).state, 'DISCONNECTED');
  assert.equal(computeHealth({ ...base, lastTickerReceivedTs: null }, lim, NOW).state, 'DISCONNECTED');
  for (const s of [8000, 25000]) assert.equal(computeHealth(base, lim, NOW + s).actionable, false);
});

test('store rejects duplicates, out-of-order and implausible exchange timestamps', () => {
  const s = new MarketStore(60_000);
  const mk = (over: any = {}) => ({ symbol: 'A_USDT', last: 1, exchangeTs: NOW, receivedTs: NOW, source: 'ws' as const, volume24: 10, ...over });
  assert.equal(s.ingestTicker(mk()), true);
  assert.equal(s.ingestTicker(mk()), false);
  assert.equal(s.stats.duplicates, 1);
  assert.equal(s.ingestTicker(mk({ exchangeTs: NOW - 1000 })), false);
  assert.equal(s.stats.outOfOrder, 1);
  assert.equal(s.ingestTicker(mk({ exchangeTs: NOW + 3_600_000 })), false);
  assert.equal(s.stats.badTimestamp, 1);
  assert.equal(s.ingestTicker(mk({ exchangeTs: NOW + 1000, last: 1.1, receivedTs: NOW + 1000 }), NOW + 1000), true);
});

test('partial WS ticker does not erase REST-only fields', () => {
  const s = new MarketStore();
  s.ingestTicker({ symbol: 'A_USDT', last: 1, exchangeTs: NOW, receivedTs: NOW, source: 'rest', holdVol: 500, bid1: 0.99, ask1: 1.01 });
  s.ingestTicker({ symbol: 'A_USDT', last: 1.02, exchangeTs: NOW + 1000, receivedTs: NOW + 1000, source: 'ws' }, NOW + 1000);
  const t = s.tickers.get('A_USDT')!;
  assert.equal(t.last, 1.02);
  assert.equal(t.holdVol, 500);
  assert.equal(t.bid1, 0.99);
});

test('mergeCandles dedupes by open time and closedCandles excludes the forming bar', () => {
  const s = new MarketStore();
  s.mergeCandles('A_USDT', 'Min5', [{ t: 0, o: 1, h: 2, l: 1, c: 1.5, v: 1 }, { t: 300, o: 1, h: 2, l: 1, c: 1.5, v: 1 }]);
  s.mergeCandles('A_USDT', 'Min5', [{ t: 300, o: 1, h: 3, l: 1, c: 2.5, v: 9 }, { t: 600, o: 2, h: 2, l: 2, c: 2, v: 1 }]);
  const all = s.getCandles('A_USDT', 'Min5');
  assert.deepEqual(all.map((c) => c.t), [0, 300, 600]);
  assert.equal(all[1].v, 9);
  assert.deepEqual(s.closedCandles('A_USDT', 'Min5', 650).map((c) => c.t), [0, 300]);
});

class FakeSocket implements WsLike {
  readyState = 0; sent: string[] = [];
  onopen: any = null; onmessage: any = null; onclose: any = null; onerror: any = null;
  send(d: string) { this.sent.push(d); }
  close() { this.readyState = 3; }
}

test('WS subscribes on open, parses plain and gzip frames, reconnects after close', async () => {
  const sockets: FakeSocket[] = [];
  const got: number[] = [];
  const states: boolean[] = [];
  const timers: Array<() => void> = [];
  const ws = new MexcWs({
    url: 'ws://fake',
    factory: () => { const s = new FakeSocket(); sockets.push(s); return s; },
    onTickers: (t) => got.push(t.length),
    onState: (c) => states.push(c),
    now: () => NOW,
    setTimer: ((fn: () => void) => { timers.push(fn); return 0 as any; }) as any,
  });
  ws.start();
  sockets[0].onopen({});
  assert.deepEqual(JSON.parse(sockets[0].sent[0]).method, 'sub.tickers');
  const payload = JSON.stringify({ channel: 'push.tickers', data: [{ symbol: 'A_USDT', lastPrice: 1, timestamp: NOW }] });
  await ws.handleMessage(payload);
  await ws.handleMessage(gzipSync(Buffer.from(payload)));
  await ws.handleMessage(JSON.stringify({ channel: 'pong', data: NOW }));
  await ws.handleMessage('not json');
  assert.deepEqual(got, [1, 1]);
  sockets[0].onclose({});
  assert.deepEqual(states, [true, false]);
  assert.equal(timers.length, 1, 'reconnect scheduled');
  timers[0]();
  assert.equal(sockets.length, 2, 'new socket created');
  sockets[1].onopen({});
  assert.equal(ws.connected, true);
  assert.equal(ws.reconnects, 1);
  ws.stop();
});

test('WS ignores close events from a stale socket', () => {
  const sockets: FakeSocket[] = [];
  const timers: Array<() => void> = [];
  const ws = new MexcWs({ url: 'ws://fake', factory: () => { const s = new FakeSocket(); sockets.push(s); return s; }, onTickers: () => {}, onState: () => {}, setTimer: ((fn: () => void) => { timers.push(fn); return 0 as any; }) as any });
  ws.start(); sockets[0].onopen({}); sockets[0].onclose({}); timers[0](); sockets[1].onopen({});
  sockets[0].onclose({}); // late close of the old socket
  assert.equal(ws.connected, true);
  assert.equal(timers.length, 1);
  ws.stop();
});
