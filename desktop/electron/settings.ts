import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { AppSettings, ManagedKeys } from './shared';

export const DEFAULT_SETTINGS: AppSettings = {
  serverUrl: '',
  tenantId: '',
  clientId: '',
  apiScope: '',
  autoStart: true,
  notifications: 'andere',
};

/**
 * Einstellungen in zwei Ebenen:
 *  1. Richtliniendatei der IT: %ProgramData%\BalanceScout\config.json – überschreibt und sperrt Felder
 *  2. Benutzereinstellungen: %APPDATA%\Balance Scout\settings.json
 */
export class SettingsStore {
  private user: Partial<AppSettings> = {};
  private policy: Partial<AppSettings> = {};

  constructor(private readonly userFile: string, private readonly policyFile: string | null) {
    this.user = readJson(userFile);
    this.policy = policyFile ? readJson(policyFile) : {};
  }

  get(): AppSettings {
    return { ...DEFAULT_SETTINGS, ...this.user, ...this.policy };
  }

  managed(): ManagedKeys {
    return Object.fromEntries(Object.keys(this.policy).map(k => [k, true])) as ManagedKeys;
  }

  complete(): boolean {
    return validateSettings(this.get()) === null;
  }

  set(patch: Partial<AppSettings>): string | null {
    const managed = this.managed();
    const clean: Partial<AppSettings> = {};
    for (const [k, v] of Object.entries(patch) as [keyof AppSettings, never][]) {
      if (managed[k]) continue; // von der IT vorgegeben
      if (!(k in DEFAULT_SETTINGS)) continue;
      (clean as Record<string, unknown>)[k] = v;
    }
    const next = { ...this.get(), ...clean };
    const err = validateSettings(next, true);
    if (err) return err;
    this.user = { ...this.user, ...clean };
    mkdirSync(path.dirname(this.userFile), { recursive: true });
    writeFileSync(this.userFile, JSON.stringify(this.user, null, 2), 'utf8');
    return null;
  }
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Gibt eine Fehlermeldung zurück oder null. partial=true erlaubt leere Felder während der Einrichtung. */
export function validateSettings(s: AppSettings, partial = false): string | null {
  const need = (v: string) => !partial || v !== '';
  if (need(s.serverUrl)) {
    let u: URL;
    try {
      u = new URL(s.serverUrl);
    } catch {
      return 'Serveradresse ist keine gültige URL.';
    }
    const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
    if (u.protocol !== 'https:' && !local) return 'Serveradresse muss mit https:// beginnen.';
  }
  if (need(s.tenantId) && !GUID.test(s.tenantId)) return 'Tenant-ID muss eine GUID sein.';
  if (need(s.clientId) && !GUID.test(s.clientId)) return 'Client-ID muss eine GUID sein.';
  if (need(s.apiScope) && !/^(api:\/\/\S+|https:\/\/\S+)\/access_as_user$/.test(s.apiScope)) return 'API-Scope muss auf /access_as_user enden (z. B. api://balance-scout/access_as_user).';
  if (!['alle', 'andere', 'keine'].includes(s.notifications)) return 'Ungültige Benachrichtigungseinstellung.';
  return null;
}

function readJson(file: string): Partial<AppSettings> {
  try {
    if (!existsSync(file)) return {};
    const raw = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

export function policyFilePath(): string | null {
  const base = process.env.ProgramData;
  return base ? path.join(base, 'BalanceScout', 'config.json') : null;
}
