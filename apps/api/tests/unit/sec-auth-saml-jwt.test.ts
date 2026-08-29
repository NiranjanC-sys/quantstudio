/**
 * Defensive security review — SAML assertion handling and service tokens (§8).
 *
 * The SAML tests build real signed XML and then attack it, because signature
 * wrapping is precisely the class of bug that reading the code does not settle:
 * the question is not "is a signature checked" but "does the signature cover the
 * element we went on to trust", and only a forged document answers it.
 *
 * The key material is generated at run time (never committed) with `openssl`;
 * the suite skips if that is not on PATH.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SignedXml } from 'xml-crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { StandardSamlAdapter, type SamlConnection } from '../../src/auth/saml.js';
import { createServiceTokenIssuer } from '../../src/auth/service-jwt.js';
import { csrfTokenValid, issueCsrfToken } from '../../src/middleware/security.js';
import { loadEnv } from '../../src/env.js';

function hasOpenssl(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const skipSaml = !hasOpenssl();
if (skipSaml) {
  process.stderr.write('[sec-auth-saml-jwt.test] openssl is not on PATH; SAML suite SKIPPED.\n');
}

const SP_ENTITY_ID = 'https://api.redquant.test/saml/metadata';
const ACS_URL = 'https://api.redquant.test/auth/saml/acme/acs';
const IDP_ENTITY_ID = 'https://idp.acme.test/entity';

describe.skipIf(skipSaml)('§8 SAML assertion verification', () => {
  let dir: string;
  let certificate: string;
  let privateKey: string;
  let connection: SamlConnection;
  const adapter = new StandardSamlAdapter();

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'rq-saml-'));
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048',
      '-keyout', join(dir, 'key.pem'),
      '-out', join(dir, 'cert.pem'),
      '-days', '3650', '-nodes', '-subj', '/CN=redquant-test-idp',
    ], { stdio: 'ignore' });

    certificate = readFileSync(join(dir, 'cert.pem'), 'utf8');
    privateKey = readFileSync(join(dir, 'key.pem'), 'utf8');

    connection = {
      id: 'conn-1',
      orgId: 'org-1',
      idpEntityId: IDP_ENTITY_ID,
      idpSsoUrl: 'https://idp.acme.test/sso',
      idpSloUrl: null,
      idpCertificates: [certificate],
      spEntityId: SP_ENTITY_ID,
      spAcsUrl: ACS_URL,
      wantAssertionsSigned: true,
      allowIdpInitiated: true,
      attributeMapping: {},
      defaultRole: 'member',
      active: true,
    };
  });

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function assertionXml(id: string, email: string, now = new Date()): string {
    const iso = (offsetMs: number) => new Date(now.getTime() + offsetMs).toISOString();
    return (
      `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ` +
      `ID="${id}" Version="2.0" IssueInstant="${iso(0)}">` +
      `<saml:Issuer>${IDP_ENTITY_ID}</saml:Issuer>` +
      `<saml:Subject>` +
      `<saml:NameID Format="urn:oasis:names:tc:SAML:2.0:nameid-format:emailAddress">${email}</saml:NameID>` +
      `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">` +
      `<saml:SubjectConfirmationData Recipient="${ACS_URL}" NotOnOrAfter="${iso(300_000)}"/>` +
      `</saml:SubjectConfirmation>` +
      `</saml:Subject>` +
      `<saml:Conditions NotBefore="${iso(-60_000)}" NotOnOrAfter="${iso(300_000)}">` +
      `<saml:AudienceRestriction><saml:Audience>${SP_ENTITY_ID}</saml:Audience></saml:AudienceRestriction>` +
      `</saml:Conditions>` +
      `<saml:AuthnStatement AuthnInstant="${iso(0)}" SessionIndex="sess-1">` +
      `<saml:AuthnContext><saml:AuthnContextClassRef>` +
      `urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport` +
      `</saml:AuthnContextClassRef></saml:AuthnContext>` +
      `</saml:AuthnStatement>` +
      `<saml:AttributeStatement>` +
      `<saml:Attribute Name="mail"><saml:AttributeValue>${email}</saml:AttributeValue></saml:Attribute>` +
      `</saml:AttributeStatement>` +
      `</saml:Assertion>`
    );
  }

  function responseXml(inner: string, responseId = '_resp1'): string {
    return (
      `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" ` +
      `xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ` +
      `ID="${responseId}" Version="2.0" IssueInstant="${new Date().toISOString()}" ` +
      `Destination="${ACS_URL}">` +
      `<saml:Issuer>${IDP_ENTITY_ID}</saml:Issuer>` +
      `<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>` +
      inner +
      `</samlp:Response>`
    );
  }

  /** Signs the assertion with `id`, enveloped, exactly as a real IdP would. */
  function sign(xml: string, id: string): string {
    const signer = new SignedXml({ privateKey, publicCert: certificate });
    signer.signatureAlgorithm = 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256';
    signer.canonicalizationAlgorithm = 'http://www.w3.org/2001/10/xml-exc-c14n#';
    signer.addReference({
      xpath: `//*[local-name(.)='Assertion' and @ID='${id}']`,
      transforms: [
        'http://www.w3.org/2000/09/xmldsig#enveloped-signature',
        'http://www.w3.org/2001/10/xml-exc-c14n#',
      ],
      digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
    });
    signer.computeSignature(xml, {
      location: { reference: `//*[local-name(.)='Assertion' and @ID='${id}']`, action: 'append' },
    });
    return signer.getSignedXml();
  }

  const b64 = (xml: string): string => Buffer.from(xml, 'utf8').toString('base64');
  const verify = (xml: string) =>
    adapter.verifyResponse(connection, b64(xml), {
      expectedInResponseTo: null,
      clockSkewSeconds: 120,
    });

  it('accepts a correctly signed assertion (the control)', () => {
    const signed = sign(responseXml(assertionXml('_a1', 'real@acme.test')), '_a1');
    const profile = verify(signed);
    expect(profile.nameId).toBe('real@acme.test');
    expect(profile.assertionId).toBe('_a1');
  });

  it('rejects an unsigned assertion', () => {
    expect(() => verify(responseXml(assertionXml('_a2', 'real@acme.test')))).toThrow(
      /unsigned|could not be validated/i,
    );
  });

  it('rejects an assertion signed by a key the connection does not pin', () => {
    const otherDir = mkdtempSync(join(tmpdir(), 'rq-saml-evil-'));
    try {
      execFileSync('openssl', [
        'req', '-x509', '-newkey', 'rsa:2048',
        '-keyout', join(otherDir, 'key.pem'),
        '-out', join(otherDir, 'cert.pem'),
        '-days', '3650', '-nodes', '-subj', '/CN=evil-idp',
      ], { stdio: 'ignore' });

      // The attacker signs with their own key and helpfully embeds their own
      // certificate in KeyInfo. Taking the cert from the document instead of the
      // connection would make this a complete bypass.
      const evil = new SignedXml({
        privateKey: readFileSync(join(otherDir, 'key.pem'), 'utf8'),
        publicCert: readFileSync(join(otherDir, 'cert.pem'), 'utf8'),
      });
      evil.signatureAlgorithm = 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256';
      evil.canonicalizationAlgorithm = 'http://www.w3.org/2001/10/xml-exc-c14n#';
      evil.addReference({
        xpath: `//*[local-name(.)='Assertion' and @ID='_a3']`,
        transforms: [
          'http://www.w3.org/2000/09/xmldsig#enveloped-signature',
          'http://www.w3.org/2001/10/xml-exc-c14n#',
        ],
        digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
      });
      evil.computeSignature(responseXml(assertionXml('_a3', 'admin@acme.test')), {
        location: {
          reference: `//*[local-name(.)='Assertion' and @ID='_a3']`,
          action: 'append',
        },
      });

      expect(() => verify(evil.getSignedXml())).toThrow(/could not be validated/i);
    } finally {
      rmSync(otherDir, { recursive: true, force: true });
    }
  });

  it('rejects signature wrapping: a forged assertion beside a genuinely signed one', () => {
    const signed = sign(responseXml(assertionXml('_a4', 'real@acme.test')), '_a4');

    // Classic XSW: the untouched signed assertion is demoted into an Extensions
    // element, and a forged assertion for a different subject takes its place as
    // the first Assertion the parser will reach.
    const signedAssertion = signed.slice(
      signed.indexOf('<saml:Assertion'),
      signed.indexOf('</saml:Assertion>') + '</saml:Assertion>'.length,
    );
    const forged = assertionXml('_evil', 'attacker@acme.test');
    const wrapped = responseXml(
      `${forged}<samlp:Extensions xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol">` +
        `${signedAssertion}</samlp:Extensions>`,
    );

    expect(() => verify(wrapped)).toThrow(/could not be validated/i);
  });

  it('rejects signature wrapping where the forged assertion reuses the signed ID', () => {
    const signed = sign(responseXml(assertionXml('_a5', 'real@acme.test')), '_a5');
    const signedAssertion = signed.slice(
      signed.indexOf('<saml:Assertion'),
      signed.indexOf('</saml:Assertion>') + '</saml:Assertion>'.length,
    );
    // Same ID, so a naive "find the element the reference names" lookup finds
    // the attacker's copy first.
    const forged = assertionXml('_a5', 'attacker@acme.test');
    const wrapped = responseXml(
      `${forged}<samlp:Extensions xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol">` +
        `${signedAssertion}</samlp:Extensions>`,
    );

    expect(() => verify(wrapped)).toThrow();
  });

  it('rejects an assertion whose audience is not this SP', () => {
    const xml = assertionXml('_a6', 'real@acme.test').replace(
      SP_ENTITY_ID,
      'https://someone-else.test/sp',
    );
    expect(() => verify(sign(responseXml(xml), '_a6'))).toThrow(/audience/i);
  });

  it('rejects an expired assertion', () => {
    const past = new Date(Date.now() - 3_600_000);
    const signed = sign(responseXml(assertionXml('_a7', 'real@acme.test', past)), '_a7');
    expect(() => verify(signed)).toThrow(/expired/i);
  });

  it('rejects an assertion issued by a different IdP entity id', () => {
    const xml = assertionXml('_a8', 'real@acme.test').replace(
      `<saml:Issuer>${IDP_ENTITY_ID}</saml:Issuer>`,
      `<saml:Issuer>https://evil.test/entity</saml:Issuer>`,
    );
    expect(() => verify(sign(responseXml(xml), '_a8'))).toThrow(/issuer/i);
  });

  it('rejects a Destination that is not this SP ACS URL', () => {
    const signed = sign(responseXml(assertionXml('_a9', 'real@acme.test')), '_a9').replace(
      `Destination="${ACS_URL}"`,
      'Destination="https://evil.test/acs"',
    );
    expect(() => verify(signed)).toThrow(/Destination|could not be validated/i);
  });
});

describe('§8 service tokens are EdDSA-only', () => {
  // The issuer touches neither store; the URLs only have to parse.
  const env = loadEnv({
    ...process.env,
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: process.env['RQ_TEST_DATABASE_URL'] ?? 'postgres://u:p@127.0.0.1:5432/unused',
    REDIS_URL: process.env['RQ_TEST_REDIS_URL'] ?? 'redis://127.0.0.1:6379/15',
    SERVICE_JWT_PRIVATE_KEY: undefined,
    SERVICE_JWT_PUBLIC_KEY: undefined,
  });

  it('refuses an alg:none token', async () => {
    const issuer = await createServiceTokenIssuer(env);
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({
        sub: 'victim',
        iss: env.SERVICE_JWT_ISSUER,
        aud: 'quantum-kernel',
        exp: Math.floor(Date.now() / 1000) + 300,
        act: 'api-gateway',
      }),
    ).toString('base64url');

    await expect(issuer.verify(`${header}.${payload}.`, 'quantum-kernel')).rejects.toThrow();
  });

  it('refuses an HS256 token signed with the public key as the shared secret', async () => {
    const issuer = await createServiceTokenIssuer(env);
    const { createHmac } = await import('node:crypto');
    const secret = issuer.publicKeyPem();
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({
        sub: 'victim',
        iss: env.SERVICE_JWT_ISSUER,
        aud: 'quantum-kernel',
        exp: Math.floor(Date.now() / 1000) + 300,
      }),
    ).toString('base64url');
    const signature = createHmac('sha256', secret)
      .update(`${header}.${payload}`)
      .digest('base64url');

    await expect(
      issuer.verify(`${header}.${payload}.${signature}`, 'quantum-kernel'),
    ).rejects.toThrow();
  });

  it('refuses a token minted for a different audience', async () => {
    const issuer = await createServiceTokenIssuer(env);
    const token = await issuer.mint({ audience: 'grader', subject: 'u1', scope: ['grade'] });
    await expect(issuer.verify(token, 'quantum-kernel')).rejects.toThrow();
    await expect(issuer.verify(token, 'grader')).resolves.toMatchObject({ sub: 'u1' });
  });

  it('mints tokens that expire within the §8 five-minute ceiling', async () => {
    const issuer = await createServiceTokenIssuer(env);
    const token = await issuer.mint({ audience: 'grader', subject: 'u1', scope: [] });
    const claims = await issuer.verify(token, 'grader');
    expect((claims.exp as number) - (claims.iat as number)).toBeLessThanOrEqual(300);
  });
});

describe('§8 CSRF tokens are bound to one session', () => {
  const secret = 'unit-test-csrf-secret-0000000000000000';

  it('accepts only the session it was issued for', () => {
    const token = issueCsrfToken(secret, 'session-key-a');
    expect(csrfTokenValid(secret, 'session-key-a', token)).toBe(true);
    expect(csrfTokenValid(secret, 'session-key-b', token)).toBe(false);
  });

  it('rejects a token whose nonce was swapped for another', () => {
    const a = issueCsrfToken(secret, 'session-key-a');
    const b = issueCsrfToken(secret, 'session-key-a');
    const frankenstein = `${a.split('.')[0]}.${b.split('.')[1]}`;
    expect(csrfTokenValid(secret, 'session-key-a', frankenstein)).toBe(false);
  });

  it('rejects a token minted under a different secret', () => {
    const token = issueCsrfToken('a-completely-different-secret-000000', 'session-key-a');
    expect(csrfTokenValid(secret, 'session-key-a', token)).toBe(false);
  });

  it('rejects structurally malformed tokens without throwing', () => {
    for (const bad of ['', '.', 'no-dot', 'nonce.', '.mac']) {
      expect(csrfTokenValid(secret, 'session-key-a', bad)).toBe(false);
    }
  });
});
