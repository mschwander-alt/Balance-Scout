import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import Papa from 'papaparse';
import type { LocalOcr } from './ocr.js';

export interface EvidenceLine {
  page: number; // 1-basiert (bei Excel: Blatt-Nr.; eingebettete Bilder als zusätzliche "Seiten")
  lineNo: number;
  text: string;
  /** 'text-layer' (exakt gelesen) oder 'ocr' (Texterkennung) */
  source?: string;
  /** Erkennungssicherheit 0–100 (nur OCR) */
  confidence?: number;
}

export type ReadStatus = 'ok' | 'partial' | 'unreadable' | 'unsupported' | 'error';

export interface EvidenceDocument {
  id: string; // stabil: Hash des relativen Pfads
  absPath: string;
  relPath: string; // relativ zum gewählten Wurzelordner, mit '/'
  filename: string;
  ext: string;
  size: number;
  sha256: string;
  pageCount: number;
  method: 'pdf' | 'image' | 'excel' | 'xls' | 'csv' | 'text' | 'word' | 'none';
  ocrPages: number;
  ocrConfidence: number | null; // Mittelwert der OCR-Seiten
  status: ReadStatus;
  warnings: string[];
  lines: EvidenceLine[];
  /** Seitenbezeichnung für Excel-Blätter/Bilder, z. B. "Blatt 'OP-Liste'" */
  pageLabels: Record<number, string>;
}

export const SUPPORTED = ['.pdf', '.xlsx', '.xlsm', '.xls', '.csv', '.txt', '.docx', '.png', '.jpg', '.jpeg', '.tif', '.tiff', '.bmp', '.webp'];
const IGNORE = /^(~\$|\.~lock|\.DS_Store$|Thumbs\.db$|desktop\.ini$|\._)/i;

export interface ScanOptions {
  /** Ordner, die übersprungen werden (z. B. der Zielordner, falls innerhalb) */
  excludeDirs?: string[];
  maxFileBytes?: number;
}

/** Listet alle Dateien rekursiv; meldet nicht unterstützte Dateien ebenfalls (für das Belegverzeichnis). */
export async function listFiles(root: string, opts: ScanOptions = {}): Promise<{ absPath: string; relPath: string }[]> {
  const out: { absPath: string; relPath: string }[] = [];
  const excl = (opts.excludeDirs ?? []).map(d => path.resolve(d));
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name, 'de'));
    for (const e of entries) {
      if (IGNORE.test(e.name)) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (excl.some(x => abs === x || abs.startsWith(x + path.sep))) continue;
        await walk(abs);
      } else if (e.isFile()) {
        out.push({ absPath: abs, relPath: path.relative(root, abs).split(path.sep).join('/') });
      }
    }
  }
  await walk(root);
  return out;
}

export interface ReadContext {
  ocr: LocalOcr;
  /** Texterkennung für Seiten mit weniger Zeichen als diesem Wert */
  minCharsPerPage?: number;
  maxOcrPages?: number;
  onProgress?: (msg: string) => void;
}

export async function readDocument(absPath: string, relPath: string, ctx: ReadContext, maxBytes = 100 * 1024 * 1024): Promise<EvidenceDocument> {
  const st = await stat(absPath);
  const filename = path.basename(absPath);
  const ext = path.extname(filename).toLowerCase();
  const base: EvidenceDocument = {
    id: createHash('sha1').update(relPath).digest('hex').slice(0, 12),
    absPath, relPath, filename, ext, size: st.size, sha256: '', pageCount: 0, method: 'none',
    ocrPages: 0, ocrConfidence: null, status: 'ok', warnings: [], lines: [], pageLabels: {},
  };
  if (!SUPPORTED.includes(ext)) {
    base.status = 'unsupported';
    base.warnings.push(`Dateityp ${ext || '(ohne Endung)'} wird nicht ausgewertet.`);
    return base;
  }
  if (st.size > maxBytes) {
    base.status = 'unsupported';
    base.warnings.push(`Datei grösser als ${Math.round(maxBytes / 1024 / 1024)} MB – übersprungen.`);
    return base;
  }
  const buf = await readFile(absPath);
  base.sha256 = createHash('sha256').update(buf).digest('hex');
  try {
    if (ext === '.pdf') await readPdf(buf, base, ctx);
    else if (['.png', '.jpg', '.jpeg', '.tif', '.tiff', '.bmp', '.webp'].includes(ext)) await readImage(buf, base, ctx);
    else if (ext === '.xlsx' || ext === '.xlsm') await readXlsx(buf, base, ctx);
    else if (ext === '.xls') await readXls(buf, base);
    else if (ext === '.csv') readCsv(buf, base);
    else if (ext === '.txt') readText(buf, base);
    else if (ext === '.docx') await readDocx(buf, base);
  } catch (e) {
    base.status = 'error';
    base.warnings.push(`Datei konnte nicht gelesen werden: ${(e as Error).message}`);
  }
  if (base.status === 'ok' && base.lines.length === 0) {
    base.status = 'unreadable';
    base.warnings.push('Kein lesbarer Text gefunden.');
  }
  const ocrConf = base.lines.filter(l => l.source === 'ocr' && l.confidence !== undefined).map(l => l.confidence!);
  if (ocrConf.length) {
    base.ocrConfidence = Math.round(ocrConf.reduce((a, b) => a + b, 0) / ocrConf.length);
    if (base.ocrConfidence < 60) {
      base.status = base.status === 'ok' ? 'partial' : base.status;
      base.warnings.push(`Texterkennung unsicher (${base.ocrConfidence} %) – Beträge mit Original vergleichen.`);
    }
  }
  return base;
}

// ---------------------------------------------------------------- PDF
async function readPdf(buf: Buffer, doc: EvidenceDocument, ctx: ReadContext): Promise<void> {
  const { getDocumentProxy, renderPageAsImage, createIsomorphicCanvasFactory } = await import('unpdf');
  doc.method = 'pdf';
  // Zeichenfläche ausdrücklich aus Node (@napi-rs/canvas): pdf.js hält sich im Electron-Hintergrundprozess
  // sonst für einen Browser und scheitert beim Rendern von Scan-Seiten.
  const CanvasFactory = await createIsomorphicCanvasFactory(() => import('@napi-rs/canvas'));
  const pdf = await getDocumentProxy(new Uint8Array(buf), { CanvasFactory } as never);
  doc.pageCount = pdf.numPages;
  const minChars = ctx.minCharsPerPage ?? 40;
  const maxOcr = ctx.maxOcrPages ?? 30;
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const tc = await page.getTextContent();
    const rows: { y: number; items: { x: number; s: string }[] }[] = [];
    let chars = 0;
    for (const it of tc.items as Array<{ str?: string; transform?: number[] }>) {
      if (!it.str?.trim() || !it.transform) continue;
      const x = it.transform[4] ?? 0;
      const y = it.transform[5] ?? 0;
      let row = rows.find(r => Math.abs(r.y - y) < 3);
      if (!row) rows.push((row = { y, items: [] }));
      row.items.push({ x, s: it.str });
      chars += it.str.trim().length;
    }
    if (chars >= minChars) {
      rows.sort((a, b) => b.y - a.y);
      let n = 0;
      for (const r of rows) {
        const text = r.items.sort((a, b) => a.x - b.x).map(i => i.s).join(' ').replace(/\s+/g, ' ').trim();
        if (text) doc.lines.push({ page: p, lineNo: ++n, text, source: 'text-layer' });
      }
      continue;
    }
    // Seite ohne Textebene (Scan) -> Texterkennung
    if (doc.ocrPages >= maxOcr) {
      doc.warnings.push(`Seite ${p}: nicht erkannt (mehr als ${maxOcr} Scan-Seiten).`);
      doc.status = 'partial';
      continue;
    }
    ctx.onProgress?.(`Texterkennung ${doc.filename}, Seite ${p}/${pdf.numPages}`);
    const png = await renderPageAsImage(pdf, p, { canvasImport: () => import('@napi-rs/canvas'), scale: 2.5 });
    const r = await ctx.ocr.recognize(Buffer.from(png));
    doc.ocrPages++;
    r.lines.forEach((l, i) => doc.lines.push({ page: p, lineNo: i + 1, text: l.text, source: 'ocr', confidence: l.confidence }));
  }
}

// ---------------------------------------------------------------- Bilder
async function readImage(buf: Buffer, doc: EvidenceDocument, ctx: ReadContext): Promise<void> {
  doc.method = 'image';
  doc.pageCount = 1;
  ctx.onProgress?.(`Texterkennung ${doc.filename}`);
  const r = await ctx.ocr.recognize(buf);
  doc.ocrPages = 1;
  r.lines.forEach((l, i) => doc.lines.push({ page: 1, lineNo: i + 1, text: l.text, source: 'ocr', confidence: l.confidence }));
}

// ---------------------------------------------------------------- Excel (xlsx/xlsm), alle Blätter + eingebettete Bilder
// SheetJS liest Zellen robust (auch Dateien anderer Programme); Bilder direkt aus dem ZIP (xl/media).
async function readXlsx(buf: Buffer, doc: EvidenceDocument, ctx: ReadContext): Promise<void> {
  await readXls(buf, doc);
  doc.method = 'excel';
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(buf);
  const media = Object.keys(zip.files).filter(n => /^xl\/media\/.+\.(png|jpe?g|bmp|tiff?|gif)$/i.test(n)).sort();
  let page = doc.pageCount;
  for (const name of media) {
    const img = await zip.file(name)!.async('nodebuffer');
    if (img.length < 2000) continue; // Logos/Icons überspringen
    page++;
    doc.pageLabels[page] = `Bild ${name.split('/').pop()}`;
    ctx.onProgress?.(`Texterkennung Bild in ${doc.filename}`);
    const r = await ctx.ocr.recognize(img);
    doc.ocrPages++;
    r.lines.forEach((l, i) => doc.lines.push({ page, lineNo: i + 1, text: l.text, source: 'ocr', confidence: l.confidence }));
  }
  doc.pageCount = page;
}

/** Zahl ohne Gleitkomma-Artefakte; ganze Zahlen ohne Nachkommastellen, sonst 2 Stellen */
export function numberText(n: number): string {
  if (!Number.isFinite(n)) return '';
  if (Number.isInteger(n)) return String(n);
  return (Math.round(n * 100) / 100).toFixed(2);
}

function dateText(d: Date): string {
  return `${String(d.getUTCDate()).padStart(2, '0')}.${String(d.getUTCMonth() + 1).padStart(2, '0')}.${d.getUTCFullYear()}`;
}

// ---------------------------------------------------------------- Excel 97–2003 (.xls)
async function readXls(buf: Buffer, doc: EvidenceDocument): Promise<void> {
  doc.method = 'xls';
  const XLSX = await import('xlsx');
  const wb = XLSX.read(buf, { type: 'buffer', cellDates: true });
  let page = 0;
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    if (!ws) continue;
    if (wb.Workbook?.Sheets?.find(x => x.name === name)?.Hidden) continue; // ausgeblendete Blätter überspringen
    page++;
    doc.pageLabels[page] = `Blatt '${name}'`;
    const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true, blankrows: false });
    rows.forEach((row, i) => {
      const cells = row
        .map(c => (typeof c === 'number' ? numberText(c) : c instanceof Date ? dateText(c) : c === null || c === undefined ? '' : String(c).trim()))
        .filter(Boolean);
      if (cells.length) doc.lines.push({ page, lineNo: i + 1, text: cells.join(' | '), source: 'text-layer' });
    });
  }
  doc.pageCount = page;
}

// ---------------------------------------------------------------- CSV / Text / Word
function decodeText(buf: Buffer): string {
  let t = buf.toString('utf8');
  if (t.includes('\uFFFD')) t = buf.toString('latin1');
  return t.replace(/^\uFEFF/, '');
}

function readCsv(buf: Buffer, doc: EvidenceDocument): void {
  doc.method = 'csv';
  doc.pageCount = 1;
  const res = Papa.parse<string[]>(decodeText(buf), { delimiter: '', skipEmptyLines: true });
  res.data.forEach((r, i) => {
    const cells = r.map(c => c.trim()).filter(Boolean);
    if (cells.length) doc.lines.push({ page: 1, lineNo: i + 1, text: cells.join(' | '), source: 'text-layer' });
  });
}

function readText(buf: Buffer, doc: EvidenceDocument): void {
  doc.method = 'text';
  doc.pageCount = 1;
  decodeText(buf).split(/\r?\n/).forEach((t, i) => {
    if (t.trim()) doc.lines.push({ page: 1, lineNo: i + 1, text: t.trim(), source: 'text-layer' });
  });
}

async function readDocx(buf: Buffer, doc: EvidenceDocument): Promise<void> {
  doc.method = 'word';
  doc.pageCount = 1;
  const mammoth = await import('mammoth');
  const { value } = await mammoth.extractRawText({ buffer: buf });
  value.split(/\r?\n/).forEach((t, i) => {
    if (t.trim()) doc.lines.push({ page: 1, lineNo: i + 1, text: t.trim(), source: 'text-layer' });
  });
}
