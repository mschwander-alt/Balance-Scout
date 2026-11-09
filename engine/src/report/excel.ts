import ExcelJS from 'exceljs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { RunResult, DocumentSummary } from '../run.js';
import type { AccountResult } from '../domain/matching/engine.js';

const BLUE = 'FF0F5EA8';
const GREEN_HDR = 'FF1D7A46';
const CHF = '#,##0.00;[Red]-#,##0.00';
const DATE = 'dd.mm.yyyy';
const STATUS_LABEL: Record<string, string> = {
  BELEGT: 'Belegt',
  PRUEFEN: 'Prüfen',
  KEIN_NACHWEIS: 'Kein Nachweis',
  NULLSALDO: 'Nullsaldo',
  NICHT_IM_UMFANG: 'Nicht im Umfang',
};
const FILL: Record<string, string> = {
  Belegt: 'FFE5F4EA', Prüfen: 'FFFFF4DC', 'Kein Nachweis': 'FFFDE8E7', Nullsaldo: 'FFEEF0F3', 'Nicht im Umfang': 'FFEEF0F3',
  Bestätigt: 'FFE5F4EA', Abweichung: 'FFFDE8E7', Offen: 'FFFFF4DC', 'Nicht anwendbar': 'FFEEF0F3',
  Zugeordnet: 'FFE5F4EA', 'Nicht zugeordnet': 'FFFDE8E7', 'Nicht relevant': 'FFEEF0F3',
};
const FLAG_TEXT: Record<string, string> = {
  SIGN_CONFLICT: 'Vorzeichen prüfen',
  AMBIGUOUS: 'mehrdeutig',
  CURRENCY_MISMATCH: 'Fremdwährung',
  DATE_MISMATCH: 'Stichtag weicht ab',
  OCR_SOURCE: 'aus Scan (Texterkennung)',
  LOW_SPECIFICITY: 'kleiner Betrag ohne Kontext',
};

export function reportFileName(mandate: string, closingDate: string | null): string {
  const safe = mandate.replace(/[<>:"/\\|?*]/g, '_').trim();
  return `Saldenabstimmung_${safe}_${closingDate ?? 'ohne-Stichtag'}.xlsx`;
}

/** Pfad der Diagnose-Datei zum Excel-Bericht. */
export const diagnosticsPathFor = (excelPath: string) => excelPath.replace(/\.xlsx$/i, '_Diagnose.txt');

/**
 * Freier Dateiname für den Bericht im Zielordner (legt den Ordner bei Bedarf an).
 * Ein bestehender Bericht – evtl. mit Einträgen der Prüferin/des Prüfers oder gerade in Excel geöffnet –
 * wird nie überschrieben: Folgeläufe erhalten „ (2)“, „ (3)“ …
 */
export async function uniqueReportPath(dir: string, mandate: string, closingDate: string | null): Promise<string> {
  await mkdir(dir, { recursive: true });
  const base = reportFileName(mandate, closingDate).replace(/\.xlsx$/, '');
  const exists = (p: string) => stat(p).then(() => true, () => false);
  for (let n = 1; n < 10_000; n++) {
    const candidate = path.join(dir, n === 1 ? `${base}.xlsx` : `${base} (${n}).xlsx`);
    const taken = (await exists(candidate)) || (await exists(diagnosticsPathFor(candidate)));
    if (!taken) return candidate;
  }
  throw new Error('Kein freier Dateiname für den Bericht gefunden.');
}

const isoToDate = (iso: string | null) => (iso ? new Date(`${iso}T00:00:00Z`) : null);

function header(ws: ExcelJS.Worksheet, cols: { name: string; width: number }[], greenFrom?: number, greenTo = 99): void {
  ws.columns = cols.map(c => ({ header: c.name, width: c.width }));
  const row = ws.getRow(1);
  row.height = 32;
  row.eachCell((cell, i) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: greenFrom && i >= greenFrom && i <= greenTo ? GREEN_HDR : BLUE } };
    cell.alignment = { wrapText: true, vertical: 'middle' };
  });
  ws.views = [{ state: 'frozen', ySplit: 1, xSplit: cols.length > 8 ? 2 : 0 }];
}

function colorRule(ws: ExcelJS.Worksheet, ref: string, values: string[]): void {
  ws.addConditionalFormatting({
    ref,
    rules: values.map((v, i) => ({
      type: 'cellIs', operator: 'equal', formulae: [`"${v}"`], priority: i + 1,
      style: { fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: FILL[v] } } },
    })),
  });
}

function listValidation(ws: ExcelJS.Worksheet, col: string, from: number, to: number, values: string[]): void {
  for (let r = from; r <= to; r++) {
    ws.getCell(`${col}${r}`).dataValidation = { type: 'list', allowBlank: true, formulae: [`"${values.join(',')}"`], showErrorMessage: true, errorTitle: 'Ungültiger Wert', error: 'Bitte einen Wert aus der Liste wählen.' };
  }
}

function pageLabel(d: DocumentSummary | undefined, page: number): string | number {
  if (!d) return page;
  return d.doc.pageLabels[page] ?? page;
}

function suggestion(r: AccountResult, group: string | null): string {
  if (r.status === 'PRUEFEN') return r.reasons.join(' ');
  const g = (group ?? '').toLowerCase();
  if (g.includes('flüssige')) return 'Kontoauszug bzw. Kassenprotokoll per Stichtag einholen.';
  if (g.includes('forderungen')) return 'Debitorenliste (OP-Liste) per Stichtag oder Saldobestätigung einholen.';
  if (g.includes('verbindlichkeiten')) return 'Kreditorenliste (OP-Liste) per Stichtag oder Saldobestätigung einholen.';
  if (g.includes('rückstellungen') || g.includes('abgrenzungen')) return 'Berechnung / Nachweis der Abgrenzung bzw. Rückstellung einholen.';
  if (g.includes('kapital') || g.includes('reserven')) return 'Handelsregisterauszug / GV-Protokoll prüfen.';
  if (g.includes('sachanlagen') || g.includes('finanzanlagen')) return 'Anlagenverzeichnis bzw. Depot-/Darlehensnachweis per Stichtag einholen.';
  if (g.includes('vorräte')) return 'Inventar per Stichtag einholen.';
  return 'Nachweis per Stichtag einholen.';
}

export async function writeExcelReport(res: RunResult, filePath: string): Promise<void> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Balance Scout';
  wb.created = new Date();
  const docBy = new Map(res.documents.map(d => [d.doc.id, d]));
  const N = res.accounts.length;
  const S = 'Saldenabstimmung';

  // ---------------- Übersicht ----------------
  const ov = wb.addWorksheet('Übersicht', { pageSetup: { orientation: 'landscape', paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
  ov.columns = [{ width: 52 }, { width: 46 }, { width: 34 }];
  ov.getCell('A1').value = 'Saldenabstimmung – Dokumentationsübersicht';
  ov.getCell('A1').font = { bold: true, size: 16, color: { argb: BLUE } };
  ov.getCell('A2').value = 'Erstellt mit Balance Scout (lokale Prüf-Engine, ohne KI)';
  ov.getCell('A2').font = { italic: true, color: { argb: 'FF6B7385' } };
  const meta: [string, ExcelJS.CellValue, string?][] = [
    ['Mandat', res.input.mandate],
    ['Kunde', res.input.client ?? ''],
    ['Bilanzstichtag', isoToDate(res.input.closingDate), DATE],
    ['Saldobilanz (Datei)', (res.input.trialBalancePaths?.length ? res.input.trialBalancePaths : [res.input.trialBalancePath]).map(p => path.basename(p)).join('; ')],
    ['Kontonummern', res.input.accountDigits ? `${res.input.accountDigits.min === res.input.accountDigits.max ? res.input.accountDigits.min : `${res.input.accountDigits.min}–${res.input.accountDigits.max}`} Ziffern (übrige Zeilen ausgeblendet: ${res.trialBalance?.excluded.length ?? 0})` : 'alle Zeilen mit Kontonummer'],
    ['Belegordner', res.input.evidencePaths.join('; ')],
    ['Zielordner', res.input.targetDir ?? '–'],
    ['Erstellt am', res.finishedAt, 'dd.mm.yyyy hh:mm'],
    ['Erstellt durch', 'Balance Scout – automatische Vorbereitung'],
    ['Verantwortliche Prüferin / Prüfer', ''],
    ['Regelwerk', `${res.match.summary.engineVersion}, Toleranz CHF ${(res.match.summary.params.absoluteToleranceCents / 100).toFixed(2)}`],
  ];
  meta.forEach(([k, v, fmt], i) => {
    const r = 4 + i;
    ov.getCell(`A${r}`).value = k;
    ov.getCell(`A${r}`).font = { bold: true };
    const c = ov.getCell(`B${r}`);
    c.value = v;
    if (fmt) c.numFmt = fmt;
    c.border = { bottom: { style: 'thin', color: { argb: 'FFD0D4DA' } } };
  });
  let r = 4 + meta.length + 1;
  ov.getCell(`A${r}`).value = 'Kennzahlen';
  ov.getCell(`A${r}`).font = { bold: true, size: 12, color: { argb: BLUE } };
  r++;
  const last = N + 1;
  const statusCount = (s: string) => res.match.results.filter(x => STATUS_LABEL[x.status] === s).length;
  const scope = res.match.results.filter(x => x.status !== 'NICHT_IM_UMFANG');
  const sumScope = scope.reduce((a, x) => a + Math.abs(x.balance), 0) / 100;
  const sumOk = res.match.results.filter(x => x.status === 'BELEGT').reduce((a, x) => a + Math.abs(x.balance), 0) / 100;
  const total = res.accounts.reduce((a, x) => a + x.balanceCurrentYear, 0) / 100;
  const kpis: [string, string, number, string][] = [
    ['Konten total', `COUNTA('${S}'!A2:A${last})`, N, '0'],
    ['Konten im Prüfumfang', `COUNTA('${S}'!A2:A${last})-COUNTIF('${S}'!F2:F${last},"Nicht im Umfang")`, scope.length, '0'],
    ...Object.values(STATUS_LABEL).map(s => [`Status: ${s}`, `COUNTIF('${S}'!F2:F${last},"${s}")`, statusCount(s), '0'] as [string, string, number, string]),
    ['Summe |Saldo| im Prüfumfang (CHF)', `SUMPRODUCT(ABS('${S}'!E2:E${last})*('${S}'!F2:F${last}<>"Nicht im Umfang"))`, sumScope, CHF],
    ['Summe |Saldo| Belegt (CHF)', `SUMPRODUCT(ABS('${S}'!E2:E${last})*('${S}'!F2:F${last}="Belegt"))`, sumOk, CHF],
  ];
  const rowOf: Record<string, number> = {};
  for (const [k, f, v, fmt] of kpis) {
    rowOf[k] = r;
    ov.getCell(`A${r}`).value = k;
    ov.getCell(`B${r}`).value = { formula: f, result: v };
    ov.getCell(`B${r}`).numFmt = fmt;
    ov.getCell(`B${r}`).font = { bold: true };
    r++;
  }
  const rs = rowOf['Summe |Saldo| im Prüfumfang (CHF)'];
  const rb = rowOf['Summe |Saldo| Belegt (CHF)'];
  ov.getCell(`A${r}`).value = 'Abdeckung (Belegt / Prüfumfang)';
  ov.getCell(`B${r}`).value = { formula: `IF(B${rs}=0,"",B${rb}/B${rs})`, result: sumScope ? sumOk / sumScope : 0 };
  ov.getCell(`B${r}`).numFmt = '0.0%';
  ov.getCell(`B${r}`).font = { bold: true };
  r++;
  ov.getCell(`A${r}`).value = 'Kontrolle Soll = Haben (Summe aller Salden, soll 0)';
  ov.getCell(`B${r}`).value = { formula: `SUM('${S}'!E2:E${last})`, result: total };
  ov.getCell(`B${r}`).numFmt = CHF;
  ov.getCell(`B${r}`).font = { bold: true };
  ov.getCell(`C${r}`).value = { formula: `IF(ABS(B${r})<0.005,"✓ ausgeglichen","✗ Differenz – Saldobilanz prüfen")`, result: Math.abs(total) < 0.005 ? '✓ ausgeglichen' : '✗ Differenz – Saldobilanz prüfen' };
  r++;
  ov.getCell(`A${r}`).value = 'Prüfer-Entscheide erfasst';
  ov.getCell(`B${r}`).value = { formula: `COUNTA('${S}'!O2:O${last})`, result: res.review ? res.review.manual.size + Object.keys(res.review.decisions.notes ?? {}).length : 0 };
  r++;
  ov.getCell(`A${r}`).value = 'Belege total / zugeordnet / nicht zugeordnet';
  ov.getCell(`B${r}`).value = `${res.documents.length} / ${res.documents.filter(d => d.assigned).length} / ${res.documents.filter(d => !d.assigned).length}`;
  r++;
  ov.getCell(`A${r}`).value = 'Davon mit Texterkennung (Scans)';
  ov.getCell(`B${r}`).value = res.documents.filter(d => d.doc.ocrPages > 0).length;
  r += 2;
  ov.getCell(`A${r}`).value = 'Prüfung der Saldobilanz';
  ov.getCell(`A${r}`).font = { bold: true, size: 12, color: { argb: BLUE } };
  r++;
  for (const c of res.validation.checks) {
    ov.getCell(`A${r}`).value = `${c.passed ? '✓' : '✗'} ${c.name}`;
    ov.getCell(`A${r}`).font = { color: { argb: c.passed ? 'FF1D7A46' : 'FFB3261E' } };
    ov.getCell(`B${r}`).value = c.message;
    ov.getCell(`B${r}`).alignment = { wrapText: true };
    r++;
  }
  for (const i of res.validation.issues.slice(0, 30)) {
    ov.getCell(`A${r}`).value = `${i.severity === 'error' ? 'Fehler' : 'Hinweis'} Zeile ${i.rowIndex}`;
    ov.getCell(`B${r}`).value = i.message;
    ov.getCell(`B${r}`).alignment = { wrapText: true };
    r++;
  }
  r++;
  ov.getCell(`A${r}`).value = 'Hinweis: Automatische Vorbereitung – Fundstellen und Status sind durch die Prüferin/den Prüfer zu verifizieren (grüne Spalten im Blatt Saldenabstimmung).';
  ov.getCell(`A${r}`).font = { italic: true, color: { argb: 'FF6B7385' } };
  ov.getCell(`A${r}`).alignment = { wrapText: true };
  ov.mergeCells(`A${r}:C${r}`);
  ov.getRow(r).height = 32;
  ov.getCell('B6').numFmt = DATE;

  // ---------------- Saldenabstimmung ----------------
  const ws = wb.addWorksheet(S, { pageSetup: { orientation: 'landscape', paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
  header(ws, [
    { name: 'Konto', width: 10 }, { name: 'Bezeichnung', width: 32 }, { name: 'Klasse', width: 7 },
    { name: 'Saldo Vorjahr CHF', width: 16 }, { name: 'Saldo Stichtag CHF', width: 16 }, { name: 'Status (automatisch)', width: 15 },
    { name: 'Datei (Beleg)', width: 32 }, { name: 'Link / Ablageort', width: 38 }, { name: 'Seite', width: 10 },
    { name: 'Fundstelle (Wortlaut)', width: 46 }, { name: 'Wert im Beleg', width: 15 }, { name: 'Differenz CHF', width: 13 },
    { name: 'Stichtag Beleg', width: 12 }, { name: 'Bemerkung (automatisch)', width: 44 },
    { name: 'Prüfer-Entscheid', width: 15 }, { name: 'Kommentar Prüfer', width: 40 }, { name: 'Visum', width: 8 }, { name: 'Datum', width: 11 },
    { name: 'Register', width: 9 }, { name: 'Gruppe (KMU-Kontenrahmen)', width: 34 },
  ], 15, 18);
  const rv = res.review;
  res.accounts.forEach((a, i) => {
    const row = i + 2;
    const m = res.byAccount.get(`${a.accountNumber}#${a.rowIndex}`)!;
    const b = m.best;
    const d = b ? docBy.get(b.documentId) : undefined;
    const link = d?.placement?.newRelPath ?? d?.doc.absPath ?? null;
    const notes = [
      ...(b ? b.flags.map(f => FLAG_TEXT[f] ?? f) : []),
      ...(m.status === 'PRUEFEN' || m.status === 'KEIN_NACHWEIS' || rv?.manual.has(a.accountNumber) ? m.reasons : []),
      ...(m.candidates.length > 1 ? [`weitere Fundstellen: ${m.candidates.slice(1, 4).map(c => `${c.filename} S.${c.page}`).join(', ')}`] : []),
    ];
    const values: ExcelJS.CellValue[] = [
      a.accountNumber, a.accountName, a.accountNumber.charAt(0),
      a.balancePreviousYear === null ? null : a.balancePreviousYear / 100, a.balanceCurrentYear / 100,
      STATUS_LABEL[m.status], b?.filename ?? null,
      link ? { text: link, hyperlink: link.replace(/\\/g, '/') } : null,
      b ? pageLabel(d, b.page) : null, b?.line ?? null,
      b && Number.isFinite(b.evidenceCents) ? b.evidenceCents / 100 : null, null,
      isoToDate(d?.balanceDate ?? null), notes.join(' · ') || null,
    ];
    values.forEach((v, c) => (ws.getCell(row, c + 1).value = v));
    // Entscheide der Prüferin / des Prüfers (grüne Spalten)
    const acc = rv?.decisions.accepted?.[a.accountNumber];
    const asg = rv?.manual.get(a.accountNumber) === 'zugeordnet' ? Object.values(rv.decisions.assignments ?? {}).find(x => x.accountNumber === a.accountNumber) : undefined;
    const note = rv?.decisions.notes?.[a.accountNumber];
    const who = acc ?? asg ?? note;
    if (rv?.manual.has(a.accountNumber)) ws.getCell(row, 15).value = 'Bestätigt';
    const comment = [rv?.manual.get(a.accountNumber) === 'akzeptiert' ? `Manuell akzeptiert${acc?.comment ? `: ${acc.comment}` : ''}` : '', asg ? 'Beleg manuell zugeordnet' : '', note?.text ? `Notiz: ${note.text}` : ''].filter(Boolean).join(' · ');
    if (comment) ws.getCell(row, 16).value = comment;
    if (who && (rv?.manual.has(a.accountNumber) || note)) {
      ws.getCell(row, 17).value = who.visum || null;
      ws.getCell(row, 18).value = isoToDate(who.at.slice(0, 10));
    }
    ws.getCell(row, 19).value = b ? rv?.registers.get(b.documentId) ?? null : null;
    ws.getCell(row, 20).value = a.groupName ? `${a.groupName}${a.groupSource === 'bezeichnung' ? ' (aus Bezeichnung)' : ''}` : null;
    const hasDiff = b && Number.isFinite(b.evidenceCents);
    ws.getCell(row, 12).value = hasDiff
      ? { formula: `IF(OR(K${row}="",E${row}=""),"",ROUND(ABS(K${row})-ABS(E${row}),2))`, result: Math.round(Math.abs(b!.evidenceCents) - Math.abs(a.balanceCurrentYear)) / 100 }
      : { formula: `IF(OR(K${row}="",E${row}=""),"",ROUND(ABS(K${row})-ABS(E${row}),2))`, result: '' };
    for (const c of [4, 5, 11, 12]) ws.getCell(row, c).numFmt = CHF;
    ws.getCell(row, 13).numFmt = DATE;
    ws.getCell(row, 18).numFmt = DATE;
    for (const c of [2, 10, 14, 16]) ws.getCell(row, c).alignment = { wrapText: true, vertical: 'top' };
  });
  const lastRow = Math.max(N + 1, 2);
  listValidation(ws, 'F', 2, lastRow, Object.values(STATUS_LABEL));
  listValidation(ws, 'O', 2, lastRow, ['Bestätigt', 'Abweichung', 'Offen', 'Nicht anwendbar']);
  colorRule(ws, `F2:F${lastRow}`, Object.values(STATUS_LABEL));
  colorRule(ws, `O2:O${lastRow}`, ['Bestätigt', 'Abweichung', 'Offen', 'Nicht anwendbar']);
  ws.addConditionalFormatting({ ref: `L2:L${lastRow}`, rules: [{ type: 'expression', priority: 1, formulae: ['AND(L2<>"",ABS(L2)>=0.005)'], style: { font: { color: { argb: 'FFB3261E' }, bold: true } } }] });
  ws.addConditionalFormatting({ ref: `M2:M${lastRow}`, rules: [{ type: 'expression', priority: 1, formulae: ['AND(M2<>"",Übersicht!$B$6<>"",M2<>Übersicht!$B$6)'], style: { font: { color: { argb: 'FFB3261E' }, bold: true } } }] });
  ws.autoFilter = { from: 'A1', to: { row: lastRow, column: 20 } };

  // ---------------- Offene Punkte ----------------
  const op = wb.addWorksheet('Offene Punkte', { pageSetup: { orientation: 'landscape', paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
  header(op, [
    { name: 'Konto', width: 10 }, { name: 'Bezeichnung', width: 32 }, { name: 'Status (automatisch)', width: 15 },
    { name: 'Was fehlt / abzuklären', width: 70 }, { name: 'Verantwortlich', width: 18 }, { name: 'Termin', width: 12 },
    { name: 'Erledigt', width: 10 }, { name: 'Erledigt am', width: 12 },
  ]);
  let orow = 2;
  for (const a of res.accounts) {
    const m = res.byAccount.get(`${a.accountNumber}#${a.rowIndex}`)!;
    if (m.status !== 'PRUEFEN' && m.status !== 'KEIN_NACHWEIS') continue;
    op.getRow(orow).values = [a.accountNumber, a.accountName, STATUS_LABEL[m.status], suggestion(m, a.groupName)];
    op.getCell(`D${orow}`).alignment = { wrapText: true, vertical: 'top' };
    op.getCell(`F${orow}`).numFmt = DATE;
    op.getCell(`H${orow}`).numFmt = DATE;
    orow++;
  }
  colorRule(op, `C2:C${Math.max(orow, 2)}`, ['Prüfen', 'Kein Nachweis']);
  listValidation(op, 'G', 2, Math.max(orow + 20, 3), ['Ja', 'Nein']);

  // ---------------- Belegverzeichnis (Excel-Tabelle tblBelege) ----------------
  const bv = wb.addWorksheet('Belegverzeichnis', { pageSetup: { orientation: 'landscape', paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
  const bcols = ['Datei', 'Quellpfad', 'Belegart', 'Stichtag', 'Gelesen', 'Texterkennung', 'Zugeordnete Konten', 'Zielordner', 'Zieldateiname', 'Bemerkung', 'Neuer Ablageort', 'Abgelegt am', 'Register'];
  [34, 50, 18, 12, 11, 14, 20, 17, 34, 40, 44, 16, 9].forEach((w, i) => (bv.getColumn(i + 1).width = w));
  const gelesen = (d: DocumentSummary) => (d.doc.status === 'ok' ? 'Ja' : d.doc.status === 'partial' ? 'Teilweise' : 'Nein');
  const rows = res.documents.map(d => [
    d.doc.filename,
    d.doc.relPath,
    d.docType,
    isoToDate(d.balanceDate),
    gelesen(d),
    d.doc.ocrPages ? `${d.doc.ocrPages} S., ${d.doc.ocrConfidence ?? '–'} %` : '–',
    d.assignedAccounts.map(a => (a === '@allgemein' ? 'Allgemeine Prüfungen' : a)).join(', '),
    d.assigned ? 'Zugeordnet' : rv?.irrelevant.has(d.doc.id) ? 'Nicht relevant' : 'Nicht zugeordnet',
    d.targetName,
    [...d.doc.warnings, rv?.decisions.assignments?.[d.doc.id] ? `manuell ${rv.decisions.assignments[d.doc.id]!.accountNumber ? 'zugeordnet' : 'als nicht relevant markiert'} (${rv.decisions.assignments[d.doc.id]!.visum})` : '', d.notePlacement?.newRelPath ? `Notiz: ${d.notePlacement.newRelPath}` : '', d.placement?.status === 'fehler' ? `Ablage fehlgeschlagen: ${d.placement.message}` : d.placement?.status === 'bereits vorhanden' ? 'bereits im Zielordner vorhanden' : ''].filter(Boolean).join(' · '),
    d.placement?.newRelPath ?? '',
    d.placement?.at ?? null,
    rv?.registers.get(d.doc.id) ?? '',
  ]);
  bv.addTable({
    name: 'tblBelege',
    ref: 'A1',
    headerRow: true,
    style: { theme: 'TableStyleMedium2', showRowStripes: true },
    columns: bcols.map(name => ({ name, filterButton: true })),
    rows: rows.length ? rows : [bcols.map(() => '')],
  });
  for (let i = 2; i <= rows.length + 1; i++) {
    bv.getCell(`D${i}`).numFmt = DATE;
    bv.getCell(`L${i}`).numFmt = 'dd.mm.yyyy hh:mm';
    bv.getCell(`J${i}`).alignment = { wrapText: true, vertical: 'top' };
    const rel = bv.getCell(`K${i}`).value;
    if (typeof rel === 'string' && rel) bv.getCell(`K${i}`).value = { text: rel, hyperlink: rel };
  }
  bv.views = [{ state: 'frozen', ySplit: 1, xSplit: 1 }];
  colorRule(bv, `H2:H${rows.length + 1}`, ['Zugeordnet', 'Nicht zugeordnet', 'Nicht relevant']);

  // ---------------- Anleitung ----------------
  const an = wb.addWorksheet('Anleitung');
  an.getColumn(1).width = 120;
  [
    'Saldenabstimmung – Anleitung',
    '1. Erstellt durch Balance Scout (lokale Prüf-Engine). Es wurden keine Daten an Dritte übermittelt.',
    '2. Eine Zeile pro Konto der Saldobilanz. "Datei (Beleg)" = massgebender Beleg, "Link / Ablageort" = abgelegte Kopie (relativ zu diesem Excel).',
    '3. Spalten A–N sind automatisch. Spalten O–R (grün) füllt ausschliesslich die Prüferin / der Prüfer.',
    '4. Status "Belegt" nur bei exaktem Betrag mit ausreichendem Kontext (z. B. Saldo-Begriff, Kontonummer, Bilanzstichtag im Beleg) und ohne Warnhinweis.',
    '   Beträge aus Scans (Texterkennung) sind immer "Prüfen" – Betrag mit dem Original vergleichen.',
    '5. Differenz = |Wert im Beleg| − |Saldo Stichtag|. Rot = Differenz ≠ 0. Stichtag Beleg rot = weicht vom Bilanzstichtag ab.',
    '6. Belegverzeichnis: alle gefundenen Dateien inkl. Unterordner; Ablage in 01_Zugeordnet, 02_Nicht_zugeordnet bzw. 03_Nicht_relevant.',
    '7. Register (z. B. B.1): Buchstabe der Gruppe im KMU-Kontenrahmen + laufende Nummer; so beginnen auch die abgelegten Dateinamen. Notizen der Prüferin/des Prüfers stehen als erste Seite im PDF bzw. als separates Notiz-PDF.',
    'Hinweis: Automatische Vorbereitung – Fundstellen und Status sind durch die Prüferin/den Prüfer zu verifizieren.',
  ].forEach((t, i) => {
    const c = an.getCell(`A${i + 1}`);
    c.value = t;
    c.alignment = { wrapText: true, vertical: 'top' };
    if (i === 0) c.font = { bold: true, size: 14, color: { argb: BLUE } };
  });

  for (const sh of [ws, op, bv]) sh.headerFooter.oddFooter = '&C&A – Seite &P von &N&RBalance Scout';
  await mkdir(path.dirname(filePath), { recursive: true });
  const buf = Buffer.from(await wb.xlsx.writeBuffer());
  try {
    await writeFile(filePath, buf, { flag: 'wx' }); // nie überschreiben
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`Der Bericht ${path.basename(filePath)} existiert bereits und wird nicht überschrieben.`);
    }
    throw e;
  }
}
