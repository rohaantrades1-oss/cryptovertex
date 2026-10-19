import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONFIG, env, mergeConfig, STRATEGY_VERSION } from './config.ts';
import { activateConfigVersion, activeConfig, logEvent, openDb, saveConfigVersion } from './db.ts';
import { MarketStore } from './market.ts';
import { MexcRest } from './mexc/rest.ts';
import { MexcWs } from './mexc/ws.ts';
import { Runner } from './engine/runner.ts';
import { PaperWallet } from './wallet/paper.ts';
import { SignalTracker } from './signals.ts';
import { loadHistory, runBacktest, type SymbolSeries } from './backtest.ts';
import type { Interval } from './mexc/types.ts';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const pub = join(root, 'public');

const db = openDb(join(env.dataDir, 'vertex-hunter.db'));
const store = new MarketStore(activeConfig(db).config.dataQuality.maxClockSkewMs);
const rest = new MexcRest({
  baseUrl: env.restBase,
  onError: (i) => { if (!i.willRetry) logEvent(db, 'warn', 'rest', `${i.path}: ${i.message}`); },
});
const clients = new Set<ServerResponse>();
const broadcast = (topic: string) => {
  const payload = `event: ${topic}\ndata: ${Date.now()}\n\n`;
  for (const c of clients) c.write(payload);
};
const wallet = new PaperWallet(db, () => broadcast('notification'));
const tracker = new SignalTracker(db);
let runner: Runner;
const ws = new MexcWs({
  url: env.wsUrl,
  onTickers: (t) => runner.ingest(t),
  onState: (connected, detail) => { logEvent(db, connected ? 'info' : 'warn', 'ws', `websocket ${connected ? 'connected' : 'disconnected'} (${detail})`); runner?.updateHealth(); },
});
runner = new Runner({ db, store, rest, ws, wallet, tracker, onChange: (t) => throttledBroadcast(t) });

const lastSent = new Map<string, number>();
function throttledBroadcast(topic: string) {
  const now = Date.now();
  if (now - (lastSent.get(topic) ?? 0) < 900) return;
  lastSent.set(topic, now);
  broadcast(topic);
}

const json = (res: ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body, (_k, v) => (typeof v === 'number' && !Number.isFinite(v) ? null : v)));
};

function authorized(req: IncomingMessage, url: URL): boolean {
  if (!env.dashboardToken) return true;
  const h = req.headers.authorization;
  return url.searchParams.get('token') === env.dashboardToken || h === `Bearer ${env.dashboardToken}` || (req.headers.cookie ?? '').includes(`vh_token=${env.dashboardToken}`);
}

async function body(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) { n += (c as Buffer).length; if (n > 1_000_000) throw new Error('body too large'); chunks.push(c as Buffer); }
  const t = Buffer.concat(chunks).toString('utf8');
  return t ? JSON.parse(t) : {};
}

function shortlistView() {
  const now = Date.now();
  return [...runner.shortlist.values()].sort((a, b) => b.candidate.score - a.candidate.score).map((e) => {
    const t = store.tickers.get(e.candidate.symbol);
    return {
      symbol: e.candidate.symbol, direction: e.candidate.direction, state: e.candidate.state, status: e.status, score: e.candidate.score,
      price: t?.last, change24hPct: runner.change24hPct(e.candidate.symbol), usdVolume24h: store.estQuoteVolume24h(e.candidate.symbol),
      risk: e.candidate.risk, reasons: e.candidate.reasons, firstSeenAt: e.firstSeenAt, ageMs: now - e.firstSeenAt, signalId: e.signalId,
      scoreHistory: e.scoreHistory.map((s) => s.score), previousState: e.previousState, invalidation: e.candidate.invalidation, target: e.candidate.target,
    };
  });
}

async function api(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const p = url.pathname;
  const method = req.method ?? 'GET';
  const now = Date.now();
  if (p === '/api/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write('retry: 3000\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  if (p === '/api/status') return json(res, 200, { strategyVersion: STRATEGY_VERSION, paperTradingOnly: true, serverTime: now, ...runner.status() });
  if (p === '/api/shortlist') return json(res, 200, { health: runner.health, items: shortlistView(), serverTime: now });
  if (p === '/api/market') {
    const rows = [...store.tickers.values()].map((t) => ({ symbol: t.symbol, last: t.last, change24hPct: runner.change24hPct(t.symbol), usdVolume24h: store.estQuoteVolume24h(t.symbol), ts: t.exchangeTs }))
      .sort((a, b) => (b.usdVolume24h ?? 0) - (a.usdVolume24h ?? 0)).slice(0, 100);
    return json(res, 200, { rows });
  }
  if (p === '/api/signals') return json(res, 200, { items: tracker.list({ symbol: url.searchParams.get('symbol') ?? undefined, status: url.searchParams.get('status') ?? undefined, limit: Number(url.searchParams.get('limit') ?? 300) }, now) });
  let m: RegExpMatchArray | null;
  if ((m = p.match(/^\/api\/signals\/([\w-]+)$/))) { const s = tracker.get(m[1], now); return s ? json(res, 200, s) : json(res, 404, { error: 'not found' }); }
  if ((m = p.match(/^\/api\/coin\/([\w]+)$/))) {
    const symbol = m[1];
    const t = store.tickers.get(symbol);
    const c = store.contracts.get(symbol);
    if (!t || !c) return json(res, 404, { error: 'unknown symbol' });
    const interval = (url.searchParams.get('interval') ?? 'Min5') as Interval;
    let candles = store.getCandles(symbol, interval);
    if (candles.length < 50 || (store.candleFetchedAt.get(`${symbol}|${interval}`) ?? 0) < now - 60_000) {
      try { const r = await rest.klines(symbol, interval, { start: Math.floor(now / 1000) - 600 * ({ Min1: 60, Min5: 300, Min15: 900, Min30: 1800, Min60: 3600, Hour4: 14400, Day1: 86400 } as any)[interval], end: Math.floor(now / 1000) + 60 }); store.mergeCandles(symbol, interval, r.candles, 600, now); candles = store.getCandles(symbol, interval); } catch (e: any) { /* chart shows what we have */ }
    }
    const entry = runner.shortlist.get(symbol);
    const pos = wallet.openPositionFor(symbol);
    return json(res, 200, {
      symbol, ticker: t, contract: c, change24hPct: runner.change24hPct(symbol), usdVolume24h: store.estQuoteVolume24h(symbol), spreadBps: store.spreadBps(symbol),
      candles, interval, candidate: entry?.candidate ?? null, shortlistStatus: entry?.status ?? null, signals: tracker.list({ symbol, limit: 50 }, now), position: pos ?? null,
      oi30m: runner.oiChange30m(symbol, now), health: runner.health,
    });
  }
  if (p === '/api/wallet') {
    const marks = runner.marks();
    const positions = wallet.openPositions().map((x) => {
      const mark = marks.get(x.symbol) ?? x.mark_price ?? x.avg_entry;
      const rate = store.contracts.get(x.symbol)?.takerFeeRate ?? 0;
      const sign = x.direction === 'LONG' ? 1 : -1;
      const units = x.contracts * x.contract_size;
      const gross = (mark - x.avg_entry) * units * sign;
      const net = gross - x.entry_fees - units * mark * rate - x.funding_paid + x.realized_pnl;
      return { ...x, mark, grossUnrealized: gross, netUnrealized: gross - x.entry_fees - units * mark * rate - x.funding_paid, underlyingPct: ((mark - x.avg_entry) / x.avg_entry) * 100 * sign, marginRoiPct: x.margin > 0 ? ((gross - x.entry_fees - units * mark * rate - x.funding_paid) / x.margin) * 100 : 0, netInclRealized: net };
    });
    return json(res, 200, { summary: wallet.summary(marks), positions, history: wallet.allPositions(100).filter((x) => x.status === 'CLOSED'), health: runner.health, risk: activeConfig(db).config.risk, equityCurve: equityCurve() });
  }
  if (p === '/api/activity') return json(res, 200, { items: wallet.activity(Number(url.searchParams.get('limit') ?? 300)) });
  if (p === '/api/notifications') {
    if (method === 'POST') { db.exec('UPDATE notifications SET read=1'); return json(res, 200, { ok: true }); }
    return json(res, 200, { items: db.prepare('SELECT * FROM notifications ORDER BY id DESC LIMIT 100').all() });
  }
  if (p === '/api/events-log') return json(res, 200, { items: db.prepare('SELECT * FROM events ORDER BY seq DESC LIMIT ?').all(Number(url.searchParams.get('limit') ?? 200)) });
  if (p === '/api/analytics') return json(res, 200, analytics());
  if (p === '/api/config') {
    if (method === 'POST') {
      const b = await body(req);
      const cur = activeConfig(db);
      try {
        const merged = mergeConfig(cur.config, b.patch ?? {});
        const id = saveConfigVersion(db, merged, String(b.label ?? 'edited via UI').slice(0, 80));
        runner.reloadConfig();
        return json(res, 200, { ok: true, version: id, config: merged });
      } catch (e: any) { return json(res, 400, { error: e.message }); }
    }
    const cur = activeConfig(db);
    return json(res, 200, { active: cur, defaults: DEFAULT_CONFIG, versions: db.prepare('SELECT id, created_at, label FROM config_versions ORDER BY id DESC LIMIT 50').all() });
  }
  if (p === '/api/config/revert' && method === 'POST') {
    const b = await body(req);
    try { activateConfigVersion(db, Number(b.version)); runner.reloadConfig(); return json(res, 200, { ok: true }); } catch (e: any) { return json(res, 400, { error: e.message }); }
  }
  if (p === '/api/strategies') {
    const cfg = activeConfig(db).config;
    return json(res, 200, { version: STRATEGY_VERSION, strategies: STRATEGY_DOCS.map((s) => ({ ...s, enabled: (cfg.strategies as any)[s.key].enabled })), weights: cfg.weights, thresholds: cfg.thresholds, risk: cfg.risk });
  }
  if (p === '/api/backtest' && method === 'POST') {
    const b = await body(req);
    const days = Math.min(14, Math.max(1, Number(b.days ?? 5)));
    const symbols: string[] = Array.isArray(b.symbols) && b.symbols.length ? b.symbols.slice(0, 20) : topSymbols(8);
    if (!symbols.includes('BTC_USDT') && store.contracts.has('BTC_USDT')) symbols.push('BTC_USDT');
    if (backtestBusy) return json(res, 409, { error: 'a backtest is already running' });
    backtestBusy = true;
    try {
      const series: SymbolSeries[] = [];
      for (const s of symbols) {
        const contract = store.contracts.get(s);
        if (!contract) continue;
        const [c5, c15, c60] = [await loadHistory(rest, s, 'Min5', days), await loadHistory(rest, s, 'Min15', days), await loadHistory(rest, s, 'Min60', days + 2)];
        if (c5.length > 200) series.push({ symbol: s, contract, c5, c15, c60 });
      }
      if (!series.length) return json(res, 502, { error: 'could not load historical data from MEXC' });
      const cfg = activeConfig(db).config;
      const result = runBacktest(series, cfg, { days }, { states: ['CONFIRMED_SETUP'] }, STRATEGY_VERSION);
      db.prepare('INSERT INTO backtest_runs (created_at, params_json, result_json) VALUES (?,?,?)').run(Date.now(), JSON.stringify(result.params), JSON.stringify({ ...result, trades: result.trades.slice(0, 500) }));
      return json(res, 200, { ...result, trades: result.trades.slice(0, 500) });
    } catch (e: any) { return json(res, 502, { error: String(e?.message ?? e) }); } finally { backtestBusy = false; }
  }
  if (p === '/api/backtest/latest') {
    const r = db.prepare('SELECT * FROM backtest_runs ORDER BY id DESC LIMIT 1').get() as any;
    return json(res, 200, r ? JSON.parse(r.result_json) : null);
  }
  if (p === '/api/reconcile') return json(res, 200, wallet.reconcile());
  if (p === '/api/health') return json(res, 200, { ok: true, feed: runner.health.state });
  return json(res, 404, { error: 'not found' });
}

let backtestBusy = false;

function topSymbols(n: number): string[] {
  return [...store.tickers.keys()].filter((s) => store.eligible.has(s)).sort((a, b) => (store.estQuoteVolume24h(b) ?? 0) - (store.estQuoteVolume24h(a) ?? 0)).slice(0, n);
}

function equityCurve() {
  const rows = db.prepare('SELECT ts, equity FROM equity_snapshots ORDER BY ts DESC LIMIT 1500').all() as Array<{ ts: number; equity: number }>;
  return rows.reverse();
}

function analytics() {
  const all = tracker.list({ limit: 5000 }, Date.now());
  const group = (k: (s: any) => string) => {
    const g: Record<string, { n: number; closed: number; wins: number; sumGross: number; sumNet: number }> = {};
    for (const s of all) {
      const key = k(s); const x = (g[key] ??= { n: 0, closed: 0, wins: 0, sumGross: 0, sumNet: 0 });
      x.n++;
      if (s.status !== 'OPEN' && s.grossRoiPct !== null) { x.closed++; x.sumGross += s.grossRoiPct; x.sumNet += s.estNetRoiPct ?? 0; if ((s.estNetRoiPct ?? 0) > 0) x.wins++; }
    }
    return Object.entries(g).map(([key, x]) => ({ key, signals: x.n, closed: x.closed, winRatePct: x.closed ? (x.wins / x.closed) * 100 : null, avgGrossPct: x.closed ? x.sumGross / x.closed : null, avgNetPct: x.closed ? x.sumNet / x.closed : null }));
  };
  const closedPos = wallet.allPositions(1000).filter((p) => p.status === 'CLOSED');
  const wins = closedPos.filter((p) => p.realized_pnl > 0);
  const gp = wins.reduce((a, p) => a + p.realized_pnl, 0);
  const gl = Math.abs(closedPos.filter((p) => p.realized_pnl <= 0).reduce((a, p) => a + p.realized_pnl, 0));
  const rejects = db.prepare("SELECT reason, COUNT(*) c FROM wallet_events WHERE type='REJECT' GROUP BY reason ORDER BY c DESC LIMIT 12").all();
  return {
    note: 'Live paper-trading statistics only. Small samples are not evidence of an edge.',
    signalsTotal: all.length, byState: group((s) => s.state), byDirection: group((s) => s.direction), byStatus: group((s) => s.status),
    wallet: { closedTrades: closedPos.length, winRatePct: closedPos.length ? (wins.length / closedPos.length) * 100 : null, profitFactor: gl > 0 ? gp / gl : null, sufficientSample: closedPos.length >= 30 },
    topRejections: rejects, feed: runner.status().ingest,
  };
}

const STRATEGY_DOCS = [
  { key: 'volumeAnomaly', name: 'Volume anomaly', logic: 'Robust z-score (median/MAD) of the latest 5m volume, and the time-normalised forming bar, against the prior ~2h of 5m bars. Credit is scaled down when the last bars move against the direction.', inputs: 'Min5 candles' },
  { key: 'momentumAcceleration', name: 'Momentum & acceleration', logic: 'ATR-normalised returns over 3 bars on 5m, 15m and 1h plus change in 5m 3-bar return versus the previous 3 bars.', inputs: 'Min5, Min15, Min60 candles' },
  { key: 'volatilityExpansion', name: 'Volatility expansion', logic: 'ATR(5)/ATR(30) on 5m; extra credit if the 20-bar range was in the lowest 30% of its recent history 6 bars earlier (compression then expansion).', inputs: 'Min5 candles' },
  { key: 'breakoutProximity', name: 'Breakout proximity', logic: 'Distance to the prior 48-bar high/low in ATR units. Full credit only after a CLOSED 5m bar beyond the level; partial credit for an unconfirmed intrabar break.', inputs: 'Min5 candles' },
  { key: 'oiDivergence', name: 'Open interest vs price', logic: 'Compares open-interest change with price change over ~30 minutes using our own ticker snapshots. Rising OI with price moving in the setup direction scores highest. Unavailable until ~30 minutes of history exists.', inputs: 'ticker holdVol history' },
  { key: 'reversalExhaustion', name: 'Failed breakout / exhaustion', logic: 'Penalty (and INVALIDATED state) when a recent bar broke the 48-bar level but closed back inside; penalty for extended moves with rejection wicks or fading volume.', inputs: 'Min5 candles' },
];

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon' };

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/api/health') return void json(res, 200, { ok: true, feed: runner.health.state });
    if (!authorized(req, url)) { res.writeHead(401, { 'content-type': 'text/plain' }); return void res.end('Unauthorized: add ?token=... or Authorization: Bearer'); }
    if (url.searchParams.get('token') && env.dashboardToken) res.setHeader('set-cookie', `vh_token=${env.dashboardToken}; Path=/; HttpOnly; SameSite=Strict`);
    if (url.pathname.startsWith('/api/')) return void (await api(req, res, url));
    let rel = normalize(url.pathname === '/' ? '/index.html' : url.pathname).replace(/^(\.\.[/\\])+/, '');
    const file = join(pub, rel);
    if (!file.startsWith(pub)) { res.writeHead(403); return void res.end(); }
    try {
      const data = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' });
      res.end(data);
    } catch { res.writeHead(404); res.end('not found'); }
  } catch (e: any) {
    logEvent(db, 'error', 'http', String(e?.message ?? e));
    if (!res.headersSent) json(res, 500, { error: 'internal error' }); else res.end();
  }
});

server.listen(env.port, () => {
  console.log(`Vertex Hunter ${STRATEGY_VERSION} listening on :${env.port} (paper trading only, public market data only)`);
  logEvent(db, 'info', 'boot', `server started ${STRATEGY_VERSION}`);
  void runner.start();
});

process.on('SIGTERM', () => { runner.stop(); server.close(); db.close(); process.exit(0); });
process.on('unhandledRejection', (e: any) => logEvent(db, 'error', 'unhandled', String(e?.message ?? e)));
