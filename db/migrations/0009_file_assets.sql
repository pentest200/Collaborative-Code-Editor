BEGIN;

-- Asset generations share file/document identities with the existing tree and
-- checkpoint cut, but preserve original bytes instead of using collaborative text.
CREATE TABLE file_assets (
  document_id uuid PRIMARY KEY REFERENCES documents(id),
  data bytea NOT NULL CHECK (octet_length(data) <= 26214400),
  media_type text NOT NULL CHECK (octet_length(media_type) BETWEEN 1 AND 128),
  checksum bytea NOT NULL CHECK (octet_length(checksum)=32),
  byte_size integer GENERATED ALWAYS AS (octet_length(data)) STORED
);
CREATE FUNCTION immutable_file_asset() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'FILE_ASSET_IMMUTABLE'; END $$;
CREATE TRIGGER file_asset_immutable BEFORE UPDATE OR DELETE ON file_assets
FOR EACH ROW EXECUTE FUNCTION immutable_file_asset();

CREATE FUNCTION reject_asset_document_updates() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM public.file_assets WHERE document_id=NEW.document_id) THEN
    RAISE EXCEPTION 'FILE_ASSET_NOT_COLLABORATIVE';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION reject_asset_document_updates() FROM PUBLIC;
CREATE TRIGGER asset_document_readonly BEFORE INSERT ON document_updates
FOR EACH ROW EXECUTE FUNCTION reject_asset_document_updates();

ALTER TABLE checkpoint_files DROP CONSTRAINT checkpoint_files_text_bytes_check;
ALTER TABLE checkpoint_files ADD CONSTRAINT checkpoint_files_text_bytes_check
CHECK (text_bytes BETWEEN 0 AND 26214400);
INSERT INTO schema_migrations(version) VALUES('0009_file_assets');
COMMIT;
