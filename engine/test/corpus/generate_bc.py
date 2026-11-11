"""Business Central „Fibukonto – Kontoblatt“ (Layout Gegenkontoinfo, ein Excel-Blatt je Konto) mit indirekter
Abschreibung (Wertberichtigungskonten) + Saldobilanz – erfundene Daten (Muster Maschinen AG).
Soll-Lösung: siehe test/bc.test.ts"""
import sys, os, openpyxl
OUT = sys.argv[1]; os.makedirs(OUT, exist_ok=True)

# Konto: (Name, Anfangssaldo in Rappen, Buchungen [(Datum, Beleg, Text, Art, Gegenkonto, Gegenkonto-Bez., Betrag)])
L = {
  '1020': ('Bank Muster CHF', 25000000, [
    ('02.01.25', 'G00012', 'Miete Schrankfach 2025', 'F', '6940', 'Bankspesen', -40000),           # Jahreszahl im Text ≠ Gegenkonto
    ('20.03.25', 'ZLG00031', 'Zahlung Muster Lieferant AG', 'K', 'KR000123', 'Muster Lieferant AG', -7840000),
    ('30.06.25', 'ZLG00044', 'Verkaufserlös 006001 Drehbank', 'F', '8510', 'Ausserordentlicher Ertrag', 500000),
  ]),
  '1500': ('Maschinen und Apparate', 50000000, [
    ('15.03.25', 'ER000101', 'Rech. 4711/Muster Lieferant AG CNC-Fräse', '', '006050', 'CNC-Fräse', 8000000),
    ('15.03.25', 'ER000101', 'Rech. 4711/Muster Lieferant AG CNC-Fräse', '', '006050', 'CNC-Fräse', -160000),   # Skonto = Minderung Zugang
    ('30.06.25', 'AN00007', 'Drehbank Weiler', 'F', '8510', 'Ausserordentlicher Ertrag', -4000000),             # Abgang Anschaffungswert
  ]),
  '1501': ('Abschr. und Wertberichtigungen Maschinen', -30000000, [
    ('31.03.25', 'AN00003', 'Abschreibungen März 2025 CNC-Fräse', '', '006050', 'CNC-Fräse', -1500000),
    ('30.06.25', 'AN00007', 'Drehbank Weiler', 'F', '8510', 'Ausserordentlicher Ertrag', 3600000),              # Auflösung bei Abgang
    ('30.06.25', 'AN00006', 'Abschreibungen Juni 2025', '', '006050', 'CNC-Fräse', -1500000),
    ('30.09.25', 'AN00009', 'Abschreibungen September 2025', '', '006050', 'CNC-Fräse', -1500000),
    ('31.12.25', 'AN00012', 'Abschreibungen Dezember 2025', '', '006050', 'CNC-Fräse', -1500000),
    ('31.12.25', '2025-14', 'Korr. Differenz Übernahmebilanz 2014', 'F', '6800', 'Abschreibungen Sachanlagen', 50000),  # Korrektur Abschreibung
  ]),
  '1510': ('Mobiliar und Einrichtungen', 4000000, [
    ('10.05.25', 'ER000140', 'Rech. 815/Büro Muster GmbH Regale', 'K', 'KR000140', 'Büro Muster GmbH', 1200000),
    ('31.12.25', 'G00999', 'Abschreibung 2025', 'F', '6800', 'Abschreibungen Sachanlagen', -1300000),  # direkte Methode
  ]),
  '1530': ('Fahrzeuge', 12000000, []),
  '1531': ('Abschr. und Wertberichtigungen Fahrzeuge', -8000000, [
    ('31.12.25', 'AN00012', 'Abschreibungen Dezember 2025', '', '006070', 'Lieferwagen', -1600000),
  ]),
  '2000': ('Kreditoren', 0, [   # Anfangssaldo 0 wird von Business Central nicht gedruckt
    ('15.03.25', 'ER000101', 'Rech. 4711/Muster Lieferant AG', 'K', 'KR000123', 'Muster Lieferant AG', -7840000),
    ('20.03.25', 'ZLG00031', 'Zahlung Muster Lieferant AG', 'B', '1020 BANK CHF', 'Bank Muster', 7840000),
  ]),
  '6800': ('Abschreibungen Sachanlagen', 0, [
    ('31.03.25', 'AN00003', 'Abschreibungen März 2025', 'F', '1501', 'Abschr. und Wertberichtigungen Maschinen', 1500000),
    ('30.06.25', 'AN00006', 'Abschreibungen Juni 2025', 'F', '1501', 'Abschr. und Wertberichtigungen Maschinen', 1500000),
    ('30.09.25', 'AN00009', 'Abschreibungen September 2025', 'F', '1501', 'Abschr. und Wertberichtigungen Maschinen', 1500000),
    ('31.12.25', 'AN00012', 'Abschreibungen Dezember 2025', 'F', '1501', 'Abschr. und Wertberichtigungen Maschinen', 1500000),
    ('31.12.25', 'AN00012', 'Abschreibungen Dezember 2025', 'F', '1531', 'Abschr. und Wertberichtigungen Fahrzeuge', 1600000),
    ('31.12.25', 'G00999', 'Abschreibung 2025', 'F', '1510', 'Mobiliar und Einrichtungen', 1300000),
    ('31.12.25', '2025-14', 'Korr. Differenz Übernahmebilanz 2014', 'F', '1501', 'Abschr. und Wertberichtigungen Maschinen', -50000),
  ]),
}

def fmt_amount(c):
    v = c / 100
    return int(v) if c % 100 == 0 else v

wb = openpyxl.Workbook(); wb.remove(wb.active)
lauf = 1000
for i, (no, (name, opening, posts)) in enumerate(L.items(), 1):
    ws = wb.create_sheet(f'Tabellenblatt{i}')
    def put(r, c, v): ws.cell(row=r, column=c + 1, value=v)
    put(1, 0, 'Fibukonto - Kontoblatt'); put(1, 25, '15. Januar 2026')
    put(2, 0, 'Muster Maschinen AG'); put(2, 29, 'Seite'); put(2, 30, i)
    put(4, 0, 'Periode: 01.01.25..31.12.25'); put(4, 6, 'MUSTER.USER')
    put(6, 0, 'Layout - Gegenkontoinfo')
    for c, h in [(0, 'Buchungs-datum'), (1, 'Belegnr.'), (2, 'Text'), (5, 'Gegenkonto'), (11, 'Gegenkonto Bez.'), (19, 'Laufnr.'), (23, 'Soll'), (26, 'Haben'), (28, 'Saldo')]: put(8, c, h)
    for r in (9, 10, 12): put(r, 0, '')
    put(13, 0, no); put(13, 1, ''); put(13, 2, name)
    put(14, 0, ''); put(14, 2, 'Anfangssaldo am 01.01.25'); put(14, 19, ''); put(14, 23, '')
    if opening: put(14, 28, fmt_amount(opening))
    r = 15; bal = opening; soll = haben = 0
    for (d, beleg, text, art, gk, gkname, amt) in posts:
        bal += amt; lauf += 1
        put(r, 0, d); put(r, 1, beleg); put(r, 2, text); put(r, 5, art); put(r, 8, gk); put(r, 11, gkname); put(r, 19, lauf)
        if amt > 0: put(r, 23, fmt_amount(amt)); put(r, 26, ''); soll += amt
        else: put(r, 23, ''); put(r, 26, fmt_amount(-amt)); haben -= amt
        put(r, 28, fmt_amount(bal)); r += 1
    put(r, 0, ''); put(r + 1, 0, '')
    put(r + 2, 0, ''); put(r + 2, 2, 'Endsaldo'); put(r + 2, 23, fmt_amount(soll) if soll else 0); put(r + 2, 26, fmt_amount(haben) if haben else 0); put(r + 2, 28, fmt_amount(bal))
wb.save(f'{OUT}/Fibu-Kontoblaetter_2025.xlsx')

# Saldobilanz (Schlusssalden) – Gegenposten Eigenkapital/Ertrag, damit Soll = Haben
tb = [(no, name, opening + sum(p[6] for p in posts)) for no, (name, opening, posts) in L.items()]
rest = -sum(x[2] for x in tb)
tb += [('2800', 'Aktienkapital', -10000000), ('3200', 'Ertrag', rest + 10000000)]
wb = openpyxl.Workbook(); ws = wb.active
ws.append(['Muster Maschinen AG']); ws.append(['Saldobilanz per 31.12.2025']); ws.append([]); ws.append(['Konto', 'Bezeichnung', 'Saldo 2025', 'Saldo 2024'])
for n, name, c in tb: ws.append([int(n), name, c / 100, None])
wb.save(f'{OUT}/Saldobilanz_2025.xlsx')
print('ok', tb)
