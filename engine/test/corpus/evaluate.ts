/** Vergleicht das Ergebnis der Engine mit der Soll-Lösung (truth.json) des Testsatzes. */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { runAudit, type RunResult } from '../../src/index.js';

export interface Evaluation {
  rows: { konto: string; erwartetDatei: string | null; gefundenDatei: string | null; erwartet: string; status: string; dateiOk: boolean; statusOk: boolean; hinweis: string }[];
  dateiTrefferquote: number;
  statusQuote: number;
  falschBelegt: number;
}

const LABEL: Record<string, string> = { BELEGT: 'Belegt', PRUEFEN: 'Prüfen', KEIN_NACHWEIS: 'Kein Nachweis', NULLSALDO: 'Nullsaldo', NICHT_IM_UMFANG: 'Nicht im Umfang' };

export async function evaluate(corpus: string, res?: RunResult): Promise<Evaluation> {
  const t = JSON.parse(await readFile(path.join(corpus, 'truth.json'), 'utf8')) as { truth: Record<string, { file: string | null; expect: string }> };
  res ??= await runAudit({ mandate: 'Alpenblick Treuhand AG', closingDate: '2025-12-31', trialBalancePath: path.join(corpus, 'Saldobilanz_2025.xlsx'), evidencePaths: [path.join(corpus, 'Kunde_Upload')], targetDir: null, fileMode: 'none' });
  const relOf = new Map(res.documents.map(d => [d.doc.id, d.doc.relPath]));
  const rows = Object.entries(t.truth).map(([konto, exp]) => {
    const r = res!.match.results.find(x => x.accountNumber === konto)!;
    const found = r.best ? relOf.get(r.best.documentId) ?? null : null;
    const status = LABEL[r.status]!;
    const foundForStatus = r.status === 'BELEGT' || r.status === 'PRUEFEN' ? found : null;
    return {
      konto, erwartetDatei: exp.file, gefundenDatei: foundForStatus, erwartet: exp.expect, status,
      dateiOk: foundForStatus === exp.file,
      statusOk: status === exp.expect,
      hinweis: [...(r.best?.flags ?? []), ...(r.status !== 'BELEGT' ? r.reasons : [])].join('; ').slice(0, 140),
    };
  });
  const withFile = rows.filter(r => r.erwartetDatei);
  return {
    rows,
    dateiTrefferquote: withFile.filter(r => r.dateiOk).length / withFile.length,
    statusQuote: rows.filter(r => r.statusOk).length / rows.length,
    // gefährlichster Fehler: "Belegt", obwohl Soll nicht "Belegt" oder falsche Datei
    falschBelegt: rows.filter(r => r.status === 'Belegt' && (r.erwartet !== 'Belegt' || !r.dateiOk)).length,
  };
}

if (process.argv[1]?.endsWith('evaluate.ts')) {
  const e = await evaluate(process.argv[2]!);
  console.table(e.rows.map(r => ({ Konto: r.konto, Soll: r.erwartet, Ist: r.status, Datei: r.dateiOk ? '✓' : r.erwartetDatei ? `✗ ${r.gefundenDatei ?? '–'}` : (r.gefundenDatei ?? '–'), Status: r.statusOk ? '✓' : '✗', Hinweis: r.hinweis })));
  console.log(`Fundstelle richtig: ${(e.dateiTrefferquote * 100).toFixed(0)} % · Status wie Soll: ${(e.statusQuote * 100).toFixed(0)} % · fälschlich "Belegt": ${e.falschBelegt}`);
}
