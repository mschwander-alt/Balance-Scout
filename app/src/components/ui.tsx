import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type TextareaHTMLAttributes } from 'react';
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

/** Info-Symbol: technische Details erst bei Hover/Klick (Tastatur: Tab) */
export function Info({ children, left, label = 'Details' }: { children: ReactNode; left?: boolean; label?: string }) {
  return (
    <span className="info" tabIndex={0} role="button" aria-label={label} onClick={e => e.stopPropagation()}>
      i<span className={`tip ${left ? 'left' : ''}`} role="tooltip">{children}</span>
    </span>
  );
}
/** Warnsymbol – nur bei Problemen */
export function WarnIcon({ text }: { text: string }) {
  return <span className="warn-icon" title={text} aria-label={text}>⚠</span>;
}

/**
 * Textfeld für Bemerkungen, Notizen und Feststellungen: bricht um und wächst mit dem Text (kein verschwundener Text).
 * `submitOnEnter`: Enter löst `onSubmit` aus bzw. verlässt das Feld, Shift+Enter fügt eine neue Zeile ein.
 */
export function AutoTextarea({ submitOnEnter, onSubmit, minRows = 1, className, onKeyDown, onInput, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement> & { submitOnEnter?: boolean; onSubmit?: () => void; minRows?: number }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const fit = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + 2}px`;
  };
  useLayoutEffect(fit);
  return (
    <textarea
      ref={ref} rows={minRows} className={`auto-text ${className ?? ''}`} {...rest}
      onInput={e => { fit(); onInput?.(e); }}
      onKeyDown={e => {
        if (submitOnEnter && e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
          e.preventDefault();
          if (onSubmit) onSubmit(); else (e.target as HTMLTextAreaElement).blur();
        }
        onKeyDown?.(e);
      }}
    />
  );
}
