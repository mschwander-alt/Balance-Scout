# Balance Scout – Prüf-Engine (lokal)

Liest Saldobilanz und Kundenunterlagen, gleicht jeden Saldo nachvollziehbar ab, erstellt die
Excel-Dokumentation und legt die Belege ab. **Läuft vollständig auf dem PC – keine Cloud, kein Server,
keine Anmeldung, keine Administratorrechte.**

## Was gelesen wird
| Format | Wie |
|---|---|
| PDF mit Text | Textebene, zeilenweise mit Seitenangabe |
| PDF-Scans (auch gemischt) | **lokale Texterkennung** pro Seite (Tesseract, Deutsch + Englisch) |
| Fotos/Bilder (JPG, PNG, TIFF, BMP, WEBP) | lokale Texterkennung mit Bildaufbereitung (Entrauschen, Kontrast, Schwarz-Weiss) |
| Excel `.xlsx`/`.xlsm` | alle sichtbaren Blätter, Zellen exakt; **eingefügte Bilder** per Texterkennung |
| Excel `.xls` (97–2003) | alle Blätter |
| CSV, TXT, Word `.docx` | Text |
| Ordner | rekursiv mit allen Unterordnern; Sperrdateien (`~$…`), `Thumbs.db` usw. werden ignoriert |

Nicht unterstützte oder defekte Dateien werden im Belegverzeichnis mit Grund aufgeführt.

## Prüfregeln (Auszug)
- Beträge in allen CH/DE-Formaten (`1'234.50`, `1 234,50`, `1.234,50`, `(1'234.50)`, `1'234.50-`, `CHF-7'410.00`);
  Datum, IBAN, Uhrzeit, Prozente, Jahreszahlen werden vorher ausgeblendet.
- **Belegt** nur bei exaktem Betrag mit genügend Kontext (Saldo-/Total-Begriff, Kontonummer/-name, Bilanzstichtag
  im Beleg) und ohne Warnhinweis. Sonst **Prüfen** mit Begründung.
- Warnhinweise, die „Belegt“ verhindern: Vorzeichen/Überzug, Mehrdeutigkeit, Fremdwährung,
  **anderer Stichtag im Beleg**, **Betrag aus Texterkennung**.
- Stichtag wird im Beleg gesucht (`31.12.2025`, `31.12.25`, `31. Dezember 2025`, `2025-12-31`).

## Qualität
Zwei realistische Testsätze mit vorab festgelegter Soll-Lösung (`test/fixtures`, Generator in `test/corpus`):
- **Alpenblick Treuhand AG**: 20 Dateien in 10 Unterordnern (Text-PDF, Scan-PDF, Handyfoto, xlsx, xls, docx,
  Excel mit Bild, defekte/fremde Dateien) – 100 % Fundstellen, 100 % Status, 0 fälschlich „Belegt“.
- **Praxisfallen**: Zufallstreffer, Betrag auf Folgezeile, deutsches Zahlenformat, Kontoüberzug,
  Beträge als Text, sehr schlechter Scan, falscher Stichtag, Saldobilanz als CSV ohne Vorzeichen – 9/9.

`npm test` – 76 Tests (Beträge, Saldobilanz, Abgleich, Testsätze, Ablage, Datumserkennung, Excel, Diagnose).

## Kommandozeile
```
npx tsx src/cli.ts --mandat "Muster AG" --stichtag 31.12.2025 --saldobilanz SaBi.xlsx \
  --belege "C:\…\Kunde Upload" [--belege weitere] --ziel "C:\…\Intern\Muster AG\JA 2025" \
  [--modus kopieren|verschieben|keine] [--toleranz 1.00] [--vorzeichen signed|unsigned]
```
Ergebnis: `Saldenabstimmung_<Mandat>_<Stichtag>.xlsx`, `…_Diagnose.txt` (ohne Beträge/Namen),
`01_Zugeordnet/`, `02_Nicht_zugeordnet/`.

## Grenzen
- Handschrift wird nur unzuverlässig erkannt; solche Beträge sind immer „Prüfen“.
- Passwortgeschützte PDFs und E-Mail-Dateien (`.msg`/`.eml`) sowie ZIP-Archive werden noch nicht gelesen.
