BEGIN;

-- Existing root siblings are covered by active_sibling_name (NULLS NOT DISTINCT).
ALTER TABLE files ADD CONSTRAINT file_name_bytes CHECK (octet_length(name) BETWEEN 1 AND 255);
ALTER TABLE files ADD CONSTRAINT file_language_shape CHECK ((kind='folder' AND language IS NULL) OR (kind='file' AND language IS NOT NULL));

CREATE OR REPLACE FUNCTION validate_active_file_tree() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  item record;
  parent record;
  cursor_id uuid;
  level_count integer;
  path_bytes integer;
  seen uuid[];
BEGIN
  -- Check the changed node and its descendants after the entire transaction.
  FOR item IN WITH RECURSIVE subtree AS (
    SELECT id,ARRAY[id] AS seen FROM files WHERE id=NEW.id
    UNION ALL
    SELECT child.id,array_append(s.seen,child.id) FROM files child JOIN subtree s ON child.parent_id=s.id
    WHERE child.project_id=NEW.project_id AND NOT child.id=ANY(s.seen)
  ) SELECT f.* FROM files f JOIN subtree s ON s.id=f.id LOOP
    IF item.tombstoned_at IS NOT NULL THEN CONTINUE; END IF;
    IF item.kind='file' AND NOT EXISTS (
      SELECT 1 FROM documents d WHERE d.id=item.current_document_id
      AND d.file_id=item.id AND d.generation=item.generation
    ) THEN RAISE EXCEPTION 'active file requires its current document generation'; END IF;
    cursor_id := item.id;
    level_count := 0;
    path_bytes := 0;
    seen := ARRAY[]::uuid[];
    WHILE cursor_id IS NOT NULL LOOP
      IF cursor_id=ANY(seen) THEN RAISE EXCEPTION 'file tree cycle'; END IF;
      seen := array_append(seen,cursor_id);
      SELECT id,project_id,parent_id,name,kind,tombstoned_at INTO parent FROM files WHERE id=cursor_id;
      IF NOT FOUND OR parent.project_id<>item.project_id OR parent.tombstoned_at IS NOT NULL THEN
        RAISE EXCEPTION 'invalid active file parent';
      END IF;
      IF cursor_id<>item.id AND parent.kind<>'folder' THEN RAISE EXCEPTION 'parent must be a folder'; END IF;
      path_bytes := path_bytes + octet_length(parent.name) + CASE WHEN cursor_id=item.id THEN 0 ELSE 1 END;
      IF path_bytes>1024 THEN RAISE EXCEPTION 'file path too long'; END IF;
      IF parent.kind='folder' THEN level_count := level_count+1; END IF;
      IF level_count>16 THEN RAISE EXCEPTION 'folder depth exceeded'; END IF;
      cursor_id := parent.parent_id;
    END LOOP;
  END LOOP;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER active_file_tree_guard
AFTER INSERT OR UPDATE OF parent_id,name,tombstoned_at,current_document_id,generation ON files
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_active_file_tree();

INSERT INTO schema_migrations(version) VALUES ('0003_file_tree');
COMMIT;
