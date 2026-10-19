# Vertex Hunter

A research and **paper-trading** engine for MEXC USDT-margined perpetual futures. It scans every eligible contract for early-momentum setups using an explainable, configurable score, records every signal with the price available at that moment, and runs an independent virtual **$100** wallet.

> **Paper trading only.** There are no exchange credentials anywhere in this project, it only calls MEXC's *public* market-data endpoints, and the wallet module contains no network or order code (a test enforces this). It cannot place real orders or withdraw funds.
>
> A score is a ranking, **not a probability of success**. Nothing here has been shown to be profitable. See [What is and isn't validated](#what-is-and-isnt-validated).

## What it does

| Area | Implementation |
|---|---|
| Live data | WebSocket `sub.tickers` (all contracts) + REST reconciliation every 4s, candles via REST `kline`, depth for the top shortlist |
| Data health | `LIVE` / `DELAYED` / `STALE` / `DISCONNECTED`. Outside `LIVE`, no new signals and no new paper entries are created. Open positions keep being tracked |
| Pipeline hardening | Reconnect with backoff, silence watchdog, ping, per-endpoint rate limiter (60% of documented limits), retry/backoff on 429/5xx, duplicate and out-of-order drop, exchange-timestamp skew check, partial WS pushes never erase REST-only fields |
| Scanner | 6 strategy components + liquidity: volume anomaly, multi-timeframe momentum/acceleration, volatility expansion after compression, breakout proximity with closed-candle confirmation, OI-vs-price, order-book imbalance (only when a fresh book exists), funding crowding, failed-breakout/exhaustion penalties |
| States | `LONG_WATCH`, `SHORT_WATCH`, `CONFIRMED_SETUP`, `INVALIDATED_SETUP` (+ `DETERIORATING` on the shortlist) |
| Filters | Late-entry (move already done), 24h chase limit, min liquidity, max spread, funding crowding |
| Missing data | Unavailable inputs are listed and **excluded** from the score (weights renormalise). Nothing is zero-filled or invented |
| Signals | SQLite, immutable entry price/time (enforced by DB triggers), live gross ROI, estimated net ROI (fees + slippage + funding), MFE/MAE, invalidation/target/expiry resolution |
| AI wallet | $100 virtual, risk-based sizing, contract step/min-size/margin rules, simulated spread+slippage fills, partial take-profit at +1R then breakeven stop, add-to-winner rule, funding settlement, estimated-liquidation cut-off, daily loss limit, cooldowns, every action *and rejection* in an append-only ledger with strategy version, config version and recorded inputs |
| Notifications | In-app toasts + bell, browser notifications if permitted, persisted |
| Backtest | Walk-forward on real MEXC candles, next-bar-open fills, stop-first tie rule, in-sample vs unseen window, by state/regime, explicit evidence verdict |
| Config | Versioned; every change creates a new version; revert from the Settings tab |

## Run it

Requires Node.js **22.18+** (uses built-in `node:sqlite` and native TypeScript stripping). Only one npm dependency (`lightweight-charts`, for the candlestick chart).

```bash
npm install
cp .env.example .env     # optional; all defaults work
npm start                # http://localhost:3000
npm test                 # 75 tests
npm run probe            # validates the parsers against the REAL MEXC API (needs network)
```

**First thing to do on a machine with internet access: `npm run probe`.** It checks the live endpoints, timestamp units, kline units, ticker field availability and the WebSocket against the exact parsers the app uses.

Open-interest history needs ~30 minutes of runtime before that component becomes available (it is derived from our own ticker snapshots). Until then it is shown as *unavailable* and left out of the score.

## Deploy (Railway, persistent)

GitHub Pages cannot run this: it needs a long-lived backend and a database file.

1. Push this repo to GitHub.
2. Railway → New Project → Deploy from GitHub repo. `railway.json` + `Dockerfile` are picked up automatically.
3. Add a **Volume** mounted at `/data` (this is where the SQLite DB lives; without it, history resets on every deploy).
4. Variables: `DATA_DIR=/data`, and strongly recommended `DASHBOARD_TOKEN=<long random string>`. Open the app once with `https://<your-domain>/?token=<that string>` (it sets a cookie).
5. Keep **one replica** (the engine holds the live state in memory and SQLite is single-writer).
6. Check `/api/health` and the status pill in the header.

No secrets are required. Do **not** add MEXC API keys. They are not used.

### Recovery

* Restart/redeploy: signals, positions, wallet cash and config versions reload from the DB; open signals and positions continue to be tracked. Candle caches rebuild within a few minutes; the OI component returns after ~30 min.
* Feed outage: UI shows DELAYED/STALE/DISCONNECTED; entries are paused automatically and resume when `LIVE`.
* Verify the ledger any time: `GET /api/reconcile` (recomputes cash from the append-only ledger and from position records; they must agree).
* To reset the paper wallet and history, stop the service and delete `vertex-hunter.db*` in the data directory. Nothing else is needed.

## Architecture

```
MEXC WS (tickers) ─┐                       ┌─> SignalTracker ─> SQLite (signals, marks)
MEXC REST (ticker, ├─> MarketStore ─> Runner ─> Scoring (pure) ─┤
 kline, depth)     ┘   (dedupe, ts check)  │                    └─> PaperWallet ─> SQLite (append-only ledger)
                                            └─> HTTP/SSE API ─> terminal UI
```

* `src/calc/pnl.ts` – every ROI/PnL/sizing/fill formula as pure, tested functions.
* `src/engine/scoring.ts` – pure `evaluate()`; same inputs ⇒ same output.
* `src/backtest.ts` reuses the *same* `evaluate()` so live and backtest logic cannot drift.
* `scripts/fake-mexc.ts` is a **test-only** local emulator of the documented API shapes (synthetic data). It is never used in production.

## What is and isn't validated

**Tested (75 automated tests):** ROI/PnL for long/short, fees, funding, slippage, step/min-size precision, sizing caps, wallet reconciliation, append-only ledger, restart persistence, duplicate suppression, cooldowns, risk limits, stale/disconnected gating, WS reconnect, rate-limit/retry, parser robustness, and **no look-ahead** in the backtester (decisions are provably identical when future candles are deleted or altered).

**Exercised end-to-end locally** against a synthetic MEXC emulator with the real server process: live → scan → confirmed signal → virtual position → ledger reconcile → restart → state intact.

**NOT validated – you must check on your side:**

1. **Real MEXC responses.** The build environment could not reach MEXC (egress blocked), so field shapes follow MEXC's published docs but were *not* confirmed against live responses. Run `npm run probe` first. Specific assumptions to confirm: ticker `timestamp` in ms, kline `time` in seconds, depth row layout `[price, orders, qty]`, and WebSocket `sub.tickers` / `push.tickers` message shapes. (`riseFallRate` unit is auto-detected at runtime.)
2. **Any claim of profitability.** No live paper track record exists yet. The backtest module exists and is honest about its limits (survivorship bias, no historical OI/funding/depth, short window), and will say `INSUFFICIENT_EVIDENCE` until there are ≥30 out-of-sample trades. Treat default thresholds as untuned starting points.
3. **Funding and liquidation** are simplified (8h UTC grid assumed; liquidation price is a conservative estimate, not MEXC's tiered formula).
4. **Automatic strategy learning** is deliberately *not* implemented. Changing parameters on a handful of trades would be overfitting. Instead you can toggle strategies, edit weights/thresholds, version configs and compare backtests, each wallet action records the config version it used.

## Licence / disclaimer

For research and education. Not financial advice. Crypto futures are high-risk; paper results do not predict real results.
