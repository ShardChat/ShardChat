// Package sfu implements the zero-storage, zero-transcode selective
// forwarding unit: the media heart of shard-media.
//
// Design invariants:
//
//   - In-memory only. No DB, no disk writes. A room exists exactly as long
//     as someone is inside it (plus a short empty grace so a link flap does
//     not destroy a call mid-handshake).
//   - Zero transcoding. RTP packets are read from the publisher and written
//     verbatim into every other member's subscriber track. The SRTP layer
//     decrypts/re-encrypts on hop boundaries, but the payload bytes are
//     never decoded.
//   - Full renegotiation. A track published after a subscriber joined is
//     attached to the subscriber's PeerConnection by a server-initiated
//     offer (client answers). A track whose publisher left is removed with
//     RemoveTrack + renegotiation. This is the price of a single-PC SFU and
//     the same pattern pion's own sfu examples use.
//   - Every PeerConnection is closed deterministically, either when its
//     signaling socket dies or when the room dies. Nothing leaks.
package sfu

import (
	"context"
	"errors"
	"log"
	"runtime/debug"
	"sync"
	"time"

	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

// rtpPacket aliases the pion RTP packet type used for parsing forwarded
// packets before WriteRTP fans them out.
type rtpPacket = rtp.Packet

const (
	// EmptyGrace is how long a room survives with zero peers before being
	// destroyed. A link flapping during a network hiccup should not tear
	// down the session while the other ear waits for the door to reopen.
	EmptyGrace = 10 * time.Second

	// NOTE: there is deliberately no cap on peers per room or rooms per
	// process. Every legitimate participant is accepted; memory growth is
	// handled by the Go GC soft memory limit (debug.SetMemoryLimit in
	// cmd/server/main.go), not by refusing users at the door.
	negotiateTimeout = 15 * time.Second
)

var (
	// ErrRoomClosed is returned when joining a room that no longer exists.
	ErrRoomClosed = errors.New("sfu: room is closed")
)

// SignalMsg is the wire envelope of the signaling WS. The sfu package only
// constructs outgoing messages; parsing lives in cmd/server.
type SignalMsg struct {
	Type      string                     `json:"type"` // "offer" | "answer" | "candidate"
	SDP       *webrtc.SessionDescription `json:"sdp,omitempty"`
	Candidate *webrtc.ICECandidateInit   `json:"candidate,omitempty"` // nil => end-of-candidates
}

// forwardingTrack pairs a publisher's incoming track with the local track
// every subscriber writes into. One room-wide local track serves all
// subscribers: the pump reads once and fans out via WriteRTP, which pion
// delivers to every bound RTPSender (SSRC/PayloadType rewritten per peer).
type forwardingTrack struct {
	sourcePeerID string
	incoming     *webrtc.TrackRemote
	outgoing     *webrtc.TrackLocalStaticRTP
}

// Peer is one participant of a room: one DTLS/SRTP session and its pump
// goroutines. It is created per signaling socket, closed with it.
type Peer struct {
	ID   string
	Conn *webrtc.PeerConnection

	room *Room
	send func(SignalMsg) error // ws write, already serialized by the caller

	// sigMu serializes every SDP-level operation on Conn: the ws read
	// loop (client offers/answers, candidates) and the negotiation
	// goroutine (server offers) both mutate SDP state.
	sigMu sync.Mutex
	mu2   sync.Mutex // guards closed
	ctx   context.Context

	// negotiation machinery
	kick          chan struct{}                  // renegotiate requested
	answerIn      chan webrtc.SessionDescription // client's answer for our offer
	dirty         bool                           // re-negotiate again after current cycle
	dirtyMu       sync.Mutex
	negotiateOnce sync.Once
	cancel        context.CancelFunc
	closed        bool
	wg            sync.WaitGroup // RTP pumps + negotiation goroutine
}

// Close tears down the peer's connection and waits for its goroutines.
func (p *Peer) Close() error {
	p.mu2.Lock()
	if p.closed {
		p.mu2.Unlock()
		return nil
	}
	p.closed = true
	p.mu2.Unlock()

	p.cancel()
	err := p.Conn.Close()
	p.wg.Wait()
	return err
}

func (p *Peer) isClosed() bool {
	p.mu2.Lock()
	defer p.mu2.Unlock()
	return p.closed
}

// kickNegotiation marks the peer dirty and wakes its negotiation goroutine.
func (p *Peer) kickNegotiation() {
	p.dirtyMu.Lock()
	p.dirty = true
	p.dirtyMu.Unlock()
	select {
	case p.kick <- struct{}{}:
	default: // already pending
	}
}

// renegotiateLoop serves every renegotiation as a serialized offer→answer
// cycle. Triggers coalesce: tracks added while an offer is in flight are
// picked up by the next cycle (dirty flag).
func (p *Peer) renegotiateLoop(ctx context.Context) {
	defer p.wg.Done()
	// A panic here must not kill the whole media node: log and let the
	// peer's normal teardown paths collect the connection.
	defer func() {
		if r := recover(); r != nil {
			log.Printf("sfu: peer %s renegotiate loop recovered from panic: %v\n%s", p.ID, r, debug.Stack())
		}
	}()
	for {
		select {
		case <-p.kick:
		case <-ctx.Done():
			return
		}
		for {
			p.dirtyMu.Lock()
			if !p.dirty {
				p.dirtyMu.Unlock()
				break
			}
			p.dirty = false
			p.dirtyMu.Unlock()
			if err := p.sendOffer(); err != nil {
				if p.isClosed() {
					return
				}
				log.Printf("sfu: peer %s renegotiate: %v", p.ID, err)
			}
		}
	}
}

// sendOffer runs one server-initiated negotiation cycle: offer → client →
// answer. The answer arrives via ApplyAnswer (ws read loop) into answerIn.
func (p *Peer) sendOffer() error {
	p.sigMu.Lock()
	offer, err := p.Conn.CreateOffer(nil)
	if err != nil {
		p.sigMu.Unlock()
		return err
	}
	if err := p.Conn.SetLocalDescription(offer); err != nil {
		p.sigMu.Unlock()
		return err
	}
	gathered := webrtc.GatheringCompletePromise(p.Conn)
	p.sigMu.Unlock()

	// Include host candidates in the offer itself; with muxes gathering is
	// instant and clients that lack trickle get a complete offer.
	select {
	case <-gathered:
	case <-time.After(3 * time.Second):
	case <-p.ctx.Done():
		return ErrRoomClosed
	}

	if err := p.send(SignalMsg{Type: "offer", SDP: p.Conn.LocalDescription()}); err != nil {
		return err
	}

	var ans webrtc.SessionDescription
	select {
	case ans = <-p.answerIn:
	case <-time.After(negotiateTimeout):
		return errors.New("sfu: client did not answer renegotiation offer")
	case <-p.ctx.Done():
		return ErrRoomClosed
	}

	p.sigMu.Lock()
	defer p.sigMu.Unlock()
	return p.Conn.SetRemoteDescription(ans)
}

// ApplyAnswer feeds a client answer into any pending renegotiation cycle.
// Unsolicited answers are dropped (buffered slot).
func (p *Peer) ApplyAnswer(sdp webrtc.SessionDescription) {
	select {
	case p.answerIn <- sdp:
	default:
		log.Printf("sfu: peer %s dropped unsolicited answer", p.ID)
	}
}

// ApplyOffer handles a client-initiated (re)negotiation: applies the remote
// offer and sends back an answer. If one of our own renegotiation offers is
// in flight, we roll back first — the client's intent wins, and the kick
// loop re-offers whatever we lost afterwards.
func (p *Peer) ApplyOffer(sdp webrtc.SessionDescription) error {
	p.sigMu.Lock()
	defer p.sigMu.Unlock()

	if p.Conn.SignalingState() == webrtc.SignalingStateHaveLocalOffer {
		if err := p.Conn.SetLocalDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeRollback}); err != nil {
			return err
		}
		p.kickNegotiation()
	}
	if err := p.Conn.SetRemoteDescription(sdp); err != nil {
		return err
	}
	answer, err := p.Conn.CreateAnswer(nil)
	if err != nil {
		return err
	}
	if err := p.Conn.SetLocalDescription(answer); err != nil {
		return err
	}
	return p.send(SignalMsg{Type: "answer", SDP: p.Conn.LocalDescription()})
}

// AddICECandidate forwards a trickled remote candidate.
func (p *Peer) AddICECandidate(c webrtc.ICECandidateInit) error {
	p.sigMu.Lock()
	defer p.sigMu.Unlock()
	return p.Conn.AddICECandidate(c)
}

// Room is one call entirely in memory.
type Room struct {
	id    string
	mu    sync.RWMutex
	peers map[string]*Peer

	// sfu back-reference so the idle timer can drop itself from the room
	// table (never held simultaneously with r.mu — see the timer below).

	// tracks holds every room-wide forwarding track, keyed by local track ID.
	tracks map[string]*forwardingTrack

	// subs[subPeerID][trackKey] = sender created when the subscriber was
	// attached — needed to RemoveTrack when the publisher leaves.
	subs map[string]map[string]*webrtc.RTPSender

	idleTimer *time.Timer
	closing   bool
	sfu       *SFU

	api      *webrtc.API
	pcConfig webrtc.Configuration
}

// SFU owns the room table. One instance per server process.
type SFU struct {
	mu    sync.RWMutex
	rooms map[string]*Room

	api      *webrtc.API
	pcConfig webrtc.Configuration
}

// New creates an SFU sharing api and pcConfig across every PeerConnection
// it ever creates (ICE-TCP mux / UDPMux are bound at the SettingEngine
// level, which is baked into the API — see cmd/server/main.go).
func New(api *webrtc.API, pcConfig webrtc.Configuration) *SFU {
	return &SFU{
		rooms:    make(map[string]*Room),
		api:      api,
		pcConfig: pcConfig,
	}
}

// GetOrCreateRoom returns an existing room or creates it afresh. The flag
// reports whether the room was just created.
func (s *SFU) GetOrCreateRoom(id string) (*Room, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if r, ok := s.rooms[id]; ok && !r.isClosingLocked() {
		r.resetIdleTimerLocked()
		return r, false, nil
	}
	// A leftover empty room whose grace timer fired but whose close has not
	// completed yet — rebuild in either case.
	if r, ok := s.rooms[id]; ok {
		go r.closeLocked()
	}
	r := &Room{
		id:       id,
		peers:    make(map[string]*Peer),
		tracks:   make(map[string]*forwardingTrack),
		subs:     make(map[string]map[string]*webrtc.RTPSender),
		sfu:      s,
		api:      s.api,
		pcConfig: s.pcConfig,
	}
	r.scheduleIdleCloseLocked()
	s.rooms[id] = r
	return r, true, nil
}

// dropRoomIfClosing removes a room that has finished closing from the table
// so health metrics and room reuse see it gone. Must not be called while
// holding the room's own lock (lock order: s.mu before r.mu everywhere else).
func (s *SFU) dropRoomIfClosing(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if r, ok := s.rooms[id]; ok && r.isClosingLocked() {
		delete(s.rooms, id)
	}
}

// NewPeerConnection builds a PC from the SFU's shared API (ICE muxes baked
// in at construction time — see cmd/server/main.go SettingEngine).
func (s *SFU) NewPeerConnection() (*webrtc.PeerConnection, error) {
	return s.api.NewPeerConnection(s.pcConfig)
}

// RoomCount returns how many rooms are alive (health metric).
func (s *SFU) RoomCount() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return len(s.rooms)
}

// PeerCount returns how many peers are connected across all rooms.
func (s *SFU) PeerCount() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	n := 0
	for _, r := range s.rooms {
		r.mu.RLock()
		n += len(r.peers)
		r.mu.RUnlock()
	}
	return n
}

// CloseAll tears down every room and every PeerConnection — used by the
// graceful-shutdown path on SIGINT/SIGTERM.
func (s *SFU) CloseAll() {
	s.mu.Lock()
	defer s.mu.Unlock()
	for id, r := range s.rooms {
		r.closeLocked()
		delete(s.rooms, id)
	}
}

func (r *Room) isClosingLocked() bool {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.closing
}

// scheduleIdleCloseLocked plans a close if the room stays empty for
// EmptyGrace. Called with r.mu (write) held.
func (r *Room) scheduleIdleCloseLocked() {
	if r.idleTimer != nil {
		r.idleTimer.Stop()
	}
	r.idleTimer = time.AfterFunc(EmptyGrace, func() {
		r.mu.Lock()
		empty := len(r.peers) == 0 && !r.closing
		if empty {
			log.Printf("sfu: room %s empty %s — closing", r.id, EmptyGrace)
			r.closing = true
			r.idleTimer = nil
			r.destroyLocked()
		}
		r.mu.Unlock()
		if empty && r.sfu != nil {
			// Drop from the room table (takes s.mu — never while holding r.mu).
			r.sfu.dropRoomIfClosing(r.id)
		}
	})
}

func (r *Room) resetIdleTimerLocked() {
	if r.idleTimer != nil {
		r.idleTimer.Reset(EmptyGrace)
	}
}

// destroyLocked closes PeerConnections. Called with r.mu held, but DTLS
// teardown can block, so the heavy work runs detached: the room is already
// marked closing and removed from the table, no new peers can arrive.
func (r *Room) destroyLocked() {
	peers := make([]*Peer, 0, len(r.peers))
	for _, p := range r.peers {
		peers = append(peers, p)
	}
	r.peers = make(map[string]*Peer)
	r.tracks = make(map[string]*forwardingTrack)
	r.subs = make(map[string]map[string]*webrtc.RTPSender)

	go func() {
		for _, p := range peers {
			if err := p.Close(); err != nil {
				log.Printf("sfu: peer %s close: %v", p.ID, err)
			}
		}
	}()
}

func (r *Room) closeLocked() {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closing {
		return
	}
	r.closing = true
	if r.idleTimer != nil {
		r.idleTimer.Stop()
		r.idleTimer = nil
	}
	r.destroyLocked()
}

// Join adds a peer to the room. The caller wires send (ws writer) and the
// returned peer runs its own renegotiation goroutine.
func (r *Room) Join(id string, pc *webrtc.PeerConnection, send func(SignalMsg) error) (*Peer, error) {
	r.mu.Lock()
	if r.closing {
		r.mu.Unlock()
		return nil, ErrRoomClosed
	}
	if r.idleTimer != nil {
		r.idleTimer.Reset(EmptyGrace)
	}

	ctx, cancel := context.WithCancel(context.Background())
	peer := &Peer{
		ID:       id,
		Conn:     pc,
		room:     r,
		send:     send,
		kick:     make(chan struct{}, 1),
		answerIn: make(chan webrtc.SessionDescription, 1),
		cancel:   cancel,
		ctx:      ctx,
	}
	r.peers[id] = peer
	r.subs[id] = make(map[string]*webrtc.RTPSender)

	// Attach all currently published tracks BEFORE the caller applies the
	// client's offer, so the initial answer already carries them (no
	// renegotiation needed for the steady state).
	existing := make([]*forwardingTrack, 0, len(r.tracks))
	for _, t := range r.tracks {
		existing = append(existing, t)
	}
	r.mu.Unlock()

	peer.wg.Add(1)
	go peer.renegotiateLoop(ctx)

	for _, ft := range existing {
		r.subscribe(peer, ft)
	}
	return peer, nil
}

// subscribe attaches a published track to a peer's connection. Tracks added
// before the peer's first negotiation ride along in the initial answer;
// tracks added after it trigger a server-initiated renegotiation offer.
// r.mu is NOT held here (pion calls are slow; do not stall the room).
func (r *Room) subscribe(peer *Peer, t *forwardingTrack) {
	if peer.ID == t.sourcePeerID || peer.isClosed() {
		return
	}
	priorNegotiated := peer.Conn.SignalingState() != webrtc.SignalingStateStable ||
		len(peer.Conn.GetTransceivers()) > 0
	sender, err := peer.Conn.AddTrack(t.outgoing)
	if err != nil {
		log.Printf("sfu: peer %s AddTrack %s: %v", peer.ID, t.outgoing.ID(), err)
		return
	}
	key := localTrackKey(t)
	r.mu.Lock()
	if r.subs[peer.ID] == nil {
		r.subs[peer.ID] = make(map[string]*webrtc.RTPSender)
	}
	r.subs[peer.ID][key] = sender
	r.mu.Unlock()

	if priorNegotiated {
		// The peer already answered its initial handshake: this track needs
		// a fresh offer so the client's SDP learns the new m-line.
		peer.kickNegotiation()
	}
}

func localTrackKey(t *forwardingTrack) string {
	return t.sourcePeerID + "/" + t.incoming.ID()
}

// Publish is called by the room when a peer's OnTrack fired: it creates the
// shared subscriber track for this incoming stream and fans it out.
func (r *Room) Publish(peer *Peer, incoming *webrtc.TrackRemote) {
	streamID := "shard-" + peer.ID + "-" + incoming.ID()
	local, err := webrtc.NewTrackLocalStaticRTP(incoming.Codec().RTPCodecCapability, streamID, "shard-media")
	if err != nil {
		log.Printf("sfu: NewTrackLocalStaticRTP: %v", err)
		return
	}
	ft := &forwardingTrack{
		sourcePeerID: peer.ID,
		incoming:     incoming,
		outgoing:     local,
	}

	r.mu.Lock()
	if r.closing {
		r.mu.Unlock()
		return
	}
	r.tracks[localTrackKey(ft)] = ft
	subs := make([]*Peer, 0, len(r.peers))
	for _, p := range r.peers {
		if p.ID != peer.ID {
			subs = append(subs, p)
		}
	}
	r.mu.Unlock()

	for _, s := range subs {
		r.subscribe(s, ft)
	}
	peer.addIncomingTrack(r, ft)
}

// addIncomingTrack records a track the peer publishes and starts its pump.
func (p *Peer) addIncomingTrack(room *Room, t *forwardingTrack) {
	p.wg.Add(1)
	go p.pumpRTP(room, t)
}

// pumpRTP forwards RTP packets from the publisher into the shared local
// track. Exits when the track closes (peer left) or the room dies.
func (p *Peer) pumpRTP(room *Room, t *forwardingTrack) {
	defer p.wg.Done()
	// One malformed RTP packet must never take the whole media node down:
	// recover, log the stack, and let teardown paths reclaim the peer.
	defer func() {
		if r := recover(); r != nil {
			log.Printf("sfu: peer %s rtp pump (%s) recovered from panic: %v\n%s",
				p.ID, t.outgoing.ID(), r, debug.Stack())
		}
	}()

	rtpBuf := make([]byte, 1500)
	for {
		n, _, err := t.incoming.Read(rtpBuf)
		if err != nil {
			return // read errors on close are normal teardown
		}
		if p.isClosed() {
			return
		}
		room.deliverToSubscribers(t, rtpBuf[:n])
	}
}

// RemovePeer removes a peer from the room: unpublishes its tracks (others
// drop the m-lines via RemoveTrack + renegotiation) and, when the room is
// empty, starts the grace timer that destroys the room.
func (r *Room) RemovePeer(peerID string) {
	r.mu.Lock()
	peer, ok := r.peers[peerID]
	if !ok {
		r.mu.Unlock()
		return
	}
	delete(r.peers, peerID)
	delete(r.subs, peerID)

	// Unpublish all tracks sourced from this peer and drop the m-lines
	// other members still carry for them.
	var detach []func()
	for key, t := range r.tracks {
		if t.sourcePeerID != peerID {
			continue
		}
		delete(r.tracks, key)
		for subID, senders := range r.subs {
			sender, ok := senders[key]
			if !ok {
				continue
			}
			delete(senders, key)
			sub, ok := r.peers[subID]
			if !ok {
				continue
			}
			subRef := sub
			detach = append(detach, func() {
				if err := subRef.Conn.RemoveTrack(sender); err != nil {
					log.Printf("sfu: RemoveTrack %s/%s: %v", subID, key, err)
				}
				subRef.kickNegotiation()
			})
		}
	}
	if len(r.peers) == 0 {
		log.Printf("sfu: room %s now empty — grace %s before close", r.id, EmptyGrace)
		r.scheduleIdleCloseLocked()
	}
	r.mu.Unlock()

	for _, fn := range detach {
		fn()
	}
	if err := peer.Close(); err != nil {
		log.Printf("sfu: peer %s close: %v", peerID, err)
	}
}

// deliverToSubscribers writes one RTP packet into the shared local track;
// pion fans it out to every bound RTPSender. The sender's own packets never
// come back — its PC has no binding for its own track.
func (r *Room) deliverToSubscribers(t *forwardingTrack, pkt []byte) {
	pktCopy := make([]byte, len(pkt))
	copy(pktCopy, pkt) // the pump reuses its read buffer
	p := &rtpPacket{}
	if err := p.Unmarshal(pktCopy); err != nil {
		return // malformed packet — nothing to forward
	}
	if err := t.outgoing.WriteRTP(p); err != nil {
		// Write failures here are typical when a subscriber link dies;
		// the room's teardown logic collects PeerConnections.
		return
	}
}
