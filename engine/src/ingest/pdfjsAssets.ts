/**
 * Ressourcen für pdf.js (Ersatzschriften, CMaps, Bilddecoder), mit der Engine ausgeliefert (Ordner `pdfjs/`).
 * So sehen Vorschau und Texterkennung überall gleich aus – auch bei PDFs mit nicht eingebetteten Schriften
 * (Navision, Abacus, Bankauszüge) oder JBIG2/JPEG2000-Scans.
 *
 * Wichtig: In der App läuft die Engine in einem Electron-Hilfsprozess (`utilityProcess`). Dort hält sich pdf.js
 * nicht für Node.js und würde die Dateien wie ein Browser per `fetch` laden – das scheitert mit Dateipfaden.
 * Deshalb liest ein eigener Lader die Dateien direkt mit `fs`, und pdf.js zeichnet Schriften selbst (ohne FontFace).
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// src/ingest/ bzw. dist/ingest/ → <engine>/pdfjs
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'pdfjs');
const DIRS = { cMapUrl: 'cmaps', standardFontDataUrl: 'standard_fonts', wasmUrl: 'wasm' } as const;
// pdf.js prüft, dass die Angaben mit „/“ enden
const dir = (name: string) => `${path.join(ROOT, name).replace(/\\/g, '/')}/`;

/** Lader für pdf.js 6 (`BinaryDataFactory`): liest Schriften, CMaps und Decoder aus `pdfjs/` */
class FsBinaryDataFactory {
  async fetch({ kind, filename }: { kind: keyof typeof DIRS; filename: string }): Promise<Uint8Array> {
    const sub = DIRS[kind];
    // nur Dateinamen aus dem eigenen Ordner (keine Pfade aus dem PDF)
    if (!sub || filename.includes('/') || filename.includes('\\') || filename.includes('..')) throw new Error(`pdf.js-Ressource nicht erlaubt: ${kind}/${filename}`);
    return new Uint8Array(readFileSync(path.join(ROOT, sub, filename)));
  }
}

export const pdfjsAssetsAvailable = () => existsSync(path.join(ROOT, 'standard_fonts'));

export function pdfjsOptions(): Record<string, unknown> {
  if (!pdfjsAssetsAvailable()) return {};
  return {
    cMapUrl: dir(DIRS.cMapUrl),
    cMapPacked: true,
    standardFontDataUrl: dir(DIRS.standardFontDataUrl),
    wasmUrl: dir(DIRS.wasmUrl),
    BinaryDataFactory: FsBinaryDataFactory,
    // Daten über den Lader oben (nicht per fetch im Worker)
    useWorkerFetch: false,
    // Ersatzschriften aus `standard_fonts` statt Systemschriften; Schriften als Umrisse zeichnen (kein FontFace nötig)
    useSystemFonts: false,
    disableFontFace: true,
  };
}

let pdfjsReady: Promise<typeof import('unpdf')> | null = null;
/**
 * unpdf mit dem vollständigen pdf.js (`pdfjs-dist`, gleiche Version wie in unpdf).
 * Die in unpdf eingebaute Serverless-Variante lädt keine Bilddecoder: CCITT-Fax- und JBIG2-Scans (1-Bit, typisch für
 * Bank- und Kopierer-Scans) sowie JPEG 2000 blieben in Vorschau und Texterkennung weiss.
 * Der Worker läuft im selben Prozess (`globalThis.pdfjsWorker`) – im Electron-Hilfsprozess gibt es keinen Web-Worker.
 */
export function loadPdfjs(): Promise<typeof import('unpdf')> {
  pdfjsReady ??= (async () => {
    const unpdf = await import('unpdf');
    try {
      const workerPath: string = 'pdfjs-dist/legacy/build/pdf.worker.mjs';
      const worker: unknown = await import(workerPath);
      (globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = worker;
      await unpdf.definePDFJSModule(() => import('pdfjs-dist/legacy/build/pdf.mjs'));
    } catch {
      // pdfjs-dist fehlt: eingebaute Variante (ohne Bilddecoder) verwenden
    }
    return unpdf;
  })();
  return pdfjsReady;
}
