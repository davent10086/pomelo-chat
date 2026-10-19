package main

import (
	"crypto/subtle"
	"fmt"
	"net/http"
	"runtime"
	"sort"
	"sync"
)

type Metrics struct {
	mu     sync.Mutex
	values map[string]float64
}

func newMetrics() *Metrics                    { return &Metrics{values: make(map[string]float64)} }
func (m *Metrics) add(name string, n float64) { m.mu.Lock(); m.values[name] += n; m.mu.Unlock() }
func (m *Metrics) set(name string, n float64) { m.mu.Lock(); m.values[name] = n; m.mu.Unlock() }
func (m *Metrics) observe(name string, seconds float64) {
	if seconds < 0 {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.values[name+"_sum"] += seconds
	m.values[name+"_count"]++
	for _, b := range []float64{.01, .025, .05, .1, .25, .5, 1, 2, 5, 10, 30, 60} {
		if seconds <= b {
			m.values[fmt.Sprintf("%s_bucket{le=\"%g\"}", name, b)]++
		}
	}
	m.values[name+"_bucket{le=\"+Inf\"}"]++
}
func (m *Metrics) serve(token string, w http.ResponseWriter, r *http.Request) {
	if token == "" || subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte("Bearer "+token)) != 1 {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "text/plain; version=0.0.4")
	w.Header().Set("Cache-Control", "no-store")
	var memory runtime.MemStats
	runtime.ReadMemStats(&memory)
	m.set("go_heap_alloc_bytes", float64(memory.HeapAlloc))
	m.set("go_goroutines", float64(runtime.NumGoroutine()))
	m.mu.Lock()
	defer m.mu.Unlock()
	keys := make([]string, 0, len(m.values))
	for k := range m.values {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		fmt.Fprintf(w, "%s %g\n", k, m.values[k])
	}
}
