"""
Schwieriger Testsatz mit typischen Praxisfallen. Aufruf: python3 generate_hard.py <Zielordner>
"""
import json, os, random, sys
from PIL import Image, ImageDraw, ImageFont, ImageFilter, ImageEnhance
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas
from reportlab.lib.units import mm
import openpyxl

random.seed(7)
OUT = sys.argv[1]; CUST = os.path.join(OUT, 'Upload')
FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'
def p(*parts):
    path = os.path.join(CUST, *parts); os.makedirs(os.path.dirname(path), exist_ok=True); return path

def pdf(path, lines):
    c = canvas.Canvas(path, pagesize=A4); y = 280 * mm
    for item in lines:
        if isinstance(item, tuple):
            for x, t in item: c.setFont('Helvetica', 10); c.drawString(x * mm, y, t)
        else:
            c.setFont('Helvetica', 10); c.drawString(20 * mm, y, item)
        y -= 6 * mm
    c.save()

# Saldobilanz als CSV, Semikolon, ALLE Salden positiv (unsigned), deutsche Zahlen
TB = [
    ('1020', 'Bank Raiffeisen', '148.250,35', 'aktiv'),
    ('1021', 'Bank Valiant', '7.410,00', 'aktiv'),          # Überzug! Bank zeigt -7'410.00
    ('1100', 'Debitoren', '64.310,40', 'aktiv'),
    ('1101', 'Debitoren Ausland', '12.000,00', 'aktiv'),   # nur Zufallstreffer im Lohnausweis
    ('2000', 'Kreditoren', '33.871,15', 'passiv'),
    ('2400', 'Bankdarlehen BEKB', '250.000,00', 'passiv'),
    ('2410', 'Hypothek', '480.000,00', 'passiv'),           # Beleg: anderer Stichtag
    ('2800', 'Aktienkapital', '100.000,00', 'passiv'),
    ('1000', 'Kasse', '1.236,80', 'aktiv'),                 # schlechter Scan
]
os.makedirs(OUT, exist_ok=True)
with open(os.path.join(OUT, 'SaBi.csv'), 'w', encoding='latin1') as f:
    f.write('Kto-Nr;Kontobezeichnung;Saldo;Vorjahr\n')
    for k, n, s, _ in TB: f.write(f'{k};{n};{s};0,00\n')

truth = {}
# 1) Betrag auf der Folgezeile, deutsches Format
pdf(p('Banken', 'Raiffeisen_Dez.pdf'), ['Raiffeisenbank Thunersee', 'Kontoauszug per 31.12.2025', '', 'Schlusssaldo zu Ihren Gunsten', ((150, 'CHF 148.250,35'),)])
truth['1020'] = {'file': 'Banken/Raiffeisen_Dez.pdf', 'expect': 'Belegt'}
# 2) Überzug mit Minus, Betrag an CHF geklebt
pdf(p('Banken', 'Valiant.pdf'), ['Valiant Bank AG', 'Kontoauszug per 31.12.2025', ((20, 'Saldo zu unseren Gunsten'), (150, 'CHF-7\'410.00'))])
truth['1021'] = {'file': 'Banken/Valiant.pdf', 'expect': 'Prüfen'}
# 3) Excel mit Beträgen als TEXT
wb = openpyxl.Workbook(); ws = wb.active; ws.title = 'Debitoren'
ws.append(['Offene Posten per 31.12.2025']); ws.append(['Kunde', 'Betrag'])
ws.append(['A AG', "40'000.00"]); ws.append(['B GmbH', "24'310.40"]); ws.append(['Total Debitoren', "64'310.40"])
wb.save(p('Debitoren', 'OP_Liste.xlsx'))
truth['1100'] = {'file': 'Debitoren/OP_Liste.xlsx', 'expect': 'Belegt'}
# 4) Zufallstreffer: Lohnausweis enthält 12'000.00 (Konto 1101 hat keinen echten Nachweis)
pdf(p('Personal', 'Lohnausweis_2025.pdf'), ['Lohnausweis 2025', ((20, 'Bonus'), (150, "12'000.00")), ((20, 'Bruttolohn'), (150, "98'400.00"))])
truth['1101'] = {'file': None, 'expect': 'Kein Nachweis oder Prüfen'}
# 5) Kreditoren: Betrag nur als Teil eines längeren Textes, ohne Saldo-Wort
pdf(p('Kreditoren', 'Kreditorenliste.pdf'), ['Kreditorenliste per 31.12.2025', ((20, 'Summe offene Rechnungen'), (150, "33'871.15"))])
truth['2000'] = {'file': 'Kreditoren/Kreditorenliste.pdf', 'expect': 'Belegt'}
# 6) Darlehen: Stichtag nur im Dateinamen, Inhalt korrekt
pdf(p('Darlehen', 'BEKB_31.12.2025.pdf'), ['Berner Kantonalbank', 'Darlehenskonto 42-118', ((20, 'Kapitalsaldo'), (150, "250'000.00"))])
truth['2400'] = {'file': 'Darlehen/BEKB_31.12.2025.pdf', 'expect': 'Prüfen oder Belegt'}
# 7) Hypothek: Beleg per 30.06.2025 (falscher Stichtag), Name sagt 31.12.
pdf(p('Darlehen', 'Hypothek_Bestaetigung_31.12.2025.pdf'), ['Hypothekarbestätigung', 'Saldo per 30.06.2025', ((20, 'Hypothek fest'), (150, "480'000.00"))])
truth['2410'] = {'file': 'Darlehen/Hypothek_Bestaetigung_31.12.2025.pdf', 'expect': 'Prüfen'}
# 8) Aktienkapital: kein Beleg; aber Betrag 100'000.00 kommt im Darlehensvertrag vor (Zufall)
pdf(p('Darlehen', 'Rahmenvertrag.pdf'), ['Rahmenvertrag', 'Kreditlimite CHF 100\'000.00'])
truth['2800'] = {'file': None, 'expect': 'Kein Nachweis oder Prüfen'}
# 9) Schlechter Scan der Kasse
W, H = 1200, 700
img = Image.new('L', (W, H), 235); d = ImageDraw.Draw(img); f = ImageFont.truetype(FONT, 30)
for i, t in enumerate(['Kassenbuch Dezember 2025', 'Bestand per 31.12.2025', "Saldo CHF 1'236.80"]): d.text((80, 120 + i * 70), t, fill=60, font=f)
img = img.rotate(3.5, fillcolor=235).filter(ImageFilter.GaussianBlur(1.6)); img = ImageEnhance.Contrast(img).enhance(0.55)
px = img.load()
for _ in range(40000): px[random.randrange(W), random.randrange(H)] = random.choice([30, 255])
img.convert('RGB').save(p('Kasse', 'kasse.jpg'), quality=45)
truth['1000'] = {'file': 'Kasse/kasse.jpg', 'expect': 'Prüfen oder Kein Nachweis'}

json.dump({'truth': truth}, open(os.path.join(OUT, 'truth.json'), 'w'), indent=1, ensure_ascii=False)
print('ok', OUT)
