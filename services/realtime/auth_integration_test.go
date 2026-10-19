package main

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/redis/go-redis/v9"
)

func TestSessionRedisValidation(t *testing.T) {
	if os.Getenv("GO_INTEGRATION") != "1" {
		t.Skip("requires isolated Redis")
	}
	r, e := openRedis()
	if e != nil {
		t.Fatal(e)
	}
	defer r.Close()
	ctx := context.Background()
	cfg := testConfig()
	cfg.Prefix = os.Getenv("REDIS_KEY_PREFIX")
	name := "go_auth_" + randomID()
	key := cfg.Prefix + "token:" + name
	defer r.Del(ctx, key)
	for _, method := range []jwt.SigningMethod{jwt.SigningMethodHS256, jwt.SigningMethodHS384, jwt.SigningMethodHS512} {
		raw, e := jwt.NewWithClaims(method, jwt.MapClaims{"id": 7, "username": name, "exp": time.Now().Add(time.Minute).Unix()}).SignedString([]byte(cfg.JWTSecret))
		if e != nil {
			t.Fatal(e)
		}
		if e = r.Set(ctx, key, raw, time.Minute).Err(); e != nil {
			t.Fatal(e)
		}
		actor, e := authenticate(ctx, r, cfg, raw)
		if e != nil || actor.ID != "7" {
			t.Fatal("supported HMAC session rejected")
		}
		_ = r.Set(ctx, key, "revoked", time.Minute).Err()
		if _, e = authenticate(ctx, r, cfg, raw); e == nil {
			t.Fatal("revocation ignored")
		}
		_ = r.Set(ctx, key, raw, time.Minute).Err()
		dead := redis.NewClient(&redis.Options{Addr: "127.0.0.1:1", DialTimeout: 50 * time.Millisecond, MaxRetries: -1})
		if _, e = authenticate(ctx, dead, cfg, raw); e == nil {
			t.Fatal("Redis outage used a cached session")
		}
		dead.Close()
	}
	expired, _ := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{"id": 7, "username": name, "exp": time.Now().Add(-time.Minute).Unix()}).SignedString([]byte(cfg.JWTSecret))
	_ = r.Set(ctx, key, expired, time.Minute).Err()
	if _, e = authenticate(ctx, r, cfg, expired); e == nil {
		t.Fatal("expired session accepted")
	}
}
