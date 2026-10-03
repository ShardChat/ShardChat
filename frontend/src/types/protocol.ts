// SHARD — WebSocket packet contract (plan.md §5). Shared by the WS hook
// and the landing screen room-creation request.
export type WSPacketType =
  | "JOIN"
  | "PEER_JOINED"
  | "KEY_EXCHANGE"
  | "CIPHER_MESSAGE"
  | "REACTION"
  | "TYPING"
  | "READ_RECEIPT"
  | "BURN_ROOM"
  // Relay-session deltas - all opaque to the server, decrypted only by peers:
  | "EDIT_MESSAGE"
  | "DELETE_MESSAGE"
  | "PIN_MESSAGE"
  | "POLL_VOTE"
  | "VIEW_ONCE_OPEN"
  // Chunked file streaming (relayed opaquely by the server):
  | "FILE_CHUNK_START"
  | "FILE_CHUNK_DATA"
  | "FILE_CHUNK_END"
  // Retired: PeerJS ids are gone with the public signaling cloud. The
  // server still relays the type so a stale client never breaks the room.
  | "PEER_ID_ANNOUNCE"
  | "CALL_INVITE"
  | "CALL_REJECT"
  | "CALL_HANGUP"
  // WebRTC signaling, relayed over this same blind socket. SDP and ICE are
  // bearer-equivalent to the session (they carry host addresses), so they ride
  // the two-seat channel that already exists instead of a third-party broker.
  | "CALL_OFFER"
  | "CALL_ANSWER"
  | "CALL_ICE"
  // Server-generated events (mirror of backend/internal/ws/protocol.go):
  | "WELCOME"
  | "PEER_LEFT"
  | "ROOM_BURNED"
  | "ERROR";

/** Every WebSocket frame is this JSON envelope. */
export interface WSPacket<P = unknown> {
  type: WSPacketType;
  payload?: P;
}

/** Encrypted application payload — opaque to the server (plan.md §5). */
export interface CipherPayload {
  id: string;
  iv: string;
  ciphertext: string;
  timestamp: number;
}

/** Announces an incoming chunked file. Name is client-supplied and E2EE on the wire. */
export interface FileChunkStartPayload {
  fileId: string;
  name: string;
  mime: string;
  totalSize: number;
  totalChunks: number;
  chunkSize: number;
  /** Optional photo caption, sealed with the same key (rides the START frame). */
  caption?: string;
  /** Sender's message id: makes the receiver's copy deletable by DELETE_MESSAGE. */
  messageId?: string;
  /** True for generic attachments → the receiver renders the card UI too. */
  attachment?: boolean;
}

/** One AES-GCM sealed 64 KB slice: (chunkIndex, iv, ciphertext). */
export interface FileChunkDataPayload {
  fileId: string;
  chunkIndex: number;
  iv: string;
  ciphertext: string;
}

export interface FileChunkEndPayload {
  fileId: string;
}

export interface PeerEventPayload {
  peerCount: number;
  expiresAt?: number;
}

export interface WelcomePayload {
  expiresAt: number;
  peerCount?: number;
}

export interface ReadReceiptPayload {
  messageId: string;
}

export interface TypingPayload {
  isTyping: boolean;
}

export interface ReactionPayload {
  messageId: string;
  emoji: string;
  op: "add" | "remove";
}

/** EDIT_MESSAGE: replaces the plaintext body of a text message. */
export interface EditMessagePayload {
  messageId: string;
  text: string;
}

/** DELETE_MESSAGE: remove-for-everyone tombstone. */
 export interface DeleteMessagePayload {
  messageId: string;
}

/** PIN_MESSAGE: one pinned message per room; empty id unpins. */
export interface PinMessagePayload {
  messageId: string | null;
}

/** POLL_VOTE: adds or moves this peer's vote within one poll. */
export interface PollVotePayload {
  messageId: string;
  optionIndex: number; // -1 = retract vote
}

/** VIEW_ONCE_OPEN: the receiver triggered a view-once media reveal. */
export interface ViewOnceOpenPayload {
  messageId: string;
}

/** KEY_EXCHANGE carries the peer's base64 raw ECDH public key. */
export interface KeyExchangePayload {
  pub: string;
}

/** JOIN carries our own public key (server relays it to the peer). */
export interface JoinPayload {
  pub: string;
}

export interface ErrorPayload {
  error: string;
}

export interface PeerIDAnnouncePayload {
  peerId: string;
}

export interface CallInvitePayload {
  kind: "audio" | "video";
}

/** SDP offer/answer for one call, relayed opaquely . */
export interface CallSignalPayload {
  sdp: string;
}

/** One trickled ICE candidate. `null` is the end-of-candidates marker. */
export interface CallIcePayload {
  candidate: RTCIceCandidateInit | null;
}

export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface TurnCredentialsResponse {
  iceServers: IceServer[];
}

/** POST /api/rooms response from the Go relay. */
export interface CreateRoomResponse {
  roomId: string;
  expiresAt: string;
}

/** TTL choices offered by the landing screen (whitelist mirrored server-side). */
export const TTL_OPTIONS = [
  { minutes: 30, label: "30 min" },
  { minutes: 120, label: "2 hours" },
  { minutes: 1440, label: "24 hours" },
] as const;
