package main

// Deliberately manual instrumentation: no URL, header, query, SQL text/argument,
// error string or payload capture. All dimensions are fixed operation names.
import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
)

var registry = prometheus.NewRegistry()
var operationSeconds = prometheus.NewHistogramVec(prometheus.HistogramOpts{Name: "cce_operation_seconds", Help: "Operation wall time, including failures.", Buckets: []float64{.001, .005, .01, .025, .05, .1, .25, .5, 1, 2, 5, 15, 30, 120, 300}}, []string{"operation", "outcome"})
var connections = prometheus.NewGauge(prometheus.GaugeOpts{Name: "cce_connections", Help: "Admitted document/project connections and handshakes."})
var databaseErrors = prometheus.NewCounter(prometheus.CounterOpts{Name: "cce_database_errors_total", Help: "Failed database queries (including policy denials)."})
var storageBytes = prometheus.NewGaugeVec(prometheus.GaugeOpts{Name: "cce_storage_bytes", Help: "Database payload/physical storage samples."}, []string{"kind"})
var queueItems = prometheus.NewGaugeVec(prometheus.GaugeOpts{Name: "cce_job_queue_items", Help: "Durable job state samples."}, []string{"kind"})
var tracer = otel.Tracer("cce/api")

func init() {
	registry.MustRegister(operationSeconds, connections, databaseErrors, storageBytes, queueItems, prometheus.NewGoCollector(), prometheus.NewProcessCollector(prometheus.ProcessCollectorOpts{}))
}

func initTelemetry(ctx context.Context, service string) (func(context.Context) error, error) {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)))
	otel.SetErrorHandler(otel.ErrorHandlerFunc(func(error) { slog.Warn("telemetry export failed") }))
	otel.SetTextMapPropagator(propagation.TraceContext{}) // no baggage from browsers
	if os.Getenv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT") == "" {
		return func(context.Context) error { return nil }, nil
	}
	exporter, err := otlptracehttp.New(ctx)
	if err != nil {
		return nil, err
	}
	ratio := .1
	if value := os.Getenv("CCE_TRACE_SAMPLE_RATIO"); value != "" {
		ratio, err = strconv.ParseFloat(value, 64)
		if err != nil || ratio < 0 || ratio > 1 {
			return nil, errors.New("invalid trace sample ratio")
		}
	}
	provider := sdktrace.NewTracerProvider(sdktrace.WithBatcher(exporter, sdktrace.WithMaxQueueSize(2048)), sdktrace.WithResource(resource.NewSchemaless(attribute.String("service.name", service))), sdktrace.WithSampler(sdktrace.ParentBased(sdktrace.TraceIDRatioBased(ratio))))
	otel.SetTracerProvider(provider)
	tracer = provider.Tracer("cce/api")
	return provider.Shutdown, nil
}

func operation(ctx context.Context, name string) (context.Context, func(error)) {
	ctx, span := tracer.Start(ctx, name)
	start := time.Now()
	return ctx, func(err error) {
		outcome := "ok"
		if err != nil {
			outcome = "error"
			span.SetStatus(codes.Error, "operation failed")
		}
		operationSeconds.WithLabelValues(name, outcome).Observe(time.Since(start).Seconds())
		span.End()
	}
}

// Query tracer excludes SQL and arguments, including errors that can contain data.
type safeQueryTracer struct{}
type querySpanKey struct{}

func (safeQueryTracer) TraceQueryStart(ctx context.Context, _ *pgx.Conn, _ pgx.TraceQueryStartData) context.Context {
	ctx, finish := operation(ctx, "database.query")
	return context.WithValue(ctx, querySpanKey{}, finish)
}
func (safeQueryTracer) TraceQueryEnd(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryEndData) {
	if data.Err != nil {
		databaseErrors.Inc()
	}
	if finish, ok := ctx.Value(querySpanKey{}).(func(error)); ok {
		finish(data.Err)
	}
}

// Normalize route templates only AFTER ServeMux selects them. Unmatched raw
// paths and invite tokens must never become telemetry dimensions.
func (a *App) observed(mux *http.ServeMux) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, pattern := mux.Handler(r)
		if pattern == "" {
			pattern = "unmatched"
		}
		ctx, span := tracer.Start(r.Context(), pattern)
		start := time.Now()
		defer func() {
			operationSeconds.WithLabelValues("http.request", "finished").Observe(time.Since(start).Seconds())
			span.End()
		}()
		// Do not wrap ResponseWriter: preserve WebSocket Hijacker and SSE Flusher.
		mux.ServeHTTP(w, r.WithContext(ctx))
	})
}

func injectTrace(ctx context.Context, h http.Header) {
	otel.GetTextMapPropagator().Inject(ctx, propagation.HeaderCarrier(h))
}

// Separate private listener; never routed by Caddy or the public API.
func (a *App) startMetrics(ctx context.Context) {
	addr := os.Getenv("METRICS_LISTEN_ADDR")
	if addr == "" {
		return
	}
	mux := http.NewServeMux()
	mux.Handle("GET /metrics", promhttp.HandlerFor(registry, promhttp.HandlerOpts{}))
	server := &http.Server{Addr: addr, Handler: mux, ReadHeaderTimeout: 3 * time.Second, WriteTimeout: 5 * time.Second, MaxHeaderBytes: 4096}
	go func() {
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			slog.Error("metrics listener failed")
		}
	}()
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdown)
	}()
	go func() {
		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				sample, cancel := context.WithTimeout(ctx, 2*time.Second)
				var payload, physical, checkpoint, search, runs int64
				err := a.db.QueryRow(sample, `SELECT coalesce((SELECT sum(durable_log_bytes) FROM projects),0),pg_database_size(current_database()),(SELECT count(*) FROM checkpoints WHERE state IN ('captured','materializing')),(SELECT count(*) FROM search_tasks WHERE revision>done_revision),(SELECT count(*) FROM run_jobs WHERE state IN ('capturing','queued','running'))`).Scan(&payload, &physical, &checkpoint, &search, &runs)
				cancel()
				if err == nil {
					storageBytes.WithLabelValues("update_payload").Set(float64(payload))
					storageBytes.WithLabelValues("database_physical").Set(float64(physical))
					queueItems.WithLabelValues("checkpoint").Set(float64(checkpoint))
					queueItems.WithLabelValues("search").Set(float64(search))
					queueItems.WithLabelValues("run").Set(float64(runs))
				}
			}
		}
	}()
}
