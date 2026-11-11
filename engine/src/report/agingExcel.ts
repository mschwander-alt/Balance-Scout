import ExcelJS from 'exceljs';
import { BUCKETS, type Aging } from '../analysis/receivables.js';

const BLUE = 'FF0F5EA8';
const CHF = '#,##0.00;[Red]-#,##0.00';
const PCT = '0.0%';
const DATE = 'dd.mm.yyyy';
const d = (iso: string | null) => (iso ? new Date(`${iso}T00:00:00Z`) : null);

export interface AgingMeta {
  mandate: string;
  closingDate: string;
  sourceFile: string;
  /** Saldo Forderungen L+L laut Saldobilanz (CHF, Rappen) */
  balanceChf: number | null;
  balanceAccounts?: string;
  findings: { text: string; status: string }[];
  visum?: string;
  /** Notiz der Prüferin / des Prüfers zum Prüfgebiet */
  note?: string;
}

function head(ws: ExcelJS.Worksheet, row: number, cols: string[]) {
  cols.forEach((c, i) => {
    const cell = ws.getCell(row, i + 1);
    cell.value = c;
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BLUE } };
    cell.alignment = { wrapText: true, vertical: 'middle' };
  });
  ws.getRow(row).height = 30;
}

/** Fälligkeitsanalyse als Excel (Übersicht, Altersstruktur, Kunden, Einzelposten). */
export async function agingWorkbook(a: Aging, m: AgingMeta): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Balance Scout';
  wb.created = new Date();
  const ps = { orientation: 'landscape' as const, paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0 };

  // ---------------- Übersicht ----------------
  const ov = wb.addWorksheet('Übersicht', { pageSetup: ps });
  ov.columns = [{ width: 46 }, { width: 22 }, { width: 60 }];
  ov.getCell('A1').value = 'Forderungen aus Lieferungen und Leistungen – Analyse Fälligkeit';
  ov.getCell('A1').font = { bold: true, size: 15, color: { argb: BLUE } };
  ov.getCell('A2').value = 'Erstellt mit Balance Scout auf Basis der Offenposten-Liste des Kunden';
  ov.getCell('A2').font = { italic: true, color: { argb: 'FF6B7385' } };
  const rates = Object.entries(a.params.rates).map(([k, v]) => `${k} ${v}`).join(', ') || '–';
  const meta: [string, ExcelJS.CellValue, string?][] = [
    ['Mandat', m.mandate], ['Bilanzstichtag', d(m.closingDate), DATE], ['Quelle (OP-Liste)', m.sourceFile],
    ['Zahlungsfrist (falls keine Fälligkeit in der Liste)', `${a.params.termDays} Tage ab Belegdatum`],
    ['Fremdwährungskurse per Stichtag (CHF)', rates], ['Erstellt am', new Date(), 'dd.mm.yyyy hh:mm'], ['Visum', m.visum ?? ''],
  ];
  let r = 4;
  for (const [k, v, f] of meta) {
    ov.getCell(`A${r}`).value = k;
    ov.getCell(`A${r}`).font = { bold: true };
    ov.getCell(`B${r}`).value = v;
    if (f) ov.getCell(`B${r}`).numFmt = f;
    r++;
  }
  r++;
  const sec = (t: string) => { ov.getCell(`A${r}`).value = t; ov.getCell(`A${r}`).font = { bold: true, size: 12, color: { argb: BLUE } }; r++; };
  sec('Abstimmung OP-Liste – Saldobilanz');
  const opRow = r;
  ov.getCell(`A${r}`).value = 'Total OP-Liste (CHF)'; ov.getCell(`B${r}`).value = a.totalChf / 100; ov.getCell(`B${r}`).numFmt = CHF; r++;
  const balRow = r;
  ov.getCell(`A${r}`).value = `Saldo Forderungen L+L laut Saldobilanz${m.balanceAccounts ? ` (${m.balanceAccounts})` : ''}`;
  ov.getCell(`B${r}`).value = m.balanceChf === null ? null : m.balanceChf / 100; ov.getCell(`B${r}`).numFmt = CHF; r++;
  ov.getCell(`A${r}`).value = 'Differenz';
  ov.getCell(`B${r}`).value = { formula: `IF(B${balRow}="","",ROUND(B${opRow}-B${balRow},2))`, result: m.balanceChf === null ? '' : (a.totalChf - m.balanceChf) / 100 };
  ov.getCell(`B${r}`).numFmt = CHF; ov.getCell(`B${r}`).font = { bold: true };
  r += 2;
  sec('Kennzahlen');
  const kpi: [string, number | string, string?][] = [
    ['Offene Rechnungen brutto (CHF)', a.grossChf / 100, CHF],
    ['Gutschriften / Vorauszahlungen (CHF)', a.credits / 100, CHF],
    ['Über 90 Tage überfällig (CHF)', a.kpis.overdue90 / 100, CHF],
    ['Über 90 Tage überfällig (Anteil an Rechnungen)', a.kpis.overdue90Share, PCT],
    ['Anzahl Debitoren / davon überfällig', `${a.kpis.customers} / ${a.kpis.overdueCustomers}`],
    ['Grösster überfälliger Saldo', a.kpis.largestOverdue ? `${a.kpis.largestOverdue.customer}: CHF ${(a.kpis.largestOverdue.amount / 100).toLocaleString('de-CH', { minimumFractionDigits: 2 })}` : '–'],
    ['Durchschnittliche Überfälligkeit (gewichtet, Tage)', a.kpis.avgDaysOverdue],
  ];
  for (const [k, v, f] of kpi) { ov.getCell(`A${r}`).value = k; ov.getCell(`B${r}`).value = v; if (f) ov.getCell(`B${r}`).numFmt = f; r++; }
  r++;
  sec('Kontrollen der OP-Liste');
  for (const c of a.checks) {
    ov.getCell(`A${r}`).value = `${c.passed ? '✓' : '✗'} ${c.name}`;
    ov.getCell(`A${r}`).font = { color: { argb: c.passed ? 'FF1D7A46' : 'FFB3261E' } };
    ov.getCell(`B${r}`).value = c.message; ov.mergeCells(`B${r}:C${r}`); ov.getCell(`B${r}`).alignment = { wrapText: true };
    r++;
  }
  r++;
  sec('Feststellungen und nächste Schritte');
  for (const f of m.findings) {
    ov.getCell(`A${r}`).value = f.text; ov.getCell(`A${r}`).alignment = { wrapText: true };
    ov.mergeCells(`A${r}:B${r}`); ov.getCell(`C${r}`).value = f.status; r++;
  }
  if (m.note?.trim()) {
    r++;
    sec('Notiz');
    ov.getCell(`A${r}`).value = m.note; ov.getCell(`A${r}`).alignment = { wrapText: true, vertical: 'top' };
    ov.mergeCells(`A${r}:C${r}`); ov.getRow(r).height = Math.min(300, 15 * (1 + Math.ceil(m.note.length / 110) + (m.note.match(/\n/g)?.length ?? 0)));
  }

  // ---------------- Altersstruktur ----------------
  const ag = wb.addWorksheet('Altersstruktur', { pageSetup: ps });
  ag.columns = [{ width: 34 }, { width: 18 }, { width: 12 }, { width: 14 }];
  head(ag, 1, ['Altersklasse (per Bilanzstichtag)', 'CHF', 'Anteil', 'Posten']);
  BUCKETS.forEach((b, i) => {
    const row = i + 2;
    ag.getCell(row, 1).value = b;
    ag.getCell(row, 2).value = a.buckets[i]! / 100; ag.getCell(row, 2).numFmt = CHF;
    ag.getCell(row, 3).value = { formula: `IF($B$7=0,0,B${row}/$B$7)`, result: a.grossChf ? a.buckets[i]! / a.grossChf : 0 }; ag.getCell(row, 3).numFmt = PCT;
    ag.getCell(row, 4).value = a.items.filter(x => x.bucket === i && (x.amountChf ?? 0) > 0).length;
  });
  ag.getCell('A7').value = 'Total offene Rechnungen'; ag.getCell('B7').value = { formula: 'SUM(B2:B6)', result: a.grossChf / 100 };
  ag.getCell('A8').value = 'Gutschriften / Vorauszahlungen'; ag.getCell('B8').value = a.credits / 100;
  ag.getCell('A9').value = 'Total OP-Liste'; ag.getCell('B9').value = { formula: 'B7+B8', result: a.totalChf / 100 };
  for (const c of ['B7', 'B8', 'B9']) { ag.getCell(c).numFmt = CHF; ag.getCell(c).font = { bold: true }; }
  for (const c of ['A7', 'A9']) ag.getCell(c).font = { bold: true };

  // ---------------- Kunden ----------------
  const ku = wb.addWorksheet('Kunden', { pageSetup: ps });
  const kcols = ['Debitor', 'Name', 'Total CHF', ...BUCKETS, 'Gutschr./VZ', 'Max. Tage überfällig', 'Mahnstufe', 'Posten'];
  [12, 34, 15, 14, 14, 14, 14, 14, 14, 12, 10, 8].forEach((w, i) => (ku.getColumn(i + 1).width = w));
  ku.addTable({
    name: 'tblKunden', ref: 'A1', headerRow: true, totalsRow: true, style: { theme: 'TableStyleMedium2', showRowStripes: true },
    columns: kcols.map((name, i) => ({ name, filterButton: true, totalsRowFunction: i >= 2 && i <= 8 ? 'sum' as const : i === 0 ? 'none' as const : 'none' as const, totalsRowLabel: i === 0 ? 'Total' : undefined })),
    rows: a.customers.map(c => [c.customerNo, c.customerName, c.totalChf / 100, ...c.buckets.map(b => b / 100), c.credits / 100, c.maxDaysOverdue || null, c.dunningLevel, c.items]),
  });
  for (let i = 2; i <= a.customers.length + 2; i++) for (let c = 3; c <= 9; c++) ku.getCell(i, c).numFmt = CHF;
  ku.views = [{ state: 'frozen', ySplit: 1, xSplit: 2 }];

  // ---------------- Einzelposten ----------------
  const ep = wb.addWorksheet('Einzelposten', { pageSetup: ps });
  const ecols = ['Debitor', 'Name', 'Beleg', 'Belegart', 'Belegdatum', 'Fällig', 'Tage überfällig', 'Altersklasse', 'Währung', 'Betrag (Währung)', 'Betrag CHF', 'Mahnstufe', 'Seite OP-Liste', 'Fälligkeit hergeleitet aus', 'Korrektur Prüfer'];
  [11, 30, 12, 13, 12, 12, 10, 13, 8, 15, 15, 9, 9, 28, 30].forEach((w, i) => (ep.getColumn(i + 1).width = w));
  ep.addTable({
    name: 'tblPosten', ref: 'A1', headerRow: true, style: { theme: 'TableStyleLight9', showRowStripes: true },
    columns: ecols.map(name => ({ name, filterButton: true })),
    rows: a.items.map(i => [i.customerNo, i.customerName, i.docNo, i.docType, d(i.date), d(i.due), i.daysOverdue, i.amount < 0 ? 'Gutschr./VZ' : BUCKETS[i.bucket], i.currency, i.amount / 100, i.amountChf === null ? null : i.amountChf / 100, i.dunningLevel, i.page, i.dueWhy ?? '', i.corrected ? `korrigiert${i.comment ? `: ${i.comment}` : ''}` : '']),
  });
  for (let i = 2; i <= a.items.length + 1; i++) {
    ep.getCell(i, 5).numFmt = DATE; ep.getCell(i, 6).numFmt = DATE; ep.getCell(i, 10).numFmt = CHF; ep.getCell(i, 11).numFmt = CHF;
  }
  ep.views = [{ state: 'frozen', ySplit: 1, xSplit: 2 }];

  // Vom Prüfer ausgeschlossene Posten (nachvollziehbar dokumentiert)
  if (a.excluded?.length) {
    const ex = wb.addWorksheet('Ausgeschlossen', { pageSetup: ps });
    ex.addTable({
      name: 'tblAusgeschlossen', ref: 'A1', headerRow: true, style: { theme: 'TableStyleLight9', showRowStripes: true },
      columns: ['Debitor', 'Name', 'Beleg', 'Belegdatum', 'Währung', 'Betrag (Währung)', 'Seite OP-Liste', 'Begründung'].map(name => ({ name, filterButton: true })),
      rows: a.excluded.map(i => [i.customerNo, i.customerName, i.docNo, d(i.date), i.currency, i.amount / 100, i.page, i.comment ?? '']),
    });
    [11, 30, 12, 12, 8, 15, 9, 40].forEach((w, i) => (ex.getColumn(i + 1).width = w));
    ex.headerFooter.oddFooter = `&L${m.mandate}&C&A – Seite &P von &N&RBalance Scout`;
  }
  for (const sh of [ov, ag, ku, ep]) sh.headerFooter.oddFooter = `&L${m.mandate}&C&A – Seite &P von &N&RBalance Scout`;
  return Buffer.from(await wb.xlsx.writeBuffer());
}
