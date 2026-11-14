import { readFile } from 'node:fs/promises';
import path from 'node:path';
import Papa from 'papaparse';
import { numberText } from './ingest/readDocument.js';
import { loadPdfjs, pdfjsOptions } from './ingest/pdfjsAssets.js';

export type Preview =
  | { kind: 'image'; dataUrl: string; width: number; height: number; page: number; pageCount: number; pageLabel?: string }
  | { kind: 'table'; rows: string[][]; page: number; pageCount: number; pageLabel?: string; truncated: boolean }
  | { kind: 'text'; lines: string[]; page: number; pageCount: number }
  | { kind: 'unsupported'; message: string; page: number; pageCount: number };

const MAX_ROWS = 3000;
const IMAGE_WIDTH = 1300;

/**
 * Vorschau einer Belegseite für die App. Zeilennummern entsprechen exakt denen der Prüfung
 * (gleiche Lesart), damit die Fundstelle markiert werden kann.
 */
export async function renderPreview(absPath: string, page: number): Promise<Preview> {
  const ext = path.extname(absPath).toLowerCase();
  const buf = await readFile(absPath);
  if (ext === '.pdf') return pdfPage(buf, page);
  if (['.png', '.jpg', '.jpeg', '.bmp', '.webp', '.gif', '.tif', '.tiff'].includes(ext)) return image(buf, 1, 1);
  if (ext === '.xlsx' || ext === '.xlsm' || ext === '.xls') return excel(buf, page, ext !== '.xls');
  if (ext === '.csv') {
    let t = buf.toString('utf8');
    if (t.includes('\uFFFD')) t = buf.toString('latin1');
    const res = Papa.parse<string[]>(t.replace(/^\uFEFF/, ''), { delimiter: '', skipEmptyLines: true });
    return { kind: 'table', rows: res.data.slice(0, MAX_ROWS).map(r => r.map(c => c.trim())), page: 1, pageCount: 1, truncated: res.data.length > MAX_ROWS };
  }
  if (ext === '.txt') return { kind: 'text', lines: decode(buf).split(/\r?\n/).slice(0, MAX_ROWS), page: 1, pageCount: 1 };
  if (ext === '.docx') {
    const mammoth = await import('mammoth');
    const { value } = await mammoth.extractRawText({ buffer: buf });
    return { kind: 'text', lines: value.split(/\r?\n/).slice(0, MAX_ROWS), page: 1, pageCount: 1 };
  }
  return { kind: 'unsupported', message: `Für ${ext || 'diese Datei'} gibt es keine Vorschau – bitte „Beleg öffnen“.`, page: 1, pageCount: 1 };
}

function decode(buf: Buffer): string {
  const t = buf.toString('utf8');
  return (t.includes('\uFFFD') ? buf.toString('latin1') : t).replace(/^\uFEFF/, '');
}

async function pdfPage(buf: Buffer, page: number): Promise<Preview> {
  const { getDocumentProxy, renderPageAsImage, createIsomorphicCanvasFactory } = await loadPdfjs();
  const CanvasFactory = await createIsomorphicCanvasFactory(() => import('@napi-rs/canvas'));
  const pdf = await getDocumentProxy(new Uint8Array(buf), { CanvasFactory, ...pdfjsOptions() } as never);
  const n = pdf.numPages;
  const p = Math.min(Math.max(1, page), n);
  const png = await renderPageAsImage(pdf, p, { canvasImport: () => import('@napi-rs/canvas'), width: IMAGE_WIDTH });
  const { loadImage } = await import('@napi-rs/canvas');
  const b = Buffer.from(png);
  const img = await loadImage(b);
  return { kind: 'image', dataUrl: `data:image/png;base64,${b.toString('base64')}`, width: img.width, height: img.height, page: p, pageCount: n };
}

async function image(buf: Buffer, page: number, pageCount: number, pageLabel?: string): Promise<Preview> {
  const { createCanvas, loadImage } = await import('@napi-rs/canvas');
  let img;
  try {
    img = await loadImage(buf);
  } catch {
    return { kind: 'unsupported', message: 'Dieses Bildformat kann nicht in der Vorschau angezeigt werden – bitte „Beleg öffnen“.', page, pageCount };
  }
  const scale = Math.min(1, IMAGE_WIDTH / img.width);
  const w = Math.round(img.width * scale);
  const h = Math.round(img.height * scale);
  const c = createCanvas(w, h);
  c.getContext('2d').drawImage(img, 0, 0, w, h);
  const png = c.toBuffer('image/png');
  return { kind: 'image', dataUrl: `data:image/png;base64,${png.toString('base64')}`, width: w, height: h, page, pageCount, pageLabel };
}

/** Gleiche Blatt- und Zeilenlogik wie beim Lesen (sichtbare Blätter, leere Zeilen ausgelassen, danach eingefügte Bilder). */
async function excel(buf: Buffer, page: number, withImages: boolean): Promise<Preview> {
  const XLSX = await import('xlsx');
  const wb = XLSX.read(buf, { type: 'buffer', cellDates: true });
  const sheets = wb.SheetNames.filter(n => wb.Sheets[n] && !wb.Workbook?.Sheets?.find(x => x.name === n)?.Hidden);
  let media: string[] = [];
  let zip: import('jszip') | null = null;
  if (withImages) {
    const JSZip = (await import('jszip')).default;
    zip = await JSZip.loadAsync(buf);
    const all = Object.keys(zip.files).filter(n => /^xl\/media\/.+\.(png|jpe?g|bmp|tiff?|gif)$/i.test(n)).sort();
    media = [];
    for (const m of all) if ((await zip.file(m)!.async('nodebuffer')).length >= 2000) media.push(m);
  }
  const pageCount = sheets.length + media.length;
  const p = Math.min(Math.max(1, page), Math.max(1, pageCount));
  if (p > sheets.length && zip) {
    const name = media[p - sheets.length - 1]!;
    return image(await zip.file(name)!.async('nodebuffer'), p, pageCount, `Bild ${name.split('/').pop()}`);
  }
  const name = sheets[p - 1];
  if (!name) return { kind: 'unsupported', message: 'Leere Arbeitsmappe.', page: 1, pageCount: 1 };
  const raw = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name]!, { header: 1, raw: true, blankrows: false });
  const rows = raw.slice(0, MAX_ROWS).map(r =>
    Array.from(r, c =>
      typeof c === 'number' ? numberText(c) : c instanceof Date ? `${String(c.getUTCDate()).padStart(2, '0')}.${String(c.getUTCMonth() + 1).padStart(2, '0')}.${c.getUTCFullYear()}` : c === null || c === undefined ? '' : String(c),
    ),
  );
  return { kind: 'table', rows, page: p, pageCount, pageLabel: `Blatt '${name}'`, truncated: raw.length > MAX_ROWS };
}
