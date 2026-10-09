import { getDb } from "./db";
import {
  DEFAULT_SETTINGS,
  type AuditEntry,
  type DisputeRow,
  type Settings,
  type StoreOrder,
} from "./types";

const now = () => new Date().toISOString();

export async function listDisputes(): Promise<DisputeRow[]> {
  const db = await getDb();
  return db.query<DisputeRow>("SELECT * FROM disputes ORDER BY created_at DESC");
}

export async function getDispute(id: string): Promise<DisputeRow | null> {
  const db = await getDb();
  const rows = await db.query<DisputeRow>("SELECT * FROM disputes WHERE id = $1", [id]);
  return rows[0] ?? null;
}

const JSON_COLUMNS = new Set(["verdict", "raw"]);

/** Patch a dispute row. Only the given columns change. */
export async function updateDispute(id: string, patch: Partial<DisputeRow>): Promise<void> {
  const keys = Object.keys(patch) as Array<keyof DisputeRow>;
  if (keys.length === 0) return;
  const db = await getDb();
  const sets = keys.map((k, i) => `${k} = $${i + 2}${JSON_COLUMNS.has(k) ? "::jsonb" : ""}`);
  const values = keys.map((k) => {
    const v = patch[k];
    return JSON_COLUMNS.has(k) && v != null ? JSON.stringify(v) : v;
  });
  await db.query(`UPDATE disputes SET ${sets.join(", ")} WHERE id = $1`, [id, ...values]);
}

export async function insertDispute(row: DisputeRow): Promise<void> {
  const db = await getDb();
  await db.query(
    `INSERT INTO disputes (source, id, status, reason, stage, amount, currency, buyer_name, buyer_email,
       transaction_id, order_id, created_at, updated_at, response_due, outcome, resolved_at,
       agent_status, agent_step, engine, verdict, evidence_score, decision, decided_by, submitted_at, raw)
     VALUES ($25,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19::jsonb,$20,$21,$22,$23,$24::jsonb)`,
    [
      row.id, row.status, row.reason, row.stage, row.amount, row.currency, row.buyer_name, row.buyer_email,
      row.transaction_id, row.order_id, row.created_at, row.updated_at, row.response_due, row.outcome,
      row.resolved_at, row.agent_status, row.agent_step, row.engine,
      row.verdict ? JSON.stringify(row.verdict) : null, row.evidence_score, row.decision, row.decided_by,
      row.submitted_at, JSON.stringify(row.raw), row.source,
    ],
  );
}

export async function saveOrder(order: StoreOrder): Promise<void> {
  const db = await getDb();
  await db.query(
    `INSERT INTO orders (id, capture_id, buyer_email, created_at, doc) VALUES ($1,$2,$3,$4,$5::jsonb)
     ON CONFLICT (id) DO UPDATE SET capture_id = $2, buyer_email = $3, doc = $5::jsonb`,
    [order.id, order.capture_id, order.buyer_email, order.placed_at, JSON.stringify(order)],
  );
}

export async function getOrder(id: string): Promise<StoreOrder | null> {
  const db = await getDb();
  const rows = await db.query<{ doc: StoreOrder }>("SELECT doc FROM orders WHERE id = $1", [id]);
  return rows[0]?.doc ?? null;
}

export async function getOrderByCapture(captureId: string): Promise<StoreOrder | null> {
  const db = await getDb();
  const rows = await db.query<{ doc: StoreOrder }>("SELECT doc FROM orders WHERE capture_id = $1", [captureId]);
  return rows[0]?.doc ?? null;
}

export async function listOrdersByBuyer(email: string): Promise<StoreOrder[]> {
  const db = await getDb();
  const rows = await db.query<{ doc: StoreOrder }>(
    "SELECT doc FROM orders WHERE buyer_email = $1 ORDER BY created_at DESC",
    [email],
  );
  return rows.map((r) => r.doc);
}

export async function listOrders(limit = 50): Promise<StoreOrder[]> {
  const db = await getDb();
  const rows = await db.query<{ doc: StoreOrder }>("SELECT doc FROM orders ORDER BY created_at DESC LIMIT $1", [limit]);
  return rows.map((r) => r.doc);
}

export async function audit(
  disputeId: string | null,
  actor: AuditEntry["actor"],
  action: string,
  detail?: Record<string, unknown>,
): Promise<void> {
  const db = await getDb();
  await db.query("INSERT INTO audit_log (dispute_id, actor, action, detail, at) VALUES ($1,$2,$3,$4::jsonb,$5)", [
    disputeId,
    actor,
    action,
    detail ? JSON.stringify(detail) : null,
    now(),
  ]);
}

export async function listAudit(disputeId: string): Promise<AuditEntry[]> {
  const db = await getDb();
  return db.query<AuditEntry>("SELECT * FROM audit_log WHERE dispute_id = $1 ORDER BY id ASC", [disputeId]);
}

export async function getSettings(): Promise<Settings> {
  const db = await getDb();
  const rows = await db.query<{ value: Partial<Settings> }>("SELECT value FROM settings WHERE key = 'main'");
  return { ...DEFAULT_SETTINGS, ...(rows[0]?.value ?? {}) };
}

export async function saveSettings(settings: Settings): Promise<void> {
  const db = await getDb();
  await db.query(
    `INSERT INTO settings (key, value) VALUES ('main', $1::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = $1::jsonb`,
    [JSON.stringify(settings)],
  );
}

/** Remove the sample cases and their orders. Cases that came from the real PayPal API are kept. */
export async function wipeSamples(): Promise<void> {
  const db = await getDb();
  await db.exec(`
    DELETE FROM audit_log WHERE dispute_id IN (SELECT id FROM disputes WHERE source = 'simulator');
    DELETE FROM disputes WHERE source = 'simulator';
    DELETE FROM orders WHERE capture_id LIKE 'CAP-%' OR capture_id LIKE 'SIMCAP-%';
    DELETE FROM sim_disputes;
  `);
}
