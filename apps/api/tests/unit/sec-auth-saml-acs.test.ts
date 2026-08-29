/**
 * Defensive security review — the SAML ACS endpoint's account-matching rules.
 *
 * The signature checks are proven in `sec-auth-saml-jwt.test.ts`. This suite is
 * about the step *after* a signature verifies: which RedQuant account a
 * cryptographically valid assertion is allowed to speak for.
 *
 * The threat is not a forged assertion. It is an institution that legitimately
 * holds a SAML connection — a compromised campus IdP, or simply a hostile
 * customer — asserting an email address it does not own. Every connection is a
 * signing authority, so unless the ACS confines a connection to its own verified
 * email domain, any tenant can mint an assertion for any account on the platform.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { SignedXml } from 'xml-crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BuiltApp } from '../../src/app.js';
import { buildApp } from '../../src/app.js';
import { loadEnv, type Env } from '../../src/env.js';
import { orgs, samlConnections, users } from '../../src/db/schema/identity.js';
import {
  HAS_POSTGRES,
  HAS_REDIS,
  requireDatabaseUrl,
  requireRedisUrl,
} from '../support/environment.js';

function hasOpenssl(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const skip = !HAS_POSTGRES || !HAS_REDIS || !hasOpenssl();
if (skip) {
  process.stderr.write(
    '[sec-auth-saml-acs.test] Postgres, Redis or openssl unavailable; suite SKIPPED.\n',
  );
}

describe.skipIf(skip)('§8 SAML ACS account matching', () => {
  let built: BuiltApp;
  let env: Env;
  let dir: string;
  let certificate: string;
  let privateKey: string;
  let slug: string;
  let acsUrl: string;
  let spEntityId: string;
  let ipCounter = 10;

  beforeAll(async () => {
    env = loadEnv({
      ...process.env,
      NODE_ENV: 'test',
      DATABASE_URL: requireDatabaseUrl(),
      REDIS_URL: requireRedisUrl(),
      SESSION_COOKIE_SECURE: 'false',
      LOG_LEVEL: 'silent',
      METRICS_ENABLED: 'false',
      RATE_LIMIT_ENABLED: 'false',
      EMAIL_TRANSPORT: 'console',
    });
    built = await buildApp(env);

    dir = mkdtempSync(join(tmpdir(), 'rq-acs-'));
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048',
      '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'),
      '-days', '3650', '-nodes', '-subj', '/CN=hostile-idp',
    ], { stdio: 'ignore' });
    certificate = readFileSync(join(dir, 'cert.pem'), 'utf8');
    privateKey = readFileSync(join(dir, 'key.pem'), 'utf8');

    // A tenant that legitimately holds a connection, and legitimately owns
    // hostile-u.test — and nothing else.
    slug = `hostile-${Date.now().toString(36)}`;
    acsUrl = `${env.API_PUBLIC_URL}/auth/saml/${slug}/acs`;
    spEntityId = `${env.API_PUBLIC_URL}/auth/saml/${slug}/metadata`;

    const org = await built.services.db.primary
      .insert(orgs)
      .values({
        slug,
        name: 'Hostile University',
        kind: 'campus',
        emailDomain: `${slug}.test`,
        domainVerified: true,
        seatLimit: 100,
      })
      .returning({ id: orgs.id });

    await built.services.db.primary.insert(samlConnections).values({
      orgId: (org[0] as { id: string }).id,
      idpEntityId: `https://idp.${slug}.test/entity`,
      idpSsoUrl: `https://idp.${slug}.test/sso`,
      idpCertificates: [certificate],
      spEntityId,
      spAcsUrl: acsUrl,
      wantAssertionsSigned: true,
      allowIdpInitiated: true,
    });
  }, 180_000);

  afterAll(async () => {
    if (built) await built.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function nextIp(): string {
    ipCounter += 1;
    return `203.0.113.${ipCounter % 250}`;
  }

  /** Signs an assertion asserting `email`, from this tenant's own IdP. */
  function signedResponse(email: string, assertionId: string): string {
    const now = new Date();
    const iso = (offset: number) => new Date(now.getTime() + offset).toISOString();

    const assertion =
      `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ` +
      `ID="${assertionId}" Version="2.0" IssueInstant="${iso(0)}">` +
      `<saml:Issuer>https://idp.${slug}.test/entity</saml:Issuer>` +
      `<saml:Subject>` +
      `<saml:NameID Format="urn:oasis:names:tc:SAML:2.0:nameid-format:emailAddress">${email}</saml:NameID>` +
      `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">` +
      `<saml:SubjectConfirmationData Recipient="${acsUrl}" NotOnOrAfter="${iso(300_000)}"/>` +
      `</saml:SubjectConfirmation></saml:Subject>` +
      `<saml:Conditions NotBefore="${iso(-60_000)}" NotOnOrAfter="${iso(300_000)}">` +
      `<saml:AudienceRestriction><saml:Audience>${spEntityId}</saml:Audience></saml:AudienceRestriction>` +
      `</saml:Conditions>` +
      `<saml:AuthnStatement AuthnInstant="${iso(0)}" SessionIndex="s1">` +
      `<saml:AuthnContext><saml:AuthnContextClassRef>` +
      `urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport` +
      `</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>` +
      `<saml:AttributeStatement>` +
      `<saml:Attribute Name="mail"><saml:AttributeValue>${email}</saml:AttributeValue></saml:Attribute>` +
      `</saml:AttributeStatement>` +
      `</saml:Assertion>`;

    const xml =
      `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" ` +
      `xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ` +
      `ID="_r${assertionId}" Version="2.0" IssueInstant="${iso(0)}" Destination="${acsUrl}">` +
      `<saml:Issuer>https://idp.${slug}.test/entity</saml:Issuer>` +
      `<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>` +
      assertion +
      `</samlp:Response>`;

    const signer = new SignedXml({ privateKey, publicCert: certificate });
    signer.signatureAlgorithm = 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256';
    signer.canonicalizationAlgorithm = 'http://www.w3.org/2001/10/xml-exc-c14n#';
    signer.addReference({
      xpath: `//*[local-name(.)='Assertion' and @ID='${assertionId}']`,
      transforms: [
        'http://www.w3.org/2000/09/xmldsig#enveloped-signature',
        'http://www.w3.org/2001/10/xml-exc-c14n#',
      ],
      digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
    });
    signer.computeSignature(xml, {
      location: {
        reference: `//*[local-name(.)='Assertion' and @ID='${assertionId}']`,
        action: 'append',
      },
    });
    return Buffer.from(signer.getSignedXml(), 'utf8').toString('base64');
  }

  function postAcs(samlResponse: string) {
    return built.app.inject({
      method: 'POST',
      url: `/auth/saml/${slug}/acs`,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-forwarded-for': nextIp(),
      },
      payload: new URLSearchParams({ SAMLResponse: samlResponse }).toString(),
    });
  }

  it('signs in a subject inside the connection\'s own verified domain (the control)', async () => {
    const response = await postAcs(signedResponse(`student@${slug}.test`, `_ok${Date.now()}`));
    expect(response.statusCode).toBe(303);
    const cookies = String(response.headers['set-cookie'] ?? '');
    expect(cookies).toContain(`${env.SESSION_COOKIE_NAME}=`);
  });

  it('refuses to take over an existing account outside the connection\'s domain', async () => {
    const victimEmail = `victim-${Date.now()}@gmail.example`;
    const registered = await built.app.inject({
      method: 'POST',
      url: '/auth/register',
      headers: { 'x-forwarded-for': nextIp() },
      payload: {
        email: victimEmail,
        password: 'correct-horse-battery-staple',
        displayName: 'Victim',
      },
    });
    expect(registered.statusCode).toBe(201);
    const victimId = (registered.json() as { user: { id: string } }).user.id;

    // A cryptographically perfect assertion — from an IdP that has no business
    // speaking for gmail.example.
    const response = await postAcs(signedResponse(victimEmail, `_evil${Date.now()}`));

    expect(response.statusCode).not.toBe(303);
    expect(String(response.headers['set-cookie'] ?? '')).not.toContain(
      `${env.SESSION_COOKIE_NAME}=`,
    );

    // And the victim must not have been dragged into the attacker's org.
    const after = await built.services.db.primary
      .select({ orgId: users.orgId })
      .from(users)
      .where(eq(users.id, victimId))
      .limit(1);
    expect(after[0]?.orgId ?? null).toBeNull();
  });

  it('refuses to pre-create an account in a domain the connection does not own', async () => {
    const email = `not-yet-registered-${Date.now()}@outlook.example`;
    const response = await postAcs(signedResponse(email, `_pre${Date.now()}`));
    expect(response.statusCode).not.toBe(303);

    const created = await built.services.db.primary
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);
    expect(created.length).toBe(0);
  });

  it('rejects a replayed assertion', async () => {
    const id = `_replay${Date.now()}`;
    const payload = signedResponse(`repeat@${slug}.test`, id);

    const first = await postAcs(payload);
    expect(first.statusCode).toBe(303);

    const second = await postAcs(payload);
    expect(second.statusCode).toBe(401);
  });
});
