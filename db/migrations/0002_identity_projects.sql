BEGIN;

ALTER TABLE sessions ADD COLUMN csrf_hash bytea NOT NULL CHECK (octet_length(csrf_hash) = 32);

CREATE TABLE oauth_flows (
  state_hash bytea PRIMARY KEY CHECK (octet_length(state_hash) = 32),
  binding_hash bytea NOT NULL CHECK (octet_length(binding_hash) = 32),
  code_verifier text NOT NULL CHECK (char_length(code_verifier) BETWEEN 43 AND 128),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX oauth_flows_expiry ON oauth_flows(expires_at);

-- An owner membership is mandatory and its role must match projects.owner_id.
-- Deferred validation permits project and membership creation in one transaction.
ALTER TABLE project_members ADD CONSTRAINT project_member_role_key UNIQUE (project_id,user_id,role);
ALTER TABLE projects ADD COLUMN owner_role text NOT NULL DEFAULT 'owner' CHECK (owner_role = 'owner');
ALTER TABLE projects ADD CONSTRAINT project_owner_membership
  FOREIGN KEY (id,owner_id,owner_role)
  REFERENCES project_members(project_id,user_id,role)
  DEFERRABLE INITIALLY DEFERRED;

INSERT INTO schema_migrations(version) VALUES ('0002_identity_projects');
COMMIT;
