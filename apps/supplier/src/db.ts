import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

// esbuild убирает префикс у node:sqlite, и сборка перестаёт находить модуль: подключаем встроенный модуль напрямую
const { DatabaseSync: Database } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

export type Db = DatabaseSync;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  inn           TEXT NOT NULL UNIQUE,
  company       TEXT NOT NULL,
  contact_name  TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  phone         TEXT,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  last_login_at TEXT,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until  TEXT
);

-- Заказ приходит от покупателя и подписан его системой: external_id это идентификатор в «Запасе»
CREATE TABLE IF NOT EXISTS orders (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  external_id   TEXT NOT NULL UNIQUE,
  number        TEXT NOT NULL,
  status        TEXT NOT NULL,
  status_label  TEXT NOT NULL,
  supplier_inn  TEXT NOT NULL,
  supplier_name TEXT NOT NULL,
  buyer_org     TEXT NOT NULL,
  buyer_location TEXT NOT NULL,
  buyer_address TEXT,
  expected_on   TEXT,
  comment       TEXT,
  total         REAL NOT NULL,
  lines         TEXT NOT NULL,
  buyer_note    TEXT,
  supplier_note TEXT,
  delivery_on   TEXT,
  received_at   TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  viewed_at     TEXT
);
CREATE INDEX IF NOT EXISTS orders_inn_idx ON orders (supplier_inn, received_at DESC);

CREATE TABLE IF NOT EXISTS events (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  at       TEXT NOT NULL,
  actor    TEXT NOT NULL,
  text     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_order_idx ON events (order_id, id);
`;

export function openDb(file: string): Db {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}
