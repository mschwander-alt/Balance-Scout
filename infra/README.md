# Balance Scout – Azure-Bereitstellung (Schweiz)

Alles läuft in **eurem eigenen Tenant** und in der Region **Schweiz Nord**.
Belege, Datenbank, Protokolle und (optional) das KI-Modell bleiben in der Schweiz.

## Was bereitgestellt wird

| Ressource | Zweck | Sicherheit |
|---|---|---|
| Container Apps (Consumption) | Balance-Scout-Server, 1–3 Instanzen | nur HTTPS; optional IP-Beschränkung (`--allow-ip`) |
| PostgreSQL Flexible Server 16 | Daten, Prüfprotokoll | **kein öffentlicher Zugang**, nur über privates Netz; TLS erzwungen; 35 Tage Backup |
| Azure Files (ZRS) | Belegdateien | TLS 1.2, kein öffentlicher Blob-Zugriff, Löschschutz 30 Tage |
| Key Vault | DB-Verbindung, Client-Secret | RBAC, Purge Protection |
| Container Registry | Server-Image | kein Admin-Zugang, Pull über verwaltete Identität |
| Azure AI Foundry (optional) | Belegauswertung, Texterkennung | **keine Schlüssel** (nur verwaltete Identität), Bereitstellung `Standard` = Verarbeitung in der Region |
| Log Analytics | Betriebsprotokolle | 90 Tage |

## Schritt 1 – App-Registrierungen (Entra ID)

In der **Azure Cloud Shell (Bash)** als Global Administrator (oder Application Administrator +
Privileged Role Administrator):

```bash
git clone <repo> && cd balance-scout/infra
./setup-entra.sh --admin-group <Objekt-ID Gruppe "Revision Leitung"> --user-group <Objekt-ID Gruppe "Revision">
```

Das Skript legt **„Balance Scout API“** und **„Balance Scout Desktop“** an, mit:
- Scope `access_as_user`, App-Rollen `BalanceScout.Admin` / `BalanceScout.User`
- **Nur zugewiesene** Benutzer/Gruppen dürfen sich anmelden
- delegierte Rechte für SharePoint (`Sites.ReadWrite.All`) und – falls aktiviert – Copilot (`WorkIQAgent.Ask`)
- Windows-SSO (WAM-Umleitung), Vorautorisierung der Desktop-App, Administratorzustimmung

Das Skript ist wiederholbar (bestehende Apps werden aktualisiert, IDs bleiben gleich).
Ergebnis: `entra-ergebnis.env` (enthält das Client-Secret, nur für den Besitzer lesbar).

## Schritt 2 – Bereitstellung

```bash
./deploy.sh --resource-group rg-balance-scout \
            [--sharepoint-drive <Drive-ID der Belegbibliothek>] \
            [--allow-ip 203.0.113.0/24]   # Kanzlei-Standorte / VPN (optional, mehrfach möglich)
```

Dauer ca. 15–20 Minuten. Am Ende: Server-URL und `desktop-config.json`.
**Danach `shred -u entra-ergebnis.env`.**

Drive-ID einer SharePoint-Bibliothek ermitteln (Graph Explorer):
`GET https://graph.microsoft.com/v1.0/sites/<kanzlei>.sharepoint.com:/sites/<Revision>:/drives`

## Schritt 3 – Windows-App verteilen

1. Installer aus GitHub Actions („Windows-Installer“, Artefakt `balance-scout-windows`): `.msi` für die
   zentrale Verteilung (Intune/SCCM), `.exe` für Einzelinstallation.
2. `desktop-config.json` als **`%ProgramData%\BalanceScout\config.json`** verteilen. Damit sind Server,
   Tenant und Client-ID fest vorgegeben (für Benutzer gesperrt) und keine Einrichtung nötig.
3. Code-Signatur: Ohne Zertifikat zeigt Windows „Unbekannter Herausgeber“. Empfehlung: **Azure Trusted
   Signing** oder ein Code-Signing-Zertifikat als GitHub-Secret (`WIN_CERT_PFX_BASE64`, `WIN_CERT_PASSWORD`).

## Schritt 4 – Microsoft 365 Copilot (optional)

1. Microsoft-365-Copilot-Lizenzen den Prüferinnen und Prüfern zuweisen.
2. **Work IQ** im Microsoft-365-Admin-Center aktivieren; Abrechnung über **Copilot Credits** einrichten.
3. `./setup-entra.sh` erneut ausführen (fügt `WorkIQAgent.Ask` hinzu) und `./deploy.sh` erneut ausführen.
4. In der App unter *Einstellungen › KI-Anbieter › Testen* prüfen.

## Betrieb

| Aufgabe | Befehl |
|---|---|
| Neue Server-Version | `./deploy.sh --resource-group rg-balance-scout` (baut und rollt aus) |
| Protokolle | `az containerapp logs show -g rg-balance-scout -n balscout-server --follow` |
| Datenbank-Backup wiederherstellen | Azure-Portal › PostgreSQL › Wiederherstellen (Zeitpunkt wählen) |
| Client-Secret erneuern (alle 2 Jahre) | `./setup-entra.sh` → `./deploy.sh` |

## Annahmen / vor Produktivstart prüfen

- **Modellverfügbarkeit**: `gpt-4.1` mit Bereitstellungstyp `Standard` in Schweiz Nord ist als Standard
  gesetzt. Verfügbarkeit im Azure-Portal prüfen; ggf. `openAiModelName`/`openAiModelVersion` anpassen.
  `DataZoneStandard`/`GlobalStandard` können Daten **ausserhalb der Schweiz** verarbeiten.
- **Work IQ**: Endpunkt und Berechtigung gemäss Microsoft-Dokumentation (Stand 2026); ein Test gegen
  euren Tenant steht aus.
- **Kosten** (Richtwerte, abhängig von Nutzung): Container Apps, PostgreSQL B2s, Speicher und Key Vault im
  tiefen dreistelligen CHF-Bereich pro Monat; KI nach Verbrauch.
