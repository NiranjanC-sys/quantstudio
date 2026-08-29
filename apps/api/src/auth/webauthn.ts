/**
 * WebAuthn passkeys (system-design §8), on `@simplewebauthn/server`.
 *
 * Challenges live in Redis with a short TTL and are consumed exactly once —
 * a replayed ceremony finds nothing and fails closed. Sign counters are enforced
 * where the authenticator provides them, which is the standard cloned-key check.
 */
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
  type WebAuthnCredential,
} from '@simplewebauthn/server';
import { eq } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import type { DatabaseHandles } from '../db/client.js';
import { webauthnCredentials } from '../db/schema/identity.js';
import type { Env } from '../env.js';
import { ApiError } from '../errors.js';
import { keys } from '../redis/scripts.js';

const CHALLENGE_TTL_SECONDS = 300;

export interface PasskeyService {
  beginRegistration(input: {
    userId: string;
    userName: string;
    userDisplayName: string;
  }): Promise<PublicKeyCredentialCreationOptionsJSON>;
  finishRegistration(input: {
    userId: string;
    response: RegistrationResponseJSON;
    label?: string;
  }): Promise<{ credentialId: string }>;
  beginAuthentication(input: { userId?: string }): Promise<{
    options: PublicKeyCredentialRequestOptionsJSON;
    /** Handle for the discoverable-credential flow, where no user is known yet. */
    ceremonyId: string;
  }>;
  finishAuthentication(input: {
    ceremonyId: string;
    response: AuthenticationResponseJSON;
  }): Promise<{ userId: string; credentialId: string }>;
  list(userId: string): Promise<Array<{ id: string; label: string | null; createdAt: Date; lastUsedAt: Date | null }>>;
  remove(userId: string, credentialId: string): Promise<boolean>;
}

export function createPasskeyService(
  env: Env,
  db: DatabaseHandles,
  redis: Redis,
): PasskeyService {
  const rpID = env.WEBAUTHN_RP_ID;
  const origins = env.WEBAUTHN_ORIGINS;

  async function loadCredential(credentialId: string) {
    const rows = await db.primary
      .select()
      .from(webauthnCredentials)
      .where(eq(webauthnCredentials.credentialId, credentialId))
      .limit(1);
    return rows[0] ?? null;
  }

  return {
    async beginRegistration({ userId, userName, userDisplayName }) {
      const existing = await db.replica
        .select({ credentialId: webauthnCredentials.credentialId, transports: webauthnCredentials.transports })
        .from(webauthnCredentials)
        .where(eq(webauthnCredentials.userId, userId));

      const options = await generateRegistrationOptions({
        rpName: env.WEBAUTHN_RP_NAME,
        rpID,
        userID: Buffer.from(userId, 'utf8'),
        userName,
        userDisplayName,
        attestationType: 'none',
        // Excluding what the user already has prevents a silent duplicate
        // registration of the same authenticator.
        excludeCredentials: existing.map((c) => ({ id: c.credentialId })),
        authenticatorSelection: {
          residentKey: 'preferred',
          userVerification: 'preferred',
        },
      });

      await redis.set(
        keys.webauthnChallenge('reg', userId),
        options.challenge,
        'EX',
        CHALLENGE_TTL_SECONDS,
      );

      return options;
    },

    async finishRegistration({ userId, response, label }) {
      const challenge = await redis.getdel(keys.webauthnChallenge('reg', userId));
      if (!challenge) {
        throw new ApiError('unauthorized', 'The passkey registration challenge has expired.');
      }

      const verification = await verifyRegistrationResponse({
        response,
        expectedChallenge: challenge,
        expectedOrigin: origins,
        expectedRPID: rpID,
        requireUserVerification: false,
      });

      if (!verification.verified || !verification.registrationInfo) {
        throw new ApiError('unauthorized', 'The passkey could not be verified.');
      }

      const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;

      await db.primary.insert(webauthnCredentials).values({
        userId,
        credentialId: credential.id,
        publicKey: Buffer.from(credential.publicKey).toString('base64url'),
        counter: credential.counter,
        transports: credential.transports ?? [],
        deviceType: credentialDeviceType,
        backedUp: credentialBackedUp,
        label: label ?? null,
      });

      return { credentialId: credential.id };
    },

    async beginAuthentication({ userId }) {
      const allowCredentials = userId
        ? (
            await db.replica
              .select({ credentialId: webauthnCredentials.credentialId })
              .from(webauthnCredentials)
              .where(eq(webauthnCredentials.userId, userId))
          ).map((c) => ({ id: c.credentialId }))
        : undefined;

      const options = await generateAuthenticationOptions({
        rpID,
        userVerification: 'preferred',
        ...(allowCredentials ? { allowCredentials } : {}),
      });

      // The ceremony id is the challenge itself: it is already a high-entropy
      // random value and it is what the response must echo back.
      const ceremonyId = options.challenge;
      await redis.set(
        keys.webauthnChallenge('auth', ceremonyId),
        JSON.stringify({ challenge: options.challenge, userId: userId ?? null }),
        'EX',
        CHALLENGE_TTL_SECONDS,
      );

      return { options, ceremonyId };
    },

    async finishAuthentication({ ceremonyId, response }) {
      const raw = await redis.getdel(keys.webauthnChallenge('auth', ceremonyId));
      if (!raw) {
        throw new ApiError('unauthorized', 'The passkey challenge has expired.');
      }
      const stored = JSON.parse(raw) as { challenge: string; userId: string | null };

      const record = await loadCredential(response.id);
      if (!record) {
        throw new ApiError('unauthorized', 'Unknown passkey.');
      }
      if (stored.userId && stored.userId !== record.userId) {
        throw new ApiError('unauthorized', 'This passkey belongs to a different account.');
      }

      const credential: WebAuthnCredential = {
        id: record.credentialId,
        publicKey: new Uint8Array(Buffer.from(record.publicKey, 'base64url')),
        counter: record.counter,
        transports: record.transports as WebAuthnCredential['transports'],
      };

      const verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: stored.challenge,
        expectedOrigin: origins,
        expectedRPID: rpID,
        credential,
        requireUserVerification: false,
      });

      if (!verification.verified) {
        throw new ApiError('unauthorized', 'The passkey assertion could not be verified.');
      }

      const newCounter = verification.authenticationInfo.newCounter;
      // A counter that fails to advance on an authenticator that uses counters is
      // the canonical signal of a cloned credential.
      if (record.counter > 0 && newCounter <= record.counter) {
        throw new ApiError('unauthorized', 'Passkey signature counter did not advance.');
      }

      await db.primary
        .update(webauthnCredentials)
        .set({ counter: newCounter, lastUsedAt: new Date() })
        .where(eq(webauthnCredentials.id, record.id));

      return { userId: record.userId, credentialId: record.credentialId };
    },

    async list(userId) {
      const rows = await db.replica
        .select({
          id: webauthnCredentials.credentialId,
          label: webauthnCredentials.label,
          createdAt: webauthnCredentials.createdAt,
          lastUsedAt: webauthnCredentials.lastUsedAt,
        })
        .from(webauthnCredentials)
        .where(eq(webauthnCredentials.userId, userId));
      return rows;
    },

    async remove(userId, credentialId) {
      const record = await loadCredential(credentialId);
      if (!record || record.userId !== userId) return false;
      await db.primary
        .delete(webauthnCredentials)
        .where(eq(webauthnCredentials.id, record.id));
      return true;
    },
  };
}
