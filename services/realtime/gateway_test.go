package main

import (
	"bufio"
	"context"
	"encoding/json"
	"github.com/gorilla/websocket"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestWireFixtures(t *testing.T) {
	raw, e := os.ReadFile("../../contracts/realtime-v1.json")
	if e != nil {
		t.Fatal(e)
	}
	var fixtures struct {
		FormatCases []struct {
			Bytes     float64
			FileSize  string `json:"file_size"`
			Timestamp int64
			Created   string `json:"created_at"`
		}
		Message Message
	}
	if e = json.Unmarshal(raw, &fixtures); e != nil {
		t.Fatal(e)
	}
	for _, f := range fixtures.FormatCases {
		if s := formatBytes(f.Bytes); s != f.FileSize {
			t.Errorf("file size %v: %s != %s", f.Bytes, s, f.FileSize)
		}
		if s := formatCreated(f.Timestamp); s != f.Created {
			t.Errorf("date: %s != %s", s, f.Created)
		}
	}
	data, _ := json.Marshal(fixtures.Message)
	var actual, expected map[string]any
	_ = json.Unmarshal(data, &actual)
	var all map[string]json.RawMessage
	_ = json.Unmarshal(raw, &all)
	_ = json.Unmarshal(all["message"], &expected)
	if len(actual) != len(expected) {
		t.Fatal("wire field count changed")
	}
	for k, v := range expected {
		if actual[k] != v {
			t.Errorf("%s changed", k)
		}
	}
}
func testConfig() Config {
	return Config{NodeURL: "http://127.0.0.1:1", InternalToken: "01234567890123456789012345678901", JWTSecret: "test-secret", QueueSize: 2, RoomQueue: 2, MaxConnections: 8, Origins: map[string]bool{}}
}
func TestPrivateBridgeNeverProxied(t *testing.T) {
	var ready atomic.Bool
	g := newGateway(context.Background(), testConfig(), nil, newMetrics(), &ready)
	for _, path := range []string{"/internal/realtime/send", "/%69nternal/realtime/send", "/internal%2frealtime/send", "/INTERNAL/realtime/send", "/internal"} {
		r := httptest.NewRequest("POST", path, nil)
		w := httptest.NewRecorder()
		g.ServeHTTP(w, r)
		if w.Code != 404 {
			t.Errorf("%s: %d", path, w.Code)
		}
	}
}
func TestReceiptBoundToConnectionAndSingleUse(t *testing.T) {
	var ready atomic.Bool
	g := newGateway(context.Background(), testConfig(), nil, newMetrics(), &ready)
	a, b := &client{ctx: context.Background()}, &client{ctx: context.Background()}
	token := g.track(a, time.Now().Add(-time.Second).UnixMilli())
	g.ack(b, token)
	if len(g.receipts) != 1 {
		t.Fatal("another connection consumed receipt")
	}
	g.ack(a, token)
	g.ack(a, token)
	if len(g.receipts) != 0 || g.metrics.values["pomelo_message_socket_receive_seconds_count"] != 1 {
		t.Fatal("receipt was not single use")
	}
	for i := 0; i < 128; i++ {
		if g.track(a, 0) == "" {
			t.Fatal("receipt capacity too small")
		}
	}
	if g.track(a, 0) != "" {
		t.Fatal("receipt cap exceeded")
	}
}
func TestConfigFailsClosed(t *testing.T) {
	t.Setenv("REALTIME_INTERNAL_TOKEN", "")
	if _, e := loadConfig("all"); e == nil {
		t.Fatal("accepted missing credential")
	}
	t.Setenv("REALTIME_INTERNAL_TOKEN", "01234567890123456789012345678901")
	t.Setenv("JWT_SECRET", "test")
	t.Setenv("GO_SOCKET_QUEUE", "0")
	if _, e := loadConfig("gateway"); e == nil {
		t.Fatal("accepted unbounded/invalid queue")
	}
	if _, e := loadConfig("bogus"); e == nil {
		t.Fatal("accepted invalid role")
	}
}
func TestMetricsRequireSeparateCredential(t *testing.T) {
	m := newMetrics()
	r := httptest.NewRequest("GET", "/internal/metrics", nil)
	w := httptest.NewRecorder()
	m.serve("", w, r)
	if w.Code != 404 {
		t.Fatal("metrics enabled without token")
	}
	r.Header.Set("Authorization", "Bearer scrape-secret")
	w = httptest.NewRecorder()
	m.serve("scrape-secret", w, r)
	if w.Code != 200 {
		t.Fatal("authorized metrics rejected")
	}
}

func TestBoundedSocketBufferClosesSlowClient(t *testing.T) {
	for _, oversized := range []bool{false, true} {
		t.Run(fmtBool(oversized), func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			connections := make(chan *websocket.Conn, 1)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				conn, e := (&websocket.Upgrader{}).Upgrade(w, r, nil)
				if e != nil {
					return
				}
				connections <- conn
				<-ctx.Done()
			}))
			defer server.Close()
			peer, _, e := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http"), nil)
			if e != nil {
				t.Fatal(e)
			}
			defer peer.Close()
			var ready atomic.Bool
			g := newGateway(ctx, testConfig(), nil, newMetrics(), &ready)
			c := &client{g: g, ctx: ctx, cancel: cancel, ws: <-connections, out: make(chan outboundFrame, 1)}
			if oversized {
				c.enqueue(make([]byte, maxBufferedBytes+1))
			} else {
				c.enqueue([]byte(`{"n":1}`))
				c.enqueue([]byte(`{"n":2}`))
			}
			if ctx.Err() == nil || len(c.out) > 1 {
				t.Fatal("slow client did not close at bounded capacity")
			}
			if g.metrics.values["pomelo_socket_slow_disconnects_total"] != 1 {
				t.Fatal("backpressure was not observed")
			}
		})
	}
}
func fmtBool(b bool) string {
	if b {
		return "byte-limit"
	}
	return "frame-limit"
}

func TestHTTPProxyStreamsAndReplacesForwardedChain(t *testing.T) {
	release := make(chan struct{})
	seen := make(chan string, 1)
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen <- r.Header.Get("X-Forwarded-For")
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte("data: first\n\n"))
		w.(http.Flusher).Flush()
		<-release
		_, _ = w.Write([]byte("data: second\n\n"))
	}))
	defer backend.Close()
	cfg := testConfig()
	cfg.NodeURL = backend.URL
	var ready atomic.Bool
	g := newGateway(context.Background(), cfg, nil, newMetrics(), &ready)
	server := httptest.NewServer(g)
	defer server.Close()
	req, _ := http.NewRequest("GET", server.URL+"/api/chat/v1/assistant/agent/stream", nil)
	req.Header.Set("X-Forwarded-For", "spoofed")
	res, e := http.DefaultClient.Do(req)
	if e != nil {
		close(release)
		t.Fatal(e)
	}
	defer res.Body.Close()
	reader := bufio.NewReader(res.Body)
	first, e := reader.ReadString('\n')
	close(release)
	if e != nil || first != "data: first\n" {
		t.Fatal("first SSE event was buffered")
	}
	if ip := <-seen; strings.Contains(ip, "spoofed") || ip == "" {
		t.Fatal("forwarded client identity was spoofable")
	}
}
