"""Fremdwährung: Saldobilanz (CHF), Kontoblätter (Abacus-Aufbau, PDF + Excel), Nachweise in EUR/USD, ESTV-Kursliste.
Erfundene Daten. Soll-Lösung siehe Tests (test/fx.test.ts)."""
import sys, os, openpyxl
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas
from reportlab.lib.units import mm
OUT = sys.argv[1]; os.makedirs(f'{OUT}/Kunde/Bank', exist_ok=True); os.makedirs(f'{OUT}/Kunde/Debitoren', exist_ok=True)
def chf(c): return ('-' if c < 0 else '') + f"{abs(c)/100:,.2f}".replace(',', "'")

# Saldobilanz in CHF (Fremdwährungskonten zum Stichtagskurs bzw. mit Bewertungsdifferenz)
acc = [('1020', 'Bank UBS CHF', 10000000), ('1025', 'Bank UBS Geschäftskonto', 4652500),  # EUR 50'000 x 0.9305 = 46'525.00
       ('1105', 'Debitoren Ausland', 795000),  # USD 10'000 x 0.79225 = 7'922.50 -> Bewertungsdifferenz 27.50
       ('2000', 'Kreditoren', -2000000), ('2800', 'Aktienkapital', -10000000), ('3200', 'Handelserlös', -9000000), ('4200', 'Warenaufwand', 5552500)]
wb = openpyxl.Workbook(); ws = wb.active
ws.append(['Muster Export AG']); ws.append(['Saldobilanz per 31.12.2025']); ws.append([])
ws.append(['Konto', 'Bezeichnung', 'Saldo 2025', 'Saldo 2024'])
for n, name, c in acc: ws.append([int(n), name, c / 100, None])
wb.save(f'{OUT}/Saldobilanz_2025.xlsx')

# Kontoblätter im Abacus-Aufbau
ledger = {
  '1020': ('Bank UBS CHF', 'CHF', 8000000, [('15.03.2025', 'Zahlung Kunde', 3200, 3000000), ('30.06.2025', 'Lieferant', 2000, -1000000)]),
  '1025': ('Bank UBS Geschäftskonto', 'EUR', 4000000, [('12.05.2025', 'Zahlung Kunde EU', 1105, 1500000), ('20.11.2025', 'Spesen', 6800, -500000)]),
  '1105': ('Debitoren Ausland', 'USD', 0, [('15.12.2025', 'Rechnung 9001', 3200, 1000000)]),
}
c = canvas.Canvas(f'{OUT}/Kontoblaetter_2025.pdf', pagesize=A4); page = 0
for no, (name, cur, opening, posts) in ledger.items():
    page += 1
    c.setFont('Helvetica-Bold', 11); c.drawString(15*mm, 285*mm, f'Konto {no} {name}')
    c.setFont('Helvetica', 9); c.drawString(15*mm, 280*mm, f'Detail nach Belegdatum (01.01.2025 - 31.12.2025), Geschäftsjahr 2025, Währung {cur}')
    c.drawString(15*mm, 275*mm, '10 Muster Export AG')
    p = '' if cur == 'CHF' else f'{cur} '
    c.setFont('Helvetica-Bold', 8); c.drawString(15*mm, 266*mm, 'BelDatum Text'); c.drawString(95*mm, 266*mm, 'Gegenko A Beleg')
    for x, t in [(150, f'{p}Soll'), (172, f'{p}Haben'), (195, f'{p}Saldo')]: c.drawRightString(x*mm, 266*mm, t)
    c.setFont('Helvetica', 8); y = 258*mm
    c.drawString(15*mm, y, 'Saldovortrag'); c.drawRightString(195*mm, y, chf(opening)); y -= 5*mm
    bal = opening; soll = haben = 0
    for i, (d, t, gk, amt) in enumerate(posts):
        bal += amt
        c.drawString(15*mm, y, d); c.drawString(35*mm, y, t); c.drawString(95*mm, y, f'{gk} F {100+i}')
        if amt > 0: c.drawRightString(150*mm, y, chf(amt)); soll += amt
        else: c.drawRightString(172*mm, y, chf(-amt)); haben -= amt
        c.drawRightString(195*mm, y, chf(bal)); y -= 5*mm
    c.drawString(15*mm, y, 'Saldo 01.01.2025 - 31.12.2025'); c.drawRightString(150*mm, y, chf(soll)); c.drawRightString(172*mm, y, chf(haben)); c.drawRightString(195*mm, y, chf(bal - opening)); y -= 5*mm
    c.drawString(15*mm, y, 'Saldovortrag'); c.drawRightString(195*mm, y, chf(opening)); y -= 5*mm
    c.drawString(15*mm, y, 'Saldo Buchungsjahr'); c.drawRightString(195*mm, y, chf(bal))
    c.setFont('Helvetica', 7); c.drawString(15*mm, 10*mm, f'Lizenz: Muster Export AG | MS | 06.02.2026 | 19:49 Seite {page}')
    c.showPage()
c.save()
wb = openpyxl.Workbook(); wb.remove(wb.active)
for no, (name, cur, opening, posts) in ledger.items():
    ws = wb.create_sheet(f'_{no}_{name.replace(" ", "_")}'[:31]); p = '' if cur == 'CHF' else f'{cur} '
    ws.append(['BelDatum', 'Text', None, 'Gegenkonto', 'A', 'Beleg', f'{p}Soll', f'{p}Haben', f'{p}Saldo']); ws.append(['Saldovortrag', None, None, None, None, None, None, None, opening / 100])
    bal = opening
    for i, (d, t, gk, amt) in enumerate(posts):
        bal += amt; ws.append([d, t, None, gk, 'F', str(100 + i), amt / 100 if amt > 0 else None, -amt / 100 if amt < 0 else None, bal / 100])
    ws.append(['Saldovortrag', None, None, None, None, None, None, None, opening / 100]); ws.append(['Saldo Buchungsjahr', None, None, None, None, None, None, None, bal / 100])
wb.save(f'{OUT}/Kontoblaetter_2025.xlsx')

# Nachweise in Fremdwährung
def letter(path, lines):
    c = canvas.Canvas(path, pagesize=A4); y = 270*mm
    for t, bold in lines:
        c.setFont('Helvetica-Bold' if bold else 'Helvetica', 10); c.drawString(20*mm, y, t); y -= 7*mm
    c.save()
letter(f'{OUT}/Kunde/Bank/UBS_EUR_Kontoauszug.pdf', [('UBS Switzerland AG', True), ('Kontoauszug Geschäftskonto EUR', False), ('IBAN CH12 0023 0230 1234 5678 9', False),
       ('Datum Text Betrag Saldo', True), ('20.11.2025 Spesen -5\'000.00 50\'000.00', False), ("Saldo per 31.12.2025 EUR 50'000.00", True)])
letter(f'{OUT}/Kunde/Bank/UBS_CHF_Kontoauszug.pdf', [('UBS Switzerland AG', True), ('Kontoauszug Konto CHF', False), ("Saldo per 31.12.2025 CHF 100'000.00", True)])
letter(f'{OUT}/Kunde/Debitoren/Saldobestaetigung_USD.pdf', [('Saldobestätigung per 31.12.2025', True), ('Debitor: Atlantic Trading Inc.', False), ("Offener Saldo USD 10'000.00", True)])
# Kontoblatt liegt (aus Versehen) auch im Kundenordner – darf nicht als Nachweis zählen
import shutil; shutil.copy(f'{OUT}/Kontoblaetter_2025.pdf', f'{OUT}/Kunde/Kontoblaetter_Kopie.pdf')

# ESTV-Kursliste (Auszug, Aufbau wie Original)
c = canvas.Canvas(f'{OUT}/ESTV_Kursliste_2025.pdf', pagesize=A4)
c.setFont('Helvetica-Bold', 10); c.drawString(30*mm, 285*mm, 'Devisen - Banknoten / Devises - Billets de banque / Divise - Biglietti di banca'); c.drawString(90*mm, 279*mm, '31.12.2025')
c.setFont('Helvetica', 8); c.drawString(15*mm, 270*mm, 'Land Währung Freie Devise Kurs für Banknoten'); c.drawString(110*mm, 264*mm, 'VN/NV CHF CHF')
rows = [('Dänemark', 'DKK Krone', 100, '2 951 004', '12.458100', '11.960000'), ('Europäische Währungsunion', 'EUR Euro', 1, '2 951 012', '0.930500', '0.910600'),
        ('Grossbritannien', 'GBP Pfund', 1, '2 951 154', '1.065681', '1.005800'), ('Japan', 'JPY Yen', 100, '2 951 035', '0.505400', '0.461400'),
        ('USA', 'USD Dollar', 1, '2 951 145', '0.792250', '0.753200'), ('Algerien', 'DZD Dinar', 100, '2 825 749', '0.611400', '-')]
y = 256*mm
for land, cur, unit, val, dev, bn in rows:
    c.drawString(15*mm, y, land); c.drawString(70*mm, y, cur); c.drawRightString(110*mm, y, str(unit)); c.drawRightString(135*mm, y, val); c.drawRightString(160*mm, y, dev); c.drawRightString(185*mm, y, bn); y -= 6*mm
c.save()
print('ok')
