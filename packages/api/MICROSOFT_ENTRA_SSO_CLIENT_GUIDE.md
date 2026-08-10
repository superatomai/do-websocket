# Microsoft Entra ID (Azure AD) SSO Setup Guide

This guide covers configuring OpenID Connect (OIDC) based Single Sign-On (SSO) between your Microsoft Entra ID tenant and Superatom AI.

---

## What To Do

In the [Microsoft Entra admin center](https://entra.microsoft.com), create a new **App registration** named `Superatom AI`, and configure it with:

| Field | Value |
|-------|-------|
| **Redirect URI** | `https://sa-api.superatom.ai/auth/sso/callback` (Platform: **Web**) |
| **Supported account types** | Single tenant (unless multi-tenant access is required) |
| **API permissions** | `openid`, `email`, `profile` (Microsoft Graph, delegated — added by default) |

Then generate a **client secret** under **Certificates & secrets**.

---

## What To Send Us

| Field | Where to find it |
|-------|-------------------|
| **Tenant ID** | App registration **Overview** page — *Directory (tenant) ID* |
| **Client ID** | App registration **Overview** page — *Application (client) ID* |
| **Client Secret** | The value generated under **Certificates & secrets** |
