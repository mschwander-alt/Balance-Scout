import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { Status } from '../types';

interface Toast { id: number; kind: 'ok' | 'error' | 'info'; text: string }
const ToastCtx = createContext<(kind: Toast['kind'], text: string) => void>(() => undefined);
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const seq = useRef(0);
  const push = useCallback((kind: Toast['kind'], text: string) => {
    const id = ++seq.current;
    setItems(x => [...x, { id, kind, text }]);
    setTimeout(() => setItems(x => x.filter(t => t.id !== id)), kind === 'error' ? 9000 : 4500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map(t => <div key={t.id} className={`toast toast-${t.kind}`} onClick={() => setItems(x => x.filter(y => y.id !== t.id))}>{t.text}</div>)}
      </div>
    </ToastCtx.Provider>
  );
}

const LABEL: Record<Status, string> = { BELEGT: 'Belegt', PRUEFEN: 'Prüfen', KEIN_NACHWEIS: 'Kein Nachweis', NULLSALDO: 'Nullsaldo', NICHT_IM_UMFANG: 'Nicht im Umfang' };
export const statusLabel = (s: Status) => LABEL[s];
export function StatusBadge({ status }: { status: Status }) {
  return <span className={`badge badge-${status.toLowerCase()}`}>{LABEL[status]}</span>;
}

export const FLAG_LABEL: Record<string, string> = {
  SIGN_CONFLICT: 'Vorzeichen', AMBIGUOUS: 'Mehrdeutig', CURRENCY_MISMATCH: 'Währung', DATE_MISMATCH: 'Stichtag', OCR_SOURCE: 'Scan/OCR', LOW_SPECIFICITY: 'Zufallsrisiko',
};

export function Spinner({ label }: { label?: string }) {
  return <span className="spinner-wrap"><span className="spinner" aria-hidden />{label && <span>{label}</span>}</span>;
}

export function Modal({ title, children, onClose, footer, wide }: { title: string; children: ReactNode; onClose: () => void; footer?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal" style={wide ? { width: 900 } : undefined} role="dialog" aria-modal="true" aria-label={title} onMouseDown={e => e.stopPropagation()}>
        <h3>{title}</h3>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  );
}
