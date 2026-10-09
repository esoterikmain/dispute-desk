import path from "node:path";
import fs from "node:fs";

// One tiny SQL interface over two drivers: node-postgres when DATABASE_URL is set
// (Render), PGlite (Postgres compiled to WASM, no install) otherwise.

export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  exec(sql: string): Promise<void>;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS disputes (
  id text PRIMARY KEY,
  source text NOT NULL DEFAULT 'paypal',
  status text NOT NULL,
  reason text NOT NULL,
  stage text,
  amount double precision NOT NULL,
  currency text NOT NULL,
  buyer_name text,
  buyer_email text,
  transaction_id text,
  order_id text,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  response_due text,
  outcome text,
  resolved_at text,
  agent_status text NOT NULL DEFAULT 'idle',
  agent_step text,
  engine text,
  verdict jsonb,
  evidence_score integer,
  decision text,
  decided_by text,
  submitted_at text,
  raw jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS orders (
  id text PRIMARY KEY,
  capture_id text,
  buyer_email text,
  created_at text NOT NULL,
  doc jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS orders_capture_idx ON orders (capture_id);
CREATE TABLE IF NOT EXISTS audit_log (
  id serial PRIMARY KEY,
  dispute_id text,
  actor text NOT NULL,
  action text NOT NULL,
  detail jsonb,
  at text NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS ai_usage (
  day text NOT NULL,
  kind text NOT NULL,
  count integer NOT NULL,
  PRIMARY KEY (day, kind)
);
CREATE TABLE IF NOT EXISTS sim_disputes (
  id text PRIMARY KEY,
  doc jsonb NOT NULL
);
`;

// Idempotent upgrades for databases created by earlier versions.
const MIGRATIONS = `
ALTER TABLE disputes ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'paypal';
UPDATE disputes SET source = 'simulator' WHERE source <> 'simulator' AND id IN (SELECT id FROM sim_disputes);
`;

async function open(): Promise<Db> {
  let db: Db;
  if (process.env.DATABASE_URL) {
    const { Pool } = await import("pg");
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL) ? undefined : { rejectUnauthorized: false },
    });
    db = {
      query: async (sql, params) => (await pool.query(sql, params as unknown[])).rows,
      exec: async (sql) => void (await pool.query(sql)),
    };
  } else {
    const { PGlite } = await import("@electric-sql/pglite");
    let pg;
    if (process.env.DISPUTE_DESK_DB === "memory") {
      pg = new PGlite();
    } else {
      const dir = path.join(process.cwd(), ".data", "pglite");
      fs.mkdirSync(dir, { recursive: true });
      pg = new PGlite(dir);
    }
    db = {
      query: async (sql, params) => (await pg.query(sql, params as unknown[])).rows as never,
      exec: async (sql) => void (await pg.exec(sql)),
    };
  }
  await db.exec(SCHEMA);
  await db.exec(MIGRATIONS);
  return db;
}

// Survive Next.js dev hot reloads: keep one connection per process.
const g = globalThis as unknown as { __disputeDeskDb?: Promise<Db> };

export function getDb(): Promise<Db> {
  if (!g.__disputeDeskDb) g.__disputeDeskDb = open();
  return g.__disputeDeskDb;
}
