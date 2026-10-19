import test from 'node:test';
import assert from 'node:assert/strict';
import {
  grossRoiPct, floorToStep, roundToTick, sizePosition, simulatedFillPrice, positionPnl,
  fundingPayment, estLiquidationPrice, updateExcursion, type ContractSpec,
} from '../src/calc/pnl.ts';

const spec: ContractSpec = {
  symbol: 'TEST_USDT', contractSize: 1, volUnit: 1, minVol: 1, maxVol: 1_000_000,
  priceUnit: 0.0001, takerFeeRate: 0.0002, makerFeeRate: 0, maxLeverage: 20, maintenanceMarginRate: 0.005,
};
const close = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`);

test('gross ROI long/short use spec formulas', () => {
  close(grossRoiPct('LONG', 100, 110), 10);
  close(grossRoiPct('SHORT', 100, 110), -10);
  close(grossRoiPct('SHORT', 100, 90), 10);
  close(grossRoiPct('LONG', 100, 90), -10);
});

test('gross ROI rejects non-positive prices', () => {
  assert.throws(() => grossRoiPct('LONG', 0, 1));
  assert.throws(() => grossRoiPct('LONG', 1, NaN));
});

test('floorToStep handles float noise and never rounds up', () => {
  assert.equal(floorToStep(0.3, 0.1), 0.3);
  assert.equal(floorToStep(10.99, 1), 10);
  assert.equal(floorToStep(0.0299, 0.01), 0.02);
  assert.equal(floorToStep(5, 10), 0);
});

test('roundToTick modes', () => {
  assert.equal(roundToTick(1.23456, 0.001, 'down'), 1.234);
  assert.equal(roundToTick(1.23456, 0.001, 'up'), 1.235);
  assert.equal(roundToTick(1.2344, 0.001), 1.234);
});

test('fill price: buyer pays ask + slippage, seller gets bid - slippage', () => {
  const ref = { bid: 99.9, ask: 100.1, last: 100 };
  const longOpen = simulatedFillPrice('LONG', 'OPEN', ref, 5, 0.01);
  assert.ok(longOpen > 100.1, 'long open must be worse than ask');
  const longClose = simulatedFillPrice('LONG', 'CLOSE', ref, 5, 0.01);
  assert.ok(longClose < 99.9, 'long close must be worse than bid');
  const shortOpen = simulatedFillPrice('SHORT', 'OPEN', ref, 5, 0.01);
  assert.ok(shortOpen < 99.9);
  const shortClose = simulatedFillPrice('SHORT', 'CLOSE', ref, 5, 0.01);
  assert.ok(shortClose > 100.1);
});

test('fill price falls back to last when book missing', () => {
  const p = simulatedFillPrice('LONG', 'OPEN', { last: 50 }, 0, 0.01);
  assert.equal(p, 50);
});

test('positionPnl long: net = gross - fees - funding; margin ROI separate from underlying move', () => {
  const r = positionPnl({
    direction: 'LONG', contracts: 100, contractSize: 1, entryPrice: 10, markPrice: 11,
    leverage: 5, entryFees: 0.2, exitFeeRate: 0.0002, fundingPaid: 0.1,
  });
  close(r.notional, 1000);
  close(r.margin, 200);
  close(r.grossPnl, 100);
  close(r.underlyingPricePct, 10);
  close(r.estExitFee, 100 * 11 * 0.0002);
  close(r.netPnl, 100 - 0.2 - 0.22 - 0.1);
  close(r.marginRoiPct, (r.netPnl / 200) * 100);
  assert.ok(Math.abs(r.marginRoiPct - 5 * r.underlyingPricePct) > 0.1, 'margin ROI is not simply leverage x price move once costs are included');
});

test('positionPnl short loses when price rises', () => {
  const r = positionPnl({
    direction: 'SHORT', contracts: 10, contractSize: 1, entryPrice: 100, markPrice: 110,
    leverage: 10, entryFees: 0, exitFeeRate: 0, fundingPaid: 0,
  });
  close(r.grossPnl, -100);
  close(r.grossPricePct, -10);
  close(r.marginRoiPct, -100);
});

test('funding: positive rate means longs pay and shorts receive', () => {
  assert.ok(fundingPayment('LONG', 100, 1, 10, 0.0001) > 0);
  assert.ok(fundingPayment('SHORT', 100, 1, 10, 0.0001) < 0);
  close(fundingPayment('LONG', 100, 1, 10, 0.0001), 0.1);
});

test('liquidation estimate sits on the correct side of entry', () => {
  const l = estLiquidationPrice('LONG', 100, 10, 0.005);
  const s = estLiquidationPrice('SHORT', 100, 10, 0.005);
  assert.ok(l < 100 && s > 100);
  close(l, 100 * (1 - 0.1 + 0.005));
});

test('excursions track max favourable and adverse', () => {
  let e = { mfePct: 0, maePct: 0 };
  e = updateExcursion('LONG', 100, 105, e);
  e = updateExcursion('LONG', 100, 97, e);
  e = updateExcursion('LONG', 100, 101, e);
  close(e.mfePct, 5);
  close(e.maePct, -3);
});

test('sizing respects step, min size, margin and risk caps', () => {
  const r = sizePosition({
    spec, price: 1, leverage: 5, availableBalance: 100, totalEquity: 100,
    riskFractionOfEquity: 0.02, stopDistanceFrac: 0.03, maxMarginFractionOfEquity: 0.3, feeRate: 0.0002,
  });
  assert.ok(r.ok);
  assert.ok(Number.isInteger(r.contracts));
  assert.ok(r.margin <= 30 + 1e-9, `margin ${r.margin}`);
  assert.ok(r.riskAtStopUsd <= 2 + 1e-9, `risk ${r.riskAtStopUsd}`);
});

test('sizing rejects when below minimum order size', () => {
  const big: ContractSpec = { ...spec, contractSize: 0.01, minVol: 1 };
  const r = sizePosition({
    spec: big, price: 70000, leverage: 5, availableBalance: 100, totalEquity: 100,
    riskFractionOfEquity: 0.02, stopDistanceFrac: 0.03, maxMarginFractionOfEquity: 0.3, feeRate: 0.0002,
  });
  assert.equal(r.ok, false);
  assert.match(r.reason ?? '', /minimum/);
});

test('sizing caps leverage at contract maximum', () => {
  const low: ContractSpec = { ...spec, maxLeverage: 2 };
  const r = sizePosition({
    spec: low, price: 1, leverage: 50, availableBalance: 100, totalEquity: 100,
    riskFractionOfEquity: 0.5, stopDistanceFrac: 0.01, maxMarginFractionOfEquity: 1, feeRate: 0,
  });
  assert.ok(r.ok);
  close(r.margin, r.notional / 2, 1e-6);
});
