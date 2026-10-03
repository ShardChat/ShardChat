package room

import (
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const (
	writeWait  = 10 * time.Second
	pongWait   = 60 * time.Second
	pingPeriod = (pongWait * 9) / 10

	// maxPacketSize caps a single WS frame (10 MB). Clients stream files as ~86 KB
	// encrypted chunks, so this ceiling is a hard backstop against
	// memory-exhaustion floods.
	maxPacketSize = 10 << 20

	// sendBuffer bounds the async outbound queue: enough to absorb a burst of
	// encrypted 64 KB file chunks (~90 KB on the wire each) while the receiving
	// browser drains its decrypt loop.
	sendBuffer = 128

	// sendBlockTimeout is how long Send() may block on a full queue before the
	// peer is declared a lost cause and shed. The block itself is the
	// backpressure mechanism: it stalls the sender's read pump, TCP backs up to
	// the sending browser, and its chunk-pacing loop throttles.
	sendBlockTimeout = 5 * time.Second
)

// Client wraps one WebSocket participant of a room. It knows nothing about
// the wire protocol: packets flow through as opaque bytes.
type Client struct {
	room    *Room
	conn    *websocket.Conn
	send    chan []byte
	quit    chan struct{}
	once    sync.Once
	writeMu sync.Mutex // gorilla/websocket forbids concurrent writes

	// Seat is an opaque per-tab token supplied by the browser on the upgrade
	// request. It identifies the PARTICIPANT, not the connection, so a client
	// that reconnects can take its own seat back instead of being refused as
	// a third peer. Never parsed, never logged, carries no identity.
	Seat string

	// Handshake state bits: JoinSeen/KeySeen gate what the relay router may
	// forward for this connection. Guarded by its own mutex because it is read
	// from the read pump, from other pumps and from the room.
	stMu sync.Mutex
	st   SessionState
}

// SessionState tracks one connection's progress through the mandatory
// JOIN → KEY_EXCHANGE phase. Application packets are relayed only when both
// seated peers report KeySeen.
type SessionState struct {
	JoinSeen bool
	KeySeen  bool
}

// State returns a snapshot of this connection's handshake state.
func (c *Client) State() SessionState {
	c.stMu.Lock()
	defer c.stMu.Unlock()
	return c.st
}

// SetState atomically updates the handshake state.
func (c *Client) SetState(f func(SessionState) SessionState) {
	c.stMu.Lock()
	defer c.stMu.Unlock()
	c.st = f(c.st)
}

// resetState clears the handshake bits (belt-and-braces on teardown).
func (c *Client) resetState() {
	c.stMu.Lock()
	defer c.stMu.Unlock()
	c.st = SessionState{}
}

// NewClient creates a client bound to a room. Call Start after TryAdd.
// seat is the opaque participant token used to reclaim a dropped seat.
func NewClient(r *Room, conn *websocket.Conn, seat string) *Client {
	return &Client{
		room: r,
		conn: conn,
		send: make(chan []byte, sendBuffer),
		quit: make(chan struct{}),
		Seat: seat,
	}
}

// Room exposes the owning room (for burn handling by the transport layer).
func (c *Client) Room() *Room { return c.room }

// Send queues raw packet bytes for asynchronous delivery.
//
// A full queue means the receiving browser is slower than the sender's stream.
// Dropping the connection there would kill whole sessions during large uploads,
// so Send blocks briefly instead: the blocked sender-side read pump propagates
// TCP backpressure up to the sending browser, whose transfer loop already paces
// on socket drain. Only a stall longer than sendBlockTimeout sheds the peer.
func (c *Client) Send(data []byte) {
	select {
	case <-c.quit:
		return
	default:
	}
	timer := time.NewTimer(sendBlockTimeout)
	defer timer.Stop()
	select {
	case c.send <- data:
	case <-timer.C:
		go c.Shutdown() // sustained slow consumer: shed, keep relaying
	case <-c.quit:
	}
}

// SendSync writes bytes directly, bypassing the queue. Used for the final
// goodbye packet. Safe for concurrent use with the write pump.
func (c *Client) SendSync(data []byte) bool {
	select {
	case <-c.quit:
		return false
	default:
	}
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	_ = c.conn.SetWriteDeadline(time.Now().Add(writeWait))
	return c.conn.WriteMessage(websocket.TextMessage, data) == nil
}

// SendClose best-effort sends a WebSocket close frame with the given code.
func (c *Client) SendClose(code int) {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	_ = c.conn.SetWriteDeadline(time.Now().Add(writeWait))
	_ = c.conn.WriteMessage(websocket.CloseMessage, websocket.FormatCloseMessage(code, ""))
}

// safe runs fn with a panic guard. Go kills the process on any unrecovered
// panic in any goroutine, so every launched goroutine goes through here: the
// blast radius becomes one dead socket instead of the whole relay.
func (c *Client) safe(what string, fn func()) {
	defer func() {
		if r := recover(); r != nil {
			// Room id + which pump: never payload data, never peer addresses.
			log.Printf("[ws] recovered room=%s pump=%s panic=%v", c.room.ID, what, r)
			c.Shutdown()
		}
	}()
	fn()
}

// Start launches the read and write pumps. onPacket receives every incoming
// packet as untouched bytes for routing by the transport layer.
func (c *Client) Start(onPacket func(*Client, []byte)) {
	go c.safe("write", c.writePump)
	go c.safe("read", func() { c.readPump(onPacket) })
}

// Shutdown tears the client down exactly once and unregisters it from its
// room. Safe to call from any goroutine, any number of times.
func (c *Client) Shutdown() {
	c.once.Do(func() {
		c.resetState()
		close(c.quit)
		_ = c.conn.Close()
		// Return the global connection slot here, inside the same guarded block as the
		// socket close, so it runs exactly once per admitted slot.
		c.room.manager.ReleaseConn()
	})
	c.room.removeClient(c) // idempotent: no-op if already unregistered
}

func (c *Client) readPump(onPacket func(*Client, []byte)) {
	defer c.Shutdown()
	conn := c.conn
	conn.SetReadLimit(maxPacketSize)
	_ = conn.SetReadDeadline(time.Now().Add(pongWait))
	conn.SetPongHandler(func(string) error {
		return conn.SetReadDeadline(time.Now().Add(pongWait))
	})
	for {
		_, raw, err := conn.ReadMessage()
		if err != nil {
			// Operational trace only: close reason, never payloads or addresses.
			reason := "network-error"
			if ce, ok := err.(*websocket.CloseError); ok {
				reason = fmt.Sprintf("close %d", ce.Code)
			}
			log.Printf("[ws] read ended room=%s reason=%s", c.room.ID, reason)
			return
		}
		if onPacket != nil {
			onPacket(c, raw)
		}
	}
}

func (c *Client) writePump() {
	ticker := time.NewTicker(pingPeriod)
	defer ticker.Stop()
	for {
		select {
		case data := <-c.send:
			if !c.write(data, websocket.TextMessage) {
				return
			}
		case <-ticker.C:
			if !c.write(nil, websocket.PingMessage) {
				return
			}
		case <-c.quit:
			return
		}
	}
}

func (c *Client) write(data []byte, msgType int) bool {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	_ = c.conn.SetWriteDeadline(time.Now().Add(writeWait))
	return c.conn.WriteMessage(msgType, data) == nil
}
