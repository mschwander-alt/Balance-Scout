"""Saldobilanz als PDF in drei Varianten (Text, Soll/Haben, Scan) aus der Alpenblick-Saldobilanz."""
import sys, os, random, subprocess, openpyxl
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas
from reportlab.lib.units import mm
from PIL import Image, ImageFilter

random.seed(3)
SRC, OUT = sys.argv[1], sys.argv[2]
os.makedirs(OUT, exist_ok=True)
ws = openpyxl.load_workbook(SRC).active
acc = [(str(r[0]), r[1], r[2], r[3]) for r in ws.iter_rows(min_row=5, values_only=True) if r[0]]

def chf(x): return ('-' if x < 0 else '') + f"{abs(x):,.2f}".replace(',', "'")

def header(c, cols, y):
    c.setFont('Helvetica-Bold', 9)
    for x, t, right in cols:
        (c.drawRightString if right else c.drawString)(x * mm, y, t)

def tb_pdf(path, mode):
    c = canvas.Canvas(path, pagesize=A4)
    per_page = 16
    pages = [acc[i:i + per_page] for i in range(0, len(acc), per_page)]
    for pi, chunk in enumerate(pages, 1):
        c.setFont('Helvetica-Bold', 13); c.drawString(20 * mm, 280 * mm, 'Alpenblick Treuhand AG')
        c.setFont('Helvetica', 10); c.drawString(20 * mm, 273 * mm, 'Saldobilanz per 31.12.2025 (in CHF)')
        cols = [(20, 'Konto', False), (38, 'Bezeichnung', False)] + (
            [(150, 'Saldo 2025', True), (188, 'Saldo 2024', True)] if mode == 'saldo' else [(150, 'Soll', True), (188, 'Haben', True)])
        y = 260 * mm; header(c, cols, y); y -= 7 * mm
        klasse = None
        for k, n, cy, py in chunk:
            if klasse and k[0] != klasse:
                c.setFont('Helvetica-Oblique', 9); c.drawString(38 * mm, y, f'Total Kontenklasse {klasse}'); y -= 7 * mm
            klasse = k[0]
            c.setFont('Helvetica', 9); c.drawString(20 * mm, y, k); c.drawString(38 * mm, y, n[:48])
            if mode == 'saldo':
                c.drawRightString(150 * mm, y, chf(cy)); c.drawRightString(188 * mm, y, chf(py))
            else:
                if cy >= 0: c.drawRightString(150 * mm, y, chf(cy))
                else: c.drawRightString(188 * mm, y, chf(-cy))
            y -= 6 * mm
        c.setFont('Helvetica', 8); c.drawString(20 * mm, 15 * mm, f'Seite {pi} von {len(pages)}   Druck 15.01.2026')
        c.showPage()
    c.save()

tb_pdf(os.path.join(OUT, 'SaBi_Text.pdf'), 'saldo')
tb_pdf(os.path.join(OUT, 'SaBi_SollHaben.pdf'), 'sollhaben')
# Scan: Text-PDF rastern, leicht drehen, rauschen, als Bild-PDF speichern
subprocess.run(['pdftoppm', '-r', '150', '-png', os.path.join(OUT, 'SaBi_Text.pdf'), '/tmp/sabi_scan'], check=True)
imgs = []
for f in sorted(x for x in os.listdir('/tmp') if x.startswith('sabi_scan') and x.endswith('.png')):
    im = Image.open('/tmp/' + f).convert('L').rotate(0.6, fillcolor=255, expand=False)
    px = im.load()
    for _ in range(6000): px[random.randrange(im.width), random.randrange(im.height)] = random.choice([0, 255])
    imgs.append(im.filter(ImageFilter.GaussianBlur(0.4)).convert('RGB'))
    os.remove('/tmp/' + f)
imgs[0].save(os.path.join(OUT, 'SaBi_Scan.pdf'), 'PDF', resolution=150, save_all=True, append_images=imgs[1:])
print('ok')
