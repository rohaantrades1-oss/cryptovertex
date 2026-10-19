// Runtime environment + versioned strategy/risk configuration.

export const env = {
  port: Number(process.env.PORT ?? 3000),
  dataDir: process.env.DATA_DIR ?? './data',
  dashboardToken: process.env.DASHBOARD_TOKEN ?? '',
  restBase: process.env.MEXC_REST_BASE ?? 'https://contract.mexc.com',
  wsUrl: process.env.MEXC_WS_URL ?? 'wss://contract.mexc.com/edge',
};

export const STRATEGY_VERSION = 'vh-1.0.0';

export interface StrategyToggle { enabled: boolean }

export interface AppConfig {
  strategies: {
    volumeAnomaly: StrategyToggle;
    momentumAcceleration: StrategyToggle;
    volatilityExpansion: StrategyToggle;
    breakoutProximity: StrategyToggle;
    oiDivergence: StrategyToggle;
    reversalExhaustion: StrategyToggle;
  };
  /** Transparent component weights; normalised over the components that are actually available. */
  weights: {
    volume: number;
    momentum: number;
    volatility: number;
    breakout: number;
    openInterest: number;
    orderBook: number;
    funding: number;
    liquidity: number;
  };
  thresholds: {
    watchScore: number;      // minimum score to appear as LONG/SHORT WATCH
    confirmScore: number;    // minimum score to become CONFIRMED SETUP
    volumeZ: number;         // z-score at which volume component saturates
    minLiquidityUsd24h: number;
    maxSpreadBps: number;
    /** Late-entry filter: skip if move over lookbackBars already exceeds this percent. */
    lateEntryMovePct: number;
    lateEntryLookbackBars: number;
    /** Skip if 24h move already beyond this percent (avoid chasing). */
    max24hMovePct: number;
    maxAbsFundingRate: number;
    minCandlesRequired: number;
  };
  risk: {
    leverage: number;
    riskFractionOfEquity: number;
    maxMarginFractionOfEquity: number;
    maxOpenPositions: number;
    stopAtrMultiple: number;
    targetRMultiple: number;
    minStopPct: number;
    maxStopPct: number;
    slippageBps: number;
    maxHoldMinutes: number;
    dailyLossLimitPct: number;
    cooldownMinutesPerSymbol: number;
  };
  walletEnabled: boolean;
  dataQuality: {
    /** ms since last good ticker update before data is DELAYED / STALE. */
    delayedAfterMs: number;
    staleAfterMs: number;
    maxClockSkewMs: number;
  };
}

export const DEFAULT_CONFIG: AppConfig = {
  strategies: {
    volumeAnomaly: { enabled: true },
    momentumAcceleration: { enabled: true },
    volatilityExpansion: { enabled: true },
    breakoutProximity: { enabled: true },
    oiDivergence: { enabled: true },
    reversalExhaustion: { enabled: true },
  },
  weights: { volume: 0.25, momentum: 0.2, volatility: 0.15, breakout: 0.15, openInterest: 0.1, orderBook: 0.05, funding: 0.05, liquidity: 0.05 },
  thresholds: {
    watchScore: 45,
    confirmScore: 65,
    volumeZ: 4,
    minLiquidityUsd24h: 2_000_000,
    maxSpreadBps: 25,
    lateEntryMovePct: 12,
    lateEntryLookbackBars: 12,
    max24hMovePct: 35,
    maxAbsFundingRate: 0.002,
    minCandlesRequired: 40,
  },
  risk: {
    leverage: 5,
    riskFractionOfEquity: 0.02,
    maxMarginFractionOfEquity: 0.25,
    maxOpenPositions: 3,
    stopAtrMultiple: 2,
    targetRMultiple: 2,
    minStopPct: 0.8,
    maxStopPct: 6,
    slippageBps: 8,
    maxHoldMinutes: 240,
    dailyLossLimitPct: 6,
    cooldownMinutesPerSymbol: 60,
  },
  walletEnabled: true,
  dataQuality: { delayedAfterMs: 5_000, staleAfterMs: 20_000, maxClockSkewMs: 60_000 },
};

export function mergeConfig(base: AppConfig, patch: unknown): AppConfig {
  const out = structuredClone(base) as any;
  const apply = (dst: any, src: any, path: string) => {
    if (src === null || typeof src !== 'object' || Array.isArray(src)) throw new Error(`config.${path} must be an object`);
    for (const [k, v] of Object.entries(src)) {
      if (!(k in dst)) throw new Error(`unknown config key: ${path}.${k}`);
      if (dst[k] !== null && typeof dst[k] === 'object') apply(dst[k], v, `${path}.${k}`);
      else {
        if (typeof v !== typeof dst[k]) throw new Error(`config.${path}.${k} must be ${typeof dst[k]}`);
        if (typeof v === 'number' && !Number.isFinite(v)) throw new Error(`config.${path}.${k} must be finite`);
        dst[k] = v;
      }
    }
  };
  apply(out, patch, '');
  validateConfig(out);
  return out;
}

export function validateConfig(c: AppConfig): void {
  const w = Object.values(c.weights);
  if (w.some((x) => x < 0) || w.reduce((a, b) => a + b, 0) <= 0) throw new Error('weights must be >= 0 with positive sum');
  if (c.thresholds.confirmScore < c.thresholds.watchScore) throw new Error('confirmScore must be >= watchScore');
  if (c.risk.leverage < 1 || c.risk.leverage > 20) throw new Error('leverage must be within 1..20 (paper trading cap)');
  if (c.risk.riskFractionOfEquity <= 0 || c.risk.riskFractionOfEquity > 0.1) throw new Error('riskFractionOfEquity must be within (0, 0.1]');
  if (c.risk.maxMarginFractionOfEquity <= 0 || c.risk.maxMarginFractionOfEquity > 1) throw new Error('maxMarginFractionOfEquity must be within (0, 1]');
  if (c.risk.minStopPct <= 0 || c.risk.maxStopPct < c.risk.minStopPct) throw new Error('stop percent bounds invalid');
  if (c.risk.maxOpenPositions < 1) throw new Error('maxOpenPositions must be >= 1');
  if (c.dataQuality.staleAfterMs <= c.dataQuality.delayedAfterMs) throw new Error('staleAfterMs must exceed delayedAfterMs');
}
