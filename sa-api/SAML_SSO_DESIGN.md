# SAML SSO Implementation Design

## Context

Currently, SA-API supports **OIDC-based SSO** (Microsoft Entra, Okta, Generic OIDC). Some enterprise clients (e.g., BlueLinx) provide **SAML 2.0** metadata instead of OIDC credentials. We need to add SAML SP (Service Provider) support alongside the existing OIDC flow.

---

## What Changes

### 1. Database Schema

**A. Extend `sso_provider` enum:**
```
Current:  "microsoft_entra" | "okta" | "generic_oidc"
New:      "microsoft_entra" | "okta" | "generic_oidc" | "saml"
```

**B. Add SAML-specific columns to `sso_configs` table:**

| Column | Type | Description |
|--------|------|-------------|
| `protocol` | varchar(10), default `"oidc"` | `"oidc"` or `"saml"` — determines which flow to use |
| `saml_idp_entity_id` | varchar(1000), nullable | IdP Entity ID from metadata (e.g., `http://www.okta.com/exkvucc8eiKYtBl1k4x7`) |
| `saml_idp_sso_url` | varchar(1000), nullable | IdP Single Sign-On URL (HTTP-Redirect binding) |
| `saml_idp_certificates` | jsonb, nullable | **Array** of IdP X.509 signing certificates (PEM format). Stored as an array to support IdP key rotation — during rotation, the IdP metadata contains both the old and new certificate. Verification tries each certificate until one succeeds. |

**Why not a separate table?** The existing `ssoConfigs` table already has a 1:1 relationship with orgs. Adding nullable SAML columns keeps the config lookup simple — one query, one table. The `protocol` column determines which fields are relevant.

**Existing OIDC columns (`clientId`, `clientSecret`, `issuerUrl`, `scopes`) become nullable** since SAML configs don't use them.

**Migration SQL:**
```sql
-- Add protocol column
ALTER TABLE sso_configs ADD COLUMN protocol varchar(10) DEFAULT 'oidc' NOT NULL;

-- Add SAML columns
ALTER TABLE sso_configs ADD COLUMN saml_idp_entity_id varchar(1000);
ALTER TABLE sso_configs ADD COLUMN saml_idp_sso_url varchar(1000);
ALTER TABLE sso_configs ADD COLUMN saml_idp_certificates jsonb;

-- Make OIDC columns nullable (they're not needed for SAML configs)
ALTER TABLE sso_configs ALTER COLUMN client_id DROP NOT NULL;
ALTER TABLE sso_configs ALTER COLUMN client_secret DROP NOT NULL;
ALTER TABLE sso_configs ALTER COLUMN issuer_url DROP NOT NULL;

-- Add 'saml' to the sso_provider enum
ALTER TYPE sso_provider ADD VALUE 'saml';
```

---

### 2. New Route File: `src/routes/saml.ts`

A dedicated route file for SAML endpoints, mounted alongside OIDC SSO routes.

#### Endpoints

**A. `GET /auth/sso/saml/metadata` — SP Metadata (Public)**

Returns our Service Provider metadata XML. The client's IdP admin needs this to configure their side.

Note: No `<KeyDescriptor use="encryption">` is included — this signals to the IdP that we **do not support encrypted assertions**. If a client requires assertion encryption in the future, we would need to generate an SP key pair and include the public key here.

```xml
<?xml version="1.0"?>
<EntityDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata"
  entityID="https://<SA_API_URL>/auth/sso/saml/metadata">
  <SPSSODescriptor
    AuthnRequestsSigned="false"
    WantAssertionsSigned="true"
    protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</NameIDFormat>
    <NameIDFormat>urn:oasis:names:tc:SAML:2.0:nameid-format:persistent</NameIDFormat>
    <NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified</NameIDFormat>
    <AssertionConsumerService
      Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"
      Location="https://<SA_API_URL>/auth/sso/saml/acs"
      index="0"
      isDefault="true"/>
  </SPSSODescriptor>
</EntityDescriptor>
```

**Values to share with the client:**
- **Entity ID (SP):** `https://<SA_API_URL>/auth/sso/saml/metadata`
- **ACS URL:** `https://<SA_API_URL>/auth/sso/saml/acs`
- **Supported NameID Formats:** `emailAddress`, `persistent`, `unspecified`

---

**B. `GET /auth/sso/saml/login?org_slug=xxx` — Initiate SAML Login (Public, SP-Initiated)**

1. Look up org by slug
2. Fetch active SSO config (where `protocol = 'saml'`)
3. Generate a unique request ID (e.g., `_a1b2c3d4...`)
4. Generate a SAML `AuthnRequest` XML
5. Create a state token (signed JWT with `orgId`, `requestId`, `redirectTo`) — the `requestId` is stored for `InResponseTo` validation later
6. **DEFLATE compress** → Base64-encode → URL-encode the AuthnRequest (required by HTTP-Redirect binding spec)
7. Redirect user to IdP SSO URL:
   ```
   <idp_sso_url>?SAMLRequest=<deflated_base64_urlencoded>&RelayState=<state_token>
   ```

**AuthnRequest XML structure:**
```xml
<samlp:AuthnRequest
  xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"
  xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"
  ID="_<random_request_id>"
  Version="2.0"
  IssueInstant="2026-03-12T00:00:00Z"
  Destination="<idp_sso_url>"
  AssertionConsumerServiceURL="https://<SA_API_URL>/auth/sso/saml/acs"
  ProtocolBinding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST">
  <saml:Issuer>https://<SA_API_URL>/auth/sso/saml/metadata</saml:Issuer>
  <samlp:NameIDPolicy
    Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress"
    AllowCreate="true"/>
</samlp:AuthnRequest>
```

**DEFLATE encoding (required by spec, not optional):**
```
AuthnRequest XML → DEFLATE raw compress → Base64 encode → URL encode
```
Workers support `CompressionStream('deflate-raw')` natively.

---

**C. `POST /auth/sso/saml/acs` — Assertion Consumer Service (Public)**

This is the core endpoint. The IdP POSTs the SAML Response here after user authentication. It supports **both SP-initiated and IdP-initiated** SSO flows.

**Request:** `application/x-www-form-urlencoded` (parsed via `c.req.parseBody()`, NOT `c.req.json()`)
- `SAMLResponse` — Base64-encoded SAML Response XML (always present)
- `RelayState` — Our state token (present in SP-initiated flow, **absent in IdP-initiated flow**)

**Processing flow:**

```
Step 1: Decode SAMLResponse (Base64 → XML string)
Step 2: Parse XML into DOM (@xmldom/xmldom)
Step 3: Parse form body using c.req.parseBody()
        ┌─────────────────────────────────────────────────────────┐
Step 4: │ Determine flow type based on RelayState presence        │
        │                                                         │
        │ ┌─── RelayState PRESENT (SP-Initiated) ──────────────┐ │
        │ │ • Verify RelayState JWT → extract orgId, requestId, │ │
        │ │   redirectTo                                         │ │
        │ │ • Load SSO config by orgId                           │ │
        │ │ • Validate InResponseTo matches requestId            │ │
        │ │ • redirectUrl = redirectTo from JWT                   │ │
        │ └─────────────────────────────────────────────────────┘ │
        │                                                         │
        │ ┌─── RelayState ABSENT (IdP-Initiated) ──────────────┐ │
        │ │ • Extract <saml:Issuer> from SAML Response           │ │
        │ │ • Look up SSO config where                           │ │
        │ │   saml_idp_entity_id matches the Issuer              │ │
        │ │ • Skip InResponseTo validation (no prior request)    │ │
        │ │ • redirectUrl = PLATFORM_UI_URL + "/sso-callback"    │ │
        │ └─────────────────────────────────────────────────────┘ │
        └─────────────────────────────────────────────────────────┘
Step 5:  Check SAML Response Status Code
         • Extract <samlp:StatusCode Value="...">
         • "urn:oasis:names:tc:SAML:2.0:status:Success" → continue
         • Any other value → redirect with error:
           "Authentication denied by identity provider"
         • If nested <samlp:StatusCode> exists, include its value
           in the server-side log for debugging
Step 6:  Validate Response Destination
         • Destination attribute on <samlp:Response> must exactly
           match our ACS URL
         • Reject if missing or mismatched
Step 7:  Validate XML Signature (xml-crypto)
         • Find <ds:Signature> element(s)
         • Try each IdP certificate from saml_idp_certificates
           array until one succeeds (supports key rotation)
         • xml-crypto handles: canonicalization (Exclusive C14N),
           digest verification, enveloped signature transforms,
           wrapping attack prevention
         • Track WHICH element was signed (Response vs Assertion)
         • Only trust identity data from the signed element
Step 8:  Check Time Conditions (±3 minute clock skew tolerance)
         • NotBefore: assertion must not be used before this time
           (minus 3 min tolerance)
         • NotOnOrAfter: assertion has expired after this time
           (plus 3 min tolerance)
Step 9:  Check Audience Restriction
         • <Audience> must match our SP Entity ID
Step 10: Extract Identity from the SIGNED assertion only
         • NameID → ssoSubject (stable user identifier)
         • Email (checked in order):
           1. NameID if format is emailAddress
           2. Attribute: "email"
           3. Attribute: "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress"
           4. Attribute: "mail"
         • Name (checked in order):
           1. Attribute: "displayName" or
              "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name"
           2. Concatenation of firstName/lastName or
              givenName/surname attributes
           3. Fallback: email prefix (before @)
Step 11: Find or Create User (same logic as OIDC callback)
         • Match by (orgId + ssoSubject) → use existing user
         • Match by email → link ssoSubject to existing user
         • No match → auto-provision with role="member"
Step 12: Verify user isActive
         • Reject if isActive === false
Step 13: Issue SA-API JWT (7-day expiry)
         • Contains: userId, orgId, role
Step 14: Redirect to frontend
         • SP-initiated: <redirectTo>?token=<jwt>
         • IdP-initiated: <PLATFORM_UI_URL>/sso-callback?token=<jwt>
```

---

### 3. SAML XML Signature Validation (Critical Security)

This is the most important security piece. **We do NOT hand-roll this.**

**Libraries used:**
- `@node-saml/xml-crypto` — Battle-tested XML signature verification (used by passport-saml in thousands of production deployments). Handles:
  - XML Canonicalization (Exclusive C14N, C14N 1.0/1.1)
  - Digest computation and verification
  - Enveloped signature transforms
  - Protection against XML Signature Wrapping attacks
  - RSA-SHA1, RSA-SHA256, RSA-SHA384, RSA-SHA512 algorithms
- `@xmldom/xmldom` — DOM-based XML parser (required by xml-crypto). Preserves namespaces, attribute ordering, and whitespace — all critical for canonicalization.

**Why not `fast-xml-parser`?** It converts XML to JSON and loses namespace prefixes, attribute ordering, and whitespace. These are all critical for XML canonicalization during signature verification. Using it would create silent authentication bypasses.

**Why this works on Cloudflare Workers:** `wrangler.toml` already has `nodejs_compat` enabled, so `xml-crypto`'s dependency on Node.js `crypto` module is satisfied.

**Verification logic (pseudocode using xml-crypto v6+ API):**
```typescript
import { SignedXml } from "@node-saml/xml-crypto";
import { DOMParser } from "@xmldom/xmldom";

function verifySamlSignature(
  xmlString: string,
  certificates: string[]
): { valid: boolean; signedElement: "Response" | "Assertion" } {
  const doc = new DOMParser().parseFromString(xmlString, "text/xml");

  // Find Signature element(s) — check both Response-level and Assertion-level
  const signatures = doc.getElementsByTagNameNS(
    "http://www.w3.org/2000/09/xmldsig#", "Signature"
  );

  if (signatures.length === 0) {
    throw new Error("No XML signature found in SAML Response");
  }

  // Determine if signature is on Response or Assertion
  const sigParent = signatures[0].parentNode;
  const signedElement = sigParent?.localName === "Assertion" ? "Assertion" : "Response";

  // Try each stored certificate (supports key rotation)
  for (const cert of certificates) {
    const sig = new SignedXml();
    sig.publicCert = certToPem(cert);   // v6+ API
    sig.loadSignature(signatures[0]);

    if (sig.checkSignature(xmlString)) {
      return { valid: true, signedElement };
    }
  }

  throw new Error("Signature verification failed with all stored certificates");
}
```

---

### 4. Admin Config Endpoints (Changes to existing)

**`POST /auth/sso/config` — Updated to support SAML:**

```typescript
// New request body for SAML
{
  provider: "saml",
  protocol: "saml",
  samlIdpEntityId: string,
  samlIdpSsoUrl: string,
  samlIdpCertificates: string[],   // Array of PEM-formatted X.509 certs
}

// Existing OIDC body unchanged
{
  provider: "okta" | "microsoft_entra" | "generic_oidc",
  protocol: "oidc",             // default if omitted
  clientId: string,
  clientSecret: string,
  issuerUrl: string,
  scopes?: string,
}
```

**Validation for SAML config:**
- `samlIdpEntityId` — required, non-empty
- `samlIdpSsoUrl` — required, must be a valid HTTPS URL
- `samlIdpCertificates` — required, array with at least one valid X.509 certificate

---

**`POST /auth/sso/config/saml/from-metadata` — New convenience endpoint (Admin)**

Accepts a SAML metadata URL (like the one the BlueLinx client provided), fetches it, parses the XML, and auto-extracts the configuration.

```typescript
// Request
{ metadataUrl: "https://bluelinx.okta.com/app/exkvucc8eiKYtBl1k4x7/sso/saml/metadata" }

// Response — extracted values (admin can review before saving)
{
  samlIdpEntityId: "http://www.okta.com/exkvucc8eiKYtBl1k4x7",
  samlIdpSsoUrl: "https://bluelinx.okta.com/app/exkvucc8eiKYtBl1k4x7/sso/saml",
  samlIdpCertificates: ["MIIDp...", "MIIDq..."]  // All signing certs from metadata
}
```

**Metadata parsing extracts:**
- `entityID` attribute from `<EntityDescriptor>` → `samlIdpEntityId`
- `<SingleSignOnService>` with `Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect"` → `samlIdpSsoUrl`
- All `<KeyDescriptor use="signing">` → `<X509Certificate>` values → `samlIdpCertificates`
- If no `use="signing"` is specified, include all `<KeyDescriptor>` certs (Okta sometimes omits the `use` attribute)

---

### 5. Modify `/auth/sso/authorize` (Existing OIDC Route)

Update the existing authorize endpoint to check the config's `protocol` field:

```
GET /auth/sso/authorize?org_slug=acme
  → if config.protocol === "oidc"  → existing OIDC redirect flow (unchanged)
  → if config.protocol === "saml"  → internally delegate to SAML login logic
```

This way the **frontend doesn't need to change** — it still calls the same `getSSOAuthorizeUrl()` and the backend routes to the correct protocol automatically.

---

### 6. Frontend Changes

**None required for the core flow.** The existing `SignInPage.tsx` and `SSOCallback.tsx` work as-is because:

- `SignInPage` calls `saApi.getSSOAuthorizeUrl(orgSlug)` → hits `/auth/sso/authorize` → backend decides OIDC vs SAML
- `SSOCallback` receives `?token=<jwt>` regardless of protocol
- IdP-initiated SSO also redirects to `/sso-callback?token=<jwt>` so `SSOCallback.tsx` handles it without changes
- The SSO admin config UI may need a small update later to show SAML fields, but that's optional for the initial implementation

---

### 7. Route Mounting

In `src/index.ts`:
```typescript
import samlRoutes from "./routes/saml";

// Existing
app.route("/auth/sso", ssoRoutes);       // OIDC SSO + config
// New
app.route("/auth/sso/saml", samlRoutes); // SAML-specific endpoints
```

---

### 8. Dependencies to Add

| Package | Purpose | Workers-compatible |
|---------|---------|-------------------|
| `@node-saml/xml-crypto` | XML signature verification (canonicalization, digest, signature validation). Battle-tested, used by passport-saml. | Yes (with `nodejs_compat`) |
| `@xmldom/xmldom` | DOM-based XML parser. Preserves namespaces and attribute ordering required for canonicalization. | Yes |

Both libraries work with the `nodejs_compat` flag already enabled in `wrangler.toml`.

**NOT using `fast-xml-parser`** — it converts XML to JSON and destroys namespace/attribute/whitespace information critical for signature verification.

---

### 9. File Summary

| File | Action | Description |
|------|--------|-------------|
| `src/db/schema.ts` | **Modify** | Add `protocol`, `samlIdpEntityId`, `samlIdpSsoUrl`, `samlIdpCertificates` columns; make OIDC columns nullable |
| `drizzle/0004_add_saml_sso.sql` | **New** | Migration for schema changes |
| `src/routes/saml.ts` | **New** | SAML endpoints: `/metadata`, `/login`, `/acs` (supports both SP-initiated and IdP-initiated) |
| `src/lib/saml.ts` | **New** | SAML helpers: AuthnRequest generation, Response parsing & validation, signature verification, metadata parsing, attribute extraction, status code checking |
| `src/routes/sso.ts` | **Modify** | Update `/authorize` to check protocol and route to SAML when needed; update `/config` POST to accept SAML fields; add `/config/saml/from-metadata` endpoint |
| `src/index.ts` | **Modify** | Mount SAML routes |
| `package.json` | **Modify** | Add `@node-saml/xml-crypto` and `@xmldom/xmldom` |

---

### 10. Security Checklist

| # | Check | Description | Status |
|---|-------|-------------|--------|
| 1 | **XML Signature Verification** | Using `xml-crypto` (not hand-rolled). Handles canonicalization, digest, enveloped transforms, and wrapping attack prevention. | Required |
| 2 | **Signed Element Trust** | Only extract identity from the element whose signature was verified. Unsigned assertions are ignored. | Required |
| 3 | **SAML Status Code Check** | Verify `<samlp:StatusCode>` is `Success` before processing. Reject IdP error/denial responses. | Required |
| 4 | **InResponseTo Validation** | SP-initiated: Response must reference our specific AuthnRequest ID (stored in RelayState JWT). IdP-initiated: skipped (no prior request). | Required |
| 5 | **Destination Validation** | Response `Destination` must exactly match our ACS URL. Prevents responses meant for other SPs. | Required |
| 6 | **Audience Restriction** | Assertion `Audience` must match our SP Entity ID. | Required |
| 7 | **Time Condition Checks** | `NotBefore` and `NotOnOrAfter` enforced with 3-minute clock skew tolerance. | Required |
| 8 | **Replay Protection** | Strict `NotOnOrAfter` enforcement (tight window). `InResponseTo` binding to our request (SP-initiated). | Required |
| 9 | **Certificate Rotation** | Store multiple IdP certificates as a JSON array. Try each during verification. | Required |
| 10 | **RelayState Integrity** | Signed JWT (HS256, 10-min expiry) — same as OIDC state token. Okta and all major IdPs support >80 byte RelayState. | Existing |
| 11 | **NameID Flexibility** | Don't assume NameID = email. Support `emailAddress`, `persistent`, `unspecified` formats. Extract email from attributes as fallback. | Required |
| 12 | **HTTPS Enforcement** | ACS URL and SP Entity ID use HTTPS. IdP SSO URL validated as HTTPS on config save. | Required |
| 13 | **IdP-Initiated SSO** | Supported via Issuer-based org lookup when RelayState is absent. | Required |
| 14 | **No Encrypted Assertion Support** | SP metadata omits `<KeyDescriptor use="encryption">`, signaling to IdPs not to encrypt. Documented as a known limitation. | Documented |

---

### 11. Flow Diagrams

#### A. SP-Initiated Flow (User clicks "Sign in with SSO" on our login page)

```
Browser                     SA-API                        Okta (BlueLinx)
  │                           │                                │
  │  GET /auth/sso/authorize  │                                │
  │  ?org_slug=bluelinx       │                                │
  ├──────────────────────────>│                                │
  │                           │ Lookup org → fetch SSO config  │
  │                           │ config.protocol === "saml"     │
  │                           │                                │
  │                           │ Generate requestId             │
  │                           │ Build AuthnRequest XML         │
  │                           │ DEFLATE → Base64 → URL-encode  │
  │                           │ Create RelayState JWT          │
  │                           │   {orgId, requestId, redirect} │
  │    302 Redirect           │                                │
  │<──────────────────────────│                                │
  │                           │                                │
  │  GET <okta_sso_url>       │                                │
  │  ?SAMLRequest=<deflated>  │                                │
  │  &RelayState=<jwt>        │                                │
  ├───────────────────────────────────────────────────────────>│
  │                           │                                │
  │                           │                 User logs in   │
  │                           │                 at Okta        │
  │                           │                                │
  │  POST /auth/sso/saml/acs                                   │
  │  Body: SAMLResponse=<b64>&RelayState=<jwt>                 │
  │<───────────────────────────────────────────────────────────│
  ├──────────────────────────>│                                │
  │                           │ Decode → Parse → Verify JWT    │
  │                           │ Check Status Code              │
  │                           │ Validate Destination           │
  │                           │ Validate InResponseTo          │
  │                           │ Verify XML signature           │
  │                           │ Check time + audience          │
  │                           │ Extract identity               │
  │                           │ Find/create user               │
  │                           │ Issue SA-API JWT               │
  │                           │                                │
  │  302 → /sso-callback?token=<sa_jwt>                        │
  │<──────────────────────────│                                │
  │                           │                                │
  │  SSOCallback.tsx          │                                │
  │  handleSSOCallback(token) │                                │
  │  → store token, navigate  │                                │
```

#### B. IdP-Initiated Flow (User clicks app tile in Okta dashboard)

```
Browser                     SA-API                        Okta (BlueLinx)
  │                           │                                │
  │  User clicks "Superatom"  │                                │
  │  tile in Okta dashboard   │                                │
  ├───────────────────────────────────────────────────────────>│
  │                           │                                │
  │                           │             Okta authenticates │
  │                           │             user, generates    │
  │                           │             SAML Response       │
  │                           │                                │
  │  POST /auth/sso/saml/acs                                   │
  │  Body: SAMLResponse=<b64> (NO RelayState)                  │
  │<───────────────────────────────────────────────────────────│
  ├──────────────────────────>│                                │
  │                           │ Decode → Parse XML             │
  │                           │ No RelayState → IdP-initiated  │
  │                           │ Extract <Issuer> from Response │
  │                           │ Lookup org by saml_idp_entity_id│
  │                           │ Check Status Code              │
  │                           │ Validate Destination           │
  │                           │ Skip InResponseTo (no request) │
  │                           │ Verify XML signature           │
  │                           │ Check time + audience          │
  │                           │ Extract identity               │
  │                           │ Find/create user               │
  │                           │ Issue SA-API JWT               │
  │                           │                                │
  │  302 → <PLATFORM_UI_URL>/sso-callback?token=<sa_jwt>       │
  │<──────────────────────────│                                │
  │                           │                                │
  │  SSOCallback.tsx          │                                │
  │  handleSSOCallback(token) │                                │
  │  → store token, navigate  │                                │
```

---

### 12. For the BlueLinx Client

Once implemented, here's what we provide them:

> **ACS URL:** `https://<sa-api-domain>/auth/sso/saml/acs`
> **Entity ID (SP):** `https://<sa-api-domain>/auth/sso/saml/metadata`
> **SP Metadata URL:** `https://<sa-api-domain>/auth/sso/saml/metadata`
> **Supported NameID Formats:** `emailAddress`, `persistent`, `unspecified`

And on our side, we use the admin endpoint to import their metadata from:
`https://bluelinx.okta.com/app/exkvucc8eiKYtBl1k4x7/sso/saml/metadata`

This auto-extracts the IdP Entity ID, SSO URL, and all signing certificates.

---

### 13. Error Handling

All errors during the ACS flow redirect to the frontend with a user-friendly error message (same pattern as OIDC callback):

```
/sso-callback?error=<url_encoded_message>
```

**Determining the redirect URL on error:**
- If RelayState is present and valid → use `redirectTo` from the JWT
- If RelayState is absent (IdP-initiated) and org was identified → use `PLATFORM_UI_URL/sso-callback`
- If nothing can be determined (early failure) → use `PLATFORM_UI_URL/sso-callback` as fallback

| Scenario | Error Message |
|----------|---------------|
| Missing SAMLResponse | `"Missing SAMLResponse in the request"` |
| Invalid/expired RelayState JWT | `"Invalid or expired SSO session"` |
| SSO config not found (by orgId or Issuer) | `"SSO is not configured for this organization"` |
| SAML Status Code is not Success | `"Authentication denied by identity provider"` |
| Destination mismatch | `"SAML Response destination mismatch"` |
| InResponseTo mismatch (SP-initiated only) | `"SAML Response does not match the original request"` |
| No XML signature found | `"SAML Response is not signed"` |
| Signature verification failed | `"SAML signature verification failed"` |
| Assertion expired (NotOnOrAfter) | `"SAML assertion has expired"` |
| Assertion not yet valid (NotBefore) | `"SAML assertion is not yet valid"` |
| Audience mismatch | `"SAML audience restriction check failed"` |
| No email in assertion | `"IdP did not provide an email address"` |
| User deactivated | `"Account is deactivated"` |

All errors are also logged server-side with full context for debugging (but sensitive data like the raw assertion is NOT included in the redirect URL).

---

### 14. Known Limitations

| Limitation | Impact | Mitigation |
|------------|--------|------------|
| **No encrypted assertion support** | If an IdP admin enables assertion encryption, SSO will fail | SP metadata omits encryption key descriptor, signaling not to encrypt. Document this for clients. Can be added later if needed. |
| **RelayState >80 bytes** | Some strict/old IdPs may truncate the RelayState JWT | All major IdPs (Okta, Entra, Google) support large RelayState. If an exotic IdP truncates it, the SP-initiated flow will fail but IdP-initiated flow still works (no RelayState needed). |
| **Single-org per IdP Entity ID** | IdP-initiated flow looks up org by `saml_idp_entity_id`, so each IdP entity can only map to one org | This is the expected 1:1 relationship. Multi-tenant IdPs use different app registrations (different entity IDs) per tenant. |
