# Balance Scout – Windows-App (lokal)

Saldennachweis-Prüfung als Windows-App: **ohne Server, ohne Cloud, ohne Administratorrechte.**

## Ablauf für Prüferinnen und Prüfer
1. **Neue Prüfung** → Mandat und Bilanzstichtag eingeben.
2. **Saldobilanz** (Excel/CSV) hineinziehen – die App zeigt sofort Anzahl Konten und Soll/Haben-Kontrolle.
   Werden die Spalten nicht erkannt: „Spalten zuordnen …“.
3. **Unterlagen des Kunden** hineinziehen: ganze Ordner (inkl. Unterordner) oder einzelne Dateien.
   Synchronisierte OneDrive-/SharePoint-Ordner funktionieren wie normale Ordner.
4. **Zielordner** wählen und **kopieren** (Standard) / verschieben / nicht ablegen.
5. **Prüfung starten.** Fortschritt im Fenster und in der Taskleiste; das Fenster darf geschlossen werden,
   die App meldet sich, wenn sie fertig ist.
6. Ergebnis: Kennzahlen und Kontenliste. **Klick auf ein Konto zeigt rechts den Beleg mit gelb markierter
   Fundstelle** (PDF-Seite, Scan, Foto, Excel-Blatt, Word) – mehrere Fundstellen umschaltbar, Blättern und Zoom,
   **↑/↓** für das nächste Konto. Dazu Belegverzeichnis, Saldobilanz-Prüfung, Diagnosebericht und die
   **Excel-Dokumentation** mit grünen Spalten für den Prüfer-Entscheid.

Im Zielordner entstehen `01_Zugeordnet`, `02_Nicht_zugeordnet` und `Saldenabstimmung_<Mandat>_<Stichtag>.xlsx`.
Vorhandene Dateien werden nie überschrieben; identische Dateien werden nicht doppelt abgelegt.

## Datenschutz
Alle Verarbeitung – auch die Texterkennung – läuft auf dem PC. Die App stellt keine Netzwerkverbindungen her.
Die Vorschau zeigt nur Belege der geöffneten Prüfung. Der **Diagnosebericht** enthält keine Beträge, Namen oder Dateinamen und darf zur Fehlersuche weitergegeben werden.

## Technik
Electron + React. Die Prüf-Engine (`../engine`) läuft in einem eigenen Hintergrundprozess, damit das Fenster
während der Texterkennung bedienbar bleibt.

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
