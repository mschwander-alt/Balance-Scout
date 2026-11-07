import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { HttpError } from '../app.js';
import { withTx } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import type { BsbEvent } from '../lib/events.js';
import { IdParam } from './engagements.js';

const LOCK_TTL_SECONDS = 120;

export const collaborationRoutes: FastifyPluginAsync = async app => {
  async function engagementOfAccount(accountId: string): Promise<string> {
    const r = await app.db.query(
      `SELECT t.engagement_id FROM accounts a JOIN trial_balances t ON t.id=a.trial_balance_id WHERE a.id=$1`,
      [accountId],
    );
    if (!r.rows[0]) throw new HttpError(404, 'Konto nicht gefunden.');
    return r.rows[0].engagement_id;
  }

  /** Sperre holen oder verlängern (Heartbeat). 409, wenn ein anderer Benutzer bearbeitet. */
  app.post('/accounts/:id/lock', async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const engagementId = await engagementOfAccount(id);
    const r = await app.db.query(
      `INSERT INTO account_locks(account_id, engagement_id, locked_by, locked_by_name, expires_at)
       VALUES ($1,$2,$3,$4, now() + make_interval(secs => $5))
       ON CONFLICT (account_id) DO UPDATE
         SET locked_by=EXCLUDED.locked_by, locked_by_name=EXCLUDED.locked_by_name, expires_at=EXCLUDED.expires_at,
             acquired_at = CASE WHEN account_locks.locked_by=EXCLUDED.locked_by THEN account_locks.acquired_at ELSE now() END
         WHERE account_locks.locked_by=EXCLUDED.locked_by OR account_locks.expires_at < now()
       RETURNING locked_by, locked_by_name, expires_at, (xmax = 0) AS fresh`,
      [id, engagementId, req.actor, req.displayName, LOCK_TTL_SECONDS],
    );
    if (!r.rows[0]) {
      const cur = await app.db.query(`SELECT locked_by, locked_by_name, expires_at FROM account_locks WHERE account_id=$1`, [id]);
      return reply.status(409).send({ error: `Wird bearbeitet von ${cur.rows[0]?.locked_by_name ?? 'anderem Benutzer'}.`, lock: cur.rows[0] });
    }
    if (r.rows[0].fresh) await app.events.publish({ type: 'lock.acquired', engagementId, actor: req.actor, data: { accountId: id, name: req.displayName } });
    return { accountId: id, lockedBy: r.rows[0].locked_by, lockedByName: r.rows[0].locked_by_name, expiresAt: r.rows[0].expires_at, ttlSeconds: LOCK_TTL_SECONDS };
  });

  app.delete('/accounts/:id/lock', async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const r = await app.db.query(`DELETE FROM account_locks WHERE account_id=$1 AND locked_by=$2 RETURNING engagement_id`, [id, req.actor]);
    if (r.rows[0]) await app.events.publish({ type: 'lock.released', engagementId: r.rows[0].engagement_id, actor: req.actor, data: { accountId: id } });
    return reply.status(204).send();
  });

  app.get('/engagements/:id/locks', async req => {
    const { id } = IdParam.parse(req.params);
    const { rows } = await app.db.query(
      `SELECT account_id AS "accountId", locked_by AS "lockedBy", locked_by_name AS "lockedByName", expires_at AS "expiresAt"
       FROM account_locks WHERE engagement_id=$1 AND expires_at > now()`,
      [id],
    );
    return rows;
  });

  /** Prüfvermerk speichern – nur mit eigener, gültiger Sperre; Versionskonflikte werden erkannt */
  app.put('/accounts/:id/review', async req => {
    const { id } = IdParam.parse(req.params);
    const b = z
      .object({
        decision: z.enum(['offen', 'bestaetigt', 'abweichung', 'nicht_anwendbar']),
        comment: z.string().max(10_000).default(''),
        runId: z.string().uuid().optional(),
        /** Version, auf der die Bearbeitung beruht (optimistische Sperre) */
        baseVersion: z.number().int().min(0),
      })
      .parse(req.body);
    const engagementId = await engagementOfAccount(id);
    const saved = await withTx(app.db, async tx => {
      const lock = await tx.query(`SELECT 1 FROM account_locks WHERE account_id=$1 AND locked_by=$2 AND expires_at > now()`, [id, req.actor]);
      if (!lock.rowCount) throw new HttpError(423, 'Konto ist nicht für Sie gesperrt – bitte zuerst Bearbeitung starten.');
      const cur = await tx.query(`SELECT coalesce(max(version),0) AS v FROM account_reviews WHERE account_id=$1`, [id]);
      const v = Number(cur.rows[0].v);
      if (v !== b.baseVersion) throw new HttpError(409, 'Der Prüfvermerk wurde inzwischen geändert. Bitte neu laden.');
      const { rows } = await tx.query(
        `INSERT INTO account_reviews(account_id, run_id, decision, comment, version, reviewed_by) VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING id, decision, comment, version, reviewed_by AS "reviewedBy", reviewed_at AS "reviewedAt"`,
        [id, b.runId ?? null, b.decision, b.comment, v + 1, req.actor],
      );
      await audit(tx, { actor: req.actor, action: 'account.review', engagementId, entity: 'account', entityId: id, details: { decision: b.decision, version: v + 1 } });
      return rows[0];
    });
    await app.events.publish({ type: 'review.updated', engagementId, actor: req.actor, data: { accountId: id, decision: b.decision, version: saved.version } });
    return saved;
  });

  app.get('/accounts/:id/reviews', async req => {
    const { id } = IdParam.parse(req.params);
    const { rows } = await app.db.query(
      `SELECT id, decision, comment, version, reviewed_by AS "reviewedBy", reviewed_at AS "reviewedAt" FROM account_reviews WHERE account_id=$1 ORDER BY version DESC`,
      [id],
    );
    return rows;
  });

  /** Live-Ereignisse eines Mandats (Server-Sent Events) – für Taskleisten-Meldungen und Live-Anzeige */
  app.get('/engagements/:id/events', async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write(': verbunden\n\n');
    const send = (e: BsbEvent) => {
      if (e.engagementId !== id) return;
      res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    };
    const unsubscribe = app.events.subscribe(send);
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.raw.on('close', () => {
      clearInterval(ping);
      unsubscribe();
    });
  });

  /** Beleg in SharePoint ablegen (im Namen des Benutzers), damit Copilot ihn lesen kann */
  app.post('/evidence/:id/sharepoint', async req => {
    const { id } = IdParam.parse(req.params);
    if (!app.sharePoint) throw new HttpError(503, 'SharePoint-Ablage ist nicht konfiguriert (SHAREPOINT_DRIVE_ID).');
    if (!req.userAssertion) throw new HttpError(401, 'Für die SharePoint-Ablage ist die Microsoft-Anmeldung nötig.');
    const d = await app.db.query(
      `SELECT d.filename, d.storage_key, d.engagement_id, e.name AS engagement_name, e.closing_date::text AS closing_date
       FROM evidence_documents d JOIN engagements e ON e.id=d.engagement_id WHERE d.id=$1`,
      [id],
    );
    const doc = d.rows[0];
    if (!doc) throw new HttpError(404, 'Beleg nicht gefunden.');
    const folder = [`${doc.engagement_name}${doc.closing_date ? ` ${doc.closing_date}` : ''}`, 'Belege'];
    const buf = await app.storage.get(doc.storage_key);
    const r = await app.sharePoint.upload(req.userAssertion, folder, doc.filename, buf);
    await app.db.query(`UPDATE evidence_documents SET sharepoint_url=$2, sharepoint_item_id=$3 WHERE id=$1`, [id, r.webUrl, r.itemId]);
    await audit(app.db, { actor: req.actor, action: 'evidence.sharepoint', engagementId: doc.engagement_id, entity: 'evidence_document', entityId: id, details: r });
    await app.events.publish({ type: 'sharepoint.uploaded', engagementId: doc.engagement_id, actor: req.actor, data: { documentId: id } });
    return r;
  });

  /** Wer bin ich? (für die Windows-App) */
  app.get('/me', async req => ({ actor: req.actor, name: req.displayName, isAdmin: req.isAdmin, microsoftLinked: !!req.userAssertion }));
};
