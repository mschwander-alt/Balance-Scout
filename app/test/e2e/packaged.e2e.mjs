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
const FIX = path.resolve(import.meta.dirname, '..', '..', '..', 'engine', 'test', 'fixtures', 'alpen');
const target = mkdtempSync(path.join(tmpdir(), 'bsb-pkg-'));
const app = await electron.launch({ executablePath: exe, args: ['--no-sandbox'] });
const win = await app.firstWindow();
await win.waitForLoadState('domcontentloaded');

const info = await app.evaluate(({ app }) => ({ packaged: app.isPackaged, resources: process.resourcesPath }));
console.log('verpackt:', info.packaged, '·', info.resources);
assert.equal(info.packaged, true);

// Hinweis: Der Testmodus für Dateidialoge ist in der verpackten App wirkungslos (app.isPackaged) –
// ein Aufruf würde den echten Dialog öffnen; deshalb hier nicht ausgelöst.

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
await app.close();
console.log('VERPACKTE APP: ALLE PRÜFUNGEN BESTANDEN');
