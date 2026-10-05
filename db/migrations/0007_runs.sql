BEGIN;
ALTER TABLE run_jobs ADD CONSTRAINT run_checkpoint_scope FOREIGN KEY(checkpoint_id,project_id) REFERENCES checkpoints(id,project_id);
ALTER TABLE run_jobs ADD COLUMN request_hash bytea NOT NULL DEFAULT decode(repeat('00',32),'hex') CHECK(octet_length(request_hash)=32);
ALTER TABLE run_jobs ADD COLUMN cancel_requested boolean NOT NULL DEFAULT false;
ALTER TABLE run_jobs ADD COLUMN event_sequence bigint NOT NULL DEFAULT 0 CHECK(event_sequence>=0);
ALTER TABLE run_jobs ADD COLUMN output_bytes integer NOT NULL DEFAULT 0 CHECK(output_bytes BETWEEN 0 AND 65536);
ALTER TABLE run_jobs ADD COLUMN output_sequence bigint NOT NULL DEFAULT 0 CHECK(output_sequence>=0);
ALTER TABLE run_jobs ADD COLUMN truncated boolean NOT NULL DEFAULT false;
ALTER TABLE run_jobs ADD COLUMN exit_code integer;
ALTER TABLE run_jobs ADD COLUMN failure_code text;
ALTER TABLE run_jobs ADD COLUMN claim_token uuid;
ALTER TABLE run_jobs ADD COLUMN finished_at timestamptz;
CREATE UNIQUE INDEX one_active_run_per_actor ON run_jobs(actor_id) WHERE state IN ('capturing','queued','running');
CREATE UNIQUE INDEX one_active_run_per_project ON run_jobs(project_id) WHERE state IN ('capturing','queued','running');
CREATE INDEX run_queue ON run_jobs(created_at) WHERE state IN ('capturing','queued','running');
ALTER TABLE run_events ADD CONSTRAINT bounded_run_event CHECK(octet_length(payload)<=65536);
ALTER TABLE run_events ADD COLUMN runner_sequence bigint;
CREATE UNIQUE INDEX run_output_receipts ON run_events(job_id,runner_sequence) WHERE runner_sequence IS NOT NULL;
CREATE FUNCTION cce_guard_run() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.state IN ('succeeded','failed','timed_out','cancelled') AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'RUN_TERMINAL'; END IF;
 IF (NEW.project_id,NEW.actor_id,NEW.checkpoint_id,NEW.idempotency_key,NEW.runtime,NEW.entrypoint,NEW.stdin,NEW.request_hash)
 IS DISTINCT FROM (OLD.project_id,OLD.actor_id,OLD.checkpoint_id,OLD.idempotency_key,OLD.runtime,OLD.entrypoint,OLD.stdin,OLD.request_hash) THEN RAISE EXCEPTION 'RUN_INPUT_IMMUTABLE'; END IF;
 IF NEW.state<>OLD.state AND NOT (
   (OLD.state='capturing' AND NEW.state IN ('queued','failed','cancelled')) OR
   (OLD.state='queued' AND NEW.state IN ('running','failed','cancelled')) OR
   (OLD.state='running' AND NEW.state IN ('succeeded','failed','timed_out','cancelled'))
 ) THEN RAISE EXCEPTION 'RUN_STATE_INVALID'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_run BEFORE UPDATE ON run_jobs FOR EACH ROW EXECUTE FUNCTION cce_guard_run();
INSERT INTO schema_migrations(version) VALUES('0007_runs');
COMMIT;
