import { SignJWT, exportJWK, generateKeyPair, createLocalJWKSet, type JWK } from 'jose';

export const TEST_TENANT = '11111111-2222-3333-4444-555555555555';
export const TEST_AUDIENCE = 'api://balance-scout';

/** Erzeugt ein Schlüsselpaar und signiert Entra-ähnliche v2-Zugriffstoken (nur für Tests). */
export async function testKeys() {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256' } as JWK;
  const sign = (claims: Record<string, unknown>) =>
    new SignJWT({ tid: TEST_TENANT, scp: 'access_as_user', ver: '2.0', ...claims })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(`https://login.microsoftonline.com/${TEST_TENANT}/v2.0`)
      .setAudience(TEST_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(privateKey);
  return { jwks: createLocalJWKSet({ keys: [jwk] }), sign };
}
