import type { FastifyPluginAsync } from 'fastify';
import { HttpError } from '../app.js';
import { withTx } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { FileStorage } from '../lib/storage.js';
import { extractEvidenceText } from '../domain/evidence/extractText.js';
import { assertEngagement, IdParam } from './engagements.js';
import { readMultipart } from './multipart.js';

const ALLOWED = /\.(pdf|xlsx|xlsm|csv|txt|png|jpe?g|tiff?|webp)$/i;

export const evidenceRoutes: FastifyPluginAsync = async app => {
  /** Belege hochladen (mehrere Dateien), Text deterministisch extrahieren */
  app.post('/engagements/:id/evidence', async (req, reply) => {
    const { id: engagementId } = IdParam.parse(req.params);
    await assertEngagement(app, engagementId);
    const { files } = await readMultipart(req);
    if (!files.length) throw new HttpError(400, 'Keine Dateien übermittelt.');

    const results = [];
    for (const f of files) {
      if (!ALLOWED.test(f.filename)) {
        results.push({ filename: f.filename, status: 'rejected', reason: 'Dateityp nicht erlaubt.' });
        continue;
      }
      const sha256 = FileStorage.sha256(f.buffer);
      const dup = await app.db.query(`SELECT id FROM evidence_documents WHERE engagement_id=$1 AND file_sha256=$2`, [engagementId, sha256]);
      if (dup.rows[0]) {
        results.push({ filename: f.filename, status: 'duplicate', id: dup.rows[0].id });
        continue;
      }
      const ex = await extractEvidenceText(f.buffer, f.filename, f.mimetype);
      const { key } = await app.storage.put(f.buffer);
      const id = await withTx(app.db, async tx => {
        const { rows } = await tx.query(
          `INSERT INTO evidence_documents(engagement_id, filename, mime_type, size_bytes, file_sha256, storage_key, extraction_method, page_count, needs_ocr, warnings, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
          [engagementId, f.filename, f.mimetype, f.buffer.length, sha256, key, ex.method, ex.pageCount, ex.needsOcr, JSON.stringify(ex.warnings), req.actor],
        );
        const docId: string = rows[0].id;
        if (ex.lines.length) {
          await tx.query(
            `INSERT INTO evidence_lines(document_id, page, line_no, text) SELECT $1, * FROM unnest($2::int[], $3::int[], $4::text[])`,
            [docId, ex.lines.map(l => l.page), ex.lines.map(l => l.lineNo), ex.lines.map(l => l.text)],
          );
        }
        await audit(tx, { actor: req.actor, action: 'evidence.upload', engagementId, entity: 'evidence_document', entityId: docId, details: { filename: f.filename, sha256, method: ex.method, lines: ex.lines.length, needsOcr: ex.needsOcr } });
        return docId;
      });
      results.push({ filename: f.filename, status: 'stored', id, method: ex.method, lines: ex.lines.length, pageCount: ex.pageCount, needsOcr: ex.needsOcr, warnings: ex.warnings });
    }
    const stored = results.filter(r => r.status === 'stored').length;
    if (stored) await app.events.publish({ type: 'evidence.uploaded', engagementId, actor: req.actor, data: { count: stored } });
    return reply.status(201).send(results);
  });

  app.get('/engagements/:id/evidence', async req => {
    const { id } = IdParam.parse(req.params);
    const { rows } = await app.db.query(
      `SELECT d.id, d.filename, d.mime_type, d.size_bytes, d.extraction_method, d.page_count, d.needs_ocr, d.warnings, d.created_at,
              (SELECT count(*)::int FROM evidence_lines l WHERE l.document_id=d.id) AS line_count,
              d.sharepoint_url,
              (SELECT jsonb_build_object('provider', x.provider, 'verified', (x.verification->>'verifiedCount')::int, 'rejected', (x.verification->>'rejectedCount')::int, 'balanceDate', x.verification->>'balanceDate')
                 FROM ai_extractions x WHERE x.document_id=d.id AND x.is_current) AS ai
       FROM evidence_documents d WHERE engagement_id=$1 ORDER BY created_at`,
      [id],
    );
    return rows;
  });

  app.get('/evidence/:id/lines', async req => {
    const { id } = IdParam.parse(req.params);
    const { rows } = await app.db.query(`SELECT page, line_no AS "lineNo", text, source FROM evidence_lines WHERE document_id=$1 ORDER BY page, line_no`, [id]);
    return rows;
  });
};
