package main

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math"
	"strconv"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

func randomID() string {
	var b [16]byte
	if _, e := rand.Read(b[:]); e != nil {
		panic(e)
	}
	return hex.EncodeToString(b[:])
}

type Worker struct {
	db       *sql.DB
	redis    *redis.Client
	cfg      Config
	metrics  *Metrics
	wakes    chan struct{}
	wg       sync.WaitGroup
	instance string
}

func newWorker(db *sql.DB, r *redis.Client, c Config, m *Metrics) *Worker {
	return &Worker{db: db, redis: r, cfg: c, metrics: m, instance: "go-worker-" + randomID(), wakes: make(chan struct{}, c.Concurrency)}
}
func (w *Worker) wake() {
	// A wake means work may exist, not that every lane needs an empty SQL scan.
	// Claiming a real row activates another lane so backlogs still fan out.
	// Idle lanes compete for a shared bounded signal. Never target a busy lane:
	// one slow delivery must not strand another room while idle lanes exist.
	select {
	case w.wakes <- struct{}{}:
	default:
	}
}
func (w *Worker) start(ctx context.Context) {
	for i := 0; i < w.cfg.Concurrency; i++ {
		w.wg.Add(1)
		go func() {
			defer w.wg.Done()
			timer := time.NewTicker(w.cfg.Poll)
			defer timer.Stop()
			for {
				select {
				case <-ctx.Done():
					return
				case <-w.wakes:
				case <-timer.C:
				}
				for ctx.Err() == nil {
					ok, e := w.one(ctx)
					if e != nil {
						w.metrics.add("pomelo_outbox_scan_errors_total", 1)
						log.Print("outbox scan failed")
						break
					}
					if !ok {
						break
					}
				}
			}
		}()
	}
	w.wake()
}
func (w *Worker) claim(ctx context.Context) (int64, string, error) {
	w.metrics.add("pomelo_outbox_claim_scans_total", 1)
	tx, e := w.db.BeginTx(ctx, nil)
	if e != nil {
		return 0, "", e
	}
	defer tx.Rollback()
	var id int64
	e = tx.QueryRowContext(ctx, `SELECT o.message_id FROM message_outbox o FORCE INDEX (idx_outbox_pending)
 WHERE o.delivered_at IS NULL AND o.next_attempt_at <= NOW()
 AND (o.lease_until IS NULL OR o.lease_until <= NOW())
 AND NOT EXISTS (SELECT 1 FROM message_outbox previous FORCE INDEX (idx_outbox_room_pending)
 WHERE previous.conversation_id=o.conversation_id AND previous.delivered_at IS NULL
 AND previous.message_id < o.message_id)
 ORDER BY o.next_attempt_at,o.message_id LIMIT 1 FOR UPDATE SKIP LOCKED`).Scan(&id)
	if errors.Is(e, sql.ErrNoRows) {
		w.metrics.add("pomelo_outbox_empty_scans_total", 1)
		return 0, "", nil
	}
	if e != nil {
		return 0, "", e
	}
	token := randomID()
	_, e = tx.ExecContext(ctx, "UPDATE message_outbox SET claim_token=?,lease_until=DATE_ADD(NOW(),INTERVAL ? SECOND) WHERE message_id=?", token, w.cfg.LeaseSeconds, id)
	if e != nil {
		return 0, "", e
	}
	if e = tx.Commit(); e != nil {
		return 0, "", e
	}
	return id, token, nil
}
func (w *Worker) renew(ctx context.Context, id int64, token string) error {
	// Never revive an already expired claim, even if nobody else has claimed it yet.
	result, e := w.db.ExecContext(ctx, `UPDATE message_outbox SET lease_until=DATE_ADD(NOW(),INTERVAL ? SECOND)
 WHERE message_id=? AND claim_token=? AND delivered_at IS NULL AND lease_until>NOW()`, w.cfg.LeaseSeconds, id, token)
	if e != nil {
		return e
	}
	n, e := result.RowsAffected()
	if e != nil {
		return e
	}
	// MySQL reports changed rows; renewal in the same second can legitimately change nothing.
	if n == 0 {
		var owned int
		e = w.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM message_outbox WHERE message_id=? AND claim_token=? AND delivered_at IS NULL AND lease_until>NOW()", id, token).Scan(&owned)
		if e != nil {
			return e
		}
		if owned != 1 {
			return fmt.Errorf("claim lost")
		}
	}
	return nil
}
func (w *Worker) finish(ctx context.Context, id int64, token string, success bool) error {
	query := `UPDATE message_outbox SET delivered_at=NOW(),claim_token=NULL,lease_until=NULL
 WHERE message_id=? AND claim_token=? AND delivered_at IS NULL AND lease_until>NOW()`
	if !success {
		query = `UPDATE message_outbox SET attempts=attempts+1,
 next_attempt_at=DATE_ADD(NOW(),INTERVAL LEAST(60,POW(2,LEAST(attempts,6))) SECOND),
 claim_token=NULL,lease_until=NULL WHERE message_id=? AND claim_token=? AND delivered_at IS NULL AND lease_until>NOW()`
	}
	result, e := w.db.ExecContext(ctx, query, id, token)
	if e != nil {
		return e
	}
	n, e := result.RowsAffected()
	if e == nil && n != 1 {
		return fmt.Errorf("claim lost")
	}
	return e
}
func (w *Worker) one(ctx context.Context) (bool, error) {
	id, token, e := w.claim(ctx)
	if e != nil || id == 0 {
		return false, e
	}
	w.wake()
	delivery, cancel := context.WithCancel(ctx)
	defer cancel()
	done := make(chan struct{})
	go func() {
		defer close(done)
		t := time.NewTicker(time.Duration(w.cfg.LeaseSeconds) * time.Second / 3)
		defer t.Stop()
		for {
			select {
			case <-delivery.Done():
				return
			case <-t.C:
				if w.renew(delivery, id, token) != nil {
					cancel()
					return
				}
			}
		}
	}()
	e = w.deliver(delivery, id, token)
	cancel()
	<-done
	finalCtx, stop := context.WithTimeout(context.Background(), 5*time.Second)
	defer stop()
	if e != nil {
		w.metrics.add("pomelo_outbox_dispatch_errors_total", 1)
		_ = w.finish(finalCtx, id, token, false)
	} else if e = w.finish(finalCtx, id, token, true); e == nil {
		w.metrics.add("pomelo_outbox_dispatch_completed_total", 1)
	} else {
		w.metrics.add("pomelo_outbox_claim_lost_total", 1)
	}
	return true, nil
}

type Message struct {
	ID       int64   `json:"id"`
	ClientID *string `json:"client_msg_id"`
	Seq      int64   `json:"room_seq"`
	Sender   int64   `json:"sender_id"`
	Receiver int64   `json:"receiver_id"`
	Content  string  `json:"content"`
	Room     string  `json:"room"`
	Avatar   *string `json:"avatar"`
	Type     string  `json:"type"`
	FileSize string  `json:"file_size"`
	Created  string  `json:"created_at"`
}
type Fanout struct {
	Version     int             `json:"version,omitempty"`
	Instance    string          `json:"instanceId"`
	Room        string          `json:"room"`
	Message     json.RawMessage `json:"message"`
	PersistedAt int64           `json:"persistedAt,omitempty"`
}

func formatBytes(n float64) string {
	if n <= 0 || math.IsNaN(n) || math.IsInf(n, 0) {
		return "0B"
	}
	units := []string{"B", "K", "M", "G", "T", "P", "E", "Z", "Y"}
	i := int(math.Floor(math.Log(n) / math.Log(1024)))
	if i >= len(units) {
		i = len(units) - 1
	}
	return strconv.FormatFloat(math.Round(n/math.Pow(1024, float64(i))*100)/100, 'f', -1, 64) + units[i]
}
func formatCreated(ms int64) string {
	return time.UnixMilli(ms).In(time.FixedZone("Asia/Shanghai", 8*3600)).Format("2006/1/2 15:04:05")
}
func (w *Worker) deliver(ctx context.Context, id int64, token string) error {
	var m Message
	var typ string
	var size float64
	var stamp float64
	e := w.db.QueryRowContext(ctx, `SELECT m.id,m.client_msg_id,m.room_seq,m.sender_id,m.receiver_id,m.content,m.room,u.avatar,m.media_type,m.file_size,UNIX_TIMESTAMP(m.created_at)*1000,m.type
 FROM message m LEFT JOIN user u ON u.id=m.sender_id WHERE m.id=?`, id).Scan(&m.ID, &m.ClientID, &m.Seq, &m.Sender, &m.Receiver, &m.Content, &m.Room, &m.Avatar, &m.Type, &size, &stamp, &typ)
	if e != nil {
		return e
	}
	if m.Seq == 0 {
		m.Seq = m.ID
	}
	m.FileSize = formatBytes(size)
	m.Created = formatCreated(int64(stamp))
	raw, e := json.Marshal(m)
	if e != nil {
		return e
	}
	event, e := json.Marshal(Fanout{1, w.instance, m.Room, raw, int64(stamp)})
	if e != nil {
		return e
	}
	if e = w.renew(ctx, id, token); e != nil {
		return e
	}
	if e = w.redis.Publish(ctx, w.cfg.Prefix+"pomelo:message:fanout", event).Err(); e != nil {
		return e
	}
	query := "SELECT username FROM user WHERE id=?"
	args := []any{m.Receiver}
	if typ == "group" {
		query = "SELECT u.username FROM group_members gm JOIN user u ON u.id=gm.user_id WHERE gm.group_id=? AND gm.user_id<>?"
		args = append(args, m.Sender)
	}
	rows, e := w.db.QueryContext(ctx, query, args...)
	if e != nil {
		return e
	}
	var recipients []string
	for rows.Next() {
		var username string
		if e = rows.Scan(&username); e != nil {
			rows.Close()
			return e
		}
		recipients = append(recipients, username)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return e
	}
	// Release the read connection before lease updates; high worker concurrency must
	// not deadlock the pool by holding one connection while requesting another.
	for start := 0; start < len(recipients); start += 32 {
		if e = w.renew(ctx, id, token); e != nil {
			return e
		}
		end := start + 32
		if end > len(recipients) {
			end = len(recipients)
		}
		pipe := w.redis.Pipeline()
		for _, username := range recipients[start:end] {
			data := map[string]any{"name": "chatList"}
			if typ == "group" {
				data["receiver_username"] = username
			} else {
				data["receiver_id"] = m.Receiver
			}
			payload, _ := json.Marshal(map[string]any{"version": 1, "instance": w.instance, "username": username, "data": data})
			pipe.Publish(ctx, w.cfg.Prefix+"pomelo:notifications", payload)
		}
		if _, e = pipe.Exec(ctx); e != nil {
			return e
		}
	}
	return nil
}
func (w *Worker) sample(ctx context.Context) {
	var pending int64
	var age float64
	if e := w.db.QueryRowContext(ctx, "SELECT COUNT(*),COALESCE(MAX(TIMESTAMPDIFF(SECOND,m.created_at,NOW())),0) FROM message_outbox o JOIN message m ON m.id=o.message_id WHERE o.delivered_at IS NULL").Scan(&pending, &age); e == nil {
		w.metrics.set("pomelo_outbox_sample_healthy", 1)
		w.metrics.set("pomelo_outbox_sample_timestamp_seconds", float64(time.Now().Unix()))
		w.metrics.set("pomelo_outbox_pending", float64(pending))
		w.metrics.set("pomelo_outbox_oldest_seconds", age)
	} else {
		w.metrics.set("pomelo_outbox_sample_healthy", 0)
	}
}
