import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { HttpError } from '../app.js';
import { withTx } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { centsToNumeric, numericToCents } from '../lib/money.js';
import { readGrid, parseTrialBalance } from '../domain/trialBalance/parser.js';
import { classifyRows, validateTrialBalance } from '../domain/trialBalance/validate.js';
import { assertEngagement, IdParam } from './engagements.js';
import { readMultipart } from './multipart.js';

const Mapping = z.object({
  headerRowIndex: z.number().int().min(0),
  mapping: z.object({
    accountNumber: z.number().int().min(0),
    accountName: z.number().int().min(0),
    balanceCurrentYear: z.number().int().min(0),
    balancePreviousYear: z.number().int().min(0).optional(),
    balanceForeignCurrency: z.number().int().min(0).optional(),
  }),
});

const Options = z.object({
  signConvention: z.enum(['signed', 'unsigned']).default('signed'),
  toleranceCents: z.coerce.number().int().min(0).default(0),
  mapping: z
    .string()
    .optional()
    .transform(s => (s ? Mapping.parse(JSON.parse(s)) : undefined)),
  /** dryRun=true: nur Vorschau, nichts speichern */
  dryRun: z
    .enum(['true', 'false'])
    .optional()
    .transform(v => v === 'true'),
});

export const trialBalanceRoutes: FastifyPluginAsync = async app => {
  /** Saldobilanz hochladen, parsen, validieren, klassieren und speichern */
  app.post('/engagements/:id/trial-balances', async (req, reply) => {
    const { id: engagementId } = IdParam.parse(req.params);
    await assertEngagement(app, engagementId);
    const { files, fields } = await readMultipart(req);
    const file = files[0];
    if (!file) throw new HttpError(400, 'Keine Datei übermittelt (Feld "file").');
    const opts = Options.parse(fields);

    const grid = await readGrid(file.buffer, file.filename);
    const parsed = parseTrialBalance(grid, opts.mapping);
    const accounts = classifyRows(parsed.rows);
    const validation = validateTrialBalance(accounts, parsed.issues, opts.signConvention, opts.toleranceCents);
    if (accounts.length === 0) throw new HttpError(422, 'Keine Konten gefunden – Spaltenzuordnung prüfen.');

    const preview = {
      filename: file.filename,
      headerRowIndex: parsed.headerRowIndex,
      headers: parsed.headers,
      mapping: parsed.mapping,
      skippedRows: parsed.skippedRows,
      validation,
    };
    if (opts.dryRun) return { dryRun: true, ...preview, accounts: accounts.slice(0, 50) };

    const { key, sha256 } = await app.storage.put(file.buffer);
    const tbId = await withTx(app.db, async tx => {
      const { rows } = await tx.query(
        `INSERT INTO trial_balances(engagement_id, filename, file_sha256, storage_key, sign_convention, column_mapping, header_row_index, validation, is_valid, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [engagementId, file.filename, sha256, key, opts.signConvention, JSON.stringify(parsed.mapping), parsed.headerRowIndex, JSON.stringify(validation), validation.ok, req.actor],
      );
      const id: string = rows[0].id;
      // Bulk-Insert per unnest
      await tx.query(
        `INSERT INTO accounts(trial_balance_id, row_index, account_number, account_name, balance_cy, balance_py, balance_fx, group_code, group_name, category)
         SELECT $1, * FROM unnest($2::int[], $3::text[], $4::text[], $5::numeric[], $6::numeric[], $7::numeric[], $8::text[], $9::text[], $10::text[])`,
        [
          id,
          accounts.map(a => a.rowIndex),
          accounts.map(a => a.accountNumber),
          accounts.map(a => a.accountName),
          accounts.map(a => centsToNumeric(a.balanceCurrentYear)),
          accounts.map(a => centsToNumeric(a.balancePreviousYear)),
          accounts.map(a => centsToNumeric(a.balanceForeignCurrency)),
          accounts.map(a => a.groupCode),
          accounts.map(a => a.groupName),
          accounts.map(a => a.category),
        ],
      );
      await audit(tx, {
        actor: req.actor,
        action: 'trial_balance.import',
        engagementId,
        entity: 'trial_balance',
        entityId: id,
        details: { filename: file.filename, sha256, accounts: accounts.length, ok: validation.ok, signConvention: opts.signConvention },
      });
      return id;
    });
    return reply.status(201).send({ id: tbId, ...preview });
  });

  app.get('/trial-balances/:id', async req => {
    const { id } = IdParam.parse(req.params);
    const tb = await app.db.query(`SELECT * FROM trial_balances WHERE id=$1`, [id]);
    if (!tb.rows[0]) throw new HttpError(404, 'Saldobilanz nicht gefunden.');
    const acc = await app.db.query(`SELECT * FROM accounts WHERE trial_balance_id=$1 ORDER BY row_index`, [id]);
    return {
      ...tb.rows[0],
      accounts: acc.rows.map(r => ({
        id: r.id,
        rowIndex: r.row_index,
        accountNumber: r.account_number,
        accountName: r.account_name,
        balanceCurrentYear: numericToCents(r.balance_cy),
        balancePreviousYear: numericToCents(r.balance_py),
        balanceForeignCurrency: numericToCents(r.balance_fx),
        groupCode: r.group_code,
        groupName: r.group_name,
        category: r.category,
      })),
    };
  });
};
