// Command server starts the SHARD blind relay: an in-memory,
// zero-persistence WebSocket rendezvous for exactly two peers per room.
// No databases. No access logs with payloads or IPs — only anonymous
// room lifecycle events by room ID.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	"golang.org/x/time/rate"

	"shard-backend/internal/httpx"
	"shard-backend/internal/room"
	"shard-backend/internal/turn"
	"shard-backend/internal/ws"
)

// ttlWhitelist mirrors the frontend TTL dropdown: 30m, 2h, 24h (in minutes).
var ttlWhitelist = map[int]bool{30: true, 120: true, 1440: true}

// shutdownGrace is how long in-flight HTTP work may finish after SIGTERM
// before the process exits anyway. Long enough for a TURN credential fetch,
// short enough to stay inside Render's deploy window.
const shutdownGrace = 10 * time.Second

// Room creation is capped per client IP. Limiters are grown lazily and the map
// itself is capped, so a flooded /24 cannot balloon memory without bound.
const (
	roomsPerMinute     = 5
	roomBurst          = 5
	maxTrackedCreators = 8192
)

type creatorLimiter struct {
	mu      sync.Mutex
	limit   rate.Limit
	burst   int
	maxN    int
	entries map[string]*rate.Limiter
}

func newCreatorLimiter(limit rate.Limit, burst, maxN int) *creatorLimiter {
	return &creatorLimiter{limit: limit, burst: burst, maxN: maxN, entries: make(map[string]*rate.Limiter)}
}

// allow reports whether one more room may be minted for this key.
func (l *creatorLimiter) allow(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	lim, ok := l.entries[key]
	if !ok {
		if len(l.entries) >= l.maxN {
			// Map full: evict an arbitrary entry. Rate limiting stays
			// approximate under abuse - by design.
			for k := range l.entries {
				delete(l.entries, k)
				break
			}
		}
		lim = rate.NewLimiter(l.limit, l.burst)
		l.entries[key] = lim
	}
	return lim.Allow()
}

// clientKey derives the rate-limit key: the real client IP without port.
//
// Behind a trusted proxy (Render, or any reverse proxy) the edge APPENDS the address it
// actually saw to the right of X-Forwarded-For. The left-most entry is whatever
// the client sent, so keying on it let anyone bypass the limiter with one forged
// header; the right-most entry is written by our own edge and is the only one
// we trust. Without a proxy the header is absent and the socket address is used.
func clientKey(r *http.Request) string {
	if fwd := r.Header.Get("X-Forwarded-For"); fwd != "" {
		parts := strings.Split(fwd, ",")
		last := strings.TrimSpace(parts[len(parts)-1])
		if last != "" {
			if host, _, err := net.SplitHostPort(last); err == nil {
				return host
			}
			return last
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// listenAddr resolves the bind address.
//
// PORT wins over SHARD_ADDR on purpose: Render (and most PaaS providers) always
// inject PORT, and their edge routes to exactly that port. Honouring it first
// means the relay binds where the platform expects on the first boot instead of
// silently listening on 8080 and being unreachable. Locally there is no PORT,
// so SHARD_ADDR applies and ":8080" is the last resort.
func listenAddr() string {
	if port := strings.TrimSpace(os.Getenv("PORT")); port != "" {
		return ":" + strings.TrimPrefix(port, ":")
	}
	if addr := strings.TrimSpace(os.Getenv("SHARD_ADDR")); addr != "" {
		return addr
	}
	return ":8080"
}

func main() {
	addr := listenAddr()
	// Strict comma-separated allow-list of browser origins. When unset,
	// the relay runs in DEV MODE (loopback origins only) and warns loudly.
	origin := envOr("ALLOWED_ORIGINS", os.Getenv("SHARD_ALLOWED_ORIGIN"))
	if origin == "" {
		log.Printf("[shard-relay] ALLOWED_ORIGINS is not set — DEV MODE: only loopback (localhost/127.0.0.1) origins are accepted; set ALLOWED_ORIGINS=https://your.domain for production")
	}

	manager := room.NewRoomManager()
	wsHandler := &ws.Handler{Manager: manager, Upgrader: ws.NewUpgrader(origin)}

	creatorLimits := newCreatorLimiter(rate.Every(time.Minute/roomsPerMinute), roomBurst, maxTrackedCreators)

	mux := http.NewServeMux()

	// REST: create a disposable session (rate-limited per IP, global ceiling).
	mux.HandleFunc("POST /api/rooms", func(w http.ResponseWriter, r *http.Request) {
		if !creatorLimits.allow(clientKey(r)) {
			writeJSON(w, http.StatusTooManyRequests, map[string]string{"error": "Too many sessions created. Try again in a minute."})
			return
		}
		var req struct {
			TTLMinutes int `json:"ttlMinutes"`
		}
		body, err := io.ReadAll(io.LimitReader(r.Body, 4096))
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "unreadable body"})
			return
		}
		if len(body) > 0 {
			if err := json.Unmarshal(body, &req); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
				return
			}
		}
		if req.TTLMinutes == 0 {
			req.TTLMinutes = 30
		}
		if !ttlWhitelist[req.TTLMinutes] {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "ttlMinutes must be 30, 120 or 1440"})
			return
		}

		rm, err := wsHandler.CreateRoom(time.Duration(req.TTLMinutes) * time.Minute)
		if err != nil {
			if errors.Is(err, room.ErrRoomLimit) {
				// At capacity a 503 lets well-behaved clients back off; the log stays
				// anonymous (no IPs, no payloads).
				log.Printf("[shard-relay/rooms] creation refused: room ceiling reached")
				writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "Server is at capacity. Try again later."})
				return
			}
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "session creation failed"})
			return
		}
		writeJSON(w, http.StatusCreated, map[string]any{
			"roomId":    rm.ID,
			"expiresAt": rm.ExpiresAt().UTC().Format(time.RFC3339),
		})
	})

	// WS: join a session as one of exactly two peers.
	mux.HandleFunc("GET /ws/{roomId}", wsHandler.ServeWS)

	// Room existence probe: lets a stuck client distinguish "waiting for
	// peer" from "room burned / server restarted" and stop reconnecting.
	// Existence + occupancy only.
	mux.HandleFunc("GET /api/rooms/{roomId}", func(w http.ResponseWriter, r *http.Request) {
		rm, ok := manager.GetRoom(r.PathValue("roomId"))
		if !ok {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "Room not found or already burned."})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"peerCount": rm.ClientCount(),
			"expiresAt": rm.ExpiresAt().UTC().Format(time.RFC3339),
		})
	})

	// TURN: short-lived ICE servers. The API key never leaves Go.
	mux.HandleFunc("GET /api/turn-credentials", func(w http.ResponseWriter, r *http.Request) {
		body, status := turn.CredentialsJSON()
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(status)
		_, _ = w.Write(body)
	})

	// Health: anonymous operational status only.
	mux.HandleFunc("HEAD /healthz", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{
			"status":    "ok",
			"liveRooms": manager.LiveRooms(),
			"liveConns": manager.LiveConns(),
			"maxConns":  room.MaxConns,
		})
	})

	// SPA static assets from frontend/dist (same process, same origin —
	// the browser sees one deployable service on Render).
	staticRoot := envOr("SHARD_STATIC", "../frontend/dist")
	mux.Handle("GET /assets/", http.StripPrefix("/assets/", http.FileServer(http.Dir(staticRoot+"/assets"))))
	mux.HandleFunc("GET /{$}", func(w http.ResponseWriter, r *http.Request) {
		http.ServeFile(w, r, staticRoot+"/index.html")
	})
	mux.HandleFunc("GET /", spaFallback(staticRoot))

	originLabel := origin
	if originLabel == "" {
		originLabel = "dev-loopback"
	}
	log.Printf("[shard-relay] SHARD blind relay on %s (origins: %s) — zero persistence, zero content logs", addr, originLabel)
	srv := &http.Server{
		Addr:              addr,
		Handler:           httpx.SecurityHeaders(withCORS(origin, httpx.Recover(mux))),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
		// ReadTimeout: without it a client can drip the body of POST /api/rooms
		// forever and pin a goroutine + connection per attempt. WebSockets are
		// unaffected - gorilla clears the hijacked connection's deadlines during
		// Upgrade (gorilla/websocket v1.5.3 server.go).
		ReadTimeout: 30 * time.Second,
		// Well below net/http's 1 MB default: this process multiplexes thousands
		// of sockets and never needs megabyte headers.
		MaxHeaderBytes: 16 << 10,
		// Deliberately no WriteTimeout: it would kill long-lived WS connections.
	}

	// Render and other PaaS platforms signal SIGTERM before a redeploy. Exiting on it
	// would drop every live socket without a goodbye; instead every room is told
	// the session is over (ROOM_BURNED + close frame, the same path a manual burn
	// takes) and in-flight HTTP drains inside a grace window.
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		log.Printf("[shard-relay] shutdown signal received — closing %d room(s)", manager.LiveRooms())
		manager.CloseAll(room.ReasonShutdown)
		shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownGrace)
		defer cancel()
		if err := srv.Shutdown(shutdownCtx); err != nil {
			log.Printf("[shard-relay] graceful shutdown timed out: %v", err)
		}
	}()

	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
	log.Printf("[shard-relay] stopped cleanly")
}

// spaFallback serves index.html for client-side routes (/room/:id) that
// have no file on disk. Without it a hard refresh inside a room would 404.
func spaFallback(root string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		http.ServeFile(w, r, root+"/index.html")
	}
}

func withCORS(allowedSpec string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if httpx.OriginAllowed(origin, allowedSpec) {
			if origin != "" {
				w.Header().Set("Access-Control-Allow-Origin", origin)
			} else {
				w.Header().Set("Access-Control-Allow-Origin", firstOrigin(allowedSpec))
			}
			w.Header().Add("Vary", "Origin")
		}
		if r.Method == http.MethodOptions {
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func firstOrigin(spec string) string {
	for _, raw := range strings.Split(spec, ",") {
		if v := strings.TrimSpace(raw); v != "" {
			return v
		}
	}
	return "*"
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
