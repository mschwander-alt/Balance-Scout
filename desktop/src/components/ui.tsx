import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { call } from '../bridge';
import type { AiPreview, Decision, Status, Task } from '../types';

// ---------- Meldungen ----------
interface Toast { id: number; kind: 'ok' | 'error' | 'info'; text: string }
const ToastCtx = createContext<(kind: Toast['kind'], text: string) => void>(() => undefined);
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const seq = useRef(0);
  const push = useCallback((kind: Toast['kind'], text: string) => {
    const id = ++seq.current;
    setItems(x => [...x, { id, kind, text }]);
    setTimeout(() => setItems(x => x.filter(t => t.id !== id)), kind === 'error' ? 8000 : 4000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map(t => (
          <div key={t.id} className={`toast toast-${t.kind}`} onClick={() => setItems(x => x.filter(y => y.id !== t.id))}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

// ---------- Kleine Bausteine ----------
const STATUS_LABEL: Record<Status, string> = {
  BELEGT: 'Belegt',
  PRUEFEN: 'Prüfen',
  KEIN_NACHWEIS: 'Kein Nachweis',
  NULLSALDO: 'Nullsaldo',
  NICHT_IM_UMFANG: 'Nicht im Umfang',
};
export function StatusBadge({ status }: { status: Status }) {
  return <span className={`badge badge-${status.toLowerCase()}`}>{STATUS_LABEL[status]}</span>;
}

export const DECISION_LABEL: Record<Decision, string> = {
  offen: 'Offen',
  bestaetigt: 'Bestätigt',
  abweichung: 'Abweichung',
  nicht_anwendbar: 'Nicht anwendbar',
};
export function DecisionBadge({ decision }: { decision: Decision }) {
  return <span className={`badge badge-d-${decision}`}>{DECISION_LABEL[decision]}</span>;
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="spinner-wrap">
      <span className="spinner" aria-hidden />
      {label && <span>{label}</span>}
    </span>
  );
}

export function Modal({ title, children, onClose, footer }: { title: string; children: ReactNode; onClose: () => void; footer?: ReactNode }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} onMouseDown={e => e.stopPropagation()}>
        <h3>{title}</h3>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  );
}

// ---------- KI-Einwilligung: zeigt vor jedem Aufruf, wohin die Daten gehen ----------
const BOUNDARY_TEXT: Record<string, string> = {
  local: 'Die Daten bleiben im Netzwerk der Kanzlei.',
  tenant: 'Die Daten bleiben im Microsoft-Tenant bzw. Azure-Abonnement der Kanzlei.',
  external: 'Die Daten werden an einen externen Anbieter übermittelt.',
};

export function useAiConsent() {
  const [state, setState] = useState<{ preview: AiPreview; what: string; resolve: (ok: boolean) => void } | null>(null);
  const ask = useCallback(async (engagementId: string, task: Task, what: string): Promise<boolean> => {
    const preview = await call<AiPreview>('GET', `/api/engagements/${engagementId}/ai-preview?task=${task}`);
    return new Promise(resolve => setState({ preview, what, resolve }));
  }, []);
  const close = (ok: boolean) => {
    state?.resolve(ok);
    setState(null);
  };
  const dialog = state ? (
    <Modal
      title="KI-Verarbeitung bestätigen"
      onClose={() => close(false)}
      footer={
        <>
          <button className="btn" onClick={() => close(false)}>Abbrechen</button>
          {state.preview.allowed && <button className="btn btn-primary" onClick={() => close(true)} autoFocus>Senden</button>}
        </>
      }
    >
      {state.preview.allowed ? (
        <div className="consent">
          <p><strong>{state.what}</strong> wird verarbeitet durch:</p>
          <dl>
            <dt>Anbieter</dt><dd>{state.preview.displayName}</dd>
            <dt>Ziel</dt><dd><code>{state.preview.destination}</code></dd>
            <dt>Datengrenze</dt><dd>{BOUNDARY_TEXT[state.preview.boundary ?? ''] ?? state.preview.boundary}</dd>
          </dl>
          {state.preview.requiresUserLogin && <p className="muted">Die Anfrage erfolgt in Ihrem Namen mit Ihrem Microsoft-365-Konto.</p>}
          <p className="muted">Das Ergebnis ist ein Hinweis. Prüfentscheide treffen die Prüfregeln und Sie.</p>
        </div>
      ) : (
        <p className="error-text">{state.preview.reason}</p>
      )}
    </Modal>
  ) : null;
  return { ask, dialog };
}
