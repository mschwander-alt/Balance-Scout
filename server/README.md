# Balance Scout – Server

Server für die **Saldennachweis-Prüfung**: Saldobilanz importieren und validieren, Belege erfassen,
Salden **deterministisch und nachvollziehbar** mit Belegbeträgen abgleichen. Jede Aktion wird in einem
unveränderlichen Prüfprotokoll festgehalten.

> Schritt 1: Import, Validierung, deterministisches Matching ✅
> Schritt 2: KI-Schicht mit **Microsoft 365 Copilot**, **Azure AI Foundry** und **Ollama** ✅
> Schritt 3: Microsoft-Anmeldung, Zusammenarbeit (Sperren, Prüfvermerke, Live-Ereignisse), SharePoint, Azure ✅
> Schritt 4: Arbeitspapiere/Export, Übernahme PDF-Annotation und Download-Center aus der alten App

## Schnellstart

```bash
# Mit Docker
API_TOKENS="$(openssl rand -hex 32):m.schwander" docker compose up --build

# Lokal (Node ≥ 20, PostgreSQL ≥ 14)
cp .env.example .env        # DATABASE_URL anpassen
npm install
npm run dev                 # migriert automatisch und startet auf :8080
npm test                    # Unit-Tests; mit TEST_DATABASE_URL zusätzlich Integrationstests
```

## Anmeldung (Schritt 3)

| `AUTH_MODE` | Verwendung |
|---|---|
| `entra` | **Produktivbetrieb.** Microsoft-Entra-Zugriffstoken (v2) werden geprüft: Signatur, eigener Tenant, Audience, Ablauf, Scope `access_as_user`, App-Rolle. `BalanceScout.Admin` = Administrator. Das Token dient zugleich als Assertion für Copilot/SharePoint (On-Behalf-Of). |
| `tokens` | Statische Tokens (`API_TOKENS`), z. B. für Automatisierung |
| `dev` | Ohne Anmeldung (nur Entwicklung; in `production` verboten) |

## Zusammenarbeit (Schritt 3)

| | |
|---|---|
| `POST /api/accounts/:id/lock` | Bearbeitungssperre holen/verlängern (120 s, Heartbeat); 409 mit Name, wenn belegt |
| `DELETE /api/accounts/:id/lock` | Sperre freigeben |
| `PUT /api/accounts/:id/review` | Prüfvermerk (`offen`/`bestaetigt`/`abweichung`/`nicht_anwendbar`) – nur mit eigener Sperre (423) und aktueller Version (409) |
| `GET /api/accounts/:id/reviews` | Versionsverlauf |
| `GET /api/trial-balances/:id/reviews` | aktueller Vermerk je Konto |
| `GET /api/trial-balances/:id/match-runs` | Abgleich-Läufe |
| `GET /api/engagements/:id/events` | Live-Ereignisse (Server-Sent Events), verteilt über PostgreSQL LISTEN/NOTIFY – funktioniert mit mehreren Instanzen, Wiederverbindung bei DB-Unterbruch |
| `POST /api/evidence/:id/sharepoint` | Beleg im Namen des Benutzers in SharePoint ablegen (für Copilot) |
| `GET /api/me` | angemeldeter Benutzer |

## Ablauf über die API

| Schritt | Aufruf |
|---|---|
| Mandat anlegen | `POST /api/engagements` `{ name, clientName?, closingDate?, currency? }` |
| Saldobilanz-Vorschau | `POST /api/engagements/:id/trial-balances` (multipart `file`, `dryRun=true`) |
| Saldobilanz importieren | dito ohne `dryRun`; optional `signConvention` (`signed`/`unsigned`), `toleranceCents`, `mapping` (JSON) |
| Saldobilanz abrufen | `GET /api/trial-balances/:id` |
| Belege hochladen | `POST /api/engagements/:id/evidence` (multipart, mehrere Dateien) |
| Belegtext ansehen | `GET /api/evidence/:id/lines` |
| Matching starten | `POST /api/trial-balances/:id/match-runs` `{ absoluteToleranceCents?, relativeTolerance?, confirmScore?, scope?, documentIds?, assignments? }` |
| Ergebnis abrufen | `GET /api/match-runs/:id` |
| Prüfprotokoll | `GET /api/engagements/:id/audit-log` |

Authentifizierung: `Authorization: Bearer <token>` (Tokens in `API_TOKENS`). Ohne Tokens (nur dev/test)
wird der Benutzer aus dem Header `X-User` übernommen.

```bash
curl -H "Authorization: Bearer $T" -F file=@SaBi_2025.xlsx -F signConvention=signed \
     http://localhost:8080/api/engagements/$E/trial-balances
curl -H "Authorization: Bearer $T" -F files=@UBS.pdf -F files=@Debitoren.pdf \
     http://localhost:8080/api/engagements/$E/evidence
curl -H "Authorization: Bearer $T" -H 'content-type: application/json' -d '{}' \
     http://localhost:8080/api/trial-balances/$TB/match-runs
```

## Prüfregeln

### Saldobilanz
- Kopfzeile wird automatisch erkannt (Konto/Kontonummer, Bezeichnung, Saldo/aktuelles Jahr, Vorjahr, FW;
  auch zwei Jahreszahlen als Spaltenköpfe). Sonst `mapping` explizit übergeben.
- Beträge: `1'234.50`, `1’234.50`, `1 234,50`, `1.234,50`, `1,234.50`, `(1'234.50)`, `1'234.50-`, `1'234.–`.
  Intern als ganzzahlige Rappen; keine Gleitkommafehler. Falsch gruppierte Zahlen (`12'34.00`) werden abgelehnt.
- Zeilen ohne Kontonummer (Totale, Überschriften) werden übersprungen und protokolliert.
- **Fehler**: ungültiger Betrag, doppelte Kontonummer. **Warnungen**: fehlende Bezeichnung, nicht klassierbar,
  ungewöhnliches Vorzeichen (Wertberichtigungskonten ausgenommen).
- **Abstimmung** (aktuelles Jahr und Vorjahr):
  - `signed` (Soll +, Haben −): Summe aller Salden = 0 und Erfolg Bilanz = Erfolg Erfolgsrechnung.
  - `unsigned`: Aktiven − Passiven = Ertrag − Aufwand.
- Gruppierung nach KMU-Kontenrahmen, längstes Präfix gewinnt (z. B. 2800 → Grundkapital, 2970 → Reserven).

### Belege
- Textgewinnung ohne KI: PDF-Textebene (zeilenweise, mit Seite/Zeile), XLSX/CSV, TXT.
- Scans/Bilder werden mit `needsOcr=true` markiert → Texterkennung in Schritt 2 via gewähltem KI-Anbieter.
- Duplikate (gleicher SHA-256) werden erkannt; Dateien werden inhaltsadressiert gespeichert.

### Matching (`bsb-match/1.0.0`)
Vor der Suche werden **Datum, IBAN, Uhrzeit, Prozente und Jahreszahlen ausgeblendet** (keine Zufallstreffer).

| Treffer | Bedingung | Basispunkte |
|---|---|---|
| exact | \|Beleg\| = \|Saldo\| auf den Rappen | 50 |
| rounded | Beleg ohne Dezimalen = auf Franken gerundeter Saldo | 30 |
| tolerance | Differenz ≤ max(absolute, relative Toleranz); Standard 1.00 CHF | 10–30 |

Kontextpunkte: Kontonummer in der Zeile +25, im Dateinamen +15, Kontobezeichnung +10, Saldo-/Total-Begriff +15,
Betrag mit Rappen +5. Abzüge: kleiner Betrag ohne Kontext −15, Vorzeichenkonflikt −30.

| Status | Regel |
|---|---|
| **BELEGT** | exakter Treffer **und** Punktzahl ≥ 70 **und** kein Vorzeichenkonflikt, keine Mehrdeutigkeit, keine Fremdwährung |
| **PRUEFEN** | jeder andere Treffer – mit Begründung |
| **KEIN_NACHWEIS** | kein Betrag im Toleranzband |
| **NULLSALDO** | Saldo 0 |
| **NICHT_IM_UMFANG** | Erfolgsrechnung bei `scope=balance_sheet` (Standard) |

Ein Toleranztreffer wird **nie** automatisch BELEGT. Passt dieselbe Belegzeile zu mehreren Konten, wird sie als
`AMBIGUOUS` markiert, ausser ein Konto liegt mindestens 20 Punkte vorne. Ergebnis: Anzahl pro Status und
**Abdeckung** (Anteil der belegten absoluten Saldosumme). Jeder Lauf wird mit Parametern, Engine-Version und
Dokumentliste gespeichert und ist damit reproduzierbar.

## KI-Schicht (Schritt 2)

### Grundsatz
Die KI **liest und begründet**, sie **entscheidet nicht**. Prüfstatus vergibt ausschliesslich die
Regel-Engine; KI-Ergebnisse fliessen nur ein, nachdem sie gegen den Belegtext verifiziert wurden.

| Aufgabe | Was die KI tut | Schutzmechanismus |
|---|---|---|
| `evidence_extraction` | Belegart, Aussteller, **Stichtag**, IBAN/Konto, Salden mit wörtlichem Zitat; bei Scans zusätzlich Abschrift (OCR) | Jeder Betrag muss wörtlich im Belegtext stehen, sonst verworfen (`quote_not_found`, `amount_not_in_quote`). OCR-Beträge nie automatisch BELEGT (`OCR_SOURCE`). |
| `match_review` | Einschätzung „stützt / stützt nicht / unklar“ mit Begründung und Formulierungsvorschlag fürs Arbeitspapier | Wird nur als Hinweis gespeichert, ändert keinen Status. |

Auswirkungen auf das Matching (Engine `bsb-match/1.1.0`, weiterhin reproduzierbar):
- verifizierter KI-Saldo an derselben Fundstelle: **+10 Punkte**
- Stichtag laut Beleg ≠ Bilanzstichtag: **DATE_MISMATCH** → PRUEFEN
- Fundstelle aus Texterkennung: **OCR_SOURCE** → PRUEFEN

### Anbieter

| | Microsoft 365 Copilot | Azure AI Foundry | Ollama |
|---|---|---|---|
| Datengrenze | eigener M365-Tenant | eigenes Azure-Abo | eigenes Netz |
| Anmeldung | **im Namen des Benutzers** (On-Behalf-Of) | API-Key oder Entra-App | keine |
| Scans lesen | nur wenn Beleg in SharePoint liegt | ✅ | ✅ mit Vision-Modell |
| Strukturierte Ausgabe | per Anweisung + strenge Validierung | nativ (JSON-Schema) | nativ (JSON-Schema) |
| Websuche | wird bei jeder Anfrage **abgeschaltet** | – | – |

### Richtlinie pro Mandat (Revisionsgeheimnis)
`PUT /api/engagements/:id/ai-policy` `{ aiPolicy }` – nur Administratoren:
- `disabled` (Standard): keine KI
- `local_only`: nur Ollama
- `tenant`: zusätzlich M365 Copilot und Azure AI Foundry

Vor jedem KI-Aufruf kann der Client `GET /api/engagements/:id/ai-preview?task=…` abfragen und anzeigen,
**wohin die Daten gehen**. Jeder Aufruf wird in `ai_calls` protokolliert (Benutzer, Anbieter, Ziel-Host,
Umfang, Dauer, Status, SHA-256 der Anfrage – **ohne Inhalte**).

### KI-Endpunkte
| | |
|---|---|
| `GET /api/ai/providers` | Anbieter, Fähigkeiten, Konfigurationsprobleme, Routing |
| `POST /api/ai/providers/:id/test` | Verbindungstest ohne Mandantendaten |
| `PUT /api/ai/routing` | Aufgabe → Anbieter (Admin) |
| `POST /api/evidence/:id/ai-extract` | Belegauswertung / OCR (optional `{ provider }`) |
| `POST /api/match-runs/:run/accounts/:acc/ai-review` | KI-Einschätzung zu einem Treffer |
| `GET /api/engagements/:id/ai-calls` | KI-Nutzungsprotokoll |

Für Copilot sendet der Client das Microsoft-Token des Benutzers im Header `X-MS-Assertion`
(ab Schritt 3 automatisch über die Microsoft-Anmeldung der Windows-App).

### Einrichtung Microsoft 365 Copilot (durch eure IT)
1. **Lizenz**: Jeder Benutzer, der Copilot-Funktionen nutzt, braucht eine Microsoft-365-Copilot-Lizenz.
2. **Variante wählen**:
   - `workiq` (empfohlen, allgemein verfügbar): Administrator aktiviert **Work IQ** im Tenant; Abrechnung über **Copilot Credits**; Berechtigung `WorkIQAgent.Ask`.
   - `graph-beta`: Vorschau-API, über die Copilot-Lizenz abgedeckt, benötigt 7 delegierte Graph-Berechtigungen; Microsoft unterstützt Beta-APIs nicht für den Produktivbetrieb.
3. **App-Registrierung** in Entra ID für den Server: Client-Secret (oder Zertifikat), delegierte Berechtigung gemäss Variante, **Administratorzustimmung** erteilen.
4. Die Windows-App (Schritt 3) erhält eine eigene Registrierung, die ein Token für die Server-API anfordert; der Server tauscht es per On-Behalf-Of gegen das Copilot-Token.
5. Werte in `.env` eintragen (`ENTRA_*`, `M365_COPILOT_*`) und mit `POST /api/ai/providers/m365-copilot/test` prüfen.

### Einrichtung Azure AI Foundry
Ressource in **Switzerland North** anlegen, Modell mit Bilderkennung bereitstellen (Deployment-Name in
`AZURE_FOUNDRY_DEPLOYMENT`), Zugriff per Entra-App (Rolle *Cognitive Services OpenAI User*) oder API-Key.

### Einrichtung Ollama
Auf einem internen Server `ollama pull <modell>` für Text und ein Vision-Modell für Scans; Adresse in
`OLLAMA_BASE_URL`. Der Verbindungstest meldet fehlende Modelle.

## Bekannte Grenzen
- Vorzeichenprüfung nur für Aktivkonten bei `signed` automatisch; die KI-Beurteilung weist zusätzlich auf Vorzeichenfragen hin.
- Stichtagsprüfung nur, wenn eine KI-Belegauswertung vorliegt.
- Copilot liest Scans nur aus SharePoint; das automatische Ablegen von Belegen in SharePoint folgt mit der Microsoft-Anmeldung in Schritt 3.
- Die Anbieter-Module sind gegen nachgebildete Schnittstellen gemäss Herstellerdokumentation getestet; ein Test gegen euren echten Tenant steht aus.
- `.xls` (Excel 97–2003) wird nicht gelesen → als `.xlsx`/`.csv` speichern.
- Benutzerverwaltung ist bewusst einfach (statische Tokens); Rollen/SSO in Schritt 3.

## Struktur
```
src/
  domain/            reine Fachlogik, ohne I/O, vollständig getestet
    amount.ts        Betragsparser (Rappen)
    trialBalance/    Parser, KMU-Gruppen, Validierung
    evidence/        Textgewinnung aus Belegen
    matching/        Betragsextraktion + Matching-Engine
  routes/            REST-API (Fastify, zod-validiert)
  db/                PostgreSQL, Migrationen
  lib/               Speicher, Prüfprotokoll, Geldformat
  ai/                KI-Schicht: Anbieter, Richtlinie, Aufgaben, Verifikation
test/                Unit- und Integrationstests (81), inkl. nachgebildeter KI-Schnittstellen
```
