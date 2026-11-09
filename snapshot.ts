import { readFile, writeFile } from 'node:fs/promises';
import type { RunResult } from './run.js';

/** Analyse-Stand als Datei (für den Abschluss nach der Durchsicht, auch nach Neustart der App). */
export async function saveSnapshot(res: RunResult, file: string): Promise<void> {
  const { byAccount: _b, review: _r, ...rest } = res;
  await writeFile(file, JSON.stringify({ v: 1, ...rest }), 'utf8');
}

export async function loadSnapshot(file: string): Promise<RunResult> {
  const o = JSON.parse(await readFile(file, 'utf8'), (k, v) => (typeof v === 'string' && (k === 'startedAt' || k === 'finishedAt' || k === 'at') && /^\d{4}-\d{2}-\d{2}T/.test(v) ? new Date(v) : v));
  const res = o as RunResult;
  res.byAccount = new Map(res.match.results.map(r => [r.accountId, r]));
  return res;
}
