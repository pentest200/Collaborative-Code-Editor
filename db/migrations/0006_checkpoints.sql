BEGIN;

ALTER TABLE checkpoints ADD COLUMN captured_tree jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(captured_tree)='array');
ALTER TABLE checkpoints ADD COLUMN manifest_checksum bytea CHECK (octet_length(manifest_checksum)=32);
ALTER TABLE checkpoints ADD COLUMN failure_code text;
ALTER TABLE checkpoints ADD COLUMN attempt bigint NOT NULL DEFAULT 0;
ALTER TABLE checkpoints ADD COLUMN lease_expires_at timestamptz;
ALTER TABLE checkpoint_files ADD COLUMN snapshot_id uuid REFERENCES document_snapshots(id);
ALTER TABLE checkpoint_files ADD COLUMN snapshot_sequence bigint CHECK (snapshot_sequence>=0);
ALTER TABLE checkpoint_files ADD COLUMN snapshot_checksum bytea CHECK (octet_length(snapshot_checksum)=32);
ALTER TABLE checkpoint_files ADD COLUMN text_bytes integer CHECK (text_bytes BETWEEN 0 AND 262144);
ALTER TABLE checkpoint_files ADD CONSTRAINT checkpoint_snapshot_cut CHECK (snapshot_sequence<=through_sequence);
CREATE INDEX checkpoint_work ON checkpoints(state,lease_expires_at,created_at) WHERE state IN ('captured','materializing');

-- Immutable references may outlive the active generation. The private TS
-- authority already has retained snapshot/update SELECT capability; it gets
-- only captured input SELECT, never metadata writes or artifact credentials.
GRANT SELECT ON checkpoint_files,checkpoints TO cce_collab;

INSERT INTO schema_migrations(version) VALUES('0006_checkpoints');
COMMIT;
