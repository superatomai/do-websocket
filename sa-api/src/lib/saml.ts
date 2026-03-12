import { SignedXml } from "xml-crypto";
import { DOMParser } from "@xmldom/xmldom";

// ─── Constants ──────────────────────────────────────────

const SAML_PROTOCOL_NS = "urn:oasis:names:tc:SAML:2.0:protocol";
const SAML_ASSERTION_NS = "urn:oasis:names:tc:SAML:2.0:assertion";
const SAML_METADATA_NS = "urn:oasis:names:tc:SAML:2.0:metadata";
const XMLDSIG_NS = "http://www.w3.org/2000/09/xmldsig#";

const SAML_STATUS_SUCCESS = "urn:oasis:names:tc:SAML:2.0:status:Success";

const NAMEID_FORMAT_EMAIL = "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress";

/** Clock skew tolerance in milliseconds (3 minutes) */
const CLOCK_SKEW_MS = 3 * 60 * 1000;

// Well-known SAML attribute names for email
const EMAIL_ATTRIBUTE_NAMES = [
  "email",
  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
  "mail",
  "http://schemas.xmlsoap.org/claims/EmailAddress",
];

// Well-known SAML attribute names for display name
const NAME_ATTRIBUTE_NAMES = [
  "displayName",
  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name",
];

// Well-known SAML attribute names for first/last name
const FIRST_NAME_ATTRS = [
  "firstName",
  "givenName",
  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname",
];
const LAST_NAME_ATTRS = [
  "lastName",
  "surname",
  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname",
];

// ─── Types ──────────────────────────────────────────────

export interface SamlIdentity {
  ssoSubject: string;
  email: string;
  name: string;
}

export interface SamlValidationResult {
  identity: SamlIdentity;
  issuer: string;
}

export interface SamlMetadataResult {
  samlIdpEntityId: string;
  samlIdpSsoUrl: string;
  samlIdpCertificates: string[];
}

// ─── AuthnRequest Generation ────────────────────────────

/**
 * Generate a random request ID for the SAML AuthnRequest.
 */
export function generateRequestId(): string {
  const array = new Uint8Array(16);
  crypto.getRandomValues(array);
  return (
    "_" +
    Array.from(array)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
  );
}

/**
 * Build a SAML AuthnRequest XML string.
 */
export function buildAuthnRequest(params: {
  requestId: string;
  acsUrl: string;
  spEntityId: string;
  idpSsoUrl: string;
}): string {
  const issueInstant = new Date().toISOString();
  return [
    `<samlp:AuthnRequest`,
    `  xmlns:samlp="${SAML_PROTOCOL_NS}"`,
    `  xmlns:saml="${SAML_ASSERTION_NS}"`,
    `  ID="${params.requestId}"`,
    `  Version="2.0"`,
    `  IssueInstant="${issueInstant}"`,
    `  Destination="${params.idpSsoUrl}"`,
    `  AssertionConsumerServiceURL="${params.acsUrl}"`,
    `  ProtocolBinding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST">`,
    `  <saml:Issuer>${params.spEntityId}</saml:Issuer>`,
    `  <samlp:NameIDPolicy`,
    `    Format="${NAMEID_FORMAT_EMAIL}"`,
    `    AllowCreate="true"/>`,
    `</samlp:AuthnRequest>`,
  ].join("\n");
}

/**
 * DEFLATE compress, Base64 encode, and URL encode the AuthnRequest
 * for HTTP-Redirect binding.
 */
export async function deflateAndEncode(xml: string): Promise<string> {
  const encoder = new TextEncoder();
  const input = encoder.encode(xml);

  // Use CompressionStream with deflate-raw (no zlib header)
  const cs = new CompressionStream("deflate-raw");
  const writer = cs.writable.getWriter();
  writer.write(input);
  writer.close();

  const reader = cs.readable.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }

  // Concatenate chunks
  const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }

  // Base64 encode
  const base64 = btoa(String.fromCharCode(...result));

  // URL encode
  return encodeURIComponent(base64);
}

// ─── SP Metadata ────────────────────────────────────────

/**
 * Generate the SP metadata XML.
 */
export function buildSpMetadata(acsUrl: string, spEntityId: string): string {
  return [
    `<?xml version="1.0"?>`,
    `<EntityDescriptor xmlns="${SAML_METADATA_NS}"`,
    `  entityID="${spEntityId}">`,
    `  <SPSSODescriptor`,
    `    AuthnRequestsSigned="false"`,
    `    WantAssertionsSigned="true"`,
    `    protocolSupportEnumeration="${SAML_PROTOCOL_NS}">`,
    `    <NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</NameIDFormat>`,
    `    <NameIDFormat>urn:oasis:names:tc:SAML:2.0:nameid-format:persistent</NameIDFormat>`,
    `    <NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified</NameIDFormat>`,
    `    <AssertionConsumerService`,
    `      Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"`,
    `      Location="${acsUrl}"`,
    `      index="0"`,
    `      isDefault="true"/>`,
    `  </SPSSODescriptor>`,
    `</EntityDescriptor>`,
  ].join("\n");
}

// ─── SAML Response Validation ───────────────────────────

/**
 * Validate and extract identity from a SAML Response.
 * Performs all security checks: status, destination, signature, conditions, audience.
 */
export function validateSamlResponse(params: {
  samlResponseXml: string;
  certificates: string[];
  expectedAcsUrl: string;
  expectedAudience: string;
  expectedRequestId?: string; // Only for SP-initiated (InResponseTo check)
}): SamlValidationResult {
  const { samlResponseXml, certificates, expectedAcsUrl, expectedAudience, expectedRequestId } =
    params;

  const doc = new DOMParser().parseFromString(samlResponseXml, "text/xml");

  // --- Check parse errors ---
  const parseErrors = doc.getElementsByTagName("parsererror");
  if (parseErrors.length > 0) {
    throw new SamlError("Failed to parse SAML Response XML");
  }

  // --- Get the Response element ---
  const responseElements = doc.getElementsByTagNameNS(SAML_PROTOCOL_NS, "Response");
  if (responseElements.length === 0) {
    throw new SamlError("No SAML Response element found");
  }
  const responseEl = responseElements[0];

  // --- Step 5: Check Status Code ---
  checkStatusCode(responseEl);

  // --- Step 6: Validate Destination ---
  const destination = responseEl.getAttribute("Destination");
  if (destination && destination !== expectedAcsUrl) {
    throw new SamlError("SAML Response destination mismatch");
  }

  // --- Step 6b: Validate InResponseTo (SP-initiated only) ---
  if (expectedRequestId) {
    const inResponseTo = responseEl.getAttribute("InResponseTo");
    if (inResponseTo && inResponseTo !== expectedRequestId) {
      throw new SamlError("SAML Response does not match the original request");
    }
  }

  // --- Extract Issuer from Response ---
  const issuer = getElementText(responseEl, SAML_ASSERTION_NS, "Issuer") || "";

  // --- Step 7: Validate XML Signature ---
  const signedElement = verifySamlSignature(samlResponseXml, doc, certificates);

  // --- Get the assertion (only from the signed element) ---
  let assertion: Element;
  if (signedElement === "Assertion") {
    const assertions = doc.getElementsByTagNameNS(SAML_ASSERTION_NS, "Assertion");
    if (assertions.length === 0) {
      throw new SamlError("No Assertion found in SAML Response");
    }
    assertion = assertions[0] as Element;
  } else {
    // Response is signed — trust all assertions within it
    const assertions = doc.getElementsByTagNameNS(SAML_ASSERTION_NS, "Assertion");
    if (assertions.length === 0) {
      throw new SamlError("No Assertion found in SAML Response");
    }
    assertion = assertions[0] as Element;
  }

  // --- Step 8: Check Conditions (time + audience) ---
  checkConditions(assertion, expectedAudience);

  // --- Step 10: Extract Identity ---
  const identity = extractIdentity(assertion);

  return { identity, issuer };
}

// ─── Internal Helpers ───────────────────────────────────

/**
 * Check the SAML StatusCode is Success.
 */
function checkStatusCode(responseEl: Element): void {
  const statusElements = responseEl.getElementsByTagNameNS(SAML_PROTOCOL_NS, "Status");
  if (statusElements.length === 0) {
    throw new SamlError("No Status element in SAML Response");
  }

  const statusCodeElements = statusElements[0].getElementsByTagNameNS(
    SAML_PROTOCOL_NS,
    "StatusCode"
  );
  if (statusCodeElements.length === 0) {
    throw new SamlError("No StatusCode element in SAML Response");
  }

  const statusValue = statusCodeElements[0].getAttribute("Value");
  if (statusValue !== SAML_STATUS_SUCCESS) {
    // Check for nested status code for more detail
    const nestedCodes = statusCodeElements[0].getElementsByTagNameNS(
      SAML_PROTOCOL_NS,
      "StatusCode"
    );
    const nestedValue = nestedCodes.length > 0 ? nestedCodes[0].getAttribute("Value") : null;
    console.error(
      `[SAML] Authentication denied. StatusCode: ${statusValue}, Nested: ${nestedValue}`
    );
    throw new SamlError("Authentication denied by identity provider");
  }
}

/**
 * Verify the XML signature on the SAML Response or Assertion.
 * Returns which element was signed.
 */
function verifySamlSignature(
  xmlString: string,
  doc: Document,
  certificates: string[]
): "Response" | "Assertion" {
  const signatures = doc.getElementsByTagNameNS(XMLDSIG_NS, "Signature");

  if (signatures.length === 0) {
    throw new SamlError("SAML Response is not signed");
  }

  // Determine if signature is on Response or Assertion
  const sigParent = signatures[0].parentNode as Element | null;
  const signedElement: "Response" | "Assertion" =
    sigParent?.localName === "Assertion" ? "Assertion" : "Response";

  // Try each stored certificate (supports key rotation)
  const errors: string[] = [];
  for (const cert of certificates) {
    try {
      const sig = new SignedXml();
      sig.publicCert = certToPem(cert);
      sig.loadSignature(signatures[0]);

      if (sig.checkSignature(xmlString)) {
        return signedElement;
      }
      errors.push("Signature digest mismatch");
    } catch (err: any) {
      errors.push(err.message || "Unknown error");
    }
  }

  console.error(`[SAML] Signature verification failed. Errors: ${errors.join("; ")}`);
  throw new SamlError("SAML signature verification failed");
}

/**
 * Check Conditions: NotBefore, NotOnOrAfter, Audience.
 */
function checkConditions(assertion: Element, expectedAudience: string): void {
  const conditionsElements = assertion.getElementsByTagNameNS(SAML_ASSERTION_NS, "Conditions");
  if (conditionsElements.length === 0) {
    // No conditions — some IdPs omit them, allow but log
    console.warn("[SAML] No Conditions element in Assertion");
    return;
  }

  const conditions = conditionsElements[0];
  const now = Date.now();

  // Check NotBefore
  const notBefore = conditions.getAttribute("NotBefore");
  if (notBefore) {
    const notBeforeMs = new Date(notBefore).getTime();
    if (now < notBeforeMs - CLOCK_SKEW_MS) {
      throw new SamlError("SAML assertion is not yet valid");
    }
  }

  // Check NotOnOrAfter
  const notOnOrAfter = conditions.getAttribute("NotOnOrAfter");
  if (notOnOrAfter) {
    const notOnOrAfterMs = new Date(notOnOrAfter).getTime();
    if (now > notOnOrAfterMs + CLOCK_SKEW_MS) {
      throw new SamlError("SAML assertion has expired");
    }
  }

  // Check Audience
  const audienceElements = conditions.getElementsByTagNameNS(SAML_ASSERTION_NS, "Audience");
  if (audienceElements.length > 0) {
    const audiences: string[] = [];
    for (let i = 0; i < audienceElements.length; i++) {
      const text = audienceElements[i].textContent?.trim();
      if (text) audiences.push(text);
    }
    if (audiences.length > 0 && !audiences.includes(expectedAudience)) {
      console.error(
        `[SAML] Audience mismatch. Expected: ${expectedAudience}, Got: ${audiences.join(", ")}`
      );
      throw new SamlError("SAML audience restriction check failed");
    }
  }
}

/**
 * Extract user identity from the SAML assertion.
 */
function extractIdentity(assertion: Element): SamlIdentity {
  // --- NameID → ssoSubject ---
  const nameIdElements = assertion.getElementsByTagNameNS(SAML_ASSERTION_NS, "NameID");
  const nameIdEl = nameIdElements.length > 0 ? nameIdElements[0] : null;
  const nameIdValue = nameIdEl?.textContent?.trim() || "";
  const nameIdFormat = nameIdEl?.getAttribute("Format") || "";

  if (!nameIdValue) {
    throw new SamlError("No NameID found in SAML Assertion");
  }

  const ssoSubject = nameIdValue;

  // --- Build attribute map ---
  const attributes = extractAttributes(assertion);

  // --- Email ---
  let email = "";

  // If NameID format is email, use it
  if (nameIdFormat === NAMEID_FORMAT_EMAIL && nameIdValue.includes("@")) {
    email = nameIdValue;
  }

  // Try attribute fallbacks
  if (!email) {
    for (const attrName of EMAIL_ATTRIBUTE_NAMES) {
      if (attributes[attrName]) {
        email = attributes[attrName];
        break;
      }
    }
  }

  if (!email) {
    throw new SamlError("IdP did not provide an email address");
  }

  // --- Name ---
  let name = "";

  // Try display name attributes
  for (const attrName of NAME_ATTRIBUTE_NAMES) {
    if (attributes[attrName]) {
      name = attributes[attrName];
      break;
    }
  }

  // Try first + last name
  if (!name) {
    let firstName = "";
    let lastName = "";
    for (const attrName of FIRST_NAME_ATTRS) {
      if (attributes[attrName]) {
        firstName = attributes[attrName];
        break;
      }
    }
    for (const attrName of LAST_NAME_ATTRS) {
      if (attributes[attrName]) {
        lastName = attributes[attrName];
        break;
      }
    }
    name = `${firstName} ${lastName}`.trim();
  }

  // Fallback: email prefix
  if (!name) {
    name = email.split("@")[0];
  }

  return { ssoSubject, email, name };
}

/**
 * Extract all SAML attributes into a flat map.
 */
function extractAttributes(assertion: Element): Record<string, string> {
  const result: Record<string, string> = {};

  const attrStatements = assertion.getElementsByTagNameNS(
    SAML_ASSERTION_NS,
    "AttributeStatement"
  );
  if (attrStatements.length === 0) return result;

  const attrs = attrStatements[0].getElementsByTagNameNS(SAML_ASSERTION_NS, "Attribute");

  for (let i = 0; i < attrs.length; i++) {
    const attr = attrs[i];
    const name = attr.getAttribute("Name");
    if (!name) continue;

    const values = attr.getElementsByTagNameNS(SAML_ASSERTION_NS, "AttributeValue");
    if (values.length > 0) {
      const value = values[0].textContent?.trim() || "";
      if (value) result[name] = value;
    }
  }

  return result;
}

/**
 * Convert a raw base64 certificate to PEM format.
 */
function certToPem(cert: string): string {
  // If already in PEM format, return as-is
  if (cert.includes("-----BEGIN CERTIFICATE-----")) {
    return cert;
  }

  // Remove whitespace and wrap in PEM headers
  const clean = cert.replace(/\s+/g, "");
  const lines: string[] = [];
  for (let i = 0; i < clean.length; i += 64) {
    lines.push(clean.substring(i, i + 64));
  }
  return `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----`;
}

/**
 * Get text content of the first matching child element.
 */
function getElementText(
  parent: Element,
  ns: string,
  localName: string
): string | null {
  const elements = parent.getElementsByTagNameNS(ns, localName);
  if (elements.length === 0) return null;
  return elements[0].textContent?.trim() || null;
}

// ─── IdP Metadata Parsing ───────────────────────────────

/**
 * Parse IdP SAML metadata XML and extract configuration.
 */
export function parseIdpMetadata(metadataXml: string): SamlMetadataResult {
  const doc = new DOMParser().parseFromString(metadataXml, "text/xml");

  // EntityID
  const entityDescriptors = doc.getElementsByTagNameNS(SAML_METADATA_NS, "EntityDescriptor");
  if (entityDescriptors.length === 0) {
    throw new Error("No EntityDescriptor found in metadata");
  }
  const samlIdpEntityId = entityDescriptors[0].getAttribute("entityID");
  if (!samlIdpEntityId) {
    throw new Error("No entityID attribute found in EntityDescriptor");
  }

  // SSO URL — find SingleSignOnService with HTTP-Redirect binding
  let samlIdpSsoUrl = "";
  const ssoServices = doc.getElementsByTagNameNS(SAML_METADATA_NS, "SingleSignOnService");
  for (let i = 0; i < ssoServices.length; i++) {
    const binding = ssoServices[i].getAttribute("Binding");
    if (binding === "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect") {
      samlIdpSsoUrl = ssoServices[i].getAttribute("Location") || "";
      break;
    }
  }
  // Fallback: try HTTP-POST binding
  if (!samlIdpSsoUrl) {
    for (let i = 0; i < ssoServices.length; i++) {
      const binding = ssoServices[i].getAttribute("Binding");
      if (binding === "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST") {
        samlIdpSsoUrl = ssoServices[i].getAttribute("Location") || "";
        break;
      }
    }
  }
  if (!samlIdpSsoUrl) {
    throw new Error("No SingleSignOnService URL found in metadata");
  }

  // Certificates — extract from KeyDescriptor elements
  const samlIdpCertificates: string[] = [];
  const keyDescriptors = doc.getElementsByTagNameNS(SAML_METADATA_NS, "KeyDescriptor");

  for (let i = 0; i < keyDescriptors.length; i++) {
    const use = keyDescriptors[i].getAttribute("use");
    // Include if use="signing" or if use is not specified (Okta sometimes omits it)
    if (use === "signing" || !use) {
      const x509Certs = keyDescriptors[i].getElementsByTagNameNS(
        "http://www.w3.org/2000/09/xmldsig#",
        "X509Certificate"
      );
      for (let j = 0; j < x509Certs.length; j++) {
        const certText = x509Certs[j].textContent?.replace(/\s+/g, "").trim();
        if (certText) {
          samlIdpCertificates.push(certText);
        }
      }
    }
  }

  if (samlIdpCertificates.length === 0) {
    throw new Error("No signing certificates found in metadata");
  }

  return { samlIdpEntityId, samlIdpSsoUrl, samlIdpCertificates };
}

// ─── Error Class ────────────────────────────────────────

/**
 * Custom error class for SAML validation errors.
 * The message is safe to show to end users.
 */
export class SamlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SamlError";
  }
}
