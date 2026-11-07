import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';

export interface EntraAuthConfig {
  tenantId: string;
  /** Erlaubte Audiences: Application-ID-URI und/oder Client-ID der Server-API */
  audiences: string[];
  /** App-Rolle mit Administratorrechten */
  adminRole: string;
  /** Rolle, die für die Nutzung nötig ist (leer = jeder im Tenant) */
  userRole?: string;
}

export interface Principal {
  /** Anzeige-/Protokollname, i. d. R. UPN (z. B. anna.muster@kanzlei.ch) */
  actor: string;
  name: string;
  oid: string;
  roles: string[];
  isAdmin: boolean;
  /** Das rohe Token – dient als Assertion für On-Behalf-Of (Copilot, SharePoint) */
  assertion: string;
}

export class AuthError extends Error {}

/**
 * Prüft Microsoft-Entra-Zugriffstoken (v2) für die Server-API:
 * Signatur (JWKS), Aussteller (eigener Tenant), Audience, Ablauf, Scope access_as_user.
 */
export class EntraVerifier {
  private readonly jwks: JWTVerifyGetKey;
  private readonly issuers: string[];

  constructor(private readonly cfg: EntraAuthConfig, jwks?: JWTVerifyGetKey) {
    this.jwks = jwks ?? createRemoteJWKSet(new URL(`https://login.microsoftonline.com/${cfg.tenantId}/discovery/v2.0/keys`));
    this.issuers = [`https://login.microsoftonline.com/${cfg.tenantId}/v2.0`, `https://sts.windows.net/${cfg.tenantId}/`];
  }

  async verify(token: string): Promise<Principal> {
    let payload: JWTPayload & Record<string, unknown>;
    try {
      ({ payload } = await jwtVerify(token, this.jwks, { issuer: this.issuers, audience: this.cfg.audiences, clockTolerance: 60 }));
    } catch (e) {
      throw new AuthError(`Anmeldung ungültig: ${(e as Error).message}`);
    }
    if (payload.tid !== this.cfg.tenantId) throw new AuthError('Token stammt nicht aus dem eigenen Tenant.');
    const scopes = String(payload.scp ?? '').split(' ').filter(Boolean);
    if (!scopes.includes('access_as_user')) throw new AuthError('Token enthält den Scope access_as_user nicht.');
    const roles = Array.isArray(payload.roles) ? (payload.roles as string[]) : [];
    if (this.cfg.userRole && !roles.includes(this.cfg.userRole) && !roles.includes(this.cfg.adminRole)) {
      throw new AuthError('Keine Berechtigung für Balance Scout (App-Rolle fehlt).');
    }
    const actor = String(payload.preferred_username ?? payload.upn ?? payload.oid ?? '');
    if (!actor) throw new AuthError('Token ohne Benutzerkennung.');
    return {
      actor,
      name: String(payload.name ?? actor),
      oid: String(payload.oid ?? ''),
      roles,
      isAdmin: roles.includes(this.cfg.adminRole),
      assertion: token,
    };
  }
}
