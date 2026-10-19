package main

import (
	"context"
	"sync/atomic"
	"time"

	"github.com/redis/go-redis/v9"
)

// Receive subscription confirmations too: reconnect must request persisted-history recovery.
func subscribe(ctx context.Context, rdb *redis.Client, channels []string, ready *atomic.Bool, onReady func(), onMessage func(string, string)) {
	for ctx.Err() == nil {
		ps := rdb.Subscribe(ctx, channels...)
		stop := context.AfterFunc(ctx, func() { _ = ps.Close() })
		count := 0
		for ctx.Err() == nil {
			event, e := ps.Receive(ctx)
			if e != nil {
				break
			}
			switch v := event.(type) {
			case *redis.Subscription:
				count++
				if count >= len(channels) {
					ready.Store(true)
					onReady()
				}
			case *redis.Message:
				onMessage(v.Channel, v.Payload)
			}
		}
		ready.Store(false)
		stop()
		_ = ps.Close()
		select {
		case <-ctx.Done():
			return
		case <-time.After(time.Second):
		}
	}
}
