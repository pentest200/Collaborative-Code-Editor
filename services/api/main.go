package main

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)))
	fatal := func(message string) { slog.Error(message); os.Exit(1) }
	cfg, err := loadConfig()
	if err != nil {
		fatal("service configuration failed")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	shutdown, err := initTelemetry(ctx, map[bool]string{true: "cce-jobs", false: "cce-api"}[os.Getenv("JOBS_ONLY") == "true"])
	if err != nil {
		fatal("telemetry configuration failed")
	}
	defer func() {
		end, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		_ = shutdown(end)
	}()
	poolConfig, err := pgxpool.ParseConfig(cfg.DatabaseURL)
	if err != nil {
		fatal("database configuration failed")
	}
	poolConfig.ConnConfig.Tracer = safeQueryTracer{}
	db, err := pgxpool.NewWithConfig(ctx, poolConfig)
	if err != nil {
		fatal("database configuration failed")
	}
	defer db.Close()
	if err := db.Ping(ctx); err != nil {
		fatal("database unavailable")
	}
	app := &App{db: db, cfg: cfg, client: &http.Client{Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
	artifacts, err := newArtifacts(cfg)
	if err != nil {
		fatal("service configuration failed")
	}
	app.artifacts = artifacts
	serviceCtx, stopService := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stopService()
	app.startMetrics(serviceCtx)
	if os.Getenv("JOBS_ONLY") == "true" {
		workerCtx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		defer stop()
		bucketCtx, cancelBucket := context.WithTimeout(workerCtx, 10*time.Second)
		err = artifacts.ensureBucket(bucketCtx)
		cancelBucket()
		if err != nil {
			fatal("private artifact bucket unavailable")
		}
		app.client.Timeout = 40 * time.Second
		go app.runExecutionJobs(workerCtx)
		go app.runSearchJobs(workerCtx)
		app.runCheckpointJobs(workerCtx)
		return
	}
	server := &http.Server{
		Addr: cfg.ListenAddr, Handler: app.routes(),
		ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 60 * time.Second,
		MaxHeaderBytes: 16 << 10,
	}
	slog.Info("api listening")
	go func() {
		<-serviceCtx.Done()
		end, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = server.Shutdown(end)
	}()
	if cfg.RunnerToken != "" {
		go func() {
			control := &http.Server{Addr: cfg.RunnerListen, Handler: app.runnerRoutes(), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 30 * time.Second, MaxHeaderBytes: 4096}
			go func() {
				<-serviceCtx.Done()
				end, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				defer cancel()
				_ = control.Shutdown(end)
			}()
			if err := control.ListenAndServe(); err != nil && err != http.ErrServerClosed {
				fatal("control listener stopped")
			}
		}()
	}
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		fatal("api listener stopped")
	}
}
