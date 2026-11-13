import ExcelJS from 'exceljs';
import type { Amounts, IncomeAnalysis, IncomeNotes } from '../analysis/incomeStatement.js';

const GREEN = 'FF3F8F4F';
const GREY = 'FF6B7385';
const RESULT_FILL = 'FF5B636E';
const SECTION_FILL = 'FFE8ECEF';
const CUR_FILL = 'FFE6F2E6';
const CHF = "#,##0;[Red]-#,##0";
const PCT = '0.0%;[Red]-0.0%';

/** Analyse der Erfolgsrechnung (Staffel, Margen, Vorjahr, Bemerkungen) als Excel */
export async function incomeWorkbook(a: IncomeAnalysis, notes: IncomeNotes, m: { mandate: string; closingDate: string; visum?: string }): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Balance Scout';
  const ws = wb.addWorksheet('Analyse Erfolgsrechnung', {
    pageSetup: { orientation: 'landscape', paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
    properties: { outlineLevelRow: 1 },
  });
  ws.properties.outlineProperties = { summaryBelow: false, summaryRight: false };
  const year = m.closingDate.slice(0, 4);
  const prevYear = String(Number(year) - 1);
  ws.getCell('A1').value = 'Analyse der Erfolgsrechnung – Vorjahresvergleich';
  ws.getCell('A1').font = { bold: true, size: 15, color: { argb: GREEN } };
  ws.getCell('A2').value = `${m.mandate} · Bilanzstichtag ${m.closingDate.split('-').reverse().join('.')} · Anteile in % von: ${a.base.label} · Ertrag positiv, Aufwand negativ${a.signFlipped ? ' (Vorzeichen der Saldobilanz gedreht)' : ''}${m.visum ? ` · Visum ${m.visum}` : ''}`;
  ws.getCell('A2').font = { italic: true, color: { argb: GREY } };
  const pctHead = a.base.key === 'R:betriebsertrag' ? '%' : `% von ${a.base.label.length > 22 ? `${a.base.label.slice(0, 21)}…` : a.base.label}`;
  const head = ['Konto', 'Bezeichnung', `${year}`, pctHead, `${prevYear}`, pctHead, 'Differenz', 'Differenz %', 'Bemerkungen'];
  [10, 52, 15, 12, 15, 12, 14, 12, 60].forEach((w, i) => (ws.getColumn(i + 1).width = w));
  head.forEach((h, i) => {
    const c = ws.getCell(4, i + 1);
    c.value = h; c.font = { bold: true, color: { argb: 'FFFFFFFF' } }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GREEN } };
    c.alignment = { horizontal: i >= 2 && i <= 7 ? 'right' : 'left', vertical: 'middle' };
  });
  ws.getRow(4).height = 22;
  let r = 5;
  const put = (no: string, label: string, x: Amounts, key: string, style: 'result' | 'section' | 'sub' | 'account') => {
    const row = ws.getRow(r);
    row.values = [no, label, x.cy / 100, x.pctCy ?? null, a.hasPreviousYear ? (x.py ?? 0) / 100 : null, a.hasPreviousYear ? x.pctPy ?? null : null, a.hasPreviousYear ? (x.diff ?? 0) / 100 : null, x.diffPct ?? null, notes[key]?.text ?? ''];
    for (const c of [3, 5, 7]) row.getCell(c).numFmt = CHF;
    for (const c of [4, 6, 8]) row.getCell(c).numFmt = PCT;
    row.getCell(3).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: CUR_FILL } };
    row.getCell(9).alignment = { wrapText: true, vertical: 'top' };
    if (style === 'result') {
      row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      for (let c = 1; c <= 9; c++) row.getCell(c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: RESULT_FILL } };
    } else if (style === 'section') {
      row.font = { bold: true };
      for (let c = 1; c <= 9; c++) if (c !== 3) row.getCell(c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: SECTION_FILL } };
    } else if (style === 'sub') {
      row.font = { bold: true };
      row.getCell(2).alignment = { indent: 1 };
    } else {
      row.outlineLevel = 1;
      row.getCell(2).alignment = { indent: 2 };
    }
    r++;
  };
  for (const x of a.rows) {
    if (x.kind === 'result') { put('', x.label, x, x.key, 'result'); r++; continue; }
    put('', x.label, x, x.key, 'section');
    for (const s of x.subs) {
      put('', s.label, s, s.key, 'sub');
      for (const ac of s.accounts) put(ac.accountNumber, ac.accountName, ac, ac.key, 'account');
    }
    for (const ac of x.accounts) put(ac.accountNumber, ac.accountName, ac, ac.key, 'account');
  }
  r++;
  ws.getCell(r, 1).value = `Gliederung nach KMU-Kontenrahmen (Gruppe des Kontos, innerhalb der Gruppe nach den ersten zwei Ziffern der Kontonummer). Prozente: Anteil an „${a.base.label}“ (${year}: ${(a.base.cy / 100).toLocaleString('de-CH')}). Konten je Untergruppe über die Gliederung (+/−) ein- und ausblenden.`;
  ws.getCell(r, 1).font = { italic: true, color: { argb: GREY } };
  ws.views = [{ state: 'frozen', ySplit: 4, xSplit: 2 }];
  ws.headerFooter.oddFooter = `&L${m.mandate}&C&A – Seite &P von &N&RBalance Scout`;
  return Buffer.from(await wb.xlsx.writeBuffer());
}
