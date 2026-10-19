package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
	"github.com/redis/go-redis/v9"
)

const maxBufferedBytes = 1 << 20

type receipt struct {
	client        *client
	sent, expires time.Time
	persisted     int64
}

// Replies contain only the caller's send result, never room history or content.
// Keep their session check, without performing another room RPC after commit.
type outboundFrame struct {
	raw    []byte
	reply  bool
	queued time.Time
}
type roomState struct {
	clients map[*client]bool
	events  chan Fanout
	ctx     context.Context
	cancel  context.CancelFunc
}
type Gateway struct {
	cfg           Config
	redis         *redis.Client
	bridge        *Bridge
	metrics       *Metrics
	ctx           context.Context
	mu            sync.Mutex
	clients       map[*client]bool
	users         map[string]map[*client]bool
	rooms         map[string]*roomState
	notifications map[string]*client
	receipts      map[string]receipt
	receiptCounts map[*client]int
	slots         chan struct{}
	subscribed    *atomic.Bool
	upgrader      websocket.Upgrader
	proxy         *httputil.ReverseProxy
	wg            sync.WaitGroup
	closing       bool
	controlReady  *atomic.Bool
}
type client struct {
	g                *Gateway
	ws               *websocket.Conn
	actor            Actor
	room, typ, lease string
	notification     bool
	ctx              context.Context
	cancel           context.CancelFunc
	once             sync.Once
	out              chan outboundFrame
	initial          chan []byte
	buffered         atomic.Int64
}

func newGateway(ctx context.Context, c Config, r *redis.Client, m *Metrics, ready *atomic.Bool) *Gateway {
	u, _ := url.Parse(c.NodeURL)
	g := &Gateway{cfg: c, redis: r, bridge: newBridge(c, m), metrics: m, ctx: ctx, clients: map[*client]bool{}, rooms: map[string]*roomState{}, notifications: map[string]*client{}, receipts: map[string]receipt{}, receiptCounts: map[*client]int{}, slots: make(chan struct{}, c.MaxConnections), subscribed: ready}
	g.users = make(map[string]map[*client]bool)
	g.upgrader = websocket.Upgrader{ReadBufferSize: 4096, WriteBufferSize: 4096, HandshakeTimeout: 5 * time.Second, Subprotocols: []string{"pomelo-token"}, CheckOrigin: func(r *http.Request) bool { o := r.Header.Get("Origin"); return o == "" || c.Origins[o] }}
	g.proxy = httputil.NewSingleHostReverseProxy(u)
	g.proxy.FlushInterval = -1
	director := g.proxy.Director
	g.proxy.Director = func(r *http.Request) {
		// ReverseProxy appends the real peer IP; discard any client-supplied chain first.
		r.Header.Del("X-Forwarded-For")
		r.Header.Del("X-Forwarded-Host")
		r.Header.Del("X-Forwarded-Proto")
		director(r)
		r.Header.Del("X-Realtime-Internal-Token")
		r.Header.Del("Forwarded")
	}
	g.proxy.ErrorHandler = func(w http.ResponseWriter, r *http.Request, _ error) {
		http.Error(w, "business service unavailable", http.StatusBadGateway)
	}
	return g
}
func tokenFromRequest(r *http.Request) string {
	for _, v := range websocket.Subprotocols(r) {
		if v != "pomelo-token" {
			return v
		}
	}
	if v := r.Header.Get("Authorization"); v != "" {
		return strings.TrimPrefix(v, "Bearer ")
	}
	return r.URL.Query().Get("token")
}
func (g *Gateway) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// Check the decoded/cleaned path as well: encoded slashes and proxy path tricks cannot expose the bridge.
	if strings.HasPrefix(strings.ToLower(r.URL.Path), "/internal/") || strings.EqualFold(r.URL.Path, "/internal") {
		http.NotFound(w, r)
		return
	}
	switch r.URL.Path {
	case "/api/chat/v1/message/connect_chat":
		g.connect(w, r, false)
	case "/api/chat/v1/auth/user_channel":
		g.connect(w, r, true)
	default:
		if websocket.IsWebSocketUpgrade(r) {
			http.NotFound(w, r)
			return
		}
		g.proxy.ServeHTTP(w, r)
	}
}
func (g *Gateway) connect(w http.ResponseWriter, r *http.Request, notification bool) {
	if !g.subscribed.Load() || (g.controlReady != nil && !g.controlReady.Load()) {
		http.Error(w, "realtime unavailable", 503)
		return
	}
	select {
	case g.slots <- struct{}{}:
		defer func() { <-g.slots }()
	default:
		g.metrics.add("pomelo_socket_capacity_rejected_total", 1)
		http.Error(w, "realtime capacity reached", 503)
		return
	}
	ctx, cancel := context.WithCancel(g.ctx)
	defer cancel()
	authCtx, stop := context.WithTimeout(ctx, 5*time.Second)
	a, e := authenticate(authCtx, g.redis, g.cfg, tokenFromRequest(r))
	stop()
	if e != nil {
		http.Error(w, "unauthorized", 401)
		return
	}
	q := r.URL.Query()
	room, typ := q.Get("room"), q.Get("type")
	if notification {
		if a.Username != q.Get("username") {
			http.Error(w, "unauthorized", 401)
			return
		}
	} else {
		if room == "" || q.Get("id") != a.ID || (typ != "private" && typ != "group") {
			http.Error(w, "invalid room", 400)
			return
		}
		if !g.bridge.authorize(ctx, a, room, typ) {
			http.Error(w, "forbidden", 403)
			return
		}
	}
	ws, e := g.upgrader.Upgrade(w, r, nil)
	if e != nil {
		return
	}
	ws.SetReadLimit(65536)
	c := &client{g: g, ws: ws, actor: a, room: room, typ: typ, notification: notification, lease: randomID(), ctx: ctx, cancel: cancel, out: make(chan outboundFrame, g.cfg.QueueSize), initial: make(chan []byte, 1)}
	if !g.add(c) {
		c.close(1001, "server stopping")
		return
	}
	defer g.wg.Done()
	defer c.close(1000, "closed")
	writerDone := make(chan struct{})
	go func() { defer close(writerDone); c.writeLoop() }()
	initDone := make(chan struct{})
	go func() { defer close(initDone); c.initialize() }()
	c.readLoop()
	c.close(1000, "closed")
	<-initDone
	<-writerDone
	c.cleanupPresence()
}
func (g *Gateway) add(c *client) bool {
	g.mu.Lock()
	if g.closing {
		g.mu.Unlock()
		return false
	}
	g.wg.Add(1)
	g.clients[c] = true
	if g.users[c.actor.Username] == nil {
		g.users[c.actor.Username] = make(map[*client]bool)
	}
	g.users[c.actor.Username][c] = true
	g.metrics.set("pomelo_socket_connections", float64(len(g.clients)))
	var previous *client
	if c.notification {
		previous = g.notifications[c.actor.Username]
		g.notifications[c.actor.Username] = c
	} else {
		state := g.rooms[c.room]
		if state == nil {
			ctx, cancel := context.WithCancel(g.ctx)
			state = &roomState{map[*client]bool{}, make(chan Fanout, g.cfg.RoomQueue), ctx, cancel}
			g.rooms[c.room] = state
			g.wg.Add(1)
			go func() {
				defer g.wg.Done()
				for {
					select {
					case <-state.ctx.Done():
						return
					case event := <-state.events:
						g.deliver(state, event)
					}
				}
			}()
		}
		state.clients[c] = true
	}
	g.mu.Unlock()
	if previous != nil {
		previous.close(4004, "connection replaced")
	}
	return true
}
func (c *client) initialize() {
	if c.notification {
		if e := c.g.redis.Set(c.ctx, c.g.cfg.Prefix+"presence:"+c.actor.Username, c.lease, 30*time.Second).Err(); e != nil {
			c.close(4001, "presence unavailable")
			return
		}
		payload, _ := json.Marshal(map[string]any{"username": c.actor.Username, "lease": c.lease})
		if e := c.g.redis.Publish(c.ctx, c.g.cfg.Prefix+"pomelo:presence:changed", payload).Err(); e != nil {
			c.close(4001, "presence unavailable")
			return
		}
		_, status, e := c.g.bridge.call(c.ctx, "presence-online", map[string]any{"token": c.actor.Token})
		if e != nil || status != 200 {
			c.close(4001, "presence unavailable")
			return
		}
		c.initial <- nil
		return
	}
	raw, status, e := c.g.bridge.call(c.ctx, "history", map[string]any{"token": c.actor.Token, "room": c.room, "type": c.typ})
	if e != nil || status != 200 {
		c.close(4003, "history unavailable")
		return
	}
	if !c.valid() {
		return
	}
	select {
	case c.initial <- raw:
	case <-c.ctx.Done():
	}
}
func (c *client) valid() bool {
	ctx, cancel := context.WithTimeout(c.ctx, 4*time.Second)
	defer cancel()
	if _, e := authenticate(ctx, c.g.redis, c.g.cfg, c.actor.Token); e != nil {
		c.close(4001, "session revoked")
		return false
	}
	return true
}
func (c *client) authorized() bool {
	if c.notification {
		return c.valid()
	}
	if !c.g.bridge.authorize(c.ctx, c.actor, c.room, c.typ) {
		c.g.metrics.add("pomelo_room_access_rejected_total", 1)
		c.close(4003, "room access revoked or unavailable")
		return false
	}
	return true
}
func (c *client) close(code int, reason string) {
	c.once.Do(func() {
		c.cancel()
		_ = c.ws.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(code, reason), time.Now().Add(time.Second))
		_ = c.ws.Close()
		g := c.g
		g.mu.Lock()
		delete(g.clients, c)
		delete(g.users[c.actor.Username], c)
		if len(g.users[c.actor.Username]) == 0 {
			delete(g.users, c.actor.Username)
		}
		g.metrics.set("pomelo_socket_connections", float64(len(g.clients)))
		if c.notification {
			if g.notifications[c.actor.Username] == c {
				delete(g.notifications, c.actor.Username)
			}
		} else if state := g.rooms[c.room]; state != nil {
			delete(state.clients, c)
			if len(state.clients) == 0 {
				delete(g.rooms, c.room)
				state.cancel()
			}
		}
		for token, r := range g.receipts {
			if r.client == c {
				delete(g.receipts, token)
				g.metrics.add("pomelo_delivery_receipts_closed_total", 1)
			}
		}
		delete(g.receiptCounts, c)
		g.metrics.set("pomelo_delivery_receipts_pending", float64(len(g.receipts)))
		g.mu.Unlock()
	})
}
func (c *client) enqueue(raw []byte) {
	c.queue(outboundFrame{raw: raw})
}
func (c *client) reply(value any) {
	raw, e := json.Marshal(value)
	if e == nil {
		c.queue(outboundFrame{raw: raw, reply: true})
	}
}
func (c *client) queue(frame outboundFrame) {
	if c.ctx.Err() != nil {
		return
	}
	if c.buffered.Add(int64(len(frame.raw))) > maxBufferedBytes {
		c.buffered.Add(-int64(len(frame.raw)))
		c.g.metrics.add("pomelo_socket_slow_disconnects_total", 1)
		_ = c.ws.Close()
		c.close(4005, "slow connection")
		return
	}
	frame.queued = time.Now()
	select {
	case c.out <- frame:
	default:
		c.buffered.Add(-int64(len(frame.raw)))
		c.g.metrics.add("pomelo_socket_slow_disconnects_total", 1)
		_ = c.ws.Close()
		c.close(4005, "slow connection")
	}
}
func (c *client) frame(value any) {
	raw, e := json.Marshal(value)
	if e == nil {
		c.enqueue(raw)
	}
}
func (c *client) write(frame outboundFrame) bool {
	if frame.reply {
		if !c.valid() {
			return false
		}
	} else if !c.authorized() {
		return false
	}
	_ = c.ws.SetWriteDeadline(time.Now().Add(5 * time.Second))
	if e := c.ws.WriteMessage(websocket.TextMessage, frame.raw); e != nil {
		c.close(4005, "write failed")
		return false
	}
	return true
}
func (c *client) writeLoop() {
	select {
	case <-c.ctx.Done():
		return
	case raw := <-c.initial:
		if len(raw) > 0 && !c.write(outboundFrame{raw: raw}) {
			return
		}
	}
	t := time.NewTicker(15 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-c.ctx.Done():
			return
		case frame := <-c.out:
			c.buffered.Add(-int64(len(frame.raw)))
			c.g.metrics.observe("pomelo_socket_queue_wait_seconds", time.Since(frame.queued).Seconds())
			if !c.write(frame) {
				return
			}
		case <-t.C:
			if !c.authorized() {
				return
			}
			if c.notification {
				n, e := c.g.redis.Eval(c.ctx, `if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('EXPIRE',KEYS[1],30) end return 0`, []string{c.g.cfg.Prefix + "presence:" + c.actor.Username}, c.lease).Int()
				if e != nil || n != 1 {
					c.close(4004, "presence replaced")
					return
				}
			}
			if e := c.ws.WriteControl(websocket.PingMessage, nil, time.Now().Add(5*time.Second)); e != nil {
				c.close(4005, "heartbeat failed")
				return
			}
		}
	}
}
func (c *client) readLoop() {
	_ = c.ws.SetReadDeadline(time.Now().Add(60 * time.Second))
	c.ws.SetPongHandler(func(string) error { return c.ws.SetReadDeadline(time.Now().Add(60 * time.Second)) })
	// Read immediately, including during initial history fetch, so the first message cannot be lost.
	for {
		_, raw, e := c.ws.ReadMessage()
		if e != nil {
			return
		}
		if c.notification {
			continue
		}
		var input map[string]any
		if json.Unmarshal(raw, &input) != nil {
			c.reply(map[string]any{"name": "error", "message": "消息格式无效，已停止重试"})
			continue
		}
		if input["name"] == "delivery_ack" {
			if receipt, ok := input["receipt"].(string); ok {
				c.g.ack(c, receipt)
			}
			continue
		}
		if !c.valid() {
			return
		}
		body := map[string]any{"token": c.actor.Token, "room": c.room, "type": c.typ, "content": input["content"], "mediaType": input["type"], "fileSize": input["fileSize"], "clientMsgId": input["clientMsgId"]}
		raw, status, e := c.g.bridge.call(c.ctx, "send", body)
		if e != nil {
			c.reply(map[string]any{"name": "error", "code": "service_unavailable", "client_msg_id": input["clientMsgId"], "message": "发送结果待核对，正在使用原消息 ID 重试", "retryable": true, "retryAfterMs": 1000})
			continue
		}
		if status == 401 || status == 403 {
			c.reply(map[string]any{"name": "error", "client_msg_id": input["clientMsgId"], "message": "会话权限已失效，已停止重试"})
			continue
		}
		var response struct {
			Name string `json:"name"`
		}
		if json.Unmarshal(raw, &response) == nil && (response.Name == "ack" || response.Name == "error") {
			c.queue(outboundFrame{raw: raw, reply: true})
		} else {
			c.reply(map[string]any{"name": "error", "client_msg_id": input["clientMsgId"], "message": "消息发送失败，请核对后手动重试"})
		}
	}
}
func (g *Gateway) deliver(state *roomState, event Fanout) {
	g.mu.Lock()
	clients := make([]*client, 0, len(state.clients))
	for c := range state.clients {
		clients = append(clients, c)
	}
	g.mu.Unlock()
	var wg sync.WaitGroup
	defer wg.Wait()
	sem := make(chan struct{}, 16)
	for _, c := range clients {
		select {
		case sem <- struct{}{}:
		case <-state.ctx.Done():
			return
		}
		wg.Add(1)
		go func(c *client) {
			defer wg.Done()
			defer func() { <-sem }()
			var frame map[string]any
			if json.Unmarshal(event.Message, &frame) != nil {
				return
			}
			if _, ok := frame["id"]; ok && fmt.Sprint(frame["sender_id"]) != c.actor.ID {
				if token := g.track(c, event.PersistedAt); token != "" {
					frame["receipt"] = token
				}
			}
			c.frame(frame)
		}(c)
	}
}
func (g *Gateway) onMessage(channel, payload string) {
	switch channel {
	case g.cfg.Prefix + "pomelo:message:fanout":
		var event Fanout
		if json.Unmarshal([]byte(payload), &event) != nil || (event.Version != 0 && event.Version != 1) || event.Room == "" || !json.Valid(event.Message) {
			return
		}
		g.mu.Lock()
		state := g.rooms[event.Room]
		g.mu.Unlock()
		if state == nil {
			return
		}
		select {
		case state.events <- event:
		default:
			g.metrics.add("pomelo_room_queue_overflow_total", 1)
			g.closeRoom(state)
		}
	case g.cfg.Prefix + "pomelo:notifications":
		var event struct {
			Username string          `json:"username"`
			Data     json.RawMessage `json:"data"`
		}
		if json.Unmarshal([]byte(payload), &event) != nil || !json.Valid(event.Data) {
			return
		}
		g.mu.Lock()
		c := g.notifications[event.Username]
		g.mu.Unlock()
		if c != nil {
			c.enqueue(event.Data)
		}
	case g.cfg.Prefix + "pomelo:session:changed":
		var event struct {
			Username string `json:"username"`
		}
		if json.Unmarshal([]byte(payload), &event) != nil {
			return
		}
		for _, c := range g.userConnections(event.Username) {
			if c.actor.Username == event.Username && !c.valid() {
				continue
			}
		}
	case g.cfg.Prefix + "pomelo:presence:changed":
		var event struct{ Username, Lease string }
		if json.Unmarshal([]byte(payload), &event) != nil {
			return
		}
		g.mu.Lock()
		c := g.notifications[event.Username]
		g.mu.Unlock()
		if c != nil {
			current, e := g.redis.Get(g.ctx, g.cfg.Prefix+"presence:"+event.Username).Result()
			if e == nil && current != c.lease {
				c.close(4004, "connection replaced")
			}
		}
	case g.cfg.Prefix + "pomelo:room:access":
		var event struct{ Room, UserID string }
		if json.Unmarshal([]byte(payload), &event) != nil || event.Room == "" {
			return
		}
		for _, c := range g.roomConnections(event.Room) {
			if c.room == event.Room && (event.UserID == "" || c.actor.ID == event.UserID) {
				c.authorized()
			}
		}
	}
}
func (g *Gateway) snapshot() []*client {
	g.mu.Lock()
	defer g.mu.Unlock()
	out := make([]*client, 0, len(g.clients))
	for c := range g.clients {
		out = append(out, c)
	}
	return out
}
func (g *Gateway) userConnections(username string) []*client {
	g.mu.Lock()
	defer g.mu.Unlock()
	clients := make([]*client, 0, len(g.users[username]))
	for c := range g.users[username] {
		clients = append(clients, c)
	}
	return clients
}
func (g *Gateway) roomConnections(room string) []*client {
	g.mu.Lock()
	defer g.mu.Unlock()
	state := g.rooms[room]
	if state == nil {
		return nil
	}
	clients := make([]*client, 0, len(state.clients))
	for c := range state.clients {
		clients = append(clients, c)
	}
	return clients
}
func (g *Gateway) closeRoom(state *roomState) {
	g.mu.Lock()
	clients := make([]*client, 0, len(state.clients))
	for c := range state.clients {
		clients = append(clients, c)
	}
	g.mu.Unlock()
	for _, c := range clients {
		_ = c.ws.Close()
		c.close(4005, "room delivery congested")
	}
}
func (g *Gateway) resync() {
	for _, c := range g.snapshot() {
		if !c.notification {
			c.frame(map[string]any{"name": "resync"})
		}
	}
}
func (g *Gateway) shutdown() {
	g.mu.Lock()
	g.closing = true
	g.mu.Unlock()
	for _, c := range g.snapshot() {
		c.close(1001, "server stopping")
	}
	g.wg.Wait()
	g.bridge.client.CloseIdleConnections()
}
func (g *Gateway) track(c *client, persisted int64) string {
	g.mu.Lock()
	defer g.mu.Unlock()
	if c.ctx.Err() != nil {
		return ""
	}
	if len(g.receipts) >= 20000 || g.receiptCounts[c] >= 128 {
		g.metrics.add("pomelo_delivery_receipts_untracked_total", 1)
		return ""
	}
	token := randomID()
	now := time.Now()
	g.receipts[token] = receipt{c, now, now.Add(30 * time.Second), persisted}
	g.receiptCounts[c]++
	g.metrics.add("pomelo_delivery_receipts_requested_total", 1)
	g.metrics.set("pomelo_delivery_receipts_pending", float64(len(g.receipts)))
	return token
}
func (g *Gateway) ack(c *client, token string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	r, ok := g.receipts[token]
	if !ok || r.client != c {
		return
	}
	delete(g.receipts, token)
	g.receiptCounts[c]--
	g.metrics.set("pomelo_delivery_receipts_pending", float64(len(g.receipts)))
	if time.Now().After(r.expires) {
		g.metrics.add("pomelo_delivery_receipts_expired_total", 1)
		return
	}
	g.metrics.observe("pomelo_message_socket_receive_seconds", time.Since(r.sent).Seconds())
	if r.persisted > 0 {
		g.metrics.observe("pomelo_message_created_to_receive_seconds", float64(time.Now().UnixMilli()-r.persisted)/1000)
	}
}
func (g *Gateway) maintain(ctx context.Context) {
	timer := time.NewTicker(5 * time.Second)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
			g.mu.Lock()
			for token, r := range g.receipts {
				if time.Now().After(r.expires) {
					delete(g.receipts, token)
					g.receiptCounts[r.client]--
					g.metrics.add("pomelo_delivery_receipts_expired_total", 1)
				}
			}
			g.metrics.set("pomelo_delivery_receipts_pending", float64(len(g.receipts)))
			g.mu.Unlock()
		}
	}
}
func (c *client) cleanupPresence() {
	if !c.notification {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	n, e := c.g.redis.Eval(ctx, `if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0`, []string{c.g.cfg.Prefix + "presence:" + c.actor.Username}, c.lease).Int()
	if e == nil && n == 1 {
		_, _, _ = c.g.bridge.call(ctx, "presence-offline", map[string]any{"username": c.actor.Username})
		payload, _ := json.Marshal(map[string]any{"username": c.actor.Username, "lease": c.lease})
		_ = c.g.redis.Publish(ctx, c.g.cfg.Prefix+"pomelo:presence:changed", payload).Err()
	}
}
