import { ApiError, parseContracts, parseDepth, parseKlines, parseTickers, unwrap } from './parse.ts';
import type { Candle, ContractInfo, DepthSnapshot, Interval, Ticker } from './types.ts';

/** Sliding-window limiter: at most `max` calls per `windowMs`. Calls queue (FIFO) instead of failing. */
export class RateLimiter {
  private stamps: number[] = [];
  private chain: Promise<void> = Promise.resolve();
  private max: number;
  private windowMs: number;
  private now: () => number;
  private sleep: (ms: number) => Promise<void>;
  constructor(max: number, windowMs: number, now: () => number = Date.now, sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))) {
    this.max = max; this.windowMs = windowMs; this.now = now; this.sleep = sleep;
  }

  acquire(): Promise<void> {
    const p = this.chain.then(async () => {
      for (;;) {
        const t = this.now();
        this.stamps = this.stamps.filter((s) => t - s < this.windowMs);
        if (this.stamps.length < this.max) { this.stamps.push(t); return; }
        await this.sleep(this.windowMs - (t - this.stamps[0]) + 5);
      }
    });
    this.chain = p.catch(() => {});
    return p;
  }
}

export interface RestOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
  timeoutMs?: number;
  /** Fraction of the documented rate limit we allow ourselves to use. */
  rateSafety?: number;
  onError?: (info: { path: string; attempt: number; message: string; willRetry: boolean }) => void;
}

export interface RestStats { requests: number; failures: number; retries: number; rateLimited: number; lastOkTs: number | null; lastError: string | null }

export class MexcRest {
  readonly stats: RestStats = { requests: 0, failures: 0, retries: 0, rateLimited: 0, lastOkTs: null, lastError: null };
  private fetchImpl: typeof fetch;
  private now: () => number;
  private sleep: (ms: number) => Promise<void>;
  private limiters: Record<'ticker' | 'detail' | 'kline' | 'depth', RateLimiter>;
  private backoffUntil = 0;

  private opts: RestOptions;
  constructor(opts: RestOptions) {
    this.opts = opts;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    const s = opts.rateSafety ?? 0.6;
    // Documented limits (MEXC futures market endpoints): ticker 10/2s, contract detail 10/2s, kline 20/2s. Depth limit is not
    // verified here, so it shares the stricter 10/2s budget.
    const mk = (max: number) => new RateLimiter(Math.max(1, Math.floor(max * s)), 2000, this.now, this.sleep);
    this.limiters = { ticker: mk(10), detail: mk(10), kline: mk(20), depth: mk(10) };
  }

  private async getJson(path: string, group: keyof MexcRest['limiters']): Promise<any> {
    const maxRetries = this.opts.maxRetries ?? 4;
    let attempt = 0;
    for (;;) {
      attempt++;
      const wait = this.backoffUntil - this.now();
      if (wait > 0) await this.sleep(wait);
      await this.limiters[group].acquire();
      this.stats.requests++;
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), this.opts.timeoutMs ?? 10_000);
        let res: Response;
        try {
          res = await this.fetchImpl(this.opts.baseUrl + path, { signal: ctrl.signal, headers: { accept: 'application/json' } });
        } finally { clearTimeout(timer); }
        if (res.status === 429 || res.status >= 500) {
          const ra = Number(res.headers.get('retry-after'));
          if (res.status === 429) this.stats.rateLimited++;
          throw new ApiError(`HTTP ${res.status}`, { status: res.status, retryable: true, code: Number.isFinite(ra) ? undefined : undefined });
        }
        if (!res.ok) throw new ApiError(`HTTP ${res.status}`, { status: res.status, retryable: false });
        const json = await res.json();
        const data = unwrap(json);
        this.stats.lastOkTs = this.now();
        return data;
      } catch (e: any) {
        const err = e instanceof ApiError ? e : new ApiError(e?.name === 'AbortError' ? 'request timeout' : String(e?.message ?? e), { retryable: true });
        this.stats.failures++;
        this.stats.lastError = `${path}: ${err.message}`;
        const willRetry = err.retryable && attempt <= maxRetries;
        this.opts.onError?.({ path, attempt, message: err.message, willRetry });
        if (!willRetry) throw err;
        this.stats.retries++;
        const base = Math.min(30_000, 500 * 2 ** (attempt - 1));
        const delay = base + Math.floor(base * 0.25 * pseudoJitter(attempt));
        if (err.status === 429 || err.code === 510) this.backoffUntil = this.now() + delay;
        await this.sleep(delay);
      }
    }
  }

  async contracts(): Promise<{ contracts: ContractInfo[]; dropped: number }> {
    return parseContracts(await this.getJson('/api/v1/contract/detail', 'detail'));
  }

  async tickers(): Promise<{ tickers: Ticker[]; dropped: number }> {
    return parseTickers(await this.getJson('/api/v1/contract/ticker', 'ticker'), this.now(), 'rest');
  }

  async klines(symbol: string, interval: Interval, opts: { start?: number; end?: number } = {}): Promise<{ candles: Candle[]; dropped: number }> {
    const q = new URLSearchParams({ interval });
    if (opts.start !== undefined) q.set('start', String(Math.floor(opts.start)));
    if (opts.end !== undefined) q.set('end', String(Math.floor(opts.end)));
    return parseKlines(await this.getJson(`/api/v1/contract/kline/${encodeURIComponent(symbol)}?${q}`, 'kline'));
  }

  async depth(symbol: string, limit = 20): Promise<DepthSnapshot | undefined> {
    return parseDepth(symbol, await this.getJson(`/api/v1/contract/depth/${encodeURIComponent(symbol)}?limit=${limit}`, 'depth'), this.now());
  }
}

let jitterState = 12345;
/** Deterministic-enough jitter in [0,1) that avoids Math.random so tests are reproducible. */
function pseudoJitter(attempt: number): number {
  jitterState = (jitterState * 1103515245 + 12345 + attempt) & 0x7fffffff;
  return jitterState / 0x7fffffff;
}
