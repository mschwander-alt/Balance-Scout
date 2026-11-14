/**
 * Testdaten Rechnungsabgrenzungen (Geschäftsjahr 1.7.2025–30.6.2026): Saldobilanz und Kontoblätter (Excel, ein Blatt je Konto)
 * Aufruf: npx tsx test/corpus/generate_rap.mts
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import * as XLSX from 'xlsx';

const OUT = path.resolve(import.meta.dirname, '..', 'fixtures', 'rap');
type P = [string, string, string, number]; // Datum, Text, Gegenkonto, Betrag (+ Soll / − Haben)
const sheets: { no: string; name: string; opening: number; postings: P[] }[] = [
  { no: '1300', name: 'Aktive Rechnungsabgrenzungen', opening: 104_811, postings: [
    ['01.07.2025', 'Auflösung TA Swiss Life, BVG Kader 07.-12.', '5720', -44_950],
    ['01.07.2025', 'Auflösung TA Abacus Wartungsvertrag 07.-12.', '6560', -13_800],
    ['01.07.2025', 'Auflösung TA Helvetia, UVG 07.-12.', '5730', -11_300],
    ['01.07.2025', 'Auflösung TA Helvetia (ehem. Zürich), Berufs-HP 07.-12.', '6300', -9_650],
    ['01.07.2025', 'Auflösung TA Helvetia, KTG 07.-12.', '5740', -6_800],
    ['01.07.2025', 'Auflösung TA Mirus, Lizenz 06.-12.', '6560', -4_380],
    ['01.07.2025', 'Auflösung TA EO Entschädigung', '5005', -4_071],
    ['01.07.2025', 'Auflösung TA Büro Föllmi AG 07-08.', '6560', -3_300],
    ['01.07.2025', 'Auflösung TA Miete St. Moritz 07.', '6000', -2_460],
    ['01.07.2025', 'Auflösung TA TaxWare, Lizenz 07.-11.', '6560', -1_800],
    ['01.07.2025', 'Auflösung TA Helvetia, Gesch\'vers. 07.-12.', '6300', -1_250],
    ['01.07.2025', 'Auflösung TA Helvetia Cyber\'vers. 07.-12.', '6300', -1_050],
    ['30.06.2026', 'Swiss Life, BVG Kader 07.-12.', '5720', 76_100],
    ['30.06.2026', 'Abacus Wartungsvertrag 07.-12.', '6560', 13_900],
    ['30.06.2026', 'Helvetia, UVG 07.-12.', '5730', 10_000],
    ['30.06.2026', 'Helvetia (ehem. Zürich), Berufs-HP 07.-12.', '6300', 9_650],
    ['30.06.2026', 'Helvetia, KTG 07.-12.', '5740', 5_800],
    ['30.06.2026', 'Mirus, Lizenz 06.-12.', '6560', 4_400],
    ['30.06.2026', 'EO Entschädigung', '5005', 1_404.45],
    ['30.06.2026', 'Büro Föllmi AG 07-08.', '6560', 3_400],
    ['30.06.2026', 'Miete St. Moritz 07.', '6000', 2_460],
    ['30.06.2026', 'TaxWare, Lizenz 07.-11.', '6560', 1_800],
    ['30.06.2026', 'Helvetia, Gesch\'vers. 07.-12.', '6300', 1_000],
    ['30.06.2026', 'Helvetia Cyber\'vers. 07.-12.', '6300', 1_100],
    ['30.06.2026', 'Büroausflug 2026/2027', '5800', 2_500],
    ['30.06.2026', 'Rotmonten, Umsatzabrechnung', '8100', 6_000],
  ] },
  { no: '2300', name: 'Passive Rechnungsabgrenzungen', opening: -18_500, postings: [
    ['03.07.2025', 'Auflösung TP Revision Vorjahr', '6530', 12_000],
    ['03.07.2025', 'Auflösung TP Strom Q2', '6400', 6_500],
    ['30.06.2026', 'TP Revision', '6530', -12_500],
    ['30.06.2026', 'TP Strom Q2', '6400', -7_200],
    ['30.06.2026', 'TP Ferienguthaben', '5000', -15_000],
  ] },
];
const wb = XLSX.utils.book_new();
const cents = (x: number) => Math.round(x * 100);
const balances: Record<string, number> = {};
for (const s of sheets) {
  let bal = cents(s.opening);
  const rows: (string | number | null)[][] = [['BelDatum', 'Text', 'Gegenkonto', 'A', 'Beleg', 'Soll', 'Haben', 'Saldo'], ['Saldovortrag', s.opening]];
  s.postings.forEach(([d, t, c, a], i) => {
    bal += cents(a);
    rows.push([d, t, c, 'F', 200 + i, a > 0 ? a : null, a < 0 ? -a : null, bal / 100]);
  });
  rows.push(['Saldo Buchungsjahr', bal / 100]);
  balances[s.no] = bal / 100;
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), `_${s.no}_${s.name}`.slice(0, 31));
}
writeFileSync(path.join(OUT, 'Kontoblaetter_2026.xlsx'), XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
// Saldobilanz (vereinfacht, ausgeglichen über Bank und Gewinnvortrag)
const tb = XLSX.utils.book_new();
const rows = [['Konto', 'Bezeichnung', 'Saldo', 'Vorjahr'],
  ['1020', 'Bank', 50_000, 40_000],
  ['1300', 'Aktive Rechnungsabgrenzungen', balances['1300'], 104_811],
  ['2300', 'Passive Rechnungsabgrenzungen', balances['2300'], -18_500],
  ['2970', 'Gewinnvortrag', -(50_000 + balances['1300']! + balances['2300']!), -(40_000 + 104_811 - 18_500)],
];
XLSX.utils.book_append_sheet(tb, XLSX.utils.aoa_to_sheet(rows), 'Saldobilanz');
writeFileSync(path.join(OUT, 'Saldobilanz_2026.xlsx'), XLSX.write(tb, { type: 'buffer', bookType: 'xlsx' }));
console.log(balances);
