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

  it('Engine-Paket liefert den Ordner aus', () => {
    const pkg = JSON.parse(readFileSync(path.resolve(import.meta.dirname, '..', 'package.json'), 'utf8')) as { files: string[] };
    expect(pkg.files).toContain('pdfjs');
  });
});
