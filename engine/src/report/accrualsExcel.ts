import ExcelJS from 'exceljs';
import type { AccrualsResult } from '../analysis/accruals.js';

const GREEN = 'FF3F8F4F';
const GREY = 'FF6B7385';
const CUR_FILL = 'FFE6F2E6';
const CHF = "#,##0.00;[Red]-#,##0.00";
const CLS: Record<string, string> = { vorjahr: 'Vorjahr (Auflösung)', laufend: 'laufendes Jahr (Bildung)', unterjaehrig: 'unterjährig' };

/** Vorjahresvergleich der Rechnungsabgrenzungen (je Konto ein Block) als Excel */
export async function accrualsWorkbook(r: AccrualsResult, m: { mandate: string; closingDate: string; notes?: Record<string, { text: string }>; note?: string; visum?: string; attachments?: { register: string; name: string; account: string; position?: string | null }[] }): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Balance Scout';
  const ws = wb.addWorksheet('Rechnungsabgrenzungen', { pageSetup: { orientation: 'landscape', paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
  const cd = m.closingDate.split('-').reverse().join('.');
  const pd = m.closingDate ? `${m.closingDate.slice(8, 10)}.${m.closingDate.slice(5, 7)}.${Number(m.closingDate.slice(0, 4)) - 1}` : 'Vorjahr';
  ws.getCell('A1').value = 'Rechnungsabgrenzungen – Vorjahresvergleich';
  ws.getCell('A1').font = { bold: true, size: 15, color: { argb: GREEN } };
  ws.getCell('A2').value = `${m.mandate} · Bilanzstichtag ${cd} · Quelle: Kontoblätter (Vorjahr = Auflösungen, laufendes Jahr = Bildung Ende Jahr)${m.visum ? ` · Visum ${m.visum}` : ''}`;
  ws.getCell('A2').font = { italic: true, color: { argb: GREY } };
  [48, 12, 16, 16, 16, 14, 50].forEach((w, i) => (ws.getColumn(i + 1).width = w));
  let row = 4;
  for (const a of r.accounts) {
    ws.getCell(row, 1).value = `${a.side === 'aktiv' ? 'Transitorische Aktiven' : 'Transitorische Passiven'} – ${a.accountNumber} ${a.accountName}`;
    ws.getCell(row, 1).font = { bold: true, size: 13 };
    row++;
    ['Position', 'Konto', cd, pd, 'Veränderung', 'Status', 'Bemerkung'].forEach((h, i) => {
      const c = ws.getCell(row, i + 1);
      c.value = h; c.font = { bold: true, color: { argb: 'FFFFFFFF' } }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GREEN } };
      c.alignment = { horizontal: i >= 2 && i <= 4 ? 'right' : 'left' };
    });
    row++;
    const first = row;
    for (const x of a.positions) {
      const att = (m.attachments ?? []).filter(f => f.account === a.accountNumber && f.position === x.key).map(f => f.register);
      const remark = [m.notes?.[`${a.accountNumber}|${x.key}`]?.text ?? '', att.length ? `Beleg ${att.join(', ')}` : ''].filter(Boolean).join(' · ');
      ws.getRow(row).values = [x.label, x.contra ?? '', x.cy / 100, x.py / 100, null, x.status === 'beide' ? (x.edited ? 'korrigiert' : '') : x.status + (x.edited ? ', korrigiert' : ''), remark];
      ws.getCell(row, 5).value = { formula: `C${row}-D${row}`, result: x.diff / 100 };
      for (const c of [3, 4, 5]) ws.getCell(row, c).numFmt = CHF;
      ws.getCell(row, 3).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: CUR_FILL } };
      ws.getCell(row, 7).alignment = { wrapText: true, vertical: 'top' };
      row++;
    }
    const sumRow = (label: string, cy: number, py: number, f?: { cy: string; py: string }) => {
      ws.getCell(row, 1).value = label;
      ws.getCell(row, 3).value = f ? { formula: f.cy, result: cy / 100 } : cy / 100;
      ws.getCell(row, 4).value = f ? { formula: f.py, result: py / 100 } : py / 100;
      ws.getCell(row, 5).value = { formula: `C${row}-D${row}`, result: (cy - py) / 100 };
      for (const c of [3, 4, 5]) ws.getCell(row, c).numFmt = CHF;
      row++;
    };
    if (a.unexplained.cy || a.unexplained.py) {
      sumRow('nicht aufgeschlüsselt (Differenz zum Saldo – Klassierung prüfen)', a.unexplained.cy, a.unexplained.py);
      ws.getRow(row - 1).font = { italic: true, color: { argb: 'FFB3261E' } };
    }
    const last = row - 1;
    sumRow('Total', a.closing, a.opening, { cy: `SUM(C${first}:C${last})`, py: `SUM(D${first}:D${last})` });
    ws.getRow(row - 1).font = { bold: true };
    ws.getRow(row - 1).border = { top: { style: 'thin' }, bottom: { style: 'double' } } as never;
    if (a.tbBalance !== null) {
      ws.getCell(row, 1).value = 'Saldo laut Saldobilanz'; ws.getCell(row, 3).value = a.tbBalance / 100; ws.getCell(row, 3).numFmt = CHF;
      ws.getCell(row, 1).font = { italic: true, color: { argb: GREY } };
      row++;
    }
    const general = (m.attachments ?? []).filter(f => f.account === a.accountNumber && !f.position);
    if (general.length) { ws.getCell(row, 1).value = `Beilagen zum Konto: ${general.map(f => `${f.register} ${f.name}`).join(' · ')}`; ws.getCell(row, 1).font = { italic: true }; ws.mergeCells(row, 1, row, 7); row++; }
    for (const f of a.flags) { ws.getCell(row, 1).value = `⚠ ${f}`; ws.getCell(row, 1).font = { color: { argb: 'FFB3261E' } }; ws.mergeCells(row, 1, row, 7); row++; }
    row += 2;
  }
  if (r.suggestions.length || m.note?.trim()) {
    ws.getCell(row, 1).value = 'Feststellungen und nächste Schritte'; ws.getCell(row, 1).font = { bold: true, color: { argb: GREEN } }; row++;
    for (const sgt of r.suggestions) { ws.getCell(row, 1).value = sgt; ws.mergeCells(row, 1, row, 7); ws.getCell(row, 1).alignment = { wrapText: true }; row++; }
    if (m.note?.trim()) { row++; ws.getCell(row, 1).value = `Notiz: ${m.note}`; ws.mergeCells(row, 1, row, 7); ws.getCell(row, 1).alignment = { wrapText: true, vertical: 'top' }; ws.getRow(row).height = 45; }
  }
  ws.headerFooter.oddFooter = `&L${m.mandate}&C&A – Seite &P von &N&RBalance Scout`;

  // Alle Buchungen mit Klassierung (nachvollziehbar, filterbar)
  const bw = wb.addWorksheet('Buchungen');
  const rows = r.accounts.flatMap(a => a.postings.map(x => [a.accountNumber, new Date(`${x.date}T00:00:00Z`), x.text, x.contra ?? '', x.amount / 100, CLS[x.cls]! + (x.cls !== x.auto ? ' (manuell)' : ''), x.cls !== x.auto ? 'vom Prüfer geändert' : x.why]));
  bw.addTable({
    name: 'tblAbgrenzungen', ref: 'A1', headerRow: true, style: { theme: 'TableStyleLight9', showRowStripes: true },
    columns: ['Konto', 'Datum', 'Text', 'Gegenkonto', 'Betrag CHF', 'Klassierung', 'Begründung'].map(name => ({ name, filterButton: true })),
    rows: rows.length ? rows : [['', null, '', '', null, '', '']],
  });
  [10, 12, 50, 12, 15, 24, 50].forEach((w, i) => (bw.getColumn(i + 1).width = w));
  for (let i = 2; i <= rows.length + 1; i++) { bw.getCell(i, 2).numFmt = 'dd.mm.yyyy'; bw.getCell(i, 5).numFmt = CHF; }
  return Buffer.from(await wb.xlsx.writeBuffer());
}
