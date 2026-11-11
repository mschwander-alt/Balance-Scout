"""Navision-Saldobilanzen mit Soll/Haben in getrennten Spalten (aktuelles Jahr und Vorjahr) – erfundene Daten.
PDF: zweizeiliger Kopf „Dieses Jahr bis 31.12.2025 | 31.12.2024“ + „Nr. | Name | Soll | Haben | Soll | Haben“.
Excel: Vorjahr links, Beträge eine Spalte neben der Überschrift (verbundene Kopfzellen). Soll-Lösung: test/tbNavision.test.ts"""
import sys, os
OUT = sys.argv[1]; os.makedirs(OUT, exist_ok=True); os.chdir(OUT)
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas
from reportlab.lib.units import mm
c=canvas.Canvas('Saldobilanz_Navision.pdf',pagesize=A4)
W=210
def r(x,y,t,b=False): c.setFont('Helvetica-Bold' if b else 'Helvetica',8); c.drawRightString(x*mm,y*mm,t)
def l(x,y,t,b=False): c.setFont('Helvetica-Bold' if b else 'Helvetica',8); c.drawString(x*mm,y*mm,t)
c.setFont('Helvetica-Bold',9)
c.drawCentredString(110*mm,280*mm,'Dieses Jahr bis'); c.drawCentredString(110*mm,276*mm,'31.12.2025')
c.drawCentredString(165*mm,280*mm,'Dieses Jahr bis'); c.drawCentredString(165*mm,276*mm,'31.12.2024')
l(10,268,'Nr.',True); l(25,268,'Name',True); r(115,268,'Soll',True); r(138,268,'Haben',True); r(170,268,'Soll',True); r(193,268,'Haben',True)
rows=[('1','Aktiven',None,None,True),('10','Umlaufvermögen',None,None,True),('1000','Kasse',None,None,False),
('1020','Bank Muster CHF',(1007104.15,0),(288264.41,0),False),('1060','Wertschriften',(500000,0),(400000,0),False),
('1061','Wertberichtigung Wertschriften',(0,24900),(0,0),False),('1099','Total Flüssige Mittel',(1482204.15,0),(688264.41,0),True),
('1100','Forderungen',(208429.8,0),(208065.34,0),False),('1109','Wertberichtigung LL inkl. Delkredere',(0,60000),(0,49400),False),
('2000','Kreditoren',(0,300000),(0,250000),False),('2800','Aktienkapital',(0,1000000),(0,500000),False),
('3200','Warenertrag',(0,2000000),(0,1800000),False),('4000','Materialaufwand',(900000,0),(800000,0),False),
('6000','Raumaufwand',(1268.05,0),(1210.25,0),False),('2970','Gewinnvortrag',(0,0),(0,98140),False)]
def f(v): return f"{v:,.2f}".replace(',',"'")
y=258
for no,n,cy,vj,b in rows:
    l(10,y,no,b); l(25+(0 if len(no)>2 else 3),y,n,b)
    for (s,h),xs,xh in [(cy or (0,0),115,138),(vj or (0,0),170,193)]:
        if s: r(xs,y,f(s),b)
        if h: r(xh,y,f(h),b)
    y-=5
c.save()
import openpyxl
wb=openpyxl.Workbook(); ws=wb.active
ws.append(['Saldenliste Muster AG'])
r=['']*12; r[4]='Dieses Jahr bis 31.12.2024'; r[8]='Dieses Jahr bis 31.12.2025'; ws.append(r)
r=['']*12; r[0]='Nr.'; r[2]='Name'; r[4]='Soll'; r[6]='Haben'; r[8]='Soll'; r[10]='Haben'; ws.append(r)
data=[('1020','Bank',(200,0),(1000.5,0)),('2000','Kreditoren',(0,150),(0,800)),('3200','Ertrag',(0,50),(0,700.5)),('4000','Aufwand',(0,0),(500,0))]
for no,n,vj,cy in data:
    r=[None]*12; r[0]=no; r[2]=n
    r[5]=vj[0] or None; r[7]=vj[1] or None; r[9]=cy[0] or None; r[11]=cy[1] or None
    ws.append(r)
wb.save('Saldenliste_Navision.xlsx')
print('ok')
