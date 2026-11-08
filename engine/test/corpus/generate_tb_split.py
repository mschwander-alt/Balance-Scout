"""Bilanz und Erfolgsrechnung mit Gruppen und Zwischensummen (wie Export aus Abacus/Bexio):
getrennt (Bilanz.xlsx + Erfolgsrechnung.pdf) und in einer Datei auf zwei Blättern (+ Deckblatt)."""
import sys, os, openpyxl
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas
from reportlab.lib.units import mm

SRC, OUT = sys.argv[1], sys.argv[2]
os.makedirs(OUT, exist_ok=True)
ws = openpyxl.load_workbook(SRC).active
acc = [(str(r[0]), r[1], r[2], r[3]) for r in ws.iter_rows(min_row=5, values_only=True) if r[0]]
GROUPS = [  # (Nummer, Bezeichnung, Präfixe)
    ('1', 'AKTIVEN', None), ('10', 'Umlaufvermögen', None),
    ('100', 'Flüssige Mittel', ('100', '101', '102')), ('106', 'Wertschriften', ('106',)),
    ('110', 'Forderungen aus Lieferungen und Leistungen', ('110',)), ('114', 'Übrige kurzfristige Forderungen', ('117',)),
    ('120', 'Vorräte', ('12',)), ('130', 'Aktive Rechnungsabgrenzungen', ('13',)),
    ('14', 'Anlagevermögen', None), ('150', 'Mobile Sachanlagen', ('15',)),
    ('2', 'PASSIVEN', None), ('20', 'Kurzfristiges Fremdkapital', None),
    ('200', 'Verbindlichkeiten aus Lieferungen und Leistungen', ('200',)), ('210', 'Kurzfristige verzinsliche Verbindlichkeiten', ('210',)),
    ('220', 'Übrige kurzfristige Verbindlichkeiten', ('22',)), ('230', 'Passive Rechnungsabgrenzungen', ('23',)),
    ('24', 'Langfristiges Fremdkapital', ('24',)), ('28', 'Eigenkapital', ('28', '29')),
    ('3', 'BETRIEBSERTRAG', ('3',)), ('4', 'MATERIALAUFWAND', ('4',)), ('5', 'PERSONALAUFWAND', ('5',)),
    ('6', 'ÜBRIGER BETRIEBLICHER AUFWAND', ('6',)),
]

def rows_for(classes):
    out = []
    for num, name, pref in GROUPS:
        if num[0] not in classes: continue
        out.append((num, name, None, None))
        if pref:
            items = [a for a in acc if a[0].startswith(pref)]
            for a in items: out.append(a)
            out.append((num, f'Total {name}', round(sum(a[2] for a in items), 2), round(sum(a[3] for a in items), 2)))
    return out

def sheet(ws, title, rows):
    ws.append(['Alpenblick Treuhand AG']); ws.append([f'{title} per 31.12.2025']); ws.append([])
    ws.append(['Konto', 'Bezeichnung', 'Saldo 2025', 'Saldo 2024'])
    for r in rows: ws.append([int(r[0]) if r[0] else None, r[1], r[2], r[3]])

bil, er = rows_for('12'), rows_for('3456')
wb = openpyxl.Workbook(); sheet(wb.active, 'Bilanz', bil); wb.active.title = 'Bilanz'; wb.save(f'{OUT}/Bilanz_2025.xlsx')
wb = openpyxl.Workbook(); d = wb.active; d.title = 'Deckblatt'; d.append(['Jahresrechnung 2025']); d.append(['Alpenblick Treuhand AG'])
sheet(wb.create_sheet('Bilanz'), 'Bilanz', bil); sheet(wb.create_sheet('Erfolgsrechnung'), 'Erfolgsrechnung', er)
wb.save(f'{OUT}/Jahresrechnung_2025.xlsx')

def chf(x): return '' if x is None else ('-' if x < 0 else '') + f"{abs(x):,.2f}".replace(',', "'")
c = canvas.Canvas(f'{OUT}/Erfolgsrechnung_2025.pdf', pagesize=A4)
c.setFont('Helvetica-Bold', 13); c.drawString(20 * mm, 280 * mm, 'Alpenblick Treuhand AG')
c.setFont('Helvetica', 10); c.drawString(20 * mm, 273 * mm, 'Erfolgsrechnung 01.01.–31.12.2025 (in CHF)')
y = 260 * mm
c.setFont('Helvetica-Bold', 9)
for x, t, r in [(20, 'Konto', 0), (38, 'Bezeichnung', 0), (150, 'Saldo 2025', 1), (188, 'Saldo 2024', 1)]:
    (c.drawRightString if r else c.drawString)(x * mm, y, t)
y -= 7 * mm
for num, name, a, b in er:
    total = name.startswith('Total') or a is None
    c.setFont('Helvetica-Bold' if total else 'Helvetica', 9)
    c.drawString(20 * mm, y, num); c.drawString(38 * mm, y, name)
    c.drawRightString(150 * mm, y, chf(a)); c.drawRightString(188 * mm, y, chf(b)); y -= 6 * mm
c.save()
print('ok', len(bil), len(er))
