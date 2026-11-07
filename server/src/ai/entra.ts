import { ConfidentialClientApplication } from '@azure/msal-node';
import { AiError } from './types.js';

export interface EntraAppConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
}

/**
 * Token-Beschaffung über Microsoft Entra ID.
 *  - onBehalfOf: delegiert, im Namen des angemeldeten Benutzers (Pflicht für M365 Copilot APIs)
 *  - appOnly:    Client-Credentials (z. B. für Azure AI Foundry)
 */
export interface TokenProvider {
  onBehalfOf(userAssertion: string, scopes: string[]): Promise<string>;
  appOnly(scopes: string[]): Promise<string>;
}

export function createEntraTokenProvider(cfg: EntraAppConfig): TokenProvider {
  const cca = new ConfidentialClientApplication({
    auth: { clientId: cfg.clientId, authority: `https://login.microsoftonline.com/${cfg.tenantId}`, clientSecret: cfg.clientSecret },
  });
  return {
    async onBehalfOf(userAssertion, scopes) {
      try {
        const r = await cca.acquireTokenOnBehalfOf({ oboAssertion: userAssertion, scopes });
        if (!r?.accessToken) throw new Error('kein Token erhalten');
        return r.accessToken;
      } catch (e) {
        throw new AiError(`Anmeldung bei Microsoft fehlgeschlagen (On-Behalf-Of): ${(e as Error).message}`, 'AUTH_REQUIRED', 401);
      }
    },
    async appOnly(scopes) {
      try {
        const r = await cca.acquireTokenByClientCredential({ scopes });
        if (!r?.accessToken) throw new Error('kein Token erhalten');
        return r.accessToken;
      } catch (e) {
        throw new AiError(`Anmeldung bei Microsoft fehlgeschlagen (App): ${(e as Error).message}`, 'AUTH_REQUIRED', 401);
      }
    },
  };
}
