BEGIN;

-- A non-login capability role. Provision a separate login in the execution
-- environment; never give the collaboration login metadata/table write grants.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='cce_collab') THEN
    CREATE ROLE cce_collab NOLOGIN;
  END IF;
END $$;

ALTER TABLE projects ADD COLUMN durable_log_bytes bigint NOT NULL DEFAULT 0 CHECK (durable_log_bytes>=0);
ALTER TABLE projects ADD COLUMN durable_log_limit bigint NOT NULL DEFAULT 1073741824 CHECK (durable_log_limit BETWEEN 1 AND 1073741824);
ALTER TABLE projects ADD COLUMN source_bytes_limit bigint NOT NULL DEFAULT 10485760 CHECK (source_bytes_limit BETWEEN 1 AND 10485760);
-- A validated size projection, never a second source-content authority.
-- Phase 03's persisted documents are empty (no durable edits existed).
ALTER TABLE documents ADD COLUMN committed_text_bytes integer NOT NULL DEFAULT 0 CHECK (committed_text_bytes BETWEEN 0 AND 262144);
UPDATE projects p SET durable_log_bytes=(SELECT coalesce(sum(octet_length(u.update_bytes)),0)
  FROM document_updates u JOIN documents d ON d.id=u.document_id JOIN files f ON f.id=d.file_id WHERE f.project_id=p.id);
ALTER TABLE document_snapshots ADD CONSTRAINT snapshot_document_identity UNIQUE(id,document_id);
ALTER TABLE documents ADD COLUMN snapshot_id uuid;
ALTER TABLE documents ADD CONSTRAINT snapshot_belongs_to_document FOREIGN KEY(snapshot_id,id)
  REFERENCES document_snapshots(id,document_id);
UPDATE documents d SET snapshot_id=(SELECT id FROM document_snapshots s WHERE s.document_id=d.id
  AND s.through_sequence<=d.last_committed_sequence ORDER BY s.through_sequence DESC LIMIT 1);

-- All append/receipt locks follow metadata's project -> session -> member ->
-- file -> document -> owner order. Project locking also serializes quota use.
CREATE FUNCTION cce_document_guard(p_project uuid,p_file uuid,p_document uuid,p_generation bigint,
  p_actor uuid,p_session uuid,p_worker uuid,p_fence bigint) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE lifecycle text; role_name text; file_row public.files; head bigint; owner_row public.document_owners;
BEGIN
  IF p_worker IS NULL OR p_fence IS NULL OR p_fence<1 THEN RAISE EXCEPTION 'ROOM_MOVED'; END IF;
  SELECT lifecycle_state INTO lifecycle FROM public.projects WHERE id=p_project FOR UPDATE;
  IF lifecycle IS DISTINCT FROM 'active' THEN RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE='P0001'; END IF;
  PERFORM 1 FROM public.sessions WHERE id=p_session AND user_id=p_actor AND revoked_at IS NULL
    AND expires_at>clock_timestamp() FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'AUTH_REQUIRED' USING ERRCODE='P0001'; END IF;
  SELECT role INTO role_name FROM public.project_members WHERE project_id=p_project AND user_id=p_actor FOR SHARE;
  IF role_name IS NULL OR role_name NOT IN ('owner','editor') THEN RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE='P0001'; END IF;
  SELECT * INTO file_row FROM public.files WHERE id=p_file AND project_id=p_project FOR SHARE;
  IF NOT FOUND OR file_row.tombstoned_at IS NOT NULL OR file_row.current_document_id IS DISTINCT FROM p_document
    OR file_row.generation<>p_generation THEN RAISE EXCEPTION 'STALE_GENERATION' USING ERRCODE='P0001'; END IF;
  SELECT last_committed_sequence INTO head FROM public.documents
    WHERE id=p_document AND file_id=p_file AND generation=p_generation FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'STALE_GENERATION' USING ERRCODE='P0001'; END IF;
  SELECT * INTO owner_row FROM public.document_owners WHERE document_id=p_document FOR UPDATE;
  IF NOT FOUND OR owner_row.worker_id<>p_worker OR owner_row.fencing_token<>p_fence
    OR owner_row.lease_expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'ROOM_MOVED' USING ERRCODE='P0001'; END IF;
  RETURN head;
END $$;

CREATE FUNCTION cce_acquire_document(p_document uuid,p_worker uuid) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE fence bigint;
BEGIN
  PERFORM 1 FROM public.documents WHERE id=p_document FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'STALE_GENERATION'; END IF;
  INSERT INTO public.document_owners(document_id,worker_id,fencing_token,lease_expires_at)
    VALUES(p_document,p_worker,1,clock_timestamp()+interval '15 seconds')
    ON CONFLICT(document_id) DO UPDATE SET worker_id=p_worker,
      fencing_token=public.document_owners.fencing_token+1,lease_expires_at=clock_timestamp()+interval '15 seconds'
    WHERE public.document_owners.lease_expires_at<=clock_timestamp()
    RETURNING fencing_token INTO fence;
  IF fence IS NULL THEN RAISE EXCEPTION 'ROOM_MOVED'; END IF;
  RETURN fence;
END $$;

CREATE FUNCTION cce_renew_document(p_document uuid,p_worker uuid,p_fence bigint) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  UPDATE public.document_owners SET lease_expires_at=clock_timestamp()+interval '15 seconds'
    WHERE document_id=p_document AND worker_id=p_worker AND fencing_token=p_fence AND lease_expires_at>clock_timestamp();
  RETURN FOUND;
END $$;

CREATE FUNCTION cce_release_document(p_document uuid,p_worker uuid,p_fence bigint) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  UPDATE public.document_owners SET lease_expires_at=clock_timestamp()
  WHERE document_id=p_document AND worker_id=p_worker AND fencing_token=p_fence;
$$;

CREATE FUNCTION cce_document_receipt(p_project uuid,p_file uuid,p_document uuid,p_generation bigint,
  p_actor uuid,p_session uuid,p_worker uuid,p_fence bigint,p_instance uuid,p_message uuid,p_hash bytea) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE prior public.document_updates;
BEGIN
  IF p_hash IS NULL OR octet_length(p_hash)<>32 THEN RAISE EXCEPTION 'FRAME_INVALID'; END IF;
  PERFORM public.cce_document_guard(p_project,p_file,p_document,p_generation,p_actor,p_session,p_worker,p_fence);
  SELECT * INTO prior FROM public.document_updates WHERE document_id=p_document AND client_instance_id=p_instance AND message_id=p_message;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF prior.actor_id<>p_actor OR prior.update_hash<>p_hash THEN RAISE EXCEPTION 'RECEIPT_MISMATCH'; END IF;
  RETURN prior.sequence;
END $$;

CREATE FUNCTION cce_append_document(p_project uuid,p_file uuid,p_document uuid,p_generation bigint,
  p_actor uuid,p_session uuid,p_worker uuid,p_fence bigint,p_head bigint,p_instance uuid,p_message uuid,p_hash bytea,p_update bytea,p_text_bytes integer) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE head bigint; prior public.document_updates; used_bytes bigint; limit_bytes bigint; source_bytes bigint; source_limit bigint; previous_bytes integer;
BEGIN
  head:=public.cce_document_guard(p_project,p_file,p_document,p_generation,p_actor,p_session,p_worker,p_fence);
  IF octet_length(p_update) NOT BETWEEN 1 AND 524288 OR octet_length(p_hash)<>32 OR sha256(p_update)<>p_hash THEN
    RAISE EXCEPTION 'FRAME_INVALID';
  END IF;
  SELECT * INTO prior FROM public.document_updates WHERE document_id=p_document AND client_instance_id=p_instance AND message_id=p_message;
  IF FOUND THEN
    IF prior.actor_id<>p_actor OR prior.update_hash<>p_hash THEN RAISE EXCEPTION 'RECEIPT_MISMATCH'; END IF;
    RETURN prior.sequence;
  END IF;
  IF p_head IS NULL OR head<>p_head THEN RAISE EXCEPTION 'HEAD_CHANGED'; END IF;
  IF p_text_bytes IS NULL OR p_text_bytes NOT BETWEEN 0 AND 262144 THEN RAISE EXCEPTION 'LIMIT_EXCEEDED'; END IF;
  SELECT committed_text_bytes INTO previous_bytes FROM public.documents WHERE id=p_document;
  SELECT coalesce(sum(d.committed_text_bytes),0) INTO source_bytes FROM public.files f JOIN public.documents d ON d.id=f.current_document_id
    WHERE f.project_id=p_project AND f.tombstoned_at IS NULL;
  SELECT source_bytes_limit INTO source_limit FROM public.projects WHERE id=p_project;
  IF source_bytes-previous_bytes+p_text_bytes>source_limit THEN RAISE EXCEPTION 'LIMIT_EXCEEDED'; END IF;
  SELECT durable_log_bytes,durable_log_limit INTO used_bytes,limit_bytes FROM public.projects WHERE id=p_project;
  IF used_bytes+octet_length(p_update)>limit_bytes OR head=9223372036854775807 THEN RAISE EXCEPTION 'LIMIT_EXCEEDED'; END IF;
  INSERT INTO public.document_updates(document_id,sequence,actor_id,client_instance_id,message_id,update_hash,update_bytes)
    VALUES(p_document,head+1,p_actor,p_instance,p_message,p_hash,p_update);
  UPDATE public.documents SET last_committed_sequence=head+1,committed_text_bytes=p_text_bytes WHERE id=p_document;
  UPDATE public.projects SET durable_log_bytes=durable_log_bytes+octet_length(p_update) WHERE id=p_project;
  RETURN head+1;
END $$;

CREATE FUNCTION cce_publish_snapshot(p_document uuid,p_worker uuid,p_fence bigint,p_sequence bigint,
  p_state bytea,p_vector bytea,p_checksum bytea) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE head bigint; snapshot_uuid uuid;
BEGIN
  SELECT last_committed_sequence INTO head FROM public.documents WHERE id=p_document FOR UPDATE;
  IF head IS NULL OR p_sequence<0 OR p_sequence>head THEN RAISE EXCEPTION 'HEAD_CHANGED'; END IF;
  PERFORM 1 FROM public.document_owners WHERE document_id=p_document AND worker_id=p_worker
    AND fencing_token=p_fence AND lease_expires_at>clock_timestamp() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ROOM_MOVED'; END IF;
  IF sha256(p_state)<>p_checksum THEN RAISE EXCEPTION 'FRAME_INVALID'; END IF;
  INSERT INTO public.document_snapshots(document_id,through_sequence,encoded_state,state_vector,checksum)
    VALUES(p_document,p_sequence,p_state,p_vector,p_checksum) ON CONFLICT(document_id,through_sequence) DO NOTHING;
  SELECT id INTO snapshot_uuid FROM public.document_snapshots WHERE document_id=p_document AND through_sequence=p_sequence;
  UPDATE public.documents SET snapshot_id=snapshot_uuid WHERE id=p_document AND (snapshot_id IS NULL OR
    p_sequence >= (SELECT through_sequence FROM public.document_snapshots WHERE id=public.documents.snapshot_id));
END $$;

REVOKE ALL ON FUNCTION cce_document_guard(uuid,uuid,uuid,bigint,uuid,uuid,uuid,bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION cce_acquire_document(uuid,uuid),cce_renew_document(uuid,uuid,bigint),cce_release_document(uuid,uuid,bigint),
  cce_document_receipt(uuid,uuid,uuid,bigint,uuid,uuid,uuid,bigint,uuid,uuid,bytea),
  cce_append_document(uuid,uuid,uuid,bigint,uuid,uuid,uuid,bigint,bigint,uuid,uuid,bytea,bytea,integer),
  cce_publish_snapshot(uuid,uuid,bigint,bigint,bytea,bytea,bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cce_acquire_document(uuid,uuid),cce_renew_document(uuid,uuid,bigint),cce_release_document(uuid,uuid,bigint),
  cce_document_receipt(uuid,uuid,uuid,bigint,uuid,uuid,uuid,bigint,uuid,uuid,bytea),
  cce_append_document(uuid,uuid,uuid,bigint,uuid,uuid,uuid,bigint,bigint,uuid,uuid,bytea,bytea,integer),
  cce_publish_snapshot(uuid,uuid,bigint,bigint,bytea,bytea,bytea) TO cce_collab;
GRANT USAGE ON SCHEMA public TO cce_collab;
GRANT SELECT ON documents,document_updates,document_snapshots,document_owners,files,project_members TO cce_collab;
GRANT SELECT(id,lifecycle_state) ON projects TO cce_collab;
GRANT SELECT(id,user_id,revoked_at,expires_at) ON sessions TO cce_collab;
INSERT INTO schema_migrations(version) VALUES('0004_document_durability');
COMMIT;
