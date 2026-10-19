import type { ContractSpec } from '../calc/pnl.ts';

export interface ContractInfo extends ContractSpec {
  baseCoin: string;
  quoteCoin: string;
  settleCoin: string;
  /** 0 enabled, 1 delivery, 2 delivered, 3 offline, 4 paused (MEXC `state`). */
  state: number;
  futureType: number;
  isNew: boolean;
  /** Unix ms; undefined when unavailable. */
  createTime?: number;
}

/** A normalised ticker. `undefined` means the exchange did not provide the field: never defaulted to 0. */
export interface Ticker {
  symbol: string;
  last: number;
  bid1?: number;
  ask1?: number;
  /** 24h volume in CONTRACTS (MEXC `volume24`). */
  volume24?: number;
  /** Exchange-reported 24h turnover; unit not documented, shown raw only. */
  amount24?: number;
  /** Open interest in contracts (`holdVol`). */
  holdVol?: number;
  fundingRate?: number;
  fairPrice?: number;
  indexPrice?: number;
  high24?: number;
  low24?: number;
  /** Exchange-reported 24h change as a fraction (0.05 = 5%), as sent. */
  riseFallRate?: number;
  /** Exchange timestamp in ms. */
  exchangeTs: number;
  /** Local receive time in ms. */
  receivedTs: number;
  source: 'ws' | 'rest';
}

export interface Candle {
  /** Open time in seconds (MEXC kline `time`). */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  /** Volume in contracts. */
  v: number;
}

export type Interval = 'Min1' | 'Min5' | 'Min15' | 'Min30' | 'Min60' | 'Hour4' | 'Day1';

export const INTERVAL_SECONDS: Record<Interval, number> = {
  Min1: 60, Min5: 300, Min15: 900, Min30: 1800, Min60: 3600, Hour4: 14400, Day1: 86400,
};

export interface DepthSnapshot {
  symbol: string;
  bids: Array<[price: number, qty: number]>;
  asks: Array<[price: number, qty: number]>;
  exchangeTs?: number;
  receivedTs: number;
}

export type HealthState = 'LIVE' | 'DELAYED' | 'STALE' | 'DISCONNECTED';
