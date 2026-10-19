// Live validation of the MEXC public API against the parsers used by Vertex Hunter.
// Run:  npm run probe          (needs outbound HTTPS/WSS to contract.mexc.com)
// Exit code 0 only if every check passes. Nothing here is mocked.
import { MexcRest } from '../src/mexc/rest.ts';
import { isEligible } from '../src/mexc/parse.ts';
import { env } from '../src/config.ts';

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
const check = (name: string, ok: boolean, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

const rest = new MexcRest({ baseUrl: env.restBase, maxRetries: 2 });
try {
  const { contracts, dropped } = await rest.contracts();
  check('contract/detail returns contracts', contracts.length > 100, `${contracts.length} contracts, ${dropped} malformed dropped`);
  const eligible = contracts.filter((c) => isEligible(c).ok);
  check('eligible USDT perpetuals found', eligible.length > 50, `${eligible.length} eligible`);
  const btc = contracts.find((c) => c.symbol === 'BTC_USDT');
  check('BTC_USDT precision fields present', !!btc && btc.priceUnit > 0 && btc.volUnit > 0 && btc.contractSize > 0, btc ? `tick ${btc.priceUnit}, volUnit ${btc.volUnit}, contractSize ${btc.contractSize}, taker ${btc.takerFeeRate}` : 'missing');

  const { tickers } = await rest.tickers();
  check('ticker (all) returns data', tickers.length > 100, `${tickers.length} tickers`);
  const bt = tickers.find((t) => t.symbol === 'BTC_USDT');
  const skew = bt ? Math.abs(Date.now() - bt.exchangeTs) : NaN;
  check('ticker timestamp is epoch milliseconds & clock skew sane', !!bt && skew < 60_000, `skew ${skew} ms`);
  const withOi = tickers.filter((t) => t.holdVol !== undefined).length;
  const withFunding = tickers.filter((t) => t.fundingRate !== undefined).length;
  console.log(`INFO  open interest present on ${withOi}/${tickers.length}, funding on ${withFunding}/${tickers.length}, bid/ask on ${tickers.filter((t) => t.bid1 && t.ask1).length}`);

  const now = Math.floor(Date.now() / 1000);
  const k = await rest.klines('BTC_USDT', 'Min5', { start: now - 3 * 3600, end: now });
  check('kline returns ascending, de-duplicated candles', k.candles.length > 20 && k.candles.every((c, i, a) => i === 0 || c.t > a[i - 1].t), `${k.candles.length} candles, ${k.dropped} dropped`);
  check('kline time is epoch SECONDS', k.candles.length > 0 && k.candles[k.candles.length - 1].t > 1.5e9 && k.candles[k.candles.length - 1].t < 1e11, `last t=${k.candles.at(-1)?.t}`);
  const lastC = k.candles.at(-1);
  if (bt && lastC) check('kline close within 2% of ticker last', Math.abs(lastC.c / bt.last - 1) < 0.02, `${lastC.c} vs ${bt.last}`);

  const d = await rest.depth('BTC_USDT', 20);
  check('depth parses (optional metric)', !!d && d.bids.length > 0 && d.asks.length > 0 && d.bids[0][0] < d.asks[0][0], d ? `best bid ${d.bids[0][0]} / ask ${d.asks[0][0]}` : 'unavailable');

  // riseFallRate unit: compare with our own 24h change from hourly candles
  const h = await rest.klines('BTC_USDT', 'Min60', { start: now - 26 * 3600, end: now });
  if (bt && bt.riseFallRate !== undefined && h.candles.length >= 25) {
    const ref = h.candles[h.candles.length - 25].c;
    const own = ((bt.last - ref) / ref) * 100;
    console.log(`INFO  riseFallRate=${bt.riseFallRate} vs own 24h change ${own.toFixed(3)}% (runner auto-detects fraction vs percent)`);
  }
} catch (e: any) {
  check('REST reachable', false, String(e?.message ?? e));
}

// WebSocket
await new Promise<void>((resolve) => {
  let got = 0; let done = false;
  const finish = (ok: boolean, detail: string) => { if (done) return; done = true; check('websocket sub.tickers pushes data', ok, detail); try { ws.close(); } catch { /* ignore */ } resolve(); };
  const ws = new WebSocket(env.wsUrl);
  const t = setTimeout(() => finish(false, 'no push.tickers within 15s'), 15_000);
  ws.onopen = () => ws.send(JSON.stringify({ method: 'sub.tickers', param: {}, gzip: false }));
  ws.onmessage = async (ev: MessageEvent) => {
    let text: string;
    if (typeof ev.data === 'string') text = ev.data;
    else { const { gunzipSync, inflateSync } = await import('node:zlib'); const buf = Buffer.from(await (ev.data as Blob).arrayBuffer()); try { text = (buf[0] === 0x1f ? gunzipSync(buf) : inflateSync(buf)).toString(); } catch { text = buf.toString(); } }
    try { const m = JSON.parse(text); if (m.channel === 'push.tickers' && Array.isArray(m.data) && ++got >= 1) { clearTimeout(t); finish(true, `${m.data.length} tickers in first push; sample keys: ${Object.keys(m.data[0] ?? {}).join(',')}`); } } catch { /* ignore */ }
  };
  ws.onerror = () => finish(false, 'socket error');
});

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\n${failed.length} check(s) FAILED. Do not trust live signals until resolved.` : '\nAll checks passed.');
process.exit(failed.length ? 1 : 0);
