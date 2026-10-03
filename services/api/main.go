package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func main() {
	cfg, err := loadConfig()
	if err != nil {
		log.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	db, err := pgxpool.New(ctx, cfg.DatabaseURL)
	if err != nil {
		log.Fatal("database configuration failed: ", err)
	}
	defer db.Close()
	if err := db.Ping(ctx); err != nil {
		log.Fatal("database unavailable: ", err)
	}
	app := &App{db: db, cfg: cfg, client: &http.Client{Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
	artifacts, err := newArtifacts(cfg)
	if err != nil {
		log.Fatal(err)
	}
	app.artifacts = artifacts
	if os.Getenv("JOBS_ONLY") == "true" {
		workerCtx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		defer stop()
		bucketCtx, cancelBucket := context.WithTimeout(workerCtx, 10*time.Second)
		err = artifacts.ensureBucket(bucketCtx)
		cancelBucket()
		if err != nil {
			log.Fatal("private artifact bucket unavailable")
		}
		app.client.Timeout = 40 * time.Second
		app.runCheckpointJobs(workerCtx)
		return
	}
	server := &http.Server{
		Addr: cfg.ListenAddr, Handler: app.routes(),
		ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 60 * time.Second,
		MaxHeaderBytes: 16 << 10,
	}
	log.Printf("api listening on %s", cfg.ListenAddr)
	log.Fatal(server.ListenAndServe())
}
