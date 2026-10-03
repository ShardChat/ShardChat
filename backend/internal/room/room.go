// Package room implements SHARD's in-memory lifecycle: strict two-peer
// capacity, TTL self-destruction and manual burn. Rooms exist only in
// process RAM; nothing is ever persisted, inspected or logged.
package room

import (
	"log"
	"sync"
	"time"
)

// MaxClients is the hard capacity of a room: exactly two participants.
const MaxClients = 2

// emptyGracePeriod is how long a room survives with zero connected peers
// before self-burning. Absorbs React StrictMode ghost sockets and brief
// mobile network flaps; a peer re-joining cancels the pending burn.
const emptyGracePeriod = 10 * time.Second

// PairGracePeriod is how long a room waits after ONE of its two peers drops
// before burning for good.
//
// A dropped socket is not the same as a departure: a phone that opens the
// photo picker, switches app or loses signal for a moment suspends its
// WebSocket, and the OS never sends a close frame. Burning instantly locked
// both participants out of a live session over a backgrounded tab. During
// this window the room stays open and ONLY the seat that left may take the
// free place back, so a returning phone resumes instead of being refused as
// a third wheel - and a stranger holding the link cannot use the gap.
//
// Overridable at boot from SHARD_PEER_GRACE_SECONDS in cmd/server.
var PairGracePeriod = 45 * time.Second

// maxCachedEnvelope caps the handshake cache: the room stores one
// KEY_EXCHANGE packet — a ~400-byte public key envelope — never bulk data.
const maxCachedEnvelope = 1 << 16 // 64 KB

// RemovalReason explains why a room left memory (operational logging only,
// never message content).
type RemovalReason string

const (
	ReasonTTL      RemovalReason = "ttl_expired"
	ReasonBurn     RemovalReason = "burned_by_user"
	ReasonEmpty    RemovalReason = "both_peers_left"
	ReasonPeerLeft RemovalReason = "peer_left"
	// ReasonShutdown marks a platform-initiated teardown (Render or any PaaS
	// SIGTERM). Clients get the same ROOM_BURNED goodbye as any other burn, so
	// a redeploy reads as "session ended" instead of "connection lost".
	ReasonShutdown RemovalReason = "server_shutdown"
)

// PeerEventKind distinguishes occupancy changes inside a room.
type PeerEventKind int

const (
	PeerJoined PeerEventKind = iota
	PeerLeft
)

// PeerEvent notifies the transport layer about occupancy changes.
type PeerEvent struct {
	Kind      PeerEventKind
	Room      *Room
	Client    *Client // the client that joined (PeerJoined) or left (PeerLeft)
	PeerCount int
}

// Hooks wire the room core to the transport layer without import cycles.
// They are set once at creation and never mutated afterwards.
type Hooks struct {
	OnPeerEvent func(PeerEvent)
	OnRoomClose func(*Client) // per-client goodbye before sockets close
}

// Room is a disposable container for at most two clients.
type Room struct {
	ID string

	mu        sync.RWMutex
	clients   map[*Client]struct{}
	isLocked  bool
	expiresAt time.Time
	timer     *time.Timer
	closed    bool

	manager *RoomManager
	hooks   Hooks

	// graceTimer delays the empty-room burn (StrictMode ghost protection).
	graceTimer *time.Timer

	// pairTimer holds a one-peer room open for PairGracePeriod after its
	// partner drops, and pendingSeat names the ONLY seat allowed to reclaim
	// it. Both are nil/"" while the pair is intact.
	pairTimer   *time.Timer
	pendingSeat string

	// cachedEnvelope is the first relayed handshake packet (the peer's
	// KEY_EXCHANGE with its public key), stored opaquely and replayed to any
	// client that joins later. The room never parses it. Only the FIRST
	// exchange is cached and size-capped above; repeats never overwrite, so an
	// attacker cannot swap the cached key mid-handshake.
	cachedEnvelope []byte
	// cachedFrom remembers which client produced the cached envelope so a
	// reconnecting peer is never replayed its OWN stale key.
	cachedFrom *Client
}

func newRoom(id string, ttl time.Duration, m *RoomManager, hooks Hooks) *Room {
	r := &Room{
		ID:        id,
		clients:   make(map[*Client]struct{}, MaxClients),
		expiresAt: time.Now().Add(ttl),
		manager:   m,
		hooks:     hooks,
	}
	// TTL self-destruction: when the timer fires, the room is wiped from RAM.
	r.timer = time.AfterFunc(ttl, func() {
		m.removeRoom(r.ID, ReasonTTL)
	})
	return r
}

// TryAdd atomically admits a client while capacity remains. When the second
// seat is taken the room locks and fires a PeerJoined event.
func (r *Room) TryAdd(c *Client) bool {
	r.mu.Lock()
	if r.closed {
		r.mu.Unlock()
		return false
	}
	// While a dropped peer is still inside its reconnect window the free seat
	// is RESERVED for that seat alone. Matching seat -> the session resumes;
	// anything else (a third participant holding the link) is refused.
	if r.pairTimer != nil {
		if r.pendingSeat != c.Seat {
			r.mu.Unlock()
			return false
		}
		r.pairTimer.Stop()
		r.pairTimer = nil
		r.pendingSeat = ""
	}
	if len(r.clients) >= MaxClients {
		r.mu.Unlock()
		return false
	}
	r.clients[c] = struct{}{}
	// A peer (re)joined: cancel any pending empty-room burn.
	if r.graceTimer != nil {
		r.graceTimer.Stop()
		r.graceTimer = nil
	}
	count := len(r.clients)
	becameFull := count == MaxClients
	if becameFull {
		r.isLocked = true
	}
	r.mu.Unlock()

	if becameFull {
		r.hooks.onPeerEvent(PeerEvent{Kind: PeerJoined, Room: r, Client: c, PeerCount: count})
	}
	return true
}

// IsLocked reports whether both seats are taken.
func (r *Room) IsLocked() bool {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.isLocked
}

// IsKeyReady reports whether the room is full AND every seated client has
// completed the JOIN → KEY_EXCHANGE phase.
func (r *Room) IsKeyReady() bool {
	r.mu.RLock()
	defer r.mu.RUnlock()
	if len(r.clients) != MaxClients {
		return false
	}
	for c := range r.clients {
		if !c.State().KeySeen {
			return false
		}
	}
	return true
}

// ClientCount returns the number of currently connected clients.
func (r *Room) ClientCount() int {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return len(r.clients)
}

// ExpiresAt returns the TTL deadline (for the frontend countdown timer).
func (r *Room) ExpiresAt() time.Time {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.expiresAt
}

// Relay pushes raw packet bytes to every peer except the sender.
// The server is blind: the bytes are never parsed, logged or stored.
func (r *Room) Relay(data []byte, except *Client) {
	for _, p := range r.PeersExcept(except) {
		p.Send(data)
	}
}

// PeersExcept returns a snapshot of every client except the given one.
// Used for synchronous delivery of final notifications (PeerLeft) that
// must not race the room teardown closing the sockets.
func (r *Room) PeersExcept(c *Client) []*Client {
	r.mu.RLock()
	defer r.mu.RUnlock()
	peers := make([]*Client, 0, MaxClients)
	for cl := range r.clients {
		if cl != c {
			peers = append(peers, cl)
		}
	}
	return peers
}

// SetCachedEnvelope stores the FIRST valid handshake packet for replay to
// late joiners. Repeats are ignored — a client that already announced must
// not overwrite the cached key mid-handshake — and oversized packets are
// dropped outright.
func (r *Room) SetCachedEnvelope(from *Client, data []byte) {
	if len(data) == 0 || len(data) > maxCachedEnvelope {
		return
	}
	r.mu.Lock()
	if r.cachedEnvelope == nil {
		r.cachedEnvelope = append([]byte(nil), data...)
		r.cachedFrom = from
	}
	r.mu.Unlock()
}

// CachedEnvelope returns the stored packet, if any.
func (r *Room) CachedEnvelope() []byte {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.cachedEnvelope
}

// CachedEnvelopeFor replays the handshake cache to c, unless the cache was
// produced by c itself: a reconnecting peer must never receive its own
// stale public key back.
func (r *Room) CachedEnvelopeFor(c *Client) []byte {
	r.mu.RLock()
	defer r.mu.RUnlock()
	if r.cachedEnvelope == nil || r.cachedFrom == c {
		return nil
	}
	return r.cachedEnvelope
}

// Destroy burns the room immediately (manual "Burn Room Now").
func (r *Room) Destroy(reason RemovalReason) {
	r.manager.removeRoom(r.ID, reason)
}

// removeClient unregisters a client; the room burns itself when empty.
func (r *Room) removeClient(c *Client) {
	r.mu.Lock()
	if _, ok := r.clients[c]; !ok {
		r.mu.Unlock()
		return
	}
	log.Printf("[room] client left id=%s remaining=%d", r.ID, len(r.clients)-1)
	delete(r.clients, c)
	count := len(r.clients)
	pairWasFull := r.isLocked
	r.mu.Unlock()

	if count == 0 {
		// Do NOT burn the room instantly when the last peer leaves: ghost sockets
		// that open and die within milliseconds and brief mobile network flaps
		// are routine. A real (or reconnecting) peer arriving inside the grace
		// window cancels the pending burn.
		r.mu.Lock()
		if r.graceTimer != nil {
			r.graceTimer.Stop()
		}
		r.graceTimer = time.AfterFunc(emptyGracePeriod, func() {
			r.mu.RLock()
			stillEmpty := len(r.clients) == 0 && !r.closed
			r.mu.RUnlock()
			if stillEmpty {
				r.manager.removeRoom(r.ID, ReasonEmpty)
			}
		})
		r.mu.Unlock()
		return
	}
	r.hooks.onPeerEvent(PeerEvent{Kind: PeerLeft, Room: r, Client: c, PeerCount: count})
	// Two-person session: one departure ends it for the survivor, in BOTH
	// directions. The departed peer's socket dies asynchronously, so this also
	// fires when the FIRST of two peers leaves — do not branch on which seat
	// dropped.
	//
	// It is held open for PairGracePeriod rather than burned instantly: the
	// survivor is told at once, but a phone that merely went to the background
	// (photo picker, app switch, a lost bar of signal) gets its seat back
	// instead of finding the session burned. If nobody returns, the burn
	// happens anyway and the link becomes permanently unjoinable.
	if pairWasFull {
		r.startPairGrace(c.Seat)
	}
}

// startPairGrace arms the post-departure window, reserving the free seat for
// the participant that left it.
func (r *Room) startPairGrace(seat string) {
	r.mu.Lock()
	if r.closed || r.pairTimer != nil {
		r.mu.Unlock()
		return
	}
	r.pendingSeat = seat
	r.pairTimer = time.AfterFunc(PairGracePeriod, func() {
		r.mu.Lock()
		armed := !r.closed && r.pairTimer != nil
		r.pairTimer = nil
		r.pendingSeat = ""
		r.mu.Unlock()
		if armed {
			log.Printf("[room] peer did not return id=%s — burning after the reconnect window", r.ID)
			r.manager.removeRoom(r.ID, ReasonPeerLeft)
		}
	})
	r.mu.Unlock()
}

// EvictSeat unregisters the client holding the given opaque seat token and
// returns it, or nil when no token was supplied or none matched.
//
// A reconnect can outrun the relay's own detection of a dead socket: the OS
// dropped the TCP connection long before the server notices, so the stale
// peer still occupies a seat. Handing it back to the participant who is
// actually here is what stops a returning phone from being turned away as a
// third wheel. The stale client is returned so the caller can shut it down;
// removeClient then finds it unregistered and stays a no-op, so no PeerLeft
// event and no burn are emitted for a seat that was immediately reclaimed.
func (r *Room) EvictSeat(seat string) *Client {
	if seat == "" {
		return nil
	}
	r.mu.Lock()
	var stale *Client
	for c := range r.clients {
		if c.Seat == seat {
			stale = c
			break
		}
	}
	if stale != nil {
		delete(r.clients, stale)
		if len(r.clients) < MaxClients {
			r.isLocked = false
		}
	}
	r.mu.Unlock()
	return stale
}

// closeAll is the single teardown path: stop the TTL timer, let the transport
// say goodbye, close sockets and drop every reference so the GC can reclaim.
func (r *Room) closeAll() {
	r.mu.Lock()
	if r.closed {
		r.mu.Unlock()
		return
	}
	r.closed = true
	if r.timer != nil {
		r.timer.Stop()
	}
	if r.graceTimer != nil {
		r.graceTimer.Stop()
	}
	if r.pairTimer != nil {
		r.pairTimer.Stop()
		r.pairTimer = nil
		r.pendingSeat = ""
	}
	clients := make([]*Client, 0, len(r.clients))
	for c := range r.clients {
		clients = append(clients, c)
	}
	r.clients = make(map[*Client]struct{}) // further removeClient calls become no-ops
	r.isLocked = false
	r.mu.Unlock()

	for _, c := range clients {
		r.hooks.onRoomClose(c)
		c.Shutdown()
	}
}

func (h Hooks) onPeerEvent(ev PeerEvent) {
	if h.OnPeerEvent != nil {
		h.OnPeerEvent(ev)
	}
}

func (h Hooks) onRoomClose(c *Client) {
	if h.OnRoomClose != nil {
		h.OnRoomClose(c)
	}
}
