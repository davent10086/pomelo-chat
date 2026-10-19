package main

import (
	"context"
	"database/sql"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

func main() {
	role := flag.String("role", env("GO_REALTIME_ROLE", "all"), "gateway, worker or all")
	flag.Parse()
	if e := run(*role); e != nil {
		log.Print(e)
		os.Exit(1)
	}
}
func run(role string) error {
	cfg, e := loadConfig(role)
	if e != nil {
		return e
	}
	rdb, e := openRedis()
	if e != nil {
		return e
	}
	defer rdb.Close()
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	startup, stop := context.WithTimeout(ctx, 10*time.Second)
	defer stop()
	if rdb.Ping(startup).Err() != nil {
		return fmt.Errorf("Redis unavailable")
	}
	var db *sql.DB
	var worker *Worker
	metrics := newMetrics()
	if role != "worker" {
		metrics.set("pomelo_realtime_role_gateway", 1)
	}
	if role != "gateway" {
		metrics.set("pomelo_realtime_role_worker", 1)
	}
	if role != "gateway" {
		db, e = openDatabase()
		if e != nil {
			return e
		}
		defer db.Close()
		if db.PingContext(startup) != nil {
			return fmt.Errorf("MySQL unavailable")
		}
		var columns int
		if db.QueryRowContext(startup, "SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='message_outbox' AND column_name IN ('conversation_id','claim_token','lease_until')").Scan(&columns) != nil || columns != 3 {
			return fmt.Errorf("run Node.js database migrations before starting the worker")
		}
		worker = newWorker(db, rdb, cfg, metrics)
	}
	var dataReady, controlReady, wakeReady atomic.Bool
	var gateway *Gateway
	if role != "worker" {
		gateway = newGateway(ctx, cfg, rdb, metrics, &dataReady)
		gateway.controlReady = &controlReady
	}
	var background sync.WaitGroup
	startSubscription := func(channels []string, ready *atomic.Bool, restored func(), handler func(string, string)) {
		background.Add(1)
		go func() { defer background.Done(); subscribe(ctx, rdb, channels, ready, restored, handler) }()
	}
	if gateway != nil {
		startSubscription([]string{cfg.Prefix + "pomelo:message:fanout", cfg.Prefix + "pomelo:notifications"}, &dataReady, gateway.resync, gateway.onMessage)
		startSubscription([]string{cfg.Prefix + "pomelo:session:changed", cfg.Prefix + "pomelo:presence:changed", cfg.Prefix + "pomelo:room:access"}, &controlReady,
			func() { /* missed control events are covered by send-time and heartbeat checks */ }, gateway.onMessage)
	}
	if worker != nil {
		startSubscription([]string{cfg.Prefix + "pomelo:outbox:wake"}, &wakeReady, worker.wake, func(string, string) { worker.wake() })
	}
	if gateway != nil {
		background.Add(1)
		go func() { defer background.Done(); gateway.maintain(ctx) }()
	}
	if worker != nil {
		worker.start(ctx)
		background.Add(1)
		go func() {
			defer background.Done()
			t := time.NewTicker(2 * time.Second)
			defer t.Stop()
			for {
				worker.sample(ctx)
				select {
				case <-ctx.Done():
					return
				case <-t.C:
				}
			}
		}()
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/internal/live", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"service":"pomelo-realtime","live":true}`))
	})
	mux.HandleFunc("/internal/ready", func(w http.ResponseWriter, r *http.Request) {
		check, end := context.WithTimeout(r.Context(), 2*time.Second)
		defer end()
		ready := ctx.Err() == nil && rdb.Ping(check).Err() == nil
		if gateway != nil {
			ready = ready && dataReady.Load() && controlReady.Load()
		}
		if worker != nil {
			ready = ready && wakeReady.Load()
		}
		if ready && db != nil {
			ready = db.PingContext(check) == nil
		}
		if ready && gateway != nil {
			_, status, err := gateway.bridge.call(check, "ready", map[string]any{})
			ready = err == nil && status == 200
		}
		if !ready {
			http.Error(w, "not ready", 503)
			return
		}
		w.WriteHeader(200)
	})
	mux.HandleFunc("/internal/metrics", func(w http.ResponseWriter, r *http.Request) {
		for name, flag := range map[string]*atomic.Bool{"data": &dataReady, "control": &controlReady, "wake": &wakeReady} {
			value := 0.0
			if flag.Load() {
				value = 1
			}
			metrics.set("pomelo_realtime_"+name+"_subscription_ready", value)
		}
		metrics.serve(cfg.MetricsToken, w, r)
	})
	if gateway != nil {
		mux.Handle("/", gateway)
	} else {
		mux.HandleFunc("/", http.NotFound)
	}
	listener, e := net.Listen("tcp", cfg.Listen)
	if e != nil {
		cancel()
		background.Wait()
		if worker != nil {
			worker.wg.Wait()
		}
		return fmt.Errorf("cannot listen on configured address")
	}
	server := &http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 32 << 10}
	errs := make(chan error, 1)
	go func() { errs <- server.Serve(listener) }()
	log.Printf("Go realtime listening on %s role=%s", listener.Addr(), role)
	select {
	case <-ctx.Done():
	case err := <-errs:
		if err != http.ErrServerClosed {
			e = err
		}
	}
	cancel()
	_ = listener.Close()
	shutdown, end := context.WithTimeout(context.Background(), 15*time.Second)
	defer end()
	_ = server.Shutdown(shutdown)
	if gateway != nil {
		gateway.shutdown()
	}
	if worker != nil {
		worker.wg.Wait()
	}
	background.Wait()
	return e
}
