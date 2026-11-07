import type { Db, Tx } from '../db/pool.js';

export async function audit(
  q: Db | Tx,
  e: { actor: string; action: string; engagementId?: string | null; entity: string; entityId?: string | null; details?: unknown },
): Promise<void> {
  await q.query(
    `INSERT INTO audit_log(actor, action, engagement_id, entity, entity_id, details) VALUES ($1,$2,$3,$4,$5,$6)`,
    [e.actor, e.action, e.engagementId ?? null, e.entity, e.entityId ?? null, JSON.stringify(e.details ?? {})],
  );
}
