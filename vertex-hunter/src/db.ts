import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DEFAULT_CONFIG, type AppConfig } from './config.ts';

export type DB = DatabaseSync;

export const INITIAL_WALLET_USD = 100;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS config_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL,
  label TEXT NOT NULL,
  config_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS signals (
  id TEXT PRIMARY KEY,
  symbol TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('LONG','SHORT')),
  state TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  entry_price REAL NOT NULL,
  strategy_version TEXT NOT NULL,
  config_version INTEGER NOT NULL,
  score REAL NOT NULL,
  components_json TEXT NOT NULL,
  reasons_json TEXT NOT NULL,
  market_json TEXT NOT NULL,
  invalidation_price REAL,
  target_price REAL,
  status TEXT NOT NULL DEFAULT 'OPEN',
  closed_at INTEGER,
  exit_price REAL,
  outcome TEXT,
  last_price REAL,
  last_update INTEGER,
  mfe_pct REAL NOT NULL DEFAULT 0,
  mae_pct REAL NOT NULL DEFAULT 0,
  est_roundtrip_cost_pct REAL NOT NULL DEFAULT 0,
  funding_rate_at_entry REAL
);
CREATE INDEX IF NOT EXISTS idx_signals_symbol ON signals(symbol, created_at);
CREATE INDEX IF NOT EXISTS idx_signals_status ON signals(status);

CREATE TABLE IF NOT EXISTS signal_marks (
  signal_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  price REAL NOT NULL,
  PRIMARY KEY (signal_id, ts)
);

CREATE TABLE IF NOT EXISTS positions (
  id TEXT PRIMARY KEY,
  symbol TEXT NOT NULL,
  direction TEXT NOT NULL,
  status TEXT NOT NULL,
  contracts REAL NOT NULL,
  contract_size REAL NOT NULL,
  avg_entry REAL NOT NULL,
  leverage REAL NOT NULL,
  margin REAL NOT NULL,
  entry_fees REAL NOT NULL DEFAULT 0,
  funding_paid REAL NOT NULL DEFAULT 0,
  realized_pnl REAL NOT NULL DEFAULT 0,
  stop_price REAL,
  target_price REAL,
  est_liq_price REAL,
  opened_at INTEGER NOT NULL,
  closed_at INTEGER,
  signal_id TEXT,
  strategy_version TEXT NOT NULL,
  config_version INTEGER NOT NULL,
  last_funding_ts INTEGER,
  mark_price REAL,
  mfe_pct REAL NOT NULL DEFAULT 0,
  mae_pct REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status);

-- Append-only wallet ledger. cash_delta is the signed change to free cash.
CREATE TABLE IF NOT EXISTS wallet_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('OPEN','ADD','REDUCE','CLOSE','REJECT','FUNDING')),
  position_id TEXT,
  symbol TEXT,
  direction TEXT,
  price REAL,
  contracts REAL,
  fees REAL NOT NULL DEFAULT 0,
  cash_delta REAL NOT NULL DEFAULT 0,
  realized_pnl_delta REAL NOT NULL DEFAULT 0,
  reason TEXT NOT NULL,
  strategy_version TEXT,
  config_version INTEGER,
  signal_id TEXT,
  inputs_json TEXT
);

-- Append-only audit log.
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  level TEXT NOT NULL,
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  data_json TEXT
);

CREATE TABLE IF NOT EXISTS equity_snapshots (
  ts INTEGER PRIMARY KEY,
  equity REAL NOT NULL,
  cash REAL NOT NULL,
  margin REAL NOT NULL,
  unrealized REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  read INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS backtest_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL,
  params_json TEXT NOT NULL,
  result_json TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS wallet_events_no_update BEFORE UPDATE ON wallet_events
BEGIN SELECT RAISE(ABORT, 'wallet_events is append-only'); END;
CREATE TRIGGER IF NOT EXISTS wallet_events_no_delete BEFORE DELETE ON wallet_events
BEGIN SELECT RAISE(ABORT, 'wallet_events is append-only'); END;
CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events
BEGIN SELECT RAISE(ABORT, 'events is append-only'); END;
CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events
BEGIN SELECT RAISE(ABORT, 'events is append-only'); END;
-- A signal's reference entry may never be rewritten after creation.
CREATE TRIGGER IF NOT EXISTS signals_entry_immutable BEFORE UPDATE OF entry_price, created_at, symbol, direction, strategy_version ON signals
BEGIN SELECT RAISE(ABORT, 'signal entry fields are immutable'); END;
`;

export function openDb(path: string): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  if (!db.prepare('SELECT 1 FROM config_versions LIMIT 1').get()) {
    db.prepare('INSERT INTO config_versions (created_at, label, config_json) VALUES (?,?,?)')
      .run(Date.now(), 'default', JSON.stringify(DEFAULT_CONFIG));
    setKv(db, 'active_config_version', '1');
  }
  if (getKv(db, 'wallet_initial') === undefined) {
    setKv(db, 'wallet_initial', String(INITIAL_WALLET_USD));
    setKv(db, 'wallet_created_at', String(Date.now()));
  }
  return db;
}

export function getKv(db: DB, key: string): string | undefined {
  const r = db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
  return r?.value;
}
export function setKv(db: DB, key: string, value: string): void {
  db.prepare('INSERT INTO kv (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
}

export function logEvent(db: DB, level: 'info' | 'warn' | 'error', kind: string, message: string, data?: unknown, ts = Date.now()): void {
  db.prepare('INSERT INTO events (ts, level, kind, message, data_json) VALUES (?,?,?,?,?)')
    .run(ts, level, kind, message, data === undefined ? null : JSON.stringify(data));
}

export function activeConfig(db: DB): { version: number; config: AppConfig } {
  const v = Number(getKv(db, 'active_config_version') ?? 1);
  const row = db.prepare('SELECT config_json FROM config_versions WHERE id = ?').get(v) as { config_json: string } | undefined;
  if (!row) throw new Error(`active config version ${v} missing`);
  return { version: v, config: JSON.parse(row.config_json) as AppConfig };
}

export function saveConfigVersion(db: DB, config: AppConfig, label: string): number {
  const r = db.prepare('INSERT INTO config_versions (created_at, label, config_json) VALUES (?,?,?)')
    .run(Date.now(), label, JSON.stringify(config));
  const id = Number(r.lastInsertRowid);
  setKv(db, 'active_config_version', String(id));
  logEvent(db, 'info', 'config', `Config version ${id} activated (${label})`);
  return id;
}

export function activateConfigVersion(db: DB, id: number): void {
  const row = db.prepare('SELECT id FROM config_versions WHERE id = ?').get(id);
  if (!row) throw new Error(`config version ${id} not found`);
  setKv(db, 'active_config_version', String(id));
  logEvent(db, 'info', 'config', `Reverted/activated config version ${id}`);
}

export function addNotification(db: DB, kind: string, title: string, body: string, ts = Date.now()): void {
  db.prepare('INSERT INTO notifications (ts, kind, title, body) VALUES (?,?,?,?)').run(ts, kind, title, body);
}
