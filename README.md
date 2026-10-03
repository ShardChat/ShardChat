<p align="center">
  <img src="logo.png" width="128" alt="SHARD logo" />
</p>

<h1 align="center">SHARD</h1>

<p align="center">Disposable end-to-end encrypted sessions.<br/>No storage. No accounts. No trace.</p>

---

## 1. Overview & Philosophy

SHARD is a one-shot encrypted messenger built around a single constraint: **nothing that can be seized, sold, or leaked should ever exist.**

A session is created with a link, shared with exactly one other person, and destroyed — by timer, by button, or the moment both participants leave. The relay that introduces the two peers is deliberately blind: it holds public keys and opaque ciphertext in RAM, and nothing else. There is no database, no persistence layer, no analytics, and no account system. If the process dies — voluntarily or otherwise — every session dies with it, permanently and irrecoverably.

The project treats server-side storage as the root of privacy failure and removes it entirely, rather than trying to secure it.

## 2. Architectural Invariants

- **Zero knowledge by construction.** All encryption happens in the browser via the native Web Crypto API. The relay only ever sees public keys and authenticated ciphertext; it cannot decrypt, filter, or moderate content.
- **In-memory Go runtime.** Rooms, peer registrations, and TTL timers live exclusively in process RAM. Nothing is written to disk, to a log, or to a database. Process restart equals total amnesia.
- **Strictly two participants.** A room accepts exactly two WebSocket peers. The third connection is rejected with `403 Room is full (2/2 peers)`.
- **Guaranteed destruction.** A room is destroyed through a single code path — TTL expiry, the manual burn button, or the last peer disconnecting. Sockets are closed, the map entry is deleted, timers are stopped. Deletion is immediate and unrecoverable.
- **Blind transport.** Application payloads (`CIPHER_MESSAGE`, file chunks, edits, reactions, polls) are sealed JSON envelopes. The server relays them without inspection.
- **Minimal operational metadata.** Logs contain room IDs and destruction reasons only — never payloads, never IP addresses.
- **No third-party signaling.** WebRTC negotiation (`CALL_OFFER` / `CALL_ANSWER` / `CALL_ICE`) rides the same two-seat blind relay as chat traffic. No public signaling cloud ever sees a peer ID, an SDP, or a local IP address.
- **Bounded resource use.** A single WS frame is capped at 10 MB (`SetReadLimit`), each connection buffers 4 KB per direction, and a global ceiling of 600 live sockets sheds load with `503` rather than an OOM kill. Outbound queues apply backpressure and drop a stalled consumer after 5 s.
- **No single packet can kill the process.** Every relay goroutine and every HTTP handler runs behind a `recover()`, so a malformed frame costs one socket, never the service.
- **Orderly shutdown.** `SIGINT` / `SIGTERM` (Render, Cloudflare) burn every room through the normal destruction path — clients receive `ROOM_BURNED` instead of a dropped socket — and in-flight HTTP drains inside a 10 s grace window.

## 3. Cryptographic Specification

All cryptography runs in the browser on the native Web Crypto API. No third-party crypto libraries.

| Primitive           | Construction                                                            | Notes                                                                     |
| ------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Key agreement       | ECDH, NIST P-256                                                        | Keypair generated in-browser; the private key never leaves the client     |
| Key derivation      | HKDF-SHA-256                                                            | Empty salt, domain-separated info `shard-aes-256-gcm`, 256-bit output |
| Session cipher      | AES-256-GCM                                                             | Fresh 12-byte CSPRNG IV per payload; key is non-extractable after import  |
| Integrity           | GCM authentication tag                                                  | Any tampered byte fails decryption                                        |
| Safety fingerprint  | SHA-256 over the raw ECDH shared secret                                 | 4 deterministic emojis from a 64-symbol pool; compared out of band        |
| Room identifiers    | `crypto/rand`, 10 characters, 58-symbol alphabet (no `l I O 0 1`)       | 58^10 keyspace, rejection sampling against modulo bias                    |
| Transport           | TLS (HTTPS / WSS)                                                       | Terminates at the relay; payload confidentiality is preserved end-to-end  |

The 4-emoji fingerprint is the out-of-band authentication channel: both peers see the same four emojis, derived from the shared secret. If they match when compared by voice or in person, no man-in-the-middle holds the real session key.

## 4. Protocol Sequence

Every WebSocket frame is a JSON envelope: `{"type": string, "payload": object}`.

```text
Client A                          Go Relay (RAM only)                         Client B
--------                          -------------------                         --------
POST /api/rooms                →  mint 10-char room id, arm TTL timer
   ◄─ {roomId, expiresAt}         (no disk, no database)
GET /ws/{roomId} ────────────►  register peer 1/2
   ◄─ WELCOME {expiresAt}
generate ECDH P-256 keypair
JOIN {pub: A.public} ────────►
                                                                  GET /ws/{roomId} ─────────►  register peer 2/2
                                                                  ◄─ WELCOME {expiresAt}
   ◄─ PEER_JOINED {peerCount: 2}
                                                                  JOIN {pub: B.public} ─────►
   ◄─ KEY_EXCHANGE {pub: B.public}
derive AES-256-GCM key ───────  (relay sees public keys only)  ────────  derive AES-256-GCM key
verify 4-emoji fingerprint ◄─── SHA-256(raw shared secret) ─────► verify 4-emoji fingerprint

CIPHER_MESSAGE {iv, ct} ─────►  ─────────────────────────────►  CIPHER_MESSAGE {iv, ct}   ◄─ decrypt
   · edits, deletes, pins, polls, reactions, typing, read receipts — same sealed envelope

FILE_CHUNK_START {meta} ─────►  ─────────────────────────────►  FILE_CHUNK_START {meta}
FILE_CHUNK_DATA × N ─────────►  64 KB slices, each sealed ───►  FILE_CHUNK_DATA × N
FILE_CHUNK_END ──────────────►  ─────────────────────────────►  FILE_CHUNK_END

CALL_INVITE {kind} ─────────►  ─────────────────────────────►  CALL_INVITE {kind}
CALL_OFFER {sdp} ───────────►  relayed opaquely ────────────►  set remote description
CALL_ICE × N ───────────────►  (candidates, blind) ────────►  addIceCandidate
                                                   CALL_ANSWER {sdp} ────►  set remote description
       ══ media: DTLS-SRTP direct peer-to-peer, never through the relay ══

BURN_ROOM ───────────────────►  destroy room, close sockets ─►  ROOM_BURNED
                                [TTL expiry / last peer left / SIGTERM → same path]
```

Room existence probes (`GET /api/rooms/{roomId}`) return only `{peerCount, expiresAt}` — enough for a client to distinguish "waiting for peer" from "room burned" without exposing anything else.

A third connection attempt is refused by the relay with `403` before the WebSocket upgrade. Since the browser's WebSocket API cannot read that HTTP status (it only reports an abnormal close), the client detects the rejection from the probe's `peerCount >= 2` and treats it as **terminal**: no reconnect timer, no further network traffic, and a "Session is Full" screen instead of the chat.

## 5. Feature Overview

| Area                | Capability                                                                                             |
| ------------------- | ------------------------------------------------------------------------------------------------------ |
| Messaging           | Markdown text with GitHub-flavored syntax and code blocks                                              |
|                     | Replies, edit, delete-for-both, one pinned message per room, emoji reactions, polls with retractable votes |
|                     | Typing indicators, read receipts, full-text search with match navigation                                |
| Media               | Voice notes recorded in-browser, rendered with a playback waveform                                       |
|                     | Capped at 10 minutes and ~48 kbps Opus, so one sealed envelope always fits the relay's frame limit     |
|                     | Images compressed client-side via canvas before encryption                                               |
|                     | View-once photos: burn after opening, on both peers, enforced by explicit open events                   |
| Files               | Up to 25 MB per file, streamed in 64 KB sealed chunks with per-chunk progress                           |
| Calls               | P2P audio/video on a native `RTCPeerConnection`; signaling over our own blind relay; screen sharing; camera switching; minimized floating call window |
| Session             | TTL of 30 minutes, 2 hours, or 24 hours; manual burn button; live countdown                             |
| Client              | Light and dark themes; no accounts, no phone numbers, no e-mail                                          |

## 6. File Security Pipeline

Attachments are gated client-side before a single byte is encrypted. The relay carries ciphertext and cannot inspect anything — which is precisely why the inspection happens at the source.

| Stage | Mechanism                                   | Rejects                                                              |
| ----- | ------------------------------------------- | -------------------------------------------------------------------- |
| 1     | Size and emptiness                          | Empty files; anything above the 25 MB cap                            |
| 2     | Extension blocklist (23 entries)            | Executables and scripts: `.exe`, `.bat`, `.cmd`, `.sh`, `.msi`, `.apk`, `.dll`, `.jar`, `.ps1`, and others |
| 3     | Magic-byte inspection of the first 4100 B   | Renamed binaries: PE (`MZ`), ELF, Mach-O (`cafe babe`, `feed face`), DEX |
| 4     | ZIP central-directory scan (JSZip)          | Executables packed inside archives — no entry is decompressed        |

The blocklist and signatures live in `frontend/src/lib/fileSecurity.ts` and are trivial to audit.

## 7. Technology Stack & Project Layout

| Layer            | Technology                                                          |
| ---------------- | ------------------------------------------------------------------- |
| Relay            | Go 1.26, `gorilla/websocket` (the only backend dependency)         |
| Client           | React 18, TypeScript 5.9, Vite 7, Tailwind CSS 4                   |
| Cryptography     | Native Web Crypto API (no third-party crypto code)                  |
| Calls            | Native `RTCPeerConnection`, signaling relayed in-session            |
|                  | (no third-party broker); TURN credentials brokered by Go           |
| Extras           | JSZip (archive inspection), react-markdown, qrcode.react            |
| Tests            | In-browser crypto self-test (`frontend/src/crypto/selftest.ts`)      |

```text
.
├── backend/
│   ├── cmd/server/main.go        # relay entrypoint: REST, WS, TURN, static hosting, signal handling
│   ├── internal/httpx/           # security headers, CORS origin checks, panic recovery
│   ├── internal/room/            # room manager: RAM store, TTL timers, burn path, connection budget
│   ├── internal/turn/            # Metered TURN broker + local-dev fallback
│   ├── internal/ws/              # WebSocket handler, packet protocol, 2-peer gate
├── frontend/
│   ├── .env.example              # documented VITE_* build-time overrides
│   ├── public/                   # favicon, logo, robots.txt
│   └── src/
│       ├── components/           # Navbar, CrystalLogo, ThemeToggle
│       ├── components/chat/      # Room, ChatHeader, MessageList, InputBar, CallStage, ...
│       ├── config/               # donation wallets
│       ├── crypto/               # ecdh.ts, cipher.ts, selftest.ts
│       ├── hooks/                # useWebSocket, useChatSession, useFileTransfer, useWebRTCCall, useVoiceRecord
│       ├── lib/                  # fileSecurity, media, audioBus, theme, endpoints
│       ├── pages/                # Landing, SessionSetup (/new), Donate (/donate), Security, Terms
│       └── types/                # WS packet contract (protocol.ts)
├── LICENSE                        # AGPL-3.0
├── Dockerfile                     # single-image build, runs as UID 10001
├── docker-compose.yml
├── render.yaml                    # Render service definition (relay)
└── vercel.json                    # Vercel static hosting + SPA rewrites (client)
```

## 8. Configuration & Environment Variables

All configuration is environment-based. Defaults are tuned for local development.

| Variable                   | Default                 | Purpose                                                        |
| -------------------------- | ----------------------- | -------------------------------------------------------------- |
| `PORT`                     | unset                   | **PaaS-injected** listen port (Render and friends); takes precedence over `SHARD_ADDR` |
| `SHARD_ADDR`              | `:8080`                 | Relay listen address, used when `PORT` is absent               |
| `ALLOWED_ORIGINS`          | unset                   | **Strict** comma-separated allowlist of browser origins (CORS + WebSocket Origin). Unset → dev mode: loopback origins only, with a startup warning |
| `SHARD_STATIC`            | `../frontend/dist`      | SPA assets served by the relay in single-service deployments   |
| `SHARD_STUN_URL`         | `stun:stun.cloudflare.com:3478` | STUN endpoint used in the no-TURN fallback (comma-separated URLs allowed) |
| `METERED_DOMAIN`           | unset                   | Metered.ca TURN API host; unset → **STUN-only** ICE fallback (no third-party TURN) |
| `METERED_API_KEY`          | unset                   | Metered API key; stays server-side, never sent to clients      |

Frontend build-time overrides (see `frontend/.env.example`):

| Variable          | Default      | Purpose                                                                       |
| ----------------- | ------------ | ----------------------------------------------------------------------------- |
| `VITE_API_BASE`   | unset        | Relay origin for REST. Unset → same-origin relative requests (single-service default) |
| `VITE_WS_URL`     | unset        | Relay origin for the WebSocket. Unset → derived from `location` (`wss:` on https). Scheme is validated at load |
| `VITE_STUN_URL`   | `stun:stun.cloudflare.com:3478` | Browser-side STUN fallback when the relay serves no TURN credentials |

`VITE_API_BASE` / `VITE_WS_URL` are needed **only** when the static bundle and the relay are served from different hosts (see the split topology below). Whichever frontend origin you deploy to must also appear in the relay's `ALLOWED_ORIGINS`, otherwise the CORS middleware refuses `POST /api/rooms` and the WebSocket origin check answers 403.

TURN credentials are issued as short-lived (24 h) ICE configurations from `GET /api/turn-credentials`. Without Metered configuration the relay hands out a neutral STUN endpoint only — no open TURN relays, no Google infrastructure (privacy: calls stay peer-to-peer whenever the network allows).

## 9. Local Development & Docker Deployment

Local development:

```bash
# terminal 1 — relay on :8080
cd backend
go run ./cmd/server

# terminal 2 — client on :5173 (proxies /api and /ws to :8080)
cd frontend
npm install
npm run dev
```

Production build served by the relay (single process, single origin):

```bash
cd frontend && npm run build   # emits frontend/dist
cd ../backend
go run ./cmd/server            # serves dist + API on :8080
```

Static checks:

```bash
cd backend
go vet ./...
gofmt -l .        # expect no output
cd ../frontend
npx tsc -b
```

Docker (multi-stage build: frontend bundle compiled, Go binary built, one minimal runtime image serving both, running as UID 10001):

```bash
docker compose up --build -d   # shard on http://localhost:8080
docker compose logs -f
docker compose down
```

### Split deployment (Vercel + Render + Cloudflare)

The client is same-origin by default, so a split topology needs two things: a Vercel build pointed at the relay, and a route for `/api` + `/ws`.

| Piece            | Configuration                                                        |
| ---------------- | -------------------------------------------------------------------- |
| Client (Vercel)  | `vercel.json` builds `frontend/` and rewrites unknown paths to `index.html` so `/room/:id` survives a hard refresh. Set `VITE_API_BASE` and `VITE_WS_URL` to the relay origin |
| Relay (Render)   | `render.yaml` builds the single-image Dockerfile, exposes `/healthz`, and expects `ALLOWED_ORIGINS` to contain the Vercel domain |
| Edge (Cloudflare)| Route `/api/*` and `/ws/*` to the Render service; everything else stays on Vercel |

A room lives in one process's RAM, so the relay must run as a **single instance** — never behind autoscaling, and never with sticky-session assumptions.

In-browser cryptographic self-test (key agreement, deterministic fingerprints, GCM round-trips):

```js
import("/src/crypto/selftest.ts").then((m) => m.runCryptoSelfTest());
```

## 10. Threat Model & Limitations

**SHARD is designed to protect against:**

- A curious or coerced relay operator. The server relays opaque ciphertext and holds no decryption material.
- Server compromise or seizure. There is no database, no disk persistence, and no backup; a seized machine yields room IDs and nothing else.
- Passive network eavesdropping. TLS protects the transport; payload confidentiality does not depend on it.
- Retention by accident. Rooms exist only in RAM and die by timer, by button, or when both peers leave.

**SHARD does not protect against:**

- A compromised endpoint. Malware, keyloggers, or an open DevTools on either machine defeat any messenger.
- The peer. The person you talk to can screenshot, record, or copy anything you send. Cryptography cannot prevent disclosure by a trusted party.
- Traffic analysis. The relay sees connection timing, message frequency, and ciphertext volumes.
- Room link leakage. The link is the only credential. Until both seats are filled, anyone holding it can take one.
- Man-in-the-middle on first contact. The relay could swap public keys. The 4-emoji fingerprint exists precisely for this: verify it through a second channel before discussing anything sensitive.
- Metadata correlation. The relay necessarily knows that two anonymous connections met and how much data they exchanged.
- Post-quantum adversaries. ECDH P-256 is not quantum-resistant.
- WebRTC IP exposure. Peer-to-peer media inherently reveals IP addresses to the peer and to the TURN service.
- Infrastructure logs outside SHARD. The relay writes no IP addresses, but a hosting provider, CDN, or reverse proxy in front of it records connection metadata under its own policy. Read the deployment chain's terms if that boundary matters to you.

There is no message recovery. Deleted means deleted; expired means gone. This is a property, not a defect.

## 11. Independent Verification Guide

No trust in this document is required — every claim below is checkable in under five minutes with two browser profiles.

1. Create a session at `/new` and open the link in a second browser profile.
2. Open DevTools (`F12`) → **Network** → filter **WS** → select the WebSocket connection → **Messages**.
3. Send a message. Every application frame is a sealed envelope:

   ```json
   { "type": "CIPHER_MESSAGE", "payload": { "id": "...", "iv": "base64", "ciphertext": "base64", "timestamp": 0 } }
   ```

4. Search all frames (`Ctrl+F`) for any word you just sent. The plaintext does not appear — not once. Repeat with file transfers: `FILE_CHUNK_DATA` frames are the same sealed format.
5. The only plaintext on the wire is by design: base64 public keys (`JOIN`, `KEY_EXCHANGE`), room IDs, and timestamps.
6. Check the relay console: logs contain `[room] destroyed id=... reason=...` lines only. `GET /healthz` answers `{"status":"ok","liveRooms":N,"liveConns":M,"maxConns":600}` — no content, no identifiers beyond counters.
7. Restart the relay process mid-session. The room is gone — RAM-only storage means there is nothing to recover.
8. Open the same link in a third browser profile. You get a "Session is Full" screen, and the Network tab shows no further `/api` or `/ws` requests: the rejection is terminal, not a retry loop.
9. Optional: run the in-browser cryptographic self-test from the console (see section 9). It validates ECDH agreement, fingerprint determinism, and AES-GCM round-trips against the browser's own Web Crypto implementation.

## 12. Donations

SHARD takes no investment and shows no advertising. Donations cover relay hosting, TURN bandwidth, and domain costs.

The crypto terminal at `/donate` accepts:

| Asset          | Network              | Address                                    |
| -------------- | -------------------- | ------------------------------------------ |
| USDT           | TRON (TRC-20)        | `TLvXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX`     |
| Litecoin (LTC) | Litecoin Native      | `ltc1qXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX` |
| Bitcoin (BTC)  | Bitcoin Mainnet      | `bc1qXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX` |
| TRX            | TRON (TRC-20)        | `TXkXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX`     |

Addresses above are placeholders — the live values are served at `/donate` and maintained in `frontend/src/config/donate.ts`. Send only the stated asset on the stated network.

Non-financial support — a GitHub star, or sharing SHARD with someone who needs it — helps just as much.

## 13. License

SHARD is free software: licensed under the **GNU Affero General Public License v3.0 (AGPL-3.0-only)**.

You are free to use, study, modify, and self-host the code. Any modified version offered as a network service must publish its corresponding source under the same license. See the GNU AGPL-3.0 text for the complete terms.
