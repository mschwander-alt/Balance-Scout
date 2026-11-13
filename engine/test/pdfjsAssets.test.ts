/** pdf.js-Ressourcen werden mitgeliefert und an pdf.js übergeben (Vorschau unabhängig von Systemschriften) */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pdfjsOptions } from '../src/ingest/pdfjsAssets.js';
import { renderPreview } from '../src/preview.js';

describe('pdf.js-Ressourcen', () => {
  const o = pdfjsOptions() as Record<string, string | boolean>;

  it('Pfade gesetzt, mit „/“ am Ende, Dateien vorhanden', () => {
    for (const [k, f] of [['standardFontDataUrl', 'LiberationSans-Regular.ttf'], ['standardFontDataUrl', 'FoxitFixed.pfb'], ['cMapUrl', 'UniJIS-UCS2-H.bcmap'], ['wasmUrl', 'openjpeg.wasm'], ['wasmUrl', 'jbig2.wasm']] as const) {
      const dir = o[k] as string;
      expect(dir, k).toMatch(/\/$/);
      expect(existsSync(path.join(dir, f)), `${k}: ${f}`).toBe(true);
    }
    expect(o.useSystemFonts).toBe(false);
    expect(o.useWorkerFetch).toBe(false);
    expect(typeof o.BinaryDataFactory).toBe('function');
  });

  it('gleiche pdf.js-Version wie in unpdf (sonst passen Schriften/Decoder nicht)', () => {
    const bundled = /apiVersion:`([\d.]+)`/.exec(readFileSync(path.resolve(import.meta.dirname, '..', 'node_modules', 'unpdf', 'dist', 'pdfjs.mjs'), 'utf8'))?.[1];
    const readme = readFileSync(path.resolve(import.meta.dirname, '..', 'pdfjs', 'README.md'), 'utf8');
    expect(readme).toContain(`pdfjs-dist@${bundled}`);
  });

  it('Navision-Liste mit nicht eingebetteten Schriften wird gerendert', async () => {
    const p = await renderPreview(path.resolve(import.meta.dirname, 'fixtures', 'op', 'OP_BusinessCentral.pdf'), 1);
    expect(p.kind).toBe('image');
  });

  it('pdfjs-dist in derselben Version wie unpdf (vollständiges pdf.js mit Bilddecodern)', () => {
    const bundled = /apiVersion:`([\d.]+)`/.exec(readFileSync(path.resolve(import.meta.dirname, '..', 'node_modules', 'unpdf', 'dist', 'pdfjs.mjs'), 'utf8'))?.[1];
    const pkg = JSON.parse(readFileSync(path.resolve(import.meta.dirname, '..', 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
    expect(pkg.dependencies['pdfjs-dist']).toBe(bundled);
  });

  it('1-Bit-Scan mit CCITT-Fax-Kompression (Bank-/Kopierer-Scan) wird nicht weiss gezeichnet', async () => {
    const p = await renderPreview(path.resolve(import.meta.dirname, 'fixtures', 'scan', 'Scan_CCITT_G4.pdf'), 1);
    expect(p.kind).toBe('image');
    if (p.kind !== 'image') return;
    const { loadImage, createCanvas } = await import('@napi-rs/canvas');
    const img = await loadImage(Buffer.from(p.dataUrl.split(',')[1]!, 'base64'));
    const c = createCanvas(img.width, img.height);
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, img.width, img.height).data;
    let dark = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i]! < 128) dark++;
    // 40 Textzeilen: rund 4 % dunkle Pixel (vorher 0 % – Decoder nicht geladen)
    expect(dark / (d.length / 4)).toBeGreaterThan(0.02);
  });

  it('Texterkennung liest den CCITT-Scan', async () => {
    const { readDocument } = await import('../src/ingest/readDocument.js');
    const { LocalOcr } = await import('../src/ingest/ocr.js');
    const ocr = new LocalOcr();
    try {
      const doc = await readDocument(path.resolve(import.meta.dirname, 'fixtures', 'scan', 'Scan_CCITT_G4.pdf'), 'Scan_CCITT_G4.pdf', { ocr });
      expect(doc.lines.map(l => l.text).join('\n')).toMatch(/880.000\.00/);
    } finally { await ocr.close(); }
  }, 120_000);

  it('Engine-Paket liefert den Ordner aus', () => {
    const pkg = JSON.parse(readFileSync(path.resolve(import.meta.dirname, '..', 'package.json'), 'utf8')) as { files: string[] };
    expect(pkg.files).toContain('pdfjs');
  });
});
