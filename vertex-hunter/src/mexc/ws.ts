import { gunzipSync, inflateSync } from 'node:zlib';
import { parseTickers } from './parse.ts';
import type { Ticker } from './types.ts';

export interface WsLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((ev: any) => void) | null;
  onmessage: ((ev: { data: any }) => void) | null;
  onclose: ((ev: any) => void) | null;
  onerror: ((ev: any) => void) | null;
}

export interface WsClientOptions {
  url: string;
  factory?: (url: string) => WsLike;
  onTickers: (tickers: Ticker[], droppedCount: number) => void;
  onState: (connected: boolean, detail: string) => void;
  now?: () => number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
  pingIntervalMs?: number;
  /** No inbound message for this long => assume the socket is dead and reconnect. */
  silenceTimeoutMs?: number;
  maxBackoffMs?: number;
}

export class MexcWs {
  connected = false;
  reconnects = 0;
  messages = 0;
  lastMessageTs: number | null = null;
  lastError: string | null = null;
  private ws: WsLike | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private stopped = false;
  private now: () => number;

  private o: WsClientOptions;
  constructor(o: WsClientOptions) {
    this.o = o;
    this.now = o.now ?? Date.now;
  }

  start(): void {
    this.stopped = false;
    this.open();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    try { this.ws?.close(); } catch { /* ignore */ }
    this.setConnected(false, 'stopped');
  }

  private open(): void {
    if (this.stopped) return;
    let ws: WsLike;
    try {
      ws = this.o.factory ? this.o.factory(this.o.url) : (new WebSocket(this.o.url) as unknown as WsLike);
    } catch (e: any) {
      this.lastError = String(e?.message ?? e);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      this.lastMessageTs = this.now();
      this.setConnected(true, 'open');
      // gzip:false asks the server for plain JSON; we still tolerate compressed frames below.
      ws.send(JSON.stringify({ method: 'sub.tickers', param: {}, gzip: false }));
      this.pingTimer = setInterval(() => {
        try { ws.send(JSON.stringify({ method: 'ping' })); } catch { /* handled by watchdog */ }
      }, this.o.pingIntervalMs ?? 15_000);
      this.watchdog = setInterval(() => {
        if (this.lastMessageTs !== null && this.now() - this.lastMessageTs > (this.o.silenceTimeoutMs ?? 30_000)) {
          this.lastError = 'silence timeout';
          try { ws.close(); } catch { /* ignore */ }
          this.handleClose(ws, 'silence timeout');
        }
      }, 5_000);
    };
    ws.onmessage = (ev) => { void this.handleMessage(ev.data); };
    ws.onerror = (ev) => { this.lastError = String(ev?.message ?? 'socket error'); };
    ws.onclose = () => this.handleClose(ws, 'closed');
  }

  private handleClose(ws: WsLike, why: string): void {
    if (this.ws !== ws) return; // stale socket
    this.ws = null;
    this.clearTimers();
    this.setConnected(false, why);
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.retryTimer) return;
    this.attempt++;
    this.reconnects++;
    const base = Math.min(this.o.maxBackoffMs ?? 30_000, 1000 * 2 ** Math.min(this.attempt - 1, 5));
    const delay = base + Math.floor(base * 0.2 * ((this.attempt * 7919) % 100) / 100);
    this.retryTimer = (this.o.setTimer ?? setTimeout)(() => { this.retryTimer = null; this.open(); }, delay);
  }

  private clearTimers(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.watchdog) clearInterval(this.watchdog);
    this.pingTimer = null; this.watchdog = null;
  }

  private setConnected(v: boolean, detail: string): void {
    const changed = this.connected !== v;
    this.connected = v;
    if (changed || !v) this.o.onState(v, detail);
  }

  async handleMessage(raw: unknown): Promise<void> {
    this.lastMessageTs = this.now();
    this.messages++;
    let text: string;
    try { text = await decodeFrame(raw); } catch (e: any) { this.lastError = `decode: ${e?.message}`; return; }
    let msg: any;
    try { msg = JSON.parse(text); } catch { this.lastError = 'non-JSON frame'; return; }
    const channel = msg?.channel;
    if (channel === 'push.tickers') {
      const { tickers, dropped } = parseTickers(msg.data, this.now(), 'ws');
      if (tickers.length || dropped) this.o.onTickers(tickers, dropped);
    } else if (channel === 'rs.error') {
      this.lastError = `server error: ${JSON.stringify(msg.data)}`;
    }
    // pong / rs.sub.* acknowledgements need no action; they still refresh lastMessageTs for the watchdog.
  }
}

async function decodeFrame(raw: unknown): Promise<string> {
  if (typeof raw === 'string') return raw;
  let buf: Buffer;
  if (raw instanceof ArrayBuffer) buf = Buffer.from(raw);
  else if (ArrayBuffer.isView(raw)) buf = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  else if (typeof Blob !== 'undefined' && raw instanceof Blob) buf = Buffer.from(await raw.arrayBuffer());
  else throw new Error('unsupported frame type');
  if (buf[0] === 0x1f && buf[1] === 0x8b) return gunzipSync(buf).toString('utf8');
  try { return inflateSync(buf).toString('utf8'); } catch { return buf.toString('utf8'); }
}
