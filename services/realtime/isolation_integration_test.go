package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/gorilla/websocket"
)

func TestBlockedControlDoesNotBlockDataAndWritesRecheckMembership(t *testing.T) {
	if os.Getenv("GO_INTEGRATION") != "1" {
		t.Skip("requires isolated Redis")
	}
	r, e := openRedis()
	if e != nil {
		t.Fatal(e)
	}
	defer r.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	cfg := testConfig()
	cfg.Prefix = os.Getenv("REDIS_KEY_PREFIX") + "isolation:" + randomID() + ":"
	var blocked, denied atomic.Bool
	entered := make(chan struct{}, 1)
	release := make(chan struct{})
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		var body struct{ Room string }
		_ = json.NewDecoder(req.Body).Decode(&body)
		if strings.HasSuffix(req.URL.Path, "/history") {
			_, _ = w.Write([]byte(`{"name":"history","messages":[]}`))
			return
		}
		if body.Room == "slow-room" && blocked.Load() {
			select {
			case entered <- struct{}{}:
			default:
			}
			select {
			case <-release:
			case <-req.Context().Done():
				return
			}
		}
		if body.Room == "fast-room" && denied.Load() {
			w.WriteHeader(403)
			return
		}
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer backend.Close()
	cfg.NodeURL = backend.URL
	raw, _ := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{"id": 7, "username": "isolation-user", "exp": time.Now().Add(time.Minute).Unix()}).SignedString([]byte(cfg.JWTSecret))
	key := cfg.Prefix + "token:isolation-user"
	if e = r.Set(ctx, key, raw, time.Minute).Err(); e != nil {
		t.Fatal(e)
	}
	defer r.Del(context.Background(), key)
	var dataReady, controlReady atomic.Bool
	dataReady.Store(true)
	g := newGateway(ctx, cfg, r, newMetrics(), &dataReady)
	server := httptest.NewServer(g)
	defer server.Close()
	defer g.shutdown()
	dial := func(room string) *websocket.Conn {
		peer, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http")+"/api/chat/v1/message/connect_chat?room="+room+"&type=private&id=7", http.Header{"Sec-Websocket-Protocol": []string{"pomelo-token, " + raw}})
		if err != nil {
			t.Fatal(err)
		}
		if _, _, err = peer.ReadMessage(); err != nil {
			t.Fatal(err)
		}
		return peer
	}
	slow, fast := dial("slow-room"), dial("fast-room")
	defer slow.Close()
	defer fast.Close()
	dataDone, controlDone := make(chan struct{}), make(chan struct{})
	go func() {
		defer close(dataDone)
		subscribe(ctx, r, []string{cfg.Prefix + "pomelo:message:fanout"}, &dataReady, func() {}, g.onMessage)
	}()
	go func() {
		defer close(controlDone)
		subscribe(ctx, r, []string{cfg.Prefix + "pomelo:room:access"}, &controlReady, func() {}, g.onMessage)
	}()
	defer func() { cancel(); close(release); <-dataDone; <-controlDone }()
	deadline := time.Now().Add(3 * time.Second)
	for !controlReady.Load() {
		if time.Now().After(deadline) {
			t.Fatal("subscription not ready")
		}
		time.Sleep(time.Millisecond)
	}
	blocked.Store(true)
	_ = r.Publish(ctx, cfg.Prefix+"pomelo:room:access", `{"room":"slow-room","userId":"7"}`).Err()
	select {
	case <-entered:
	case <-time.After(3 * time.Second):
		t.Fatal("control request did not block")
	}
	publish := func(id int) {
		event, _ := json.Marshal(Fanout{Version: 1, Room: "fast-room", Message: json.RawMessage(`{"id":` + stringNumber(id) + `,"sender_id":8,"room":"fast-room","content":"isolated"}`)})
		if err := r.Publish(ctx, cfg.Prefix+"pomelo:message:fanout", event).Err(); err != nil {
			t.Fatal(err)
		}
	}
	publish(1)
	_ = fast.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, frame, e := fast.ReadMessage()
	if e != nil || !strings.Contains(string(frame), "isolated") {
		t.Fatal("blocked control stalled unrelated room delivery")
	}
	denied.Store(true)
	publish(2)
	_, _, e = fast.ReadMessage()
	if e == nil {
		t.Fatal("revoked member received queued message")
	}
	if !websocket.IsCloseError(e, 4003) {
		t.Fatalf("expected authorization close: %v", e)
	}
}
func stringNumber(n int) string { raw, _ := json.Marshal(n); return string(raw) }

func TestSendRepliesAvoidRoomRPCButStillRejectRevokedSessions(t *testing.T) {
	if os.Getenv("GO_INTEGRATION") != "1" {
		t.Skip("requires isolated Redis")
	}
	r, err := openRedis()
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	cfg := testConfig()
	cfg.Prefix = os.Getenv("REDIS_KEY_PREFIX") + "replies:" + randomID() + ":"
	key := cfg.Prefix + "token:reply-user"
	var denied atomic.Bool
	var authorizationCalls atomic.Int64
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.Header.Get("Authorization") != "Bearer "+cfg.InternalToken {
			w.WriteHeader(404)
			return
		}
		switch {
		case strings.HasSuffix(req.URL.Path, "/authorize"):
			authorizationCalls.Add(1)
			if denied.Load() {
				w.WriteHeader(403)
				return
			}
			_, _ = w.Write([]byte(`{"ok":true}`))
		case strings.HasSuffix(req.URL.Path, "/history"):
			_, _ = w.Write([]byte(`{"name":"history","messages":[]}`))
		case strings.HasSuffix(req.URL.Path, "/send"):
			var input struct {
				ID string `json:"clientMsgId"`
			}
			_ = json.NewDecoder(req.Body).Decode(&input)
			denied.Store(true) // Membership changed after the business operation.
			if input.ID == "revoke-session" {
				_ = r.Del(ctx, key).Err()
			}
			if input.ID == "denied-message" {
				w.WriteHeader(403)
				return
			}
			if input.ID == "unexpected-body" {
				_, _ = w.Write([]byte(`{"name":"history","messages":[{"content":"must not escape"}]}`))
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"name": "ack", "id": 1, "client_msg_id": input.ID, "room_seq": 1})
		default:
			w.WriteHeader(404)
		}
	}))
	defer backend.Close()
	cfg.NodeURL = backend.URL
	token, _ := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{"id": 7, "username": "reply-user", "exp": time.Now().Add(time.Minute).Unix()}).SignedString([]byte(cfg.JWTSecret))
	if err = r.Set(ctx, key, token, time.Minute).Err(); err != nil {
		t.Fatal(err)
	}
	defer r.Del(context.Background(), key)
	var ready atomic.Bool
	ready.Store(true)
	g := newGateway(ctx, cfg, r, newMetrics(), &ready)
	server := httptest.NewServer(g)
	defer server.Close()
	defer g.shutdown()
	peer, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http")+"/api/chat/v1/message/connect_chat?room=reply-room&type=private&id=7", http.Header{"Sec-Websocket-Protocol": []string{"pomelo-token, " + token}})
	if err != nil {
		t.Fatal(err)
	}
	defer peer.Close()
	_ = peer.SetReadDeadline(time.Now().Add(4 * time.Second))
	if _, _, err = peer.ReadMessage(); err != nil {
		t.Fatal(err)
	}
	authorizationCalls.Store(0)
	for _, id := range []string{"committed-message", "denied-message", "unexpected-body", "revoke-session"} {
		if err = peer.WriteJSON(map[string]any{"content": "test", "type": "text", "clientMsgId": id}); err != nil {
			t.Fatal(err)
		}
		_, raw, readErr := peer.ReadMessage()
		if id == "revoke-session" {
			if !websocket.IsCloseError(readErr, 4001) {
				t.Fatalf("revoked session got reply: %s, %v", raw, readErr)
			}
			continue
		}
		if readErr != nil {
			t.Fatalf("reply blocked by extra room authorization: %v", readErr)
		}
		var frame struct {
			Name string `json:"name"`
		}
		_ = json.Unmarshal(raw, &frame)
		want := "error"
		if id == "committed-message" {
			want = "ack"
		}
		if frame.Name != want || strings.Contains(string(raw), "must not escape") {
			t.Fatalf("unexpected reply: %s", raw)
		}
	}
	if authorizationCalls.Load() != 0 {
		t.Fatal("send reply performed redundant room authorization")
	}
}
