// SHARD — chat session core. Owns the whole E2EE lifecycle:
// JOIN -> PEER_JOINED -> KEY_EXCHANGE -> shared AES key -> encrypted traffic.
// everything the server relays beyond the handshake is ciphertext.
// session deltas (edit/delete/pin/polls/view-once) ride dedicated packet
// types whose payloads are sealed with the same shared AES-GCM-256 key.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useWebSocket, type WsStatus } from "./useWebSocket";
import {
  deriveSharedKey,
  generateECDHKeyPair,
  generateEmojiFingerprint,
  exportPublicKey,
  importPublicKey,
} from "../crypto/ecdh";
import { encryptPayload, decryptPayload } from "../crypto/cipher";
import { compressImage } from "../lib/media";
import { checkFile } from "../lib/fileSecurity";
import { useFileTransfer } from "./useFileTransfer";
import type {
  CipherPayload,
  DeleteMessagePayload,
  EditMessagePayload,
  KeyExchangePayload,
  PinMessagePayload,
  PollVotePayload,
  ReactionPayload,
  ReadReceiptPayload,
  TypingPayload,
  ViewOnceOpenPayload,
  WelcomePayload,
  PeerEventPayload,
  WSPacket,
} from "../types/protocol";
import type { ChatMessage, MessageBody, PollBody, TransferState } from "../types/chat";
import { isValidId, randomId } from "../lib/utils";

export type SessionPhase =
  | "connecting" // WS not open yet
  | "waiting" // WS open, waiting for the peer
  | "exchanging" // peer present, keys in flight
  | "secure" // E2EE channel established
  | "peer_away" // partner dropped; the room holds it open for their return
  | "burned" // room destroyed (by peer or by button)
  | "gone" // room vanished server-side: restart or TTL while away
  | "room_full"; // terminal: both seats taken, this client is not one of them

const TYPING_DEBOUNCE_MS = 300;
const TYPING_EXPIRE_MS = 3000;

/** Why the session ended — derived from real signals (server goodbye,
 *  PEER_LEFT, TTL deadline) and shown as the highlighted cause row. */
export type BurnReason = "manual" | "peer-left" | "timer" | "restart";

/** Real numbers behind the burned-screen badge: what THIS tab held in RAM
 *  and purged when the session ended — measured first, then wiped for real. */
export interface PurgeStats {
  /** Approximate payload bytes: UTF-8 texts, decoded base64 bodies, file sizes. */
  bytes: number;
  /** Message count removed from local memory. */
  messages: number;
  /** Detected cause; null = unknown (dead link, server restart, never joined). */
  reason: BurnReason | null;
}

interface UseChatSessionResult {
  phase: SessionPhase;
  fingerprint: [string, string, string, string] | null;
  expiresAt: number | null;
  peerConnected: boolean;
  messages: ChatMessage[];
  peerTyping: boolean;
  wsStatus: WsStatus;
  /** Live chunked-transfer progress entries (upload/download). */
  transfers: TransferState[];
  /** Last security-guard rejection (blocklist / zip / size) for the toast. */
  securityNotice: string | null;
  /** Surfaces a quiet rejection from the input dock (queue gate). */
  reportSecurity: (reason: string) => void;
  /** True once a REST probe confirmed the room exists (pre-flight gate). */
  verified: boolean;
  /** Terminal rejection: the room's two seats are occupied by someone else. */
  roomFull: boolean;
  /** id of the room's single pinned message (null = none). */
  pinnedId: string | null;
  /** What this tab purged when the session ended (burned screen badge). */
  purgeStats: PurgeStats | null;
  sendText: (text: string, replyTo?: ChatMessage["id"]) => void;
  sendImage: (file: File, replyTo?: ChatMessage["id"], viewOnce?: boolean, caption?: string) => Promise<void>;
  /** Any non-image attachment (video/audio/docs/archives): security-gated, E2EE. */
  sendAttachment: (file: File, caption?: string) => Promise<void>;
  sendAudio: (blob: Blob, wave: number[], durationMs: number) => Promise<void>;
  sendPoll: (question: string, options: string[]) => void;
  editMessage: (messageId: string, text: string) => void;
  deleteMessage: (messageId: string) => void;
  pinMessage: (messageId: string | null) => void;
  votePoll: (messageId: string, optionIndex: number) => void;
  openViewOnce: (messageId: string) => void;
  toggleReaction: (messageId: string, emoji: string) => void;
  notifyTyping: () => void;
  markRead: (messageId: string) => void;
  burnRoom: () => void;
  sendSignal: (pkt: WSPacket) => boolean;
  onSignal: (handler: (pkt: WSPacket) => void) => () => void;
  onWsReconnect: (handler: () => void) => () => void;
}

export function useChatSession(roomId: string): UseChatSessionResult {
  const { send, on, onReconnect, goneRef, statusRef, verified, roomFull, bufferedAmount } = useWebSocket(roomId, true);

  const [phase, setPhase] = useState<SessionPhase>("connecting");
  const [fingerprint, setFingerprint] = useState<[string, string, string, string] | null>(null);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [peerTyping, setPeerTyping] = useState(false);
  const [transfers, setTransfers] = useState<TransferState[]>([]);
  const [pinnedId, setPinnedId] = useState<string | null>(null);
  /** Last security-guard rejection (blocklist / zip / size) for the toast. */
  const [securityNotice, setSecurityNotice] = useState<string | null>(null);
  const reportSecurity = useCallback((reason: string) => {
    setSecurityNotice(reason);
  }, []);
  // the toast auto-dismisses after 6s — quiet, not a permanent banner.
  useEffect(() => {
    if (!securityNotice) return;
    const t = window.setTimeout(() => setSecurityNotice(null), 6000);
    return () => window.clearTimeout(t);
  }, [securityNotice]);

  // Mutable session state kept in refs (no re-render storms).
  const keyPairRef = useRef<CryptoKeyPair | null>(null);
  const sharedKeyRef = useRef<CryptoKey | null>(null);
  const peerJoinedRef = useRef(false);
  const exchangedRef = useRef(false);
  const exchSentRef = useRef(false);
  const peerPubRef = useRef<string | null>(null);
  /** Set when the peer's connection dropped (PEER_LEFT) on a full room. */
  const peerLeftRef = useRef(false);
  const typingSentAtRef = useRef(0);
  /** Inbound only: drops the peer's indicator when it goes stale. */
  const typingExpireRef = useRef<number>(0);
  /** Outbound only: withdraws our own "typing" once we stop producing input. */
  const typingStopRef = useRef<number>(0);
  /** True while this tab has an unwithdrawn "typing" announcement. */
  const typingActiveRef = useRef(false);
  /** Inbound TYPING flood gate: accept "typing" at most once per 250 ms. */
  const lastTypingAtRef = useRef(0);
  /** Monotonic handshake epoch: a hello() superseded while its key pair
   *  was being minted (StrictMode double-mount, fast reconnect) is discarded. */
  const sessionEpochRef = useRef(0);
  /** JOIN packet parked until the socket is open (fires from onopen). */
  const pendingJoinRef = useRef<WSPacket | null>(null);
  /** Cause latched at the FIRST end-signal; later phase flips never rewrite it. */
  const burnReasonRef = useRef<BurnReason | null>(null);
  /** True when THIS tab sent the BURN_ROOM (self burn → "manual"). */
  const selfBurnedRef = useRef(false);
  /** TTL deadline mirror: the WS-packet closure is registered once at mount,
   *  so it must read the deadline through a ref, not a stale state closure. */
  const expiresAtRef = useRef<number | null>(null);
  expiresAtRef.current = expiresAt;

  // media blob URLs outlive message state unless explicitly revoked;
  // keep a live handle so unmount (burn / exit / navigation) frees every
  // file URL instead of pinning Blobs until the tab closes.
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  useEffect(
    () => () => {
      for (const m of messagesRef.current) {
        if (m.body.kind === "file" && m.body.url) URL.revokeObjectURL(m.body.url);
      }
    },
    [],
  );

  // Burn/gone telemetry: measure what this tab actually held, then wipe it
  // or real — messages leave state, key references drop, blob URLs revoke.
  // layout effect so the burned-screen badge paints with the true numbers.
  // the latch is monotonic: the first end-event wins and later phase flips
  // (WS close → hello() "connecting" → probe "gone") must never overwrite
  // the measurement with an already-emptied state.
  const [purgeStats, setPurgeStats] = useState<PurgeStats | null>(null);
  const purgedRef = useRef(false);
  useLayoutEffect(() => {
    if (purgedRef.current) return;
    if (phase !== "burned" && phase !== "gone" && phase !== "room_full") return;
    purgedRef.current = true;
    const wiped = messagesRef.current;
    setPurgeStats({
      bytes: wiped.reduce((n, m) => n + bodyBytes(m.body), 0),
      messages: wiped.length,
      reason: burnReasonRef.current,
    });
    for (const m of wiped) {
      if (m.body.kind === "file" && m.body.url) URL.revokeObjectURL(m.body.url);
    }
    setMessages([]);
    setTransfers([]);
    setPinnedId(null);
    keyPairRef.current = null;
    sharedKeyRef.current = null;
  }, [phase]);

  /** Ends the session for good. The first end-signal latches the cause:
   *  ROOM_BURNED goodbye, PEER_LEFT, a failed probe or the burn button all
   *  funnel here, and later signals never overwrite the attribution. */
  const endSession = useCallback((reason: BurnReason | null) => {
    if (burnReasonRef.current === null) burnReasonRef.current = reason;
    setPhase("burned");
  }, []);

  // Chunked file streaming: the wire sees ~86 KB sealed chunks;
  // the relay forwards each immediately, buffering nothing.
  const { sendFile, handleChunkPacket } = useFileTransfer({
    send,
    bufferedAmount, // real socket backlog: pauses chunking past ~1 MB
  });
  const phaseRef = useRef<SessionPhase>("connecting");
  phaseRef.current = phase;

  const establishSecure = useCallback(async () => {
    const pair = keyPairRef.current;
    const peerPub = peerPubRef.current;
    if (!pair || !peerPub || exchangedRef.current) return;
    exchangedRef.current = true;
    try {
      const peerKey = await importPublicKey(peerPub);
      const shared = await deriveSharedKey(pair.privateKey, peerKey);
      sharedKeyRef.current = shared;
      const fp = await generateEmojiFingerprint(pair.privateKey, peerKey);
      setFingerprint(fp);
      setPhase("secure");
    } catch {
      // An invalid curve point / malformed key from the peer (or a
      // flaky crypto backend) must never surface as an unhandled rejection
      // or crash the promise chain - the handshake just fails quietly and
      // an be re-attempted on the next KEY_EXCHANGE.
      exchangedRef.current = false;
    }
  }, []);

  const tryKeyExchange = useCallback(() => {
    if (peerLeftRef.current || !peerJoinedRef.current || !keyPairRef.current || exchSentRef.current) return;
    setPhase("exchanging");
    exchSentRef.current = true;
    exportPublicKey(keyPairRef.current.publicKey).then((pub) => {
      send({ type: "KEY_EXCHANGE", payload: { pub } satisfies KeyExchangePayload });
    });
  }, [send]);

  // fresh (re)connect: restore a clean handshake slate, and JOIN strictly
  // from the socket's open callback so the key that crosses the wire is
  // always minted on THIS connection (kills the stale-key race entirely).
  const hello = useCallback(() => {
    // Each hello() starts a new handshake epoch. If another hello()
    // fires before this one's keys are minted, the epoch check below
    // discards the stale pair instead of racing the JOIN it already sent.
    const epoch = ++sessionEpochRef.current;
    exchangedRef.current = false;
    exchSentRef.current = false;
    peerPubRef.current = null;
    keyPairRef.current = null;
    peerLeftRef.current = false;
    setPhase("connecting");
    generateECDHKeyPair().then(async (pair) => {
      if (epoch !== sessionEpochRef.current) return; // superseded handshake
      keyPairRef.current = pair;
      const pub = await exportPublicKey(pair.publicKey);
      pendingJoinRef.current = { type: "JOIN", payload: { pub } };
      // If the socket already opened before the keys were ready, fire now;
      // otherwise the onopen handler will pick pendingJoinRef up.
      if (statusRef.current === "open") {
        send(pendingJoinRef.current);
        pendingJoinRef.current = null;
      }
      if (peerPubRef.current) {
        tryKeyExchange();
        establishSecure();
      }
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [send, tryKeyExchange, establishSecure]);

  useEffect(() => {
    const offPacket = on((pkt: WSPacket) => {
      // Client barrier: application traffic that arrives before the E2EE
      // channel is established is by definition spoofed or stale — the peer
      // had no shared key to seal it with. Drop before it touches any state.
      if (
        phaseRef.current !== "secure" &&
        (pkt.type === "CIPHER_MESSAGE" ||
          pkt.type === "TYPING" ||
          pkt.type === "REACTION" ||
          pkt.type === "READ_RECEIPT" ||
          pkt.type === "FILE_CHUNK_START" ||
          pkt.type === "FILE_CHUNK_DATA" ||
          pkt.type === "FILE_CHUNK_END")
      ) {
        return;
      }
      switch (pkt.type) {
        case "WELCOME": {
          const p = pkt.payload as WelcomePayload;
          if (p?.expiresAt) setExpiresAt(p.expiresAt);
          // reconnect into an already-full room: resume the handshake
          // without waiting for a PEER_JOINED that will never repeat.
          if ((p?.peerCount ?? 0) >= 2) {
            peerJoinedRef.current = true;
            if (!sharedKeyRef.current) {
              // reconnect of the SAME seat after a flap: the server replays
              // the peer's cached key, so re-arm the answer and re-derive.
              exchSentRef.current = false;
              establishSecure();
            }
            tryKeyExchange();
          }
          break;
        }
        case "PEER_JOINED": {
          const p = pkt.payload as PeerEventPayload;
          if (p?.expiresAt) setExpiresAt(p.expiresAt);
          peerJoinedRef.current = true;
          peerLeftRef.current = false;
          // The partner took their seat back inside the reconnect window -
          // leave the waiting state and let the handshake re-arm.
          setPhase((p2) => (p2 === "peer_away" ? "exchanging" : p2));
          tryKeyExchange();
          break;
        }
        case "KEY_EXCHANGE": {
          const p = pkt.payload as KeyExchangePayload;
          // A P-256 public key is base64 of a 65-byte uncompressed
          // point (~88 chars). Anything else never reaches WebCrypto.
          const pub = p?.pub;
          if (typeof pub === "string" && pub.length >= 86 && pub.length <= 92 && /^[A-Za-z0-9+/]+=*$/.test(pub)) {
            peerPubRef.current = pub;
            // the joining peer never sees PEER_JOINED (the server notifies
            // only the first seat), so answer with our own key right here.
            tryKeyExchange();
            establishSecure();
          }
          break;
        }
        case "CIPHER_MESSAGE": {
          const p = pkt.payload as CipherPayload;
          if (!p?.iv || !p?.ciphertext) break; // the envelope must be well-formed
          void handleCipher(p, false);
          break;
        }
        case "EDIT_MESSAGE": {
          const key = sharedKeyRef.current;
          if (!key) break;
          void decryptPayload<EditMessagePayload>(key, (pkt.payload as { iv: string; ciphertext: string }).iv, (pkt.payload as { iv: string; ciphertext: string }).ciphertext)
            .then((p) => {
              if (!isValidId(p?.messageId)) return; // L-1
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === p.messageId && m.body.kind === "text"
                    ? { ...m, body: { ...m.body, text: p.text, edited: true } }
                    : m,
                ),
              );
            })
            .catch(() => {});
          break;
        }
        case "DELETE_MESSAGE": {
          const key = sharedKeyRef.current;
          if (!key) break;
          void decryptPayload<DeleteMessagePayload>(key, (pkt.payload as { iv: string; ciphertext: string }).iv, (pkt.payload as { iv: string; ciphertext: string }).ciphertext)
            .then((p) => {
              if (!isValidId(p?.messageId)) return; // L-1
              setMessages((prev) => {
                // free the blob URL of any media the delete removes.
                prev.forEach((m) => {
                  if (m.id === p.messageId && m.body.kind === "file" && m.body.url) URL.revokeObjectURL(m.body.url);
                });
                return prev.filter((m) => m.id !== p.messageId);
              });
              setPinnedId((pin) => (pin === p.messageId ? null : pin));
            })
            .catch(() => {});
          break;
        }
        case "PIN_MESSAGE": {
          const key = sharedKeyRef.current;
          if (!key) break;
          void decryptPayload<PinMessagePayload>(key, (pkt.payload as { iv: string; ciphertext: string }).iv, (pkt.payload as { iv: string; ciphertext: string }).ciphertext)
            .then((p) => setPinnedId(p == null || p.messageId === null || isValidId(p.messageId) ? p?.messageId ?? null : null)) // null unpins; garbage pins nothing
            .catch(() => {});
          break;
        }
        case "POLL_VOTE": {
          const key = sharedKeyRef.current;
          if (!key) break;
          void decryptPayload<PollVotePayload>(key, (pkt.payload as { iv: string; ciphertext: string }).iv, (pkt.payload as { iv: string; ciphertext: string }).ciphertext)
            .then((p) => {
              if (!isValidId(p?.messageId)) return; // L-1
              setMessages((prev) => prev.map((m) => (m.id === p.messageId && m.body.kind === "poll" ? { ...m, body: applyPollVote(m.body, "peer", p.optionIndex) } : m)));
            })
            .catch(() => {});
          break;
        }
        case "VIEW_ONCE_OPEN": {
          const key = sharedKeyRef.current;
          if (!key) break;
          void decryptPayload<ViewOnceOpenPayload>(key, (pkt.payload as { iv: string; ciphertext: string }).iv, (pkt.payload as { iv: string; ciphertext: string }).ciphertext)
            .then((p) => {
              if (!isValidId(p?.messageId)) return; // L-1
              // the sender learns the receiver opened it: flip our copy to
              // the burned ghost (the content is gone on the receiver side).
              setMessages((prev) => prev.map((m) => (m.id === p.messageId ? markViewOnceBurned(m) : m)));
            })
            .catch(() => {});
          break;
        }
        case "REACTION": {
          // reactions now ride the sealed delta channel like every
          // other session mutation — plaintext REACTION frames are ignored.
          const key = sharedKeyRef.current;
          if (!key) break;
          void decryptPayload<ReactionPayload>(key, (pkt.payload as { iv: string; ciphertext: string }).iv, (pkt.payload as { iv: string; ciphertext: string }).ciphertext)
            .then((p) => {
              // malformed ids and non-scalar emoji never touch the UI.
              if (!isValidId(p?.messageId) || typeof p.emoji !== "string" || p.emoji.length === 0 || p.emoji.length > 16) return;
              applyReaction(messages, setMessages, p.messageId, p.emoji, "peer", p.op ?? "toggle");
            })
            .catch(() => {});
          break;
        }
        case "TYPING": {
          const p = pkt.payload as TypingPayload;
          // A sealed peer can still flood TYPING frames; each one costs
          // timer churn and a possible re-render. "Typing on" is accepted at
          // most once per 250 ms - the stop signal always goes through.
          if (p?.isTyping) {
            const now = Date.now();
            if (now - lastTypingAtRef.current < 250) break;
            lastTypingAtRef.current = now;
          }
          setPeerTyping(!!p?.isTyping);
          if (p?.isTyping) {
            window.clearTimeout(typingExpireRef.current);
            typingExpireRef.current = window.setTimeout(() => setPeerTyping(false), TYPING_EXPIRE_MS);
          } else {
            window.clearTimeout(typingExpireRef.current);
          }
          break;
        }
        case "READ_RECEIPT": {
          const p = pkt.payload as ReadReceiptPayload;
          if (isValidId(p?.messageId)) { // L-1
            setMessages((prev) =>
              prev.map((m) => (m.id === p.messageId ? { ...m, receipt: "read" } : m)),
            );
          }
          break;
        }
        case "FILE_CHUNK_START":
        case "FILE_CHUNK_DATA":
        case "FILE_CHUNK_END": {
          // chunk routing keys come from the peer — validate the shape
          // before they reach the transfer map or the messages list.
          const rawFileId = (pkt.payload as { fileId?: unknown } | null)?.fileId;
          if (pkt.type !== "FILE_CHUNK_START" && !isValidId(rawFileId)) break;
          if (pkt.type === "FILE_CHUNK_START" && rawFileId != null && !isValidId(rawFileId)) break;
          const key = sharedKeyRef.current;
          if (!key) break;
          void handleChunkPacket(pkt, {
            sharedKey: key,
            onProgress: (progress) => updateTransfer(pkt, progress, "down"),
            onDone: ({ blob, name, caption, messageId, attachment }) => {
              const id = messageId ?? randomId(); // sender's id when present → deletable both sides
              const mime = blob.type;
              // view-once payloads ride the chunk pipeline with a marker name.
              const viewOnce = name.startsWith(VIEW_ONCE_PREFIX);
              const cleanName = viewOnce ? name.slice(VIEW_ONCE_PREFIX.length) : name;
              setMessages((prev) => [
                ...prev,
                {
                  id,
                  sender: "peer",
                  body: viewOnce
                    ? { kind: "file", name: cleanName, mime, url: URL.createObjectURL(blob), size: blob.size, viewOnce: true, revealedAt: null, caption }
                    : { kind: "file", name, mime, url: URL.createObjectURL(blob), size: blob.size, caption, attachment },
                  timestamp: Date.now(),
                  receipt: "read",
                  reactions: new Map(),
                },
              ]);
              setTransfers((prev) => prev.filter((t) => t.progress < 1));
            },
          });
          break;
        }
        case "PEER_LEFT":
          // The partner is gone for now. The relay holds the room open for a
          // short reconnect window, because a phone that opened the photo
          // picker or switched apps drops its socket without ever saying
          // goodbye - burning here is what used to eject the surviving phone
          // from a perfectly healthy session. The composer locks (phase is no
          // longer "secure") and the real burn arrives as ROOM_BURNED if the
          // partner does not come back in time.
          peerLeftRef.current = true;
          setPhase((p) => (p === "burned" || p === "gone" ? p : "peer_away"));
          break;
        case "ROOM_BURNED":
          // server goodbye before teardown (never sent on a crash/restart).
          // the relay never says WHY, so attribute it here: a departed peer
          // wins, an already-passed TTL deadline means the timer, otherwise
          // a living peer must have burned the session manually.
          endSession(
            peerLeftRef.current
              ? "peer-left"
              : expiresAtRef.current != null && Date.now() >= expiresAtRef.current
                ? "timer"
                : "manual",
          );
          break;
        default:
          break;
      }
    });
    const offReconnect = onReconnect(() => {
      hello();
      // Fire the parked JOIN now that the socket is live.
      if (pendingJoinRef.current) {
        send(pendingJoinRef.current);
        pendingJoinRef.current = null;
      }
    });
    return () => {
      offPacket();
      offReconnect();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on, onReconnect, hello]);

  // Initial handshake on mount: mint keys immediately; the JOIN fires from
  // the socket's onopen via onReconnect (which also runs on first open).
  useEffect(() => {
    hello();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // server-side probe says the room is gone (restart/TTL/burn elsewhere):
  // top the retry loop and show the "room destroyed" screen. Poll the
  // watch so the flip happens promptly after the probe, not on rerender.
  const [goneLatch, setGoneLatch] = useState(false);
  useEffect(() => {
    const id = window.setInterval(() => setGoneLatch(goneRef.current), 500);
    return () => window.clearInterval(id);
  }, [goneRef]);
  useEffect(() => {
    if (goneLatch && phase !== "gone" && phase !== "burned" && phase !== "room_full") {
      // No goodbye arrived (crash/restart or a silent sweep): attribute via
      // the TTL deadline. A never-joined link (no deadline) stays unknown.
      if (burnReasonRef.current === null) {
        burnReasonRef.current = expiresAt == null ? null : Date.now() >= expiresAt ? "timer" : "restart";
      }
      setPhase("gone");
    }
  }, [goneLatch, phase, expiresAt]);

  // A rejected third participant: the socket hook has already stopped every
  // timer and network call, so this only records the terminal verdict. Latched
  // like the burn screen so a later render can never fall back to the chat.
  useEffect(() => {
    if (!roomFull) return;
    setPhase("room_full");
  }, [roomFull]);

  /** The peer's message landed: whatever they were typing, they are done. */
  function stopPeerTyping() {
    window.clearTimeout(typingExpireRef.current);
    lastTypingAtRef.current = 0;
    setPeerTyping(false);
  }

  /** Withdraws our own announcement the moment we stop (a message was sent). */
  function stopTyping() {
    window.clearTimeout(typingStopRef.current);
    if (!typingActiveRef.current) return;
    typingActiveRef.current = false;
    send({ type: "TYPING", payload: { isTyping: false } });
  }

  /** Decrypts an incoming envelope and folds it into the message list. */
  async function handleCipher(p: CipherPayload, isSelfEcho: boolean) {
    const key = sharedKeyRef.current;
    if (!key || !p.ciphertext) return;
    try {
      const body = await decryptPayload<MessageBody & { replyTo?: ChatMessage["body"]["replyTo"] }>(
        key,
        p.iv,
        p.ciphertext,
      );
      // the id shapes React keys, dedupe and all delta targeting —
      // reject malformed ones before they ever reach the message list.
      if (!isValidId(p.id)) return;
      stopPeerTyping();
      setMessages((prev) => {
        if (prev.some((m) => m.id === p.id)) return prev; // dedupe reconnects
        return [
          ...prev,
          {
            id: p.id,
            sender: isSelfEcho ? "self" : "peer",
            body,
            timestamp: p.timestamp,
            receipt: "read",
            reactions: new Map(),
          },
        ];
      });
    } catch {
    // Undecryptable: wrong key or corrupted frame - drop silently.
    }
  }

  const encryptAndSend = useCallback(
    async (id: string, body: MessageBody): Promise<boolean> => {
      const key = sharedKeyRef.current;
      if (!key) return false;
      stopTyping(); // Enter beats the 3 s withdraw timer — no lingering dots.
      const cipher = await encryptPayload(key, body);
      const packet: CipherPayload = {
        id,
        iv: cipher.iv,
        ciphertext: cipher.ciphertext,
        timestamp: Date.now(),
      };
      const ok = send({ type: "CIPHER_MESSAGE", payload: packet });
      if (ok) {
        setMessages((prev) => [
          ...prev,
          { id, sender: "self", body, timestamp: packet.timestamp, receipt: "sent", reactions: new Map() },
        ]);
      }
      return ok;
    },
    [send],
  );

  /** Encrypts a session-delta payload and sends it under a dedicated type. */
  const sendDelta = useCallback(
    async <P,>(type: "EDIT_MESSAGE" | "DELETE_MESSAGE" | "PIN_MESSAGE" | "POLL_VOTE" | "VIEW_ONCE_OPEN" | "REACTION", payload: P): Promise<boolean> => {
      const key = sharedKeyRef.current;
      if (!key) return false;
      const cipher = await encryptPayload(key, payload);
      return send({ type, payload: cipher as unknown as Record<string, unknown> });
    },
    [send],
  );

  const sendText = useCallback(
    (text: string, replyTo?: ChatMessage["id"]) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      const id = randomId();
      const quote = replyTo ? quoteOf(messages, replyTo) : undefined;
      void encryptAndSend(id, { kind: "text", text: trimmed, replyTo: quote });
    },
    [messages, encryptAndSend],
  );

  const sendImage = useCallback(
    async (file: File, replyTo?: ChatMessage["id"], viewOnce = false, caption?: string) => {
      // The row appears BEFORE any work starts. The security gate and the
      // canvas re-encode of a 12 MP phone photo take seconds, and until the
      // first byte is encrypted there was nothing on screen at all - the
      // composer just looked frozen with no way to tell it was still going.
      const prepId = randomId();
      const dropPrep = () => setTransfers((prev) => prev.filter((t) => t.fileId !== prepId));
      setTransfers((prev) => [
        ...prev,
        { fileId: prepId, progress: 0, direction: "up", name: file.name, phase: "prepare" },
      ]);

      const gate = await checkFile(file);
      if (!gate.ok) {
        dropPrep();
        setSecurityNotice(gate.reason);
        return;
      }
      const key = sharedKeyRef.current;
      if (!key) {
        dropPrep();
        return;
      }
      const quote = replyTo ? quoteOf(messages, replyTo) : undefined;
      const trimmedCaption = caption?.trim() || undefined;

      // canvas-compress BEFORE encryption (10 MB photo → ~0.5 MB),
      // then stream as 64 KB sealed chunks with a live progress bar.
      // view-once rides the same pipeline: the encrypted chunk-start name
      // carries the marker, so the wire stays fully opaque.
      const compressed = await compressImage(file);
      const payload = viewOnce
        ? new File([compressed], `${VIEW_ONCE_PREFIX}${file.name}`, { type: compressed.type || "image/jpeg" })
        : compressed;
      const fileId = randomId();
      // the message id is minted ONCE and shared with the peer via the
      // sealed FILE_CHUNK_START: DELETE_MESSAGE then removes the photo on
      // both sides (receiver previously minted its own id → delete missed).
      const messageId = randomId();
      setTransfers((prev) => [
        ...prev.filter((t) => t.fileId !== prepId),
        { fileId, progress: 0, direction: "up", name: file.name, phase: "stream" },
      ]);
      await sendFile(payload, {
        sharedKey: key,
        caption: trimmedCaption,
        messageId,
        onProgress: (progress) =>
          setTransfers((prev) => prev.map((t) => (t.fileId === fileId ? { ...t, progress } : t))),
        onDone: () => {
          setTransfers((prev) => prev.filter((t) => t.fileId !== fileId));
          setMessages((prev) => [
            ...prev,
            {
              id: messageId,
              sender: "self",
              body: viewOnce
                ? { kind: "file", name: file.name, mime: compressed.type || "image/jpeg", url: URL.createObjectURL(compressed), size: compressed.size, viewOnce: true, revealedAt: null, replyTo: quote, caption: trimmedCaption }
                : { kind: "file", name: file.name, mime: compressed.type || "image/jpeg", url: URL.createObjectURL(compressed), size: compressed.size, replyTo: quote, caption: trimmedCaption },
              timestamp: Date.now(),
              receipt: "sent",
              reactions: new Map(),
            },
          ]);
        },
      });
    },
    [messages, sendFile],
  );

  /** Security gate + generic attachment upload (video/audio/docs/archives).
   *  The shared AES-256-GCM session key seals every 64 KB chunk; the relay
   *  forwards frames blind and buffers nothing. */
  const sendAttachment = useCallback(
    async (file: File, caption?: string) => {
      const prepId = randomId();
      const dropPrep = () => setTransfers((prev) => prev.filter((t) => t.fileId !== prepId));
      setTransfers((prev) => [
        ...prev,
        { fileId: prepId, progress: 0, direction: "up", name: file.name, phase: "prepare" },
      ]);
      const gate = await checkFile(file);
      if (!gate.ok) {
        dropPrep();
        setSecurityNotice(gate.reason);
        return;
      }
      const key = sharedKeyRef.current;
      if (!key) {
        dropPrep();
        return;
      }
      const trimmedCaption = caption?.trim() || undefined;
      const messageId = randomId();
      const fileId = randomId();
      setTransfers((prev) => [
        ...prev.filter((t) => t.fileId !== prepId),
        { fileId, progress: 0, direction: "up", name: file.name, phase: "stream" },
      ]);
      await sendFile(file, {
        sharedKey: key,
        caption: trimmedCaption,
        messageId,
        attachment: true,
        onProgress: (progress) =>
          setTransfers((prev) => prev.map((t) => (t.fileId === fileId ? { ...t, progress } : t))),
        onDone: () => {
          setTransfers((prev) => prev.filter((t) => t.fileId !== fileId));
          setMessages((prev) => [
            ...prev,
            {
              id: messageId,
              sender: "self",
              body: {
                kind: "file",
                name: file.name,
                mime: file.type || "application/octet-stream",
                url: URL.createObjectURL(file),
                size: file.size,
                attachment: true,
                caption: trimmedCaption,
              },
              timestamp: Date.now(),
              receipt: "sent",
              reactions: new Map(),
            },
          ]);
        },
      });
    },
    [sendFile],
  );

  const sendAudio = useCallback(
    async (blob: Blob, wave: number[], durationMs: number) => {
      const id = randomId();
      const b64 = await blobToBase64(blob);
      await encryptAndSend(id, { kind: "audio", audioBase64: b64, wave, durationMs });
    },
    [encryptAndSend],
  );

  const sendPoll = useCallback(
    (question: string, options: string[]) => {
      const q = question.trim();
      const opts = options.map((o) => o.trim()).filter(Boolean);
      if (!q || opts.length < 2) return;
      const id = randomId();
      const body: PollBody = { kind: "poll", question: q, options: opts.slice(0, 4), votes: {} };
      void encryptAndSend(id, body);
    },
    [encryptAndSend],
  );

  const editMessage = useCallback(
    (messageId: string, text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      setMessages((prev) =>
        prev.map((m) =>
          m.id === messageId && m.body.kind === "text" ? { ...m, body: { ...m.body, text: trimmed, edited: true } } : m,
        ),
      );
      void sendDelta("EDIT_MESSAGE", { messageId, text: trimmed } satisfies EditMessagePayload);
    },
    [sendDelta],
  );

  const deleteMessage = useCallback(
    (messageId: string) => {
      setMessages((prev) => {
        // free the blob URL of any media the delete removes.
        prev.forEach((m) => {
          if (m.id === messageId && m.body.kind === "file" && m.body.url) URL.revokeObjectURL(m.body.url);
        });
        return prev.filter((m) => m.id !== messageId);
      });
      setPinnedId((pin) => (pin === messageId ? null : pin));
      void sendDelta("DELETE_MESSAGE", { messageId } satisfies DeleteMessagePayload);
    },
    [sendDelta],
  );

  const pinMessage = useCallback(
    (messageId: string | null) => {
      setPinnedId(messageId);
      void sendDelta("PIN_MESSAGE", { messageId } satisfies PinMessagePayload);
    },
    [sendDelta],
  );

  const votePoll = useCallback(
    (messageId: string, optionIndex: number) => {
      setMessages((prev) =>
        prev.map((m) => (m.id === messageId && m.body.kind === "poll" ? { ...m, body: applyPollVote(m.body, "self", optionIndex) } : m)),
      );
      void sendDelta("POLL_VOTE", { messageId, optionIndex } satisfies PollVotePayload);
    },
    [sendDelta],
  );

  const openViewOnce = useCallback(
    (messageId: string) => {
      setMessages((prev) => prev.map((m) => (m.id === messageId ? markViewOnceRevealed(m) : m)));
      void sendDelta("VIEW_ONCE_OPEN", { messageId } satisfies ViewOnceOpenPayload);
    },
    [sendDelta],
  );

  const toggleReaction = useCallback(
    (messageId: string, emoji: string) => {
      const op = applyReaction(messages, setMessages, messageId, emoji, "self", "toggle");
      // the reaction payload is sealed with the session key — the
      // relay (and any pre-handshake spoof) can no longer forge it.
      void sendDelta("REACTION", { messageId, emoji, op } satisfies ReactionPayload);
    },
    [sendDelta],
  );

  const notifyTyping = useCallback(() => {
    const now = Date.now();
    if (now - typingSentAtRef.current >= TYPING_DEBOUNCE_MS) {
      typingSentAtRef.current = now;
      typingActiveRef.current = true;
      send({ type: "TYPING", payload: { isTyping: true } });
      window.clearTimeout(typingStopRef.current);
      typingStopRef.current = window.setTimeout(stopTyping, TYPING_EXPIRE_MS);
    }
  }, [send]);

  const markRead = useCallback(
    (messageId: string) => {
      send({ type: "READ_RECEIPT", payload: { messageId } satisfies ReadReceiptPayload });
    },
    [send],
  );

  const burnRoom = useCallback(() => {
    selfBurnedRef.current = true;
    send({ type: "BURN_ROOM" });
    endSession("manual");
  }, [send, endSession]);

  return {
    phase,
    fingerprint,
    expiresAt,
    peerConnected: (phase === "secure" || phase === "exchanging") && !peerLeftRef.current,
    messages,
    peerTyping,
    wsStatus: (statusRef.current ?? "connecting") as WsStatus,
    verified,
    roomFull,
    transfers,
    pinnedId,
    purgeStats,
    securityNotice,
    reportSecurity,
    sendAttachment,
    sendText,
    sendImage,
    sendAudio,
    sendPoll,
    editMessage,
    deleteMessage,
    pinMessage,
    votePoll,
    openViewOnce,
    toggleReaction,
    notifyTyping,
    markRead,
    burnRoom,
    sendSignal: send,
    onSignal: on,
    onWsReconnect: onReconnect,
  };

  /** Keeps the live transfer bar in sync (upload or download). */
  function updateTransfer(pkt: WSPacket, progress: number, direction: "up" | "down") {
    const fileId = (pkt.payload as { fileId?: string })?.fileId;
    if (!fileId) return;
    setTransfers((prev) => {
      const existing = prev.find((t) => t.fileId === fileId);
      if (existing) return prev.map((t) => (t.fileId === fileId ? { ...t, progress } : t));
      return [...prev, { fileId, progress, direction, name: "file" }];
    });
  }
}

// ---- pure helpers ----

/** Encrypted chunk-start name prefix marking a view-once file. */
export const VIEW_ONCE_PREFIX = "burn-once:";

const UTF8 = new TextEncoder();

/** Approximate in-memory size of one decrypted message body, in bytes. */
function bodyBytes(body: MessageBody): number {
  const utf8 = (s: string) => UTF8.encode(s).length;
  switch (body.kind) {
    case "text":
      return utf8(body.text);
    case "image":
      return Math.ceil(body.imageBase64.length * 0.75); // base64 → raw
    case "audio":
      return Math.ceil(body.audioBase64.length * 0.75);
    case "file":
      return body.size + (body.caption ? utf8(body.caption) : 0);
    case "poll":
      return utf8(body.question) + body.options.reduce((n, o) => n + utf8(o), 0);
  }
}

/** Receiver: stamp the reveal time (starts the 10s burn clock). */
function markViewOnceRevealed(m: ChatMessage): ChatMessage {
  if (m.body.kind === "file" && m.body.viewOnce) {
    return { ...m, body: { ...m.body, revealedAt: Date.now() } };
  }
  return m;
}

/** Sender: the receiver opened it — replace our copy with the burned ghost. */
function markViewOnceBurned(m: ChatMessage): ChatMessage {
  if (m.body.kind === "file" && m.body.viewOnce) {
    URL.revokeObjectURL(m.body.url);
    return { ...m, body: { ...m.body, url: "", revealedAt: -1 } };
  }
  return m;
}

/** Adds/moves/retracts one voter inside a poll body (pure). */
function applyPollVote(body: PollBody, voter: "self" | "peer", optionIndex: number): PollBody {
  const votes: PollBody["votes"] = {};
  for (const [k, v] of Object.entries(body.votes)) {
    votes[Number(k)] = v.filter((s) => s !== voter);
  }
  for (const k of Object.keys(votes)) {
    if (votes[Number(k)].length === 0) delete votes[Number(k)];
  }
  if (optionIndex >= 0 && optionIndex < body.options.length) {
    votes[optionIndex] = [...(votes[optionIndex] ?? []), voter];
  }
  return { ...body, votes };
}

function quoteOf(messages: ChatMessage[], id: string) {
  const m = messages.find((x) => x.id === id);
  if (!m) return undefined;
  const snippet =
    m.body.kind === "text" ? m.body.text.slice(0, 80)
    : m.body.kind === "poll" ? `📊 ${m.body.question}`
    : m.body.kind === "image" ? "Photo"
    : m.body.kind === "file" ? `📎 ${m.body.name}`
    : "🎤 Voice message";
  return { id: m.id, snippet, sender: m.sender };
}

function applyReaction(
  _messages: ChatMessage[],
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>,
  messageId: string,
  emoji: string,
  sender: "self" | "peer",
  op: "add" | "remove" | "toggle",
): "add" | "remove" {
  let result: "add" | "remove" = "add";
  setMessages((prev) =>
    prev.map((m) => {
      if (m.id !== messageId) return m;
      const reactions = new Map(m.reactions);
      const who = new Set(reactions.get(emoji) ?? []);
      if (op === "toggle") {
        if (who.has(sender)) {
          who.delete(sender);
          result = "remove";
        } else {
          who.add(sender);
        }
      } else if (op === "add") {
        who.add(sender);
      } else {
        who.delete(sender);
      }
      if (who.size === 0) reactions.delete(emoji);
      else reactions.set(emoji, [...who]);
      return { ...m, reactions };
    }),
  );
  return result;
}

function fileToBase64(file: File | Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result);
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

const blobToBase64 = fileToBase64;
