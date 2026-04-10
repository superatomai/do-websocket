import {
  pgTable,
  uuid,
  varchar,
  text,
  boolean,
  timestamp,
  jsonb,
  serial,
  pgEnum,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

// ─── Enums ───────────────────────────────────────────────

export const userRoleEnum = pgEnum("user_role", ["super_admin", "org_admin", "member"]);

export const appTypeEnum = pgEnum("app_type", [
  "dashboard",
  "app",
  "report",
  "chat_agent",
]);

export const projectPermissionEnum = pgEnum("project_permission", [
  "view",
  "edit",
]);

// Kept for backward compatibility — no longer used by routes
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
  defaultAppId: uuid("default_app_id"), // Kept for backward compatibility — no longer used by routes
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
    email: varchar("email", { length: 255 }).unique().notNull(),
    username: varchar("username", { length: 100 }).unique(),
    name: varchar("name", { length: 255 }).notNull(),
    passwordHash: varchar("password_hash", { length: 255 }),
    ssoSubject: varchar("sso_subject", { length: 500 }),
    role: userRoleEnum("role").default("member").notNull(),
    isActive: boolean("is_active").default(true).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [uniqueIndex("users_org_sso_subject_idx").on(table.orgId, table.ssoSubject)]
);

export const usersRelations = relations(users, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [users.orgId],
    references: [organizations.id],
  }),
  appPermissions: many(appPermissions), // Kept for backward compatibility
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
    members: jsonb("members").default([]).$type<
      Array<{
        userId: string;
        permission: "view" | "edit";
        grantedBy: string;
        grantedAt: string;
      }>
    >(),
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
  permissions: many(appPermissions), // Kept for backward compatibility
}));

// ─── App Permissions (kept for backward compatibility — no longer used by routes) ───

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
});

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
