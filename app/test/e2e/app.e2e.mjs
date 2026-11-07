/**
 * Ende-zu-Ende-Test der echten Electron-App (Fenster, Hintergrundprozess, Texterkennung, Ablage, Excel).
 * Aufruf: xvfb-run -a node test/e2e/app.e2e.mjs
 */
import { _electron as electron } from 'playwright-core';
import { mkdtempSync, readdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = path.resolve(import.meta.dirname, '..', '..');
const FIX = path.resolve(root, '..', 'engine', 'test', 'fixtures', 'alpen');
const target = mkdtempSync(path.join(tmpdir(), 'bsb-ziel-'));
const userData = mkdtempSync(path.join(tmpdir(), 'bsb-user-'));
const shots = path.join(tmpdir(), 'bsb-shots');
const t0 = Date.now();
const step = m => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);

const app = await electron.launch({
  args: [root, '--no-sandbox'],
  env: {
    ...process.env,
    BSB_USER_DATA: userData,
    BSB_E2E_PICKS: JSON.stringify({ trialBalance: path.join(FIX, 'Saldobilanz_2025.xlsx'), folders: [path.join(FIX, 'Kunde_Upload')], files: [], targetDir: target }),
  },
});
const page = await app.firstWindow();
page.setDefaultTimeout(30_000);
await page.setViewportSize({ width: 1400, height: 900 });
await page.screenshot({ path: `${shots}-1-start.png` });
step('App gestartet');

await page.getByText('+ Neue Prüfung starten').click();
await page.getByPlaceholder('z. B. Muster AG').fill('Alpenblick Treuhand AG');
await page.locator('input[type=date]').fill('2025-12-31');
await page.getByRole('button', { name: 'Datei wählen …' }).click();
await page.getByText(/27 Konten erkannt/).waitFor();
step('Saldobilanz-Vorschau: 27 Konten');
await page.getByRole('button', { name: 'Ordner wählen …', exact: true }).click();
await page.getByText(/Kunde_Upload/).waitFor();
await page.getByRole('button', { name: 'Zielordner wählen …' }).click();
await page.getByText(target).waitFor();
await page.screenshot({ path: `${shots}-2-eingaben.png` });
await page.getByRole('button', { name: 'Prüfung starten' }).click();
step('Prüfung gestartet');
await page.getByText(/Belege lesen|Saldobilanz lesen|Unterlagen suchen/).first().waitFor();
await page.screenshot({ path: `${shots}-3-lauf.png` });
await page.getByText('Excel-Dokumentation öffnen').waitFor({ timeout: Number(process.env.RUN_TIMEOUT ?? 180000) }).catch(async e => { await page.screenshot({ path: `${shots}-err.png` }); throw e; });
step('Prüfung abgeschlossen');
await page.screenshot({ path: `${shots}-4-ergebnis.png` });

// Kennzahlen und Detailansicht
const kpis = await page.locator('.kpi').allInnerTexts();
console.log('Kennzahlen:', kpis.map(k => k.replace(/\n/g, ' ')).join(' | '));
assert.match(kpis[1], /Belegt\s*10/);
assert.match(kpis[2], /Prüfen\s*6/);
assert.match(kpis[3], /Kein Nachweis\s*5/);
assert.match(kpis[4], /4 mit Texterkennung/);
// Ergebnis muss exakt dem der Engine-Tests entsprechen (gleiche Engine, andere Laufumgebung)
const stored = JSON.parse(readFileSync(readdirSync(userData).filter(f => f.startsWith('result-')).map(f => path.join(userData, f))[0], 'utf8'));
const errs = stored.documents.filter(d => d.status === 'error').map(d => d.relPath);
assert.deepEqual(errs, ['Diverses/defekt.pdf'], 'nur die absichtlich defekte Datei darf fehlschlagen: ' + JSON.stringify(stored.documents.filter(d => d.status === 'error').map(d => [d.relPath, d.warnings])));
await page.getByRole('cell', { name: 'Bank UBS Kontokorrent' }).click();
await page.getByText('Fundstelle', { exact: true }).waitFor();
assert.match(await page.locator('.panel').innerText(), /Schlusssaldo zu Ihren Gunsten/);
await page.screenshot({ path: `${shots}-5-detail.png` });
await page.getByRole('tab', { name: 'Belegverzeichnis' }).click();
await page.getByText('IMG_4471.jpg').waitFor();
await page.screenshot({ path: `${shots}-6-belege.png` });
await page.getByRole('tab', { name: 'Diagnosebericht' }).click();
assert.match(await page.locator('pre.diag').innerText(), /DIAGNOSEBERICHT/);

// Dateien im Zielordner
const assigned = readdirSync(path.join(target, '01_Zugeordnet'));
const unassigned = readdirSync(path.join(target, '02_Nicht_zugeordnet'));
const excel = readdirSync(target).filter(f => f.endsWith('.xlsx'));
console.log(`Ablage: ${assigned.length} zugeordnet, ${unassigned.length} nicht zugeordnet, Excel: ${excel.join(', ')}`);
assert.equal(excel.length, 1);
assert.ok(assigned.includes('Bank_UBS_Kontoauszug.pdf') && assigned.includes('Bank_PostFinance_Kontoauszug.pdf'));
assert.ok(existsSync(path.join(FIX, 'Kunde_Upload', 'Bank', 'UBS', 'Kontoauszug.pdf')), 'Original muss beim Kopieren bleiben');

// Verlauf nach Neustart
await page.getByRole('button', { name: 'Übersicht' }).click();
await page.getByText('Letzte Prüfungen').waitFor();
assert.ok((await page.locator('.hist').innerText()).includes('Alpenblick Treuhand AG'));
const hist = JSON.parse(readFileSync(path.join(userData, 'history.json'), 'utf8'));
assert.equal(hist[0].counts.BELEGT, 10);
await page.screenshot({ path: `${shots}-7-verlauf.png` });
await app.close();
step('ALLE PRÜFUNGEN BESTANDEN');
