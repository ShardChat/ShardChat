// Package ws implements the WebSocket edge of SHARD: the JSON envelope,
// the upgrade handler and the blind relay routing between two peers.
package ws

import "encoding/json"

// Wire packet types (see plan.md §5). The server interprets exactly one
// control type — BURN_ROOM; every other packet is relayed untouched.
const (
	TypeJoin           = "JOIN"         // sent by a client on connect (ECDH public key inside)
	TypePeerJoined     = "PEER_JOINED"  // server → both peers when room locks at 2/2
	TypeKeyExchange    = "KEY_EXCHANGE" // relayed public key to the other peer
	TypeCipherMsg      = "CIPHER_MESSAGE"
	TypeReaction       = "REACTION"
	TypeTyping         = "TYPING"
	TypeReadReceipt    = "READ_RECEIPT"
	TypeBurnRoom       = "BURN_ROOM"
	TypePeerIDAnnounce = "PEER_ID_ANNOUNCE" // retired with the PeerJS cloud; still relayed
	TypeCallInvite     = "CALL_INVITE"
	TypeCallReject     = "CALL_REJECT"
	TypeCallHangup     = "CALL_HANGUP"

	// WebRTC signaling. Relayed opaquely between the two peers like any
	// other app traffic — the server never parses an SDP or a candidate.
	TypeCallOffer  = "CALL_OFFER"
	TypeCallAnswer = "CALL_ANSWER"
	TypeCallIce    = "CALL_ICE"

	// Server-generated events.
	TypeWelcome    = "WELCOME"     // first packet on connect: TTL metadata
	TypePeerLeft   = "PEER_LEFT"   // the peer dropped its connection
	TypeRoomBurned = "ROOM_BURNED" // final packet before socket teardown
	TypeError      = "ERROR"       // protocol-level errors, never message content
)

// Packet is the JSON envelope of every WebSocket frame.
type Packet struct {
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload,omitempty"`
}

// WelcomePayload is the first server packet on any connection: the TTL
// deadline powers the client's burn-countdown header, and peerCount lets a
// reconnecting client resume the key handshake without a fresh PEER_JOINED.
type WelcomePayload struct {
	ExpiresAt int64 `json:"expiresAt"` // unix ms
	PeerCount int   `json:"peerCount"`
}

// PeerEventPayload announces room occupancy changes to the clients.
type PeerEventPayload struct {
	PeerCount int   `json:"peerCount"`
	ExpiresAt int64 `json:"expiresAt,omitempty"` // unix ms, on peer join
}

// ErrorPayload carries protocol-level errors only.
type ErrorPayload struct {
	Error string `json:"error"`
}
