-- Add protocol column to distinguish OIDC vs SAML configs
ALTER TABLE sso_configs ADD COLUMN protocol varchar(10) DEFAULT 'oidc' NOT NULL;

-- Add SAML-specific columns
ALTER TABLE sso_configs ADD COLUMN saml_idp_entity_id varchar(1000);
ALTER TABLE sso_configs ADD COLUMN saml_idp_sso_url varchar(1000);
ALTER TABLE sso_configs ADD COLUMN saml_idp_certificates jsonb;

-- Make OIDC columns nullable (they're not needed for SAML configs)
ALTER TABLE sso_configs ALTER COLUMN client_id DROP NOT NULL;
ALTER TABLE sso_configs ALTER COLUMN client_secret DROP NOT NULL;
ALTER TABLE sso_configs ALTER COLUMN issuer_url DROP NOT NULL;

-- Add 'saml' to the sso_provider enum
ALTER TYPE sso_provider ADD VALUE 'saml';
