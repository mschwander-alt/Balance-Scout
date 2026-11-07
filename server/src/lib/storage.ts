import { createHash } from 'node:crypto';
import { mkdir, writeFile, readFile, access } from 'node:fs/promises';
import path from 'node:path';

/** Inhaltsadressierter Dateispeicher (SHA-256). Austauschbar gegen S3 in späteren Schritten. */
export class FileStorage {
  constructor(private readonly root: string) {}

  static sha256(buf: Buffer): string {
    return createHash('sha256').update(buf).digest('hex');
  }

  async put(buf: Buffer): Promise<{ key: string; sha256: string }> {
    const sha256 = FileStorage.sha256(buf);
    const key = `${sha256.slice(0, 2)}/${sha256}`;
    const full = path.join(this.root, key);
    try {
      await access(full);
    } catch {
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, buf, { flag: 'wx' }).catch(e => { if (e.code !== 'EEXIST') throw e; });
    }
    return { key, sha256 };
  }

  get(key: string): Promise<Buffer> {
    if (!/^[0-9a-f]{2}\/[0-9a-f]{64}$/.test(key)) throw new Error('Ungültiger Speicherschlüssel');
    return readFile(path.join(this.root, key));
  }
}
