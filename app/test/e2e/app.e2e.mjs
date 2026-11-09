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
    BSB_CLOUD_ROOTS: path.join(FIX, 'Kunde_Upload'),
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
// Cloud-Schnellzugriff wird angezeigt (synchronisierter Ordner)
await page.locator('.cloud .chip', { hasText: 'Kunde_Upload' }).waitFor();
step('Cloud-Ordner erkannt');
await page.getByRole('button', { name: 'Ordner wählen …', exact: true }).click();
await page.locator('.paths li', { hasText: 'Kunde_Upload' }).waitFor();
await page.getByRole('button', { name: 'Zielordner wählen …' }).click();
await page.getByText(target).waitFor();
await page.screenshot({ path: `${shots}-2-eingaben.png` });
await page.getByRole('button', { name: 'Prüfung starten' }).click();
step('Prüfung gestartet');
await page.getByText(/Belege lesen|Saldobilanz lesen|Unterlagen suchen/).first().waitFor();
await page.screenshot({ path: `${shots}-3-lauf.png` });
await page.getByRole('button', { name: 'Abschliessen …' }).waitFor({ timeout: Number(process.env.RUN_TIMEOUT ?? 180000) }).catch(async e => { await page.screenshot({ path: `${shots}-err.png` }); throw e; });
step('Analyse abgeschlossen – Durchsicht');
// Vor dem Abschluss wird nichts abgelegt
assert.equal(readdirSync(target).length, 0, 'vor dem Abschliessen darf nichts im Zielordner liegen');
await page.screenshot({ path: `${shots}-4-ergebnis.png` });

// Kennzahlen und Detailansicht
const kz = async k => (await page.locator(`.summary-line [data-k="${k}"]`).innerText()).replace(/\s+/g, ' ');
console.log('Kennzahlen:', (await page.locator('.summary-line').innerText()).replace(/\s+/g, ' '));
assert.match(await kz('BELEGT'), /10 belegt/);
assert.match(await kz('PRUEFEN'), /6 prüfen/);
assert.match(await kz('KEIN_NACHWEIS'), /5 ohne Nachweis/);
// Ergebnis muss exakt dem der Engine-Tests entsprechen (gleiche Engine, andere Laufumgebung)
const stored = JSON.parse(readFileSync(readdirSync(userData).filter(f => f.startsWith('result-')).map(f => path.join(userData, f))[0], 'utf8'));
assert.equal(stored.documents.filter(d => d.ocrPages > 0).length, 4, '4 Belege mit Texterkennung');
const errs = stored.documents.filter(d => d.status === 'error').map(d => d.relPath);
assert.deepEqual(errs, ['Diverses/defekt.pdf'], 'nur die absichtlich defekte Datei darf fehlschlagen: ' + JSON.stringify(stored.documents.filter(d => d.status === 'error').map(d => [d.relPath, d.warnings])));
// Belegvorschau mit markierter Fundstelle – je Belegart
const pv = async (konto, sel, file, shot) => {
  await page.getByRole('cell', { name: konto, exact: true }).click();
  await page.locator('.preview-panel ' + sel).first().waitFor({ state: 'visible', timeout: 30_000 });
  assert.match(await page.locator('.preview-panel .doc-line').innerText(), new RegExp(file.split('/').pop().replace(/[.]/g, '\\.')));
  if (shot) await page.screenshot({ path: `${shots}-${shot}.png` });
  step(`Vorschau ${konto}: ${sel} sichtbar`);
};
await pv('Bank UBS Kontokorrent', '.hl-box', 'Bank/UBS/Kontoauszug.pdf', '5-vorschau-pdf');
await pv('Kasse', '.hl-box', 'Kasse/IMG_4471.jpg', '5b-vorschau-foto');
await pv('Bank ZKB Privatkonto', '.hl-box', 'Bank/ZKB/Scan_20260112.pdf', '5c-vorschau-scan');
await pv('Forderungen aus Lieferungen und Leistungen', 'tr.hl-row', 'OP_Debitoren', '5d-vorschau-excel');
await pv('Verbindlichkeiten aus Lieferungen und Leistungen', '.textdoc .hl-row', 'Kreditoren_OP.docx', '5e-vorschau-word');
// Markierung liegt im sichtbaren Bereich der Vorschau (automatisch hingescrollt)
const inView = await page.evaluate(() => {
  const m = document.querySelector('.preview-panel .hl-row'); const v = document.querySelector('.viewer-body');
  const a = m.getBoundingClientRect(), b = v.getBoundingClientRect(); return a.top >= b.top - 2 && a.bottom <= b.bottom + 2;
});
assert.ok(inView, 'Fundstelle muss im sichtbaren Bereich sein');
// Pfeiltaste: nächstes Konto, Vorschau folgt
const before = await page.locator('.preview-panel h3').innerText();
await page.keyboard.press('ArrowDown');
await page.waitForFunction(b => document.querySelector('.preview-panel h3')?.textContent !== b, before);
step(`Pfeiltaste: ${before} → ${await page.locator('.preview-panel h3').innerText()}`);
// Seitenwechsel im PDF und zurück zur Fundstelle
await page.getByRole('cell', { name: 'Bank UBS Kontokorrent', exact: true }).click();
await page.locator('.preview-panel .hl-box').waitFor();
await page.getByRole('button', { name: 'vorherige Seite' }).click();
await page.getByText('zur Fundstelle').waitFor();
assert.equal(await page.locator('.preview-panel .hl-box').count(), 0);
await page.getByText('zur Fundstelle').click();
await page.locator('.preview-panel .hl-box').waitFor();
step('Seitenwechsel und zurück zur Fundstelle');
await page.getByRole('tab', { name: 'Belegverzeichnis' }).click();
await page.getByRole('button', { name: /^Alle \(/ }).click();
await page.locator('tr[data-beleg="Kasse/IMG_4471.jpg"]').waitFor();
await page.screenshot({ path: `${shots}-6-belege.png` });
await page.getByRole('tab', { name: 'Diagnosebericht' }).click();
assert.match(await page.locator('pre.diag').innerText(), /DIAGNOSEBERICHT/);

// ---------------- Durchsicht: akzeptieren, Notiz, Belege zuordnen ----------------
await page.getByRole('tab', { name: 'Konten' }).click();
await page.getByLabel('Visum').fill('MS');
const pruefen = stored.accounts.filter(a => a.status === 'PRUEFEN');
const kn = stored.accounts.filter(a => a.status === 'KEIN_NACHWEIS');
await page.locator(`[data-konto="${pruefen[0].accountNumber}"]`).click();
await page.getByRole('button', { name: '✓ Akzeptieren', exact: true }).click();
await page.getByRole('button', { name: /Akzeptiert · rückgängig/ }).waitFor();
assert.match(await kz('BELEGT'), /11 belegt/);
assert.match(await kz('PRUEFEN'), /5 prüfen/);
step(`Konto ${pruefen[0].accountNumber} akzeptiert → Belegt 11 / Prüfen 5`);
// Gruppierung nach KMU-Kontenrahmen mit Registerbuchstaben
assert.ok(await page.locator('tr.group-row', { hasText: 'Flüssige Mittel' }).count() === 1);
assert.equal(await page.locator('tr.group-row', { hasText: 'Flüssige Mittel' }).locator('.register').innerText(), 'B');
// Notiz zur Bank
await page.locator('[data-konto="1020"]').click();
await page.getByRole('button', { name: 'Notiz', exact: true }).click();
await page.locator('.note-field textarea').fill('Saldo mit Bankbestätigung abgestimmt.');
await page.locator('.preview-panel h3').click(); // Feld verlassen = speichern
await page.locator('[data-konto="1020"] .flag.note').waitFor();
step('Notiz erfasst');
// Belege ohne Zuordnung: einen Beleg einem Konto ohne Nachweis zuordnen, übrige als nicht relevant
await page.getByRole('tab', { name: 'Belegverzeichnis' }).click();
await page.getByRole('button', { name: /Ohne Zuordnung/ }).click();
const open0 = await page.locator('tr[data-beleg]').count();
assert.ok(open0 >= 2, 'es gibt Belege ohne Zuordnung');
const firstOk = stored.documents.find(d => !d.assigned && d.status === 'ok');
// Vorschau des Belegs rechts, Konto in der Liste wählen, zuordnen
await page.locator(`tr[data-beleg="${firstOk.relPath}"]`).click();
await page.locator('.doc-panel .viewer').waitFor();
await page.locator('.doc-panel input[aria-label="Konto suchen"]').fill(kn[0].accountNumber);
await page.locator(`.doc-panel tr[data-pick="${kn[0].accountNumber}"]`).click();
await page.getByRole('button', { name: new RegExp(`Beleg zuordnen → ${kn[0].accountNumber}`) }).click();
await page.locator(`tr[data-beleg="${firstOk.relPath}"]`).waitFor({ state: 'detached' });
await page.screenshot({ path: `${shots}-6b-belegverzeichnis.png` });
// nächster offener Beleg ist automatisch gewählt -> Allgemeine Prüfungen
const generalDoc = await page.locator('tr[data-beleg].selected').getAttribute('data-beleg');
await page.getByRole('button', { name: 'Allgemein (A)' }).click();
await page.locator(`tr[data-beleg="${generalDoc}"]`).waitFor({ state: 'detached' });
for (let i = 0; i < 30 && (await page.locator('tr[data-beleg]').count()) > 0; i++) {
  const r = await page.locator('tr[data-beleg]').first().getAttribute('data-beleg');
  await page.locator('tr[data-beleg]').first().click();
  await page.getByRole('button', { name: 'Nicht relevant' }).click();
  await page.locator(`tr[data-beleg="${r}"]`).waitFor({ state: 'detached' });
}
assert.equal(await page.locator('tr[data-beleg]').count(), 0, 'alle Belege haben eine Zuordnung');
assert.match(await kz('BELEGT'), /12 belegt/);
assert.match(await kz('belege'), /20 \/ 20 Belege zugeordnet/);
step(`${open0} Belege zugeordnet bzw. als nicht relevant markiert`);
await page.screenshot({ path: `${shots}-6-durchsicht.png` });
// Entscheide überleben einen Neustart (gespeichert)
const savedDec = JSON.parse(readFileSync(readdirSync(userData).filter(f => f.startsWith('result-')).map(f => path.join(userData, f))[0], 'utf8')).decisions;
assert.equal(Object.keys(savedDec.accepted).length, 1);
assert.ok(Object.keys(savedDec.assignments).length >= 2);

// ---------------- Abschliessen ----------------
await page.getByRole('button', { name: 'Abschliessen …' }).click();
await page.getByRole('button', { name: 'Ablegen und Excel erstellen' }).click();
await page.getByText('Excel-Dokumentation öffnen').waitFor({ timeout: 120_000 });
step('Abgeschlossen');
const assigned = readdirSync(path.join(target, '01_Zugeordnet'));
const unassigned = readdirSync(path.join(target, '02_Nicht_zugeordnet'));
const irrelevant = readdirSync(path.join(target, '03_Nicht_relevant'));
const excel = readdirSync(target).filter(f => f.endsWith('.xlsx'));
console.log(`Ablage: ${assigned.length} zugeordnet (${assigned.slice(0, 6).join(', ')} …), ${unassigned.length} nicht zugeordnet, ${irrelevant.length} nicht relevant, Excel: ${excel.join(', ')}`);
assert.equal(excel.length, 1);
assert.equal(unassigned.length, 0);
assert.ok(assigned.filter(f => /^[A-Z]+\d*\.\d+_/.test(f)).length >= 12, 'Dateinamen mit Register');
assert.ok(assigned.includes(`A.1_${generalDoc.split('/').pop()}`), 'Allgemeine Prüfungen mit Register A');
const ubs = assigned.find(f => /^B\.\d+_Bank_UBS_Kontoauszug\.pdf$/.test(f));
assert.ok(ubs, 'Bankauszug mit Register B');
assert.ok(readFileSync(path.join(target, '01_Zugeordnet', ubs)).length > readFileSync(path.join(FIX, 'Kunde_Upload', 'Bank', 'UBS', 'Kontoauszug.pdf')).length, 'Notizseite vorangestellt');
assert.ok(existsSync(path.join(FIX, 'Kunde_Upload', 'Bank', 'UBS', 'Kontoauszug.pdf')), 'Original muss beim Kopieren bleiben');
await page.getByRole('tab', { name: 'Diagnosebericht' }).click();
assert.match(await page.locator('pre.diag').innerText(), /DIAGNOSEBERICHT/);

// Bilanz und Erfolgsrechnung getrennt, mit Zwischensummen: Vorschau über die Schnittstelle
const SPLIT = path.resolve(root, '..', 'engine', 'test', 'fixtures', 'tb_split');
const sp = await page.evaluate(p => window.bsb.engine.previewTrialBalance(p, 'signed', { accountDigits: { min: 4, max: 4 } }), [path.join(SPLIT, 'Bilanz_2025.xlsx'), path.join(SPLIT, 'Erfolgsrechnung_2025.pdf')]);
assert.equal(sp.accounts.length, 27);
assert.ok(sp.validation.checks.filter(c => c.name.startsWith('Aktuelles Jahr')).every(c => c.passed), 'Bilanz + ER zusammen: Soll = Haben, Erfolg stimmt');
step(`Bilanz.xlsx + Erfolgsrechnung.pdf: ${sp.accounts.length} Konten, ${sp.excluded.length} Zeilen ausgeblendet`);

// Verlauf nach Neustart
await page.getByRole('button', { name: 'Übersicht' }).click();
await page.getByText('Letzte Prüfungen').waitFor();
assert.ok((await page.locator('.hist').innerText()).includes('Alpenblick Treuhand AG'));
const hist = JSON.parse(readFileSync(path.join(userData, 'history.json'), 'utf8'));
assert.equal(hist[0].counts.BELEGT, 12);
assert.equal(hist[0].finalized, true);
await page.screenshot({ path: `${shots}-7-verlauf.png` });
await app.close();
step('ALLE PRÜFUNGEN BESTANDEN');
