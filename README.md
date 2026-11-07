# Balance Scout

Saldennachweis-Prüfung für Schweizer Revisionsstellen: Saldobilanz einlesen und abstimmen, Belege
erfassen, Salden **nachvollziehbar** mit Belegen abgleichen, KI-gestützte Belegauswertung mit
**Microsoft 365 Copilot**, **Azure AI Foundry (Schweiz)** oder **Ollama (lokal)**, Zusammenarbeit im Team.

```
┌──────────────────────────┐  HTTPS + Microsoft-Anmeldung    ┌──────────────────────────────────────────┐
│ Windows-App (Taskleiste)  │ ─────────────────────────────▶ │ Azure Schweiz Nord (eigener Tenant)      │
│  · Windows-SSO (WAM)      │ ◀── Live-Ereignisse (SSE) ──── │  Container Apps: Balance-Scout-Server    │
│  · Benachrichtigungen     │                                │  PostgreSQL 16 (nur privat), Azure Files │
└──────────────────────────┘                                 │  Key Vault, Azure AI Foundry (optional)  │
                                                             └───────────────┬──────────────────────────┘
                                                      im Namen des Benutzers │ (On-Behalf-Of)
                                                                             ▼
                                                     Microsoft 365 Copilot (Work IQ) · SharePoint
```

| Ordner | Inhalt |
|---|---|
| [`server/`](server/README.md) | Server (Node.js/TypeScript): Prüfregeln, Matching, KI-Schicht, Zusammenarbeit, Prüfprotokoll |
| [`desktop/`](desktop/README.md) | Windows-App (Electron/React) mit Taskleisten-Symbol |
| [`infra/`](infra/README.md) | Azure-Infrastruktur (Bicep) und Einrichtungsskripte |

## Inbetriebnahme (Kurzfassung für die IT)

1. **Entra ID** – in der Azure Cloud Shell: `infra/setup-entra.sh --admin-group <ID> --user-group <ID>`
2. **Azure** – `infra/deploy.sh --resource-group rg-balance-scout` (Schweiz Nord)
3. **Windows-App** – Installer aus GitHub Actions („Windows-Installer“) verteilen und
   `infra/desktop-config.json` als `%ProgramData%\BalanceScout\config.json` ausrollen (Intune/GPO)
4. **Copilot** (optional) – Work IQ im Microsoft-365-Admin-Center aktivieren, Schritt 1 wiederholen

Details: [infra/README.md](infra/README.md)

## Qualität

| | Tests |
|---|---|
| Server | 99 (Fachlogik, KI-Anbieter gegen nachgebildete Schnittstellen, Microsoft-Token-Prüfung, Sperren, Live-Ereignisse über zwei Instanzen, SharePoint, PostgreSQL) |
| Windows-App | 13 (Einstellungen/IT-Richtlinie, Pfadschutz, Oberfläche, Ende-zu-Ende gegen echten Server) |
| Infrastruktur | Bicep-Build + Linter, ShellCheck, Trockenlauf der Entra-Einrichtung gegen nachgebildete Azure CLI |
