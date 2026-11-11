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
Dateien, die nur in der Cloud liegen (OneDrive „Nur online verfügbar“) und nicht geladen werden können,
erscheinen mit einem verständlichen Hinweis statt eines technischen Fehlers.

## Saldobilanz bzw. Bilanz und Erfolgsrechnung
Eine Datei oder **mehrere Dateien** (z. B. Bilanz.xlsx + Erfolgsrechnung.pdf); bei Excel werden **alle Blätter**
gelesen (Blätter ohne Kontenliste wie ein Deckblatt werden ignoriert). Erkannte Kopfzeilen u. a.: „Saldo 2025“, „31.12.2025“,
„Ist 2025“, „GJ 2025“, „Betrag/Vorjahr“, „Aufwand/Ertrag“, „Aktiven/Passiven“, „Soll/Haben“. Hat ein Blatt keine Kopfzeile,
wird der Aufbau eines anderen Blatts derselben Datei übernommen bzw. aus den Daten abgeleitet (mit Hinweis). Die Konten aller Teile werden zusammengeführt.

**Ziffernbereich der Kontonummern (von–bis):** Nur Zeilen, deren Kontonummer so viele Ziffern hat, gelten als Konto.
Gruppen, Zwischensummen und Totale (z. B. „100 Flüssige Mittel“, „Total Umlaufvermögen“) werden ausgeblendet und
nachvollziehbar aufgelistet. Der Bereich wird automatisch vorgeschlagen (häufigste Länge).

**Gruppierung nach KMU-Kontenrahmen:** über die Kontonummer; passt sie nicht (eigener Kontenplan), über die
Bezeichnung (z. B. „Debitoren Inland“ → Forderungen aus L+L) – solche Zuordnungen sind als „bitte prüfen“ markiert.
Hinweis: Das ist eine feste, nachvollziehbare Regelbasis, keine KI.

| Format | Wie |
|---|---|
| Excel `.xlsx`/`.xlsm`/`.xls`, CSV | Spalten werden automatisch erkannt (Konto, Bezeichnung, Saldo **oder** Soll/Haben) |
| **PDF mit Text** (Export aus Abacus, Bexio, Sage, Excel usw.) | Spalten werden aus der Lage der Zahlen auf der Seite rekonstruiert |
| **PDF-Scan** | lokale Texterkennung, danach wie oben; Hinweis „aus Texterkennung – Beträge kontrollieren“ |

- Getrennte Spalten **Soll** und **Haben**: Saldo = Soll − Haben.
- Wiederholte Kopfzeilen auf Folgeseiten, Zwischentitel und Totalzeilen werden übersprungen.
- Kontrolle Soll = Haben und Hinweise werden in der App und im Excel-Bericht angezeigt.

## Prüfregeln (Auszug)
- Beträge in allen CH/DE-Formaten (`1'234.50`, `1 234,50`, `1.234,50`, `(1'234.50)`, `1'234.50-`, `CHF-7'410.00`);
  Datum, IBAN, Uhrzeit, Prozente, Jahreszahlen werden vorher ausgeblendet.
- **Belegt** nur bei exaktem Betrag mit genügend Kontext (Saldo-/Total-Begriff, Kontonummer/-name, Bilanzstichtag
  im Beleg) und ohne Warnhinweis. Sonst **Prüfen** mit Begründung.
- Warnhinweise, die „Belegt“ verhindern: Vorzeichen/Überzug, Mehrdeutigkeit, Fremdwährung,
  **anderer Stichtag im Beleg**, **Betrag aus Texterkennung**.
- Stichtag wird im Beleg gesucht (`31.12.2025`, `31.12.25`, `31. Dezember 2025`, `2025-12-31`).

## Saldobilanz mit Soll/Haben-Spalten (Navision)
- Stehen Soll und Haben in getrennten Spalten – auch zweimal nebeneinander für aktuelles Jahr und Vorjahr
  („Dieses Jahr bis 31.12.2025 | 31.12.2024“) – wird Saldo = Soll − Haben gerechnet; welches Paar das aktuelle
  Jahr ist, entscheidet die Jahreszahl über der Kopfzeile.
- Stehen die Beträge in Excel nicht genau unter „Soll“/„Haben“ (verbundene Kopfzellen), wird die benachbarte
  Spalte mit Beträgen verwendet. Manuell zuordenbar unter „Spalten zuordnen“ (inkl. Soll/Haben Vorjahr).

## Kontoblätter und Fremdwährung
- **Kontoblätter** (Abacus, Navision/Business Central; PDF mit Textebene oder Excel, auch mehrere hundert Seiten –
  rund 400 Seiten in unter 10 Sekunden): je Konto Währung, Saldovortrag, Buchungen (mit Gegenkonto, falls vorhanden),
  Schlusssaldo und Selbstkontrolle (Saldovortrag + Buchungen = Schlusssaldo). Gescannte Kontoblätter werden nicht
  automatisch per Texterkennung gelesen. Kontoblätter sind **kein Nachweis** – liegen sie im Kundenordner, werden sie
  erkannt und vom Abgleich ausgenommen.
- **Business Central „Fibukonto – Kontoblatt“** (Excel, ein Blatt je Konto, Layout Gegenkontoinfo): Kontokopf
  „1500 | Bezeichnung“, leerer Anfangssaldo = 0, Endsaldo Soll | Haben | Saldo, Periode „01.01.25..31.12.25“;
  Gegenkonto nur bei Art F (Sachkonto) – A = Anlage, B = Bank, D/K = Debitor/Kreditor; Belegnummer aus der Spalte.
- **Diagnose:** Werden in einer Kontoblatt-Datei keine Konten erkannt, erscheint ein Hinweis unter „Saldobilanz-Prüfung“
  und im Prüfgebiet; der Diagnosebericht zeigt den Aufbau der ersten Zeilen **ohne Inhalte** (DATUM, BETRAG, NRn, x).
  Liegen die Kontoblätter in einem anderen Geschäftsjahr als der Bilanzstichtag, gibt es ebenfalls einen Hinweis.
- **Fremdwährungskonten** (Währung laut Kontoblatt): Abgleich Fremdwährungssaldo ↔ Fremdwährungsbetrag im Nachweis;
  **Bewertung** Buchwert CHF ↔ Saldo FW × Kurs per Stichtag (Bewertungsdifferenz). CHF-Konten: Kontoblatt ↔ Saldobilanz.
- **ESTV-Kursliste** (PDF „Devisen – Banknoten“ per 31.12.) wird gelesen (Kurs je 1 Einheit, auch bei 100er-Notierung);
  in der App einmal jährlich laden, unterjährig Kurse manuell erfassen.

## Vertiefte Prüfung: Sachanlagen (Anlagespiegel)
- Aus den Kontoblättern je Anlagekonto: Anfangsbestand, Zugänge, Abgänge, Abschreibungen, Umbuchungen, Endbestand;
  Abstimmung mit der Saldobilanz. Konten werden nach Gruppe **und** Bezeichnung vorgeschlagen (nur Aktivkonten;
  Darlehen/Beteiligungen ausgeschlossen) – auch bei eigenen Kontenplänen (z. B. Navision 17xxx).
- Klassierung über Gegenkonto (z. B. 68xx = Abschreibung, 80xx/85xx = Abgang) bzw. Buchungstext („Abschreibung“,
  „AFA“, „Ausbuchung Restwert“, „Verkauf“); je Buchung korrigierbar.
- Abschreibungsanalyse: effektiver Satz = Abschreibung / (Anfangsbestand + Zugänge − Abgänge) gegenüber den
  ESTV-Normalsätzen (Merkblatt A 1995), Kategorie je Konto wählbar; Hinweise bei Überschreitung, Sofortabschreibung,
  Abschreibung auf Land, Differenz zur Saldobilanz. Excel `Analyse_Anlagespiegel.xlsx` (Anlagespiegel + Buchungen).
- **Indirekte Abschreibung:** Wertberichtigungskonten („Abschr. und Wertberichtigungen …“, „WB …“) werden dem
  Anlagekonto davor zugeordnet (z. B. 1501 → 1500) und zusammengefasst: Buchwerte im Anlagespiegel, zusätzlich
  Anschaffungswerte und kumulierte Abschreibungen (Blatt „Anschaffungswerte“). Auf dem WB-Konto gilt Haben =
  Abschreibung, Soll = Auflösung bei Abgang (gleicher Beleg/Tag wie der Abgang) bzw. Korrektur der Abschreibung
  (Gegenkonto 68xx). Haben-Buchungen mit gleichem Beleg wie die Aktivierung (Skonto/Rabatt) mindern den Zugang.
  Zusätzlich Satz vom Anschaffungswert (Vergleich mit halbem ESTV-Satz für lineare Abschreibung).
- **Abstimmung Abschreibungen ↔ Aufwand:** Summe Abschreibungen laut Anlagespiegel gegen die Aufwandkonten 68xx
  bzw. „Abschreibungen …“ laut Saldobilanz (Differenz als Feststellung).

## Durchsicht und Abschluss
Die Analyse legt noch nichts ab. Erst nach der Durchsicht (`finalizeAudit`) entstehen Ablage und Excel:
- **Akzeptieren:** Konto „Prüfen“ → „Belegt“ (mit Visum, Datum, Kommentar).
- **Manuell zuordnen:** Beleg → Konto oder „nicht relevant“ (Ordner `03_Nicht_relevant`). Ziel: jede Datei hat eine Zuordnung.
- **Register** (Standard der Revisionsstelle, in der App änderbar): A Allgemeine Prüfungen (Belege ohne Konto), B Flüssige Mittel,
  D Wertschriften UV, E Forderungen L+L, F Sonstige Forderungen, G IC-Forderungen/-Verbindlichkeiten, I Vorräte, N Beteiligungen,
  Q Passive RA, R Verbindlichkeiten L+L, S Steuerrückstellungen/Steueraufwand, T Langfristige Verbindlichkeiten,
  U Sonstige Verbindlichkeiten, W Rückstellungen. IC und Steuern werden über die Bezeichnung erkannt (Vorrang vor der Nummer);
  abgelegte Dateien heissen dann `B.1_Kontoauszug Bank A.pdf`, `B.2_Kontoauszug Bank B.pdf` (Reihenfolge: Kontonummer, Dateiname).
- **Notizen je Konto:** bei PDF-Belegen als **erste Seite** im abgelegten PDF, bei Excel/Word/Bild als separates
  `B.1_Notiz_<Datei>.pdf`; ausserdem im Excel (Spalte „Kommentar Prüfer“).
- Ein bestehender Excel-Bericht wird nie überschrieben; ein erneuter Abschluss erzeugt „… (2).xlsx“.

## Vertiefte Prüfung: Forderungen aus L+L (Fälligkeitsanalyse)
- Offenposten-Liste der Debitoren wird unter den Kundenunterlagen erkannt: **Abacus**, **Navision / Business Central**
  (auch als Scan per Texterkennung) und **Excel/CSV**-Exporte (Kunde je Zeile).
- Kundenblöcke, Posten, Kundentotale und Gesamttotal(e) je Währung werden gelesen und **gegeneinander abgestimmt**;
  Seitenkopf/-fuss wird ignoriert. Abweichungen (z. B. Lesefehler) werden gemeldet.
- Fälligkeit per **Bilanzstichtag**: Fälligkeitsdatum aus der Liste, sonst Belegdatum + Zahlungsfrist (Standard 30 Tage).
  Altersklassen nicht fällig / 1–30 / 31–60 / 61–90 / > 90 Tage – **nur offene Rechnungen**; Gutschriften und
  Vorauszahlungen separat. Fremdwährungen mit Kurs per Stichtag (je Prüfung einzugeben).
- Abstimmung Total OP-Liste ↔ Saldo Forderungen L+L (ohne Delkredere), Kennzahlen, Kunden-Tabelle, vorgeschlagene Feststellungen.
- Grundlage sind nur Belege, die (nach der Durchsicht) **Konten der Forderungen L+L zugeordnet** sind – ein Beleg kann
  mehreren Konten zugeordnet sein (z. B. eine OP-Liste für 1100/1101/1102); mehrere Listen werden zusammengeführt.
  Die Analyse startet in der App erst auf Knopfdruck.
- Excel `E.x_Analyse_Fälligkeit.xlsx` (Übersicht, Altersstruktur, Kunden, Einzelposten) und PowerPoint
  `E.x_Analyse_Fälligkeit.pptx` (bearbeitbare Diagramme, Kennzahlen, grösste Debitoren, Feststellungen, Notiz) –
  beim Abschluss als Nachweise abgelegt, jederzeit auch einzeln herunterladbar.

## Qualität
Zwei realistische Testsätze mit vorab festgelegter Soll-Lösung (`test/fixtures`, Generator in `test/corpus`):
- **Alpenblick Treuhand AG**: 20 Dateien in 10 Unterordnern (Text-PDF, Scan-PDF, Handyfoto, xlsx, xls, docx,
  Excel mit Bild, defekte/fremde Dateien) – 100 % Fundstellen, 100 % Status, 0 fälschlich „Belegt“.
- **Praxisfallen**: Zufallstreffer, Betrag auf Folgezeile, deutsches Zahlenformat, Kontoüberzug,
  Beträge als Text, sehr schlechter Scan, falscher Stichtag, Saldobilanz als CSV ohne Vorzeichen – 9/9.
- **Saldobilanz als PDF**: Text-PDF über zwei Seiten mit wiederholter Kopfzeile, PDF mit Soll/Haben-Spalten
  und gescannte Saldobilanz – je 27/27 Konten exakt.
- **Bilanz und Erfolgsrechnung getrennt** (Excel + PDF) sowie in einer Datei mit Deckblatt/Bilanz/ER-Blatt, jeweils mit
  Gruppen- und Totalzeilen: mit 4 Ziffern exakt die 27 Konten, gleiches Prüfergebnis.
- **Durchsicht/Abschluss:** Akzeptieren, manuelle Zuordnung, Register-Präfix, Notizseite im PDF, Notiz-PDF, Excel-Spalten.

`npm test` – 140 Tests (inkl. künstlicher OP-Listen im Aufbau von Abacus, Navision-Scan und Business Central sowie Business-Central-Kontoblätter mit indirekter Abschreibung) (Beträge, Saldobilanz, Abgleich, Testsätze, Ablage, Datumserkennung, Excel, Diagnose, Belegvorschau und Fundstellen-Positionen).

## Belegvorschau
`renderPreview(datei, seite)` liefert die Seite als Bild (PDF, Scan, Foto, Bild in Excel), als Tabelle (Excel, CSV)
oder als Text (Word, TXT). Jede Fundstelle enthält ihre **Lage auf der Seite** (`bbox`, relativ 0–1) bzw. die
Zeilennummer – so kann die App die Stelle markieren.

## Kommandozeile
```
npx tsx src/cli.ts --mandat "Muster AG" --stichtag 31.12.2025 --saldobilanz SaBi.xlsx \
  --belege "C:\…\Kunde Upload" [--belege weitere] --ziel "C:\…\Intern\Muster AG\JA 2025" \
  [--modus kopieren|verschieben|keine] [--toleranz 1.00] [--vorzeichen signed|unsigned]
```
Die Saldobilanz darf auch ein PDF sein. Ergebnis: `Saldenabstimmung_<Mandat>_<Stichtag>.xlsx`, `…_Diagnose.txt` (ohne Beträge/Namen),
`01_Zugeordnet/`, `02_Nicht_zugeordnet/`.

## Grenzen
- Handschrift wird nur unzuverlässig erkannt; solche Beträge sind immer „Prüfen“.
- Passwortgeschützte PDFs und E-Mail-Dateien (`.msg`/`.eml`) sowie ZIP-Archive werden noch nicht gelesen.
