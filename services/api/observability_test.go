package main

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"go.opentelemetry.io/otel"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
)

func TestTelemetryRedactsAndPreservesHTTPInterfaces(t *testing.T) {
	const secret = "CCE_SECRET_SENTINEL_cookie_invite_source_stdin_stdout"
	exporter := tracetest.NewInMemoryExporter()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSyncer(exporter))
	previous := tracer
	tracer = provider.Tracer("test")
	defer func() { tracer = previous; _ = provider.Shutdown(context.Background()) }()
	a := &App{}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/v1/invites/{token}/accept", func(w http.ResponseWriter, r *http.Request) {
		q := safeQueryTracer{}
		ctx := q.TraceQueryStart(r.Context(), nil, pgx.TraceQueryStartData{SQL: secret, Args: []any{secret}})
		q.TraceQueryEnd(ctx, nil, pgx.TraceQueryEndData{Err: errors.New(secret)})
		w.WriteHeader(403)
	})
	r := httptest.NewRequest("POST", "/api/v1/invites/"+secret+"/accept?secret="+secret, strings.NewReader(secret))
	r.Header.Set("Cookie", secret)
	r.Header.Set("Authorization", secret)
	w := httptest.NewRecorder()
	a.observed(mux).ServeHTTP(w, r)
	spans := exporter.GetSpans()
	if len(spans) != 2 {
		t.Fatalf("missing correlation spans: %d", len(spans))
	}
	if spans[0].SpanContext.TraceID() != spans[1].SpanContext.TraceID() {
		t.Fatal("SQL and request trace not correlated")
	}
	for _, span := range spans {
		if strings.Contains(span.Name, secret) || strings.Contains(span.Status.Description, secret) || len(span.Attributes) > 0 || len(span.Events) > 0 {
			t.Fatal("sensitive tracing data captured")
		}
	}
	metrics := httptest.NewRecorder()
	promhttp.HandlerFor(registry, promhttp.HandlerOpts{}).ServeHTTP(metrics, httptest.NewRequest("GET", "/metrics", nil))
	if strings.Contains(metrics.Body.String(), secret) {
		t.Fatal("sensitive metric label")
	}
	server := httptest.NewServer(a.routes())
	defer server.Close()
	response, err := http.Get(server.URL + "/metrics")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != 404 {
		t.Fatal("metrics exposed by public router")
	}
	_ = otel.GetTracerProvider()
}
