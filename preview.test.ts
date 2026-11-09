import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { renderPreview, runAudit, type RunResult } from '../src/index.js';

const F = path.join(import.meta.dirname, 'fixtures', 'alpen');
const U = path.join(F, 'Kunde_Upload');

describe('Belegvorschau', () => {
  it.each([
    ['Bank/UBS/Kontoauszug.pdf', 2, 'image', 2],
    ['Bank/ZKB/Scan_20260112.pdf', 1, 'image', 1],
    ['Kasse/IMG_4471.jpg', 1, 'image', 1],
    ['Debitoren/OP_Debitoren_31.12.2025.xlsx', 1, 'table', 1],
    ['Anlagen/Anlagenspiegel.xlsx', 2, 'image', 2], // eingefügtes Bild als 2. "Seite"
    ['Inventar/Inventar_2025.xls', 1, 'table', 1],
    ['Kreditoren/Kreditoren_OP.docx', 1, 'text', 1],
    ['Diverses/Mail_Treuhaender.msg', 1, 'unsupported', 1],
  ])('%s', async (f, page, kind, pageCount) => {
    const p = await renderPreview(path.join(U, f), page);
    expect(p.kind).toBe(kind);
    expect(p.pageCount).toBe(pageCount);
    if (p.kind === 'image') expect(p.dataUrl).toMatch(/^data:image\/png;base64,/);
  });

  it('Seitenzahl ausserhalb wird begrenzt', async () => {
    expect((await renderPreview(path.join(U, 'Bank/UBS/Kontoauszug.pdf'), 99)).page).toBe(2);
  });
});

describe('Fundstellen für die Markierung', () => {
  let res: RunResult;
  beforeAll(async () => {
    res = await runAudit({ mandate: 'x', closingDate: '2025-12-31', trialBalancePath: path.join(F, 'Saldobilanz_2025.xlsx'), evidencePaths: [U], targetDir: null, fileMode: 'none' });
  });
  const best = (k: string) => res.match.results.find(r => r.accountNumber === k)!.best!;

  it.each([['1020', 'PDF mit Text'], ['1022', 'Scan-PDF'], ['1000', 'Foto'], ['1510', 'Bild in Excel']])('Konto %s (%s) hat gültige Position', k => {
    const b = best(k).bbox!;
    expect(b).toBeDefined();
    for (const v of Object.values(b)) expect(v).toBeGreaterThanOrEqual(0), expect(v).toBeLessThanOrEqual(1);
    expect(b.x1).toBeGreaterThan(b.x0);
    expect(b.y1).toBeGreaterThan(b.y0);
  });

  it('PDF: Position liegt auf Höhe der Schlusssaldo-Zeile (unterhalb der Buchungen)', () => {
    const lines = res.documents.find(d => d.doc.relPath === 'Bank/UBS/Kontoauszug.pdf')!.doc.lines.filter(l => l.page === 2);
    const sald = lines.find(l => /Schlusssaldo/.test(l.text))!.bbox!;
    const brunner = lines.find(l => /Brunner/.test(l.text))!.bbox!;
    expect(sald.y0).toBeGreaterThan(brunner.y1);
    expect(best('1020').bbox).toEqual(sald);
  });

  it('Excel: Zeilennummer der Fundstelle entspricht der Vorschau-Tabelle', async () => {
    const b = best('1100');
    const p = await renderPreview(path.join(U, 'Debitoren/OP_Debitoren_31.12.2025.xlsx'), b.page);
    expect(p.kind === 'table' && p.rows[b.lineNo - 1]!.join(' ')).toMatch(/Total.*87640\.20/);
  });

  it('Word: Zeilennummer entspricht der Textvorschau', async () => {
    const b = best('2000');
    const p = await renderPreview(path.join(U, 'Kreditoren/Kreditoren_OP.docx'), 1);
    expect(p.kind === 'text' && p.lines[b.lineNo - 1]).toMatch(/54'311\.90/);
  });
});
