import { ExclusiveCanonicalization } from "xml-crypto";
import { DOMParser } from "@xmldom/xmldom";

// ─── Constants ──────────────────────────────────────────

const SAML_PROTOCOL_NS = "urn:oasis:names:tc:SAML:2.0:protocol";
const SAML_ASSERTION_NS = "urn:oasis:names:tc:SAML:2.0:assertion";
const SAML_METADATA_NS = "urn:oasis:names:tc:SAML:2.0:metadata";
const XMLDSIG_NS = "http://www.w3.org/2000/09/xmldsig#";
const EXC_C14N_NS = "http://www.w3.org/2001/10/xml-exc-c14n#";

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
export async function validateSamlResponse(params: {
  samlResponseXml: string;
  certificates: string[];
  expectedAcsUrl: string;
  expectedAudience: string;
  expectedRequestId?: string; // Only for SP-initiated (InResponseTo check)
}): Promise<SamlValidationResult> {
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
  const signedElement = await verifySamlSignature(samlResponseXml, doc, certificates);

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

// ─── Signature Algorithm Mappings ──────────────────────

const DIGEST_ALGORITHM_MAP: Record<string, string> = {
  "http://www.w3.org/2000/09/xmldsig#sha1": "SHA-1",
  "http://www.w3.org/2001/04/xmlenc#sha256": "SHA-256",
  "http://www.w3.org/2001/04/xmlenc#sha512": "SHA-512",
};

const SIGNATURE_ALGORITHM_MAP: Record<string, string> = {
  "http://www.w3.org/2000/09/xmldsig#rsa-sha1": "SHA-1",
  "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256": "SHA-256",
  "http://www.w3.org/2001/04/xmldsig-more#rsa-sha512": "SHA-512",
};

/**
 * Compute a digest using Web Crypto API.
 */
async function webCryptoDigest(algorithm: string, data: string): Promise<string> {
  const encoded = new TextEncoder().encode(data);
  const hashBuffer = await crypto.subtle.digest(algorithm, encoded);
  return btoa(String.fromCharCode(...new Uint8Array(hashBuffer)));
}

/**
 * Extract the SubjectPublicKeyInfo (SPKI) from a DER-encoded X.509 certificate.
 * This parses just enough ASN.1 to pull out the public key for Web Crypto import.
 */
function extractSpkiFromCert(certDer: Uint8Array): Uint8Array {
  // X.509 Certificate structure (simplified ASN.1):
  //   Certificate ::= SEQUENCE {
  //     tbsCertificate TBSCertificate ::= SEQUENCE {
  //       version [0] EXPLICIT ...,
  //       serialNumber ...,
  //       signature AlgorithmIdentifier,
  //       issuer ...,
  //       validity ...,
  //       subject ...,
  //       subjectPublicKeyInfo SubjectPublicKeyInfo  <-- this is what we need
  //       ...
  //     }
  //   }
  let offset = 0;

  function readTag(): { tag: number; constructed: boolean; length: number } {
    const tag = certDer[offset++];
    const constructed = (tag & 0x20) !== 0;
    let length = certDer[offset++];
    if (length & 0x80) {
      const numBytes = length & 0x7f;
      length = 0;
      for (let i = 0; i < numBytes; i++) {
        length = (length << 8) | certDer[offset++];
      }
    }
    return { tag: tag & 0x1f, constructed, length };
  }

  function skipField(): void {
    const { length } = readTag();
    offset += length;
  }

  // Outer SEQUENCE (Certificate)
  readTag();
  // TBSCertificate SEQUENCE
  readTag();

  // version [0] EXPLICIT — optional, context-specific tag 0
  if ((certDer[offset] & 0xa0) === 0xa0) {
    skipField();
  }

  // serialNumber
  skipField();
  // signature (AlgorithmIdentifier)
  skipField();
  // issuer
  skipField();
  // validity
  skipField();
  // subject
  skipField();

  // subjectPublicKeyInfo — capture this entire SEQUENCE
  const spkiStart = offset;
  skipField();
  return certDer.slice(spkiStart, offset);
}

/**
 * Import a PEM-encoded X.509 certificate as a CryptoKey for signature verification.
 */
async function importX509Key(pemCert: string, hashAlgo: string): Promise<CryptoKey> {
  const b64 = pemCert
    .replace(/-----BEGIN CERTIFICATE-----/g, "")
    .replace(/-----END CERTIFICATE-----/g, "")
    .replace(/\s+/g, "");
  const binary = atob(b64);
  const certDer = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    certDer[i] = binary.charCodeAt(i);
  }

  const spki = extractSpkiFromCert(certDer);

  return crypto.subtle.importKey(
    "spki",
    spki.buffer as ArrayBuffer,
    { name: "RSASSA-PKCS1-v1_5", hash: hashAlgo },
    false,
    ["verify"]
  );
}

/**
 * Collect xmlns namespace declarations from all ancestor elements of a node.
 */
function collectAncestorNamespaces(
  node: Node
): Array<{ prefix: string; namespaceURI: string }> {
  const nsArray: Array<{ prefix: string; namespaceURI: string }> = [];
  let current = node.parentNode as Element | null;
  while (current && current.nodeType === 1 /* ELEMENT_NODE */) {
    if (current.attributes) {
      for (let i = 0; i < current.attributes.length; i++) {
        const attr = current.attributes[i];
        if (attr.nodeName && /^xmlns:?/.test(attr.nodeName)) {
          const prefix = attr.nodeName.replace(/^xmlns:?/, "");
          // Only add if not already present (closest ancestor wins)
          if (!nsArray.some((ns) => ns.prefix === prefix)) {
            nsArray.push({ prefix, namespaceURI: attr.nodeValue || "" });
          }
        }
      }
    }
    current = current.parentNode as Element | null;
  }
  return nsArray;
}

/**
 * Read the Exclusive C14N InclusiveNamespaces PrefixList from a
 * <Transform> or <CanonicalizationMethod> element. These prefixes must be
 * preserved during canonicalization even when not "visibly utilized"
 * (e.g. Okta sets PrefixList="xs" because attribute values use xsi:type="xs:string").
 */
function getInclusivePrefixList(parent: Element): string[] {
  const incl = parent.getElementsByTagNameNS(EXC_C14N_NS, "InclusiveNamespaces");
  if (incl.length === 0) return [];
  return (incl[0].getAttribute("PrefixList") || "").split(/\s+/).filter(Boolean);
}

/**
 * Canonicalize an XML element using Exclusive C14N,
 * automatically including ancestor namespace declarations.
 */
function canonicalizeElement(
  elem: Element,
  inclusiveNamespacesPrefixList: string[] = []
): string {
  const ancestorNamespaces = collectAncestorNamespaces(elem);
  const c14n = new ExclusiveCanonicalization();
  return c14n.process(elem, { ancestorNamespaces, inclusiveNamespacesPrefixList }).toString();
}

/**
 * Apply the enveloped-signature transform to a cloned node.
 *
 * Only the signature that directly envelops this element is removed — NOT
 * signatures over nested elements. This matters when both the Response and the
 * Assertion are signed (e.g. Okta): when verifying the Response, the Assertion's
 * own signature is part of the digested content and must be preserved.
 */
function removeSignatureFromElement(elem: Element): Element {
  const cloned = elem.cloneNode(true) as Element;
  const children = cloned.childNodes;
  for (let i = children.length - 1; i >= 0; i--) {
    const child = children[i] as Element;
    if (
      child.nodeType === 1 /* ELEMENT_NODE */ &&
      child.localName === "Signature" &&
      child.namespaceURI === XMLDSIG_NS
    ) {
      cloned.removeChild(child);
    }
  }
  return cloned;
}

/**
 * Verify the XML signature on the SAML Response or Assertion using Web Crypto API.
 * Returns which element was signed.
 *
 * Exported for regression testing against captured real-world IdP responses
 * (signature/canonicalization only — independent of assertion time conditions).
 */
export async function verifySamlSignature(
  _xmlString: string,
  doc: Document,
  certificates: string[]
): Promise<"Response" | "Assertion"> {
  const signatures = doc.getElementsByTagNameNS(XMLDSIG_NS, "Signature");

  if (signatures.length === 0) {
    throw new SamlError("SAML Response is not signed");
  }

  const signatureEl = signatures[0] as Element;
  const sigParent = signatureEl.parentNode as Element | null;
  const signedElement: "Response" | "Assertion" =
    sigParent?.localName === "Assertion" ? "Assertion" : "Response";

  // Extract SignedInfo
  const signedInfoEls = signatureEl.getElementsByTagNameNS(XMLDSIG_NS, "SignedInfo");
  if (signedInfoEls.length === 0) {
    throw new SamlError("No SignedInfo element found in Signature");
  }
  const signedInfoEl = signedInfoEls[0] as Element;

  // Get signature algorithm
  const sigMethodEls = signedInfoEl.getElementsByTagNameNS(XMLDSIG_NS, "SignatureMethod");
  if (sigMethodEls.length === 0) {
    throw new SamlError("No SignatureMethod found in SignedInfo");
  }
  const sigAlgoUri = sigMethodEls[0].getAttribute("Algorithm") || "";
  const hashAlgo = SIGNATURE_ALGORITHM_MAP[sigAlgoUri];
  if (!hashAlgo) {
    throw new SamlError(`Unsupported signature algorithm: ${sigAlgoUri}`);
  }

  // Get SignatureValue
  const sigValueEls = signatureEl.getElementsByTagNameNS(XMLDSIG_NS, "SignatureValue");
  if (sigValueEls.length === 0) {
    throw new SamlError("No SignatureValue found");
  }
  const sigValueB64 = (sigValueEls[0].textContent || "").replace(/\s+/g, "");
  const sigBytes = Uint8Array.from(atob(sigValueB64), (c) => c.charCodeAt(0));

  // Validate References (digest checks)
  const referenceEls = signedInfoEl.getElementsByTagNameNS(XMLDSIG_NS, "Reference");
  for (let i = 0; i < referenceEls.length; i++) {
    const ref = referenceEls[i] as Element;
    const uri = ref.getAttribute("URI") || "";

    // Find the referenced element
    let referencedElement: Element;
    if (uri === "") {
      referencedElement = doc.documentElement as Element;
    } else if (uri.startsWith("#")) {
      const id = uri.substring(1);
      referencedElement = findElementById(doc, id);
      if (!referencedElement) {
        throw new SamlError(`Referenced element not found: ${uri}`);
      }
    } else {
      throw new SamlError(`Unsupported Reference URI: ${uri}`);
    }

    // Apply transforms
    const transformEls = ref.getElementsByTagNameNS(XMLDSIG_NS, "Transform");
    let transformedElement = referencedElement;
    let refPrefixList: string[] = [];
    for (let t = 0; t < transformEls.length; t++) {
      const transformEl = transformEls[t] as Element;
      const transformAlgo = transformEl.getAttribute("Algorithm") || "";
      if (transformAlgo === "http://www.w3.org/2000/09/xmldsig#enveloped-signature") {
        transformedElement = removeSignatureFromElement(transformedElement);
      } else if (transformAlgo === EXC_C14N_NS) {
        // Exclusive C14N is applied during canonicalization below; capture its
        // InclusiveNamespaces PrefixList so it canonicalizes the same bytes the IdP signed.
        refPrefixList = getInclusivePrefixList(transformEl);
      }
    }

    // Canonicalize and compute digest
    const canonXml = canonicalizeElement(transformedElement, refPrefixList);

    // Get expected digest
    const digestMethodEls = ref.getElementsByTagNameNS(XMLDSIG_NS, "DigestMethod");
    const digestAlgoUri = digestMethodEls[0]?.getAttribute("Algorithm") || "";
    const digestHashAlgo = DIGEST_ALGORITHM_MAP[digestAlgoUri];
    if (!digestHashAlgo) {
      throw new SamlError(`Unsupported digest algorithm: ${digestAlgoUri}`);
    }

    const digestValueEls = ref.getElementsByTagNameNS(XMLDSIG_NS, "DigestValue");
    const expectedDigest = (digestValueEls[0]?.textContent || "").replace(/\s+/g, "");

    const computedDigest = await webCryptoDigest(digestHashAlgo, canonXml);

    if (computedDigest !== expectedDigest) {
      console.error(
        `[SAML] Digest mismatch for ${uri}. Expected: ${expectedDigest}, Got: ${computedDigest}. DigestAlgo: ${digestAlgoUri}. CanonXml length: ${canonXml.length}`
      );
      console.error(`[SAML] CanonXml (first 500 chars): ${canonXml.substring(0, 500)}`);
      throw new SamlError("SAML signature verification failed");
    }
  }

  // Canonicalize SignedInfo for signature verification, honoring any
  // InclusiveNamespaces PrefixList on its CanonicalizationMethod.
  const canonMethodEls = signedInfoEl.getElementsByTagNameNS(
    XMLDSIG_NS,
    "CanonicalizationMethod"
  );
  const signedInfoPrefixList =
    canonMethodEls.length > 0 ? getInclusivePrefixList(canonMethodEls[0] as Element) : [];
  const canonSignedInfo = canonicalizeElement(signedInfoEl, signedInfoPrefixList);

  // Try each stored certificate (supports key rotation)
  const errors: string[] = [];
  for (const cert of certificates) {
    try {
      const pem = certToPem(cert);
      const cryptoKey = await importX509Key(pem, hashAlgo);
      const dataBytes = new TextEncoder().encode(canonSignedInfo);
      const valid = await crypto.subtle.verify(
        "RSASSA-PKCS1-v1_5",
        cryptoKey,
        sigBytes,
        dataBytes
      );
      if (valid) {
        return signedElement;
      }
      errors.push("Signature value mismatch");
    } catch (err: any) {
      errors.push(err.message || "Unknown error");
    }
  }

  console.error(`[SAML] Signature verification failed. Errors: ${errors.join("; ")}`);
  throw new SamlError("SAML signature verification failed");
}

/**
 * Find an element by its ID attribute (checks Id, ID, id).
 */
function findElementById(doc: Document, id: string): Element {
  const all = doc.getElementsByTagName("*");
  for (let i = 0; i < all.length; i++) {
    const el = all[i] as Element;
    if (
      el.getAttribute("ID") === id ||
      el.getAttribute("Id") === id ||
      el.getAttribute("id") === id
    ) {
      return el;
    }
  }
  return null as any;
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
