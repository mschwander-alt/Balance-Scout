import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface OcrLine {
  text: string;
  confidence: number; // 0–100
  /** Lage relativ zur Bildgrösse (0–1) */
  bbox?: { x0: number; y0: number; x1: number; y1: number };
}

export interface OcrOptions {
  /** Ordner mit deu.traineddata.gz / eng.traineddata.gz (wird mit der App ausgeliefert) */
  langPath?: string;
  cachePath?: string;
  languages?: string[];
}

type Worker = Awaited<ReturnType<typeof import('tesseract.js')['createWorker']>>;

/**
 * Lokale Texterkennung (Tesseract, WebAssembly). Läuft vollständig offline auf dem PC;
 * es werden keine Daten übertragen. Ein Worker wird wiederverwendet.
 */
export class LocalOcr {
  private worker: Promise<Worker> | null = null;
  constructor(private readonly opts: OcrOptions = {}) {}

  private get(): Promise<Worker> {
    if (!this.worker) {
      this.worker = (async () => {
        const { createWorker } = await import('tesseract.js');
        const langPath = this.opts.langPath ?? defaultLangPath();
        const languages = this.opts.languages ?? ['deu', 'eng'];
        // Sprachdaten werden als lokaler Zwischenspeicher bereitgestellt (Datei <sprache>.traineddata, gzip).
        // Die Bibliothek liest den Zwischenspeicher immer zuerst direkt von der Festplatte –
        // dadurch ist kein Netzwerkzugriff nötig, auch nicht in Electron.
        for (const code of languages) {
          try {
            await readFile(path.join(langPath, `${code}.traineddata`));
          } catch {
            throw new Error(`Sprachdaten für Texterkennung fehlen: ${path.join(langPath, `${code}.traineddata`)}`);
          }
        }
        return createWorker(languages, 1, {
          cachePath: langPath,
          cacheMethod: 'readOnly',
          langPath: 'file:///nicht-verwenden', // wird nie benötigt (Zwischenspeicher hat Vorrang)
          gzip: true,
          logger: () => undefined,
          errorHandler: (e: unknown) => console.error('Texterkennung:', e),
        });
      })();
      // fehlgeschlagene Initialisierung nicht zwischenspeichern
      this.worker.catch(() => (this.worker = null));
    }
    return this.worker;
  }

  /**
   * Erkennt Text. Bei unsicherem Ergebnis (< 75 %) zweiter Versuch mit aufbereitetem Bild
   * (vergrössert, Graustufen, Kontrast gestreckt); das sicherere Ergebnis zählt.
   */
  async recognize(image: Buffer): Promise<{ lines: OcrLine[]; confidence: number }> {
    const first = await this.recognizeRaw(image);
    if (first.confidence >= 75) return first;
    try {
      let best = first;
      for (const bin of [true, false]) {
        const r = await this.recognizeRaw(await enhanceForOcr(image, bin));
        if (r.confidence > best.confidence) best = r;
        if (best.confidence >= 75) break;
      }
      return best;
    } catch {
      return first;
    }
  }

  private async recognizeRaw(image: Buffer): Promise<{ lines: OcrLine[]; confidence: number }> {
    const w = await this.get();
    const r = await w.recognize(image, {}, { blocks: true, text: true });
    const { width, height } = await imageSize(image);
    const lines: OcrLine[] = [];
    for (const b of r.data.blocks ?? []) {
      for (const p of b.paragraphs ?? []) {
        for (const l of p.lines ?? []) {
          const text = l.text.replace(/\s+/g, ' ').trim();
          if (!text) continue;
          const bb = l.bbox;
          lines.push({
            text,
            confidence: l.confidence,
            bbox: bb && width && height ? { x0: bb.x0 / width, y0: bb.y0 / height, x1: bb.x1 / width, y1: bb.y1 / height } : undefined,
          });
        }
      }
    }
    return { lines, confidence: r.data.confidence };
  }

  async close(): Promise<void> {
    if (this.worker) {
      const w = await this.worker;
      await w.terminate();
      this.worker = null;
    }
  }
}

export function defaultLangPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..', 'tessdata');
}

/**
 * Bildaufbereitung für schlechte Scans/Fotos:
 * 1. auf ca. 2400 px Breite skalieren, 2. Graustufen, 3. Medianfilter (entfernt Pixelrauschen),
 * 4. Kontrast strecken, 5. optional Schwarz-Weiss nach Otsu.
 */
export async function enhanceForOcr(image: Buffer, binarize = true): Promise<Buffer> {
  const { createCanvas, loadImage } = await import('@napi-rs/canvas');
  const img = await loadImage(image);
  // 1. Graustufen in Originalgrösse
  const w0 = img.width, h0 = img.height;
  const c0 = createCanvas(w0, h0);
  const x0 = c0.getContext('2d');
  x0.drawImage(img, 0, 0);
  const d0 = x0.getImageData(0, 0, w0, h0);
  let gray: Uint8Array = new Uint8Array(w0 * h0);
  for (let i = 0, j = 0; i < d0.data.length; i += 4, j++) gray[j] = (0.299 * d0.data[i]! + 0.587 * d0.data[i + 1]! + 0.114 * d0.data[i + 2]!) | 0;
  // 2. Rauschen entfernen (vor dem Vergrössern, sonst werden Punkte zu Flecken)
  gray = median(gray, w0, h0, 1);
  // 3. Kontrast strecken
  const hist = new Uint32Array(256);
  for (const g of gray) hist[g]!++;
  const pct = (q: number) => {
    let acc = 0;
    for (let v = 0; v < 256; v++) if ((acc += hist[v]!) >= gray.length * q) return v;
    return 255;
  };
  const lo = pct(0.005);
  // Weisspunkt = typischer Hintergrund (Median): Belegseiten bestehen grösstenteils aus Hintergrund
  const hi = Math.max(lo + 1, pct(0.5));
  for (let i = 0, j = 0; j < gray.length; i += 4, j++) {
    const v = Math.max(0, Math.min(255, ((gray[j]! - lo) * 255) / (hi - lo)));
    d0.data[i] = d0.data[i + 1] = d0.data[i + 2] = v;
    d0.data[i + 3] = 255;
  }
  x0.putImageData(d0, 0, 0);
  // 4. Vergrössern auf ca. 2400 px Breite
  const scale = Math.min(3, Math.max(1, 2400 / w0));
  const w = Math.round(w0 * scale), h = Math.round(h0 * scale);
  const c1 = createCanvas(w, h);
  const x1 = c1.getContext('2d');
  x1.imageSmoothingEnabled = true;
  x1.imageSmoothingQuality = 'high';
  x1.drawImage(c0, 0, 0, w, h);
  // 5. optional Schwarz-Weiss (Otsu)
  if (binarize) {
    const d1 = x1.getImageData(0, 0, w, h);
    const g1 = new Uint8Array(w * h);
    for (let i = 0, j = 0; i < d1.data.length; i += 4, j++) g1[j] = d1.data[i]!;
    const t = otsu(g1);
    for (let i = 0, j = 0; i < d1.data.length; i += 4, j++) d1.data[i] = d1.data[i + 1] = d1.data[i + 2] = g1[j]! > t ? 255 : 0;
    x1.putImageData(d1, 0, 0);
  }
  return c1.toBuffer('image/png');
}

/** Medianfilter mit Radius r (Histogramm-basiert, schnell genug für Seitenbilder) */
function median(src: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const out = new Uint8Array(src.length);
  const size = (2 * r + 1) ** 2;
  const half = size >> 1;
  const win = new Uint8Array(size);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let n = 0;
      for (let dy = -r; dy <= r; dy++) {
        const yy = Math.min(h - 1, Math.max(0, y + dy)) * w;
        for (let dx = -r; dx <= r; dx++) win[n++] = src[yy + Math.min(w - 1, Math.max(0, x + dx))]!;
      }
      win.sort();
      out[y * w + x] = win[half]!;
    }
  }
  return out;
}

function otsu(g: Uint8Array): number {
  const hist = new Float64Array(256);
  for (const v of g) hist[v]!++;
  const total = g.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i]!;
  let sumB = 0, wB = 0, best = 0, thr = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]!;
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t]!;
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) { best = between; thr = t; }
  }
  return thr;
}

/** Bildgrösse in Pixeln (für relative Positionen der erkannten Zeilen) */
async function imageSize(image: Buffer): Promise<{ width: number; height: number }> {
  try {
    const { loadImage } = await import('@napi-rs/canvas');
    const img = await loadImage(image);
    return { width: img.width, height: img.height };
  } catch {
    return { width: 0, height: 0 };
  }
}
