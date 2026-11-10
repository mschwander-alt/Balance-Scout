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
  const head = ['Konto', 'Bezeichnung', 'Anfangsbestand', 'Zugänge', 'Abgänge', 'Abschreibungen', 'Umbuchungen', 'Endbestand', 'Saldobilanz', 'Differenz', 'Kategorie (ESTV)', 'ESTV-Satz', 'Effektiver Satz', 'Hinweise'];
  [10, 32, 15, 14, 14, 15, 13, 15, 15, 12, 34, 10, 12, 60].forEach((w, i) => (ws.getColumn(i + 1).width = w));
  head.forEach((h, i) => {
    const c = ws.getCell(4, i + 1);
    c.value = h; c.font = { bold: true, color: { argb: 'FFFFFFFF' } }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BLUE } }; c.alignment = { wrapText: true, vertical: 'middle' };
  });
  ws.getRow(4).height = 30;
  r.rows.forEach((x, i) => {
    const row = 5 + i;
    const v: ExcelJS.CellValue[] = [x.accountNumber, x.accountName, x.opening / 100, x.additions / 100, -x.disposals / 100, -x.depreciation / 100, x.transfers / 100, null, x.tbBalance === null ? null : x.tbBalance / 100, null, x.categoryLabel, x.estvRate === null ? null : x.estvRate / 100, null, x.flags.join(' · ')];
    v.forEach((val, j) => (ws.getCell(row, j + 1).value = val));
    ws.getCell(row, 8).value = { formula: `SUM(C${row}:G${row})`, result: x.closing / 100 };
    ws.getCell(row, 10).value = { formula: `IF(I${row}="","",ROUND(H${row}-I${row},2))`, result: x.tbDiff === null ? '' : x.tbDiff / 100 };
    ws.getCell(row, 13).value = { formula: `IF((C${row}+D${row}+E${row}+G${row})<=0,"",-F${row}/(C${row}+D${row}+E${row}+G${row}))`, result: x.effectiveRate ?? '' };
    for (let c = 3; c <= 10; c++) ws.getCell(row, c).numFmt = CHF;
    ws.getCell(row, 12).numFmt = '0%'; ws.getCell(row, 13).numFmt = '0.0%';
    ws.getCell(row, 14).alignment = { wrapText: true, vertical: 'top' };
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
  ws.views = [{ state: 'frozen', ySplit: 4, xSplit: 2 }];
  let rr = tr + 2;
  ws.getCell(rr, 1).value = 'ESTV-Normalsätze: Merkblatt A 1995 (degressiv vom Buchwert; linear vom Anschaffungswert = halber Satz). Effektiver Satz = Abschreibung / (Anfangsbestand + Zugänge − Abgänge + Umbuchungen).';
  ws.getCell(rr, 1).font = { italic: true, color: { argb: 'FF6B7385' } };
  rr += 2;
  ws.getCell(rr, 1).value = 'Feststellungen und nächste Schritte'; ws.getCell(rr, 1).font = { bold: true, color: { argb: BLUE } }; rr++;
  for (const f of m.findings) { ws.getCell(rr, 1).value = f.status; ws.getCell(rr, 2).value = f.text; ws.mergeCells(rr, 2, rr, 10); rr++; }
  if (m.note?.trim()) { rr++; ws.getCell(rr, 1).value = 'Notiz'; ws.getCell(rr, 1).font = { bold: true, color: { argb: BLUE } }; ws.getCell(rr, 2).value = m.note; ws.mergeCells(rr, 2, rr, 10); ws.getCell(rr, 2).alignment = { wrapText: true, vertical: 'top' }; ws.getRow(rr).height = 60; }

  const bw = wb.addWorksheet('Buchungen', { pageSetup: ps });
  const rows = r.rows.flatMap(x => x.postings.map(p => [x.accountNumber, new Date(`${p.date}T00:00:00Z`), p.text, p.contra ?? '', p.amount / 100, CLS[p.cls]! + (p.cls !== p.auto ? ' (manuell)' : ''), p.cls !== p.auto ? 'vom Prüfer geändert' : p.why, p.page]));
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
