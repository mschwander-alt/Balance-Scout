import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { HttpError } from '../app.js';
import { withTx } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { numericToCents } from '../lib/money.js';
import { extractAmounts, type AmountCandidate } from '../domain/matching/extractAmounts.js';
import { runMatching, type DocumentInsight, type MatchAccount } from '../domain/matching/engine.js';
import type { Category } from '../domain/trialBalance/accountGroups.js';
import { IdParam } from './engagements.js';

const RunBody = z
  .object({
    absoluteToleranceCents: z.number().int().min(0).max(10_000_00).optional(),
    relativeTolerance: z.number().min(0).max(0.1).optional(),
    confirmScore: z.number().int().min(0).max(100).optional(),
    scope: z.enum(['balance_sheet', 'all']).optional(),
    documentIds: z.array(z.string().uuid()).optional(),
    assignments: z.record(z.string().uuid(), z.array(z.string().uuid())).optional(),
  })
  .default({});

export const matchingRoutes: FastifyPluginAsync = async app => {
  /** Matching-Lauf starten (deterministisch, reproduzierbar, protokolliert) */
  app.post('/trial-balances/:id/match-runs', async (req, reply) => {
    const { id: tbId } = IdParam.parse(req.params);
    const body = RunBody.parse(req.body ?? {});
    const tb = await app.db.query(
      `SELECT t.id, t.engagement_id, t.sign_convention, e.closing_date::text AS closing_date
       FROM trial_balances t JOIN engagements e ON e.id=t.engagement_id WHERE t.id=$1`,
      [tbId],
    );
    const tbRow = tb.rows[0];
    if (!tbRow) throw new HttpError(404, 'Saldobilanz nicht gefunden.');

    const accRows = await app.db.query(`SELECT id, account_number, account_name, balance_cy, category FROM accounts WHERE trial_balance_id=$1 ORDER BY row_index`, [tbId]);
    const accounts: MatchAccount[] = accRows.rows.map(r => ({
      id: r.id,
      accountNumber: r.account_number,
      accountName: r.account_name,
      balance: numericToCents(r.balance_cy) ?? 0,
      category: r.category as Category,
    }));

    const docRows = await app.db.query(
      `SELECT id, filename FROM evidence_documents WHERE engagement_id=$1 ${body.documentIds ? 'AND id = ANY($2)' : ''} ORDER BY created_at`,
      body.documentIds ? [tbRow.engagement_id, body.documentIds] : [tbRow.engagement_id],
    );
    const docIds = docRows.rows.map(r => r.id as string);

    // Verifizierte KI-Auswertungen (falls vorhanden) – fliessen deterministisch ins Scoring ein
    const ins = await app.db.query(`SELECT id, document_id, verification FROM ai_extractions WHERE document_id = ANY($1) AND is_current`, [docIds]);
    const insightByDoc = new Map<string, DocumentInsight>();
    const extractionIds: string[] = [];
    for (const r of ins.rows) {
      extractionIds.push(r.id);
      const v = r.verification as { balanceDate: string | null; balances: { status: string; cents: number | null; location: { page: number; lineNo: number } | null }[] };
      insightByDoc.set(r.document_id, {
        balanceDate: v.balanceDate,
        verifiedBalances: v.balances
          .filter(b => b.status === 'verified' && b.cents !== null && b.location)
          .map(b => ({ page: b.location!.page, lineNo: b.location!.lineNo, cents: b.cents! })),
      });
    }
    const documents = docRows.rows.map(r => ({ id: r.id as string, filename: r.filename as string, insight: insightByDoc.get(r.id) }));

    const lineRows = await app.db.query(
      `SELECT document_id, page, line_no, text, source FROM evidence_lines WHERE document_id = ANY($1) ORDER BY document_id, source, page, line_no`,
      [docIds],
    );
    const linesByDoc = new Map<string, { page: number; lineNo: number; text: string; source: string }[]>();
    for (const r of lineRows.rows) {
      const arr = linesByDoc.get(r.document_id) ?? [];
      arr.push({ page: r.page, lineNo: r.line_no, text: r.text, source: r.source });
      linesByDoc.set(r.document_id, arr);
    }
    const amounts: AmountCandidate[] = [];
    for (const [docId, lines] of linesByDoc) amounts.push(...extractAmounts(docId, lines));

    const out = runMatching(accounts, documents, amounts, {
      absoluteToleranceCents: body.absoluteToleranceCents,
      relativeTolerance: body.relativeTolerance,
      confirmScore: body.confirmScore,
      scope: body.scope,
      assignments: body.assignments,
      signConvention: tbRow.sign_convention,
      closingDate: tbRow.closing_date,
    });

    const runId = await withTx(app.db, async tx => {
      const { rows } = await tx.query(
        `INSERT INTO match_runs(trial_balance_id, engine_version, params, summary, document_ids, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [tbId, out.summary.engineVersion, JSON.stringify({ ...out.summary.params, aiExtractionIds: extractionIds }), JSON.stringify(out.summary), docIds, req.actor],
      );
      const id: string = rows[0].id;
      await tx.query(
        `INSERT INTO match_results(run_id, account_id, status, best, candidates, reasons)
         SELECT $1, * FROM unnest($2::uuid[], $3::text[], $4::jsonb[], $5::jsonb[], $6::jsonb[])`,
        [
          id,
          out.results.map(r => r.accountId),
          out.results.map(r => r.status),
          out.results.map(r => (r.best ? JSON.stringify(r.best) : null)),
          out.results.map(r => JSON.stringify(r.candidates)),
          out.results.map(r => JSON.stringify(r.reasons)),
        ],
      );
      await audit(tx, { actor: req.actor, action: 'matching.run', engagementId: tbRow.engagement_id, entity: 'match_run', entityId: id, details: { counts: out.summary.counts, coverage: out.summary.coverage, documents: docIds.length } });
      return id;
    });
    await app.events.publish({ type: 'match.completed', engagementId: tbRow.engagement_id, actor: req.actor, data: { runId, trialBalanceId: tbId, counts: out.summary.counts } });
    return reply.status(201).send({ id: runId, ...out });
  });

  app.get('/trial-balances/:id/match-runs', async req => {
    const { id } = IdParam.parse(req.params);
    const { rows } = await app.db.query(
      `SELECT id, engine_version, summary, created_at, created_by FROM match_runs WHERE trial_balance_id=$1 ORDER BY created_at DESC`,
      [id],
    );
    return rows;
  });

  /** Aktueller Prüfvermerk je Konto der Saldobilanz */
  app.get('/trial-balances/:id/reviews', async req => {
    const { id } = IdParam.parse(req.params);
    const { rows } = await app.db.query(
      `SELECT DISTINCT ON (r.account_id) r.account_id AS "accountId", r.decision, r.comment, r.version, r.reviewed_by AS "reviewedBy", r.reviewed_at AS "reviewedAt"
       FROM account_reviews r JOIN accounts a ON a.id=r.account_id WHERE a.trial_balance_id=$1
       ORDER BY r.account_id, r.version DESC`,
      [id],
    );
    return rows;
  });

  app.get('/match-runs/:id', async req => {
    const { id } = IdParam.parse(req.params);
    const run = await app.db.query(`SELECT * FROM match_runs WHERE id=$1`, [id]);
    if (!run.rows[0]) throw new HttpError(404, 'Matching-Lauf nicht gefunden.');
    const res = await app.db.query(
      `SELECT a.account_number AS "accountNumber", a.account_name AS "accountName", a.balance_cy AS balance, r.status, r.best, r.candidates, r.reasons, r.account_id AS "accountId"
       FROM match_results r JOIN accounts a ON a.id=r.account_id WHERE r.run_id=$1 ORDER BY a.row_index`,
      [id],
    );
    return { ...run.rows[0], results: res.rows.map(r => ({ ...r, balance: numericToCents(r.balance) })) };
  });
};
