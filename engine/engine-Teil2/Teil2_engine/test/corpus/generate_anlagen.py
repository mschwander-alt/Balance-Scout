"""Sachanlagen: Saldobilanz + Kontoblätter (Abacus-Aufbau mit Gegenkonto) – erfundene Daten.
Soll-Lösung: siehe test/anlagen.test.ts"""
import sys, os, openpyxl
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas
from reportlab.lib.units import mm
OUT = sys.argv[1]; os.makedirs(OUT, exist_ok=True)
def chf(c): return ('-' if c < 0 else '') + f"{abs(c)/100:,.2f}".replace(',', "'")
# Konto: (Name, Saldovortrag, Buchungen [(Datum, Text, Gegenkonto, Betrag)])
L = {
  '1500': ('Maschinen und Apparate', 12000000, [('15.03.2025', 'Kauf CNC-Fräse', '2000', 6000000), ('31.12.2025', 'Abschreibung 2025', '6800', -5400000)]),  # Basis 180'000, 30 % = 54'000
  '1510': ('Mobiliar und Einrichtungen', 4000000, [('31.12.2025', 'Abschreibung 2025', '6800', -1000000)]),  # 25 %
  '1530': ('Fahrzeuge', 6000000, [('30.06.2025', 'Verkauf VW Transporter', '8510', -1500000), ('31.12.2025', 'Abschreibung 2025', '6800', -2700000)]),  # Basis 45'000, 60 % > 40 %
  '1600': ('Geschäftsliegenschaft', 100000000, [('31.12.2025', 'Abschreibung Gebäude', '6800', -4000000)]),  # 4 %
}
tb = [(n, v[0], v[1] + sum(p[3] for p in v[2])) for n, v in L.items()]
tb += [('1020', 'Bank', 5000000), ('2800', 'Aktienkapital', -100000000), ('6800', 'Abschreibungen', 13100000), ('3200', 'Ertrag', -sum(x[2] for x in tb) - 5000000 + 100000000 - 13100000)]
wb = openpyxl.Workbook(); ws = wb.active
ws.append(['Muster Bau AG']); ws.append(['Saldobilanz per 31.12.2025']); ws.append([]); ws.append(['Konto', 'Bezeichnung', 'Saldo 2025', 'Saldo 2024'])
for n, name, c in tb: ws.append([int(n), name, c / 100, None])
wb.save(f'{OUT}/Saldobilanz_2025.xlsx')
c = canvas.Canvas(f'{OUT}/Kontoblaetter_2025.pdf', pagesize=A4)
for i, (no, (name, opening, posts)) in enumerate(L.items(), 1):
    c.setFont('Helvetica-Bold', 11); c.drawString(15*mm, 285*mm, f'Konto {no} {name}')
    c.setFont('Helvetica', 9); c.drawString(15*mm, 280*mm, 'Detail nach Belegdatum (01.01.2025 - 31.12.2025), Geschäftsjahr 2025, Währung CHF')
    c.setFont('Helvetica-Bold', 8); c.drawString(15*mm, 266*mm, 'BelDatum Text'); c.drawString(95*mm, 266*mm, 'Gegenko A Beleg')
    for x, t in [(150, 'Soll'), (172, 'Haben'), (195, 'Saldo')]: c.drawRightString(x*mm, 266*mm, t)
    c.setFont('Helvetica', 8); y = 258*mm; c.drawString(15*mm, y, 'Saldovortrag'); c.drawRightString(195*mm, y, chf(opening)); y -= 5*mm
    bal = opening
    for j, (d, t, gk, amt) in enumerate(posts):
        bal += amt; c.drawString(15*mm, y, d); c.drawString(35*mm, y, t); c.drawString(95*mm, y, f'{gk} F {200+j}')
        c.drawRightString((150 if amt > 0 else 172)*mm, y, chf(abs(amt))); c.drawRightString(195*mm, y, chf(bal)); y -= 5*mm
    c.drawString(15*mm, y, 'Saldovortrag'); c.drawRightString(195*mm, y, chf(opening)); y -= 5*mm
    c.drawString(15*mm, y, 'Saldo Buchungsjahr'); c.drawRightString(195*mm, y, chf(bal))
    c.setFont('Helvetica', 7); c.drawString(15*mm, 10*mm, f'Lizenz: Muster Bau AG | MS | Seite {i}'); c.showPage()
c.save(); print('ok', tb)
