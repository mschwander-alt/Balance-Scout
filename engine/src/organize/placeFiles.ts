import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type FileMode = 'copy' | 'move' | 'none';
export const ASSIGNED_DIR = '01_Zugeordnet';
export const UNASSIGNED_DIR = '02_Nicht_zugeordnet';

export interface PlacementPlan {
  docId: string;
  absPath: string;
  relPath: string;
  sha256: string;
  assigned: boolean;
  targetName: string;
  /** Unterordner statt 01/02 (z. B. für „nicht relevant“) */
  subDir?: string;
  /** Abzulegender Inhalt statt der Originaldatei (z. B. PDF mit vorangestellter Notiz) */
  content?: Buffer;
  /** Neu erzeugte Datei ohne Original (z. B. Notiz-PDF) – beim Verschieben nichts löschen */
  generated?: boolean;
}

export interface PlacementResult {
  docId: string;
  newPath: string | null; // absolut
  newRelPath: string | null; // relativ zum Zielordner (für Excel-Links)
  status: 'kopiert' | 'verschoben' | 'bereits vorhanden' | 'nicht abgelegt' | 'fehler';
  message?: string;
  at: Date | null;
}

/** Eindeutige Zieldateinamen: bei gleichen Namen aus verschiedenen Unterordnern Unterordner voranstellen. */
export function planTargetNames(items: { docId: string; relPath: string }[]): Map<string, string> {
  const byName = new Map<string, string[]>();
  for (const it of items) {
    const name = path.posix.basename(it.relPath);
    byName.set(name.toLowerCase(), [...(byName.get(name.toLowerCase()) ?? []), it.docId]);
  }
  const used = new Set<string>();
  const out = new Map<string, string>();
  for (const it of items) {
    const name = path.posix.basename(it.relPath);
    let target = name;
    if ((byName.get(name.toLowerCase())?.length ?? 0) > 1) {
      const dir = path.posix.dirname(it.relPath);
      const prefix = dir === '.' ? '' : dir.split('/').filter(Boolean).join('_');
      target = sanitize(prefix ? `${prefix}_${name}` : name);
    }
    target = sanitize(target);
    let candidate = target;
    let i = 2;
    while (used.has(candidate.toLowerCase())) {
      const ext = path.extname(target);
      candidate = `${target.slice(0, target.length - ext.length)} (${i++})${ext}`;
    }
    used.add(candidate.toLowerCase());
    out.set(it.docId, candidate);
  }
  return out;
}

function sanitize(name: string): string {
  return name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 180) || 'unbenannt';
}

/**
 * Legt die Belege im Zielordner ab. Überschreibt nie: existiert eine gleichnamige Datei mit
 * gleichem Inhalt -> "bereits vorhanden"; mit anderem Inhalt -> Nummer anhängen.
 */
export async function placeFiles(targetDir: string, plans: PlacementPlan[], mode: FileMode): Promise<PlacementResult[]> {
  if (mode === 'none') return plans.map(p => ({ docId: p.docId, newPath: null, newRelPath: null, status: 'nicht abgelegt', at: null }));
  await mkdir(path.join(targetDir, ASSIGNED_DIR), { recursive: true });
  await mkdir(path.join(targetDir, UNASSIGNED_DIR), { recursive: true });
  for (const sd of new Set(plans.map(p => p.subDir).filter((x): x is string => !!x))) await mkdir(path.join(targetDir, sd), { recursive: true });
  const results: PlacementResult[] = [];
  for (const p of plans) {
    const sub = p.subDir ?? (p.assigned ? ASSIGNED_DIR : UNASSIGNED_DIR);
    const wantSha = p.content ? createHash('sha256').update(p.content).digest('hex') : p.sha256;
    try {
      let name = p.targetName;
      let dest = path.join(targetDir, sub, name);
      let n = 2;
      let already = false;
      for (;;) {
        const exists = await stat(dest).then(() => true, () => false);
        if (!exists) break;
        const sha = createHash('sha256').update(await readFile(dest)).digest('hex');
        if (sha === wantSha) {
          already = true;
          break;
        }
        const ext = path.extname(p.targetName);
        name = `${p.targetName.slice(0, p.targetName.length - ext.length)} (${n++})${ext}`;
        dest = path.join(targetDir, sub, name);
      }
      const rel = `${sub}/${name}`;
      if (already) {
        results.push({ docId: p.docId, newPath: dest, newRelPath: rel, status: 'bereits vorhanden', at: new Date() });
        if (mode === 'move' && !p.generated) await unlink(p.absPath).catch(() => undefined);
        continue;
      }
      if (p.content) {
        await writeFile(dest, p.content, { flag: 'wx' });
        if (mode === 'move' && !p.generated) await unlink(p.absPath);
        results.push({ docId: p.docId, newPath: dest, newRelPath: rel, status: mode === 'move' && !p.generated ? 'verschoben' : 'kopiert', at: new Date() });
      } else if (mode === 'copy') {
        await copyFile(p.absPath, dest, constants.COPYFILE_EXCL);
        results.push({ docId: p.docId, newPath: dest, newRelPath: rel, status: 'kopiert', at: new Date() });
      } else {
        try {
          await rename(p.absPath, dest);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
          await copyFile(p.absPath, dest, constants.COPYFILE_EXCL);
          await unlink(p.absPath);
        }
        results.push({ docId: p.docId, newPath: dest, newRelPath: rel, status: 'verschoben', at: new Date() });
      }
    } catch (e) {
      results.push({ docId: p.docId, newPath: null, newRelPath: null, status: 'fehler', message: (e as Error).message, at: null });
    }
  }
  return results;
}
