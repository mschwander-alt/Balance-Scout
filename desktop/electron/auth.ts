import path from 'node:path';
import {
  PublicClientApplication,
  InteractionRequiredAuthError,
  type AccountInfo,
  type AuthenticationResult,
  type Configuration,
  type INativeBrokerPlugin,
  type ICachePlugin,
} from '@azure/msal-node';
import type { AppSettings, AuthStatus } from './shared';

export interface AuthDeps {
  /** Öffnet die Microsoft-Anmeldeseite im Standardbrowser (Fallback ohne WAM) */
  openBrowser(url: string): Promise<void>;
  /** Fensterhandle für den Windows-Anmeldedialog (WAM) */
  windowHandle(): Buffer | undefined;
  cacheDir: string;
}

/**
 * Microsoft-Anmeldung der Windows-App.
 *  - Bevorzugt WAM (Windows-Kontoverwaltung): Single Sign-on mit dem Windows-/Microsoft-365-Konto
 *  - Fallback: Systembrowser mit Loopback-Umleitung
 *  - Token-Cache verschlüsselt mit Windows DPAPI (nur dieser Benutzer auf diesem Gerät)
 */
export class AuthService {
  private pca: PublicClientApplication | null = null;
  private broker = false;
  private account: AccountInfo | null = null;
  private configKey = '';

  constructor(private readonly deps: AuthDeps) {}

  private async client(s: AppSettings): Promise<PublicClientApplication> {
    const key = `${s.tenantId}|${s.clientId}`;
    if (this.pca && key === this.configKey) return this.pca;
    const ext = await loadExtensions();
    let cachePlugin: ICachePlugin | undefined;
    let brokerPlugin: INativeBrokerPlugin | undefined;
    if (ext) {
      try {
        const persistence = await ext.PersistenceCreator.createPersistence({
          cachePath: path.join(this.deps.cacheDir, 'msal-cache.bin'),
          dataProtectionScope: ext.DataProtectionScope.CurrentUser,
          serviceName: 'BalanceScout',
          accountName: 'msal',
          usePlaintextFileOnLinux: false,
        });
        cachePlugin = new ext.PersistenceCachePlugin(persistence);
      } catch {
        cachePlugin = undefined; // ohne persistenten Cache: Anmeldung pro Sitzung
      }
      try {
        const nb = new ext.NativeBrokerPlugin();
        if (nb.isBrokerAvailable) brokerPlugin = nb;
      } catch {
        brokerPlugin = undefined;
      }
    }
    const config: Configuration = {
      auth: { clientId: s.clientId, authority: `https://login.microsoftonline.com/${s.tenantId}` },
      broker: brokerPlugin ? { nativeBrokerPlugin: brokerPlugin } : undefined,
      cache: cachePlugin ? { cachePlugin } : undefined,
    };
    this.pca = new PublicClientApplication(config);
    this.broker = !!brokerPlugin;
    this.configKey = key;
    this.account = null;
    return this.pca;
  }

  async status(s: AppSettings): Promise<AuthStatus> {
    try {
      const token = await this.tokenSilent(s);
      return this.statusFrom(token ? this.account : null);
    } catch (e) {
      return { signedIn: false, broker: this.broker, error: (e as Error).message };
    }
  }

  async signIn(s: AppSettings): Promise<AuthStatus> {
    const pca = await this.client(s);
    const scopes = [s.apiScope];
    let r: AuthenticationResult | null = null;
    try {
      r = await this.tokenSilent(s);
      if (!r) {
        r = await pca.acquireTokenInteractive({
          scopes,
          windowHandle: this.broker ? this.deps.windowHandle() : undefined,
          openBrowser: this.deps.openBrowser,
          successTemplate: '<h2>Angemeldet.</h2><p>Sie können dieses Fenster schliessen und zu Balance Scout zurückkehren.</p>',
          errorTemplate: '<h2>Anmeldung fehlgeschlagen.</h2><p>{{error}}</p>',
        });
      }
    } catch (e) {
      return { signedIn: false, broker: this.broker, error: friendly(e) };
    }
    this.account = r?.account ?? null;
    return this.statusFrom(this.account);
  }

  async signOut(s: AppSettings): Promise<AuthStatus> {
    const pca = await this.client(s);
    for (const a of await pca.getTokenCache().getAllAccounts()) await pca.getTokenCache().removeAccount(a);
    this.account = null;
    return { signedIn: false, broker: this.broker };
  }

  /** Zugriffstoken für die Server-API; null, wenn (erneute) Anmeldung nötig ist. */
  async accessToken(s: AppSettings): Promise<string | null> {
    return (await this.tokenSilent(s))?.accessToken ?? null;
  }

  private async tokenSilent(s: AppSettings): Promise<AuthenticationResult | null> {
    const pca = await this.client(s);
    const account = this.account ?? (await pca.getTokenCache().getAllAccounts())[0] ?? null;
    if (!account) return null;
    try {
      const r = await pca.acquireTokenSilent({ account, scopes: [s.apiScope] });
      this.account = r.account;
      return r;
    } catch (e) {
      if (e instanceof InteractionRequiredAuthError) return null;
      throw e;
    }
  }

  private statusFrom(a: AccountInfo | null): AuthStatus {
    return a ? { signedIn: true, broker: this.broker, account: { name: a.name ?? a.username, username: a.username } } : { signedIn: false, broker: this.broker };
  }
}

type Ext = typeof import('@azure/msal-node-extensions');
async function loadExtensions(): Promise<Ext | null> {
  try {
    return await import('@azure/msal-node-extensions');
  } catch {
    return null;
  }
}

function friendly(e: unknown): string {
  const m = (e as Error).message ?? String(e);
  if (/user_cancelled|cancel/i.test(m)) return 'Anmeldung abgebrochen.';
  if (/AADSTS50105|AADSTS50011/.test(m)) return 'Ihr Konto ist für Balance Scout nicht freigeschaltet. Bitte an die IT wenden.';
  if (/AADSTS65001/.test(m)) return 'Die Administratorzustimmung für Balance Scout fehlt. Bitte an die IT wenden.';
  return `Anmeldung fehlgeschlagen: ${m}`;
}
