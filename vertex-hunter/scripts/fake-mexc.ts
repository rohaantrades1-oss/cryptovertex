// LOCAL TEST TOOL ONLY. Emulates the documented MEXC Futures public REST + WebSocket shapes with SYNTHETIC data so the
// full pipeline can be exercised offline. Never used by the production server. Usage:
//   node scripts/fake-mexc.ts 4010   then   MEXC_REST_BASE=http://localhost:4010 MEXC_WS_URL=ws://localhost:4010/edge npm start
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

const port = Number(process.argv[2] ?? 4010);
const SYMS = ['BTC_USDT', 'SURGE_USDT', 'QUIET_USDT', 'DUMP_USDT', 'THIN_USDT', 'ETH_USDT'];
const BASE: Record<string, number> = { BTC_USDT: 70000, SURGE_USDT: 1.25, QUIET_USDT: 0.8, DUMP_USDT: 3.1, THIN_USDT: 0.05, ETH_USDT: 3500 };
const CS: Record<string, number> = { BTC_USDT: 0.0001, ETH_USDT: 0.01 };
const startBar = Math.floor(Date.now() / 300_000) * 300;
const rng = (seed: number) => () => ((seed = (seed * 1664525 + 1013904223) & 0x7fffffff) / 0x7fffffff);

function candles(sym: string, interval: string, from: number, to: number) {
  const sec = ({ Min5: 300, Min15: 900, Min60: 3600, Min1: 60, Hour4: 14400, Day1: 86400 } as any)[interval] ?? 300;
  const r = rng([...sym].reduce((a, c) => a + c.charCodeAt(0), 7));
  const out = { time: [] as number[], open: [] as number[], high: [] as number[], low: [] as number[], close: [] as number[], vol: [] as number[] };
  // build on a 5m grid then aggregate for larger intervals
  const nowBar = Math.floor(Date.now() / 300_000) * 300;
  const grid: any[] = [];
  let p = BASE[sym];
  for (let t = nowBar - 400 * 300; t <= nowBar; t += 300) {
    const idx = (nowBar - t) / 300;
    const comp = idx > 3 && idx < 40 ? 0.5 : 1;
    const o = p;
    let c = o * (1 + (r() - 0.5) * 0.0012 * comp);
    let v = 1500 * (0.9 + r() * 0.2) * (sym === 'THIN_USDT' ? 0.02 : 1);
    const surgeBar = (b: number) => (startBar - t) / 300 === b;
    if (sym === 'SURGE_USDT') { if (idx === 1 || surgeBar(1)) { c = o * 1.012; v = 9000; } if (idx === 0) { c = o * 1.003; v = 4500; } }
    if (sym === 'DUMP_USDT') { if (idx === 1) { c = o * 0.988; v = 9000; } if (idx === 0) { c = o * 0.997; v = 4500; } }
    grid.push({ t, o, h: Math.max(o, c) * 1.0002, l: Math.min(o, c) * 0.9998, c, v });
    p = c;
  }
  const m = new Map<number, any>();
  for (const g of grid) { const t = Math.floor(g.t / sec) * sec; const a = m.get(t); if (!a) m.set(t, { ...g, t }); else { a.h = Math.max(a.h, g.h); a.l = Math.min(a.l, g.l); a.c = g.c; a.v += g.v; } }
  for (const c of [...m.values()].sort((a, b) => a.t - b.t)) {
    if (c.t < from || c.t > to) continue;
    // like a real exchange, the still-forming bar only holds the volume traded so far
    const elapsed = (Date.now() / 1000 - c.t) / sec;
    if (elapsed > 0 && elapsed < 1) c.v *= elapsed;
    out.time.push(c.t); out.open.push(c.o); out.high.push(c.h); out.low.push(c.l); out.close.push(c.c); out.vol.push(c.v);
  }
  return out;
}

let oi: Record<string, number> = Object.fromEntries(SYMS.map((s) => [s, 2_000_000]));
function ticker(sym: string) {
  const c = candles(sym, 'Min5', 0, 9e12);
  const last = c.close[c.close.length - 1];
  if (sym === 'SURGE_USDT' || sym === 'DUMP_USDT') oi[sym] *= 1.0006; // OI building during the move
  const cs = CS[sym] ?? 1;
  const vol24 = sym === 'THIN_USDT' ? 2000 : sym === 'BTC_USDT' ? 4e7 : sym === 'ETH_USDT' ? 8e6 : 6_000_000;
  const first = c.close[c.close.length - 289] ?? c.close[0];
  return { contractId: 1, symbol: sym, lastPrice: last, bid1: last * 0.9999, ask1: last * 1.0001, volume24: vol24, amount24: vol24 * cs * last, holdVol: Math.round(oi[sym]), lower24Price: last * 0.97, high24Price: last * 1.03, riseFallRate: (last - first) / first, riseFallValue: last - first, indexPrice: last, fairPrice: last, fundingRate: 0.00005, maxBidPrice: last * 1.1, minAskPrice: last * 0.9, timestamp: Date.now() };
}

const http = createServer((req, res) => {
  const u = new URL(req.url ?? '/', 'http://x');
  const send = (data: unknown) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ success: true, code: 0, data })); };
  let m: RegExpMatchArray | null;
  if (u.pathname === '/api/v1/contract/detail') return send(SYMS.map((s) => ({ symbol: s, contractSize: CS[s] ?? 1, volUnit: 1, minVol: 1, maxVol: 1e9, priceUnit: BASE[s] > 100 ? 0.1 : 0.00001, takerFeeRate: 0.0002, makerFeeRate: 0, maxLeverage: 100, maintenanceMarginRate: 0.004, baseCoin: s.split('_')[0], quoteCoin: 'USDT', settleCoin: 'USDT', state: 0, futureType: 1, isNew: false })));
  if (u.pathname === '/api/v1/contract/ticker') return send(SYMS.map(ticker));
  if ((m = u.pathname.match(/^\/api\/v1\/contract\/kline\/(\w+)$/))) return send(candles(m[1], u.searchParams.get('interval') ?? 'Min5', Number(u.searchParams.get('start') ?? 0), Number(u.searchParams.get('end') ?? 9e12)));
  if ((m = u.pathname.match(/^\/api\/v1\/contract\/depth\/(\w+)$/))) { const t = ticker(m[1]); return send({ asks: [[t.lastPrice * 1.0002, 10, 5000], [t.lastPrice * 1.0004, 8, 4000]], bids: [[t.lastPrice * 0.9998, 12, 9000], [t.lastPrice * 0.9996, 9, 7000]], timestamp: Date.now() }); }
  res.writeHead(404); res.end();
});
const wss = new WebSocketServer({ server: http, path: '/edge' });
wss.on('connection', (ws) => {
  let timer: any;
  ws.on('message', (raw) => {
    const msg = JSON.parse(String(raw));
    if (msg.method === 'ping') ws.send(JSON.stringify({ channel: 'pong', data: Date.now() }));
    if (msg.method === 'sub.tickers') {
      ws.send(JSON.stringify({ channel: 'rs.sub.tickers', data: 'success', ts: Date.now() }));
      timer = setInterval(() => ws.send(JSON.stringify({ channel: 'push.tickers', data: SYMS.map(ticker), ts: Date.now() })), 1000);
    }
  });
  ws.on('close', () => clearInterval(timer));
});
http.listen(port, () => console.log(`fake MEXC (SYNTHETIC) on :${port}`));
