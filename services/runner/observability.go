package main

import (
	"context"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"log/slog"
	"net/http"
	"os"
	"time"
)

var runnerRegistry = prometheus.NewRegistry()
var runnerSeconds = prometheus.NewHistogramVec(prometheus.HistogramOpts{Name: "cce_runner_seconds", Help: "Runner stage time (Docker attach startup is not first user instruction).", Buckets: []float64{.005, .01, .05, .1, .25, .5, 1, 2, 5, 10, 30}}, []string{"stage", "runtime"})

func init() {
	runnerRegistry.MustRegister(runnerSeconds, prometheus.NewGoCollector(), prometheus.NewProcessCollector(prometheus.ProcessCollectorOpts{}))
}
func observeStage(stage, runtime string, start time.Time) {
	if runtime != "python" && runtime != "javascript" {
		runtime = "invalid"
	}
	runnerSeconds.WithLabelValues(stage, runtime).Observe(time.Since(start).Seconds())
}
func startRunnerMetrics(ctx context.Context) {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)))
	addr := os.Getenv("METRICS_LISTEN_ADDR")
	if addr == "" {
		return
	}
	mux := http.NewServeMux()
	mux.Handle("GET /metrics", promhttp.HandlerFor(runnerRegistry, promhttp.HandlerOpts{}))
	server := &http.Server{Addr: addr, Handler: mux, ReadHeaderTimeout: 3 * time.Second, WriteTimeout: 5 * time.Second}
	go func() {
		if server.ListenAndServe() != http.ErrServerClosed {
			slog.Error("runner metrics listener stopped")
		}
	}()
	go func() {
		<-ctx.Done()
		stop, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = server.Shutdown(stop)
	}()
}
