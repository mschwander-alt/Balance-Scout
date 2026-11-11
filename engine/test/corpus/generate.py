"""
Realistischer Testsatz "Alpenblick Treuhand AG", Stichtag 31.12.2025.
Erzeugt Saldobilanz, Kundenordner mit Unterordnern (PDF, Scans, Foto, xlsx, xls, docx, Störfälle)
und die Soll-Lösung (truth.json): für jedes Konto der erwartete Beleg.
Aufruf: python3 generate.py <Zielordner>
"""
import io, json, os, random, sys
from PIL import Image, ImageDraw, ImageFont, ImageFilter, ImageEnhance
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas
from reportlab.lib.units import mm
import openpyxl, xlwt, docx
from openpyxl.drawing.image import Image as XLImage

random.seed(42)
OUT = sys.argv[1]
CUST = os.path.join(OUT, 'Kunde_Upload')
FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'
FONT_MONO = '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf'

def p(*parts):
    path = os.path.join(CUST, *parts); os.makedirs(os.path.dirname(path), exist_ok=True); return path

def chf(x):
    s = f"{abs(x):,.2f}".replace(',', "'")
    return ('-' if x < 0 else '') + s

# ------------------------------------------------------------------ Saldobilanz
ACC = [
    ('1000', 'Kasse', 1890.20, 2384.55),
    ('1020', 'Bank UBS Kontokorrent', 120400.00, 148250.35),
    ('1021', 'PostFinance', 18000.00, 23901.10),
    ('1022', 'Bank ZKB Privatkonto', 29000.00, 31450.00),
    ('1060', 'Wertschriften', 48000.00, 50125.00),
    ('1100', 'Forderungen aus Lieferungen und Leistungen', 79210.00, 87640.20),
    ('1109', 'Delkredere', -3960.00, -4382.00),
    ('1170', 'Vorsteuer MWST', 5100.00, 6210.45),
    ('1176', 'Verrechnungssteuer', 70.00, 105.00),
    ('1200', 'Handelswaren', 42000.00, 45000.00),
    ('1300', 'Aktive Rechnungsabgrenzungen', 2800.00, 3500.00),
    ('1510', 'Mobiliar und Einrichtungen', 15600.00, 12800.00),
    ('2000', 'Verbindlichkeiten aus Lieferungen und Leistungen', -48900.00, -54311.90),
    ('2100', 'Kontokorrentkredit ZKB', -5000.00, 0.00),
    ('2200', 'Geschuldete MWST', -8800.00, -9870.35),
    ('2270', 'Sozialversicherungen', -2900.00, -3215.60),
    ('2300', 'Passive Rechnungsabgrenzungen', -5500.00, -6000.00),
    ('2400', 'Darlehen ZKB', -160000.00, -150000.00),
    ('2450', 'Darlehen Aktionär', -80000.00, -80000.00),
    ('2800', 'Aktienkapital', -100000.00, -100000.00),
    ('2900', 'Gesetzliche Gewinnreserve', -20000.00, -20000.00),
    ('3200', 'Handelserlöse', -612000.00, -655300.00),
    ('4200', 'Warenaufwand', 388000.00, 401500.00),
    ('5000', 'Lohnaufwand', 168000.00, 172400.00),
    ('6000', 'Raumaufwand', 36000.00, 36000.00),
    ('6800', 'Abschreibungen', 2800.00, 2800.00),
]
total = round(sum(a[3] for a in ACC), 2)
ACC.append(('2970', 'Gewinnvortrag / Verlustvortrag', -20000.00, round(-total, 2)))
ACC.sort(key=lambda a: a[0])
os.makedirs(OUT, exist_ok=True)
wb = openpyxl.Workbook(); ws = wb.active; ws.title = 'Saldobilanz'
ws.append(['Alpenblick Treuhand AG']); ws.append(['Saldobilanz per 31.12.2025']); ws.append([])
ws.append(['Konto', 'Bezeichnung', 'Saldo 2025', 'Saldo 2024'])
for a in ACC: ws.append([int(a[0]), a[1], a[3], a[2]])
ws.append([None, 'Total', round(sum(a[3] for a in ACC), 2), None])
wb.save(os.path.join(OUT, 'Saldobilanz_2025.xlsx'))

truth = {}  # Konto -> {file, expect}

# ------------------------------------------------------------------ Helfer
def text_pdf(path, pages, font='Helvetica', size=10):
    c = canvas.Canvas(path, pagesize=A4)
    for lines in pages:
        y = 280 * mm
        for item in lines:
            if isinstance(item, tuple):  # Spalten: (x_mm, text) ...
                for x, t in item:
                    c.setFont(font, size); c.drawString(x * mm, y, t)
            else:
                c.setFont('Helvetica-Bold' if item.isupper() else font, size); c.drawString(20 * mm, y, item)
            y -= 6 * mm
        c.showPage()
    c.save()

def scan_image(lines, rotate=0.8, noise=18000, blur=0.7, contrast=1.0, width=1654, height=2339, size=34):
    img = Image.new('L', (width, height), 246); d = ImageDraw.Draw(img)
    f = ImageFont.truetype(FONT, size); y = 180
    for l in lines:
        d.text((130, y), l, fill=25, font=f); y += int(size * 1.9)
    img = img.rotate(rotate, expand=False, fillcolor=246)
    px = img.load()
    for _ in range(noise):
        x, yy = random.randrange(width), random.randrange(height); px[x, yy] = random.choice([0, 90, 255])
    img = img.filter(ImageFilter.GaussianBlur(blur))
    if contrast != 1.0: img = ImageEnhance.Contrast(img).enhance(contrast)
    return img

def scan_pdf(path, pages):
    imgs = [scan_image(lines) for lines in pages]
    imgs[0].convert('RGB').save(path, 'PDF', resolution=200, save_all=True, append_images=[i.convert('RGB') for i in imgs[1:]])

# ------------------------------------------------------------------ Bank UBS (Text-PDF, 2 Seiten, Spalten)
tx = [('03.11.2025', 'Zahlung Lieferant Huber AG', 12500.00, None), ('15.11.2025', 'Gutschrift Kunde Steiner GmbH', None, 18320.00),
      ('28.11.2025', 'Lohnzahlungen November', 14200.00, None), ('05.12.2025', 'Gutschrift Kunde Meier AG', None, 22150.35),
      ('19.12.2025', 'Miete Dezember', 3000.00, None), ('22.12.2025', 'Gutschrift Kunde Brunner', None, 17080.00)]
bal = 120400.00; rows = []
for dte, t, deb, cred in tx:
    bal = round(bal - (deb or 0) + (cred or 0), 2)
    rows.append(((20, dte), (45, t), (120, chf(deb) if deb else ''), (150, chf(cred) if cred else ''), (178, chf(bal))))
assert round(bal, 2) == 148250.35, bal
text_pdf(p('Bank', 'UBS', 'Kontoauszug.pdf'), [
    ['UBS Switzerland AG', 'Kontoauszug Privatkonto / Kontokorrent', 'Alpenblick Treuhand AG, Bahnhofstrasse 1, 8001 Zürich',
     'IBAN CH93 0027 3273 1234 5678 9', 'Periode 01.11.2025 – 31.12.2025', '',
     ((20, 'Datum'), (45, 'Text'), (120, 'Belastung'), (150, 'Gutschrift'), (178, 'Saldo')),
     ((20, '01.11.2025'), (45, 'Saldovortrag'), (178, chf(120400.00))), *rows[:3]],
    ['UBS Switzerland AG – Seite 2', '', ((20, 'Datum'), (45, 'Text'), (120, 'Belastung'), (150, 'Gutschrift'), (178, 'Saldo')), *rows[3:], '',
     ((20, '31.12.2025'), (45, 'Schlusssaldo zu Ihren Gunsten'), (178, 'CHF ' + chf(148250.35)))],
])
truth['1020'] = {'file': 'Bank/UBS/Kontoauszug.pdf', 'expect': 'Belegt'}

# ------------------------------------------------------------------ PostFinance (anderes Layout, Leerzeichen als Tausender)
text_pdf(p('Bank', 'PostFinance', 'Kontoauszug.pdf'), [[
    'PostFinance AG', 'Kontoauszug Geschäftskonto', 'Kontonummer 85-123456-7', 'Auszug vom 31.12.2025', '',
    ((20, 'Buchungsdatum'), (60, 'Avisierungstext'), (150, 'Betrag CHF')),
    ((20, '12.12.2025'), (60, 'Einzahlung Bareinzahlung'), (150, '2 400.00')),
    ((20, '20.12.2025'), (60, 'E-Banking Zahlung Swisscom'), (150, '-498.90')), '',
    ((20, 'Kontostand per 31.12.2025'), (150, '23 901.10')),
]])
truth['1021'] = {'file': 'Bank/PostFinance/Kontoauszug.pdf', 'expect': 'Belegt'}

# ------------------------------------------------------------------ ZKB (Scan-PDF ohne Textebene)
scan_pdf(p('Bank', 'ZKB', 'Scan_20260112.pdf'), [[
    'Zürcher Kantonalbank', 'Kontoauszug Privatkonto per 31.12.2025', 'IBAN CH44 0070 0110 0012 3456 7', '',
    'Datum       Text                       Betrag        Saldo',
    '01.12.2025  Saldovortrag                            29\'750.00',
    '18.12.2025  Gutschrift Zins                1\'700.00   31\'450.00', '',
    'Schlusssaldo per 31.12.2025      CHF 31\'450.00']])
truth['1022'] = {'file': 'Bank/ZKB/Scan_20260112.pdf', 'expect': 'Prüfen'}

# ------------------------------------------------------------------ Kasse (Handyfoto JPG)
img = scan_image(['Kassenprotokoll / Kassensturz', 'Alpenblick Treuhand AG', 'Datum: 31.12.2025', '',
                  'Noten        1\'950.00', 'Münzen         434.55', '', 'Kassabestand gezählt   CHF 2\'384.55', '',
                  'Visum: M. Keller'], rotate=2.2, noise=30000, blur=1.1, contrast=0.8, width=1500, height=1400, size=40)
img.convert('RGB').save(p('Kasse', 'IMG_4471.jpg'), quality=70)
truth['1000'] = {'file': 'Kasse/IMG_4471.jpg', 'expect': 'Prüfen'}

# ------------------------------------------------------------------ Wertschriften (Text-PDF)
text_pdf(p('Wertschriften', 'Depotauszug_UBS_2025.pdf'), [[
    'UBS Switzerland AG – Depotauszug', 'Bewertung per 31.12.2025', '',
    ((20, 'Titel'), (100, 'Anzahl'), (130, 'Kurs'), (165, 'Wert CHF')),
    ((20, 'Nestlé N'), (100, '200'), (130, '82.15'), (165, chf(16430.00))),
    ((20, 'Novartis N'), (100, '250'), (130, '96.30'), (165, chf(24075.00))),
    ((20, 'iShares SMI ETF'), (100, '74'), (130, '130.00'), (165, chf(9620.00))), '',
    ((20, 'Total Depotwert'), (165, chf(50125.00)))]])
truth['1060'] = {'file': 'Wertschriften/Depotauszug_UBS_2025.pdf', 'expect': 'Belegt'}

# ------------------------------------------------------------------ Debitoren (xlsx, Zahlen numerisch, Total per Formel)
wb = openpyxl.Workbook(); ws = wb.active; ws.title = 'OP Debitoren'
ws.append(['Offene Posten Debitoren per 31.12.2025']); ws.append([])
ws.append(['Kunde', 'Rechnung', 'Datum', 'Betrag'])
deb = [('Steiner GmbH', 'R-2025-118', 23410.00), ('Meier AG', 'R-2025-121', 31230.20), ('Brunner', 'R-2025-124', 18000.00), ('Keller & Co', 'R-2025-127', 15000.00)]
for k, rn, b in deb: ws.append([k, rn, '15.12.2025', b])
ws.append(['Total', None, None, '=SUM(D4:D7)'])
wb.save(p('Debitoren', 'OP_Debitoren_31.12.2025.xlsx'))
# Formelergebnis fehlt in openpyxl-Dateien (wie bei manchen Exporten) -> Total zusätzlich als Text im Fusszeilenblatt
wb = openpyxl.load_workbook(p('Debitoren', 'OP_Debitoren_31.12.2025.xlsx'))
wb['OP Debitoren']['D8'] = 87640.20
wb.save(p('Debitoren', 'OP_Debitoren_31.12.2025.xlsx'))
truth['1100'] = {'file': 'Debitoren/OP_Debitoren_31.12.2025.xlsx', 'expect': 'Belegt'}

# ------------------------------------------------------------------ MWST-Abrechnung (Text-PDF): Vorsteuer und geschuldete MWST
text_pdf(p('Steuern', 'MWST_Abrechnung_Q4_2025.pdf'), [[
    'Eidgenössische Steuerverwaltung ESTV – Hauptabteilung MWST', 'Abrechnung 4. Quartal 2025 (01.10.2025 – 31.12.2025)', '',
    ((20, 'Ziffer 200 Total vereinbarte Entgelte'), (160, chf(171200.00))),
    ((20, 'Ziffer 303 Steuer Normalsatz 8.1 %'), (160, chf(16080.80))),
    ((20, 'Ziffer 400 Vorsteuer auf Material- und DL-Aufwand'), (160, chf(6210.45))),
    ((20, 'Total Vorsteuer'), (160, chf(6210.45))), '',
    ((20, 'Zu bezahlender Betrag (geschuldete Steuer)'), (160, chf(9870.35)))]])
truth['1170'] = {'file': 'Steuern/MWST_Abrechnung_Q4_2025.pdf', 'expect': 'Belegt'}
# Korrigiert nach erstem Lauf: Zahlbetrag der Q4-Abrechnung per Stichtag ist ein gültiger Nachweis der geschuldeten MWST
truth['2200'] = {'file': 'Steuern/MWST_Abrechnung_Q4_2025.pdf', 'expect': 'Belegt'}

# ------------------------------------------------------------------ Verrechnungssteuer (kleiner Betrag)
text_pdf(p('Steuern', 'VSt_Rueckforderung_2025.pdf'), [[
    'Antrag auf Rückerstattung der Verrechnungssteuer 2025', 'Bruttoertrag Dividenden CHF 300.00', 'Verrechnungssteuer 35 % 105.00']])
truth['1176'] = {'file': 'Steuern/VSt_Rueckforderung_2025.pdf', 'expect': 'Prüfen'}

# ------------------------------------------------------------------ Inventar (altes .xls)
wbx = xlwt.Workbook(); sh = wbx.add_sheet('Inventar 2025')
sh.write(0, 0, 'Inventar Handelswaren per 31.12.2025')
for i, (art, menge, preis) in enumerate([('Artikel A', 500, 30.00), ('Artikel B', 300, 50.00), ('Artikel C', 600, 25.00)], start=2):
    sh.write(i, 0, art); sh.write(i, 1, menge); sh.write(i, 2, preis); sh.write(i, 3, menge * preis)
sh.write(6, 0, 'Total Inventar'); sh.write(6, 3, 45000.00)
wbx.save(p('Inventar', 'Inventar_2025.xls'))
truth['1200'] = {'file': 'Inventar/Inventar_2025.xls', 'expect': 'Belegt'}

# ------------------------------------------------------------------ Anlagen: Excel mit eingefügtem Bild (Screenshot)
shot = scan_image(['Anlagenverzeichnis per 31.12.2025', 'Mobiliar Büro         8\'400.00', 'Einrichtung Sitzungszimmer   4\'400.00',
                   'Total Mobiliar und Einrichtungen   12\'800.00'], rotate=0, noise=2000, blur=0.3, width=1400, height=600, size=36)
buf = io.BytesIO(); shot.convert('RGB').save(buf, 'PNG'); buf.seek(0)
wb = openpyxl.Workbook(); ws = wb.active; ws.title = 'Anlagen'; ws['A1'] = 'Anlagenspiegel – siehe Screenshot aus Buchhaltung'
ws.add_image(XLImage(buf), 'A3'); wb.save(p('Anlagen', 'Anlagenspiegel.xlsx'))
truth['1510'] = {'file': 'Anlagen/Anlagenspiegel.xlsx', 'expect': 'Prüfen'}

# ------------------------------------------------------------------ Kreditoren (Word)
d = docx.Document(); d.add_heading('Kreditorenliste per 31.12.2025', 1)
t = d.add_table(rows=1, cols=3); t.rows[0].cells[0].text, t.rows[0].cells[1].text, t.rows[0].cells[2].text = 'Lieferant', 'Rechnung', 'Betrag CHF'
for l, r, b in [('Huber AG', 'H-889', "21'300.00"), ('Swisscom', 'S-1201', "498.90"), ('Grosshandel Ost', 'G-77', "32'513.00")]:
    c = t.add_row().cells; c[0].text, c[1].text, c[2].text = l, r, b
d.add_paragraph("Total offene Posten Kreditoren: CHF 54'311.90")
d.save(p('Kreditoren', 'Kreditoren_OP.docx'))
truth['2000'] = {'file': 'Kreditoren/Kreditoren_OP.docx', 'expect': 'Belegt'}

# ------------------------------------------------------------------ AHV (Scan mit FALSCHEM Stichtag)
scan_pdf(p('Sozialversicherung', 'AHV_Kontoauszug.pdf'), [[
    'Ausgleichskasse Zürich', 'Kontoauszug Beitragskonto', 'Saldo per 30.11.2025 zu unseren Gunsten', '', "Ausstehender Betrag CHF 3'215.60"]])
truth['2270'] = {'file': 'Sozialversicherung/AHV_Kontoauszug.pdf', 'expect': 'Prüfen'}

# ------------------------------------------------------------------ Darlehen
text_pdf(p('Darlehen', 'Darlehensvertrag_ZKB.pdf'), [[
    'Darlehensvertrag', 'Zwischen der Zürcher Kantonalbank und der Alpenblick Treuhand AG', 'Darlehensbetrag: CHF 200\'000.00',
    'Amortisation: CHF 10\'000.00 pro Jahr', 'Zinssatz: 2.15 %']])
text_pdf(p('Darlehen', 'Zinsausweis_ZKB_2025.pdf'), [[
    'Zürcher Kantonalbank – Zins- und Kapitalausweis 2025', 'Fester Vorschuss Nr. 4471-22', '',
    ((20, 'Kapital per 01.01.2025'), (150, chf(160000.00))), ((20, 'Amortisation 30.06.2025'), (150, chf(-10000.00))),
    ((20, 'Saldo per 31.12.2025'), (150, chf(150000.00))), ((20, 'Zinsen 2025'), (150, chf(3332.50)))]])
truth['2400'] = {'file': 'Darlehen/Zinsausweis_ZKB_2025.pdf', 'expect': 'Belegt'}
text_pdf(p('Darlehen', 'Saldobestaetigung_Aktionaer.pdf'), [[
    'Saldobestätigung', 'Hiermit bestätige ich, dass mein Darlehen an die Alpenblick Treuhand AG',
    "per 31.12.2025 einen Saldo zu meinen Gunsten von CHF 80'000.00 aufweist.", '', 'Zürich, 15.01.2026  Hans Aebi']])
truth['2450'] = {'file': 'Darlehen/Saldobestaetigung_Aktionaer.pdf', 'expect': 'Belegt'}

# ------------------------------------------------------------------ Eigenkapital
text_pdf(p('Gesellschaft', 'HR_Auszug.pdf'), [[
    'Handelsregister des Kantons Zürich – Auszug', 'Alpenblick Treuhand AG', 'Aktienkapital: CHF 100\'000.00', 'Liberierung: CHF 100\'000.00',
    'Aktien: 100 Namenaktien zu CHF 1\'000.00']])
truth['2800'] = {'file': 'Gesellschaft/HR_Auszug.pdf', 'expect': 'Prüfen'}

# ------------------------------------------------------------------ ohne Nachweis (im Ordner nicht vorhanden)
for k in ['1109', '1300', '2300', '2900', '2970']:
    truth[k] = {'file': None, 'expect': 'Kein Nachweis'}
truth['2100'] = {'file': None, 'expect': 'Nullsaldo'}

# ------------------------------------------------------------------ Störfälle / irrelevant
text_pdf(p('Diverses', 'Lohnausweis_Keller.pdf'), [['Lohnausweis 2025', 'Bruttolohn 86\'200.00', 'AHV/IV/EO 4\'568.60', 'Nettolohn 72\'915.40']])
text_pdf(p('Diverses', 'AGB_Lieferant.pdf'), [['Allgemeine Geschäftsbedingungen', 'Zahlungsfrist 30 Tage netto.']])
open(p('Diverses', 'defekt.pdf'), 'wb').write(b'%PDF-1.4 kaputt')
open(p('Diverses', 'Mail_Treuhaender.msg'), 'wb').write(b'\xd0\xcf\x11\xe0 binary')
open(p('Diverses', '~$OP_Debitoren.xlsx'), 'wb').write(b'lockfile')

json.dump({'mandate': 'Alpenblick Treuhand AG', 'closingDate': '2025-12-31', 'truth': truth}, open(os.path.join(OUT, 'truth.json'), 'w'), indent=1, ensure_ascii=False)
print('Testsatz erstellt:', OUT)
