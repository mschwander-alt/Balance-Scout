/**
 * Prüft die VERPACKTE App (wie nach der Installation): Pfade zu Engine und Sprachdaten,
 * Start des Hintergrundprozesses, Texterkennung eines Scans und kompletter Lauf – ausgelöst im Hauptprozess.
 * Aufruf: xvfb-run -a node test/e2e/packaged.e2e.mjs <Pfad zur ausführbaren Datei>
 */
import { _electron as electron } from 'playwright-core';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
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
// Es muss die lokale App erscheinen – nicht eine andere "Balance Scout"-App, die bereits läuft
await win.getByText('lokal · ohne Cloud').waitFor({ timeout: 15_000 });
mark('Richtige App sichtbar (Balance Scout lokal)');

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
// Schritt 2: Abschliessen (ohne Entscheide) – erst jetzt Ablage und Excel
assert.equal(readdirSync(target).length, 0, 'vor dem Abschliessen nichts ablegen');
const fin = await win.evaluate(id => window.bsb.review.finalize(id, {}), result.historyId);
assert.ok(fin.finalized && fin.excelPath.endsWith('.xlsx'));
const ocr = result.documents.filter(d => d.ocrPages > 0).length;
const errs = result.documents.filter(d => d.status === 'error').map(d => d.relPath);
console.log('Ergebnis:', JSON.stringify(result.summary.counts), '· Texterkennung:', ocr, '· Fehler:', errs.join(', '));
assert.deepEqual([result.summary.counts.BELEGT, result.summary.counts.PRUEFEN, result.summary.counts.KEIN_NACHWEIS], [10, 6, 5]);
assert.equal(ocr, 4);
assert.deepEqual(errs, ['Diverses/defekt.pdf']);
assert.equal(readdirSync(target).filter(f => f.endsWith('.xlsx')).length, 1);
// Belegvorschau in der verpackten App (Scan-PDF -> Bild) und Schutz gegen fremde Dateien
mark('Saldobilanz als PDF (Scan)');
const TBPDF = path.resolve(import.meta.dirname, '..', '..', '..', 'engine', 'test', 'fixtures', 'tb_pdf');
const pvTb = await win.evaluate(p => window.bsb.engine.previewTrialBalance(p, 'signed'), TBPDF + '/SaBi_Scan.pdf');
console.log('PDF-Saldobilanz (Scan):', pvTb.accounts.length, 'Konten,', pvTb.validation.issues.filter(i => i.code === 'TB_OCR').length, 'Hinweis Texterkennung');
assert.equal(pvTb.accounts.length, 27);
const SPLIT = path.resolve(import.meta.dirname, '..', '..', '..', 'engine', 'test', 'fixtures', 'tb_split');
const pvSplit = await win.evaluate(p => window.bsb.engine.previewTrialBalance(p, 'signed', { accountDigits: { min: 4, max: 4 } }), [SPLIT + '/Bilanz_2025.xlsx', SPLIT + '/Erfolgsrechnung_2025.pdf']);
console.log('Bilanz + Erfolgsrechnung getrennt:', pvSplit.accounts.length, 'Konten,', pvSplit.excluded.length, 'Zeilen ausgeblendet');
assert.equal(pvSplit.accounts.length, 27);
mark('Belegvorschau');
const scan = result.documents.find(d => d.relPath === 'Bank/ZKB/Scan_20260112.pdf');
const pv = await win.evaluate(p => window.bsb.engine.filePreview(p, 1), fin.filed[scan.id].placement.newPath);
assert.equal(pv.kind, 'image');
const denied = await win.evaluate(() => window.bsb.engine.filePreview('/etc/passwd', 1).then(() => 'erlaubt', e => e.message));
assert.match(denied, /nur für Belege der geöffneten Prüfung/);
console.log('Vorschau ok, fremde Datei abgewiesen');
// Zweiter Lauf in denselben Zielordner: bestehender Bericht (evtl. mit Prüfer-Einträgen) bleibt unverändert
mark('Zweiter Lauf in denselben Zielordner');
const firstXlsx = readdirSync(target).find(f => f.endsWith('.xlsx'));
const firstBytes = readFileSync(path.join(target, firstXlsx));
const r2a = await win.evaluate(async ({ FIX, target }) => window.bsb.engine.run({
  mandate: 'Paket-Test', closingDate: '2025-12-31', trialBalancePath: FIX + '/Saldobilanz_2025.xlsx', signConvention: 'signed',
  evidencePaths: [FIX + '/Kunde_Upload/Debitoren'], targetDir: target, fileMode: 'copy', absoluteToleranceCents: 100,
}), { FIX, target });
const r2 = await win.evaluate(id => window.bsb.review.finalize(id, {}), r2a.historyId);
const st2 = Object.values(r2.filed).map(f => f.placement?.status);
console.log('Zweiter Bericht:', path.basename(r2.excelPath), '· Ablage:', st2.join(', '));
assert.match(r2.excelPath, / \(2\)\.xlsx$/);
assert.equal(readdirSync(target).filter(f => f.endsWith('.xlsx')).length, 2);
assert.ok(readFileSync(path.join(target, firstXlsx)).equals(firstBytes), 'erster Bericht wurde verändert');
assert.deepEqual(st2, ['bereits vorhanden']);
mark('App wird beendet');
const pid = app.process().pid;
const alive = id => { try { process.kill(id, 0); return true; } catch { return false; } };
const listApp = async () => {
  const cp = await import('node:child_process');
  try {
    return process.platform === 'win32'
      ? cp.execSync('tasklist /FI "IMAGENAME eq Balance Scout.exe" /FO CSV /NH').toString().trim()
      : cp.execSync('pgrep -af balance-scout-lokal || true').toString().trim();
  } catch { return '(Liste nicht verfügbar)'; }
};
// Wie ein Benutzer: App zum Beenden auffordern und prüfen, ob ALLE App-Prozesse verschwinden
const countApp = async () => {
  const cp = await import('node:child_process');
  try {
    if (process.platform === 'win32') {
      const out = cp.execSync('tasklist /FI "IMAGENAME eq Balance Scout.exe" /FO CSV /NH').toString();
      return out.split(/\r?\n/).filter(l => l.includes('Balance Scout.exe')).length;
    }
    return appPids.filter(id => { try { process.kill(id, 0); return true; } catch { return false; } }).length;
  } catch { return -1; }
};
// Prozessnummern aller App-Prozesse (Haupt-, Fenster-, Grafik-, Engine-Prozess) merken
const appPids = await app.evaluate(({ app }) => app.getAppMetrics().map(m => m.pid)).catch(() => []);
step(`App-Prozesse vor dem Beenden: ${appPids.length}`);
await app.evaluate(({ app }) => app.quit()).catch(() => {});
let gone = false;
for (let i = 0; i < 40 && !gone; i++) {
  await new Promise(r => setTimeout(r, 500));
  gone = (await countApp()) === 0;
}
step(`Alle App-Prozesse beendet: ${gone ? 'ja' : 'NEIN'}`);
if (!gone) step(`Noch laufende Balance-Scout-Prozesse:\n${await listApp()}`);
// Verbindung des Testwerkzeugs lösen, ohne auf offene Kanäle zu warten
await Promise.race([app.close().catch(() => {}), new Promise(r => setTimeout(r, 5000))]);
if (!gone) {
  try { process.platform === 'win32' ? (await import('node:child_process')).execSync(`taskkill /PID ${pid} /T /F`) : process.kill(pid, 'SIGKILL'); } catch {}
  console.error('FEHLER: App-Prozess hat sich nach "Beenden" nicht innert 20 s beendet.');
  process.exit(1);
}
mark('Beendet');
console.log('VERPACKTE APP: ALLE PRÜFUNGEN BESTANDEN');
process.exit(0);
