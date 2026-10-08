// Command server is the entrypoint of shard-media: a standalone SFU
// media node for SHARD calls, in the spirit of a Discord voice node.
//
// It speaks one WebSocket signaling channel (/ws/:roomId) that carries a
// thin JSON envelope of WebRTC offers/answers/ICE candidates, and serves
// health checks on /healthz. Media itself never passes through these
// endpoints — it flows peer-to-media-node via DTLS/SRTP over ICE.
//
// Render compatibility: the free tier proxies only TCP (80/443) and blocks
// arbitrary UDP. The SettingEngine therefore enables ICE-TCP (SetICETCPMux
// + TCP network types) so media can ride the platform's TCP proxy. HTTP
// signaling owns $PORT; the raw TCP ICE mux needs its own listener, so it
// binds SHARD_TCP_PORT when provided (a Render TCP port / host mapping) and
// the engine falls back to UDP-only where UDP egress exists (local dev).
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"runtime/debug"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/gorilla/websocket"
	"github.com/pion/ice/v4"
	"github.com/pion/logging"
	"github.com/pion/webrtc/v4"

	"shard-media/internal/sfu"
)

// idleReadDeadline bounds a silent signaling socket. A client that stops
// talking for this long is presumed gone: we drop the peer and start the
// room's empty-grace countdown.
const (
	// pingReadDeadline bounds a silent signaling socket. The server pings
	// every pingInterval; a live client's automatic pong keeps resetting
	// this deadline. When it fires, the client is gone (dead tunnel, lost
	// network without a close frame) and its WebRTC resources are freed.
	pingReadDeadline = 60 * time.Second
	pingInterval     = 25 * time.Second
	writeWait        = 10 * time.Second
	maxMessageSize   = 1 << 16 // 64 KiB is generous for SDP blobs

	// gcMemoryLimit is the Go soft memory limit handed to the runtime:
	// as total memory (heap + stacks + runtime overhead) approaches this
	// ceiling the GC runs progressively harder instead of the process
	// dying or OOM-killing. It is NOT a user cap — the server accepts any
	// number of legitimate peers and scales by degrading GC laziness.
	// Tuned for a 512 MB container (Render free tier).
	gcMemoryLimit = 460 << 20
)

// The signaling WS wire format is sfu.SignalMsg: deliberately tiny and
// oblivious — the server parses SDP/ICE envelopes, never inspects media.

func env(w http.ResponseWriter, msg string, code int) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": msg})
}

func main() {
	// Soft memory ceiling for the GC (see gcMemoryLimit above). This scales
	// the garbage collector under any load instead of refusing users.
	debug.SetMemoryLimit(gcMemoryLimit)

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	addr := ":" + port

	// ---- Shared WebRTC API with ICE-TCP (Render compatibility) --------
	se := webrtc.SettingEngine{}

	// TCP mux on its own listener: $PORT belongs to HTTP signaling (the
	// edge proxy routes it), a raw TCP listener cannot be shared by two
	// owners, and STUN-over-HTTP is not a thing. SHARD_TCP_PORT gives the
	// media path an explicit home (e.g. a Render TCP port or a host port
	// mapping); unset means UDP-only — still fully functional wherever
	// UDP egress exists (local dev, bare metal).
	if tcpPort := os.Getenv("SHARD_TCP_PORT"); tcpPort != "" {
		ln, lnErr := net.Listen("tcp", ":"+tcpPort)
		if lnErr == nil {
			mux := ice.NewTCPMuxDefault(ice.TCPMuxParams{
				Listener:        ln,
				Logger:          logging.NewDefaultLoggerFactory().NewLogger("ice-tcp"),
				WriteBufferSize: 4 << 20,
			})
			se.SetICETCPMux(mux)
			se.SetNetworkTypes([]webrtc.NetworkType{
				webrtc.NetworkTypeUDP4, webrtc.NetworkTypeUDP6,
				webrtc.NetworkTypeTCP4, webrtc.NetworkTypeTCP6,
			})
			log.Printf("media: ICE-TCP mux live on :%s (Render TCP proxy compatible)", tcpPort)
		} else {
			log.Printf("media: SHARD_TCP_PORT :%s unavailable (%v) — UDP-only ICE", tcpPort, lnErr)
		}
	} else {
		log.Printf("media: SHARD_TCP_PORT unset — UDP-only ICE (set it to enable ICE-TCP, e.g. for Render's TCP proxy)")
	}

	api := webrtc.NewAPI(webrtc.WithSettingEngine(se))
	pcConfig := webrtc.Configuration{
		ICEServers: []webrtc.ICEServer{}, // LAN/cross-host deployment; no TURN needed server-side
	}
	engine := sfu.New(api, pcConfig)

	// ---- CSWSH guard: only browsers from our own frontends may upgrade -
	allowedOrigins := parseAllowedOrigins(os.Getenv("ALLOWED_ORIGINS"))
	if allowedOrigins == nil {
		log.Println("media: ALLOWED_ORIGINS unset — accepting WS connections from ANY origin (set it in production, e.g. \"https://shardchat.example\")")
	} else {
		log.Printf("media: CSWSH guard on — WS allowed from %d origin(s)", len(allowedOrigins))
	}

	// ---- HTTP surface --------------------------------------------------
	mux_http := http.NewServeMux()
	mux_http.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"status":      "ok",
			"activeCalls": engine.RoomCount(),
			"peers":       engine.PeerCount(),
		})
	})
	mux_http.HandleFunc("/ws/{roomId}", handleSignaling(engine, allowedOrigins))

	srv := &http.Server{
		Addr:              addr,
		Handler:           mux_http,
		ReadHeaderTimeout: 10 * time.Second,
	}

	// ---- Graceful shutdown on SIGINT/SIGTERM ---------------------------
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	errCh := make(chan error, 1)
	go func() {
		log.Printf("shard-media listening on %s", addr)
		errCh <- srv.ListenAndServe()
	}()

	select {
	case <-ctx.Done():
		log.Println("shard-media: signal received — draining")
	case err := <-errCh:
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("shard-media: %v", err)
		}
	}

	shCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := srv.Shutdown(shCtx); err != nil {
		log.Printf("http shutdown: %v", err)
	}
	engine.CloseAll() // every PeerConnection in every room, deterministically
	log.Println("shard-media: bye")
}

// parseAllowedOrigins reads ALLOWED_ORIGINS (comma-separated; entries may
// carry a scheme, which is ignored — only host[:port] is matched). A nil map
// means "no guard": dev convenience, never a production posture.
func parseAllowedOrigins(raw string) map[string]bool {
	if strings.TrimSpace(raw) == "" {
		return nil
	}
	set := make(map[string]bool)
	for _, entry := range strings.Split(raw, ",") {
		host := strings.TrimSpace(entry)
		if host == "" {
			continue
		}
		if i := strings.Index(host, "://"); i >= 0 {
			host = host[i+3:]
		}
		host = strings.TrimSuffix(host, "/")
		set[strings.ToLower(host)] = true
	}
	return set
}

// handleSignaling wires one browser onto one room. Protocol per socket:
//
//	client → server: {"type":"offer","sdp":...}        join + publish intent
//	server → client: {"type":"answer","sdp":...}
//	both ways:       {"type":"candidate","candidate":...} (nil => end)
func handleSignaling(engine *sfu.SFU, allowedOrigins map[string]bool) http.HandlerFunc {
	upgrader := websocket.Upgrader{
		ReadBufferSize:  4096,
		WriteBufferSize: 4096,
		// Cross-Site WebSocket Hijacking guard: a web page on any other
		// domain can open a WebSocket here and inherit the victim's ambient
		// network position, so its Origin must match our own frontends.
		// A browser ALWAYS sends Origin, so requests without one are
		// non-browser clients (scripts, smoke tests) and are accepted.
		// gorilla answers a rejected origin with 403 Forbidden.
		CheckOrigin: func(r *http.Request) bool {
			origin := r.Header.Get("Origin")
			if origin == "" {
				return true
			}
			if allowedOrigins == nil {
				return true
			}
			u, err := url.Parse(origin)
			if err != nil {
				return false
			}
			return allowedOrigins[strings.ToLower(u.Host)]
		},
	}

	return func(w http.ResponseWriter, r *http.Request) {
		roomID := r.PathValue("roomId")
		if roomID == "" {
			env(w, "missing roomId", http.StatusBadRequest)
			return
		}

		ws, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			log.Printf("ws upgrade: %v", err)
			return
		}
		ws.SetReadLimit(maxMessageSize)
		defer ws.Close()

		if err := signalingLoop(w, r, ws, engine, roomID); err != nil {
			log.Printf("signaling %s: %v", roomID, err)
		}
	}
}

func signalingLoop(_ http.ResponseWriter, _ *http.Request, ws *websocket.Conn, engine *sfu.SFU, roomID string) error {
	// Detect silent disconnects: every read waits at most
	// pingReadDeadline, and our own pings (below) force the client's
	// automatic pongs to keep the deadline alive. When the deadline fires
	// the socket is a zombie; the deferred cleanup in the caller releases
	// the peer's WebRTC resources.
	ws.SetPongHandler(func(appData string) error {
		ws.SetReadDeadline(time.Now().Add(pingReadDeadline))
		return nil
	})

	// Any socket that reaches here is bound for a specific room. Wait for
	// the offer that completes the join; the PC is created lazily so an
	// idle socket cannot grow heap.
	ws.SetReadDeadline(time.Now().Add(pingReadDeadline))
	var first sfu.SignalMsg
	if err := ws.ReadJSON(&first); err != nil {
		return fmt.Errorf("read offer: %w", err)
	}
	if first.Type != "offer" || first.SDP == nil {
		return errors.New("first message must be an offer")
	}

	room, created, err := engine.GetOrCreateRoom(roomID)
	if err != nil {
		return err
	}
	if created {
		log.Printf("room %s created", roomID)
	}

	pc, err := engine.NewPeerConnection()
	if err != nil {
		return fmt.Errorf("pc: %w", err)
	}

	// All signaling writes (trickled ICE, renegotiation offers, answers)
	// funnel into one goroutine so concurrent callbacks never interleave
	// WS frames on the socket. The same goroutine emits pings — one
	// concurrent writer per connection is a gorilla/websocket invariant.
	outbound := make(chan sfu.SignalMsg, 16)
	done := make(chan struct{})
	pingTicker := time.NewTicker(pingInterval)
	go func() {
		defer close(done)
		defer pingTicker.Stop()
		for {
			select {
			case msg := <-outbound:
				ws.SetWriteDeadline(time.Now().Add(writeWait))
				if err := ws.WriteJSON(msg); err != nil {
					log.Printf("ws write: %v", err)
					return
				}
			case <-pingTicker.C:
				ws.SetWriteDeadline(time.Now().Add(writeWait))
				if err := ws.WriteMessage(websocket.PingMessage, nil); err != nil {
					log.Printf("ws ping: %v", err)
					return
				}
			}
		}
	}()

	// send is safe from any goroutine (ICE callbacks, renegotiation loop)
	// and never panics after the peer leaves: closing is guarded by outMu,
	// so an in-flight send always completes before close(outbound).
	var outMu sync.Mutex
	outClosed := false
	send := func(m sfu.SignalMsg) error {
		outMu.Lock()
		defer outMu.Unlock()
		if outClosed {
			return errors.New("outbound closed")
		}
		outbound <- m // the writer goroutine always drains (deadline on writes)
		return nil
	}

	pc.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c == nil {
			_ = send(sfu.SignalMsg{Type: "candidate"})
			return
		}
		init := c.ToJSON()
		_ = send(sfu.SignalMsg{Type: "candidate", Candidate: &init})
	})

	// Join first: tracks already published in the room are attached to the
	// PC here, so the initial answer below carries them without a second
	// renegotiation round-trip.
	peer, err := room.Join(peerIDgen(), pc, send)
	if err != nil {
		_ = pc.Close()
		outMu.Lock()
		outClosed = true
		outMu.Unlock()
		close(outbound)
		<-done
		return err
	}
	defer func() {
		outMu.Lock()
		outClosed = true
		outMu.Unlock()
		close(outbound)
		<-done
		room.RemovePeer(peer.ID)
		log.Printf("room %s peer %s left", roomID, peer.ID)
	}()

	pc.OnTrack(func(remote *webrtc.TrackRemote, receiver *webrtc.RTPReceiver) {
		log.Printf("room %s peer %s publishing %s (%s)",
			roomID, peer.ID, remote.ID(), remote.Kind())
		room.Publish(peer, remote)
	})

	pc.OnICEConnectionStateChange(func(state webrtc.ICEConnectionState) {
		log.Printf("room %s peer %s ICE %s", roomID, peer.ID, state)
	})

	// Initial handshake: client's offer → our answer. Tracks attached in
	// Join ride along in the answer; anything added later triggers a
	// server-initiated renegotiation offer.
	if err := peer.ApplyOffer(*first.SDP); err != nil {
		return fmt.Errorf("remote offer: %w", err)
	}
	// ICE candidates trickle both ways via OnICECandidate / "candidate"
	// messages; local candidates arrive on outbound from the callback.

	// Remaining messages: ICE candidates (either direction) + polite close.
	for {
		ws.SetReadDeadline(time.Now().Add(pingReadDeadline))
		var msg sfu.SignalMsg
		if err := ws.ReadJSON(&msg); err != nil {
			return fmt.Errorf("read loop: %w", err)
		}
		switch msg.Type {
		case "candidate":
			if msg.Candidate != nil {
				if err := peer.AddICECandidate(*msg.Candidate); err != nil {
					log.Printf("AddICECandidate: %v", err)
				}
			}
			// nil candidate = end-of-gathering from client; nothing to do.
		case "offer":
			// Client-driven renegotiation (e.g. it turned on video).
			if msg.SDP == nil {
				continue
			}
			if err := peer.ApplyOffer(*msg.SDP); err != nil {
				log.Printf("client offer: %v", err)
			}
		case "answer":
			// The client answered one of our renegotiation offers.
			if msg.SDP != nil {
				peer.ApplyAnswer(*msg.SDP)
			}
		}
	}
}

func peerIDgen() string {
	// Cheap, collision-safe under a single process: a monotonic counter
	// is all we need for in-memory room maps.
	return fmt.Sprintf("p%d", time.Now().UnixNano())
}
