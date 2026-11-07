import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { HttpError } from '../app.js';
import { withTx } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { numericToCents } from '../lib/money.js';
import { AI_POLICIES } from '../ai/service.js';
import { AiError, type AiCallContext, type AiImage, type ProviderId } from '../ai/types.js';
import { buildExtractionRequest, parseExtraction, verifyExtraction } from '../ai/tasks/evidenceExtraction.js';
import { buildReviewRequest, parseReview } from '../ai/tasks/matchReview.js';
import { imageFromUpload, renderPdfPages } from '../domain/evidence/renderPages.js';
import { IdParam } from './engagements.js';

const ProviderEnum = z.enum(['m365-copilot', 'azure-foundry', 'ollama']);
const MAX_OCR_PAGES = 10;

function ctxOf(req: FastifyRequest): AiCallContext {
  return { actor: req.actor, userAssertion: req.userAssertion };
}

function requireAdmin(req: FastifyRequest): void {
  if (!req.isAdmin) throw new HttpError(403, 'Nur Administratoren dürfen diese Einstellung ändern.');
}

export const aiRoutes: FastifyPluginAsync = async app => {
  const ai = app.ai;

  /** Übersicht: konfigurierte Anbieter, Datengrenze, Fähigkeiten, Zuordnung */
  app.get('/ai/providers', async () => ({
    providers: [...ai.registry.values()].map(p => ({
      id: p.id,
      displayName: p.displayName,
      boundary: p.boundary,
      destination: p.destination,
      capabilities: p.capabilities,
    })),
    problems: app.aiProblems,
    routing: await ai.routing(),
    policies: AI_POLICIES,
  }));

  /** Verbindungstest (ohne Mandantendaten) */
  app.post('/ai/providers/:provider/test', async req => {
    const { provider } = z.object({ provider: ProviderEnum }).parse(req.params);
    const p = ai.registry.get(provider);
    if (!p) throw new HttpError(404, `${provider} ist nicht konfiguriert.`);
    return p.healthCheck(ctxOf(req));
  });

  /** Aufgabe → Anbieter (Admin) */
  app.put('/ai/routing', async req => {
    requireAdmin(req);
    const b = z.object({ task: z.enum(['evidence_extraction', 'match_review']), provider: ProviderEnum }).parse(req.body);
    await ai.setRouting(b.task, b.provider, req.actor);
    await audit(app.db, { actor: req.actor, action: 'ai.routing.update', entity: 'ai_settings', entityId: b.task, details: b });
    return ai.routing();
  });

  /** KI-Richtlinie eines Mandats (Admin) */
  app.put('/engagements/:id/ai-policy', async req => {
    requireAdmin(req);
    const { id } = IdParam.parse(req.params);
    const { aiPolicy } = z.object({ aiPolicy: z.enum(['disabled', 'local_only', 'tenant']) }).parse(req.body);
    const r = await app.db.query(`UPDATE engagements SET settings = settings || jsonb_build_object('aiPolicy', $2::text) WHERE id=$1 RETURNING id`, [id, aiPolicy]);
    if (!r.rowCount) throw new HttpError(404, 'Mandat nicht gefunden.');
    await audit(app.db, { actor: req.actor, action: 'engagement.ai_policy', engagementId: id, entity: 'engagement', entityId: id, details: { aiPolicy } });
    return { id, aiPolicy };
  });

  /** Vorschau: Wohin gingen die Daten? (für Bestätigungsdialog im Client) */
  app.get('/engagements/:id/ai-preview', async req => {
    const { id } = IdParam.parse(req.params);
    const q = z.object({ task: z.enum(['evidence_extraction', 'match_review']), provider: ProviderEnum.optional() }).parse(req.query);
    try {
      const { provider, policy } = await ai.resolve(q.task, id, q.provider);
      return { allowed: true, policy, provider: provider.id, displayName: provider.displayName, destination: provider.destination, boundary: provider.boundary, requiresUserLogin: provider.capabilities.requiresUserToken };
    } catch (e) {
      if (e instanceof AiError && e.code === 'POLICY_BLOCKED') return { allowed: false, reason: e.message };
      throw e;
    }
  });

  /** KI-Belegauswertung (inkl. OCR für Scans) */
  app.post('/evidence/:id/ai-extract', async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const body = z.object({ provider: ProviderEnum.optional() }).default({}).parse(req.body ?? {});
    const d = await app.db.query(`SELECT id, engagement_id, filename, storage_key, needs_ocr, sharepoint_url FROM evidence_documents WHERE id=$1`, [id]);
    const doc = d.rows[0];
    if (!doc) throw new HttpError(404, 'Beleg nicht gefunden.');
    const { provider } = await ai.resolve('evidence_extraction', doc.engagement_id, body.provider as ProviderId | undefined);

    const lr = await app.db.query(`SELECT page, line_no AS "lineNo", text FROM evidence_lines WHERE document_id=$1 AND source='text-layer' ORDER BY page, line_no`, [id]);
    const lines = lr.rows as { page: number; lineNo: number; text: string }[];
    let images: AiImage[] | undefined;
    const ocr = doc.needs_ocr || lines.length === 0;
    if (ocr) {
      if (provider.capabilities.sharePointFiles && doc.sharepoint_url) {
        images = undefined; // Copilot liest die Datei direkt aus SharePoint
      } else {
        const buf = await app.storage.get(doc.storage_key);
        const single = imageFromUpload(buf, doc.filename);
        images = single ? [single] : await renderPdfPages(buf, MAX_OCR_PAGES);
      }
    }

    const request = buildExtractionRequest({ filename: doc.filename, lines, images, sharePointUrl: doc.sharepoint_url ?? undefined });
    const res = await ai.call(provider, request, ctxOf(req), { engagementId: doc.engagement_id, documentId: id });
    if (res.refused) throw new AiError(`${provider.displayName} hat die Auswertung abgelehnt.`, 'REFUSED', 422);
    const extraction = parseExtraction(res.text);

    // Bei OCR: Abschrift als eigene Zeilenquelle speichern und dagegen verifizieren
    const ocrSource = `ocr:${provider.id}`;
    const ocrLines = ocr
      ? (extraction.transcription ?? []).flatMap(t => t.text.split(/\r?\n/).map(s => s.trim()).filter(Boolean).map((text, i) => ({ page: t.page, lineNo: i + 1, text })))
      : [];
    const verification = verifyExtraction(extraction, ocr ? ocrLines : lines, ocr);
    if (ocr) {
      // Betrag muss zumindest in der eigenen Abschrift stehen, sonst verworfen
      for (const b of verification.balances) {
        if (b.status === 'ocr_unconfirmed') {
          const amt = b.raw.replace(/^-/, '');
          const hit = ocrLines.find(l => l.text.includes(amt));
          if (!hit) b.status = 'quote_not_found';
          else b.location = { page: hit.page, lineNo: hit.lineNo };
        }
      }
    }

    const extractionId = await withTx(app.db, async tx => {
      await tx.query(`UPDATE ai_extractions SET is_current=false WHERE document_id=$1 AND is_current`, [id]);
      const { rows } = await tx.query(
        `INSERT INTO ai_extractions(document_id, provider, model, result, verification, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [id, provider.id, res.model, JSON.stringify(extraction), JSON.stringify(verification), req.actor],
      );
      if (ocr) {
        await tx.query(`DELETE FROM evidence_lines WHERE document_id=$1 AND source=$2`, [id, ocrSource]);
        if (ocrLines.length) {
          await tx.query(
            `INSERT INTO evidence_lines(document_id, page, line_no, text, source) SELECT $1, p, l, t, $5 FROM unnest($2::int[], $3::int[], $4::text[]) AS x(p, l, t) ON CONFLICT DO NOTHING`,
            [id, ocrLines.map(l => l.page), ocrLines.map(l => l.lineNo), ocrLines.map(l => l.text), ocrSource],
          );
        }
      }
      await audit(tx, {
        actor: req.actor, action: 'ai.extract', engagementId: doc.engagement_id, entity: 'evidence_document', entityId: id,
        details: { provider: provider.id, model: res.model, ocr, balances: verification.balances.length, verified: verification.verifiedCount, rejected: verification.rejectedCount },
      });
      return rows[0].id as string;
    });

    await app.events.publish({ type: 'ai.extract.completed', engagementId: doc.engagement_id, actor: req.actor, data: { documentId: id, filename: doc.filename } });
    return reply.status(201).send({ id: extractionId, provider: provider.id, model: res.model, ocr, extraction, verification, citations: res.citations ?? [] });
  });

  app.get('/evidence/:id/ai-extraction', async req => {
    const { id } = IdParam.parse(req.params);
    const { rows } = await app.db.query(`SELECT * FROM ai_extractions WHERE document_id=$1 AND is_current`, [id]);
    if (!rows[0]) throw new HttpError(404, 'Keine KI-Auswertung vorhanden.');
    return rows[0];
  });

  /** KI-Einschätzung zu einem Matching-Ergebnis (Hinweis für den Prüfer) */
  app.post('/match-runs/:runId/accounts/:accountId/ai-review', async (req, reply) => {
    const { runId, accountId } = z.object({ runId: z.string().uuid(), accountId: z.string().uuid() }).parse(req.params);
    const body = z.object({ provider: ProviderEnum.optional() }).default({}).parse(req.body ?? {});
    const r = await app.db.query(
      `SELECT mr.best, mr.reasons, a.account_number, a.account_name, a.balance_cy, e.id AS engagement_id, e.closing_date::text AS closing_date, e.currency
       FROM match_results mr JOIN accounts a ON a.id=mr.account_id JOIN match_runs m ON m.id=mr.run_id
       JOIN trial_balances t ON t.id=m.trial_balance_id JOIN engagements e ON e.id=t.engagement_id
       WHERE mr.run_id=$1 AND mr.account_id=$2`,
      [runId, accountId],
    );
    const row = r.rows[0];
    if (!row) throw new HttpError(404, 'Ergebnis nicht gefunden.');
    if (!row.best) throw new HttpError(422, 'Für dieses Konto gibt es keine Fundstelle zum Beurteilen.');
    const { provider } = await ai.resolve('match_review', row.engagement_id, body.provider as ProviderId | undefined);
    const best = row.best as { documentId: string; filename: string; page: number; lineNo: number; flags: string[] };
    const sur = await app.db.query(
      `SELECT page, line_no AS "lineNo", text FROM evidence_lines WHERE document_id=$1 AND page=$2 AND line_no BETWEEN $3 AND $4 ORDER BY source DESC, line_no`,
      [best.documentId, best.page, best.lineNo - 5, best.lineNo + 5],
    );
    const request = buildReviewRequest({
      accountNumber: row.account_number, accountName: row.account_name, balance: numericToCents(row.balance_cy) ?? 0,
      closingDate: row.closing_date, currency: row.currency, filename: best.filename, page: best.page, lineNo: best.lineNo,
      surrounding: sur.rows, engineReasons: row.reasons, flags: best.flags,
    });
    const res = await ai.call(provider, request, ctxOf(req), { engagementId: row.engagement_id, documentId: best.documentId });
    if (res.refused) throw new AiError(`${provider.displayName} hat die Beurteilung abgelehnt.`, 'REFUSED', 422);
    const review = parseReview(res.text);
    const { rows } = await app.db.query(
      `INSERT INTO ai_reviews(run_id, account_id, provider, model, result, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, created_at`,
      [runId, accountId, provider.id, res.model, JSON.stringify(review), req.actor],
    );
    await audit(app.db, { actor: req.actor, action: 'ai.review', engagementId: row.engagement_id, entity: 'match_result', entityId: `${runId}/${accountId}`, details: { provider: provider.id, assessment: review.assessment } });
    return reply.status(201).send({ id: rows[0].id, provider: provider.id, model: res.model, review, notice: 'KI-Einschätzung – kein Prüfentscheid. Bitte durch den Prüfer würdigen.' });
  });

  /** KI-Nutzungsprotokoll eines Mandats */
  app.get('/engagements/:id/ai-calls', async req => {
    const { id } = IdParam.parse(req.params);
    const { rows } = await app.db.query(`SELECT * FROM ai_calls WHERE engagement_id=$1 ORDER BY id`, [id]);
    return rows;
  });
};
