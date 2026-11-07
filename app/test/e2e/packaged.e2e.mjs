/**
 * Prüft die VERPACKTE App (wie nach der Installation): Pfade zu Engine und Sprachdaten,
 * Start des Hintergrundprozesses, Texterkennung eines Scans und kompletter Lauf – ausgelöst im Hauptprozess.
 * Aufruf: xvfb-run -a node test/e2e/packaged.e2e.mjs <Pfad zur ausführbaren Datei>
 */
import { _electron as electron } from 'playwright-core';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const exe = process.argv[2];
const t0 = Date.now();
const step = m => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);
// Watchdog: nie länger als 5 Minuten hängen, sondern mit Hinweis abbrechen
let lastStep = 'Start';
setTimeout(() => { console.error(`ABBRUCH nach 5 Minuten – hängt bei: ${lastStep}`); process.exit(1); }, 5 * 60_000).unref();
const mark = m => { lastStep = m; step(m); };
const FIX = path.resolve(import.meta.dirname, '..', '..', '..', 'engine', 'test', 'fixtures', 'alpen');
const target = mkdtempSync(path.join(tmpdir(), 'bsb-pkg-'));
mark(`App wird gestartet: ${exe}`);
const app = await electron.launch({ executablePath: exe, args: ['--no-sandbox'], timeout: 60_000 });
app.process().stdout?.on('data', d => process.stdout.write(`[app] ${d}`));
app.process().stderr?.on('data', d => process.stdout.write(`[app] ${d}`));
mark('App gestartet, warte auf Fenster');
const win = await app.firstWindow();
await win.waitForLoadState('domcontentloaded');
mark('Fenster geladen');

const info = await app.evaluate(({ app }) => ({ packaged: app.isPackaged, resources: process.resourcesPath }));
console.log('verpackt:', info.packaged, '·', info.resources);
assert.equal(info.packaged, true);

// Hinweis: Der Testmodus für Dateidialoge ist in der verpackten App wirkungslos (app.isPackaged) –
// ein Aufruf würde den echten Dialog öffnen; deshalb hier nicht ausgelöst.

mark('Kompletter Prüflauf');
// Kompletter Lauf über die echte Schnittstelle der Oberfläche
const result = await win.evaluate(async ({ FIX, target }) => window.bsb.engine.run({
  mandate: 'Paket-Test', closingDate: '2025-12-31', trialBalancePath: FIX + '/Saldobilanz_2025.xlsx', signConvention: 'signed',
  evidencePaths: [FIX + '/Kunde_Upload'], targetDir: target, fileMode: 'copy', absoluteToleranceCents: 100,
}), { FIX, target });
const ocr = result.documents.filter(d => d.ocrPages > 0).length;
const errs = result.documents.filter(d => d.status === 'error').map(d => d.relPath);
console.log('Ergebnis:', JSON.stringify(result.summary.counts), '· Texterkennung:', ocr, '· Fehler:', errs.join(', '));
assert.deepEqual([result.summary.counts.BELEGT, result.summary.counts.PRUEFEN, result.summary.counts.KEIN_NACHWEIS], [10, 6, 5]);
assert.equal(ocr, 4);
assert.deepEqual(errs, ['Diverses/defekt.pdf']);
assert.equal(readdirSync(target).filter(f => f.endsWith('.xlsx')).length, 1);
// Belegvorschau in der verpackten App (Scan-PDF -> Bild) und Schutz gegen fremde Dateien
mark('Belegvorschau');
const scan = result.documents.find(d => d.relPath === 'Bank/ZKB/Scan_20260112.pdf');
const pv = await win.evaluate(p => window.bsb.engine.filePreview(p, 1), scan.placement.newPath);
assert.equal(pv.kind, 'image');
const denied = await win.evaluate(() => window.bsb.engine.filePreview('/etc/passwd', 1).then(() => 'erlaubt', e => e.message));
assert.match(denied, /nur für Belege der geöffneten Prüfung/);
console.log('Vorschau ok, fremde Datei abgewiesen');
mark('App wird beendet');
const pid = app.process().pid;
// Regulär beenden; falls das nicht innert 20 s gelingt, gilt das als Fehler (App bliebe im Hintergrund hängen)
const closed = await Promise.race([app.close().then(() => true), new Promise(r => setTimeout(() => r(false), 20_000))]);
if (!closed) {
  try { process.platform === 'win32' ? (await import('node:child_process')).execSync(`taskkill /PID ${pid} /T /F`) : process.kill(pid, 'SIGKILL'); } catch {}
  console.error('FEHLER: App hat sich nicht innert 20 s beendet.');
  process.exit(1);
}
mark('Beendet');
console.log('VERPACKTE APP: ALLE PRÜFUNGEN BESTANDEN');
process.exit(0);
