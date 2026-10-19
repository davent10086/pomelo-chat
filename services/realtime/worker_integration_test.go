package main

import (
	"context"
	"net"
	"os"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
)

// Runs only inside the Node isolated runner, after migrations and before any worker starts.
func TestWorkerDatabaseLeases(t *testing.T) {
	if os.Getenv("GO_INTEGRATION") != "1" {
		t.Skip("requires isolated MySQL/Redis runner")
	}
	db, e := openDatabase()
	if e != nil {
		t.Fatal(e)
	}
	defer db.Close()
	r, e := openRedis()
	if e != nil {
		t.Fatal(e)
	}
	defer r.Close()
	ctx := context.Background()
	cfg := testConfig()
	cfg.Prefix = os.Getenv("REDIS_KEY_PREFIX")
	cfg.LeaseSeconds = 3
	cfg.Concurrency = 2
	w := newWorker(db, r, cfg, newMetrics())
	other := newWorker(db, r, cfg, newMetrics())
	exec := func(query string, args ...any) int64 {
		result, err := db.ExecContext(ctx, query, args...)
		if err != nil {
			t.Fatal(err)
		}
		id, _ := result.LastInsertId()
		return id
	}
	user := exec("INSERT INTO user(username,password,phone) VALUES(?,?,?)", "go_"+randomID(), "test", randomID())
	defer db.Exec("DELETE FROM user WHERE id=?", user)
	makeRoom := func() int64 {
		return exec("INSERT INTO conversation(room,type,target_id) VALUES(?,'private',?)", "go_"+randomID(), user)
	}
	a, b := makeRoom(), makeRoom()
	defer db.Exec("DELETE FROM conversation WHERE id IN (?,?)", a, b)
	var room string
	_ = db.QueryRow("SELECT room FROM conversation WHERE id=?", a).Scan(&room)
	add := func(conversation int64) int64 {
		var room string
		if err := db.QueryRow("SELECT room FROM conversation WHERE id=?", conversation).Scan(&room); err != nil {
			t.Fatal(err)
		}
		id := exec("INSERT INTO message(conversation_id,room_seq,sender_id,receiver_id,content,room,type,media_type) VALUES(?,1,?,?,'lease test',?,'private','text')", conversation, user, user, room)
		exec("INSERT INTO message_outbox(message_id,conversation_id) VALUES(?,?)", id, conversation)
		return id
	}
	head, tail, independent := add(a), add(a), add(b)
	first, token, e := w.claim(ctx)
	if e != nil || first != head {
		t.Fatalf("claim head: %d %v", first, e)
	}
	second, token2, e := other.claim(ctx)
	if e != nil || second != independent {
		t.Fatalf("leased head did not isolate room: %d %v", second, e)
	}
	none, _, e := other.claim(ctx)
	if e != nil || none != 0 {
		t.Fatal("claimed follower behind leased head")
	}
	if e = w.renew(ctx, first, token); e != nil {
		t.Fatal(e)
	}
	if e = other.finish(ctx, first, "stale-token", true); e == nil {
		t.Fatal("stale token completed claim")
	}
	if e = w.finish(ctx, first, token, false); e != nil {
		t.Fatal(e)
	}
	none, _, e = other.claim(ctx)
	if e != nil || none != 0 {
		t.Fatal("retry backoff did not block room successor")
	}
	exec("UPDATE message_outbox SET next_attempt_at=NOW() WHERE message_id=?", head)
	id, retryToken, e := w.claim(ctx)
	if e != nil || id != head {
		t.Fatal("retry head missing")
	}
	exec("UPDATE message_outbox SET lease_until=DATE_SUB(NOW(),INTERVAL 1 SECOND) WHERE message_id=?", head)
	if e = w.renew(ctx, id, retryToken); e == nil {
		t.Fatal("expired lease revived")
	}
	reclaimed, newToken, e := other.claim(ctx)
	if e != nil || reclaimed != head || newToken == retryToken {
		t.Fatal("expired lease not reclaimed")
	}
	if e = w.finish(ctx, id, retryToken, true); e == nil {
		t.Fatal("previous owner completed reassigned claim")
	}
	if e = other.deliver(ctx, head, newToken); e != nil {
		t.Fatal(e)
	}
	// Publish-before-completion crash: the next attempt may publish again and must still resolve one row.
	sub := r.Subscribe(ctx, cfg.Prefix+"pomelo:message:fanout")
	defer sub.Close()
	if _, e = sub.Receive(ctx); e != nil {
		t.Fatal(e)
	}
	if e = other.deliver(ctx, head, newToken); e != nil {
		t.Fatal(e)
	}
	read, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	if _, e = sub.ReceiveMessage(read); e != nil {
		t.Fatal("retry was not published")
	}
	if e = other.finish(ctx, head, newToken, true); e != nil {
		t.Fatal(e)
	}
	next, nextToken, e := w.claim(ctx)
	if e != nil || next != tail {
		t.Fatal("follower not released after completion")
	}
	if e = w.finish(ctx, next, nextToken, true); e != nil {
		t.Fatal(e)
	}
	if e = other.finish(ctx, independent, token2, true); e != nil {
		t.Fatal(e)
	}
	var attempts, complete int
	e = db.QueryRow("SELECT attempts,delivered_at IS NOT NULL FROM message_outbox WHERE message_id=?", head).Scan(&attempts, &complete)
	if e != nil || complete != 1 {
		t.Fatal("completion missing")
	}
	if attempts != 1 {
		t.Fatal("retry attempts changed")
	}
	// Simultaneous claims must select independent room heads, never the same row.
	add(a)
	add(b)
	var claims sync.WaitGroup
	results := make(chan int64, 2)
	failures := make(chan error, 2)
	for _, candidate := range []*Worker{w, other} {
		claims.Add(1)
		go func(worker *Worker) {
			defer claims.Done()
			id, token, err := worker.claim(ctx)
			if err == nil {
				err = worker.finish(ctx, id, token, true)
			}
			results <- id
			failures <- err
		}(candidate)
	}
	claims.Wait()
	if <-results == <-results {
		t.Fatal("competing workers claimed the same row")
	}
	for i := 0; i < 2; i++ {
		if err := <-failures; err != nil {
			t.Fatal(err)
		}
	}
	// A broker failure leaves a retryable durable row rather than marking it complete.
	failed := add(a)
	broken := redis.NewClient(&redis.Options{Addr: "127.0.0.1:1", DialTimeout: 50 * time.Millisecond, MaxRetries: -1})
	defer broken.Close()
	failing := newWorker(db, broken, cfg, newMetrics())
	if ok, err := failing.one(ctx); err != nil || !ok {
		t.Fatal("failed delivery did not execute")
	}
	if err := db.QueryRow("SELECT attempts,delivered_at IS NOT NULL FROM message_outbox WHERE message_id=?", failed).Scan(&attempts, &complete); err != nil || attempts != 1 || complete != 0 {
		t.Fatal("broker failure lost durable retry")
	}
	// One startup wake must drain a backlog without relying on the fallback poll.
	exec("UPDATE message_outbox SET next_attempt_at=NOW() WHERE message_id=?", failed)
	for i := 0; i < 8; i++ {
		room := makeRoom()
		defer db.Exec("DELETE FROM conversation WHERE id=?", room)
		add(room)
	}
	cfg.Concurrency, cfg.Poll = 4, time.Hour
	draining := newWorker(db, r, cfg, newMetrics())
	drainCtx, stopDrain := context.WithCancel(ctx)
	draining.start(drainCtx)
	defer func() { stopDrain(); draining.wg.Wait() }()
	deadline := time.Now().Add(5 * time.Second)
	for {
		var pending int
		if err := db.QueryRow("SELECT COUNT(*) FROM message_outbox WHERE delivered_at IS NULL").Scan(&pending); err != nil {
			t.Fatal(err)
		}
		if pending == 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("single wake stranded a durable backlog until fallback poll")
		}
		time.Sleep(10 * time.Millisecond)
	}
	stopDrain()
	draining.wg.Wait()
	// Block one delivery indefinitely. Each subsequent wake must reach an idle
	// lane, rather than waiting behind that busy lane or the fallback poll.
	blockedRedis := redis.NewClient(r.Options())
	defer blockedRedis.Close()
	hook := &blockFirstPublish{entered: make(chan struct{}), release: make(chan struct{})}
	blockedRedis.AddHook(hook)
	slowRoom := makeRoom()
	defer db.Exec("DELETE FROM conversation WHERE id=?", slowRoom)
	add(slowRoom)
	cfg.Concurrency = 2
	isolated := newWorker(db, blockedRedis, cfg, newMetrics())
	isolationCtx, stopIsolation := context.WithCancel(ctx)
	isolated.start(isolationCtx)
	defer func() { close(hook.release); stopIsolation(); isolated.wg.Wait() }()
	select {
	case <-hook.entered:
	case <-time.After(3 * time.Second):
		t.Fatal("slow delivery did not start")
	}
	for i := 0; i < 8; i++ {
		room := makeRoom()
		defer db.Exec("DELETE FROM conversation WHERE id=?", room)
		message := add(room)
		isolated.wake()
		until := time.Now().Add(2 * time.Second)
		for {
			var delivered int
			if err := db.QueryRow("SELECT delivered_at IS NOT NULL FROM message_outbox WHERE message_id=?", message).Scan(&delivered); err != nil {
				t.Fatal(err)
			}
			if delivered == 1 {
				break
			}
			if time.Now().After(until) {
				t.Fatal("wake stranded an independent room behind a busy lane")
			}
			time.Sleep(5 * time.Millisecond)
		}
	}
}

type blockFirstPublish struct {
	blocked          atomic.Bool
	entered, release chan struct{}
}

func (h *blockFirstPublish) DialHook(next redis.DialHook) redis.DialHook {
	return func(ctx context.Context, network, addr string) (net.Conn, error) { return next(ctx, network, addr) }
}
func (h *blockFirstPublish) ProcessPipelineHook(next redis.ProcessPipelineHook) redis.ProcessPipelineHook {
	return next
}
func (h *blockFirstPublish) ProcessHook(next redis.ProcessHook) redis.ProcessHook {
	return func(ctx context.Context, cmd redis.Cmder) error {
		if cmd.Name() == "publish" && h.blocked.CompareAndSwap(false, true) {
			close(h.entered)
			select {
			case <-h.release:
			case <-ctx.Done():
				return ctx.Err()
			}
		}
		return next(ctx, cmd)
	}
}
