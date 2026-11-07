import { useEffect, useState } from 'react';
import { bsb } from '../bridge';
import type { HistoryEntry } from '../../electron/shared';
import { date, dateTime, pct } from '../format';

export function Start({ onNew, onOpen }: { onNew: () => void; onOpen: (h: HistoryEntry) => void }) {
  const [hist, setHist] = useState<HistoryEntry[] | null>(null);
  useEffect(() => void bsb().app.history().then(setHist), []);
  return (
    <div className="page stack">
      <div className="card">
        <h2>Saldennachweis-Prüfung</h2>
        <p className="muted">
          Saldobilanz und Unterlagen des Kunden wählen – Balance Scout liest alle Dateien (inkl. Scans und Unterordner), gleicht jeden Saldo ab,
          erstellt die Excel-Dokumentation und legt die Belege in <code>01_Zugeordnet</code> / <code>02_Nicht_zugeordnet</code> ab.
          Alles läuft auf diesem PC; es werden keine Daten übertragen.
        </p>
        <button className="btn btn-primary btn-lg" onClick={onNew}>+ Neue Prüfung starten</button>
      </div>
      <div className="card">
        <h3>Letzte Prüfungen</h3>
        {hist === null ? null : hist.length === 0 ? <p className="muted">Noch keine Prüfungen.</p> : (
          <div className="hist">
            {hist.map(h => (
              <div key={h.id} style={{ display: 'contents' }}>
                <div>
                  <strong>{h.mandate}</strong>
                  <div className="muted small">Stichtag {date(h.closingDate)} · geprüft {dateTime(h.at)} · {h.documents} Belege</div>
                </div>
                <div className="small">
                  <span className="badge badge-belegt">{h.counts.BELEGT} belegt</span>{' '}
                  <span className="badge badge-pruefen">{h.counts.PRUEFEN} prüfen</span>{' '}
                  <span className="badge badge-kein_nachweis">{h.counts.KEIN_NACHWEIS} ohne</span>{' '}
                  <span className="pill">Abdeckung {pct(h.coverage)}</span>
                </div>
                <div className="actions">
                  <button className="btn btn-sm" onClick={() => onOpen(h)}>Ergebnis</button>
                  <button className="btn btn-sm" onClick={() => bsb().app.openPath(h.excelPath)}>Excel</button>
                  <button className="link small" onClick={async () => setHist(await bsb().app.removeHistory(h.id))}>entfernen</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
