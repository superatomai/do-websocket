# Okta SAML SSO Setup Guide

This guide walks through configuring SAML-based Single Sign-On (SSO) between your Okta organization and Superatom AI.

---

## What You'll Need

- Admin access to your Okta organization
- The following values from Superatom (provided below)

## Superatom SP (Service Provider) Details

| Field | Value |
|-------|-------|
| **Single Sign-On URL (ACS URL)** | `https://sa-api.superatom.ai/auth/sso/saml/acs` |
| **Audience URI (SP Entity ID)** | `https://sa-api.superatom.ai/auth/sso/saml/metadata` |
| **SP Metadata URL** | `https://sa-api.superatom.ai/auth/sso/saml/metadata` |
| **Name ID Format** | `EmailAddress` |

---

## Step 1: Create a SAML App Integration in Okta

1. Sign in to your **Okta Admin Console**
2. Navigate to **Applications** > **Applications**
3. Click **Create App Integration**
4. Select **SAML 2.0** and click **Next**

### General Settings

| Field | Value |
|-------|-------|
| App name | `Superatom AI` |
| App logo | *(optional — upload your Superatom logo if desired)* |

Click **Next**.

### SAML Settings

#### General

| Field | Value |
|-------|-------|
| Single sign-on URL | `https://sa-api.superatom.ai/auth/sso/saml/acs` |
| Use this for Recipient URL and Destination URL | Checked |
| Audience URI (SP Entity ID) | `https://sa-api.superatom.ai/auth/sso/saml/metadata` |
| Default RelayState | *(leave blank)* |
| Name ID format | `EmailAddress` |
| Application username | `Email` |
| Update application username on | `Create and update` |

#### Attribute Statements

Configure the following attribute mappings so that Superatom can identify your users:

| Name | Name format | Value |
|------|-------------|-------|
| `email` | Basic | `user.email` |
| `firstName` | Basic | `user.firstName` |
| `lastName` | Basic | `user.lastName` |
| `displayName` | Basic | `user.displayName` |

#### Group Attribute Statements

*(Optional — leave blank unless you need group-based access control)*

Click **Next**.

### Feedback

- Select **I'm an Okta customer adding an internal app**
- Click **Finish**

---

## Step 2: Share Metadata with Superatom

After creating the app, Okta generates a metadata URL.

1. Go to the **Sign On** tab of the newly created app
2. Under **SAML Signing Certificates**, find the **Metadata URL** (or click **Identity Provider metadata**)
3. The URL will look like:
   ```
   https://your-org.okta.com/app/xxxxxxxxxx/sso/saml/metadata
   ```
4. **Share this metadata URL with your Superatom admin** — we will use it to complete the configuration on our side

Alternatively, if you prefer to share the values manually, provide:
- **IdP Entity ID** — found in the metadata XML or on the Sign On tab
- **IdP Single Sign-On URL** — the SAML SSO endpoint
- **X.509 Certificate** — the signing certificate (downloadable from the Sign On tab)

---

## Step 3: Assign Users

1. Go to the **Assignments** tab of the Superatom app
2. Click **Assign** > **Assign to People** or **Assign to Groups**
3. Select the users or groups who should have access to Superatom
4. Click **Save and Go Back** > **Done**

Only assigned users will be able to sign in to Superatom via SSO.

---

## How Users Sign In

Once SSO is configured, users have two ways to access Superatom:

### From the Superatom Login Page (SP-Initiated)
1. Go to the Superatom sign-in page
2. Click **Sign in with Enterprise SSO**
3. Enter your organization identifier
4. You'll be redirected to Okta to authenticate
5. After signing in at Okta, you're redirected back to Superatom automatically

### From the Okta Dashboard (IdP-Initiated)
1. Sign in to your Okta dashboard
2. Click the **Superatom AI** app tile
3. You'll be signed in to Superatom automatically

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| "SSO is not configured for this organization" | Verify the metadata URL was shared with Superatom and configuration was completed on our side |
| "SAML signature verification failed" | The signing certificate may have been rotated in Okta. Share the updated metadata URL with your Superatom admin |
| "SAML assertion has expired" | Check that your Okta server's clock is accurate. There is a 3-minute tolerance for clock differences |
| "IdP did not provide an email address" | Verify the attribute statements are configured correctly (Step 1 — Attribute Statements section above) |
| User gets "Account is deactivated" | The user's account has been deactivated in Superatom. Contact your Superatom admin |
| User is not in Superatom after first SSO login | New users are auto-provisioned on first login. If they don't appear, verify they are assigned to the app in Okta (Step 3) |

---

## Certificate Rotation

When Okta rotates its signing certificate:

1. Go to the **Sign On** tab of the Superatom app in Okta
2. You'll see both the old and new certificates listed
3. Share the updated **metadata URL** with your Superatom admin
4. We will re-import the metadata to pick up the new certificate
5. Both old and new certificates will work during the transition period

---

## Support

If you run into any issues during setup, contact your Superatom admin with:
- Your Okta organization URL (e.g., `https://your-org.okta.com`)
- The metadata URL for the Superatom app
- A screenshot of any error messages
