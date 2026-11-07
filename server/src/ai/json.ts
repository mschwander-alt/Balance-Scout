import { z } from 'zod';
import { AiError } from './types.js';

/**
 * Holt ein JSON-Objekt aus einer Modellantwort. Copilot liefert Markdown,
 * daher werden Code-Fences und umgebender Text toleriert.
 */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) throw new AiError('Antwort enthält kein JSON-Objekt.', 'INVALID_OUTPUT', 502);
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch (e) {
    throw new AiError(`Antwort enthält ungültiges JSON: ${(e as Error).message}`, 'INVALID_OUTPUT', 502);
  }
}

export function parseWith<T extends z.ZodTypeAny>(schema: T, text: string): z.infer<T> {
  const r = schema.safeParse(extractJson(text));
  if (!r.success) {
    throw new AiError(`Antwort entspricht nicht dem erwarteten Format: ${r.error.issues.slice(0, 3).map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`, 'INVALID_OUTPUT', 502);
  }
  return r.data;
}

/** Normalisiert Text für Zitatvergleich (Leerzeichen, Apostroph-Varianten, Minuszeichen) */
export function normalizeForQuote(s: string): string {
  return s
    .replace(/[’`´]/g, "'")
    .replace(/[−–—]/g, '-')
    .replace(/[\u00A0\u202F\u2009]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}
