BEGIN;

-- One coalesced durable task per stable file. Edits during a claim increase
-- revision without replacing its identity; publication completes only its cut.
CREATE TABLE search_tasks (
  file_id uuid PRIMARY KEY REFERENCES files(id),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  done_revision bigint NOT NULL DEFAULT 0 CHECK (done_revision >= 0 AND done_revision <= revision),
  claim_id uuid,
  lease_expires_at timestamptz,
  retry_at timestamptz NOT NULL DEFAULT now(),
  failure_code text CHECK (failure_code IS NULL OR failure_code='PROJECTION_FAILED')
);
CREATE INDEX search_tasks_pending ON search_tasks(retry_at) WHERE revision > done_revision;
CREATE INDEX search_project ON search_documents(project_id);
ALTER TABLE search_documents ADD CONSTRAINT search_content_bound CHECK (octet_length(content)<=262144);
-- PostgreSQL text cannot contain NUL. Keep exact UTF-8 bytes for that case;
-- the matching text uses an unqueryable control-character separator.
ALTER TABLE search_documents ADD COLUMN raw_content bytea CHECK (raw_content IS NULL OR octet_length(raw_content)<=262144);

CREATE FUNCTION enqueue_search_file() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE target uuid;
BEGIN
  IF TG_TABLE_NAME='documents' THEN target := NEW.file_id;
  ELSE target := NEW.id; END IF;
  INSERT INTO search_tasks(file_id) VALUES(target)
  ON CONFLICT(file_id) DO UPDATE SET revision=search_tasks.revision+1,retry_at=clock_timestamp();
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION enqueue_search_file() FROM PUBLIC;
CREATE TRIGGER search_committed_head AFTER UPDATE OF last_committed_sequence ON documents
FOR EACH ROW WHEN (NEW.last_committed_sequence IS DISTINCT FROM OLD.last_committed_sequence)
EXECUTE FUNCTION enqueue_search_file();
CREATE TRIGGER search_generation AFTER UPDATE OF current_document_id ON files
FOR EACH ROW WHEN (NEW.current_document_id IS NOT NULL AND NEW.current_document_id IS DISTINCT FROM OLD.current_document_id)
EXECUTE FUNCTION enqueue_search_file();
-- Existing projects are indexed too. Paths are always read from current metadata.
INSERT INTO search_tasks(file_id) SELECT id FROM files WHERE kind='file' AND tombstoned_at IS NULL;
INSERT INTO schema_migrations(version) VALUES ('0008_search');
COMMIT;
