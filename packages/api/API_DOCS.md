# SA-API — REST API Documentation

**Base URL:** `https://sa-api.ashish-91e.workers.dev`

---

## Authentication

All endpoints (except `POST /auth/login` and `GET /health`) require a JWT token in the Authorization header:

```
Authorization: Bearer <token>
```

Get the token by calling `POST /auth/login`.

---

## Health Check

### `GET /health`

No auth required.

**Response:**
```json
{
  "status": "healthy",
  "worker": "sa-api",
  "timestamp": 1770809847577
}
```

---

## Auth

### `POST /auth/login`

Login with email or username + password. Returns a JWT token (valid for 7 days).

**Body:**
```json
{
  "email": "gopi@superatom.ai",
  "password": "your-password"
}
```
Or use username:
```json
{
  "username": "gopi",
  "password": "your-password"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| email | string | one of email/username | User's email |
| username | string | one of email/username | User's username |
| password | string | yes | User's password |

**Response (200):**
```json
{
  "token": "eyJhbGciOiJIUzI1NiJ9...",
  "user": {
    "id": "uuid",
    "email": "gopi@superatom.ai",
    "username": "gopi",
    "name": "Gopinadh",
    "role": "org_admin",
    "orgId": "uuid"
  }
}
```

**Errors:** `400` missing fields, `401` invalid credentials

---

### `POST /auth/logout`

Acknowledge logout (JWT is stateless — client should discard the token).

**Headers:** `Authorization: Bearer <token>`

**Response (200):**
```json
{ "message": "Logged out successfully" }
```

---

### `GET /auth/me`

Get the current user's profile, organization, and list of permitted apps.

**Headers:** `Authorization: Bearer <token>`

**Response (200):**
```json
{
  "user": {
    "id": "uuid",
    "email": "gopi@superatom.ai",
    "username": "gopi",
    "name": "Gopinadh",
    "role": "org_admin"
  },
  "organization": {
    "id": "uuid",
    "name": "Superatom",
    "slug": "superatom"
  },
  "apps": [
    {
      "id": "uuid",
      "name": "Sales Dashboard",
      "type": "dashboard",
      "projectId": "uuid",
      "projectName": "Analytics",
      "permission": "edit"
    }
  ]
}
```

**Note:** `org_admin` sees ALL active apps in the org. `member` sees only apps explicitly granted via permissions.

---

## Organizations (org_admin only)

### `POST /orgs`

Create a new organization.

**Body:**
```json
{
  "name": "Acme Corp",
  "slug": "acme-corp"
}
```

**Response (201):** Returns the created organization object.

---

### `GET /orgs/:orgId`

Get organization details.

**Response (200):**
```json
{
  "id": "uuid",
  "name": "Acme Corp",
  "slug": "acme-corp",
  "createdAt": "2025-01-01T00:00:00.000Z",
  "updatedAt": "2025-01-01T00:00:00.000Z"
}
```

---

### `PUT /orgs/:orgId`

Update organization.

**Body (all fields optional):**
```json
{
  "name": "Acme Corp Updated",
  "slug": "acme-updated"
}
```

**Response (200):** Returns updated organization object.

---

## Users (org_admin only)

### `POST /orgs/:orgId/users`

Create a new user in the organization.

**Body:**
```json
{
  "email": "bob@acme.com",
  "username": "bob",
  "name": "Bob Smith",
  "password": "securepassword",
  "role": "member"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| email | string | yes | Unique email |
| username | string | yes | Unique username |
| name | string | yes | Display name |
| password | string | yes | Plain text (hashed server-side) |
| role | string | no | `"org_admin"` or `"member"` (default: `"member"`) |

**Response (201):**
```json
{
  "id": "uuid",
  "orgId": "uuid",
  "email": "bob@acme.com",
  "username": "bob",
  "name": "Bob Smith",
  "role": "member",
  "isActive": true,
  "createdAt": "2025-01-01T00:00:00.000Z"
}
```

**Errors:** `409` if email already exists

---

### `GET /orgs/:orgId/users`

List all users in the organization.

**Response (200):**
```json
[
  {
    "id": "uuid",
    "email": "bob@acme.com",
    "username": "bob",
    "name": "Bob Smith",
    "role": "member",
    "isActive": true,
    "createdAt": "2025-01-01T00:00:00.000Z"
  }
]
```

---

### `GET /orgs/:orgId/users/:userId`

Get user details including their app permissions.

**Response (200):**
```json
{
  "id": "uuid",
  "email": "bob@acme.com",
  "username": "bob",
  "name": "Bob Smith",
  "role": "member",
  "isActive": true,
  "createdAt": "2025-01-01T00:00:00.000Z",
  "permissions": [
    {
      "appId": "uuid",
      "appName": "Sales Dashboard",
      "appType": "dashboard",
      "permission": "view",
      "createdAt": "2025-01-01T00:00:00.000Z"
    }
  ]
}
```

---

### `PUT /orgs/:orgId/users/:userId`

Update a user.

**Body (all fields optional):**
```json
{
  "username": "bobby",
  "name": "Bobby Smith",
  "role": "org_admin",
  "isActive": false
}
```

**Response (200):** Returns updated user object.

---

### `DELETE /orgs/:orgId/users/:userId`

Deactivate a user. Sets `isActive = false` and **revokes all app permissions**.

**Response (200):**
```json
{ "message": "User deactivated and all permissions revoked" }
```

---

## Projects (org_admin only)

### `POST /orgs/:orgId/projects`

Create a new project.

**Body:**
```json
{
  "name": "Analytics",
  "slug": "analytics",
  "description": "Analytics dashboards and reports"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| name | string | yes | Project name |
| slug | string | yes | URL-friendly identifier (unique within org) |
| description | string | no | Project description |

**Response (201):** Returns the created project object.

**Errors:** `409` if slug already exists in the org

---

### `GET /orgs/:orgId/projects`

List all projects in the organization.

**Response (200):**
```json
[
  {
    "id": "uuid",
    "orgId": "uuid",
    "name": "Analytics",
    "slug": "analytics",
    "description": "Analytics dashboards and reports",
    "createdBy": "uuid",
    "createdAt": "2025-01-01T00:00:00.000Z",
    "updatedAt": "2025-01-01T00:00:00.000Z"
  }
]
```

---

### `GET /orgs/:orgId/projects/:projectId`

Get project details including its apps.

**Response (200):**
```json
{
  "id": "uuid",
  "orgId": "uuid",
  "name": "Analytics",
  "slug": "analytics",
  "description": "Analytics dashboards and reports",
  "createdBy": "uuid",
  "createdAt": "2025-01-01T00:00:00.000Z",
  "updatedAt": "2025-01-01T00:00:00.000Z",
  "apps": [
    {
      "id": "uuid",
      "projectId": "uuid",
      "type": "dashboard",
      "name": "Sales Dashboard",
      "config": {},
      "createdBy": "uuid",
      "isActive": true,
      "createdAt": "2025-01-01T00:00:00.000Z",
      "updatedAt": "2025-01-01T00:00:00.000Z"
    }
  ]
}
```

---

### `PUT /orgs/:orgId/projects/:projectId`

Update a project.

**Body (all fields optional):**
```json
{
  "name": "Analytics v2",
  "slug": "analytics-v2",
  "description": "Updated analytics"
}
```

**Response (200):** Returns updated project object.

---

### `DELETE /orgs/:orgId/projects/:projectId`

Delete a project. **Cascades** — deletes all apps and their permissions.

**Response (200):**
```json
{ "message": "Project deleted" }
```

---

## Apps (org_admin only)

### `POST /projects/:projectId/apps`

Create an app in a project.

**Body:**
```json
{
  "name": "Sales Dashboard",
  "type": "dashboard",
  "config": { "theme": "dark" }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| name | string | yes | App name |
| type | string | yes | `"dashboard"`, `"app"`, `"report"`, or `"chat_agent"` |
| config | object | no | App-specific configuration (JSONB) |

**Response (201):** Returns the created app object.

---

### `GET /projects/:projectId/apps`

List all active apps in a project.

**Response (200):**
```json
[
  {
    "id": "uuid",
    "projectId": "uuid",
    "type": "dashboard",
    "name": "Sales Dashboard",
    "config": { "theme": "dark" },
    "createdBy": "uuid",
    "isActive": true,
    "createdAt": "2025-01-01T00:00:00.000Z",
    "updatedAt": "2025-01-01T00:00:00.000Z"
  }
]
```

---

### `GET /apps/:appId`

Get a single app's details.

**Response (200):** Returns the app object.

---

### `PUT /apps/:appId`

Update an app.

**Body (all fields optional):**
```json
{
  "name": "Sales Dashboard v2",
  "type": "report",
  "config": { "theme": "light" },
  "isActive": false
}
```

**Response (200):** Returns updated app object.

---

### `DELETE /apps/:appId`

Delete an app. **Cascades** — removes all permissions for this app.

**Response (200):**
```json
{ "message": "App deleted" }
```

---

## App Permissions (org_admin only)

### `POST /apps/:appId/permissions`

Grant a user access to an app.

**Body:**
```json
{
  "userId": "uuid",
  "permission": "view"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| userId | string (UUID) | yes | User to grant access to |
| permission | string | yes | `"view"`, `"edit"`, or `"admin"` |

**Response (201):** Returns the created permission object.

**Errors:** `409` if user already has permission (use PUT to update)

---

### `GET /apps/:appId/permissions`

List all users who have access to this app.

**Response (200):**
```json
[
  {
    "id": "uuid",
    "userId": "uuid",
    "userName": "Bob Smith",
    "userEmail": "bob@acme.com",
    "permission": "view",
    "createdAt": "2025-01-01T00:00:00.000Z"
  }
]
```

---

### `PUT /apps/:appId/permissions/:userId`

Update a user's permission level for an app.

**Body:**
```json
{
  "permission": "edit"
}
```

**Response (200):** Returns updated permission object.

---

### `DELETE /apps/:appId/permissions/:userId`

Revoke a user's access to an app.

**Response (200):**
```json
{ "message": "Permission revoked" }
```

---

## User-Facing Endpoints (any authenticated user)

### `GET /my/apps`

List all apps the logged-in user can access.

- **org_admin** → returns all active apps in the org
- **member** → returns only apps explicitly granted via permissions

**Response (200):**
```json
[
  {
    "id": "uuid",
    "name": "Sales Dashboard",
    "type": "dashboard",
    "projectId": "uuid",
    "projectName": "Analytics",
    "config": { "theme": "dark" },
    "permission": "view"
  }
]
```

---

### `GET /my/apps/:appId`

Get a specific app's details (only if the user has access).

**Response (200):**
```json
{
  "id": "uuid",
  "name": "Sales Dashboard",
  "type": "dashboard",
  "projectId": "uuid",
  "projectName": "Analytics",
  "config": { "theme": "dark" },
  "permission": "view"
}
```

**Errors:** `403` if user doesn't have permission

---

## Error Responses

All errors follow this format:

```json
{
  "error": "Description of what went wrong"
}
```

| Status | Meaning |
|--------|---------|
| 400 | Bad request — missing or invalid fields |
| 401 | Unauthorized — missing/invalid/expired JWT |
| 403 | Forbidden — user doesn't have required role or permission |
| 404 | Not found |
| 409 | Conflict — duplicate entry (email, slug, permission) |
| 500 | Internal server error |

---

## Quick Start Example

```bash
# 1. Login
TOKEN=$(curl -s -X POST https://sa-api.ashish-91e.workers.dev/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"gopi","password":"your-password"}' | jq -r '.token')

# 2. Get current user info
curl -s https://sa-api.ashish-91e.workers.dev/auth/me \
  -H "Authorization: Bearer $TOKEN" | jq .

# 3. Create a project
curl -s -X POST https://sa-api.ashish-91e.workers.dev/orgs/<orgId>/projects \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Analytics","slug":"analytics","description":"Reports and dashboards"}' | jq .

# 4. Create an app in the project
curl -s -X POST https://sa-api.ashish-91e.workers.dev/projects/<projectId>/apps \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Sales Dashboard","type":"dashboard"}' | jq .

# 5. Grant a user access to the app
curl -s -X POST https://sa-api.ashish-91e.workers.dev/apps/<appId>/permissions \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"userId":"<userId>","permission":"view"}' | jq .

# 6. As a member, see my apps
curl -s https://sa-api.ashish-91e.workers.dev/my/apps \
  -H "Authorization: Bearer $MEMBER_TOKEN" | jq .
```
