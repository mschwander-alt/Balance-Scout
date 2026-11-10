import { BUCKETS, type Aging } from '../analysis/receivables.js';
import type { AgingMeta } from './agingExcel.js';

const BLUE = '0F5EA8';
const SHADES = ['1F5F9E', '3B82C4', '6EA6D9', 'A4C8EA', 'D4E5F6'];
const TXT = '222936';
const MUTED = '737B8C';
const chf = (c: number) => (c / 100).toLocaleString('de-CH', { minimumFractionDigits: 0, maximumFractionDigits: 0 }).replace(/’/g, "'");
const chf2 = (c: number) => (c / 100).toLocaleString('de-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).replace(/’/g, "'");
const fmtD = (iso: string) => iso.split('-').reverse().join('.');

/**
 * Fälligkeitsanalyse als PowerPoint (16:9) mit echten, bearbeitbaren Diagrammen:
 * Titel · Altersstruktur (Säulen) · Verteilung (Ring) · Kennzahlen und grösste Kunden · Feststellungen und Notiz.
 */
export async function agingPptx(a: Aging, m: AgingMeta & { note?: string; letter?: string }): Promise<Buffer> {
  // pptxgenjs ist ein CommonJS-Paket: Konstruktor je nach Lader unter default oder default.default
  const mod = (await import('pptxgenjs')) as unknown as { default: unknown };
  const Ctor = ((mod.default as { default?: unknown }).default ?? mod.default) as new () => import('pptxgenjs').default;
  const pptx = new Ctor();
  pptx.layout = 'LAYOUT_WIDE'; // 13.33 x 7.5 in
  pptx.author = 'Balance Scout';
  pptx.title = `Forderungen L+L – Fälligkeitsanalyse ${m.mandate}`;
  pptx.defineSlideMaster({
    title: 'BS',
    background: { color: 'FFFFFF' },
    objects: [
      { rect: { x: 0, y: 0, w: 13.33, h: 0.08, fill: { color: BLUE } } },
      { text: { text: `${m.mandate} · Bilanzstichtag ${fmtD(m.closingDate)}`, options: { x: 0.5, y: 7.05, w: 8, h: 0.3, fontSize: 9, color: MUTED } } },
      { text: { text: 'Balance Scout', options: { x: 10.8, y: 7.05, w: 2, h: 0.3, fontSize: 9, color: MUTED, align: 'right' } } },
    ],
  });
  const title = (s: ReturnType<typeof pptx.addSlide>, t: string, sub?: string) => {
    if (m.letter) s.addText(m.letter, { x: 0.5, y: 0.35, w: 0.5, h: 0.5, fontSize: 18, bold: true, color: 'FFFFFF', fill: { color: BLUE }, align: 'center', valign: 'middle' });
    s.addText(t, { x: m.letter ? 1.15 : 0.5, y: 0.3, w: 10, h: 0.45, fontSize: 22, bold: true, color: TXT });
    if (sub) s.addText(sub, { x: m.letter ? 1.15 : 0.5, y: 0.75, w: 10, h: 0.3, fontSize: 12, color: MUTED });
  };
  const diff = m.balanceChf === null ? null : a.totalChf - m.balanceChf;

  // 1 – Titel mit Abstimmung
  let s = pptx.addSlide({ masterName: 'BS' });
  title(s, 'Forderungen aus Lieferungen und Leistungen', 'Vertiefte Prüfung – Fälligkeitsanalyse per Bilanzstichtag');
  s.addTable([
    [{ text: 'Total OP-Liste', options: { color: MUTED } }, { text: `CHF ${chf2(a.totalChf)}`, options: { bold: true, align: 'right' } }],
    [{ text: `Saldo Forderungen L+L${m.balanceAccounts ? ` (Konto ${m.balanceAccounts})` : ''}`, options: { color: MUTED } }, { text: m.balanceChf === null ? '–' : `CHF ${chf2(m.balanceChf)}`, options: { bold: true, align: 'right' } }],
    [{ text: 'Differenz', options: { color: MUTED } }, { text: diff === null ? '–' : Math.abs(diff) <= 100 ? '✓ abgestimmt' : `CHF ${chf2(diff)}`, options: { bold: true, align: 'right', color: diff !== null && Math.abs(diff) > 100 ? 'B3261E' : '1D7A46' } }],
    [{ text: 'Quelle', options: { color: MUTED } }, { text: m.sourceFile, options: { align: 'right' } }],
    [{ text: 'Zahlungsfrist (ohne Fälligkeitsdatum)', options: { color: MUTED } }, { text: `${a.params.termDays} Tage`, options: { align: 'right' } }],
  ], { x: 0.5, y: 1.6, w: 8, colW: [4.5, 3.5], fontSize: 14, border: { type: 'none' }, rowH: 0.45 });

  // 2 – Altersstruktur (Säulen) + Verteilung (Ring)
  s = pptx.addSlide({ masterName: 'BS' });
  title(s, 'Altersstruktur der offenen Rechnungen', `CHF ${chf(a.grossChf)} offene Rechnungen${a.credits ? ` · Gutschriften/Vorauszahlungen CHF ${chf(a.credits)} separat` : ''}`);
  const labels = [...BUCKETS];
  s.addChart(pptx.ChartType.bar, [{ name: 'CHF', labels, values: a.buckets.map(b => Math.round(b / 100)) }], {
    x: 0.5, y: 1.3, w: 7.6, h: 5.4, barDir: 'col', chartColors: SHADES, barGapWidthPct: 60,
    showValue: true, dataLabelFormatCode: "#,##0", dataLabelFontSize: 11, dataLabelColor: TXT,
    catAxisLabelFontSize: 12, valAxisLabelFontSize: 10, valAxisLabelFormatCode: "#,##0", valGridLine: { color: 'EEF1F5', size: 1 },
    showLegend: false, varyColors: true,
  } as never);
  s.addChart(pptx.ChartType.doughnut, [{ name: 'Anteil', labels, values: a.buckets.map(b => Math.round(b / 100)) }], {
    x: 8.4, y: 1.3, w: 4.5, h: 5.4, holeSize: 55, chartColors: SHADES, showPercent: true, showValue: false, showLegend: true,
    legendPos: 'b', legendFontSize: 11, dataLabelColor: TXT, dataLabelFontSize: 10,
  } as never);

  // 3 – Kennzahlen + grösste Kunden
  s = pptx.addSlide({ masterName: 'BS' });
  title(s, 'Kennzahlen und grösste Debitoren');
  const kpis: [string, string, string][] = [
    ['Über 90 Tage überfällig', `CHF ${chf(a.kpis.overdue90)}`, `${(a.kpis.overdue90Share * 100).toFixed(1)} % der Rechnungen`],
    ['Überfällige Debitoren', String(a.kpis.overdueCustomers), `von ${a.kpis.customers}`],
    ['Grösster überfälliger Saldo', a.kpis.largestOverdue ? `CHF ${chf(a.kpis.largestOverdue.amount)}` : '–', a.kpis.largestOverdue?.customer ?? ''],
    ['Ø Überfälligkeit', `${a.kpis.avgDaysOverdue} Tage`, 'gewichtet, überfällige Posten'],
  ];
  kpis.forEach(([k, v, sub], i) => {
    const x = 0.5 + i * 3.1;
    s.addShape(pptx.ShapeType.roundRect, { x, y: 1.25, w: 2.9, h: 1.3, fill: { color: 'F7F8FA' }, line: { color: 'E3E6EB' }, rectRadius: 0.08 });
    s.addText([
      { text: k, options: { fontSize: 11, color: MUTED, breakLine: true } },
      { text: v, options: { fontSize: 20, bold: true, color: TXT, breakLine: true } },
      { text: sub, options: { fontSize: 10, color: MUTED } },
    ], { x: x + 0.15, y: 1.3, w: 2.6, h: 1.2, valign: 'middle' });
  });
  const head = ['Kunde', 'Total CHF', ...BUCKETS.map(b => b.replace(' Tage', ' T'))].map(t => ({ text: t, options: { bold: true, color: 'FFFFFF', fill: { color: BLUE }, align: t === 'Kunde' ? 'left' as const : 'right' as const } }));
  type Cell = { text: string; options: Record<string, unknown> };
  const rows: Cell[][] = a.customers.slice(0, 10).map(c => [
    { text: c.customerName || c.customerNo, options: { align: 'left' as const } },
    { text: chf(c.totalChf), options: { align: 'right' as const } },
    ...c.buckets.map((b, i) => ({ text: b ? chf(b) : '–', options: { align: 'right' as const, color: i >= 3 && b > 0 ? '9A6200' : TXT } })),
  ]);
  const others = a.customers.slice(10);
  if (others.length) rows.push([
    { text: `Andere (${others.length})`, options: { align: 'left' as const, color: MUTED } },
    { text: chf(others.reduce((x, c) => x + c.totalChf, 0)), options: { align: 'right' as const, color: MUTED } },
    ...BUCKETS.map((_, i) => ({ text: chf(others.reduce((x, c) => x + c.buckets[i]!, 0)), options: { align: 'right' as const, color: MUTED } })),
  ]);
  rows.push([
    { text: 'Total', options: { align: 'left' as const, bold: true } as never },
    { text: chf(a.totalChf), options: { align: 'right' as const, bold: true } as never },
    ...a.buckets.map(b => ({ text: chf(b), options: { align: 'right' as const, bold: true } as never })),
  ]);
  s.addTable([head, ...rows] as never, { x: 0.5, y: 2.8, w: 12.3, colW: [3.6, 1.5, 1.44, 1.44, 1.44, 1.44, 1.44], fontSize: 10, border: { type: 'solid', color: 'E8EAEE', pt: 0.5 }, rowH: 0.3, autoPage: false });

  // 4 – Feststellungen und Notiz
  s = pptx.addSlide({ masterName: 'BS' });
  title(s, 'Feststellungen und nächste Schritte');
  const fs = m.findings.length ? m.findings : [{ text: 'Keine Feststellungen erfasst.', status: '' }];
  s.addText(fs.map(f => ({ text: `${f.status === 'erledigt' ? '☑' : f.status ? '☐' : ''} ${f.text}`, options: { bullet: false, breakLine: true, color: f.status === 'erledigt' ? MUTED : TXT } })), { x: 0.5, y: 1.3, w: 12.3, h: m.note ? 2.9 : 5.3, fontSize: 14, valign: 'top', paraSpaceAfter: 6 });
  if (m.note?.trim()) {
    s.addShape(pptx.ShapeType.rect, { x: 0.5, y: 4.4, w: 12.3, h: 2.4, fill: { color: 'F7F8FA' }, line: { color: 'E3E6EB' } });
    s.addText([{ text: 'Notiz', options: { bold: true, fontSize: 12, color: BLUE, breakLine: true } }, { text: m.note, options: { fontSize: 12, color: TXT } }], { x: 0.7, y: 4.5, w: 11.9, h: 2.2, valign: 'top' });
  }
  return Buffer.from((await pptx.write({ outputType: 'nodebuffer' })) as ArrayBuffer);
}
