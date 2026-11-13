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
    BSB_E2E_PICKS: JSON.stringify({ trialBalance: path.join(FIX, 'Saldobilanz_2025.xlsx'), folders: [path.join(FIX, 'Kunde_Upload')], files: [], targetDir: target, rates: path.resolve(root, '..', 'engine', 'test', 'fixtures', 'fx', 'ESTV_Kursliste_2025.pdf') }),
  },
});
// Ausgaben von App und Prüf-Engine mitschreiben – bei einem Fehler werden sie gezeigt
const appLog = [];
for (const st of [app.process().stdout, app.process().stderr]) st?.on('data', d => appLog.push(...String(d).split('\n').filter(Boolean)));
const showLog = async () => {
  const err = await page.locator('.err-box, .error-box, .error-text, [role=alert]').allInnerTexts().catch(() => []);
  if (err.length) console.log('Fehlermeldung in der App:', err.join(' | '));
  console.log('--- Letzte Ausgaben von App und Prüf-Engine ---');
  console.log(appLog.filter(l => !/Indexing all PDF objects/.test(l)).slice(-60).join('\n'));
};
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
// Option „Konten mit Saldo null nicht importieren“: umschaltbar, Vorschau bleibt stabil (die Testdaten enthalten keine Nullsalden)
const zeroBox = page.getByLabel('Konten mit Saldo null nicht importieren');
await zeroBox.check();
await page.getByText(/\d+ Konten erkannt/).waitFor();
const withZeroSkip = Number((await page.getByText(/\d+ Konten erkannt/).innerText()).match(/(\d+) Konten erkannt/)[1]);
assert.ok(withZeroSkip <= 27 && withZeroSkip >= 20, `Konten ohne Nullsalden: ${withZeroSkip}`);
await zeroBox.uncheck();
await page.getByText(/27 Konten erkannt/).waitFor();
step(`Option Nullsalden umschaltbar (Testdaten ohne Nullsalden: ${withZeroSkip} Konten; Regel siehe engine/test/trialBalanceZero.test.ts)`);
// Cloud-Schnellzugriff wird angezeigt (synchronisierter Ordner)
await page.locator('.cloud .chip', { hasText: 'Kunde_Upload' }).waitFor();
step('Cloud-Ordner erkannt');
await page.getByRole('button', { name: 'Ordner wählen …', exact: true }).click();
await page.locator('.paths li', { hasText: 'Kunde_Upload' }).waitFor();
// Kursliste einmal laden: gilt danach für alle Prüfungen per 31.12.2025
await page.getByRole('button', { name: 'ESTV-Kursliste laden …' }).click();
await page.getByText(/ESTV-Kursliste per 31\.12\.2025 \(6 Währungen, z\. B\. EUR 0\.9305 · USD 0\.79225\)/).waitFor();
step('ESTV-Kursliste geladen');
await page.getByRole('button', { name: 'Zielordner wählen …' }).click();
await page.getByText(target).waitFor();
await page.screenshot({ path: `${shots}-2-eingaben.png` });
await page.getByRole('button', { name: 'Prüfung starten' }).click();
step('Prüfung gestartet');
await page.getByText(/Belege lesen|Saldobilanz lesen|Unterlagen suchen/).first().waitFor({ timeout: 10_000 }).catch(() => {});
await page.screenshot({ path: `${shots}-3-lauf.png` });
await Promise.race([
  page.getByRole('button', { name: 'Abschliessen …' }).waitFor({ timeout: Number(process.env.RUN_TIMEOUT ?? 180000) }),
  page.getByText(/konnte nicht abgeschlossen werden|unerwartet beendet/).waitFor({ timeout: Number(process.env.RUN_TIMEOUT ?? 180000) }).then(() => { throw new Error('Prüfung abgebrochen'); }),
]).catch(async e => { await page.screenshot({ path: `${shots}-err.png` }); await showLog(); throw e; });
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
await page.getByRole('tab', { name: 'Erfolgsrechnung' }).click();
// Analyse (Standard): Staffel mit Margen, Jahresgewinn = Total der Kontenansicht; Bemerkung erfassen
await page.locator('table.income tr[data-inc="R:gewinn"]').waitFor();
const histId = readdirSync(userData).find(f => f.startsWith('result-')).slice(7, -5);
const inc = await page.evaluate(id => window.bsb.review.analysis(id, 'income', {}), histId);
assert.equal(inc.check.accounts, 5);
assert.equal(inc.rows.find(r => r.key === 'R:gewinn').cy, inc.check.total);
await page.locator('table.income tr[data-inc="S:personal"] ~ tr.inc-sub').first().click();
await page.getByLabel('Bemerkung Bruttoergebnis nach Material- und Warenaufwand').fill('Marge stabil');
await page.getByLabel('Bemerkung Bruttoergebnis nach Material- und Warenaufwand').press('Enter');
await page.getByText('1 Bemerkung erfasst').waitFor();
// Langer Kommentar bricht um (Feld wächst mit)
const longNote = page.getByLabel('Bemerkung Betriebsertrag');
const h0 = await longNote.evaluate(e => e.getBoundingClientRect().height);
await longNote.fill('Umsatzwachstum vor allem im zweiten Halbjahr durch Neukunden im Bereich Sanitär; Preiserhöhung per 1. April um 3 % gemäss Preisliste; Abgleich mit Auftragsbestand erfolgt.');
const h1 = await longNote.evaluate(e => e.getBoundingClientRect().height);
assert.ok(h1 > h0 * 1.8, `Kommentarfeld wächst (${h0} → ${h1} px)`);
await longNote.press('Enter');
// Bezugsgrösse: Untergruppe Lohnaufwand = 100 %
await page.getByLabel('Bezugsgrösse').selectOption('U:personal/lohn');
await page.locator('table.income tr[data-inc="U:personal/lohn"].inc-base').waitFor();
assert.equal((await page.locator('table.income tr[data-inc="U:personal/lohn"] td.pct').first().innerText()).trim(), '100.0 %');
// Drag & Drop in der Analyse: Raumaufwand (6000) in den Personalaufwand ziehen, Jahresgewinn unverändert, dann zurücksetzen
const gewinn0 = await page.locator('table.income tr[data-inc="R:gewinn"] td.cur').innerText();
await page.locator('table.income tr[data-inc="U:betrieb/raum"]').click();
await page.locator('table.income tr[data-inc="6000"]').dragTo(page.locator('table.income tr[data-inc="S:personal"]'));
await page.locator('table.income tr[data-inc="6000"] .flag.moved').waitFor();
assert.equal(await page.locator('table.income tr[data-inc="R:gewinn"] td.cur').innerText(), gewinn0);
assert.match(await page.locator('table.income tr[data-inc="S:personal"]').innerText(), /-208'400\.00/);
await page.screenshot({ path: `${shots}-5g-er-analyse.png` });
await page.locator('table.income tr[data-inc="6000"] .flag.moved').click();
await page.locator('table.income tr[data-inc="6000"] .flag.moved').waitFor({ state: 'detached' });
await page.getByLabel('Bezugsgrösse').selectOption('R:betriebsertrag');
step('ER-Analyse: Bezugsgrösse Lohnaufwand = 100 %, Konto per Drag & Drop verschoben und zurückgesetzt, Kommentar bricht um');
step(`Erfolgsrechnung-Analyse: Staffel bis Jahresgewinn CHF ${inc.check.total / 100}, Bemerkung erfasst`);
await page.getByRole('tab', { name: 'Konten', exact: true }).click();
assert.equal(await page.locator('table.konten.er tr[data-konto]').count(), 5, 'Erfolgsrechnung: 5 Konten');
await page.locator('table.konten.er tr.total-row', { hasText: 'Jahres' }).waitFor();
await page.screenshot({ path: `${shots}-5f-erfolgsrechnung.png` });
step('Reiter Erfolgsrechnung: 5 Konten mit Jahresergebnis');
await page.getByRole('tab', { name: 'Bilanz', exact: true }).click();
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
// Konto per Drag & Drop in eine andere Gruppe verschieben: Beleg wird mitgenommen (Register der neuen Gruppe), danach zurücksetzen
await page.getByRole('tab', { name: 'Bilanz', exact: true }).click();
const rowOrder = () => page.locator('table.konten tbody tr').evaluateAll(rs => rs.map(r => (r.dataset.gruppe ? `G:${r.dataset.gruppe}` : r.dataset.konto ?? '')));
const groupOfRow = (order, num) => order.slice(0, order.indexOf(num)).filter(x => x.startsWith('G:')).pop();
const movNum = await page.locator('tr.group-row[data-gruppe="A10"] ~ tr[data-konto]:has(.reg-link)').first().getAttribute('data-konto');
const movRow = page.locator(`tr[data-konto="${movNum}"]`);
const regBefore = await movRow.locator('.reg-link').innerText();
assert.equal(groupOfRow(await rowOrder(), movNum), 'G:A10');
await movRow.dragTo(page.locator('tr.group-row[data-gruppe="A12"]'));
await movRow.locator('.flag.moved').waitFor();
assert.equal(groupOfRow(await rowOrder(), movNum), 'G:A12', 'Konto steht in der neuen Gruppe');
const regMoved = await movRow.locator('.reg-link').innerText();
assert.notEqual(regMoved[0], regBefore[0], `Register folgt der Gruppe (${regBefore} → ${regMoved})`);
await page.screenshot({ path: `${shots}-5b-verschoben.png` });
// Zurücksetzen im Konto rechts
await movRow.click();
await page.locator('.group-line').getByRole('button', { name: 'zurücksetzen' }).click();
await movRow.locator('.flag.moved').waitFor({ state: 'detached' });
assert.equal(groupOfRow(await rowOrder(), movNum), 'G:A10');
assert.equal(await movRow.locator('.reg-link').innerText(), regBefore);
step(`Konto ${movNum} per Drag & Drop verschoben (${regBefore} → ${regMoved}) und zurückgesetzt`);
// Auto-Scroll beim Ziehen: Konto an den unteren Rand der Tabelle ziehen → Tabelle scrollt mit (Abbruch mit Esc, nichts verschoben)
const tw = page.locator('.result-layout .table-wrap').first();
await tw.evaluate(e => { e.scrollTop = 0; });
const twBox = await tw.boundingBox();
await page.locator('tr[data-konto="1000"]').hover();
await page.mouse.down();
await page.mouse.move(twBox.x + 200, twBox.y + 120, { steps: 4 });
await page.mouse.move(twBox.x + 200, twBox.y + twBox.height - 8, { steps: 6 });
await page.waitForTimeout(700);
const scrolled = await tw.evaluate(e => e.scrollTop);
await page.keyboard.press('Escape');
await page.mouse.up();
assert.ok(scrolled > 50, `Tabelle scrollt beim Ziehen (${scrolled} px)`);
assert.equal(await page.locator('tr[data-konto="1000"] .flag.moved').count(), 0, 'abgebrochenes Ziehen verschiebt nichts');
step(`Auto-Scroll beim Ziehen: ${scrolled} px`);
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

// ---------------- Prüfgebiete: Forderungen L+L – Fälligkeitsanalyse ----------------
await page.getByRole('tab', { name: 'Prüfgebiete' }).click();
// Nur Belege, die Forderungskonten zugeordnet sind, stehen zur Auswahl; die Analyse startet erst auf Knopfdruck
await page.locator('.pick-line', { hasText: 'OP_Debitoren' }).waitFor();
assert.equal(await page.locator('.recon').count(), 0, 'Analyse darf nicht automatisch laufen');
assert.equal(await page.locator('.pick-line', { hasText: 'Kreditoren_OP' }).count(), 0);
await page.screenshot({ path: `${shots}-8a-vor-start.png` });
await page.getByRole('button', { name: 'Analyse starten' }).click();
await page.locator('.recon').waitFor();
assert.match(await page.locator('.recon').innerText(), /87'640\.20[\s\S]*✓ abgestimmt/);
assert.equal(await page.locator('table.kunden tr[data-kunde]').count(), 4);
// Alle Kunden: Suche und Sortierung (keine Zusammenfassung „Andere“)
assert.equal(await page.locator('table.kunden', { hasText: 'Andere (' }).count(), 0);
await page.getByLabel('Kunde suchen').fill('meier');
assert.equal(await page.locator('table.kunden tr[data-kunde]').count(), 1);
await page.locator('table.kunden', { hasText: 'Summe Auswahl (1)' }).waitFor();
await page.getByLabel('Kunde suchen').fill('');
await page.locator('table.kunden th', { hasText: 'Kunde' }).click();
assert.deepEqual(await page.locator('table.kunden tr[data-kunde]').evaluateAll(r => r.map(x => x.dataset.kunde)), ['Brunner', 'Keller & Co', 'Meier AG', 'Steiner GmbH']);
await page.locator('table.kunden th', { hasText: 'Total CHF' }).click();
// Abstimmung: weiteres Konto aus allen Konten hinzufügen und wieder entfernen
const addAcc = page.getByLabel('Weiteres Konto für die Abstimmung');
const extra = await addAcc.locator('option').nth(1).getAttribute('value');
await addAcc.selectOption(extra);
await page.locator('.pick-line', { hasText: 'andere Gruppe' }).waitFor();
await page.locator('.recon', { hasText: new RegExp(`Saldo Konto (1100, ${extra}|${extra}, 1100) `) }).waitFor();
await page.locator('.pick-line', { hasText: 'andere Gruppe' }).locator('input').click(); // abgewählt → zurück in die Auswahlliste
assert.equal(await page.locator('.pick-line', { hasText: 'andere Gruppe' }).count(), 0);
await page.locator('.recon', { hasText: /87'640\.20[\s\S]*✓ abgestimmt/ }).waitFor();
step('Kunden durchsuchbar und sortierbar, Abstimmungskonto aus allen Konten');
await page.locator('table.kunden tr[data-kunde="Meier AG"]').click();
await page.locator('.preview-panel .viewer').waitFor();
await page.locator('.preview-panel tr.hl-row').first().waitFor({ timeout: 20_000 });
await page.screenshot({ path: `${shots}-8-pruefgebiete.png` });
await page.getByRole('tab', { name: /Feststellungen/ }).click();
await page.locator('.note-field textarea').fill('Delkredere pauschal 5 % – angemessen.');
await page.getByPlaceholder(/Neue Feststellung/).fill('Saldenbestätigung Meier AG einholen');
await page.getByRole('button', { name: '+ Feststellung erfassen' }).click();
await page.locator('.finding', { hasText: 'Meier AG' }).waitFor();
step('Prüfgebiet Forderungen: OP-Liste abgestimmt, Kunden, Vorschau, Feststellung');

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
const ana = assigned.find(f => /^E\.\d+_Analyse_Fälligkeit\.xlsx$/.test(f));
assert.ok(ana, 'Fälligkeitsanalyse als Nachweis abgelegt');
assert.ok(assigned.includes(ana.replace(/\.xlsx$/, '.pptx')), 'PowerPoint mit gleicher Nummer abgelegt');
const ubs = assigned.find(f => /^B\.\d+_Bank_UBS_Kontoauszug\.pdf$/.test(f));
assert.ok(ubs, 'Bankauszug mit Register B');
assert.ok(readFileSync(path.join(target, '01_Zugeordnet', ubs)).length > readFileSync(path.join(FIX, 'Kunde_Upload', 'Bank', 'UBS', 'Kontoauszug.pdf')).length, 'Notizseite vorangestellt');
assert.ok(existsSync(path.join(FIX, 'Kunde_Upload', 'Bank', 'UBS', 'Kontoauszug.pdf')), 'Original muss beim Kopieren bleiben');
await page.getByRole('tab', { name: 'Diagnosebericht' }).click();
assert.match(await page.locator('pre.diag').innerText(), /DIAGNOSEBERICHT/);

// Fremdwährung: Kontoblätter + Kurse -> Abgleich in EUR/USD, Bewertung
const FXD = path.resolve(root, '..', 'engine', 'test', 'fixtures', 'fx');
const fxr = await page.evaluate(F => window.bsb.engine.run({
  mandate: 'Muster Export AG', closingDate: '2025-12-31', trialBalancePath: F + '/Saldobilanz_2025.xlsx', signConvention: 'signed', evidencePaths: [F + '/Kunde'],
  targetDir: null, fileMode: 'none', absoluteToleranceCents: 100, ledgerPaths: [F + '/Kontoblaetter_2025.pdf'],
  fxRates: { date: '2025-12-31', rates: { EUR: 0.9305, USD: 0.79225 }, source: 'ESTV Kursliste 31.12.2025' },
}), FXD);
const eur = fxr.accounts.find(a => a.accountNumber === '1025');
assert.equal(eur.status, 'BELEGT');
assert.deepEqual([eur.fx.currency, eur.fx.closing, eur.fx.valuationDiff], ['EUR', 5000000, 0]);
assert.equal(fxr.accounts.find(a => a.accountNumber === '1105').fx.valuationDiff, 2750);
step('Fremdwährung: EUR-Konto in EUR belegt, USD-Bewertungsdifferenz 27.50');

// Sachanlagen: Anlagespiegel aus Kontoblättern
const AND = path.resolve(root, '..', 'engine', 'test', 'fixtures', 'anlagen');
const anl = await page.evaluate(F => window.bsb.engine.run({
  mandate: 'Muster Bau AG', closingDate: '2025-12-31', trialBalancePath: F + '/Saldobilanz_2025.xlsx', signConvention: 'signed', evidencePaths: [F + '/Saldobilanz_2025.xlsx'],
  targetDir: null, fileMode: 'none', absoluteToleranceCents: 100, ledgerPaths: [F + '/Kontoblaetter_2025.pdf'],
}), AND);
const fa = await page.evaluate(id => window.bsb.review.fixedAssets(id, {}), anl.historyId);
assert.deepEqual(fa.rows.map(x => [x.accountNumber, x.additions, x.disposals, x.depreciation, x.closing]), [['1500', 6000000, 0, 5400000, 12600000], ['1510', 0, 0, 1000000, 3000000], ['1530', 0, 1500000, 2700000, 1800000], ['1600', 0, 0, 4000000, 96000000]]);
assert.match(fa.rows.find(x => x.accountNumber === '1530').flags.join(' '), /über dem ESTV-Normalsatz von 40 %/);
step('Anlagespiegel: 4 Konten, Abschreibung Fahrzeuge über ESTV-Satz erkannt');

// Business Central Kontoblätter (Excel, ein Blatt je Konto) mit indirekter Abschreibung (Wertberichtigungskonten)
const BCD = path.resolve(root, '..', 'engine', 'test', 'fixtures', 'bc');
const bc = await page.evaluate(F => window.bsb.engine.run({
  mandate: 'Muster Maschinen AG', closingDate: '2025-12-31', trialBalancePath: F + '/Saldobilanz_2025.xlsx', signConvention: 'signed', evidencePaths: [F + '/Saldobilanz_2025.xlsx'],
  targetDir: null, fileMode: 'none', absoluteToleranceCents: 100, ledgerPaths: [F + '/Fibu-Kontoblaetter_2025.xlsx'],
}), BCD);
const fb = await page.evaluate(id => window.bsb.review.fixedAssets(id, {}), bc.historyId);
assert.deepEqual(fb.rows.map(x => [x.accountNumber, x.wbAccount, x.closing, x.tbDiff]), [['1500', '1501', 21490000, 0], ['1510', null, 3900000, 0], ['1530', '1531', 2400000, 0]]);
assert.equal(fb.expense.diff, 0);
// Oberfläche: Prüfgebiet Mobile Sachanlagen
await page.getByRole('button', { name: 'Übersicht' }).click();
await page.locator('.hist > div', { hasText: 'Muster Maschinen AG' }).first().getByRole('button', { name: /Durchsicht fortsetzen|Ergebnis/ }).click();
await page.getByRole('tab', { name: 'Prüfgebiete' }).click();
await page.locator('.area-item', { hasText: 'Mobile Sachanlagen' }).click();
await page.locator('.pick-line', { hasText: 'Wertberichtigung zu 1500' }).waitFor();
await page.getByRole('button', { name: 'Anlagespiegel erstellen' }).click();
await page.locator('tr[data-anlage="1500"]', { hasText: '+ 1501 WB' }).waitFor();
assert.match(await page.locator('.expense-check').innerText(), /✓ stimmt überein/);
await page.locator('tr[data-anlage="1500"]').click();
await page.locator('table.brutto').waitFor();
assert.match(await page.locator('table.brutto').innerText(), /Kum\. Abschreibungen \(1501\)[\s\S]*-323'500\.00/);
await page.screenshot({ path: `${shots}-9-anlagen-bc.png` });
step('Business Central: Wertberichtigungen zugeordnet, Brutto-Anlagespiegel, Abschreibungen = Aufwand');
// Zugänge anklicken → Zugangsliste (Summe = Total Zugänge)
const totAdd = fb.additionsList.reduce((x, a) => x + a.amount, 0);
assert.equal(totAdd, fb.totals.additions);
await page.locator('table.anlagen .total-row .num-link').click();
await page.locator('table.additions').waitFor();
assert.equal(await page.locator('table.additions tbody tr').count(), fb.additionsList.length);
await page.screenshot({ path: `${shots}-9b-zugangsliste.png` });
await page.getByRole('dialog').getByRole('button', { name: 'Schliessen', exact: true }).click();
step(`Zugangsliste: ${fb.additionsList.length} Buchungen, Summe = Zugänge`);

// Rechnungsabgrenzungen: Vorjahresvergleich aus den Kontoblättern (Beispiel „Transitorische Aktiven“)
const RAP = path.resolve(root, '..', 'engine', 'test', 'fixtures', 'rap');
const rap = await page.evaluate(F => window.bsb.engine.run({
  mandate: 'Muster Treuhand AG', closingDate: '2026-06-30', trialBalancePath: F + '/Saldobilanz_2026.xlsx', signConvention: 'signed', evidencePaths: [F + '/Saldobilanz_2026.xlsx'],
  targetDir: null, fileMode: 'none', absoluteToleranceCents: 100, ledgerPaths: [F + '/Kontoblaetter_2026.xlsx'],
}), RAP);
await page.getByRole('button', { name: 'Übersicht' }).click();
await page.locator('.hist > div', { hasText: 'Muster Treuhand AG' }).first().getByRole('button', { name: /Durchsicht fortsetzen|Ergebnis/ }).click();
await page.getByRole('tab', { name: 'Prüfgebiete' }).click();
await page.locator('.area-item', { hasText: 'Aktive Rechnungsabgrenzungen' }).click();
await page.getByRole('button', { name: 'Vorjahresvergleich erstellen' }).click();
const acr = page.locator('[data-abgrenzung="1300"]');
await acr.waitFor();
assert.match(await acr.locator('tfoot').innerText(), /139'514\.45[\s\S]*104'811\.00/);
assert.equal(await acr.locator('tbody tr').count(), 14);
await acr.getByLabel('Bemerkung Swiss Life, BVG Kader 07.-12.').fill('Prämienerhöhung lt. Police 2026');
await acr.getByLabel('Bemerkung Swiss Life, BVG Kader 07.-12.').press('Enter');
await page.screenshot({ path: `${shots}-9c-abgrenzungen.png` });
const acrRes = await page.evaluate(id => window.bsb.review.analysis(id, 'accruals', {}), rap.historyId);
assert.deepEqual(acrRes.accounts.map(a => [a.accountNumber, a.totals.cy, a.totals.py]), [['1300', 13951445, 10481100], ['2300', 3470000, 1850000]]);
step('Rechnungsabgrenzungen: Vorjahresvergleich 139\'514.45 / 104\'811.00, 12 Positionen zugeordnet, 2 neu');

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
const alp = hist.find(h => h.mandate === 'Alpenblick Treuhand AG');
assert.equal(alp.counts.BELEGT, 12);
assert.equal(alp.finalized, true);
await page.screenshot({ path: `${shots}-7-verlauf.png` });
await app.close();
step('ALLE PRÜFUNGEN BESTANDEN');
