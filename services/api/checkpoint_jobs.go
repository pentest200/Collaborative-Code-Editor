package main

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

// A durable PostgreSQL claim survives process loss. Attempt fencing protects
// metadata publication after a lease expires; deterministic object bytes/keys
// make partial uploads and ambiguous completion safe to retry.
func (a *App) materializeNext(ctx context.Context) (bool, error) {
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer tx.Rollback(ctx)
	var project, id string
	var attempt int64
	err = tx.QueryRow(ctx, `WITH candidate AS (
  SELECT id FROM checkpoints WHERE state='captured' OR (state='materializing' AND lease_expires_at<clock_timestamp())
  ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
  UPDATE checkpoints c SET state='materializing',attempt=attempt+1,lease_expires_at=clock_timestamp()+interval '5 minutes',failure_code=NULL
  FROM candidate WHERE c.id=candidate.id RETURNING c.id::text,c.project_id::text,c.attempt`).Scan(&id, &project, &attempt)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	_, err = tx.Exec(ctx, `UPDATE outbox_events SET state='processing' WHERE operation_id=$1 AND topic='checkpoint.materialize'`, id)
	if err == nil {
		err = addCheckpointLifecycle(ctx, tx, project, id, "checkpoint.materializing", attempt)
	}
	if err == nil {
		err = tx.Commit(ctx)
	}
	if err != nil {
		return false, err
	}
	task, cancel := context.WithTimeout(ctx, 4*time.Minute)
	defer cancel()
	err = a.materializeCheckpoint(task, project, id, attempt)
	if err != nil {
		// A failed database write can leave materializing; lease takeover retries.
		failureCtx, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		_, _ = a.db.Exec(failureCtx, `WITH failed AS (UPDATE checkpoints SET state='failed',failure_code='MATERIALIZATION_FAILED',lease_expires_at=NULL
			WHERE id=$1 AND attempt=$2 AND state='materializing' RETURNING id,project_id,attempt),
   marked AS (UPDATE outbox_events SET state='failed' WHERE operation_id IN (SELECT id FROM failed) AND topic='checkpoint.materialize' RETURNING id)
   INSERT INTO outbox_events(operation_id,topic,payload) SELECT gen_random_uuid(),'checkpoint.failed',jsonb_build_object('checkpoint_id',id,'project_id',project_id,'attempt',attempt) FROM failed`, id, attempt)
	}
	return true, err
}

func (a *App) materializeCheckpoint(ctx context.Context, project, id string, attempt int64) (resultErr error) {
	ctx, finish := operation(ctx, "checkpoint.materialize")
	defer func() { finish(resultErr) }()
	tx, err := a.db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return err
	}
	_, manifest, _, err := loadCheckpoint(ctx, tx, project, id)
	_ = tx.Rollback(ctx)
	if err != nil {
		return err
	}
	if a.artifacts == nil {
		return errors.New("artifact storage unavailable")
	}
	total := 0
	assetTotal := 0
	for i := range manifest.Files {
		file := &manifest.Files[i]
		var output struct {
			Text string `json:"text"`
		}
		var data []byte
		if file.Asset {
			var expected []byte
			if err = a.db.QueryRow(ctx, `SELECT data,checksum FROM file_assets WHERE document_id=$1`, file.DocumentID).Scan(&data, &expected); err != nil {
				return err
			}
			if checksum(data) != hex.EncodeToString(expected) {
				return errCheckpointCorrupt
			}
			assetTotal += len(data)
			if len(data) > maxAssetBytes || assetTotal > maxProjectAssetBytes {
				return errors.New("captured asset limit exceeded")
			}
		} else {
			if err = a.internalCheckpoint(ctx, "materialize", map[string]string{"project_id": project, "checkpoint_id": id, "file_id": file.FileID}, &output); err != nil {
				return err
			}
			data = []byte(output.Text)
			total += len(data)
			if len(data) > 262144 || total > 10<<20 {
				return errors.New("captured source limit exceeded")
			}
		}
		file.ArtifactKey = checkpointKey(project, id, file.FileID)
		file.Checksum = checksum(data)
		file.TextBytes = len(data)
		if err = a.artifacts.Put(ctx, file.ArtifactKey, data); err != nil {
			return err
		}
		if _, err = a.verifiedFile(ctx, project, id, *file); err != nil {
			return err
		}
	}
	data, err := json.Marshal(manifest)
	if err != nil {
		return err
	}
	key := manifestKey(project, id)
	if err = a.artifacts.Put(ctx, key, data); err != nil {
		return err
	}
	verified, err := a.artifacts.Get(ctx, key, maxCheckpointManifestBytes)
	if err != nil {
		return err
	}
	if checksum(verified) != checksum(data) {
		return errCheckpointCorrupt
	}
	tx, err = a.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var current int64
	var state string
	err = tx.QueryRow(ctx, `SELECT attempt,state FROM checkpoints WHERE id=$1 FOR UPDATE`, id).Scan(&current, &state)
	if err != nil {
		return err
	}
	if current != attempt || state != "materializing" {
		return errors.New("materializer claim replaced")
	}
	for _, file := range manifest.Files {
		hash, _ := hex.DecodeString(file.Checksum)
		if _, err = tx.Exec(ctx, `UPDATE checkpoint_files SET artifact_key=$3,checksum=$4,text_bytes=$5 WHERE checkpoint_id=$1 AND file_id=$2`, id, file.FileID, file.ArtifactKey, hash, file.TextBytes); err != nil {
			return err
		}
	}
	hash, _ := hex.DecodeString(checksum(data))
	_, err = tx.Exec(ctx, `UPDATE checkpoints SET state='ready',manifest_key=$2,manifest_checksum=$3,lease_expires_at=NULL,failure_code=NULL WHERE id=$1`, id, key, hash)
	if err == nil {
		_, err = tx.Exec(ctx, `UPDATE outbox_events SET state='done' WHERE operation_id=$1 AND topic='checkpoint.materialize'`, id)
	}
	if err == nil {
		err = addCheckpointLifecycle(ctx, tx, project, id, "checkpoint.ready", attempt)
	}
	if err == nil {
		err = tx.Commit(ctx)
	}
	return err
}

func (a *App) runCheckpointJobs(ctx context.Context) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			for ctx.Err() == nil {
				worked, err := a.materializeNext(ctx)
				if err != nil || !worked {
					break
				}
			}
		}
	}
}
