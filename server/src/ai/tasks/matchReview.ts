import { z } from 'zod';
import { formatChf, type Cents } from '../../domain/amount.js';
import { parseWith } from '../json.js';
import type { AiRequest } from '../types.js';

export const ReviewSchema = z.object({
  assessment: z.enum(['stuetzt', 'stuetzt_nicht', 'unklar']),
  reasoning: z.string().min(1),
  issues: z.array(z.enum(['stichtag', 'vorzeichen', 'waehrung', 'falsches_konto', 'teilbetrag', 'zwischentotal', 'sonstiges'])).default([]),
  suggestedComment: z.string().nullable().default(null),
});
export type Review = z.infer<typeof ReviewSchema>;

const JSON_SCHEMA = {
  type: 'object',
  required: ['assessment', 'reasoning', 'issues', 'suggestedComment'],
  properties: {
    assessment: { type: 'string', enum: ['stuetzt', 'stuetzt_nicht', 'unklar'] },
    reasoning: { type: 'string' },
    issues: { type: 'array', items: { type: 'string', enum: ['stichtag', 'vorzeichen', 'waehrung', 'falsches_konto', 'teilbetrag', 'zwischentotal', 'sonstiges'] } },
    suggestedComment: { type: ['string', 'null'] },
  },
};

const SYSTEM = `Du unterstützt eine Schweizer Revisionsstelle bei der Saldenprüfung (Prüfungsstandard PS-CH).
Beurteile, ob die angegebene Belegstelle den Buchsaldo des Kontos nachweist.
Achte auf: Stichtag = Bilanzstichtag, richtiges Konto/Institut, Vorzeichen (Guthaben vs. Überzug), Währung, ob es ein Schlusssaldo und kein Zwischentotal oder Teilbetrag ist.
Du triffst keinen Prüfentscheid; deine Einschätzung ist ein Hinweis an den Prüfer.
Antworte ausschliesslich mit JSON: {"assessment": "stuetzt|stuetzt_nicht|unklar", "reasoning": string (max. 3 Sätze, Deutsch), "issues": ["stichtag"|"vorzeichen"|"waehrung"|"falsches_konto"|"teilbetrag"|"zwischentotal"|"sonstiges"], "suggestedComment": string|null (Formulierung für das Arbeitspapier)}`;

export interface ReviewInput {
  accountNumber: string;
  accountName: string;
  balance: Cents;
  closingDate: string | null;
  currency: string;
  filename: string;
  page: number;
  lineNo: number;
  /** Zeilen um die Fundstelle (±5) */
  surrounding: { page: number; lineNo: number; text: string }[];
  engineReasons: string[];
  flags: string[];
}

export function buildReviewRequest(i: ReviewInput): AiRequest {
  const ctx = i.surrounding.map(l => `${l.page === i.page && l.lineNo === i.lineNo ? '>>' : '  '} [S.${l.page} Z.${l.lineNo}] ${l.text}`).join('\n');
  return {
    task: 'match_review',
    system: SYSTEM,
    user:
      `Konto ${i.accountNumber} "${i.accountName}", Buchsaldo ${formatChf(i.balance)} ${i.currency}, Bilanzstichtag ${i.closingDate ?? 'unbekannt'}.\n` +
      `Fundstelle: ${i.filename}, Seite ${i.page}, Zeile ${i.lineNo} (mit >> markiert).\n` +
      `Hinweise der Regel-Engine: ${[...i.engineReasons, ...i.flags].join('; ') || 'keine'}`,
    context: [ctx],
    jsonSchema: JSON_SCHEMA,
    maxOutputTokens: 800,
  };
}

export function parseReview(text: string): Review {
  return parseWith(ReviewSchema, text);
}
