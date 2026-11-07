import type { AiImage } from '../../ai/types.js';

/** Rendert PDF-Seiten als PNG (für Texterkennung durch Vision-Modelle). */
export async function renderPdfPages(buffer: Buffer, maxPages: number, scale = 2): Promise<AiImage[]> {
  const { getDocumentProxy, renderPageAsImage } = await import('unpdf');
  const doc = await getDocumentProxy(new Uint8Array(buffer));
  const n = Math.min(doc.numPages, maxPages);
  const out: AiImage[] = [];
  for (let p = 1; p <= n; p++) {
    const png = await renderPageAsImage(doc, p, { canvasImport: () => import('@napi-rs/canvas'), scale });
    out.push({ mimeType: 'image/png', base64: Buffer.from(png).toString('base64'), label: `Seite ${p}` });
  }
  return out;
}

export function imageFromUpload(buffer: Buffer, filename: string): AiImage | null {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.png')) return { mimeType: 'image/png', base64: buffer.toString('base64') };
  if (/\.jpe?g$/.test(lower)) return { mimeType: 'image/jpeg', base64: buffer.toString('base64') };
  return null;
}
