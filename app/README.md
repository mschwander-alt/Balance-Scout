# Balance Scout – Windows-App (lokal)

Saldennachweis-Prüfung als Windows-App: **ohne Server, ohne Cloud, ohne Administratorrechte.**

## Ablauf für Prüferinnen und Prüfer
1. **Neue Prüfung** → Mandat und Bilanzstichtag eingeben.
2. **Bilanz und Erfolgsrechnung** hineinziehen – eine Datei oder mehrere (Excel, CSV, PDF, auch Scan).
   **Kontonummern von … bis … Ziffern** angeben (wird vorgeschlagen): Gruppen und Zwischensummen werden ausgeblendet.
   „Konten anzeigen“ zeigt die Konten gegliedert nach KMU-Kontenrahmen. Spalten nicht erkannt → „Spalten zuordnen …“.
3. **Unterlagen des Kunden** hineinziehen: ganze Ordner (inkl. Unterordner) oder einzelne Dateien
   (auch synchronisierte OneDrive-/SharePoint-Ordner).
4. **Zielordner** wählen und **kopieren** (Standard) / verschieben / nicht ablegen → **Prüfung starten.**
5. **Durchsicht** (noch wird nichts abgelegt):
   - Konten sind nach KMU-Kontenrahmen gruppiert, mit Registerbuchstaben (z. B. **B** Flüssige Mittel).
   - Klick auf ein Konto zeigt rechts den Beleg mit gelb markierter Fundstelle.
   - **„Akzeptieren → Belegt“** bei Konten mit „Prüfen“ (optional mit Kommentar; Visum oben eintragen).
   - **Notiz** je Konto erfassen.
   - Im **Belegverzeichnis** unter „Ohne Zuordnung“ jeden Beleg einem Konto zuordnen oder als „nicht relevant“ markieren.
   - **Register …**: Buchstaben je Gruppe anpassen (als Standard speicherbar).
   Alle Entscheide werden laufend gespeichert – die Durchsicht kann später über „Übersicht“ fortgesetzt werden.
6. **Abschliessen …** → Ablage und Excel-Dokumentation entstehen:
   `01_Zugeordnet/B.1_Kontoauszug Bank A.pdf`, `B.2_…` (Notiz als erste PDF-Seite bzw. `B.1_Notiz_….pdf`),
   `02_Nicht_zugeordnet`, `03_Nicht_relevant`, `Saldenabstimmung_<Mandat>_<Stichtag>.xlsx`.
   Erneutes Abschliessen erstellt eine neue Version „… (2).xlsx“; nichts wird überschrieben.

## Datenschutz
Alle Verarbeitung – auch die Texterkennung – läuft auf dem PC. Die App stellt keine Netzwerkverbindungen her.
Die Vorschau zeigt nur Belege der geöffneten Prüfung. Der **Diagnosebericht** enthält keine Beträge, Namen oder Dateinamen und darf zur Fehlersuche weitergegeben werden.

## Technik
Electron + React. Die Prüf-Engine (`../engine`) läuft in einem eigenen Hintergrundprozess, damit das Fenster
während der Texterkennung bedienbar bleibt. Die App heisst im Startmenü **„Balance Scout Lokal“** und hat einen eigenen
Datenordner (`%APPDATA%\Balance Scout Lokal`) – getrennt von der früheren Server-Variante.

```bash
npm ci && npm install --install-links --no-save   # Engine als echte Kopie einbinden (wichtig fürs Verpacken)
npm run build
xvfb-run -a node test/e2e/app.e2e.mjs                                   # echte App durchklicken
npx electron-builder --linux --dir && xvfb-run -a node test/e2e/packaged.e2e.mjs release/linux-unpacked/balance-scout-lokal
npm run dist:win            # Windows-Installer (auf Windows bzw. GitHub Actions "Balance Scout lokal")
```

## Optionale Anbindungen (später)
Copilot/Azure/SharePoint aus der Server-Variante (`../server`) können zugeschaltet werden, sobald eine
Administratorfreigabe vorliegt. Die lokale App funktioniert vollständig ohne sie.
