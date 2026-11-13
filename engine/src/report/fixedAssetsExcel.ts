import ExcelJS from 'exceljs';
import type { FixedAssetsResult } from '../analysis/fixedAssets.js';

const BLUE = 'FF0F5EA8';
const CHF = '#,##0.00;[Red]-#,##0.00';
const CLS: Record<string, string> = { zugang: 'Zugang', abgang: 'Abgang', abschreibung: 'Abschreibung', umbuchung: 'Umbuchung' };

/** Anlagespiegel und Abschreibungsanalyse als Excel */
export async function fixedAssetsWorkbook(r: FixedAssetsResult, m: { mandate: string; closingDate: string; findings: { text: string; status: string }[]; note?: string; visum?: string; sources?: string[] }): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Balance Scout';
  const ps = { orientation: 'landscape' as const, paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
  const ws = wb.addWorksheet('Anlagespiegel', { pageSetup: ps });
  ws.getCell('A1').value = 'Sachanlagen – Anlagespiegel und Abschreibungsanalyse';
  ws.getCell('A1').font = { bold: true, size: 15, color: { argb: BLUE } };
  ws.getCell('A2').value = `${m.mandate} · Bilanzstichtag ${m.closingDate.split('-').reverse().join('.')} · Quelle: Kontoblätter${m.sources?.length ? ` (${m.sources.join(', ')})` : ''}${m.visum ? ` · Visum ${m.visum}` : ''}`;
  ws.getCell('A2').font = { italic: true, color: { argb: 'FF6B7385' } };
  const head = ['Konto', 'Bezeichnung', 'Anfangsbestand', 'Zugänge', 'Abgänge', 'Abschreibungen', 'Umbuchungen', 'Endbestand', 'Saldobilanz', 'Differenz', 'Kategorie (ESTV)', 'ESTV-Satz', 'Effektiver Satz (Buchwert)', 'Satz vom AW (linear)', 'Hinweise'];
  [10, 32, 15, 14, 14, 15, 13, 15, 15, 12, 34, 10, 12, 12, 60].forEach((w, i) => (ws.getColumn(i + 1).width = w));
  head.forEach((h, i) => {
    const c = ws.getCell(4, i + 1);
    c.value = h; c.font = { bold: true, color: { argb: 'FFFFFFFF' } }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BLUE } }; c.alignment = { wrapText: true, vertical: 'middle' };
  });
  ws.getRow(4).height = 30;
  r.rows.forEach((x, i) => {
    const row = 5 + i;
    const v: ExcelJS.CellValue[] = [x.accountNumber, x.wbAccount ? `${x.accountName} (inkl. Wertberichtigung ${x.wbAccount})` : x.accountName, x.opening / 100, x.additions / 100, -x.disposals / 100, -x.depreciation / 100, x.transfers / 100, null, x.tbBalance === null ? null : x.tbBalance / 100, null, x.categoryLabel, x.estvRate === null ? null : x.estvRate / 100, null, x.linearRate, x.flags.join(' · ')];
    v.forEach((val, j) => (ws.getCell(row, j + 1).value = val));
    ws.getCell(row, 8).value = { formula: `SUM(C${row}:G${row})`, result: x.closing / 100 };
    ws.getCell(row, 10).value = { formula: `IF(I${row}="","",ROUND(H${row}-I${row},2))`, result: x.tbDiff === null ? '' : x.tbDiff / 100 };
    ws.getCell(row, 13).value = { formula: `IF((C${row}+D${row}+E${row}+G${row})<=0,"",-F${row}/(C${row}+D${row}+E${row}+G${row}))`, result: x.effectiveRate ?? '' };
    for (let c = 3; c <= 10; c++) ws.getCell(row, c).numFmt = CHF;
    ws.getCell(row, 12).numFmt = '0%'; ws.getCell(row, 13).numFmt = '0.0%'; ws.getCell(row, 14).numFmt = '0.0%';
    ws.getCell(row, 15).alignment = { wrapText: true, vertical: 'top' };
  });
  const tr = 5 + r.rows.length;
  ws.getCell(tr, 1).value = 'Total';
  const tot = [r.totals.opening, r.totals.additions, -r.totals.disposals, -r.totals.depreciation, r.totals.transfers, r.totals.closing, r.totals.tbBalance, r.totals.closing - r.totals.tbBalance];
  for (let c = 3; c <= 10; c++) {
    const L = String.fromCharCode(64 + c);
    ws.getCell(tr, c).value = { formula: `SUM(${L}5:${L}${tr - 1})`, result: tot[c - 3]! / 100 };
    ws.getCell(tr, c).numFmt = CHF;
  }
  ws.getRow(tr).font = { bold: true };
  ws.addConditionalFormatting({ ref: `M5:M${Math.max(5, tr - 1)}`, rules: [{ type: 'expression', priority: 1, formulae: ['AND(M5<>"",L5<>"",M5>L5+0.005)'], style: { font: { color: { argb: 'FFB3261E' }, bold: true } } }] });
  ws.addConditionalFormatting({ ref: `N5:N${Math.max(5, tr - 1)}`, rules: [{ type: 'expression', priority: 2, formulae: ['AND(N5<>"",L5<>"",N5>L5/2+0.005)'], style: { font: { color: { argb: 'FFB3261E' }, bold: true } } }] });
  ws.views = [{ state: 'frozen', ySplit: 4, xSplit: 2 }];
  let rr = tr + 2;
  // Abstimmung der Abschreibungen mit dem Aufwand laut Saldobilanz
  if (r.expense) {
    ws.getCell(rr, 1).value = 'Abstimmung Abschreibungen ↔ Aufwand (Saldobilanz)'; ws.getCell(rr, 1).font = { bold: true, color: { argb: BLUE } }; rr++;
    ws.getCell(rr, 2).value = 'Abschreibungen laut Anlagespiegel'; ws.getCell(rr, 6).value = { formula: `-F${tr}`, result: r.totals.depreciation / 100 }; ws.getCell(rr, 6).numFmt = CHF;
    const depRow = rr; rr++;
    const first = rr;
    for (const a of r.expense.accounts) { ws.getCell(rr, 1).value = a.accountNumber; ws.getCell(rr, 2).value = a.accountName; ws.getCell(rr, 6).value = a.balance / 100; ws.getCell(rr, 6).numFmt = CHF; rr++; }
    ws.getCell(rr, 2).value = 'Abschreibungsaufwand laut Saldobilanz'; ws.getCell(rr, 6).value = { formula: `SUM(F${first}:F${rr - 1})`, result: r.expense.total / 100 }; ws.getCell(rr, 6).numFmt = CHF; ws.getRow(rr).font = { bold: true };
    const expRow = rr; rr++;
    ws.getCell(rr, 2).value = 'Differenz'; ws.getCell(rr, 6).value = { formula: `ROUND(F${depRow}-F${expRow},2)`, result: r.expense.diff / 100 }; ws.getCell(rr, 6).numFmt = CHF; ws.getRow(rr).font = { bold: true };
    if (Math.abs(r.expense.diff) > 100) ws.getCell(rr, 6).font = { bold: true, color: { argb: 'FFB3261E' } };
    rr += 2;
  }
  ws.getCell(rr, 1).value = 'ESTV-Normalsätze: Merkblatt A 1995 (degressiv vom Buchwert; linear vom Anschaffungswert = halber Satz). Effektiver Satz = Abschreibung / (Anfangsbestand + Zugänge − Abgänge + Umbuchungen); Satz vom AW = Abschreibung / Anschaffungswert Ende (nur indirekte Methode).';
  ws.getCell(rr, 1).font = { italic: true, color: { argb: 'FF6B7385' } };
  if (r.rows.some(x => x.wbAccount)) {
    rr++;
    ws.getCell(rr, 1).value = 'Indirekte Abschreibung: Beträge sind Buchwerte (Anlagekonto + Wertberichtigungskonto); Anschaffungswerte und kumulierte Abschreibungen im Blatt „Anschaffungswerte“.';
    ws.getCell(rr, 1).font = { italic: true, color: { argb: 'FF6B7385' } };
  }
  rr += 2;
  ws.getCell(rr, 1).value = 'Feststellungen und nächste Schritte'; ws.getCell(rr, 1).font = { bold: true, color: { argb: BLUE } }; rr++;
  for (const f of m.findings) { ws.getCell(rr, 1).value = f.status; ws.getCell(rr, 2).value = f.text; ws.mergeCells(rr, 2, rr, 10); rr++; }
  if (m.note?.trim()) { rr++; ws.getCell(rr, 1).value = 'Notiz'; ws.getCell(rr, 1).font = { bold: true, color: { argb: BLUE } }; ws.getCell(rr, 2).value = m.note; ws.mergeCells(rr, 2, rr, 10); ws.getCell(rr, 2).alignment = { wrapText: true, vertical: 'top' }; ws.getRow(rr).height = 60; }

  // Indirekte Methode: Anschaffungswerte und kumulierte Abschreibungen (Bruttodarstellung)
  if (r.rows.some(x => x.wbAccount)) {
    const gs = wb.addWorksheet('Anschaffungswerte', { pageSetup: ps });
    gs.getCell('A1').value = 'Anlagespiegel brutto – Anschaffungswerte und kumulierte Abschreibungen';
    gs.getCell('A1').font = { bold: true, size: 15, color: { argb: BLUE } };
    gs.getCell('A2').value = 'Anschaffungswerte aus dem Anlagekonto, kumulierte Abschreibungen aus dem Wertberichtigungskonto (Haben = Abschreibung, Soll bei Abgang = Auflösung).';
    gs.getCell('A2').font = { italic: true, color: { argb: 'FF6B7385' } };
    const gh = ['Konto', 'Bezeichnung', 'WB-Konto', 'AW Anfang', 'Zugänge', 'Abgänge', 'Umbuchungen', 'AW Ende', 'Kum. Abschr. Anfang', 'Abschreibungen', 'Auflösung Abgänge', 'Übrige', 'Kum. Abschr. Ende', 'Buchwert Ende', 'Saldobilanz', 'Differenz'];
    [10, 32, 10, 15, 14, 14, 13, 15, 16, 15, 15, 12, 16, 15, 15, 12].forEach((w, i) => (gs.getColumn(i + 1).width = w));
    gh.forEach((h, i) => {
      const c = gs.getCell(4, i + 1);
      c.value = h; c.font = { bold: true, color: { argb: 'FFFFFFFF' } }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BLUE } }; c.alignment = { wrapText: true, vertical: 'middle' };
    });
    gs.getRow(4).height = 30;
    r.rows.forEach((x, i) => {
      const row = 5 + i;
      const v: ExcelJS.CellValue[] = [x.accountNumber, x.accountName, x.wbAccount ?? '(direkt)', x.awOpening / 100, x.awAdditions / 100, -x.awDisposals / 100, x.awTransfers / 100, null, x.kumOpening / 100, -x.depreciation / 100, x.kumDisposals / 100, x.kumOther / 100, null, null, x.tbBalance === null ? null : x.tbBalance / 100, null];
      v.forEach((val, j) => (gs.getCell(row, j + 1).value = val));
      gs.getCell(row, 8).value = { formula: `SUM(D${row}:G${row})`, result: x.awClosing / 100 };
      gs.getCell(row, 13).value = { formula: `SUM(I${row}:L${row})`, result: x.kumClosing / 100 };
      gs.getCell(row, 14).value = { formula: `H${row}+M${row}`, result: (x.awClosing + x.kumClosing) / 100 };
      gs.getCell(row, 16).value = { formula: `IF(O${row}="","",ROUND(N${row}-O${row},2))`, result: x.tbBalance === null ? '' : (x.awClosing + x.kumClosing - x.tbBalance) / 100 };
      for (let c = 4; c <= 16; c++) gs.getCell(row, c).numFmt = CHF;
    });
    const gt = 5 + r.rows.length;
    gs.getCell(gt, 1).value = 'Total';
    const sumOf = (f: (x: (typeof r.rows)[number]) => number) => r.rows.reduce((s2, x) => s2 + f(x), 0) / 100;
    const gtot = [sumOf(x => x.awOpening), sumOf(x => x.awAdditions), sumOf(x => -x.awDisposals), sumOf(x => x.awTransfers), sumOf(x => x.awClosing), sumOf(x => x.kumOpening), sumOf(x => -x.depreciation), sumOf(x => x.kumDisposals), sumOf(x => x.kumOther), sumOf(x => x.kumClosing), sumOf(x => x.awClosing + x.kumClosing), sumOf(x => x.tbBalance ?? 0), sumOf(x => x.tbBalance === null ? 0 : x.awClosing + x.kumClosing - x.tbBalance)];
    for (let c = 4; c <= 16; c++) {
      const L = String.fromCharCode(64 + c);
      gs.getCell(gt, c).value = { formula: `SUM(${L}5:${L}${gt - 1})`, result: gtot[c - 4]! };
      gs.getCell(gt, c).numFmt = CHF;
    }
    gs.getRow(gt).font = { bold: true };
    gs.views = [{ state: 'frozen', ySplit: 4, xSplit: 2 }];
    gs.headerFooter.oddFooter = `&L${m.mandate}&C&A – Seite &P von &N&RBalance Scout`;
  }

  // Zugangsliste: alle Zugänge mit Beleg, Gegenkonto und Text (Summe = Spalte „Zugänge“)
  const zs = wb.addWorksheet('Zugänge', { pageSetup: ps });
  zs.getCell('A1').value = 'Zugangsliste';
  zs.getCell('A1').font = { bold: true, size: 15, color: { argb: BLUE } };
  zs.getCell('A2').value = `${m.mandate} · Geschäftsjahr per ${m.closingDate.split('-').reverse().join('.')} · ${r.additionsList.length} Buchungen · Total CHF ${(r.totals.additions / 100).toLocaleString('de-CH', { minimumFractionDigits: 2 }).replace(/’/g, "'")}`;
  zs.getCell('A2').font = { italic: true, color: { argb: 'FF6B7385' } };
  const zRows = r.additionsList.map(x => [x.assetAccount, x.assetName, x.account !== x.assetAccount ? x.account : '', new Date(`${x.date}T00:00:00Z`), x.docNo ?? '', x.text, x.contra ?? '', x.amount / 100, x.manual ? 'vom Prüfer als Zugang klassiert' : '']);
  zs.addTable({
    name: 'tblZugaenge', ref: 'A4', headerRow: true, totalsRow: true, style: { theme: 'TableStyleLight9', showRowStripes: true },
    columns: [
      { name: 'Anlagekonto', totalsRowLabel: 'Total', filterButton: true }, { name: 'Bezeichnung', filterButton: true }, { name: 'Gebucht auf', filterButton: true },
      { name: 'Datum', filterButton: true }, { name: 'Beleg', filterButton: true }, { name: 'Text', filterButton: true }, { name: 'Gegenkonto', filterButton: true },
      { name: 'Betrag CHF', totalsRowFunction: 'sum', filterButton: true }, { name: 'Hinweis', filterButton: true },
    ],
    rows: zRows.length ? zRows : [['', 'Keine Zugänge im Geschäftsjahr', '', null, '', '', '', 0, '']],
  });
  [12, 32, 12, 12, 12, 50, 12, 15, 30].forEach((w, i) => (zs.getColumn(i + 1).width = w));
  for (let i = 5; i <= Math.max(1, zRows.length) + 5; i++) { zs.getCell(i, 4).numFmt = 'dd.mm.yyyy'; zs.getCell(i, 8).numFmt = CHF; }
  zs.views = [{ state: 'frozen', ySplit: 4 }];
  zs.headerFooter.oddFooter = `&L${m.mandate}&C&A – Seite &P von &N&RBalance Scout`;

  const bw = wb.addWorksheet('Buchungen', { pageSetup: ps });
  const rows = r.rows.flatMap(x => x.postings.map(p => [p.key.split('|')[0] ?? x.accountNumber, new Date(`${p.date}T00:00:00Z`), p.text, p.contra ?? '', p.amount / 100, CLS[p.cls]! + (p.cls !== p.auto ? ' (manuell)' : ''), p.cls !== p.auto ? 'vom Prüfer geändert' : p.why, p.page]));
  bw.addTable({
    name: 'tblAnlagenBuchungen', ref: 'A1', headerRow: true, style: { theme: 'TableStyleLight9', showRowStripes: true },
    columns: ['Konto', 'Datum', 'Text', 'Gegenkonto', 'Betrag CHF', 'Klassierung', 'Begründung', 'Seite'].map(name => ({ name, filterButton: true })),
    rows: rows.length ? rows : [['', null, '', '', null, '', '', null]],
  });
  [10, 12, 50, 12, 15, 18, 40, 8].forEach((w, i) => (bw.getColumn(i + 1).width = w));
  for (let i = 2; i <= rows.length + 1; i++) { bw.getCell(i, 2).numFmt = 'dd.mm.yyyy'; bw.getCell(i, 5).numFmt = CHF; }
  for (const sh of [ws, bw]) sh.headerFooter.oddFooter = `&L${m.mandate}&C&A – Seite &P von &N&RBalance Scout`;
  return Buffer.from(await wb.xlsx.writeBuffer());
}
