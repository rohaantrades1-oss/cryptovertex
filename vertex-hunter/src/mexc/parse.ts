// Defensive parsers for MEXC Futures public responses. Anything malformed is dropped (and counted by callers),
// never repaired with invented values.
import type { Candle, ContractInfo, DepthSnapshot, Ticker } from './types.ts';

export class ApiError extends Error {
  code?: number;
  status?: number;
  retryable: boolean;
  constructor(message: string, opts: { code?: number; status?: number; retryable?: boolean } = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = opts.code;
    this.status = opts.status;
    this.retryable = opts.retryable ?? false;
  }
}

export function num(v: unknown): number | undefined {
  if (v === null || v === undefined || v === '') return undefined;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
}
function posNum(v: unknown): number | undefined {
  const n = num(v);
  return n !== undefined && n > 0 ? n : undefined;
}

/** Unwraps the MEXC envelope {success, code, data}. */
export function unwrap(json: any): any {
  if (json === null || typeof json !== 'object') throw new ApiError('response is not a JSON object');
  if (json.success === false || (typeof json.code === 'number' && json.code !== 0 && json.code !== 200)) {
    const code = typeof json.code === 'number' ? json.code : undefined;
    // 510 is MEXC's "request too frequent" in the futures API; treat as retryable.
    throw new ApiError(`API error code=${code} message=${json.message ?? ''}`, { code, retryable: code === 510 || code === 429 });
  }
  return json.data;
}

export function parseContracts(data: unknown): { contracts: ContractInfo[]; dropped: number } {
  const arr = Array.isArray(data) ? data : data && typeof data === 'object' ? [data] : [];
  const contracts: ContractInfo[] = [];
  let dropped = 0;
  for (const r of arr as any[]) {
    const symbol = typeof r?.symbol === 'string' ? r.symbol : undefined;
    const contractSize = posNum(r?.contractSize);
    const volUnit = posNum(r?.volUnit);
    const priceUnit = posNum(r?.priceUnit);
    const minVol = posNum(r?.minVol);
    if (!symbol || !contractSize || !volUnit || !priceUnit || !minVol) { dropped++; continue; }
    contracts.push({
      symbol,
      contractSize,
      volUnit,
      minVol,
      maxVol: posNum(r.maxVol) ?? Number.MAX_SAFE_INTEGER,
      priceUnit,
      takerFeeRate: num(r.takerFeeRate) ?? NaN,
      makerFeeRate: num(r.makerFeeRate) ?? NaN,
      maxLeverage: posNum(r.maxLeverage) ?? 1,
      maintenanceMarginRate: num(r.maintenanceMarginRate) ?? NaN,
      baseCoin: String(r.baseCoin ?? ''),
      quoteCoin: String(r.quoteCoin ?? ''),
      settleCoin: String(r.settleCoin ?? ''),
      state: num(r.state) ?? -1,
      futureType: num(r.futureType) ?? 1,
      isNew: Boolean(r.isNew),
      createTime: num(r.createTime),
    });
  }
  return { contracts, dropped };
}

/** Eligible = enabled USDT-settled perpetual with documented fee data. Fee rates missing => not eligible (no guessing). */
export function isEligible(c: ContractInfo): { ok: boolean; reason?: string } {
  if (c.state !== 0) return { ok: false, reason: `state=${c.state} (not enabled)` };
  if (c.futureType !== 1) return { ok: false, reason: 'not a perpetual' };
  if (c.settleCoin !== 'USDT' || c.quoteCoin !== 'USDT') return { ok: false, reason: 'not USDT-margined' };
  if (!Number.isFinite(c.takerFeeRate)) return { ok: false, reason: 'taker fee unavailable' };
  return { ok: true };
}

/**
 * Normalise a ticker object from REST (`/contract/ticker`) or the WS `push.tickers` payload.
 * Returns undefined if the essentials (symbol, positive last price, usable exchange timestamp) are missing.
 */
export function parseTicker(r: any, receivedTs: number, source: 'ws' | 'rest'): Ticker | undefined {
  const symbol = typeof r?.symbol === 'string' ? r.symbol : undefined;
  const last = posNum(r?.lastPrice);
  if (!symbol || !last) return undefined;
  const exchangeTs = posNum(r.timestamp);
  if (!exchangeTs) return undefined;
  return {
    symbol,
    last,
    bid1: posNum(r.bid1),
    ask1: posNum(r.ask1),
    volume24: num(r.volume24),
    amount24: num(r.amount24),
    holdVol: num(r.holdVol),
    fundingRate: num(r.fundingRate),
    fairPrice: posNum(r.fairPrice),
    indexPrice: posNum(r.indexPrice),
    high24: posNum(r.high24Price),
    low24: posNum(r.lower24Price),
    riseFallRate: num(r.riseFallRate),
    exchangeTs,
    receivedTs,
    source,
  };
}

export function parseTickers(data: unknown, receivedTs: number, source: 'ws' | 'rest'): { tickers: Ticker[]; dropped: number } {
  const arr = Array.isArray(data) ? data : data && typeof data === 'object' ? [data] : [];
  const tickers: Ticker[] = [];
  let dropped = 0;
  for (const r of arr) {
    const t = parseTicker(r, receivedTs, source);
    if (t) tickers.push(t); else dropped++;
  }
  return { tickers, dropped };
}

/**
 * Kline response: data = { time:[], open:[], close:[], high:[], low:[], vol:[], ... } (parallel arrays).
 * Output is sorted ascending, de-duplicated by open time, and free of malformed rows.
 */
export function parseKlines(data: any): { candles: Candle[]; dropped: number } {
  if (!data || typeof data !== 'object' || !Array.isArray(data.time)) return { candles: [], dropped: 0 };
  const n = data.time.length;
  const byTime = new Map<number, Candle>();
  let dropped = 0;
  for (let i = 0; i < n; i++) {
    const t = num(data.time[i]);
    const o = posNum(data.open?.[i]);
    const h = posNum(data.high?.[i]);
    const l = posNum(data.low?.[i]);
    const c = posNum(data.close?.[i]);
    const v = num(data.vol?.[i]);
    if (t === undefined || !o || !h || !l || !c || v === undefined || v < 0 || h < l || h < Math.max(o, c) - 1e-12 || l > Math.min(o, c) + 1e-12) {
      dropped++;
      continue;
    }
    byTime.set(t, { t, o, h, l, c, v }); // later duplicate wins
  }
  return { candles: [...byTime.values()].sort((a, b) => a.t - b.t), dropped };
}

/** Depth: data = { asks:[[price, orders, vol]...], bids:[...], timestamp }. Quantity is the LAST element or index 1 depending on shape; we take index 2 when present. */
export function parseDepth(symbol: string, data: any, receivedTs: number): DepthSnapshot | undefined {
  if (!data || !Array.isArray(data.bids) || !Array.isArray(data.asks)) return undefined;
  const side = (rows: any[]): Array<[number, number]> => {
    const out: Array<[number, number]> = [];
    for (const r of rows) {
      if (!Array.isArray(r)) continue;
      const p = posNum(r[0]);
      const q = posNum(r.length >= 3 ? r[2] : r[1]);
      if (p && q) out.push([p, q]);
    }
    return out;
  };
  const bids = side(data.bids);
  const asks = side(data.asks);
  if (!bids.length || !asks.length) return undefined;
  return { symbol, bids, asks, exchangeTs: num(data.timestamp), receivedTs };
}
