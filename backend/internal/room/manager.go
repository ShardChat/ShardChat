package room

import (
	"crypto/rand"
	"errors"
	"log"
	"sync"
	"time"
)

// idLen is the length of a room ID: 10 URL-safe, unambiguous characters.
const idLen = 10

// MaxRooms is the global in-memory room ceiling: each room holds two client
// structures, a send channel, timers and a handshake cache.
const MaxRooms = 1500

// MaxConns is the hard ceiling of simultaneously connected WebSocket clients.
// This — not MaxRooms — decides whether a small memory tier survives: every
// admitted socket costs read+write buffers, two goroutine stacks and a send
// channel, and a room can hold two of them. Overload is shed with a 503 rather
// than an OOM kill.
const MaxConns = 600

// ErrRoomLimit is returned by CreateRoom when the ceiling is reached.
var ErrRoomLimit = errors.New("room limit reached")

// RoomManager owns every live room. It is the single source of truth for
// creation, lookup and destruction — all strictly in process RAM.
type RoomManager struct {
	mu    sync.RWMutex
	rooms map[string]*Room

	// conns counts live WebSocket clients across all rooms. Socket buffers,
	// goroutine stacks and send channels are per connection, so this — far more
	// directly than the room count — is what decides the process footprint.
	// Guarded by connMu, NOT by mu: admission must never block room bookkeeping.
	connMu sync.Mutex
	conns  int
}

// NewRoomManager creates an empty manager.
func NewRoomManager() *RoomManager {
	return &RoomManager{rooms: make(map[string]*Room)}
}

// CreateRoom mints a room with the given TTL and publishes it atomically,
// refusing to allocate once the global ceiling is reached.
func (m *RoomManager) CreateRoom(ttl time.Duration, hooks Hooks) (*Room, error) {
	for {
		id, err := newRoomID(idLen)
		if err != nil {
			return nil, err
		}
		r := newRoom(id, ttl, m, hooks)

		m.mu.Lock()
		if _, exists := m.rooms[id]; exists {
			// Astronomically unlikely (58^10 keyspace); stay correct anyway.
			m.mu.Unlock()
			r.closeAll() // stop the just-armed TTL timer of the doomed duplicate
			continue
		}
		if len(m.rooms) >= MaxRooms {
			m.mu.Unlock()
			r.closeAll() // stop the just-armed TTL timer of the rejected room
			return nil, ErrRoomLimit
		}
		m.rooms[id] = r
		m.mu.Unlock()
		return r, nil
	}
}

// GetRoom returns the live room with the given ID.
func (m *RoomManager) GetRoom(id string) (*Room, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	r, ok := m.rooms[id]
	return r, ok
}

// removeRoom is the single destruction path: stop timers, close sockets,
// nil out references, forget the room. Idempotent and safe from any
// goroutine (TTL timer, burn button, last peer leaving).
func (m *RoomManager) removeRoom(id string, reason RemovalReason) {
	m.mu.Lock()
	r, ok := m.rooms[id]
	if ok {
		delete(m.rooms, id)
	}
	m.mu.Unlock()

	if !ok {
		return
	}
	r.closeAll()
	// Operational log: room ID + reason only. Never payloads, never IPs.
	log.Printf("[room] destroyed id=%s reason=%s", id, reason)
}

// LiveRooms reports how many rooms currently occupy memory.
func (m *RoomManager) LiveRooms() int {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return len(m.rooms)
}

// ErrConnLimit is returned by TryAcquireConn when the global socket ceiling
// is reached.
var ErrConnLimit = errors.New("connection limit reached")

// TryAcquireConn reserves one slot of the global connection budget. It MUST be
// granted BEFORE the WebSocket upgrade: gorilla allocates its read and write
// buffers inside Upgrade, so a check afterwards would be too late to bound
// memory. Every granted slot must be returned with ReleaseConn (the client's
// Shutdown does it via the room teardown path).
func (m *RoomManager) TryAcquireConn() error {
	m.connMu.Lock()
	defer m.connMu.Unlock()
	if m.conns >= MaxConns {
		return ErrConnLimit
	}
	m.conns++
	return nil
}

// ReleaseConn returns a slot taken by TryAcquireConn.
func (m *RoomManager) ReleaseConn() {
	m.connMu.Lock()
	if m.conns > 0 {
		m.conns--
	}
	m.connMu.Unlock()
}

// LiveConns reports the number of admitted WebSocket clients.
func (m *RoomManager) LiveConns() int {
	m.connMu.Lock()
	defer m.connMu.Unlock()
	return m.conns
}

// CloseAll burns every live room (graceful shutdown). Each room's teardown
// path delivers ROOM_BURNED to its clients before the sockets close, so a
// redeploy ends sessions politely instead of dropping them. The room map is
// emptied in one pass; removeRoom then finds nothing left to close and becomes
// a no-op.
func (m *RoomManager) CloseAll(reason RemovalReason) {
	m.mu.Lock()
	rooms := make([]*Room, 0, len(m.rooms))
	for _, r := range m.rooms {
		rooms = append(rooms, r)
	}
	m.rooms = make(map[string]*Room)
	m.mu.Unlock()

	for _, r := range rooms {
		r.closeAll()
	}
	log.Printf("[room] shutdown: closed %d room(s) reason=%s", len(rooms), reason)
}

// idAlphabet excludes visually ambiguous glyphs (l, I, O, 0, 1).
const idAlphabet = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"

// newRoomID derives a cryptographically random, bias-free ID from crypto/rand.
func newRoomID(n int) (string, error) {
	max := byte(256 - 256%len(idAlphabet)) // rejection threshold
	out := make([]byte, 0, n)
	buf := make([]byte, n)
	for len(out) < n {
		if _, err := rand.Read(buf); err != nil {
			return "", err
		}
		for _, b := range buf {
			if b >= max {
				continue // reject the biased tail of the byte space
			}
			out = append(out, idAlphabet[b%byte(len(idAlphabet))])
			if len(out) == n {
				break
			}
		}
	}
	return string(out), nil
}
