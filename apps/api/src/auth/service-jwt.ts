/**
 * Short-lived EdDSA service tokens (system-design §8):
 *
 *   "Access to internal services uses short-lived (5 min) EdDSA-signed JWTs
 *    minted by the gateway."
 *
 * The gateway is the only minter. Downstream services verify with the public
 * key; nothing downstream ever sees a user session cookie.
 */
import { importPKCS8, importSPKI, jwtVerify, SignJWT, type JWTPayload, type KeyLike } from 'jose';
import { generateKeyPairSync } from 'node:crypto';
import { ApiError } from '../errors.js';
import type { Env } from '../env.js';

const ALG = 'EdDSA';

export interface ServiceTokenClaims extends JWTPayload {
  /** The user the call is made on behalf of, when there is one. */
  sub?: string;
  /** Cell that minted the token, for blast-radius attribution. */
  cell: string;
  scope: string[];
  act: 'api-gateway';
}

export interface ServiceTokenIssuer {
  mint(input: {
    audience: string;
    subject?: string;
    scope: readonly string[];
    extra?: Record<string, string | number | boolean>;
  }): Promise<string>;
  verify(token: string, audience: string): Promise<ServiceTokenClaims>;
  publicKeyPem(): string;
}

/**
 * Builds the issuer. If no key pair is configured, an ephemeral Ed25519 pair is
 * generated for this process — correct for local development and for tests,
 * and useless to an attacker because it dies with the process. Production
 * always supplies `SERVICE_JWT_PRIVATE_KEY`.
 */
export async function createServiceTokenIssuer(env: Env): Promise<ServiceTokenIssuer> {
  let privateKey: KeyLike;
  let publicKey: KeyLike;
  let publicPem: string;

  if (env.SERVICE_JWT_PRIVATE_KEY && env.SERVICE_JWT_PUBLIC_KEY) {
    privateKey = await importPKCS8(env.SERVICE_JWT_PRIVATE_KEY, ALG);
    publicKey = await importSPKI(env.SERVICE_JWT_PUBLIC_KEY, ALG);
    publicPem = env.SERVICE_JWT_PUBLIC_KEY;
  } else {
    if (env.NODE_ENV === 'production') {
      throw new Error(
        'SERVICE_JWT_PRIVATE_KEY and SERVICE_JWT_PUBLIC_KEY are required in production.',
      );
    }
    const pair = generateKeyPairSync('ed25519');
    publicPem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    privateKey = await importPKCS8(
      pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      ALG,
    );
    publicKey = await importSPKI(publicPem, ALG);
  }

  const allowedAudiences = new Set(env.SERVICE_JWT_AUDIENCE);

  return {
    async mint({ audience, subject, scope, extra }) {
      if (!allowedAudiences.has(audience)) {
        throw new ApiError(
          'internal-error',
          `Refusing to mint a service token for unknown audience "${audience}".`,
        );
      }

      const jwt = new SignJWT({
        cell: env.CELL_ID,
        scope: [...scope],
        act: 'api-gateway',
        ...extra,
      })
        .setProtectedHeader({ alg: ALG, typ: 'JWT' })
        .setIssuedAt()
        .setIssuer(env.SERVICE_JWT_ISSUER)
        .setAudience(audience)
        .setExpirationTime(`${env.SERVICE_JWT_TTL_SECONDS}s`)
        .setJti(crypto.randomUUID());

      if (subject) jwt.setSubject(subject);

      return jwt.sign(privateKey);
    },

    async verify(token, audience) {
      try {
        const { payload } = await jwtVerify(token, publicKey, {
          issuer: env.SERVICE_JWT_ISSUER,
          audience,
          algorithms: [ALG],
          clockTolerance: 5,
        });
        return payload as ServiceTokenClaims;
      } catch (error) {
        throw new ApiError('unauthorized', 'Invalid or expired service token.', { cause: error });
      }
    },

    publicKeyPem: () => publicPem,
  };
}
