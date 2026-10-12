package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"time"
)

// Retry cleanup from persisted inventory after project deletion/API restart.
func (a *App) runWorkspaceJanitor(ctx context.Context) {
	if a.cfg.WorkspaceToken == "" {
		return
	}
	tick := time.NewTicker(time.Minute)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
			response, err := a.workspaceRequest(ctx, "GET", "/projects", nil)
			if err != nil {
				continue
			}
			var ids []string
			err = json.NewDecoder(io.LimitReader(response.Body, 8192)).Decode(&ids)
			response.Body.Close()
			if err != nil {
				continue
			}
			for _, id := range ids {
				if !validUUID(id) {
					continue
				}
				var active bool
				err = a.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM projects WHERE id=$1 AND lifecycle_state='active')`, id).Scan(&active)
				if err != nil || active {
					continue
				}
				response, err = a.workspaceRequest(ctx, "GET", "/projects/"+id, nil)
				if err != nil {
					continue
				}
				var config struct {
					Language   string `json:"language"`
					Root       string `json:"root"`
					Entrypoint string `json:"entrypoint"`
				}
				err = json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&config)
				response.Body.Close()
				if err != nil {
					continue
				}
				body, _ := json.Marshal(map[string]string{"action": "stop", "language": config.Language, "root": config.Root, "entrypoint": config.Entrypoint})
				if response, err = a.workspaceRequest(ctx, "PUT", "/projects/"+id, bytes.NewReader(body)); err == nil {
					response.Body.Close()
				}
				if response, err = a.workspaceRequest(ctx, "DELETE", "/projects/"+id, nil); err == nil {
					response.Body.Close()
				}
			}
		}
	}
}
