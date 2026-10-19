// Pure, deterministic calculation helpers. No I/O, no clocks, no randomness.
// Every number the UI shows for ROI / PnL comes from here so it is reproducible and unit-tested.

export type Direction = 'LONG' | 'SHORT';

export function dirSign(d: Direction): 1 | -1 {
  return d === 'LONG' ? 1 : -1;
}

/** Gross, unleveraged, cost-free price return in percent. */
export function grossRoiPct(direction: Direction, entry: number, current: number): number {
  assertPositive(entry, 'entry');
  assertPositive(current, 'current');
  return ((current - entry) / entry) * 100 * dirSign(direction);
}

export interface ContractSpec {
  symbol: string;
  /** Underlying units per contract (MEXC `contractSize`). */
  contractSize: number;
  /** Quantity step in contracts (`volUnit`). */
  volUnit: number;
  /** Minimum order size in contracts (`minVol`). */
  minVol: number;
  /** Maximum order size in contracts (`maxVol`). */
  maxVol: number;
  /** Price tick (`priceUnit`). */
  priceUnit: number;
  takerFeeRate: number;
  makerFeeRate: number;
  maxLeverage: number;
  maintenanceMarginRate: number;
}

const EPS = 1e-12;

function assertPositive(v: number, name: string): void {
  if (!Number.isFinite(v) || v <= 0) throw new RangeError(`${name} must be a positive finite number, got ${v}`);
}

/** Round DOWN to a step, tolerant to float noise (e.g. 0.3/0.1). */
export function floorToStep(value: number, step: number): number {
  assertPositive(step, 'step');
  const n = Math.floor(value / step + EPS);
  const decimals = decimalPlaces(step);
  return Number((n * step).toFixed(decimals));
}

export function roundToTick(price: number, tick: number, mode: 'nearest' | 'up' | 'down' = 'nearest'): number {
  assertPositive(tick, 'tick');
  const q = price / tick;
  const n = mode === 'up' ? Math.ceil(q - EPS) : mode === 'down' ? Math.floor(q + EPS) : Math.round(q);
  return Number((n * tick).toFixed(decimalPlaces(tick)));
}

export function decimalPlaces(x: number): number {
  if (!Number.isFinite(x)) return 0;
  const s = x.toString();
  if (s.includes('e-')) return Number(s.split('e-')[1]) + (s.split('e-')[0].split('.')[1]?.length ?? 0);
  return s.split('.')[1]?.length ?? 0;
}

export function notionalUsd(contracts: number, spec: Pick<ContractSpec, 'contractSize'>, price: number): number {
  return contracts * spec.contractSize * price;
}

export interface SizingInput {
  spec: ContractSpec;
  /** Intended entry price (already slippage-adjusted). */
  price: number;
  leverage: number;
  /** Equity currently available as free margin. */
  availableBalance: number;
  /** Max fraction of total equity that may be put at risk if the stop is hit. */
  riskFractionOfEquity: number;
  totalEquity: number;
  /** Stop distance as a fraction of entry price (e.g. 0.03). */
  stopDistanceFrac: number;
  /** Cap on margin as a fraction of total equity for a single position. */
  maxMarginFractionOfEquity: number;
  /** Fee rate applied per side. */
  feeRate: number;
}

export interface SizingResult {
  ok: boolean;
  reason?: string;
  contracts: number;
  notional: number;
  margin: number;
  estEntryFee: number;
  riskAtStopUsd: number;
}

/**
 * Position sizing: size so that a stop-out loses (price move + round-trip fees) <= riskFraction * equity,
 * bounded by margin caps and free balance, then floored to contract step. Rejects below minVol.
 */
export function sizePosition(i: SizingInput): SizingResult {
  const fail = (reason: string): SizingResult => ({ ok: false, reason, contracts: 0, notional: 0, margin: 0, estEntryFee: 0, riskAtStopUsd: 0 });
  if (!(i.price > 0) || !(i.leverage >= 1) || !(i.stopDistanceFrac > 0)) return fail('invalid sizing inputs');
  const lev = Math.min(i.leverage, i.spec.maxLeverage);
  const unitNotional = i.spec.contractSize * i.price; // USD per contract
  if (!(unitNotional > 0)) return fail('invalid contract notional');

  const riskBudget = i.totalEquity * i.riskFractionOfEquity;
  const lossPerContract = unitNotional * (i.stopDistanceFrac + 2 * i.feeRate);
  const byRisk = riskBudget / lossPerContract;

  const marginBudget = Math.min(i.availableBalance, i.totalEquity * i.maxMarginFractionOfEquity);
  // margin + entry fee must fit in the budget
  const byMargin = marginBudget / (unitNotional / lev + unitNotional * i.feeRate);

  let contracts = floorToStep(Math.min(byRisk, byMargin, i.spec.maxVol), i.spec.volUnit);
  if (contracts < i.spec.minVol - EPS) {
    const need = i.spec.minVol * (unitNotional / lev + unitNotional * i.feeRate);
    return fail(`below minimum order size (${i.spec.minVol} contracts needs ~$${need.toFixed(2)} margin+fee; risk/margin budget allows ${contracts})`);
  }
  const notional = contracts * unitNotional;
  const margin = notional / lev;
  return {
    ok: true,
    contracts,
    notional,
    margin,
    estEntryFee: notional * i.feeRate,
    riskAtStopUsd: contracts * lossPerContract,
  };
}

/** Simulated market-order fill price including spread crossing and slippage in basis points. */
export function simulatedFillPrice(direction: Direction, action: 'OPEN' | 'CLOSE', ref: { bid?: number; ask?: number; last: number }, slippageBps: number, tick: number): number {
  const buying = (direction === 'LONG') === (action === 'OPEN');
  const base = buying ? (ref.ask ?? ref.last) : (ref.bid ?? ref.last);
  const slipped = base * (1 + (buying ? 1 : -1) * (slippageBps / 10000));
  return roundToTick(slipped, tick, buying ? 'up' : 'down');
}

export interface PositionPnlInput {
  direction: Direction;
  contracts: number;
  contractSize: number;
  entryPrice: number;
  markPrice: number;
  leverage: number;
  /** Fees already paid when opening (USD). */
  entryFees: number;
  /** Fee rate to be paid when closing at markPrice. */
  exitFeeRate: number;
  /** Net funding paid (+) or received (-) so far (USD). */
  fundingPaid: number;
}

export interface PositionPnl {
  notional: number;
  margin: number;
  grossPnl: number;
  grossPricePct: number;
  estExitFee: number;
  netPnl: number;
  /** Net PnL divided by allocated margin: the return on the capital actually committed. */
  marginRoiPct: number;
  /** Underlying move, NOT multiplied by leverage. */
  underlyingPricePct: number;
}

export function positionPnl(i: PositionPnlInput): PositionPnl {
  const sign = dirSign(i.direction);
  const qtyUnits = i.contracts * i.contractSize;
  const notional = qtyUnits * i.entryPrice;
  const margin = notional / i.leverage;
  const grossPnl = (i.markPrice - i.entryPrice) * qtyUnits * sign;
  const estExitFee = qtyUnits * i.markPrice * i.exitFeeRate;
  const netPnl = grossPnl - i.entryFees - estExitFee - i.fundingPaid;
  return {
    notional,
    margin,
    grossPnl,
    grossPricePct: grossRoiPct(i.direction, i.entryPrice, i.markPrice),
    estExitFee,
    netPnl,
    marginRoiPct: margin > 0 ? (netPnl / margin) * 100 : 0,
    underlyingPricePct: ((i.markPrice - i.entryPrice) / i.entryPrice) * 100,
  };
}

/** Funding for one settlement: positive rate => longs pay shorts. Returns USD paid (+) / received (-). */
export function fundingPayment(direction: Direction, contracts: number, contractSize: number, markPrice: number, fundingRate: number): number {
  return contracts * contractSize * markPrice * fundingRate * dirSign(direction);
}

/**
 * Approximate isolated-margin liquidation price. This is an ESTIMATE: MEXC's real formula uses
 * tiered maintenance margin and fees. Used only to warn / force-close in paper trading conservatively.
 */
export function estLiquidationPrice(direction: Direction, entry: number, leverage: number, maintenanceMarginRate: number): number {
  const m = 1 / leverage;
  return direction === 'LONG' ? entry * (1 - m + maintenanceMarginRate) : entry * (1 + m - maintenanceMarginRate);
}

/** Excursions in percent of entry price (favourable >= 0, adverse <= 0). */
export function updateExcursion(direction: Direction, entry: number, price: number, prev: { mfePct: number; maePct: number }) {
  const r = grossRoiPct(direction, entry, price);
  return { mfePct: Math.max(prev.mfePct, r), maePct: Math.min(prev.maePct, r) };
}
