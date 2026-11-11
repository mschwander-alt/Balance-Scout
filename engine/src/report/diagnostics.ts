import type { RunResult } from '../run.js';

/**
 * Diagnosebericht OHNE vertrauliche Inhalte: keine Namen, keine Beträge, keine Dateinamen.
 * Darf zur Fehlersuche weitergegeben werden.
 */
export function diagnosticReport(res: RunResult): string {
  const s = res.match.summary;
  const lines: string[] = [];
  lines.push('BALANCE SCOUT – DIAGNOSEBERICHT (anonym)');
  lines.push(`Version Regelwerk: ${s.engineVersion} · Dauer: ${Math.round((res.finishedAt.getTime() - res.startedAt.getTime()) / 1000)} s`);
  lines.push(`Saldobilanz: ${res.accounts.length} Konten · Kontrollen: ${res.validation.checks.map(c => (c.passed ? 'ok' : 'FEHLER')).join('/')} · Hinweise: ${res.validation.issues.length}`);
  lines.push(`Status: Belegt ${s.counts.BELEGT} · Prüfen ${s.counts.PRUEFEN} · Kein Nachweis ${s.counts.KEIN_NACHWEIS} · Nullsaldo ${s.counts.NULLSALDO} · Nicht im Umfang ${s.counts.NICHT_IM_UMFANG} · Abdeckung ${(s.coverage * 100).toFixed(1)} %`);
  const flags = new Map<string, number>();
  for (const r of res.match.results) for (const f of r.best?.flags ?? []) flags.set(f, (flags.get(f) ?? 0) + 1);
  lines.push(`Warnhinweise: ${[...flags].map(([k, v]) => `${k} ${v}`).join(' · ') || 'keine'}`);
  lines.push('');
  lines.push('Nr | Typ | Seiten | Lesart | OCR-Seiten | OCR-Sicherheit | Zeilen | Beträge | Stichtag erkannt | zugeordnet | Status');
  res.documents.forEach((d, i) => {
    lines.push(
      [
        i + 1, d.doc.ext || '-', d.doc.pageCount, d.doc.method, d.doc.ocrPages, d.doc.ocrConfidence ?? '-', d.doc.lines.length, d.amountCount,
        d.balanceDate ? (d.balanceDate === res.input.closingDate ? 'ja (=Stichtag)' : 'anderes Datum') : 'nein',
        d.assigned ? 'ja' : 'nein', d.doc.status,
      ].join(' | '),
    );
  });
  lines.push('');
  lines.push('Konten ohne Nachweis nach Kontenklasse: ' + summarizeMissing(res));
  const lf = res.ledger?.files ?? [];
  if (lf.length) {
    lines.push('');
    lines.push('Kontoblätter: Datei | Seiten/Blätter | Lesart | Konten | stimmig | Buchungen | Zeitraum');
    lf.forEach((f, i) => lines.push([`K${i + 1}`, f.pages, f.readStatus, f.accounts, f.consistent, f.postings, `${f.from ?? '?'} – ${f.to ?? '?'}`].join(' | ')));
    lf.forEach((f, i) => {
      if (!f.shape?.length) return;
      lines.push(`Aufbau K${i + 1} (keine Konten erkannt; Inhalte ersetzt: DATUM, BETRAG, NRn = Nummer mit n Ziffern, x = Wort):`);
      for (const s2 of f.shape) lines.push(`  ${s2}`);
    });
  }
  return lines.join('\n');
}

function summarizeMissing(res: RunResult): string {
  const by = new Map<string, number>();
  for (const r of res.match.results) if (r.status === 'KEIN_NACHWEIS') by.set(r.accountNumber.slice(0, 2) + 'xx', (by.get(r.accountNumber.slice(0, 2) + 'xx') ?? 0) + 1);
  return [...by].map(([k, v]) => `${k}: ${v}`).join(' · ') || 'keine';
}
