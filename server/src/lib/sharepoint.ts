import type { TokenProvider } from '../ai/entra.js';
import { AiError } from '../ai/types.js';

export interface SharePointConfig {
  /** Dokumentbibliothek (Drive-ID) für Prüfungsbelege */
  driveId: string;
  /** Basisordner innerhalb der Bibliothek */
  rootFolder: string;
  graphBaseUrl: string;
}

/**
 * Legt Belege im Namen des Benutzers in SharePoint ab (delegiert, On-Behalf-Of),
 * damit Microsoft 365 Copilot sie als Dateikontext lesen kann. Berechtigungen und
 * Vertraulichkeitsbezeichnungen von SharePoint gelten unverändert.
 */
export class SharePointUploader {
  constructor(private readonly cfg: SharePointConfig, private readonly tokens: TokenProvider) {}

  async upload(userAssertion: string, folder: string[], filename: string, content: Buffer): Promise<{ webUrl: string; itemId: string }> {
    if (content.length > 250 * 1024 * 1024) throw new AiError('Datei grösser als 250 MB – Ablage in SharePoint nicht möglich.', 'UNSUPPORTED', 413);
    const token = await this.tokens.onBehalfOf(userAssertion, ['https://graph.microsoft.com/Sites.ReadWrite.All']);
    const segments = [this.cfg.rootFolder, ...folder, filename].filter(Boolean).map(s => encodeURIComponent(sanitize(s)));
    const url = `${this.cfg.graphBaseUrl.replace(/\/$/, '')}/drives/${encodeURIComponent(this.cfg.driveId)}/root:/${segments.join('/')}:/content?@microsoft.graph.conflictBehavior=replace`;
    const res = await fetch(url, { method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' }, body: new Uint8Array(content) });
    const text = await res.text();
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) throw new AiError(`SharePoint verweigert den Zugriff (${res.status}). Berechtigung auf die Bibliothek prüfen.`, 'AUTH_REQUIRED', 403);
      throw new AiError(`SharePoint-Ablage fehlgeschlagen (${res.status}): ${text.slice(0, 300)}`, 'UPSTREAM');
    }
    const item = JSON.parse(text) as { id: string; webUrl: string };
    return { webUrl: item.webUrl, itemId: item.id };
  }
}

/** SharePoint-unzulässige Zeichen ersetzen */
function sanitize(s: string): string {
  return s.replace(/["*:<>?/\\|#%]/g, '_').replace(/^\.+|\.+$/g, '').trim().slice(0, 200) || 'unbenannt';
}
