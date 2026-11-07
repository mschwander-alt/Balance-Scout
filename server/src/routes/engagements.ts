import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { audit } from '../lib/audit.js';
import { HttpError } from '../app.js';

export const CreateEngagement = z.object({
  name: z.string().trim().min(1).max(200),
  clientName: z.string().trim().max(200).optional(),
  closingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  currency: z.string().length(3).toUpperCase().default('CHF'),
});

export const IdParam = z.object({ id: z.string().uuid() });

export const engagementRoutes: FastifyPluginAsync = async app => {
  app.post('/engagements', async (req, reply) => {
    const b = CreateEngagement.parse(req.body);
    const { rows } = await app.db.query(
      `INSERT INTO engagements(name, client_name, closing_date, currency, created_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING id, name, client_name, closing_date, currency, created_at`,
      [b.name, b.clientName ?? null, b.closingDate ?? null, b.currency, req.actor],
    );
    const e = rows[0];
    await audit(app.db, { actor: req.actor, action: 'engagement.create', engagementId: e.id, entity: 'engagement', entityId: e.id, details: b });
    return reply.status(201).send(e);
  });

  app.get('/engagements', async () => {
    const { rows } = await app.db.query(`SELECT id, name, client_name, closing_date, currency, created_at FROM engagements ORDER BY created_at DESC`);
    return rows;
  });

  app.get('/engagements/:id', async req => {
    const { id } = IdParam.parse(req.params);
    const { rows } = await app.db.query(`SELECT * FROM engagements WHERE id=$1`, [id]);
    if (!rows[0]) throw new HttpError(404, 'Mandat nicht gefunden.');
    const tbs = await app.db.query(
      `SELECT id, filename, sign_convention, is_valid, created_at, created_by FROM trial_balances WHERE engagement_id=$1 ORDER BY created_at DESC`,
      [id],
    );
    return { ...rows[0], trialBalances: tbs.rows };
  });

  app.get('/engagements/:id/audit-log', async req => {
    const { id } = IdParam.parse(req.params);
    const { rows } = await app.db.query(
      `SELECT id, at, actor, action, entity, entity_id, details FROM audit_log WHERE engagement_id=$1 ORDER BY id`,
      [id],
    );
    return rows;
  });
};

export async function assertEngagement(app: { db: import('../db/pool.js').Db }, id: string): Promise<void> {
  const { rowCount } = await app.db.query('SELECT 1 FROM engagements WHERE id=$1', [id]);
  if (!rowCount) throw new HttpError(404, 'Mandat nicht gefunden.');
}
