#!/usr/bin/env node
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { runAudit, writeExcelReport, reportFileName, diagnosticReport, type FileMode } from './index.js';

function usage(msg?: string): never {
  if (msg) console.error(`Fehler: ${msg}\n`);
  console.error(`Aufruf:
  bsb-local --mandat "Muster AG" --stichtag 31.12.2025 --saldobilanz SaBi.xlsx --belege <Ordner|Datei> [--belege …]
            [--ziel <Ordner>] [--modus kopieren|verschieben|keine] [--toleranz 1.00] [--vorzeichen signed|unsigned]`);
  process.exit(2);
}

const args = process.argv.slice(2);
const get = (k: string) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : undefined;
};
const all = (k: string) => args.flatMap((a, i) => (a === k && args[i + 1] ? [args[i + 1]!] : []));

const mandate = get('--mandat') ?? usage('--mandat fehlt');
const tb = get('--saldobilanz') ?? usage('--saldobilanz fehlt');
const evidence = all('--belege');
if (!evidence.length) usage('--belege fehlt');
const st = get('--stichtag');
let closingDate: string | null = null;
if (st) {
  const m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(st) ?? /^(\d{4})-(\d{2})-(\d{2})$/.exec(st);
  if (!m) usage('--stichtag im Format TT.MM.JJJJ');
  closingDate = st.includes('-') ? st : `${m![3]}-${m![2]!.padStart(2, '0')}-${m![1]!.padStart(2, '0')}`;
}
const modeArg = get('--modus') ?? 'kopieren';
const fileMode: FileMode = modeArg === 'verschieben' ? 'move' : modeArg === 'keine' ? 'none' : 'copy';
const target = get('--ziel') ?? null;
const tol = Math.round(Number((get('--toleranz') ?? '1.00').replace(',', '.')) * 100);

const res = await runAudit({
  mandate,
  closingDate,
  trialBalancePath: tb,
  evidencePaths: evidence,
  targetDir: target,
  fileMode,
  absoluteToleranceCents: tol,
  signConvention: (get('--vorzeichen') as 'signed' | 'unsigned') ?? 'signed',
  onProgress: p => process.stderr.write(`\r\x1b[K[${p.phase}] ${p.current ? `${p.current}/${p.total} ` : ''}${p.message.slice(0, 90)}`),
});
process.stderr.write('\n');
const out = path.join(target ?? path.dirname(path.resolve(tb)), reportFileName(mandate, closingDate));
await writeExcelReport(res, out);
const diag = diagnosticReport(res);
await writeFile(out.replace(/\.xlsx$/, '_Diagnose.txt'), diag, 'utf8');
const c = res.match.summary.counts;
console.log(`Konten: ${res.accounts.length} · Belegt ${c.BELEGT} · Prüfen ${c.PRUEFEN} · Kein Nachweis ${c.KEIN_NACHWEIS} · Abdeckung ${(res.match.summary.coverage * 100).toFixed(1)} %`);
console.log(`Belege: ${res.documents.length} (zugeordnet ${res.documents.filter(d => d.assigned).length}) · Excel: ${out}`);
