package ws

import (
	"encoding/json"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"shard-backend/internal/httpx"
	"shard-backend/internal/room"
)

// Handler upgrades HTTP requests to WebSocket and routes packets between
// the two peers of a room. It is deliberately blind: apart from reading the
// BURN_ROOM type byte, packet contents are never parsed, logged or stored.
type Handler struct {
	Manager  *room.RoomManager
	Upgrader websocket.Upgrader
}

// NewUpgrader builds an upgrader that only accepts origins from the
// ALLOWED_ORIGINS allow-list. An empty spec selects dev mode where only
// loopback origins pass; strict mode also rejects Origin-less handshakes.
// Mismatches are rejected by gorilla with a 403 before upgrade.
//
// Buffer sizing: gorilla allocates ReadBufferSize + WriteBufferSize for every
// upgraded connection, so the pair is a per-socket memory tax. No compression is
// negotiated here, so small buffers cost nothing but throughput the relay never
// needed, and the write pool shares a few buffers across all connections.
func NewUpgrader(allowedOrigin string) websocket.Upgrader {
	return websocket.Upgrader{
		ReadBufferSize:  4 << 10,
		WriteBufferSize: 4 << 10,
		WriteBufferPool: &sync.Pool{},
		CheckOrigin: func(r *http.Request) bool {
			origin := r.Header.Get("Origin")
			if httpx.OriginAllowed(origin, allowedOrigin) {
				return true
			}
			log.Printf("[ws] handshake rejected: origin %q not in allow-list %q", origin, allowedOrigin)
			return false
		},
	}
}

// CreateRoom mints a room wired to this handler's relay callbacks.
func (h *Handler) CreateRoom(ttl time.Duration) (*room.Room, error) {
	return h.Manager.CreateRoom(ttl, room.Hooks{
		OnPeerEvent: h.onPeerEvent,
		OnRoomClose: h.onRoomClose,
	})
}

// ServeWS handles GET /ws/{roomId}. Rejections happen before the upgrade so
// callers see clean HTTP statuses:
//
//	404 — room not found or already burned
//	403 — room is full (2/2 peers): the third wheel is rejected
//	503 — the global connection budget is exhausted
func (h *Handler) ServeWS(w http.ResponseWriter, r *http.Request) {
	roomID := r.PathValue("roomId")

	rm, ok := h.Manager.GetRoom(roomID)
	if !ok {
		// The upgrade is rejected, so the WS client sees no HTTP status.
		// Hijack the connection and deliver a ROOM_BURNED packet first, so a
		// visitor of a dead link learns it instantly, not one reconnect cycle
		// later.
		rejectGone(w, r, h.Upgrader)
		return
	}
	if rm.ClientCount() >= room.MaxClients {
		writeJSON(w, http.StatusForbidden, ErrorPayload{Error: "Room is full (2/2 peers)."})
		return
	}
	// Reserve a socket slot BEFORE the upgrade — that is where gorilla allocates
	// the connection buffers, so a later check would be too late to bound
	// memory. Overload is shed with a 503 the client can back off from, not with
	// an OOM kill of the whole relay.
	if err := h.Manager.TryAcquireConn(); err != nil {
		writeJSON(w, http.StatusServiceUnavailable, ErrorPayload{Error: "Server at capacity. Try again shortly."})
		return
	}

	conn, err := h.Upgrader.Upgrade(w, r, nil)
	if err != nil {
		h.Manager.ReleaseConn() // Upgrade already wrote the HTTP error response.
		return
	}

	c := room.NewClient(rm, conn)
	if !rm.TryAdd(c) {
		// Lost the race: the room filled between the check and the upgrade.
		raw, _ := json.Marshal(Packet{
			Type:    TypeError,
			Payload: mustPayload(ErrorPayload{Error: "Room is full (2/2 peers)."}),
		})
		_ = c.SendSync(raw)
		c.SendClose(websocket.ClosePolicyViolation)
		c.Shutdown() // returns the reserved slot
		return
	}
	c.Start(h.handlePacket)

	// First touch: hand the client the room's TTL deadline and occupancy so a
	// reconnecting peer can resume the key handshake. Metadata only.
	if raw, err := json.Marshal(Packet{
		Type:    TypeWelcome,
		Payload: mustPayload(WelcomePayload{ExpiresAt: rm.ExpiresAt().UnixMilli(), PeerCount: rm.ClientCount()}),
	}); err == nil {
		_ = c.SendSync(raw)
	}

	// Catch the newcomer up: if the peer already announced its key, replay
	// it so the handshake completes regardless of join order or reconnects.
	// CachedEnvelopeFor skips the replay when the cache holds this client's
	// own stale announcement (reconnect of the same seat).
	if env := rm.CachedEnvelopeFor(c); env != nil {
		_ = c.SendSync(env)
	}
}

// appTypes are the relayed packet types that may carry user traffic. They
// are gated behind the full handshake: until BOTH peers have seen each
// other's KEY_EXCHANGE there is no shared key, so forwarding them would
// only feed a pre-established-state attack surface.
var appTypes = map[string]bool{
	TypeCipherMsg:   true,
	TypeReaction:    true,
	TypeTyping:      true,
	TypeReadReceipt: true,

	TypePeerIDAnnounce: true,
	TypeCallInvite:     true,
	TypeCallReject:     true,
	TypeCallHangup:     true,
	TypeCallOffer:      true,
	TypeCallAnswer:     true,
	TypeCallIce:        true,

	"EDIT_MESSAGE":   true,
	"DELETE_MESSAGE": true,
	"PIN_MESSAGE":    true,
	"POLL_VOTE":      true,
	"VIEW_ONCE_OPEN": true,

	"FILE_CHUNK_START": true,
	"FILE_CHUNK_DATA":  true,
	"FILE_CHUNK_END":   true,
}

// handlePacket enforces the handshake state machine and then routes:
//
//	JOIN           — exactly once per connection, before anything else
//	KEY_EXCHANGE   — only after JOIN; first one is cached for late joiners
//	BURN_ROOM      — accepted in any state (user intent, not app traffic)
//	app traffic    — relayed only when both peers have completed KEY_EXCHANGE
//	everything else — malformed or unknown: blind-dropped
func (h *Handler) handlePacket(c *room.Client, raw []byte) {
	defer h.recoverPacket(c) // B-2: one bad packet must never kill the relay
	var pkt Packet
	if err := json.Unmarshal(raw, &pkt); err != nil {
		return // Malformed envelope: blind-drop, never logged.
	}
	rm := c.Room()

	if pkt.Type == TypeBurnRoom {
		rm.Destroy(room.ReasonBurn) // allowed in any state
		return
	}

	switch pkt.Type {
	case TypeJoin:
		st := c.State()
		if st.JoinSeen {
			return // strict once per connection
		}
		c.SetState(func(s room.SessionState) room.SessionState { s.JoinSeen = true; return s })
		rm.Relay(raw, c)
		return

	case TypeKeyExchange:
		if !c.State().JoinSeen {
			return // handshake not started
		}
		if !c.State().KeySeen {
			// Remember the first handshake packet so a reconnecting or
			// late-joining peer still receives the sender's public key.
			rm.SetCachedEnvelope(c, raw)
			c.SetState(func(s room.SessionState) room.SessionState { s.KeySeen = true; return s })
		}
		rm.Relay(raw, c)
		return
	}

	if appTypes[pkt.Type] {
		if !rm.IsKeyReady() {
			return // pre-handshake app traffic: dropped
		}
		rm.Relay(raw, c)
	}
	// Unknown types: blind-drop, never logged.
}

// recoverPacket is the second panic guard: the client's read pump already
// wraps handlePacket, but the blast radius of an unhandled panic here would
// be the whole process.
func (h *Handler) recoverPacket(c *room.Client) {
	if r := recover(); r != nil {
		log.Printf("[ws] recovered route room=%s panic=%v", c.Room().ID, r)
		c.Shutdown()
	}
}

// onPeerEvent converts room occupancy events into server envelopes.
func (h *Handler) onPeerEvent(ev room.PeerEvent) {
	var typ string
	switch ev.Kind {
	case room.PeerJoined:
		typ = TypePeerJoined
	case room.PeerLeft:
		typ = TypePeerLeft
	default:
		return
	}
	payload := PeerEventPayload{PeerCount: ev.PeerCount}
	if typ == TypePeerJoined {
		payload.ExpiresAt = ev.Room.ExpiresAt().UnixMilli()
	}
	raw, err := json.Marshal(Packet{
		Type:    typ,
		Payload: mustPayload(payload),
	})
	if err != nil {
		return
	}
	// PeerJoined: notify the first peer about the newcomer.
	// PeerLeft: notify the survivor synchronously — removeClient burns the
	// room right after this hook returns, and an async queued write would race
	// the teardown and drop the goodbye.
	if typ == TypePeerLeft {
		for _, p := range ev.Room.PeersExcept(ev.Client) {
			p.SendSync(raw)
		}
		return
	}
	ev.Room.Relay(raw, ev.Client)
}

// onRoomClose gives a client its ROOM_BURNED goodbye before teardown.
func (h *Handler) onRoomClose(c *room.Client) {
	if raw, err := json.Marshal(Packet{Type: TypeRoomBurned}); err == nil {
		_ = c.SendSync(raw)
	}
	c.SendClose(websocket.CloseNormalClosure)
}

func mustPayload(v any) json.RawMessage {
	raw, err := json.Marshal(v)
	if err != nil {
		return json.RawMessage(`{}`)
	}
	return raw
}

// rejectGone tells a WS client that the room does not exist. Because the
// HTTP status of a failed upgrade is invisible to the WebSocket API, the
// packet is pushed over a hijacked connection before the socket is closed.
func rejectGone(w http.ResponseWriter, r *http.Request, up websocket.Upgrader) {
	conn, err := up.Upgrade(w, r, nil)
	if err != nil {
		return // Upgrade already wrote the HTTP error response.
	}
	defer conn.Close() //nolint:errcheck // best-effort goodbye
	if raw, err := json.Marshal(Packet{Type: TypeRoomBurned}); err == nil {
		_ = conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
		_ = conn.WriteMessage(websocket.TextMessage, raw)
	}
	_ = conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
	_ = conn.WriteMessage(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""))
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
