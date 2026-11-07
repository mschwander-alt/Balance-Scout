import { useEffect, useRef, useState } from 'react';
import { bsb } from '../bridge';
import type { FilePreview } from '../../electron/shared';
import type { BBox } from '../types';
import { Spinner } from './ui';

/**
 * Belegvorschau mit markierter Fundstelle.
 * Bild (PDF-Seite, Scan, Foto): gelber Rahmen an der erkannten Position.
 * Tabelle (Excel/CSV) und Text (Word/TXT): hervorgehobene Zeile.
 */
export function DocumentPreview({ file, page, lineNo, bbox, line }: { file: string; page: number; lineNo: number; bbox?: BBox; line: string }) {
  const [current, setCurrent] = useState(page);
  const [zoom, setZoom] = useState(1);
  const [pv, setPv] = useState<FilePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const mark = useRef<HTMLElement | null>(null);
  const scroller = useRef<HTMLDivElement | null>(null);

  useEffect(() => setCurrent(page), [file, page, lineNo]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    bsb().engine.filePreview(file, current).then(
      r => alive && setPv(r),
      e => alive && setError(String((e as Error).message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')),
    ).finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [file, current]);

  // Markierung nur, wenn die angezeigte UND die gewählte Seite die Fundstellen-Seite ist
  const onTarget = pv?.page === page && current === page;
  // Fundstelle in den sichtbaren Bereich scrollen
  useEffect(() => {
    if (!pv || !onTarget) return;
    const t = setTimeout(() => mark.current?.scrollIntoView({ block: 'center', inline: 'nearest' }), 30);
    return () => clearTimeout(t);
  }, [pv, onTarget, zoom]);

  const pages = pv?.pageCount ?? 1;
  return (
    <div className="viewer">
      <div className="viewer-bar">
        <button className="btn btn-sm" disabled={current <= 1} onClick={() => setCurrent(c => c - 1)} aria-label="vorherige Seite">‹</button>
        <span className="small">{pv && 'pageLabel' in pv && pv.pageLabel ? pv.pageLabel : `Seite ${current}`} {pages > 1 && `· ${current}/${pages}`}</span>
        <button className="btn btn-sm" disabled={current >= pages} onClick={() => setCurrent(c => c + 1)} aria-label="nächste Seite">›</button>
        {current !== page && <button className="link small" onClick={() => setCurrent(page)}>zur Fundstelle</button>}
        <span className="spacer" />
        {pv?.kind === 'image' && (
          <>
            <button className="btn btn-sm" onClick={() => setZoom(z => Math.max(1, z - 0.5))} disabled={zoom <= 1} aria-label="verkleinern">−</button>
            <span className="small">{Math.round(zoom * 100)} %</span>
            <button className="btn btn-sm" onClick={() => setZoom(z => Math.min(3, z + 0.5))} disabled={zoom >= 3} aria-label="vergrössern">+</button>
          </>
        )}
      </div>
      <div className="viewer-body" ref={scroller}>
        {loading && !pv && <div className="pad"><Spinner label="Vorschau wird erstellt …" /></div>}
        {error && <p className="err-box">{error}</p>}
        {pv?.kind === 'image' && (
          <div className="page-img" style={{ width: `${zoom * 100}%` }}>
            <img src={pv.dataUrl} alt={`Seite ${pv.page}`} draggable={false} />
            {onTarget && bbox && (
              <span
                ref={el => (mark.current = el)}
                className="hl-box"
                title={line}
                style={{ left: `${bbox.x0 * 100}%`, top: `${bbox.y0 * 100}%`, width: `${(bbox.x1 - bbox.x0) * 100}%`, height: `${(bbox.y1 - bbox.y0) * 100}%` }}
              />
            )}
            {loading && <div className="page-loading"><Spinner /></div>}
          </div>
        )}
        {pv?.kind === 'table' && (
          <table className="sheet">
            <tbody>
              {pv.rows.map((r, i) => (
                <tr key={i} ref={onTarget && i === lineNo - 1 ? el => (mark.current = el) : undefined} className={onTarget && i === lineNo - 1 ? 'hl-row' : ''}>
                  <td className="rn">{i + 1}</td>
                  {r.map((c, j) => <td key={j} className={/^-?[\d'.,]+$/.test(c) ? 'num' : ''}>{c}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {pv?.kind === 'text' && (
          <div className="textdoc">
            {pv.lines.map((l, i) => (
              <div key={i} ref={onTarget && i === lineNo - 1 ? el => (mark.current = el) : undefined} className={onTarget && i === lineNo - 1 ? 'hl-row' : ''}>{l || '\u00a0'}</div>
            ))}
          </div>
        )}
        {pv?.kind === 'unsupported' && <p className="muted pad">{pv.message}</p>}
      </div>
    </div>
  );
}
