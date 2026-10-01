-- Canonical PostgreSQL 18 migration source. Apply once, in order, with psql -v ON_ERROR_STOP=1.
BEGIN;

CREATE TABLE schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL CHECK (provider = 'github'),
  provider_subject text NOT NULL,
  display_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_subject)
);

CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  tree_version bigint NOT NULL DEFAULT 0 CHECK (tree_version >= 0),
  event_sequence bigint NOT NULL DEFAULT 0 CHECK (event_sequence >= 0),
  lifecycle_state text NOT NULL DEFAULT 'active' CHECK (lifecycle_state IN ('active','deleted')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE project_members (
  project_id uuid NOT NULL REFERENCES projects(id),
  user_id uuid NOT NULL REFERENCES users(id),
  role text NOT NULL CHECK (role IN ('owner','editor','viewer')),
  PRIMARY KEY (project_id,user_id)
);
CREATE UNIQUE INDEX one_owner_per_project ON project_members(project_id) WHERE role = 'owner';

CREATE TABLE project_invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id),
  token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  role text NOT NULL CHECK (role IN ('editor','viewer')),
  expires_at timestamptz NOT NULL,
  max_uses integer NOT NULL CHECK (max_uses BETWEEN 1 AND 100),
  used_count integer NOT NULL DEFAULT 0 CHECK (used_count >= 0 AND used_count <= max_uses),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id),
  parent_id uuid,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 255),
  kind text NOT NULL CHECK (kind IN ('file','folder')),
  language text,
  current_document_id uuid,
  generation bigint NOT NULL DEFAULT 1 CHECK (generation > 0),
  tombstoned_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id,project_id),
  FOREIGN KEY (parent_id,project_id) REFERENCES files(id,project_id),
  CHECK ((kind = 'folder' AND current_document_id IS NULL) OR kind = 'file'),
  CHECK (parent_id IS DISTINCT FROM id)
);
-- PostgreSQL NULLS NOT DISTINCT makes root sibling names unique too.
CREATE UNIQUE INDEX active_sibling_name ON files(project_id,parent_id,name) NULLS NOT DISTINCT WHERE tombstoned_at IS NULL;

CREATE TABLE documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  file_id uuid NOT NULL REFERENCES files(id),
  generation bigint NOT NULL CHECK (generation > 0),
  last_committed_sequence bigint NOT NULL DEFAULT 0 CHECK (last_committed_sequence >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (file_id,generation),
  UNIQUE (id,file_id)
);
ALTER TABLE files ADD CONSTRAINT current_document_belongs_to_file
  FOREIGN KEY (current_document_id,id) REFERENCES documents(id,file_id) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE document_updates (
  document_id uuid NOT NULL REFERENCES documents(id),
  sequence bigint NOT NULL CHECK (sequence > 0),
  actor_id uuid NOT NULL REFERENCES users(id),
  client_instance_id uuid NOT NULL,
  message_id uuid NOT NULL,
  update_hash bytea NOT NULL CHECK (octet_length(update_hash) = 32),
  update_bytes bytea NOT NULL CHECK (octet_length(update_bytes) BETWEEN 1 AND 524288),
  committed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id,sequence),
  UNIQUE (document_id,client_instance_id,message_id)
);

CREATE TABLE document_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES documents(id),
  through_sequence bigint NOT NULL CHECK (through_sequence >= 0),
  encoded_state bytea NOT NULL CHECK (octet_length(encoded_state) <= 2097152),
  state_vector bytea NOT NULL CHECK (octet_length(state_vector) <= 65536),
  checksum bytea NOT NULL CHECK (octet_length(checksum) = 32),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id,through_sequence)
);

CREATE TABLE document_owners (
  document_id uuid PRIMARY KEY REFERENCES documents(id),
  worker_id uuid NOT NULL,
  fencing_token bigint NOT NULL CHECK (fencing_token > 0),
  lease_expires_at timestamptz NOT NULL
);

CREATE TABLE project_events (
  project_id uuid NOT NULL REFERENCES projects(id),
  sequence bigint NOT NULL CHECK (sequence > 0),
  event_type text NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id,sequence)
);

CREATE TABLE checkpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id),
  creator_id uuid NOT NULL REFERENCES users(id),
  name text NOT NULL,
  state text NOT NULL CHECK (state IN ('captured','materializing','ready','failed')),
  captured_tree_version bigint NOT NULL CHECK (captured_tree_version >= 0),
  manifest_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id,project_id)
);

CREATE TABLE checkpoint_files (
  checkpoint_id uuid NOT NULL REFERENCES checkpoints(id),
  file_id uuid NOT NULL REFERENCES files(id),
  path text NOT NULL,
  language text,
  document_id uuid NOT NULL REFERENCES documents(id),
  through_sequence bigint NOT NULL CHECK (through_sequence >= 0),
  artifact_key text,
  checksum bytea CHECK (checksum IS NULL OR octet_length(checksum) = 32),
  PRIMARY KEY (checkpoint_id,file_id)
);

CREATE TABLE run_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id),
  actor_id uuid NOT NULL REFERENCES users(id),
  checkpoint_id uuid NOT NULL REFERENCES checkpoints(id),
  idempotency_key uuid NOT NULL,
  runtime text NOT NULL CHECK (runtime IN ('python','javascript')),
  entrypoint text NOT NULL,
  stdin bytea NOT NULL DEFAULT ''::bytea CHECK (octet_length(stdin) <= 16384),
  state text NOT NULL CHECK (state IN ('capturing','queued','running','succeeded','failed','timed_out','cancelled')),
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  lease_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id,actor_id,idempotency_key)
);

CREATE TABLE run_events (
  job_id uuid NOT NULL REFERENCES run_jobs(id),
  sequence bigint NOT NULL CHECK (sequence > 0),
  kind text NOT NULL CHECK (kind IN ('stdout','stderr','status')),
  payload bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (job_id,sequence)
);

CREATE TABLE outbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id uuid NOT NULL UNIQUE,
  topic text NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','processing','done','failed')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE search_documents (
  file_id uuid PRIMARY KEY REFERENCES files(id),
  project_id uuid NOT NULL REFERENCES projects(id),
  document_id uuid NOT NULL REFERENCES documents(id),
  through_sequence bigint NOT NULL CHECK (through_sequence >= 0),
  filename text NOT NULL,
  content text NOT NULL,
  indexed_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO schema_migrations(version) VALUES ('0001_foundation');
COMMIT;
