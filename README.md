# Balance Scout

Saldennachweis-Prüfung für Schweizer Revisionsstellen.

## Empfohlen: Balance Scout lokal (ohne Server, ohne Cloud, ohne Administrator)
| Ordner | Inhalt |
|---|---|
| [`engine/`](engine/README.md) | Prüf-Engine: Saldobilanz, Belege inkl. **lokaler Texterkennung** (Scans, Fotos, Bilder in Excel), Abgleich, Excel-Dokumentation, Ablage in `01_Zugeordnet` / `02_Nicht_zugeordnet` |
| [`app/`](app/README.md) | Windows-App: Ordner hineinziehen, prüfen, Excel öffnen |

Windows-Installer: GitHub **Actions › „Balance Scout lokal“ › Run workflow** → Artefakt `balance-scout-lokal-windows`.
Der Ablauf testet Engine und App und prüft die installierte Windows-Version mit einem kompletten Lauf, bevor er den Installer bereitstellt.

## Optional: Variante mit Server in Azure (benötigt Administratorfreigabe)
| Ordner | Inhalt |
|---|---|
| [`server/`](server/README.md) | Server mit Microsoft-Anmeldung, Microsoft 365 Copilot / Azure AI Foundry / Ollama, Teamfunktionen |
| [`desktop/`](desktop/README.md) | Windows-App für den Server |
| [`infra/`](infra/README.md) | Azure-Infrastruktur (Schweiz Nord) und Entra-Einrichtung |
