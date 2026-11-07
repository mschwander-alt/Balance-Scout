/**
 * Gemeinsame Typen zwischen Hauptprozess (Electron) und Oberfläche (React).
 * Die Oberfläche hat keinen direkten Netz- oder Dateizugriff; alles läuft
 * über diese schmale, geprüfte Schnittstelle (window.bsb).
 */

export interface AppSettings {
  /** Adresse des Balance-Scout-Servers in Azure, z. B. https://balance-scout.kanzlei.ch */
  serverUrl: string;
  /** Entra-Tenant-ID */
  tenantId: string;
  /** Client-ID der Desktop-App-Registrierung */
  clientId: string;
  /** Scope der Server-API, z. B. api://balance-scout/access_as_user */
  apiScope: string;
  autoStart: boolean;
  notifications: 'alle' | 'andere' | 'keine';
}

/** Welche Felder durch die IT (Richtliniendatei) fest vorgegeben sind */
export type ManagedKeys = Partial<Record<keyof AppSettings, true>>;

export interface AuthStatus {
  signedIn: boolean;
  account?: { name: string; username: string };
  /** Windows-Anmeldung (WAM) verfügbar */
  broker: boolean;
  error?: string;
}

export interface ApiResult<T = unknown> {
  ok: boolean;
  status: number;
  data?: T;
  error?: string;
}

export interface PickedFile {
  path: string;
  name: string;
  size: number;
}

export interface ServerEvent {
  type: string;
  engagementId: string;
  actor: string;
  data: Record<string, unknown>;
  at: string;
}

export interface BsbBridge {
  settings: {
    get(): Promise<{ settings: AppSettings; managed: ManagedKeys; complete: boolean }>;
    set(s: Partial<AppSettings>): Promise<{ ok: boolean; error?: string }>;
  };
  auth: {
    status(): Promise<AuthStatus>;
    signIn(): Promise<AuthStatus>;
    signOut(): Promise<AuthStatus>;
  };
  api: {
    request<T = unknown>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<ApiResult<T>>;
    pickFiles(opts: { multiple: boolean; filters: { name: string; extensions: string[] }[] }): Promise<PickedFile[]>;
    upload<T = unknown>(path: string, files: PickedFile[], fields?: Record<string, string>, fieldName?: string): Promise<ApiResult<T>>;
  };
  events: {
    watch(engagementId: string | null): Promise<void>;
    on(cb: (e: ServerEvent) => void): () => void;
    onConnection(cb: (state: 'connected' | 'reconnecting' | 'offline') => void): () => void;
  };
  app: {
    setActivity(label: string | null): Promise<void>;
    setRecent(items: { id: string; name: string }[]): Promise<void>;
    onNavigate(cb: (engagementId: string) => void): () => void;
    openExternal(url: string): Promise<void>;
    version(): Promise<string>;
  };
}
