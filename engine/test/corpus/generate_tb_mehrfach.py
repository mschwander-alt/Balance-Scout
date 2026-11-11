"""Saldobilanzen mit typischen Stolpersteinen – erfundene Daten. Soll-Lösung: test/tbMehrfach.test.ts
1. Mehrere Blätter: „Saldobilanz“ (alle Konten), „Bilanz“ (Auszug derselben Konten), „Notizen“
2. Nummer und Bezeichnung in einer Zelle („1020 Bank UBS“), Kopf nur „Konto“
3. Gleiches Konto doppelt (wiederholte Zeile), einmal mit anderem Saldo"""
import sys, os, openpyxl
OUT = sys.argv[1]; os.makedirs(OUT, exist_ok=True)
K = [('1000', 'Kasse', 1500.00, 1200.00), ('1020', 'Bank UBS', 48000.50, 30000.00), ('1100', 'Forderungen LL', 25000.00, 20000.00),
     ('2000', 'Kreditoren', -18000.00, -15000.00), ('2800', 'Aktienkapital', -50000.00, -50000.00), ('3200', 'Warenertrag', -120000.00, -100000.00),
     ('4000', 'Warenaufwand', 70000.00, 60000.00), ('6000', 'Raumaufwand', 43499.50, 53800.00)]
wb = openpyxl.Workbook(); ws = wb.active; ws.title = 'Saldobilanz'
ws.append(['Muster Handels AG – Saldobilanz per 31.12.2025']); ws.append([])
ws.append(['Konto', 'Bezeichnung', 'Saldo 2025', 'Saldo 2024'])
for k in K: ws.append([int(k[0]), k[1], k[2], k[3]])
b = wb.create_sheet('Bilanz')
b.append(['Bilanz per 31.12.2025']); b.append(['Konto', 'Bezeichnung', 'Saldo 2025'])
for k in K[:5]: b.append([int(k[0]), k[1], k[2]])
n = wb.create_sheet('Notizen'); n.append(['Bemerkungen zum Abschluss']); n.append(['Inventar per 31.12. erhalten'])
wb.save(f'{OUT}/Saldobilanz_mehrere_Blaetter.xlsx')

wb = openpyxl.Workbook(); ws = wb.active
ws.append(['Saldenliste 2025']); ws.append(['Konto', 'Saldo 31.12.2025', 'Saldo 31.12.2024'])
for k in K: ws.append([f'{k[0]} {k[1]}', k[2], k[3]])
ws.append([f'{K[1][0]} {K[1][1]}', K[1][2], K[1][3]])        # Zeile doppelt (gleicher Saldo)
ws.append([f'{K[2][0]} {K[2][1]}', 999.00, None])           # doppelt mit anderem Saldo
wb.save(f'{OUT}/Saldenliste_Nummer_und_Name.xlsx')
print('ok')
