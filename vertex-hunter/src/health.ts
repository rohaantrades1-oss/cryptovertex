import type { HealthState } from './mexc/types.ts';

export interface HealthInputs {
  wsConnected: boolean;
  /** Local receive time of the last accepted ticker batch (ws or rest); null if never. */
  lastTickerReceivedTs: number | null;
  /** Consecutive failed REST ticker polls. */
  restConsecutiveFailures: number;
  /** Contract metadata loaded at least once. */
  contractsLoaded: boolean;
}

export interface HealthLimits { delayedAfterMs: number; staleAfterMs: number }

export interface Health {
  state: HealthState;
  /** New actionable signals / paper entries are permitted only in LIVE. */
  actionable: boolean;
  ageMs: number | null;
  reason: string;
}

/**
 * LIVE         WebSocket connected, fresh data, contract metadata loaded.
 * DELAYED      Data is arriving but late, or only REST polling is feeding us.
 * STALE        Data has arrived before, but nothing fresh for staleAfterMs.
 * DISCONNECTED No data source is working (never received data, or WS down and REST failing repeatedly).
 */
export function computeHealth(i: HealthInputs, lim: HealthLimits, now: number): Health {
  const age = i.lastTickerReceivedTs === null ? null : Math.max(0, now - i.lastTickerReceivedTs);
  if (age === null) return { state: 'DISCONNECTED', actionable: false, ageMs: null, reason: 'no market data received yet' };
  if (!i.wsConnected && i.restConsecutiveFailures >= 3) return { state: 'DISCONNECTED', actionable: false, ageMs: age, reason: 'websocket down and REST failing' };
  if (age > lim.staleAfterMs) return { state: 'STALE', actionable: false, ageMs: age, reason: `no fresh ticker for ${(age / 1000).toFixed(0)}s` };
  if (age > lim.delayedAfterMs) return { state: 'DELAYED', actionable: false, ageMs: age, reason: `data ${(age / 1000).toFixed(1)}s old` };
  if (!i.wsConnected) return { state: 'DELAYED', actionable: false, ageMs: age, reason: 'websocket down; using REST polling' };
  if (!i.contractsLoaded) return { state: 'DELAYED', actionable: false, ageMs: age, reason: 'contract metadata not loaded' };
  return { state: 'LIVE', actionable: true, ageMs: age, reason: 'ok' };
}
