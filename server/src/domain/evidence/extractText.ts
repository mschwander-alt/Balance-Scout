import { readGrid } from '../trialBalance/parser.js';

export interface EvidenceLine {
  page: number; // 1-basiert; bei Tabellen: Blatt 1
  lineNo: number; // 1-basiert
  text: string;
  /** Herkunft: Textebene (Standard) oder OCR durch KI-Anbieter, z. B. "ocr:azure-foundry" */
  source?: string;
}

export interface ExtractionResult {
  method: 'pdf-text' | 'spreadsheet' | 'plain-text' | 'none';
  lines: EvidenceLine[];
  pageCount: number;
  /** true, wenn das Dokument keine Textebene hat (Scan) und OCR/KI benötigt (Schritt 2) */
  needsOcr: boolean;
  warnings: string[];
}

/**
 * Deterministische Textgewinnung ohne KI. Gescannte PDFs und Bilder werden als
 * needsOcr markiert und in Schritt 2 durch den gewählten KI-Anbieter ausgelesen.
 */
export async function extractEvidenceText(buffer: Buffer, filename: string, mime: string): Promise<ExtractionResult> {
  const lower = filename.toLowerCase();
  if (mime === 'application/pdf' || lower.endsWith('.pdf')) return extractPdf(buffer);
  if (/\.(xlsx|xlsm|csv)$/.test(lower)) {
    const grid = await readGrid(buffer, filename);
    const lines = grid
      .map((row, i) => ({ page: 1, lineNo: i + 1, text: row.filter(c => c !== null && c !== '').map(c => (typeof c === 'number' ? formatNumberCell(c) : String(c))).join(' | ') }))
      .filter(l => l.text.trim() !== '');
    return { method: 'spreadsheet', lines, pageCount: 1, needsOcr: false, warnings: [] };
  }
  if (/\.(txt)$/.test(lower) || mime.startsWith('text/')) {
    const lines = buffer.toString('utf8').split(/\r?\n/).map((t, i) => ({ page: 1, lineNo: i + 1, text: t.trim() })).filter(l => l.text);
    return { method: 'plain-text', lines, pageCount: 1, needsOcr: false, warnings: [] };
  }
  if (mime.startsWith('image/') || /\.(png|jpe?g|tiff?|webp)$/.test(lower)) {
    return { method: 'none', lines: [], pageCount: 1, needsOcr: true, warnings: ['Bilddatei: Texterkennung (OCR/KI) erforderlich.'] };
  }
  return { method: 'none', lines: [], pageCount: 0, needsOcr: false, warnings: [`Format nicht unterstützt: ${filename}`] };
}

/** Zahlen aus Excel unverfälscht als Text (ohne Gleitkomma-Artefakte) */
function formatNumberCell(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

async function extractPdf(buffer: Buffer): Promise<ExtractionResult> {
  const { getDocumentProxy } = await import('unpdf');
  const warnings: string[] = [];
  let doc;
  try {
    doc = await getDocumentProxy(new Uint8Array(buffer));
  } catch (e) {
    return { method: 'none', lines: [], pageCount: 0, needsOcr: false, warnings: [`PDF konnte nicht gelesen werden: ${(e as Error).message}`] };
  }
  const lines: EvidenceLine[] = [];
  let charCount = 0;
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    // Textfragmente nach y-Position zu Zeilen gruppieren, innerhalb der Zeile nach x sortieren
    const rows: { y: number; items: { x: number; s: string }[] }[] = [];
    for (const it of tc.items as Array<{ str?: string; transform?: number[] }>) {
      if (!it.str || !it.transform) continue;
      const x = it.transform[4] ?? 0;
      const y = it.transform[5] ?? 0;
      let row = rows.find(r => Math.abs(r.y - y) < 2.5);
      if (!row) rows.push((row = { y, items: [] }));
      row.items.push({ x, s: it.str });
    }
    rows.sort((a, b) => b.y - a.y);
    let n = 0;
    for (const r of rows) {
      const text = r.items.sort((a, b) => a.x - b.x).map(i => i.s).join(' ').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      charCount += text.length;
      lines.push({ page: p, lineNo: ++n, text });
    }
  }
  const needsOcr = charCount < 20 * Math.max(1, doc.numPages);
  if (needsOcr) warnings.push('PDF enthält (fast) keine Textebene – vermutlich Scan. Texterkennung (OCR/KI) erforderlich.');
  return { method: 'pdf-text', lines, pageCount: doc.numPages, needsOcr, warnings };
}
