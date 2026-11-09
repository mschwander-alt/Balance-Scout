"""Künstliche OP-Listen im Aufbau von Abacus, Navision (gescannt) und Business Central – erfundene Kunden.
Soll-Lösung je Liste in truth.json (Posten, Kundentotale, Gesamttotal je Währung)."""
import sys, os, json, random, io
from reportlab.lib.pagesizes import A4, landscape
from reportlab.pdfgen import canvas
from reportlab.lib.units import mm
from PIL import Image, ImageFilter
import subprocess, tempfile, glob

random.seed(7)
OUT = sys.argv[1]; os.makedirs(OUT, exist_ok=True)
NAMES = ['Alpen Logistik AG', 'Bergsicht GmbH', 'Calanda Bau AG', 'Dufour Optik SA', 'Engadin Hotels AG', 'Föhn Technik GmbH',
         'Gotthard Transporte AG', 'Hasliberg Holz AG', 'Ilanz Elektro GmbH', 'Jura Uhren SA', 'Kander Fenster AG', 'Linth Metall AG',
         'Mythen Garage GmbH', 'Napf Käserei AG', 'Oberland Druck AG', 'Pilatus Software GmbH', 'Rigi Reisen AG', 'Säntis Kälte AG']
def chf(c): return ('-' if c < 0 else '') + f"{abs(c)/100:,.2f}".replace(',', "'")
def chf_bc(c): return ('-' if c < 0 else '') + f"{abs(c)/100:,.2f}".replace(',', '’')
def d(y, m, dd, short=False): return f"{dd:02d}.{m:02d}.{str(y)[2:] if short else y}"

def customers(n, currencies=('CHF',), year=2025):
    out = []
    for i, name in enumerate(NAMES[:n]):
        cur = random.choice(currencies)
        items = []
        for j in range(random.randint(1, 6)):
            age = random.choice([5, 20, 45, 70, 100, 200, 400])
            dt = 31 - (age % 28)
            m = max(1, 12 - age // 30); y = year if age < 330 else year - 1
            amt = random.randint(5000, 2_500_000)
            typ = 'Rechnung'
            if random.random() < 0.12: typ, amt = 'Gutschrift', -random.randint(5000, 300000)
            items.append({'no': f'{760000 + i * 20 + j}', 'type': typ, 'date': (y, m, min(dt, 28)), 'cur': cur, 'amount': amt})
        out.append({'no': str(3000 + i * 7), 'name': name, 'items': items})
    return out

truth = {}
# ---------------- Abacus (Text-PDF, mehrere Währungen, Seitenkopf, 3 Betragsspalten) ----------------
cs = customers(18, ('CHF', 'CHF', 'EUR', 'USD'), 2025)
c = canvas.Canvas(f'{OUT}/OP_Abacus.pdf', pagesize=A4)
def ab_head(page):
    c.setFont('Helvetica-Bold', 11); c.drawString(15*mm, 285*mm, 'Liste der offenen Debitorenposten rückwirkend per 31.12.2025')
    c.setFont('Helvetica', 9); c.drawString(15*mm, 280*mm, 'Reihenfolge Nach Kundennummer'); c.drawString(15*mm, 275*mm, '10 - Muster Handels AG')
    c.setFont('Helvetica-Bold', 8)
    for x, t in [(15, 'Bel.-Nr.'), (32, 'Art'), (62, 'FIBU-Datum')]: c.drawString(x*mm, 268*mm, t)
    for x, t in [(130, 'Beleg-Betrag'), (160, 'Beleg-OP'), (192, 'fälliger Betrag')]: c.drawRightString(x*mm, 268*mm, t)
    c.setFont('Helvetica', 7); c.drawString(15*mm, 10*mm, f'Lizenz: Muster Handels AG | MS | 06.02.2026 | 17:25 Seite {page}')
page = 1; ab_head(page); y = 260*mm
tot = {}
def ab_line(cols):
    global y, page
    if y < 22*mm:
        c.showPage(); page += 1; ab_head(page); y = 260*mm
    c.setFont('Helvetica', 8)
    for x, t, right in cols: (c.drawRightString if right else c.drawString)(x*mm, y, t)
    y -= 5*mm
for cu in cs:
    ab_line([(15, f"{cu['no']} {cu['name'].split()[0].upper()}", False)])
    s = 0
    for it in cu['items']:
        art = 'R Rechnung' if it['type'] == 'Rechnung' else 'G Gutschrift'
        due = it['amount'] if random.random() < 0.5 else 0
        ab_line([(15, it['no'], False), (32, art, False), (62, d(*it['date']), False), (100, it['cur'], False),
                 (130, chf(it['amount']), True), (160, chf(it['amount']), True), (192, chf(due), True)])
        s += it['amount']; tot[it['cur']] = tot.get(it['cur'], 0) + it['amount']
    ab_line([(15, f"Total {cu['no']} {cu['name'].split()[0].upper()}", False), (75, f"{len(cu['items'])} Beleg(e)", False), (100, cu['items'][0]['cur'], False), (130, chf(s), True), (160, chf(s), True), (192, chf(0), True)])
    y -= 2*mm
first = True
for cur, v in tot.items():
    ab_line([(15, 'Gesamttotal Nach Währungen' if first else '', False), (75, '9 Beleg(e)', False), (100, cur, False), (130, chf(v), True), (160, chf(v), True), (192, chf(0), True)]); first = False
c.save()
truth['OP_Abacus.pdf'] = {'closing': '2025-12-31', 'customers': len(cs), 'items': sum(len(x['items']) for x in cs), 'totals': tot}

# ---------------- Navision (gescannt: Bild-PDF, 2-stelliges Jahr, Telefonzeile, Laufnr.) ----------------
cs = customers(14, ('CHF',), 2025)
buf = io.BytesIO(); c = canvas.Canvas(buf, pagesize=A4)
c.setFont('Helvetica-Bold', 16); c.drawString(15*mm, 280*mm, 'Debitor OP Liste'); c.setFont('Helvetica', 9)
c.drawString(15*mm, 274*mm, 'Muster Chemie AG'); c.drawRightString(195*mm, 280*mm, '16. Februar 2026')
c.drawString(15*mm, 266*mm, 'Alle Beträge in MW.'); c.drawString(15*mm, 261*mm, 'Saldo am 31.12.25')
c.setFont('Helvetica-Bold', 9)
for x, t in [(15, 'Buchungsdatum'), (45, 'Belegart'), (70, 'Belegnr.'), (95, 'Beschreibung')]: c.drawString(x*mm, 252*mm, t)
c.drawRightString(170*mm, 252*mm, 'Betrag'); c.drawRightString(192*mm, 252*mm, 'Laufnr.')
y = 244*mm; total = 0
for i, cu in enumerate(cs):
    if y < 40*mm: c.showPage(); y = 280*mm
    c.setFont('Helvetica-Bold', 9); c.drawString(15*mm, y, f"D{int(cu['no']):06d}"); c.drawString(45*mm, y, cu['name']); y -= 4.5*mm
    c.setFont('Helvetica', 8); c.drawString(45*mm, y, 'Telefon'); c.drawString(70*mm, y, f'+41 71 {200+i} 17 77'); y -= 4.5*mm
    s = 0
    for j, it in enumerate(cu['items']):
        c.drawString(15*mm, y, d(*it['date'], short=True)); c.drawString(45*mm, y, it['type']); c.drawString(70*mm, y, ('RG' if it['amount'] > 0 else 'VG') + it['no'][-6:])
        c.drawString(95*mm, y, f"Auft. VA05{it['no'][-4:]}/{cu['name'][:18]}"); c.drawRightString(170*mm, y, chf(it['amount'])); c.drawRightString(192*mm, y, str(60000 + i * 50 + j)); y -= 4.5*mm
        s += it['amount']
    c.setFont('Helvetica-Bold', 9); c.drawString(45*mm, y, cu['name']); c.drawRightString(170*mm, y, chf(s)); y -= 7*mm; total += s
c.setFont('Helvetica-Bold', 9); c.drawString(45*mm, y, 'Gesamt'); c.drawRightString(170*mm, y, chf(total)); c.save()
tmp = tempfile.mkdtemp(); open(f'{tmp}/nav.pdf', 'wb').write(buf.getvalue())
subprocess.run(['pdftoppm', '-r', '200', '-png', f'{tmp}/nav.pdf', f'{tmp}/p'], check=True); imgs = []
for f in sorted(glob.glob(f'{tmp}/p*.png')):
    im = Image.open(f).convert('L').rotate(0.4, fillcolor=255, expand=False).filter(ImageFilter.GaussianBlur(0.5)); imgs.append(im)
imgs[0].save(f'{OUT}/OP_Navision_Scan.pdf', save_all=True, append_images=imgs[1:], resolution=200)
truth['OP_Navision_Scan.pdf'] = {'closing': '2025-12-31', 'customers': len(cs), 'items': sum(len(x['items']) for x in cs), 'totals': {'CHF': total}}

# ---------------- Business Central (Soll/Haben, Mahnstufe, Folgezeile, ’) ----------------
cs = customers(16, ('CHF',), 2025)
c = canvas.Canvas(f'{OUT}/OP_BusinessCentral.pdf', pagesize=landscape(A4))
c.setFont('Helvetica', 9); c.drawString(15*mm, 195*mm, 'Muster Bau AG'); c.drawRightString(282*mm, 195*mm, 'Debitor - Offene Posten'); c.drawRightString(282*mm, 190*mm, 'Saldo per 31.12.2025')
c.setFont('Helvetica-Bold', 8)
for x, t in [(15, 'Belegnr.'), (40, 'Buch.dat'), (60, 'Beleg.dat'), (80, 'Belegart'), (110, 'Kst.'), (122, 'Buchungstext'), (180, 'Stati.'), (195, 'MS')]: c.drawString(x*mm, 182*mm, t)
c.drawRightString(240*mm, 182*mm, 'Soll'); c.drawRightString(262*mm, 182*mm, 'Haben'); c.drawString(270*mm, 182*mm, 'MW')
y = 175*mm; total = 0
for i, cu in enumerate(cs):
    if y < 30*mm: c.showPage(); y = 190*mm
    c.setFont('Helvetica-Bold', 8); c.drawString(15*mm, y, f"{cu['no']} {cu['name']} 9000 St. Gallen"); y -= 4.5*mm; c.setFont('Helvetica', 8)
    s = 0
    for it in cu['items']:
        typ = 'Zahlung' if it['type'] == 'Gutschrift' else 'Rechnung'
        c.drawString(15*mm, y, it['no']); c.drawString(40*mm, y, d(*it['date'])); c.drawString(60*mm, y, d(*it['date'])); c.drawString(80*mm, y, typ); c.drawString(110*mm, y, '9016')
        c.drawString(122*mm, y, cu['name'][:22]); c.drawString(180*mm, y, 'Nein'); c.drawString(195*mm, y, str(random.choice([0, 0, 1, 2])))
        if it['amount'] >= 0: c.drawRightString(240*mm, y, chf_bc(it['amount']))
        else: c.drawRightString(262*mm, y, chf_bc(-it['amount']))
        c.drawString(270*mm, y, 'CHF'); y -= 4.5*mm
        if len(cu['name']) > 22: c.drawString(122*mm, y, cu['name'][22:]); y -= 4.5*mm
        s += it['amount']
    c.drawString(150*mm, y, f"Gesamtsumme Debitorennr.: {cu['no']}"); c.drawRightString(240*mm, y, chf_bc(s)); c.drawString(270*mm, y, 'CHF'); y -= 7*mm; total += s
c.drawString(150*mm, y, 'Gesamtsumme Liste:'); c.drawRightString(240*mm, y, chf_bc(total)); c.drawString(270*mm, y, 'CHF'); c.save()
truth['OP_BusinessCentral.pdf'] = {'closing': '2025-12-31', 'customers': len(cs), 'items': sum(len(x['items']) for x in cs), 'totals': {'CHF': total}}
json.dump(truth, open(f'{OUT}/truth.json', 'w'), indent=1)
print(json.dumps(truth))
