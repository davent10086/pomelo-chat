package main

import (
	"database/sql"
	"fmt"
	"net"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/go-sql-driver/mysql"
	"github.com/redis/go-redis/v9"
)

type Config struct {
	Role, Listen, NodeURL, InternalToken, JWTSecret, Prefix, MetricsToken string
	Origins                                                               map[string]bool
	Concurrency, QueueSize, RoomQueue, MaxConnections, LeaseSeconds       int
	Poll                                                                  time.Duration
}

func env(name, fallback string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return fallback
}
func setting(name string, fallback, max int) (int, error) {
	n, e := strconv.Atoi(env(name, strconv.Itoa(fallback)))
	if e != nil || n < 1 || n > max {
		return 0, fmt.Errorf("invalid %s", name)
	}
	return n, nil
}
func loadConfig(role string) (Config, error) {
	c := Config{Role: role, Listen: env("GO_REALTIME_ADDR", ":3000"), NodeURL: env("NODE_INTERNAL_URL", "http://127.0.0.1:3001"),
		InternalToken: os.Getenv("REALTIME_INTERNAL_TOKEN"), JWTSecret: os.Getenv("JWT_SECRET"), Prefix: os.Getenv("REDIS_KEY_PREFIX"), MetricsToken: os.Getenv("METRICS_TOKEN"), Origins: map[string]bool{}}
	if role != "gateway" && role != "worker" && role != "all" {
		return c, fmt.Errorf("role must be gateway, worker or all")
	}
	if len(c.InternalToken) < 32 {
		return c, fmt.Errorf("REALTIME_INTERNAL_TOKEN must contain at least 32 characters")
	}
	if c.JWTSecret == "" && role != "worker" {
		return c, fmt.Errorf("JWT_SECRET is required")
	}
	u, e := url.Parse(c.NodeURL)
	if e != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return c, fmt.Errorf("invalid NODE_INTERNAL_URL")
	}
	c.NodeURL = strings.TrimRight(c.NodeURL, "/")
	if _, _, e = net.SplitHostPort(c.Listen); e != nil {
		return c, fmt.Errorf("invalid GO_REALTIME_ADDR")
	}
	for _, s := range strings.Split(env("CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173,http://localhost:3000,http://127.0.0.1:3000,pomelo://app"), ",") {
		c.Origins[strings.TrimSpace(s)] = true
	}
	for _, item := range []struct {
		name          string
		target        *int
		fallback, max int
	}{
		{"OUTBOX_CONCURRENCY", &c.Concurrency, 8, 128}, {"GO_SOCKET_QUEUE", &c.QueueSize, 128, 4096},
		{"GO_ROOM_QUEUE", &c.RoomQueue, 256, 8192}, {"GO_MAX_CONNECTIONS", &c.MaxConnections, 20000, 1000000},
		{"OUTBOX_LEASE_SECONDS", &c.LeaseSeconds, 60, 3600},
	} {
		*item.target, e = setting(item.name, item.fallback, item.max)
		if e != nil {
			return c, e
		}
	}
	poll, e := setting("OUTBOX_POLL_MS", 2000, 60000)
	c.Poll = time.Duration(poll) * time.Millisecond
	return c, e
}
func openRedis() (*redis.Client, error) {
	var opt *redis.Options
	var e error
	if raw := os.Getenv("REDIS_URL"); raw != "" {
		opt, e = redis.ParseURL(raw)
		if e != nil {
			return nil, fmt.Errorf("invalid REDIS_URL")
		}
	} else {
		port, err := setting("REDIS_PORT", 6379, 65535)
		if err != nil {
			return nil, err
		}
		db, err := strconv.Atoi(env("REDIS_DB", "0"))
		if err != nil || db < 0 {
			return nil, fmt.Errorf("invalid REDIS_DB")
		}
		opt = &redis.Options{Addr: net.JoinHostPort(env("REDIS_HOST", "127.0.0.1"), strconv.Itoa(port)), Password: os.Getenv("REDIS_PASSWORD"), DB: db}
	}
	opt.DialTimeout = 3 * time.Second
	opt.ReadTimeout = 3 * time.Second
	opt.WriteTimeout = 3 * time.Second
	opt.MaxRetries = 1
	opt.ClientName = os.Getenv("REDIS_KEY_PREFIX") + "pomelo-go-" + randomID()
	return redis.NewClient(opt), nil
}
func openDatabase() (*sql.DB, error) {
	cfg := mysql.NewConfig()
	cfg.User = env("DB_USER", "root")
	cfg.Passwd = os.Getenv("DB_PASSWORD")
	cfg.Net = "tcp"
	cfg.Addr = net.JoinHostPort(env("DB_HOST", "127.0.0.1"), env("DB_PORT", "3306"))
	cfg.DBName = env("DB_NAME", "pomelo-chat")
	if raw := env("DATABASE_URL_TEST", os.Getenv("TEST_DATABASE_URL")); raw != "" {
		u, e := url.Parse(raw)
		if e != nil || u.Scheme != "mysql" || u.User == nil {
			return nil, fmt.Errorf("invalid DATABASE_URL_TEST")
		}
		cfg.User = u.User.Username()
		cfg.Passwd, _ = u.User.Password()
		cfg.Addr = net.JoinHostPort(u.Hostname(), envURLPort(u, "3306"))
		cfg.DBName = strings.TrimPrefix(u.Path, "/")
	}
	if (os.Getenv("DATABASE_URL_TEST") != "" || os.Getenv("TEST_DATABASE_URL") != "" || os.Getenv("NODE_ENV") == "test" || os.Getenv("APP_ENV") == "test") &&
		!regexp.MustCompile(`(?i)(^|[_-])test([_-]|$)|[_-]test$`).MatchString(cfg.DBName) {
		return nil, fmt.Errorf("refusing non-test database")
	}
	cfg.Timeout = 3 * time.Second
	cfg.ReadTimeout = 5 * time.Second
	cfg.WriteTimeout = 5 * time.Second
	cfg.Collation = "utf8mb4_unicode_ci"
	connector, e := mysql.NewConnector(cfg)
	if e != nil {
		return nil, fmt.Errorf("invalid database configuration")
	}
	db := sql.OpenDB(connector)
	db.SetMaxOpenConns(12)
	db.SetMaxIdleConns(12)
	db.SetConnMaxLifetime(3 * time.Minute)
	return db, nil
}
func envURLPort(u *url.URL, fallback string) string {
	if u.Port() != "" {
		return u.Port()
	}
	return fallback
}
