/**
 * OIDC / OAuth 2.0 federation (system-design §8): Google, Microsoft Entra,
 * GitHub, ORCID and LinkedIn.
 *
 * Google, Microsoft, ORCID and LinkedIn are real OpenID Providers and are
 * configured by discovery. GitHub is not an OpenID Provider — it has no
 * discovery document and issues no ID token — so it is configured explicitly and
 * its profile is read from the REST API after the code exchange. That asymmetry
 * is handled here rather than leaking into the route.
 *
 * Every flow uses PKCE and a one-time state stored in Redis; OIDC flows also
 * carry a nonce.
 */
import * as oidc from 'openid-client';
import type { Redis } from 'ioredis';
import { ApiError } from '../errors.js';
import type { Env } from '../env.js';
import { fetchJson } from '../lib/http.js';
import { keys } from '../redis/scripts.js';

export type OidcProviderId = 'google' | 'microsoft' | 'github' | 'orcid' | 'linkedin';

export const OIDC_PROVIDERS: readonly OidcProviderId[] = [
  'google',
  'microsoft',
  'github',
  'orcid',
  'linkedin',
];

export interface FederatedProfile {
  provider: OidcProviderId;
  /** Stable identifier at the provider; `identity.accounts.provider_account_id`. */
  providerAccountId: string;
  email: string | null;
  emailVerified: boolean;
  displayName: string | null;
  avatarUrl: string | null;
}

export interface AuthorizationStart {
  url: string;
  state: string;
}

export interface StateRecord {
  provider: OidcProviderId;
  codeVerifier: string;
  nonce: string | null;
  redirectTo: string;
  /** Set when the flow links a provider to an already signed-in user. */
  linkUserId: string | null;
}

export interface OidcRegistry {
  configured(): OidcProviderId[];
  isConfigured(provider: OidcProviderId): boolean;
  begin(input: {
    provider: OidcProviderId;
    redirectTo: string;
    linkUserId?: string | null;
  }): Promise<AuthorizationStart>;
  complete(input: {
    provider: OidcProviderId;
    callbackUrl: URL;
    state: string;
  }): Promise<{ profile: FederatedProfile; stateRecord: StateRecord }>;
}

interface ProviderSpec {
  scopes: string;
  /** Discovery issuer, or `null` for a hand-configured OAuth 2.0 provider. */
  issuer: string | null;
  clientId: string | undefined;
  clientSecret: string | undefined;
}

const STATE_TTL_SECONDS = 600;

function providerSpecs(env: Env): Record<OidcProviderId, ProviderSpec> {
  return {
    google: {
      issuer: 'https://accounts.google.com',
      scopes: 'openid email profile',
      clientId: env.OIDC_GOOGLE_CLIENT_ID,
      clientSecret: env.OIDC_GOOGLE_CLIENT_SECRET,
    },
    microsoft: {
      issuer: `https://login.microsoftonline.com/${env.OIDC_MICROSOFT_TENANT}/v2.0`,
      scopes: 'openid email profile',
      clientId: env.OIDC_MICROSOFT_CLIENT_ID,
      clientSecret: env.OIDC_MICROSOFT_CLIENT_SECRET,
    },
    github: {
      issuer: null,
      scopes: 'read:user user:email',
      clientId: env.OIDC_GITHUB_CLIENT_ID,
      clientSecret: env.OIDC_GITHUB_CLIENT_SECRET,
    },
    orcid: {
      issuer: env.OIDC_ORCID_ISSUER,
      scopes: 'openid',
      clientId: env.OIDC_ORCID_CLIENT_ID,
      clientSecret: env.OIDC_ORCID_CLIENT_SECRET,
    },
    linkedin: {
      issuer: 'https://www.linkedin.com/oauth',
      scopes: 'openid email profile',
      clientId: env.OIDC_LINKEDIN_CLIENT_ID,
      clientSecret: env.OIDC_LINKEDIN_CLIENT_SECRET,
    },
  };
}

interface GithubUser {
  id: number;
  login: string;
  name: string | null;
  email: string | null;
  avatar_url: string | null;
}

interface GithubEmail {
  email: string;
  primary: boolean;
  verified: boolean;
}

export function createOidcRegistry(env: Env, redis: Redis): OidcRegistry {
  const specs = providerSpecs(env);
  const configurations = new Map<OidcProviderId, Promise<oidc.Configuration>>();

  function redirectUri(provider: OidcProviderId): string {
    return `${env.API_PUBLIC_URL}/auth/oauth/${provider}/callback`;
  }

  function requireSpec(provider: OidcProviderId): ProviderSpec & {
    clientId: string;
    clientSecret: string;
  } {
    const spec = specs[provider];
    if (!spec.clientId || !spec.clientSecret) {
      throw new ApiError('not-found', `The ${provider} sign-in provider is not configured.`);
    }
    return { ...spec, clientId: spec.clientId, clientSecret: spec.clientSecret };
  }

  async function configuration(provider: OidcProviderId): Promise<oidc.Configuration> {
    const cached = configurations.get(provider);
    if (cached) return cached;

    const spec = requireSpec(provider);

    const created = (async (): Promise<oidc.Configuration> => {
      if (spec.issuer === null) {
        // GitHub: no discovery document exists. Its token endpoint defaults to
        // form-encoded responses, so the Accept header is forced here.
        const config = new oidc.Configuration(
          {
            issuer: 'https://github.com',
            authorization_endpoint: 'https://github.com/login/oauth/authorize',
            token_endpoint: 'https://github.com/login/oauth/access_token',
          },
          spec.clientId,
          spec.clientSecret,
        );
        config[oidc.customFetch] = (url, options) => {
          const init = (options ?? {}) as RequestInit;
          return fetch(url, {
            ...init,
            headers: { ...(init.headers as Record<string, string> | undefined), accept: 'application/json' },
          });
        };
        return config;
      }

      try {
        const config = await oidc.discovery(
          new URL(spec.issuer),
          spec.clientId,
          spec.clientSecret,
        );
        if (env.NODE_ENV !== 'production' && spec.issuer.startsWith('http://')) {
          oidc.allowInsecureRequests(config);
        }
        return config;
      } catch (error) {
        throw new ApiError(
          'upstream-unavailable',
          `Could not read the ${provider} OpenID configuration.`,
          { extensions: { service: provider }, retryAfterSeconds: 5, cause: error },
        );
      }
    })();

    // A failed discovery must not be cached, or one blip disables the provider
    // until the pod is recycled.
    created.catch(() => configurations.delete(provider));
    configurations.set(provider, created);
    return created;
  }

  async function githubProfile(accessToken: string): Promise<FederatedProfile> {
    const headers = {
      authorization: `Bearer ${accessToken}`,
      'user-agent': 'redquant-api',
      accept: 'application/vnd.github+json',
    };

    const user = await fetchJson<GithubUser>('https://api.github.com/user', {
      headers,
      timeoutMs: 5_000,
      service: 'github',
    });

    if (user.status !== 200 || !user.body) {
      throw new ApiError('upstream-unavailable', 'GitHub did not return a profile.', {
        extensions: { service: 'github' },
      });
    }

    let email = user.body.email;
    let emailVerified = false;

    if (!email) {
      const emails = await fetchJson<GithubEmail[]>('https://api.github.com/user/emails', {
        headers,
        timeoutMs: 5_000,
        service: 'github',
      });
      const primary = Array.isArray(emails.body)
        ? emails.body.find((e) => e.primary && e.verified) ?? emails.body.find((e) => e.verified)
        : undefined;
      email = primary?.email ?? null;
      emailVerified = primary?.verified ?? false;
    }

    return {
      provider: 'github',
      providerAccountId: String(user.body.id),
      email,
      emailVerified,
      displayName: user.body.name ?? user.body.login,
      avatarUrl: user.body.avatar_url,
    };
  }

  return {
    configured() {
      return OIDC_PROVIDERS.filter((p) => {
        const spec = specs[p];
        return Boolean(spec.clientId && spec.clientSecret);
      });
    },

    isConfigured(provider) {
      const spec = specs[provider];
      return Boolean(spec.clientId && spec.clientSecret);
    },

    async begin({ provider, redirectTo, linkUserId }) {
      const config = await configuration(provider);
      const spec = requireSpec(provider);

      const codeVerifier = oidc.randomPKCECodeVerifier();
      const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);
      const state = oidc.randomState();
      const nonce = spec.issuer === null ? null : oidc.randomNonce();

      const record: StateRecord = {
        provider,
        codeVerifier,
        nonce,
        redirectTo,
        linkUserId: linkUserId ?? null,
      };
      await redis.set(keys.oauthState(state), JSON.stringify(record), 'EX', STATE_TTL_SECONDS);

      const parameters: Record<string, string> = {
        redirect_uri: redirectUri(provider),
        scope: spec.scopes,
        state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
      };
      if (nonce) parameters['nonce'] = nonce;

      return { url: oidc.buildAuthorizationUrl(config, parameters).href, state };
    },

    async complete({ provider, callbackUrl, state }) {
      // The state is consumed exactly once: a replayed callback finds nothing.
      const raw = await redis.getdel(keys.oauthState(state));
      if (!raw) {
        throw new ApiError('unauthorized', 'This sign-in attempt has expired. Start again.');
      }

      const stateRecord = JSON.parse(raw) as StateRecord;
      if (stateRecord.provider !== provider) {
        throw new ApiError('unauthorized', 'Sign-in state does not match the callback provider.');
      }

      const config = await configuration(provider);

      let tokens: oidc.TokenEndpointResponse & oidc.TokenEndpointResponseHelpers;
      try {
        tokens = await oidc.authorizationCodeGrant(config, callbackUrl, {
          pkceCodeVerifier: stateRecord.codeVerifier,
          expectedState: state,
          ...(stateRecord.nonce ? { expectedNonce: stateRecord.nonce } : {}),
        });
      } catch (error) {
        throw new ApiError('unauthorized', `The ${provider} sign-in could not be completed.`, {
          cause: error,
        });
      }

      if (provider === 'github') {
        return { profile: await githubProfile(tokens.access_token), stateRecord };
      }

      const claims = tokens.claims();
      if (!claims?.sub) {
        throw new ApiError('unauthorized', `${provider} returned no subject claim.`);
      }

      // ORCID's ID token carries name claims but no email; userinfo fills the gap
      // where the provider offers it.
      let email = typeof claims['email'] === 'string' ? claims['email'] : null;
      let emailVerified = claims['email_verified'] === true;
      let displayName = typeof claims['name'] === 'string' ? claims['name'] : null;
      let avatarUrl = typeof claims['picture'] === 'string' ? claims['picture'] : null;

      if (!email && config.serverMetadata().userinfo_endpoint) {
        try {
          const info = await oidc.fetchUserInfo(config, tokens.access_token, claims.sub);
          email = typeof info['email'] === 'string' ? info['email'] : email;
          emailVerified = info['email_verified'] === true ? true : emailVerified;
          displayName = typeof info['name'] === 'string' ? info['name'] : displayName;
          avatarUrl = typeof info['picture'] === 'string' ? info['picture'] : avatarUrl;
        } catch {
          // Userinfo is best-effort; the ID token already authenticated the user.
        }
      }

      return {
        profile: {
          provider,
          providerAccountId: claims.sub,
          email,
          emailVerified,
          displayName,
          avatarUrl,
        },
        stateRecord,
      };
    },
  };
}
