import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';

export interface NoteEntry {
  accountNumber: string;
  accountName: string;
  text: string;
  visum: string;
  at: string; // ISO
}

export interface NoteHeader {
  mandate: string;
  closingDate: string | null;
  register: string | null; // z. B. "B.1"
  documentName: string;
}

const A4: [number, number] = [595.28, 841.89];
const fmtDate = (iso: string | null) => (iso ? iso.slice(0, 10).split('-').reverse().join('.') : '–');

/** Zeichen, die die Standardschrift nicht kennt, ersetzen (statt abzubrechen). */
function safe(font: PDFFont, t: string): string {
  let out = '';
  for (const ch of t.replace(/\t/g, '    ')) {
    try {
      font.encodeText(ch);
      out += ch;
    } catch {
      out += ch === '–' || ch === '—' ? '-' : '?';
    }
  }
  return out;
}

function wrap(font: PDFFont, size: number, text: string, width: number): string[] {
  const lines: string[] = [];
  for (const para of text.split(/\r?\n/)) {
    let cur = '';
    for (const word of para.split(/ +/)) {
      const next = cur ? `${cur} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) <= width) cur = next;
      else {
        if (cur) lines.push(cur);
        // sehr lange Wörter hart umbrechen
        let w = word;
        while (font.widthOfTextAtSize(w, size) > width) {
          let n = w.length;
          while (n > 1 && font.widthOfTextAtSize(w.slice(0, n), size) > width) n--;
          lines.push(w.slice(0, n));
          w = w.slice(n);
        }
        cur = w;
      }
    }
    lines.push(cur);
  }
  return lines;
}

/** Fügt Notizseite(n) in ein PDF-Dokument ein (am Anfang). */
async function addNotePages(doc: PDFDocument, header: NoteHeader, notes: NoteEntry[], at = 0): Promise<number> {
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const margin = 56;
  const width = A4[0] - 2 * margin;
  let inserted = 0;
  let page: PDFPage = doc.insertPage(at + inserted++, A4);
  let y = A4[1] - margin;
  const newPage = () => {
    page = doc.insertPage(at + inserted++, A4);
    y = A4[1] - margin;
  };
  const line = (t: string, f: PDFFont, size: number, color = rgb(0.1, 0.1, 0.12), gap = 4) => {
    for (const l of wrap(f, size, safe(f, t), width)) {
      if (y - size < margin + 20) newPage();
      page.drawText(l, { x: margin, y: y - size, size, font: f, color });
      y -= size + gap;
    }
  };
  // Kopf
  page.drawRectangle({ x: margin, y: y - 4, width, height: 4, color: rgb(0.06, 0.37, 0.66) });
  y -= 20;
  line(`Notiz der Revisionsstelle${header.register ? ` – Register ${header.register}` : ''}`, bold, 16, rgb(0.06, 0.37, 0.66), 8);
  line(`Mandat: ${header.mandate} · Bilanzstichtag: ${fmtDate(header.closingDate)}`, font, 10, rgb(0.35, 0.38, 0.45));
  line(`Beleg: ${header.documentName}`, font, 10, rgb(0.35, 0.38, 0.45), 14);
  for (const n of notes) {
    y -= 6;
    line(`Konto ${n.accountNumber} ${n.accountName}`, bold, 12, rgb(0.1, 0.1, 0.12), 6);
    line(n.text, font, 11, rgb(0.1, 0.1, 0.12), 4);
    line(`Visum ${n.visum || '–'} · ${fmtDate(n.at)}`, font, 9, rgb(0.42, 0.45, 0.52), 10);
  }
  // Fuss auf allen Notizseiten
  for (let i = 0; i < inserted; i++) {
    doc.getPage(at + i).drawText(safe(font, 'Erstellt mit Balance Scout – Notiz der Prüferin / des Prüfers, kein Bestandteil des Originalbelegs.'), {
      x: margin, y: 30, size: 8, font, color: rgb(0.5, 0.52, 0.58),
    });
  }
  return inserted;
}

/** Eigenständiges Notiz-PDF (für Excel-, Word- und Bilddateien). */
export async function notePdf(header: NoteHeader, notes: NoteEntry[]): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Notiz ${header.register ?? ''} ${header.documentName}`.trim());
  doc.setProducer('Balance Scout');
  await addNotePages(doc, header, notes);
  return Buffer.from(await doc.save());
}

/**
 * Stellt die Notiz einem bestehenden PDF voran. Gibt null zurück, wenn das PDF nicht verändert werden kann
 * (verschlüsselt, beschädigt) – dann wird stattdessen ein separates Notiz-PDF abgelegt.
 */
export async function prependNote(original: Buffer, header: NoteHeader, notes: NoteEntry[]): Promise<Buffer | null> {
  try {
    const doc = await PDFDocument.load(original, { updateMetadata: false });
    if (doc.isEncrypted) return null;
    await addNotePages(doc, header, notes, 0);
    return Buffer.from(await doc.save());
  } catch {
    return null;
  }
}
