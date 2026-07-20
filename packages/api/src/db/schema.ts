import {
  pgTable,
  uuid,
  varchar,
  text,
  boolean,
  timestamp,
  jsonb,
  serial,
  integer,
  numeric,
  pgEnum,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";

// ─── Enums ───────────────────────────────────────────────

export const userRoleEnum = pgEnum("user_role", ["super_admin", "org_admin", "member"]);

export const appTypeEnum = pgEnum("app_type", [
  "dashboard",
  "app",
  "report",
  "chat_agent",
]);

export const permissionEnum = pgEnum("permission_level", [
  "view",
  "edit",
  "admin",
]);

export const ssoProviderEnum = pgEnum("sso_provider", [
  "microsoft_entra",
  "okta",
  "generic_oidc",
  "saml",
]);

// ─── Organizations ───────────────────────────────────────

export const organizations = pgTable("organizations", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  slug: varchar("slug", { length: 100 }).unique().notNull(),
  icon: text("icon"),
  defaultAppId: uuid("default_app_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const organizationsRelations = relations(organizations, ({ many }) => ({
  users: many(users),
  projects: many(projects),
}));

// ─── Users ───────────────────────────────────────────────

export const users = pgTable(
  "users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id").references(() => organizations.id, { onDelete: "cascade" }),
    email: varchar("email", { length: 255 }).notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    passwordHash: varchar("password_hash", { length: 255 }),
    ssoSubject: varchar("sso_subject", { length: 500 }),
    role: userRoleEnum("role").default("member").notNull(),
    isActive: boolean("is_active").default(true).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("users_org_email_idx").on(table.orgId, table.email),
    uniqueIndex("users_org_sso_subject_idx").on(table.orgId, table.ssoSubject),
  ]
);

export const usersRelations = relations(users, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [users.orgId],
    references: [organizations.id],
  }),
  appPermissions: many(appPermissions),
  createdProjects: many(projects),
  createdApps: many(apps),
}));

// ─── Projects ────────────────────────────────────────────

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 255 }).notNull(),
    slug: varchar("slug", { length: 100 }).notNull(),
    description: text("description"),
    icon: text("icon"),
    designSystem: jsonb("design_system"),
    config: jsonb("config"),
    createdBy: uuid("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [uniqueIndex("projects_org_slug_idx").on(table.orgId, table.slug)]
);

export const projectsRelations = relations(projects, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [projects.orgId],
    references: [organizations.id],
  }),
  creator: one(users, {
    fields: [projects.createdBy],
    references: [users.id],
  }),
  apps: many(apps),
}));

// ─── Apps ────────────────────────────────────────────────

export const apps = pgTable("apps", {
  id: uuid("id").defaultRandom().primaryKey(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  type: appTypeEnum("type").notNull(),
  name: varchar("name", { length: 255 }).notNull(),
  description: varchar("description"),
  icon: text("icon"),
  config: jsonb("config"),
  createdBy: uuid("created_by").references(() => users.id, {
    onDelete: "set null",
  }),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const appsRelations = relations(apps, ({ one, many }) => ({
  project: one(projects, {
    fields: [apps.projectId],
    references: [projects.id],
  }),
  creator: one(users, {
    fields: [apps.createdBy],
    references: [users.id],
  }),
  permissions: many(appPermissions),
}));

// ─── App Permissions ─────────────────────────────────────

export const appPermissions = pgTable(
  "app_permissions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    appId: uuid("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    permission: permissionEnum("permission").notNull(),
    grantedBy: uuid("granted_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("app_permissions_user_app_idx").on(table.userId, table.appId),
  ]
);

export const appPermissionsRelations = relations(
  appPermissions,
  ({ one }) => ({
    user: one(users, {
      fields: [appPermissions.userId],
      references: [users.id],
    }),
    app: one(apps, {
      fields: [appPermissions.appId],
      references: [apps.id],
    }),
    granter: one(users, {
      fields: [appPermissions.grantedBy],
      references: [users.id],
      relationName: "grantedPermissions",
    }),
  })
);

// ─── API Keys (existing table, updated) ──────────────────

export const apiKeys = pgTable("api_keys", {
  id: serial("id").primaryKey(),
  projectId: varchar("project_id", { length: 255 }).notNull(),
  orgId: uuid("org_id").references(() => organizations.id, {
    onDelete: "set null",
  }),
  keyHash: varchar("key_hash", { length: 255 }).notNull(),
  keyPrefix: varchar("key_prefix", { length: 20 }).notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  createdBy: varchar("created_by", { length: 255 }),
  description: varchar("description", { length: 500 }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
}, (table) => [
  // At most one ACTIVE API key per project. Revoked rows (is_active = false)
  // stay for history, so revoke→create rotation works. Replaces the need for a
  // full UNIQUE(project_id) constraint, which would block rotation.
  uniqueIndex("idx_api_keys_active")
    .on(table.projectId)
    .where(sql`${table.isActive} = true`),
]);

export const apiKeysRelations = relations(apiKeys, ({ one }) => ({
  organization: one(organizations, {
    fields: [apiKeys.orgId],
    references: [organizations.id],
  }),
}));

// ─── SSO Configs ────────────────────────────────────────

export const ssoConfigs = pgTable("sso_configs", {
  id: uuid("id").defaultRandom().primaryKey(),
  orgId: uuid("org_id")
    .notNull()
    .unique()
    .references(() => organizations.id, { onDelete: "cascade" }),
  provider: ssoProviderEnum("provider").notNull(),
  protocol: varchar("protocol", { length: 10 }).default("oidc").notNull(),
  // OIDC fields (nullable — not used for SAML configs)
  clientId: varchar("client_id", { length: 500 }),
  clientSecret: text("client_secret"),
  issuerUrl: varchar("issuer_url", { length: 1000 }),
  scopes: varchar("scopes", { length: 500 }).default("openid email profile"),
  // SAML fields (nullable — not used for OIDC configs)
  samlIdpEntityId: varchar("saml_idp_entity_id", { length: 1000 }),
  samlIdpSsoUrl: varchar("saml_idp_sso_url", { length: 1000 }),
  samlIdpCertificates: jsonb("saml_idp_certificates"),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const ssoConfigsRelations = relations(ssoConfigs, ({ one }) => ({
  organization: one(organizations, {
    fields: [ssoConfigs.orgId],
    references: [organizations.id],
  }),
}));

// ─── Analytics Status Enum ──────────────────────────────

export const analyticsStatusEnum = pgEnum("analytics_status", [
  "success",
  "error",
  "aborted",
]);

// One row shape covers chat, dashboard-agent, and report-generation usage —
// `type` is the discriminator; the fields specific to one type (threadId/
// messageIndex/question for chat, appId for dashboard/report) are nullable
// and only populated for their own type. Kept as one table with one
// ingest/query path rather than per-type tables so all three can be
// queried/filtered together via a single `type` param instead of juggling
// separate endpoints.
export const analyticsTypeEnum = pgEnum("analytics_type", [
  "chat_agent",
  "dashboard",
  "report",
]);

// ─── Chat Analytics ─────────────────────────────────────

export const chatAnalytics = pgTable(
  "chat_analytics",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    type: analyticsTypeEnum("type").notNull().default("chat_agent"),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    orgId: uuid("org_id")
      .references(() => organizations.id, { onDelete: "set null" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    // Chat-only grouping fields — null for dashboard/report rows, which group
    // by appId instead (see below).
    threadId: varchar("thread_id", { length: 255 }),
    messageIndex: integer("message_index"),
    question: text("question"),
    sourcesUsed: jsonb("sources_used"), // [{ sourceId, sourceName, sourceType }]
    sqlGenerated: text("sql_generated"),
    // Dashboard-agent / report-generation identifier — null for chat rows.
    // One column for both, not separate dashboardId/reportId, since both are
    // just "apps" (see appTypeEnum above — dashboard/report/chat_agent/app
    // are all app types already).
    appId: varchar("app_id", { length: 255 }),
    // Row id of the saved conversation in the main backend's OWN Postgres
    // (user_conversations / dashboard_agent_conversations / reports_conversations
    // — a different database this service has no connection to, hence no FK).
    // Nullable/optional: older SDK versions won't send it.
    conversationId: integer("conversation_id"),
    model: varchar("model", { length: 255 }).notNull(),
    inputTokens: integer("input_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
    cost: numeric("cost", { precision: 12, scale: 6 }).notNull(),
    latencyMs: integer("latency_ms").notNull(),
    status: analyticsStatusEnum("status").notNull(),
    errorMessage: text("error_message"),
    feedback: varchar("feedback", { length: 50 }), // 'thumbs_up' | 'thumbs_down' | null
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("chat_analytics_type_idx").on(table.type),
    index("chat_analytics_app_id_idx").on(table.appId),
    index("chat_analytics_conversation_id_idx").on(table.conversationId),
    index("chat_analytics_user_id_idx").on(table.userId),
    index("chat_analytics_org_id_idx").on(table.orgId),
    index("chat_analytics_project_id_idx").on(table.projectId),
    index("chat_analytics_created_at_idx").on(table.createdAt),
    index("chat_analytics_model_idx").on(table.model),
    index("chat_analytics_status_idx").on(table.status),
  ]
);

export const chatAnalyticsRelations = relations(chatAnalytics, ({ one }) => ({
  user: one(users, {
    fields: [chatAnalytics.userId],
    references: [users.id],
  }),
  organization: one(organizations, {
    fields: [chatAnalytics.orgId],
    references: [organizations.id],
  }),
  project: one(projects, {
    fields: [chatAnalytics.projectId],
    references: [projects.id],
  }),
}));
