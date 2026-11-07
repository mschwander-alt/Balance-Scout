import type { FastifyRequest } from 'fastify';
import { HttpError } from '../app.js';

export interface UploadedFile {
  filename: string;
  mimetype: string;
  buffer: Buffer;
}

/** Liest alle Dateien und Textfelder eines multipart-Requests. */
export async function readMultipart(req: FastifyRequest): Promise<{ files: UploadedFile[]; fields: Record<string, string> }> {
  if (!req.isMultipart()) throw new HttpError(415, 'multipart/form-data erwartet.');
  const files: UploadedFile[] = [];
  const fields: Record<string, string> = {};
  for await (const part of req.parts()) {
    if (part.type === 'file') {
      const buffer = await part.toBuffer();
      if (part.file.truncated) throw new HttpError(413, `${part.filename} überschreitet die maximale Dateigrösse.`);
      files.push({ filename: sanitizeFilename(part.filename), mimetype: part.mimetype, buffer });
    } else {
      fields[part.fieldname] = String(part.value);
    }
  }
  return { files, fields };
}

function sanitizeFilename(n: string): string {
  return n.replace(/[\\/]/g, '_').replace(/[\u0000-\u001f]/g, '').slice(0, 255) || 'unbenannt';
}
