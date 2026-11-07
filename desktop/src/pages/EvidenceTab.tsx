import { useCallback, useEffect, useState } from 'react';
import { bsb, call } from '../bridge';
import type { Engagement, Evidence } from '../types';
import { date, dateTime } from '../format';
import { Spinner, useAiConsent, useToast } from '../components/ui';

export function EvidenceTab({ engagement, tick }: { engagement: Engagement; tick: number }) {
  const toast = useToast();
  const { ask, dialog } = useAiConsent();
  const [docs, setDocs] = useState<Evidence[] | null>(null);
  const [busy, setBusy] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      setDocs(await call<Evidence[]>('GET', `/api/engagements/${engagement.id}/evidence`));
    } catch (e) {
      toast('error', (e as Error).message);
    }
  }, [engagement.id, toast]);
  useEffect(() => {
    void load();
  }, [load, tick]);

  const setB = (id: string, v: string | null) => setBusy(b => {
    const n = { ...b };
    if (v) n[id] = v;
    else delete n[id];
    return n;
  });

  const upload = async () => {
    const files = await bsb().api.pickFiles({ multiple: true, filters: [{ name: 'Belege', extensions: ['pdf', 'xlsx', 'xlsm', 'csv', 'txt', 'png', 'jpg', 'jpeg', 'tif', 'tiff'] }] });
    if (!files.length) return;
    setB('_upload', `${files.length} Datei(en) …`);
    const r = await bsb().api.upload<{ filename: string; status: string; reason?: string; needsOcr?: boolean }[]>(`/api/engagements/${engagement.id}/evidence`, files);
    setB('_upload', null);
    if (!r.ok) return toast('error', r.error ?? 'Upload fehlgeschlagen');
    const res = r.data ?? [];
    const stored = res.filter(x => x.status === 'stored').length;
    const dup = res.filter(x => x.status === 'duplicate').length;
    const rej = res.filter(x => x.status === 'rejected');
    toast('ok', `${stored} Beleg(e) gespeichert${dup ? `, ${dup} bereits vorhanden` : ''}.`);
    if (rej.length) toast('error', `Abgelehnt: ${rej.map(x => x.filename).join(', ')}`);
    if (res.some(x => x.needsOcr)) toast('info', 'Gescannte Belege erkannt – für die Auswertung „KI-Auswertung“ verwenden.');
    void load();
  };

  const aiExtract = async (d: Evidence) => {
    if (!(await ask(engagement.id, 'evidence_extraction', `Beleg „${d.filename}“`))) return;
    setB(d.id, 'KI wertet aus …');
    await bsb().app.setActivity(`KI-Auswertung: ${d.filename}`);
    try {
      const r = await call<{ verification: { verifiedCount: number; rejectedCount: number; balanceDate: string | null }; ocr: boolean }>('POST', `/api/evidence/${d.id}/ai-extract`, {});
      const v = r.verification;
      toast('ok', `${d.filename}: ${v.verifiedCount} Saldo/Salden bestätigt${v.rejectedCount ? `, ${v.rejectedCount} verworfen (nicht im Beleg gefunden)` : ''}${v.balanceDate ? `, Stichtag ${date(v.balanceDate)}` : ''}.`);
      void load();
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setB(d.id, null);
      await bsb().app.setActivity(null);
    }
  };

  const toSharePoint = async (d: Evidence) => {
    setB(d.id, 'SharePoint …');
    try {
      await call('POST', `/api/evidence/${d.id}/sharepoint`, {});
      toast('ok', `${d.filename} in SharePoint abgelegt.`);
      void load();
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setB(d.id, null);
    }
  };

  return (
    <div className="stack">
      {dialog}
      <div className="row">
        <button className="btn btn-primary" onClick={upload} disabled={!!busy._upload}>Belege hochladen …</button>
        {busy._upload && <Spinner label={busy._upload} />}
        <span className="muted small">PDF, Excel, CSV, Bilder · Duplikate werden erkannt</span>
      </div>
      {docs === null ? <Spinner /> : docs.length === 0 ? <p className="muted">Noch keine Belege.</p> : (
        <table className="grid">
          <thead>
            <tr><th>Datei</th><th>Text</th><th>KI-Auswertung</th><th>SharePoint</th><th>Hochgeladen</th><th /></tr>
          </thead>
          <tbody>
            {docs.map(d => (
              <tr key={d.id}>
                <td>{d.filename}<div className="muted small">{d.page_count} S. · {(d.size_bytes / 1024).toFixed(0)} KB</div></td>
                <td>{d.needs_ocr ? <span className="badge badge-pruefen" title="Keine Textebene – Texterkennung nötig">Scan</span> : <span className="muted">{d.line_count} Zeilen</span>}</td>
                <td>
                  {d.ai ? (
                    <span title={`Anbieter: ${d.ai.provider}`}>
                      ✓ {d.ai.verified} bestätigt{d.ai.rejected ? <span className="warn"> · {d.ai.rejected} verworfen</span> : null}
                      {d.ai.balanceDate && <div className="muted small">Stichtag {date(d.ai.balanceDate)}</div>}
                    </span>
                  ) : <span className="muted">–</span>}
                </td>
                <td>{d.sharepoint_url ? <button className="link" onClick={() => bsb().app.openExternal(d.sharepoint_url!)}>öffnen</button> : <span className="muted">–</span>}</td>
                <td className="muted small">{dateTime(d.created_at)}</td>
                <td className="actions">
                  {busy[d.id] ? <Spinner label={busy[d.id]} /> : (
                    <>
                      <button className="btn btn-sm" onClick={() => aiExtract(d)}>KI-Auswertung</button>
                      {!d.sharepoint_url && <button className="btn btn-sm" onClick={() => toSharePoint(d)} title="Für Microsoft 365 Copilot lesbar machen">In SharePoint</button>}
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
