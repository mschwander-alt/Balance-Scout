import { z } from 'zod';
import { parseAmount, type Cents } from '../../domain/amount.js';
import type { EvidenceLine } from '../../domain/evidence/extractText.js';
import { normalizeForQuote, parseWith } from '../json.js';
import type { AiImage, AiRequest } from '../types.js';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable();

export const ExtractionSchema = z.object({
  documentType: z.enum(['kontoauszug', 'saldobestaetigung', 'debitorenliste', 'kreditorenliste', 'darlehensvertrag', 'steuerdokument', 'inventar', 'sonstiges']),
  issuer: z.string().nullable(),
  balanceDate: isoDate,
  accountReferences: z.array(z.object({ type: z.enum(['iban', 'kontonummer', 'kundennummer', 'sonstige']), value: z.string() })).default([]),
  balances: z
    .array(
      z.object({
        label: z.string(),
        amount: z.string(),
        currency: z.string().nullable(),
        date: isoDate,
        side: z.enum(['soll', 'haben', 'unbekannt']).default('unbekannt'),
        page: z.number().int().nullable(),
        quote: z.string(),
      }),
    )
    .default([]),
  /** Nur bei Bildern/Scans: Abschrift der Seiten */
  transcription: z.array(z.object({ page: z.number().int(), text: z.string() })).optional(),
  notes: z.string().nullable().default(null),
});
export type Extraction = z.infer<typeof ExtractionSchema>;

/** JSON-Schema für Anbieter mit nativer JSON-Ausgabe (Azure, Ollama) */
export const EXTRACTION_JSON_SCHEMA = {
  type: 'object',
  required: ['documentType', 'issuer', 'balanceDate', 'accountReferences', 'balances', 'notes'],
  properties: {
    documentType: { type: 'string', enum: ExtractionSchema.shape.documentType.options },
    issuer: { type: ['string', 'null'] },
    balanceDate: { type: ['string', 'null'], description: 'YYYY-MM-DD' },
    accountReferences: { type: 'array', items: { type: 'object', required: ['type', 'value'], properties: { type: { type: 'string', enum: ['iban', 'kontonummer', 'kundennummer', 'sonstige'] }, value: { type: 'string' } } } },
    balances: {
      type: 'array',
      items: {
        type: 'object',
        required: ['label', 'amount', 'currency', 'date', 'side', 'page', 'quote'],
        properties: {
          label: { type: 'string' },
          amount: { type: 'string' },
          currency: { type: ['string', 'null'] },
          date: { type: ['string', 'null'] },
          side: { type: 'string', enum: ['soll', 'haben', 'unbekannt'] },
          page: { type: ['integer', 'null'] },
          quote: { type: 'string' },
        },
      },
    },
    transcription: { type: 'array', items: { type: 'object', required: ['page', 'text'], properties: { page: { type: 'integer' }, text: { type: 'string' } } } },
    notes: { type: ['string', 'null'] },
  },
} as const;

const SYSTEM = `Du bist Assistent einer Schweizer Revisionsstelle und liest Prüfungsnachweise (Kontoauszüge, Saldobestätigungen, OP-Listen usw.).
Regeln:
- Erfinde nichts. Gib nur Werte an, die wörtlich im Dokument stehen.
- "quote" ist die exakte Textstelle (Zeile) aus dem Dokument, in der der Betrag steht – unverändert abgeschrieben.
- "amount" genau so, wie im Dokument geschrieben (z. B. "48'250.35" oder "-1 234,50").
- Erfasse nur Salden, Totale und Schlussbestände, keine Einzelbuchungen.
- "balanceDate" = Stichtag, auf den sich der Saldo bezieht (ISO-Format), sonst null.
- "side": "haben" bei Soll-/Minussaldo zulasten des Kunden (z. B. Kontoüberzug), "soll" bei Guthaben des Kunden; wenn unklar "unbekannt".
- Antworte ausschliesslich mit einem JSON-Objekt gemäss Schema, ohne weiteren Text.`;

const SCHEMA_HINT = `Schema: {"documentType": "kontoauszug|saldobestaetigung|debitorenliste|kreditorenliste|darlehensvertrag|steuerdokument|inventar|sonstiges", "issuer": string|null, "balanceDate": "YYYY-MM-DD"|null, "accountReferences": [{"type": "iban|kontonummer|kundennummer|sonstige", "value": string}], "balances": [{"label": string, "amount": string, "currency": string|null, "date": "YYYY-MM-DD"|null, "side": "soll|haben|unbekannt", "page": number|null, "quote": string}], "transcription": [{"page": number, "text": string}] (nur bei Bildern), "notes": string|null}`;

export function buildExtractionRequest(input: { filename: string; lines: EvidenceLine[]; images?: AiImage[]; sharePointUrl?: string }): AiRequest {
  const ocr = !!input.images?.length;
  const textBlock = input.lines.length ? formatLines(input.lines) : '';
  return {
    task: 'evidence_extraction',
    system: SYSTEM,
    user:
      `Dokument: ${input.filename}\n` +
      (ocr ? 'Das Dokument liegt als Bild vor. Schreibe zusätzlich jede Seite vollständig zeilenweise in "transcription" ab.\n' : 'Der Dokumenttext folgt zeilenweise mit Seitenangabe [S.x Z.y].\n') +
      SCHEMA_HINT,
    context: textBlock ? [textBlock] : undefined,
    images: input.images,
    sharePointFiles: input.sharePointUrl ? [input.sharePointUrl] : undefined,
    jsonSchema: EXTRACTION_JSON_SCHEMA as unknown as Record<string, unknown>,
    maxOutputTokens: ocr ? 8000 : 3000,
  };
}

function formatLines(lines: EvidenceLine[]): string {
  return lines.map(l => `[S.${l.page} Z.${l.lineNo}] ${l.text}`).join('\n');
}

export interface VerifiedBalance {
  label: string;
  raw: string;
  cents: Cents | null;
  currency: string | null;
  date: string | null;
  side: 'soll' | 'haben' | 'unbekannt';
  /** Fundstelle im Dokumenttext, falls Zitat gefunden */
  location: { page: number; lineNo: number } | null;
  status: 'verified' | 'quote_not_found' | 'amount_not_in_quote' | 'unparseable' | 'ocr_unconfirmed';
}

export interface ExtractionVerification {
  balances: VerifiedBalance[];
  verifiedCount: number;
  rejectedCount: number;
  balanceDate: string | null;
}

/**
 * Halluzinationsschutz: Ein KI-Betrag wird nur akzeptiert, wenn
 *  1. das Zitat im Dokumenttext vorkommt und
 *  2. der Betrag im Zitat steht.
 * Bei Scans (keine Textebene) gilt der Betrag als "ocr_unconfirmed" und muss vom Menschen bestätigt werden.
 */
export function verifyExtraction(ex: Extraction, lines: EvidenceLine[], ocr: boolean): ExtractionVerification {
  const normLines = lines.map(l => ({ ...l, norm: normalizeForQuote(l.text) }));
  const balances: VerifiedBalance[] = ex.balances.map(b => {
    const parsed = parseAmount(b.amount);
    const base = { label: b.label, raw: b.amount, cents: parsed?.cents ?? null, currency: b.currency, date: b.date, side: b.side };
    if (!parsed) return { ...base, location: null, status: 'unparseable' as const };
    const q = normalizeForQuote(b.quote);
    const amountNorm = normalizeForQuote(b.amount);
    if (!q.includes(amountNorm.replace(/^-/, '')) && !q.includes(amountNorm)) return { ...base, location: null, status: 'amount_not_in_quote' as const };
    if (ocr) return { ...base, location: null, status: 'ocr_unconfirmed' as const };
    const hit = normLines.find(l => l.norm.includes(q) || (q.length > 10 && q.includes(l.norm) && l.norm.includes(amountNorm.replace(/^-/, ''))));
    if (!hit) return { ...base, location: null, status: 'quote_not_found' as const };
    return { ...base, location: { page: hit.page, lineNo: hit.lineNo }, status: 'verified' as const };
  });
  return {
    balances,
    verifiedCount: balances.filter(b => b.status === 'verified').length,
    rejectedCount: balances.filter(b => b.status !== 'verified' && b.status !== 'ocr_unconfirmed').length,
    balanceDate: ex.balanceDate,
  };
}

export function parseExtraction(text: string): Extraction {
  return parseWith(ExtractionSchema, text);
}
