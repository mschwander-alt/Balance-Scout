import type { LocalOcr } from '../../ingest/ocr.js';
import type { Grid } from './parser.js';
import { pdfjsOptions } from '../../ingest/pdfjsAssets.js';

/** Textstück mit horizontaler Lage (relativ zur Seitenbreite, 0–1) */
interface Token {
  text: string;
  x0: number;
  x1: number;
}
type Line = Token[];

const AMOUNT_RX = /^[-−–(]?\s?(CHF\s?)?[\d'’ .,]+[)-]?$/;
const isAmountLike = (t: string) => AMOUNT_RX.test(t.trim()) && /\d/.test(t);

/**
 * Saldobilanz als PDF -> Tabelle (Grid).
 * Text-PDF: Textstücke mit Position; Scan: Wörter der Texterkennung mit Position.
 * Spalten werden aus der Lage rekonstruiert (untereinander stehende Beträge = eine Spalte).
 */
export async function pdfToGrid(buffer: Buffer, ocr?: LocalOcr): Promise<{ grid: Grid; ocrPages: number }> {
  const { getDocumentProxy, renderPageAsImage, createIsomorphicCanvasFactory } = await import('unpdf');
  const CanvasFactory = await createIsomorphicCanvasFactory(() => import('@napi-rs/canvas'));
  const pdf = await getDocumentProxy(new Uint8Array(buffer), { CanvasFactory, ...pdfjsOptions() } as never);
  const lines: Line[] = [];
  let ocrPages = 0;
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const [vx0 = 0, , vx1 = 595] = (page as unknown as { view: number[] }).view ?? [];
    const pw = vx1 - vx0 || 1;
    const tc = await page.getTextContent();
    const items = (tc.items as Array<{ str?: string; transform?: number[]; width?: number }>).filter(i => i.str?.trim() && i.transform);
    if (items.reduce((a, i) => a + i.str!.trim().length, 0) >= 40) {
      const rows: { y: number; toks: Token[] }[] = [];
      for (const it of items) {
        const y = it.transform![5] ?? 0;
        const x0 = ((it.transform![4] ?? 0) - vx0) / pw;
        let row = rows.find(r => Math.abs(r.y - y) < 3);
        if (!row) rows.push((row = { y, toks: [] }));
        row.toks.push({ text: it.str!, x0, x1: x0 + (it.width ?? 0) / pw });
      }
      rows.sort((a, b) => b.y - a.y);
      for (const r of rows) lines.push(r.toks.sort((a, b) => a.x0 - b.x0));
    } else if (ocr) {
      // Scan: Wörter mit Position aus der Texterkennung
      const png = await renderPageAsImage(pdf, p, { canvasImport: () => import('@napi-rs/canvas'), scale: 2.5 });
      const r = await ocr.recognize(Buffer.from(png));
      ocrPages++;
      for (const l of r.lines) {
        if (l.words?.length) lines.push(l.words.map(w => ({ text: w.text, x0: w.bbox.x0, x1: w.bbox.x1 })));
      }
    }
  }
  return { grid: linesToGrid(lines), ocrPages };
}

/** Zeilen mit positionierten Textstücken -> Tabelle mit rekonstruierten Spalten */
export function linesToGrid(lines: Line[]): Grid {
  // 1. Pro Zeile Textstücke zu Zellen verbinden (kleiner Abstand = gleiche Zelle)
  const rows: Token[][] = lines.map(toks => {
    const cells: Token[] = [];
    for (const t of toks) {
      const prev = cells[cells.length - 1];
      const gap = prev ? t.x0 - prev.x1 : Infinity;
      // Beträge nie mit Text verbinden; sonst bei Lücke < ~1,5 Zeichen zusammenführen
      if (prev && gap < 0.012 && isAmountLike(prev.text) === isAmountLike(t.text)) {
        prev.text = `${prev.text}${gap > 0.002 ? ' ' : ''}${t.text}`;
        prev.x1 = Math.max(prev.x1, t.x1);
      } else cells.push({ ...t });
    }
    // Kontonummer, die mit der Bezeichnung zu einer Zelle verschmolzen ist, abtrennen ("1020 Bank UBS")
    const first = cells[0];
    const m = first ? /^(\d{3,6})\s+(\D.*)$/.exec(first.text.trim()) : null;
    if (first && m) {
      const share = (m[1]!.length + 1) / first.text.length;
      const split = first.x0 + (first.x1 - first.x0) * share;
      cells.splice(0, 1, { text: m[1]!, x0: first.x0, x1: split - 0.002 }, { text: m[2]!, x0: split, x1: first.x1 });
    }
    return cells;
  });

  // 2. Spalten aus überlappenden Zellen bilden (über alle Seiten)
  const cols: { x0: number; x1: number }[] = [];
  const overlap = (a: { x0: number; x1: number }, b: { x0: number; x1: number }) => Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  // Spalten nur aus Datenzeilen bilden (mind. 2 Zellen, mind. ein Betrag) – Titel, Überschriften
  // und Seitenfüsse würden sonst Spalten verschmelzen. Zuerst Beträge, dann Text.
  const body = rows.filter(r => r.length >= 2 && r.some(c => isAmountLike(c.text)));
  const allCells = body.flat().sort((a, b) => Number(isAmountLike(b.text)) - Number(isAmountLike(a.text)));
  for (const c of allCells) {
    const w = Math.max(0.005, c.x1 - c.x0);
    let best = -1;
    let bestOv = 0;
    cols.forEach((col, i) => {
      const ov = overlap(c, col) / Math.min(w, col.x1 - col.x0 || w);
      if (ov > bestOv) {
        bestOv = ov;
        best = i;
      }
    });
    if (best >= 0 && bestOv > 0.3) {
      const col = cols[best]!;
      // Textzellen erweitern Zahlenspalten nicht (lange Überschriften sollen keine Nachbarspalte schlucken)
      if (!isAmountLike(c.text) && cols.some((o, i) => i !== best && overlap({ x0: Math.min(col.x0, c.x0), x1: Math.max(col.x1, c.x1) }, o) > 0)) continue;
      col.x0 = Math.min(col.x0, c.x0);
      col.x1 = Math.max(col.x1, c.x1);
    } else cols.push({ x0: c.x0, x1: c.x1 });
  }
  // überlappende Spalten zusammenführen, nach Lage sortieren
  cols.sort((a, b) => a.x0 - b.x0);
  const merged: { x0: number; x1: number }[] = [];
  for (const c of cols) {
    const last = merged[merged.length - 1];
    if (last && overlap(last, c) > 0.25 * Math.min(last.x1 - last.x0, c.x1 - c.x0)) last.x1 = Math.max(last.x1, c.x1);
    else merged.push({ ...c });
  }

  // 3. Jede Zelle der Spalte mit der grössten Überlappung (sonst der nächsten) zuordnen
  return rows.map(cells => {
    const out: (string | null)[] = merged.map(() => null);
    for (const c of cells) {
      let idx = 0;
      let best = -Infinity;
      merged.forEach((col, i) => {
        const ov = overlap(c, col);
        const score = ov > 0 ? ov : -Math.min(Math.abs(c.x0 - col.x1), Math.abs(col.x0 - c.x1));
        if (score > best) {
          best = score;
          idx = i;
        }
      });
      out[idx] = out[idx] ? `${out[idx]} ${c.text}` : c.text;
    }
    return out;
  });
}
