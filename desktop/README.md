# Balance Scout – Windows-App

Desktop-App für Windows 10/11 mit Symbol im Infobereich der Taskleiste.

## Funktionen
- **Anmeldung mit Microsoft 365** – über das Windows-Konto (Single Sign-on, WAM), sonst Browser.
  Anmeldedaten werden mit Windows DPAPI verschlüsselt nur für diesen Benutzer gespeichert.
- **Taskleiste**: Schliessen minimiert in den Infobereich; Menü mit zuletzt geöffneten Mandaten,
  laufenden Aktivitäten, Autostart; Windows-Benachrichtigungen bei Änderungen von Kolleginnen und Kollegen.
- **Mandate**: Saldobilanz (Vorschau, Abstimmung), Belege (Upload, KI-Auswertung, SharePoint-Ablage),
  Abgleich (Kennzahlen, Filter, Fundstellen mit Begründung), Prüfvermerke mit Bearbeitungssperre und
  Versionsverlauf, Prüfprotokoll und KI-Nutzungsprotokoll, Einstellungen (KI-Richtlinie, Anbieter).
- **Vor jeder KI-Anfrage** zeigt die App, an welchen Anbieter und welches Ziel die Daten gehen.
- **Live**: Sperren und Vermerke anderer erscheinen sofort; Verbindung wird bei Netzproblemen automatisch
  wiederhergestellt.

## Sicherheit
- Oberfläche ohne Node-Zugriff (`contextIsolation`, `sandbox`, strikte CSP); nur eine schmale, geprüfte
  Schnittstelle (`window.bsb`).
- Netzwerkzugriff nur aus dem Hauptprozess und nur auf `/api/…` des konfigurierten Servers (https).
- Uploads nur von Dateien, die der Benutzer im Dateidialog gewählt hat.
- Keine Navigation aus der App heraus; externe Links (SharePoint) nur https im Standardbrowser.

## Konfiguration
Zentral durch die IT: `%ProgramData%\BalanceScout\config.json` (überschreibt und sperrt Felder):
```json
{ "serverUrl": "https://…azurecontainerapps.io", "tenantId": "…", "clientId": "…", "apiScope": "api://…/access_as_user" }
```
Optional zusätzlich `"autoStart": true`, `"notifications": "andere" | "alle" | "keine"`.

## Entwicklung
```bash
npm install
npm run dev          # Oberfläche mit Hot-Reload + Electron
npm test             # Einheiten-, Oberflächen- und (mit TEST_DATABASE_URL) Ende-zu-Ende-Tests
npm run dist:win     # Installer (auf Windows; sonst GitHub Actions „Windows-Installer“)
```
