package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/redis/go-redis/v9"
)

type Actor struct {
	ID              string
	Username, Token string
}
type Bridge struct {
	url, secret string
	client      *http.Client
	metrics     *Metrics
}

func newBridge(c Config, metrics *Metrics) *Bridge {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.MaxIdleConns = 128
	transport.MaxIdleConnsPerHost = 64
	transport.MaxConnsPerHost = 64
	transport.IdleConnTimeout = time.Minute
	transport.ResponseHeaderTimeout = 10 * time.Second
	return &Bridge{strings.TrimRight(c.NodeURL, "/"), c.InternalToken, &http.Client{Transport: transport, Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}, metrics}
}
func (b *Bridge) call(ctx context.Context, op string, input any) (json.RawMessage, int, error) {
	started := time.Now()
	defer func() {
		b.metrics.observe("pomelo_bridge_"+strings.ReplaceAll(op, "-", "_")+"_seconds", time.Since(started).Seconds())
	}()
	data, e := json.Marshal(input)
	if e != nil {
		return nil, 0, e
	}
	req, e := http.NewRequestWithContext(ctx, "POST", b.url+"/internal/realtime/"+op, bytes.NewReader(data))
	if e != nil {
		return nil, 0, e
	}
	req.Header.Set("Authorization", "Bearer "+b.secret)
	req.Header.Set("Content-Type", "application/json")
	res, e := b.client.Do(req)
	if e != nil {
		return nil, 0, fmt.Errorf("business service unavailable")
	}
	defer res.Body.Close()
	data, e = io.ReadAll(io.LimitReader(res.Body, (2<<20)+1))
	if len(data) > 2<<20 {
		return nil, res.StatusCode, fmt.Errorf("business response exceeds limit")
	}
	return data, res.StatusCode, e
}
func (b *Bridge) authorize(ctx context.Context, a Actor, room, typ string) bool {
	_, s, e := b.call(ctx, "authorize", map[string]any{"token": a.Token, "room": room, "type": typ})
	return e == nil && s == 200
}
func authenticate(ctx context.Context, rdb *redis.Client, c Config, token string) (Actor, error) {
	a := Actor{Token: strings.TrimPrefix(token, "Bearer ")}
	parsed, e := jwt.Parse(a.Token, func(*jwt.Token) (any, error) { return []byte(c.JWTSecret), nil }, jwt.WithValidMethods([]string{"HS256", "HS384", "HS512"}), jwt.WithJSONNumber())
	if e != nil || !parsed.Valid {
		return a, fmt.Errorf("unauthorized")
	}
	claims, ok := parsed.Claims.(jwt.MapClaims)
	if !ok {
		return a, fmt.Errorf("unauthorized")
	}
	a.Username, ok = claims["username"].(string)
	if !ok || a.Username == "" {
		return a, fmt.Errorf("unauthorized")
	}
	switch id := claims["id"].(type) {
	case json.Number:
		a.ID = id.String()
	case string:
		a.ID = id
	default:
		return a, fmt.Errorf("unauthorized")
	}
	if a.ID == "" {
		return a, fmt.Errorf("unauthorized")
	}
	saved, e := rdb.Get(ctx, c.Prefix+"token:"+a.Username).Result()
	if e != nil || saved != a.Token {
		return a, fmt.Errorf("unauthorized")
	}
	return a, nil
}
