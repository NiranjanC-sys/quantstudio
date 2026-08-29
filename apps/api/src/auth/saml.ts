/**
 * SAML 2.0 for institutions (system-design §8): "one connection per org, with
 * IdP-initiated and SP-initiated flows".
 *
 * The connection model lives in `identity.saml_connections`. Everything that
 * differs between identity providers — binding quirks, attribute names,
 * signature placement — sits behind `SamlAdapter`, so an org that needs a
 * bespoke integration gets its own adapter rather than a branch in this file.
 *
 * `StandardSamlAdapter` implements the profile that Entra ID, Okta, Shibboleth
 * and Google Workspace all speak: SP-initiated redirect binding out, signed
 * HTTP-POST response back.
 */
import {
  DOMParser,
  type Document as XmlDocument,
  type Element as XmlElement,
} from '@xmldom/xmldom';
import { deflateRawSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { SignedXml } from 'xml-crypto';
import { and, eq } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import type { DatabaseHandles } from '../db/client.js';
import { orgs, samlConnections } from '../db/schema/identity.js';
import type { Env } from '../env.js';
import { ApiError } from '../errors.js';
import { keys } from '../redis/scripts.js';

const NS_PROTOCOL = 'urn:oasis:names:tc:SAML:2.0:protocol';
const NS_ASSERTION = 'urn:oasis:names:tc:SAML:2.0:assertion';
const NS_DSIG = 'http://www.w3.org/2000/09/xmldsig#';
const STATUS_SUCCESS = 'urn:oasis:names:tc:SAML:2.0:status:Success';

export interface SamlConnection {
  id: string;
  orgId: string;
  idpEntityId: string;
  idpSsoUrl: string;
  idpSloUrl: string | null;
  /** PEM or bare base64 certificates; more than one during a rollover. */
  idpCertificates: string[];
  spEntityId: string;
  spAcsUrl: string;
  wantAssertionsSigned: boolean;
  allowIdpInitiated: boolean;
  attributeMapping: Record<string, string>;
  defaultRole: 'member' | 'instructor' | 'admin';
  active: boolean;
}

export interface SamlProfile {
  nameId: string;
  nameIdFormat: string | null;
  sessionIndex: string | null;
  assertionId: string;
  issuer: string;
  inResponseTo: string | null;
  attributes: Record<string, string[]>;
  /** Mapped through `attributeMapping`. */
  email: string | null;
  displayName: string | null;
}

export interface AuthnRequestOptions {
  relayState: string;
  /** Forces re-authentication at the IdP. */
  forceAuthn?: boolean;
}

export interface VerifyOptions {
  /** `null` for an IdP-initiated response, which has no InResponseTo. */
  expectedInResponseTo: string | null;
  now?: Date;
  clockSkewSeconds: number;
}

/**
 * The seam an institution-specific integration plugs into. Anything that varies
 * per IdP belongs behind this interface.
 */
export interface SamlAdapter {
  readonly id: string;
  /** Builds the SP-initiated redirect. Returns the request id to correlate with. */
  createAuthnRequest(
    connection: SamlConnection,
    options: AuthnRequestOptions,
  ): { requestId: string; redirectUrl: string };
  /** Validates signature, conditions and audience, and extracts the subject. */
  verifyResponse(
    connection: SamlConnection,
    samlResponseBase64: string,
    options: VerifyOptions,
  ): SamlProfile;
  /** SP metadata XML the institution's IdP administrator uploads. */
  spMetadata(connection: SamlConnection): string;
}

function text(node: XmlElement | null | undefined): string | null {
  const value = node?.textContent?.trim();
  return value && value.length > 0 ? value : null;
}

function firstChild(
  root: XmlElement | XmlDocument,
  ns: string,
  name: string,
): XmlElement | null {
  const list = root.getElementsByTagNameNS(ns, name);
  return (list.item(0) as XmlElement | null) ?? null;
}

function toPem(certificate: string): string {
  const trimmed = certificate.trim();
  if (trimmed.includes('BEGIN CERTIFICATE')) return trimmed;
  const body = trimmed.replace(/\s+/g, '').match(/.{1,64}/g)?.join('\n') ?? trimmed;
  return `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----`;
}

export class StandardSamlAdapter implements SamlAdapter {
  readonly id = 'standard';

  createAuthnRequest(
    connection: SamlConnection,
    options: AuthnRequestOptions,
  ): { requestId: string; redirectUrl: string } {
    // SAML IDs must be NCNames, so they cannot start with a digit.
    const requestId = `_${randomUUID()}`;
    const issueInstant = new Date().toISOString();

    const xml =
      `<samlp:AuthnRequest xmlns:samlp="${NS_PROTOCOL}" xmlns:saml="${NS_ASSERTION}" ` +
      `ID="${requestId}" Version="2.0" IssueInstant="${issueInstant}" ` +
      `Destination="${connection.idpSsoUrl}" ` +
      `ProtocolBinding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" ` +
      `AssertionConsumerServiceURL="${connection.spAcsUrl}"` +
      `${options.forceAuthn ? ' ForceAuthn="true"' : ''}>` +
      `<saml:Issuer>${connection.spEntityId}</saml:Issuer>` +
      `<samlp:NameIDPolicy Format="urn:oasis:names:tc:SAML:2.0:nameid-format:emailAddress" AllowCreate="true"/>` +
      `</samlp:AuthnRequest>`;

    // HTTP-Redirect binding: DEFLATE (raw, no zlib header) then base64.
    const encoded = deflateRawSync(Buffer.from(xml, 'utf8')).toString('base64');

    const url = new URL(connection.idpSsoUrl);
    url.searchParams.set('SAMLRequest', encoded);
    url.searchParams.set('RelayState', options.relayState);

    return { requestId, redirectUrl: url.href };
  }

  verifyResponse(
    connection: SamlConnection,
    samlResponseBase64: string,
    options: VerifyOptions,
  ): SamlProfile {
    const now = options.now ?? new Date();
    const skewMs = options.clockSkewSeconds * 1000;

    let xml: string;
    try {
      xml = Buffer.from(samlResponseBase64, 'base64').toString('utf8');
    } catch (error) {
      throw new ApiError('validation-failed', 'SAMLResponse is not valid base64.', { cause: error });
    }

    const doc = new DOMParser().parseFromString(xml, 'text/xml');
    const response = firstChild(doc, NS_PROTOCOL, 'Response');
    if (!response) {
      throw new ApiError('validation-failed', 'SAMLResponse contains no Response element.');
    }

    const statusCode = firstChild(response, NS_PROTOCOL, 'StatusCode');
    const statusValue = statusCode?.getAttribute('Value');
    if (statusValue !== STATUS_SUCCESS) {
      throw new ApiError('unauthorized', `The identity provider returned status ${statusValue ?? 'unknown'}.`);
    }

    const responseIssuer = text(firstChild(response, NS_ASSERTION, 'Issuer'));
    if (responseIssuer && responseIssuer !== connection.idpEntityId) {
      throw new ApiError('unauthorized', 'SAML response issuer does not match the connection.');
    }

    const destination = response.getAttribute('Destination');
    if (destination && destination !== connection.spAcsUrl) {
      throw new ApiError('unauthorized', 'SAML response Destination does not match the ACS URL.');
    }

    const assertion = firstChild(response, NS_ASSERTION, 'Assertion');
    if (!assertion) {
      throw new ApiError('unauthorized', 'SAML response contains no assertion.');
    }

    const assertionId = assertion.getAttribute('ID');
    if (!assertionId) {
      throw new ApiError('unauthorized', 'SAML assertion has no ID.');
    }

    if (connection.wantAssertionsSigned) {
      this.verifySignature(doc, xml, assertion, response, connection);
    }

    const assertionIssuer = text(firstChild(assertion, NS_ASSERTION, 'Issuer'));
    if (assertionIssuer !== connection.idpEntityId) {
      throw new ApiError('unauthorized', 'SAML assertion issuer does not match the connection.');
    }

    // Conditions: validity window and audience restriction.
    const conditions = firstChild(assertion, NS_ASSERTION, 'Conditions');
    if (conditions) {
      const notBefore = conditions.getAttribute('NotBefore');
      const notOnOrAfter = conditions.getAttribute('NotOnOrAfter');
      if (notBefore && now.getTime() + skewMs < Date.parse(notBefore)) {
        throw new ApiError('unauthorized', 'SAML assertion is not yet valid.');
      }
      if (notOnOrAfter && now.getTime() - skewMs >= Date.parse(notOnOrAfter)) {
        throw new ApiError('unauthorized', 'SAML assertion has expired.');
      }

      const audiences = conditions.getElementsByTagNameNS(NS_ASSERTION, 'Audience');
      if (audiences.length > 0) {
        const values: string[] = [];
        for (let i = 0; i < audiences.length; i += 1) {
          const value = text(audiences.item(i) as XmlElement);
          if (value) values.push(value);
        }
        if (!values.includes(connection.spEntityId)) {
          throw new ApiError('unauthorized', 'SAML assertion audience does not include this SP.');
        }
      }
    }

    const subject = firstChild(assertion, NS_ASSERTION, 'Subject');
    const nameIdNode = subject ? firstChild(subject, NS_ASSERTION, 'NameID') : null;
    const nameId = text(nameIdNode);
    if (!nameId) {
      throw new ApiError('unauthorized', 'SAML assertion carries no NameID.');
    }

    let inResponseTo: string | null = null;
    const confirmationData = subject
      ? firstChild(subject, NS_ASSERTION, 'SubjectConfirmationData')
      : null;
    if (confirmationData) {
      inResponseTo = confirmationData.getAttribute('InResponseTo');
      const recipient = confirmationData.getAttribute('Recipient');
      if (recipient && recipient !== connection.spAcsUrl) {
        throw new ApiError('unauthorized', 'SAML subject confirmation Recipient does not match.');
      }
      const notOnOrAfter = confirmationData.getAttribute('NotOnOrAfter');
      if (notOnOrAfter && now.getTime() - skewMs >= Date.parse(notOnOrAfter)) {
        throw new ApiError('unauthorized', 'SAML subject confirmation has expired.');
      }
    }
    inResponseTo ??= response.getAttribute('InResponseTo');

    if (options.expectedInResponseTo !== null) {
      if (inResponseTo !== options.expectedInResponseTo) {
        throw new ApiError('unauthorized', 'SAML response does not answer the request we sent.');
      }
    } else if (inResponseTo && !connection.allowIdpInitiated) {
      // An SP-initiated response arriving without a tracked request is a replay.
      throw new ApiError('unauthorized', 'Unsolicited SAML response rejected.');
    } else if (!connection.allowIdpInitiated) {
      throw new ApiError('unauthorized', 'IdP-initiated sign-in is disabled for this organisation.');
    }

    const attributes: Record<string, string[]> = {};
    const attributeNodes = assertion.getElementsByTagNameNS(NS_ASSERTION, 'Attribute');
    for (let i = 0; i < attributeNodes.length; i += 1) {
      const node = attributeNodes.item(i) as XmlElement;
      const name = node.getAttribute('Name') ?? node.getAttribute('FriendlyName');
      if (!name) continue;
      const values = node.getElementsByTagNameNS(NS_ASSERTION, 'AttributeValue');
      const collected: string[] = [];
      for (let j = 0; j < values.length; j += 1) {
        const value = text(values.item(j) as XmlElement);
        if (value) collected.push(value);
      }
      attributes[name] = collected;
    }

    const authnStatement = firstChild(assertion, NS_ASSERTION, 'AuthnStatement');
    const mapping = connection.attributeMapping;

    const pick = (field: string, fallbacks: string[]): string | null => {
      const mapped = mapping[field];
      const candidates = mapped ? [mapped, ...fallbacks] : fallbacks;
      for (const key of candidates) {
        const value = attributes[key]?.[0];
        if (value) return value;
      }
      return null;
    };

    return {
      nameId,
      nameIdFormat: nameIdNode?.getAttribute('Format') ?? null,
      sessionIndex: authnStatement?.getAttribute('SessionIndex') ?? null,
      assertionId,
      issuer: assertionIssuer,
      inResponseTo,
      attributes,
      email:
        pick('email', [
          'urn:oid:0.9.2342.19200300.100.1.3',
          'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
          'mail',
          'email',
        ]) ?? (nameId.includes('@') ? nameId : null),
      displayName: pick('displayName', [
        'urn:oid:2.16.840.1.113730.3.1.241',
        'http://schemas.microsoft.com/identity/claims/displayname',
        'displayName',
        'cn',
      ]),
    };
  }

  /**
   * Verifies the enveloped signature and — critically — that the signature
   * actually covers the assertion we are about to trust. Checking only that
   * *some* signature in the document is valid is the classic SAML signature
   * wrapping vulnerability.
   */
  private verifySignature(
    doc: XmlDocument,
    xml: string,
    assertion: XmlElement,
    response: XmlElement,
    connection: SamlConnection,
  ): void {
    const signatures = doc.getElementsByTagNameNS(NS_DSIG, 'Signature');
    if (signatures.length === 0) {
      throw new ApiError('unauthorized', 'SAML response is unsigned.');
    }

    let lastError: unknown = null;

    for (let i = 0; i < signatures.length; i += 1) {
      const signatureNode = signatures.item(i) as XmlElement;

      for (const certificate of connection.idpCertificates) {
        const verifier = new SignedXml({ publicCert: toPem(certificate) });
        try {
          verifier.loadSignature(signatureNode as unknown as Node);
          if (!verifier.checkSignature(xml)) continue;

          // The signature is cryptographically valid; now prove it references
          // the assertion (or the response that contains it).
          try {
            verifier.validateElementAgainstReferences(
              assertion as unknown as Element,
              doc as unknown as globalThis.Document,
            );
            return;
          } catch {
            verifier.validateElementAgainstReferences(
              response as unknown as Element,
              doc as unknown as globalThis.Document,
            );
            return;
          }
        } catch (error) {
          lastError = error;
        }
      }
    }

    throw new ApiError('unauthorized', 'The SAML signature could not be validated.', {
      cause: lastError,
    });
  }

  spMetadata(connection: SamlConnection): string {
    return (
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${connection.spEntityId}">` +
      `<md:SPSSODescriptor AuthnRequestsSigned="false" WantAssertionsSigned="${connection.wantAssertionsSigned}" ` +
      `protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">` +
      `<md:NameIDFormat>urn:oasis:names:tc:SAML:2.0:nameid-format:emailAddress</md:NameIDFormat>` +
      `<md:AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" ` +
      `Location="${connection.spAcsUrl}" index="0" isDefault="true"/>` +
      `</md:SPSSODescriptor>` +
      `</md:EntityDescriptor>`
    );
  }
}

export interface SamlService {
  /** Registers an adapter for institutions that need a bespoke integration. */
  register(adapter: SamlAdapter): void;
  adapterFor(connection: SamlConnection): SamlAdapter;
  byOrg(orgId: string): Promise<SamlConnection | null>;
  byIdpEntityId(entityId: string): Promise<SamlConnection | null>;
  /** Resolves an email domain to its org's connection (§8, org resolution). */
  byEmailDomain(domain: string): Promise<SamlConnection | null>;
  begin(connection: SamlConnection, relayState: string): Promise<{ redirectUrl: string }>;
  complete(input: {
    connection: SamlConnection;
    samlResponse: string;
    relayState: string | null;
  }): Promise<SamlProfile>;
}

interface ConnectionRow {
  id: string;
  orgId: string;
  idpEntityId: string;
  idpSsoUrl: string;
  idpSloUrl: string | null;
  idpCertificates: string[];
  spEntityId: string;
  spAcsUrl: string;
  wantAssertionsSigned: boolean;
  allowIdpInitiated: boolean;
  attributeMapping: Record<string, string>;
  defaultRole: 'member' | 'instructor' | 'admin';
  active: boolean;
}

export function createSamlService(env: Env, db: DatabaseHandles, redis: Redis): SamlService {
  const adapters = new Map<string, SamlAdapter>();
  const standard = new StandardSamlAdapter();
  adapters.set(standard.id, standard);

  const selection = {
    id: samlConnections.id,
    orgId: samlConnections.orgId,
    idpEntityId: samlConnections.idpEntityId,
    idpSsoUrl: samlConnections.idpSsoUrl,
    idpSloUrl: samlConnections.idpSloUrl,
    idpCertificates: samlConnections.idpCertificates,
    spEntityId: samlConnections.spEntityId,
    spAcsUrl: samlConnections.spAcsUrl,
    wantAssertionsSigned: samlConnections.wantAssertionsSigned,
    allowIdpInitiated: samlConnections.allowIdpInitiated,
    attributeMapping: samlConnections.attributeMapping,
    defaultRole: samlConnections.defaultRole,
    active: samlConnections.active,
  };

  function toConnection(row: ConnectionRow): SamlConnection {
    return { ...row };
  }

  return {
    register(adapter) {
      adapters.set(adapter.id, adapter);
    },

    adapterFor() {
      // Adapter selection is per-connection today only by name; the registry
      // exists so a bespoke integration is a registration, not a code branch.
      return adapters.get(standard.id) as SamlAdapter;
    },

    async byOrg(orgId) {
      const rows = await db.replica
        .select(selection)
        .from(samlConnections)
        .where(and(eq(samlConnections.orgId, orgId), eq(samlConnections.active, true)))
        .limit(1);
      const row = rows[0];
      return row ? toConnection(row as ConnectionRow) : null;
    },

    async byIdpEntityId(entityId) {
      const rows = await db.replica
        .select(selection)
        .from(samlConnections)
        .where(and(eq(samlConnections.idpEntityId, entityId), eq(samlConnections.active, true)))
        .limit(1);
      const row = rows[0];
      return row ? toConnection(row as ConnectionRow) : null;
    },

    /**
     * §8 org resolution: an email-domain claim, verified by DNS TXT, routes the
     * learner to their institution's SSO. An unverified domain resolves to
     * nothing — otherwise anyone could claim a university's domain.
     */
    async byEmailDomain(domain) {
      const rows = await db.replica
        .select(selection)
        .from(samlConnections)
        .innerJoin(orgs, eq(orgs.id, samlConnections.orgId))
        .where(
          and(
            eq(samlConnections.active, true),
            eq(orgs.domainVerified, true),
            eq(orgs.emailDomain, domain.toLowerCase()),
          ),
        )
        .limit(1);
      const row = rows[0];
      return row ? toConnection(row as ConnectionRow) : null;
    },

    async begin(connection, relayState) {
      const adapter = this.adapterFor(connection);
      const { requestId, redirectUrl } = adapter.createAuthnRequest(connection, { relayState });
      // Correlates the eventual InResponseTo, and bounds how long a request is
      // answerable.
      await redis.set(
        keys.samlRequest(relayState),
        JSON.stringify({ requestId, connectionId: connection.id }),
        'EX',
        600,
      );
      return { redirectUrl };
    },

    async complete({ connection, samlResponse, relayState }) {
      let expectedInResponseTo: string | null = null;

      if (relayState) {
        const raw = await redis.getdel(keys.samlRequest(relayState));
        if (raw) {
          const parsed = JSON.parse(raw) as { requestId: string; connectionId: string };
          if (parsed.connectionId !== connection.id) {
            throw new ApiError('unauthorized', 'SAML relay state belongs to another connection.');
          }
          expectedInResponseTo = parsed.requestId;
        }
      }

      const adapter = this.adapterFor(connection);
      const profile = adapter.verifyResponse(connection, samlResponse, {
        expectedInResponseTo,
        clockSkewSeconds: env.SAML_ASSERTION_SKEW_SECONDS,
      });

      // Replay protection: an assertion id is accepted exactly once.
      const fresh = await redis.set(keys.samlReplay(profile.assertionId), '1', 'EX', 3600, 'NX');
      if (fresh !== 'OK') {
        throw new ApiError('unauthorized', 'This SAML assertion has already been used.');
      }

      return profile;
    },
  };
}
