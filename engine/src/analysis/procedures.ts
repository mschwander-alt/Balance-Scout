/**
 * Empfohlene Prüfungshandlungen je Prüfgebiet (Gruppe des KMU-Kontenrahmens, „ER“ = Erfolgsrechnung).
 *
 * Startkatalog in eigenen Worten nach den Grundsätzen der eingeschränkten Revision (Befragungen, analytische
 * Prüfungshandlungen, angemessene Detailprüfungen). Kein Abdruck des Standards – der Katalog kann durch eine eigene
 * (lizenzierte) Liste ersetzt werden: `loadProcedureCatalog()` liest eine Excel-/CSV-Datei mit den Spalten
 * Gebiet | Nr | Prüfungshandlung.
 *
 * `auto` verknüpft eine Handlung mit einem automatischen Ergebnis der App (wird abgehakt und mit einem Notizvorschlag
 * versehen, solange die Prüferin / der Prüfer sie nicht selbst bearbeitet hat).
 */
export type ProcedureAuto = 'belege' | 'vorjahr' | 'op-abstimmung' | 'op-alter' | 'anlagespiegel' | 'abgrenzungen' | 'er-analyse';
export interface ProcedureDef { id: string; text: string; auto?: ProcedureAuto }
export type ProcedureCatalog = Record<string, ProcedureDef[]>;

const p = (id: string, text: string, auto?: ProcedureAuto): ProcedureDef => (auto ? { id, text, auto } : { id, text });

/** Handlungen, die für jede Bilanzposition gelten (falls nichts Spezifisches hinterlegt ist) */
export const GENERIC_PROCEDURES: ProcedureDef[] = [
  p('saldo', 'Saldo mit Nachweis per Stichtag (Bestätigung, Inventar, Aufstellung) abstimmen', 'belege'),
  p('vorjahr', 'Wesentliche Veränderungen gegenüber dem Vorjahr erklären lassen und auf Plausibilität beurteilen', 'vorjahr'),
  p('bewertung', 'Bewertung und Ausweis gemäss OR 960 ff. beurteilen'),
  p('anhang', 'Erforderliche Angaben im Anhang (OR 959c) auf Vollständigkeit prüfen'),
];

export const DEFAULT_PROCEDURES: ProcedureCatalog = {
  A10: [
    p('bank', 'Bank- und Postkonten mit Saldobestätigungen bzw. Kontoauszügen per Stichtag abstimmen', 'belege'),
    p('kasse', 'Kassenbestand per Stichtag mit Kassenprotokoll oder Kassabuch belegen'),
    p('vorjahr', 'Wesentliche Veränderungen zum Vorjahr erklären (Zu- und Abflüsse, neue oder aufgelöste Konten)', 'vorjahr'),
    p('fw', 'Konten in Fremdwährung zum Stichtagskurs (z. B. ESTV-Kursliste) umgerechnet'),
    p('verfuegung', 'Verpfändungen und Verfügungsbeschränkungen erfragen und im Anhang offenlegen'),
  ],
  A11: [
    p('depot', 'Bestand mit Depotauszug per Stichtag abstimmen', 'belege'),
    p('kurs', 'Bewertung zum Börsenkurs am Stichtag bzw. Niederstwert nachvollziehen'),
    p('vorjahr', 'Veränderungen zum Vorjahr (Käufe, Verkäufe, Kursdifferenzen) erklären', 'vorjahr'),
    p('ertrag', 'Wertschwankungsreserven und Erträge plausibilisieren'),
  ],
  A12: [
    p('op', 'Offenpostenliste per Stichtag mit dem Saldo der Debitoren abstimmen', 'op-abstimmung'),
    p('alter', 'Altersstruktur analysieren und überfällige Posten erfragen', 'op-alter'),
    p('delkredere', 'Angemessenheit des Delkrederes (Einzel- und Pauschalwertberichtigung) beurteilen'),
    p('nach', 'Zahlungseingänge nach dem Stichtag für wesentliche Posten einsehen'),
    p('abgrenzung', 'Periodengerechte Fakturierung um den Stichtag (Cut-off) stichprobenweise prüfen'),
  ],
  A13: [
    p('mwst', 'Vorsteuer und Verrechnungssteuer mit Abrechnungen bzw. Steuerausweisen abstimmen', 'belege'),
    p('vorjahr', 'Veränderungen zum Vorjahr erklären', 'vorjahr'),
    p('einbringlich', 'Einbringlichkeit übriger Forderungen beurteilen'),
  ],
  A14: [
    p('inventar', 'Inventar per Stichtag mit dem Saldo abstimmen; Inventuraufnahme erfragen', 'belege'),
    p('bewertung', 'Bewertung zu Anschaffungs- bzw. Herstellkosten oder tieferem Marktwert beurteilen'),
    p('reserve', 'Warenreserve (Drittel) und Veränderung nachvollziehen'),
    p('ladenhueter', 'Nach Ladenhütern und unverkäuflichen Beständen fragen'),
  ],
  A15: [
    p('vj', 'Vorjahresabgrenzungen auf Auflösung im laufenden Jahr prüfen', 'abgrenzungen'),
    p('neu', 'Neue Abgrenzungen mit Belegen (Rechnungen, Verträge) plausibilisieren', 'abgrenzungen'),
    p('vollst', 'Vollständigkeit erfragen (wiederkehrende Vorauszahlungen, Versicherungen, Mieten)'),
  ],
  A16: [
    p('bestaetigung', 'Saldo mit Bestätigung der Gegenpartei abstimmen', 'belege'),
    p('konditionen', 'Konditionen (Zins, Rückzahlung) und Werthaltigkeit beurteilen'),
    p('anhang', 'Offenlegung gegenüber Beteiligten und Nahestehenden im Anhang prüfen'),
  ],
  A20: [
    p('vertrag', 'Darlehen und Finanzanlagen mit Verträgen bzw. Bestätigungen belegen', 'belege'),
    p('werthaltig', 'Werthaltigkeit und Zinsabgrenzung beurteilen'),
    p('vorjahr', 'Veränderungen zum Vorjahr erklären', 'vorjahr'),
  ],
  A25: [
    p('nachweis', 'Bestand mit Kaufvertrag, Aktienbuch oder Handelsregister belegen', 'belege'),
    p('werthaltig', 'Werthaltigkeit anhand der Abschlüsse der Beteiligung beurteilen'),
    p('anhang', 'Angaben zu Beteiligungen im Anhang prüfen'),
  ],
  A21: [
    p('spiegel', 'Anlagespiegel erstellen und mit Saldobilanz und Kontoblättern abstimmen', 'anlagespiegel'),
    p('zugaenge', 'Wesentliche Zugänge mit Rechnungen belegen und Aktivierbarkeit beurteilen'),
    p('abschreibung', 'Abschreibungen auf Angemessenheit (z. B. ESTV-Sätze) prüfen'),
    p('abgaenge', 'Abgänge und Verkaufserlöse nachvollziehen'),
  ],
  A22: [
    p('spiegel', 'Anlagespiegel erstellen und mit Saldobilanz und Kontoblättern abstimmen', 'anlagespiegel'),
    p('grundbuch', 'Eigentum mit Grundbuchauszug belegen; Belastungen (Hypotheken) abgleichen'),
    p('abschreibung', 'Abschreibungen und Wertvermehrungen beurteilen'),
  ],
  A23: [
    p('spiegel', 'Anlagespiegel erstellen und mit Saldobilanz abstimmen', 'anlagespiegel'),
    p('aktivierung', 'Aktivierungsvoraussetzungen und Nutzungsdauer beurteilen'),
  ],
  P10: [
    p('op', 'Kreditorenliste per Stichtag mit dem Saldo abstimmen', 'belege'),
    p('vollst', 'Vollständigkeit: Rechnungen nach dem Stichtag auf Leistungen des alten Jahres durchsehen'),
    p('vorjahr', 'Veränderungen zum Vorjahr und Debitoren mit Habensaldo erklären', 'vorjahr'),
  ],
  P11: [
    p('bank', 'Bankkredite mit Bestätigungen bzw. Verträgen per Stichtag abstimmen', 'belege'),
    p('sicherheit', 'Sicherheiten und Covenants erfragen und im Anhang offenlegen'),
  ],
  P12: [
    p('mwst', 'MWST-Schuld mit Abrechnung des letzten Quartals bzw. Semesters abstimmen', 'belege'),
    p('sozial', 'Sozialversicherungen mit Jahresabrechnungen abstimmen'),
    p('vorjahr', 'Veränderungen zum Vorjahr erklären', 'vorjahr'),
  ],
  P13: [
    p('vj', 'Vorjahresabgrenzungen auf Auflösung im laufenden Jahr prüfen', 'abgrenzungen'),
    p('neu', 'Neue Abgrenzungen und Rückstellungen mit Belegen plausibilisieren', 'abgrenzungen'),
    p('vollst', 'Vollständigkeit erfragen (Revision, Boni, Ferien- und Überzeitguthaben, Steuern)'),
  ],
  P14: [
    p('bestaetigung', 'Saldo mit Bestätigung der Gegenpartei abstimmen', 'belege'),
    p('konditionen', 'Konditionen und Rangrücktritte beurteilen; Offenlegung im Anhang prüfen'),
  ],
  P15: [
    p('steuer', 'Steuerrückstellung anhand Steuerberechnung bzw. letzter Veranlagung nachvollziehen', 'belege'),
    p('vorjahr', 'Auflösung bzw. Verwendung der Vorjahresrückstellung prüfen', 'vorjahr'),
  ],
  P20: [
    p('vertrag', 'Darlehen und Hypotheken mit Verträgen bzw. Bestätigungen abstimmen', 'belege'),
    p('fristen', 'Fristigkeit (kurz- / langfristiger Anteil) und Zinsabgrenzung prüfen'),
    p('sicherheit', 'Sicherheiten im Anhang offenlegen'),
  ],
  P21: [
    p('nachweis', 'Bestand mit Verträgen bzw. Bestätigungen belegen', 'belege'),
    p('rangruecktritt', 'Rangrücktritte und Konditionen erfragen'),
  ],
  P22: [
    p('begruendung', 'Rückstellungen auf Begründung (Ereignis vor dem Stichtag) und Höhe beurteilen', 'belege'),
    p('vorjahr', 'Verwendung und Auflösung der Vorjahresrückstellungen prüfen', 'vorjahr'),
  ],
  P30: [
    p('hr', 'Kapital mit Handelsregisterauszug abstimmen', 'belege'),
    p('veraenderung', 'Kapitalveränderungen mit Beschlüssen belegen'),
  ],
  P31: [
    p('gv', 'Gewinnverwendung gemäss GV-Beschluss verbucht', 'belege'),
    p('reserven', 'Gesetzliche Reserven (OR 672 ff.) und Kapitalverlust / Überschuldung (OR 725 ff.) beurteilen'),
    p('vorjahr', 'Vortrag mit dem Vorjahresabschluss abstimmen', 'vorjahr'),
  ],
  ER: [
    p('analyse', 'Erfolgsrechnung analytisch mit dem Vorjahr vergleichen (Margen, Kennzahlen)', 'er-analyse'),
    p('erklaerung', 'Wesentliche Abweichungen erfragen und Erklärungen dokumentieren'),
    p('umsatz', 'Umsatz mit MWST-Abrechnungen abstimmen'),
    p('personal', 'Personalaufwand mit Lohnausweisen bzw. AHV-Abrechnung abstimmen'),
    p('abgrenzung', 'Periodengerechte Abgrenzung von Aufwand und Ertrag beurteilen'),
  ],
};

/** Handlungen eines Gebiets: aus dem Katalog, sonst die allgemeinen */
export function proceduresFor(area: string, catalog: ProcedureCatalog = DEFAULT_PROCEDURES): ProcedureDef[] {
  return catalog[area] ?? (area === 'ER' || area.startsWith('E') || area === 'X90' ? [] : GENERIC_PROCEDURES);
}
