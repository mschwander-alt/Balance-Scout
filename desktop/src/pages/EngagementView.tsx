import { useCallback, useEffect, useState } from 'react';
import { bsb, call } from '../bridge';
import type { Engagement, Lock, Me } from '../types';
import { date } from '../format';
import { Spinner, useToast } from '../components/ui';
import { TrialBalanceTab } from './TrialBalanceTab';
import { EvidenceTab } from './EvidenceTab';
import { MatchingTab } from './MatchingTab';
import { LogTab } from './LogTab';
import { SettingsTab } from './SettingsTab';

type Tab = 'tb' | 'evidence' | 'matching' | 'log' | 'settings';

export function EngagementView({ engagementId, me }: { engagementId: string; me: Me }) {
  const toast = useToast();
  const [eng, setEng] = useState<Engagement | null>(null);
  const [tab, setTab] = useState<Tab>('matching');
  const [locks, setLocks] = useState<Lock[]>([]);
  const [tick, setTick] = useState(0); // erhöht sich bei Live-Ereignissen -> Tabs laden neu

  const load = useCallback(async () => {
    try {
      setEng(await call<Engagement>('GET', `/api/engagements/${engagementId}`));
      setLocks(await call<Lock[]>('GET', `/api/engagements/${engagementId}/locks`));
    } catch (e) {
      toast('error', (e as Error).message);
    }
  }, [engagementId, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  // Live-Ereignisse von Kolleginnen und Kollegen
  useEffect(
    () =>
      bsb().events.on(e => {
        if (e.engagementId !== engagementId) return;
        if (e.type === 'lock.acquired' || e.type === 'lock.released') {
          void call<Lock[]>('GET', `/api/engagements/${engagementId}/locks`).then(setLocks);
          return;
        }
        if (e.actor !== me.actor) {
          setTick(t => t + 1);
          if (e.type === 'review.updated') toast('info', `${e.actor.split('@')[0]} hat einen Prüfvermerk gespeichert.`);
          if (e.type === 'evidence.uploaded') toast('info', `${e.actor.split('@')[0]} hat Belege hochgeladen.`);
        }
      }),
    [engagementId, me.actor, toast],
  );

  if (!eng) return <div className="pad"><Spinner label="Lade Mandat …" /></div>;
  const tb = eng.trialBalances?.[0] ?? null;
  const policy = eng.settings?.aiPolicy ?? 'disabled';

  return (
    <div className="engagement">
      <header className="eng-head">
        <div>
          <h2>{eng.name}</h2>
          <p className="muted">{eng.client_name ?? '–'} · Bilanzstichtag {date(eng.closing_date)} · {eng.currency}</p>
        </div>
        <span className={`policy policy-${policy}`} title="KI-Richtlinie dieses Mandats">
          KI: {policy === 'disabled' ? 'gesperrt' : policy === 'local_only' ? 'nur lokal' : 'Microsoft-Tenant'}
        </span>
      </header>
      <nav className="tabs" role="tablist">
        {([
          ['matching', 'Abgleich'],
          ['tb', 'Saldobilanz'],
          ['evidence', 'Belege'],
          ['log', 'Protokoll'],
          ['settings', 'Einstellungen'],
        ] as [Tab, string][]).map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>{l}</button>
        ))}
      </nav>
      <section className="tab-body">
        {tab === 'tb' && <TrialBalanceTab engagement={eng} onImported={load} />}
        {tab === 'evidence' && <EvidenceTab engagement={eng} tick={tick} />}
        {tab === 'matching' && (tb ? <MatchingTab engagement={eng} trialBalanceId={tb.id} me={me} locks={locks} tick={tick} /> : <p className="muted pad">Bitte zuerst eine Saldobilanz importieren (Register „Saldobilanz“).</p>)}
        {tab === 'log' && <LogTab engagementId={eng.id} />}
        {tab === 'settings' && <SettingsTab engagement={eng} me={me} onChanged={load} />}
      </section>
    </div>
  );
}
