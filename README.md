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

- **Zero knowledge by construction.** All encryption happens in the browser — the native Web Crypto API for the classical leg and every symmetric operation, the audited pure-JS `@noble/post-quantum` for the ML-KEM-768 leg (WebCrypto ships no post-quantum primitives). The relay only ever sees public keys and authenticated ciphertext; it cannot decrypt, filter, or moderate content.
- **In-memory Go runtime.** Rooms, peer registrations, and TTL timers live exclusively in process RAM. Nothing is written to disk, to a log, or to a database. Process restart equals total amnesia.
- **Strictly two participants.** A room accepts exactly two WebSocket peers. The third connection is rejected with `403 Room is full (2/2 peers)`.
- **Guaranteed destruction.** A room is destroyed through a single code path — TTL expiry, the manual burn button, or the last peer disconnecting. Sockets are closed, the map entry is deleted, timers are stopped. Deletion is immediate and unrecoverable. (A single peer dropping is not treated as a departure: the room holds its seat open for `SHARD_PEER_GRACE_SECONDS` so a backgrounded phone can come back — see *Peer departure and the reconnect window*.)
- **Blind transport.** Application payloads (`CIPHER_MESSAGE`, file chunks, edits, reactions, polls) are sealed JSON envelopes. The server relays them without inspection.
- **Minimal operational metadata.** Logs contain room IDs and destruction reasons only — never payloads, never IP addresses.
- **No third-party signaling.** WebRTC negotiation (`CALL_OFFER` / `CALL_ANSWER` / `CALL_ICE`) rides the same two-seat blind relay as chat traffic. No public signaling cloud ever sees a peer ID, an SDP, or a local IP address.
- **Bounded resource use.** A single WS frame is capped at 10 MB (`SetReadLimit`), each connection buffers 4 KB per direction, and a global ceiling of 600 live sockets sheds load with `503` rather than an OOM kill. Outbound queues apply backpressure and drop a stalled consumer after 5 s.
- **No single packet can kill the process.** Every relay goroutine and every HTTP handler runs behind a `recover()`, so a malformed frame costs one socket, never the service.
- **Orderly shutdown.** `SIGINT` / `SIGTERM` (Render and other PaaS platforms) burn every room through the normal destruction path — clients receive `ROOM_BURNED` instead of a dropped socket — and in-flight HTTP drains inside a 10 s grace window.

## 3. Cryptographic Specification

**Hybrid Post-Quantum E2EE (NIST ML-KEM-768 / Kyber + ECDH P-256 + AES-GCM-256).**
All cryptography runs in the browser: the native Web Crypto API powers the classical leg and every symmetric operation, while the audited pure-JS `@noble/post-quantum` implements ML-KEM-768 — WebCrypto ships no post-quantum primitives.

| Primitive           | Construction                                                            | Notes                                                                     |
| ------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Classical leg       | ECDH, NIST P-256                                                        | Keypair generated in-browser; the private key never leaves the client     |
| Post-quantum leg    | ML-KEM-768 (Kyber, FIPS 203) via `@noble/post-quantum`                  | 1184-B encapsulation key, 1088-B ciphertext; exactly one encapsulation per session — the peer with the lexicographically smaller base64 ECDH public key encapsulates, so no role negotiation is needed |
| Key agreement       | Hybrid combiner: 32 B ECDH secret ‖ 32 B ML-KEM secret                  | A future quantum attacker must break BOTH legs; either alone is useless   |
| Key derivation      | HKDF-SHA-256 over the 64-byte hybrid secret                             | Empty salt, domain-separated info `shard-hybrid-pq-aes-256-gcm`, 256-bit output |
| Session cipher      | AES-256-GCM                                                             | Fresh 12-byte CSPRNG IV per payload; key is non-extractable after import  |
| Integrity           | GCM authentication tag                                                  | Any tampered byte fails decryption                                        |
| Key confirmation    | AES-GCM proof sealed under the session key                              | Both peers verify the peer's proof before "secure"; a tampered KEM ciphertext (implicit-rejection secret) aborts the session |
| Safety fingerprint  | SHA-256 over the combined hybrid secret (ECDH ‖ ML-KEM)                 | 4 deterministic emojis from a 64-symbol pool; compared out of band        |
| Room identifiers    | `crypto/rand`, 10 characters, 58-symbol alphabet (no `l I O 0 1`)       | 58^10 keyspace, rejection sampling against modulo bias                    |
| Transport           | TLS (HTTPS / WSS)                                                       | Terminates at the relay; payload confidentiality is preserved end-to-end  |

The 4-emoji fingerprint is the out-of-band authentication channel: both peers see the same four emojis, derived from the shared secret. If they match when compared by voice or in person, no man-in-the-middle holds the real session key.

The handshake is additionally fail-closed by construction: `pqPub` is structurally mandatory (the hybrid combiner is the only key-agreement path — a `KEY_EXCHANGE` without a valid ML-KEM key aborts the session instead of falling back to classic ECDH), both peers must verify each other's GCM key-confirmation proof before the session may enter the secure phase, and a packet presenting our own public key back to us (mirror/reflection or a relay replaying our stale cached envelope on reconnect) is ignored outright.

## 4. Protocol Sequence

Every WebSocket frame is a JSON envelope: `{"type": string, "payload": object}`.

```text
Client A                          Go Relay (RAM only)                         Client B
--------                          -------------------                         --------
POST /api/rooms                →  mint 10-char room id, arm TTL timer
   ◄─ {roomId, expiresAt}         (no disk, no database)
GET /ws/{roomId} ────────────►  register peer 1/2
   ◄─ WELCOME {expiresAt}
generate ECDH P-256 + ML-KEM-768 keypairs
JOIN {pub: A.public} ────────►
                                                                  GET /ws/{roomId} ─────────►  register peer 2/2
                                                                  ◄─ WELCOME {expiresAt}
   ◄─ PEER_JOINED {peerCount: 2}
                                                                  JOIN {pub: B.public} ─────►
   ◄─ KEY_EXCHANGE {pub: B.public, pqPub: B.kyber, pqCT: encaps(B→A), confirm}
KEY_EXCHANGE {pub: A.public, pqPub: A.kyber, confirm} ──────────────────────►
derive AES-256-GCM key ───────  (relay sees public keys only)  ────────  derive AES-256-GCM key
        │ HKDF(ECDH ‖ ML-KEM-768 secret)                                │ HKDF(ECDH ‖ ML-KEM-768 secret)
verify 4-emoji fingerprint ◄─── SHA-256(combined hybrid secret) ─────► verify 4-emoji fingerprint

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
                                [TTL expiry / peer gone for good / SIGTERM → same path]
```

### Peer departure and the reconnect window

A dropped socket is not a departure. A phone that opens the photo picker,
switches app or loses a bar of signal suspends its WebSocket and the OS never
sends a close frame — the relay only learns about it when the TCP stack gives
up. Burning the session on that signal ejected both participants from a live
call, so a two-peer room now survives a departure for `SHARD_PEER_GRACE_SECONDS`
(45 s by default, `0` restores instant destruction):

1. The survivor is told `PEER_LEFT` immediately and its composer locks.
2. The free seat is **reserved** for the participant that left, identified by an
   opaque per-tab token on the upgrade request (`?seat=`). A returning client
   reclaims its own seat; anyone else is still refused with 403.
3. If the same participant does not come back before the window closes, the
   room burns through the normal path.

The token identifies a browser tab, not a person: it carries no identity, is
never parsed by the relay, never logged and never relayed.

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
| Installable         | Web app manifest: installs as a standalone app on Android, iOS and desktop, with a `New session` shortcut |

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
| Cryptography     | Native Web Crypto API + `@noble/post-quantum` (ML-KEM-768; the only third-party crypto) |
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
│   ├── public/                   # favicon, logo, manifest.webmanifest, icon-*.png, robots.txt
│   ├── scripts/                  # csp-hash.mjs, make-icons.mjs (maintenance tools)
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
└── render.yaml                    # Render web service definition (relay)
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

### Deployment on Render

A room lives in one process's RAM, so the relay must run as a **single instance** — never behind autoscaling, and never with sticky-session assumptions. There are two ways to put this on Render.

**Option A — static site + relay (two services, two origins).** Render **Static Site** for the client plus a **Web Service** for the relay. Two origins, so the browser build must be told where the relay lives.

| Piece       | Configuration                                                                   |
| ----------- | -------------------------------------------------------------------------------- |
| Static Site | Root directory `frontend`, build `npm install && npm run build`, publish `dist`  |
| Static Site | Rewrite rule `/*  /index.html  200` — without it a hard refresh on `/room/:id` 404s |
| Static Site | `VITE_API_BASE` = `https://<relay>.onrender.com`, `VITE_WS_URL` = `wss://<relay>.onrender.com` |
| Web Service | Runtime **Go**, root directory **`backend`**                                      |
| Web Service | Build `go build -tags netgo -ldflags '-s -w' -o app ./cmd/server`, start `./app` |
| Web Service | Health check path `/healthz`, `ALLOWED_ORIGINS` = the static site's origin        |

The package must be named in the build command: the `backend/` module root holds no `.go` file itself, so a bare `go build` there fails with `no Go files in .../backend`.

Root directory `backend` also scopes auto-deploy to `backend/` — frontend-only commits will not redeploy the relay, which is what you want when the client is its own service.

**Option B — one web service serving everything.** Switch the runtime to **Docker** and Render builds the repository `Dockerfile`, which compiles the SPA and serves it from the same process. Client, `/api` and `/ws` share one origin: no CORS, no `VITE_*` build variables, no rewrite rule.

| Setting           | Value                                                |
| ----------------- | ---------------------------------------------------- |
| Runtime           | Docker (uses the repository `Dockerfile`)            |
| Health check path | `/healthz`                                          |
| Environment       | `ALLOWED_ORIGINS` = your own domain                 |

`ALLOWED_ORIGINS` is a strict allow-list and gates both the CORS preflight for `POST /api/rooms` and the WebSocket `Origin` check. Leave it unset and the relay stays in dev mode: loopback origins only, with a startup warning.

### Installable app (PWA)

`frontend/public/manifest.webmanifest` makes SHARD installable from the browser on Android, iOS and desktop: standalone display, no address bar, its own launcher icon and splash colour. Chrome offers *Install app* once the page has been visited and shows engagement; iOS uses **Share → Add to Home Screen**.

| Piece                             | Role                                                                                                                             |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `manifest.webmanifest`            | `id`/`start_url`/`scope` at `/`, `display: standalone`, theme `#09090b`, the icon set, and a `New session` shortcut to `/new`    |
| `icon-192.png`, `icon-512.png`    | `purpose: "any"` — the logo as drawn, straight from the master `logo.png`                                                        |
| `maskable-192.png`, `-512.png`    | `purpose: "maskable"` — full-bleed so the OS can crop it; mark inset to 75% of the canvas                                       |
| `apple-touch-icon.png`            | iOS ignores the manifest for home-screen installs; it takes this 180×180 PNG and rounds it itself                               |

Every icon is derived from `logo.png` by `frontend/scripts/make-icons.mjs` rather than hand-exported, so the brand mark has exactly one source. `--inspect` reports the mark's bounding box. Regenerate with `node scripts/make-icons.mjs` after replacing the logo. The output is committed, not built: installability must not depend on a code generator running.

Two details are load-bearing rather than cosmetic:

- **The manifest must be served as `application/manifest+json`.** Go's MIME table has no `.webmanifest` entry, so `http.ServeFile` sniffs the bytes and answers `text/plain` — and since `SecurityHeaders` sends `X-Content-Type-Options: nosniff`, the browser refuses to parse it and the install prompt silently disappears behind a `200`. `cmd/server/main.go` pins the type with `mime.AddExtensionType`. If you host the bundle anywhere else (Option A's static site, nginx, a CDN), **check that host returns `application/manifest+json` for `/manifest.webmanifest`**, or name the file `manifest.json`, which every host already maps to `application/json`.
- **There is deliberately no service worker.** Chrome's install criteria no longer require one, so the manifest alone buys the install. A caching worker would sit badly with this project's guarantees: it can pin a stale app shell indefinitely, and any future runtime caching rule touching `/api` or `/ws` would persist sealed session traffic — exactly what the zero-retention design forbids. Offline support, if it is ever wanted, should be an explicit, reviewed decision rather than a default.

In-browser cryptographic self-test (hybrid ECDH + ML-KEM-768 agreement, deterministic fingerprints, GCM round-trips):

```js
import("/src/crypto/selftest.ts").then((m) => m.runCryptoSelfTest());
```

## 10. Threat Model & Limitations

**SHARD is designed to protect against:**

- A curious or coerced relay operator. The server relays opaque ciphertext and holds no decryption material.
- Server compromise or seizure. There is no database, no disk persistence, and no backup; a seized machine yields room IDs and nothing else.
- Passive network eavesdropping. TLS protects the transport; payload confidentiality does not depend on it.
- Harvest-now-decrypt-later quantum attacks. The hybrid ML-KEM-768 (Kyber) leg keeps recorded ciphertext sealed even against a future cryptographically relevant quantum computer: breaking the session key requires defeating BOTH ML-KEM-768 and ECDH P-256.
- Retention by accident. Rooms exist only in RAM and die by timer, by button, or when both peers leave.

**SHARD does not protect against:**

- A compromised endpoint. Malware, keyloggers, or an open DevTools on either machine defeat any messenger.
- The peer. The person you talk to can screenshot, record, or copy anything you send. Cryptography cannot prevent disclosure by a trusted party.
- Traffic analysis. The relay sees connection timing, message frequency, and ciphertext volumes.
- Room link leakage. The link is the only credential. Until both seats are filled, anyone holding it can take one.
- Man-in-the-middle on first contact. The relay could swap public keys. The 4-emoji fingerprint exists precisely for this: verify it through a second channel before discussing anything sensitive.
- Metadata correlation. The relay necessarily knows that two anonymous connections met and how much data they exchanged.
- Quantum authentication is not identity. The hybrid KEM makes the channel confidential against quantum adversaries, but confirming WHO holds the other end still rests on the manual 4-emoji fingerprint comparison.
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
5. The only plaintext on the wire is by design: base64 public keys (`JOIN`, `KEY_EXCHANGE` — the latter now also carries the ~1.6 KB ML-KEM-768 encapsulation key and the ~1.5 KB encapsulation ciphertext), room IDs, and timestamps.
6. Check the relay console: logs contain `[room] destroyed id=... reason=...` lines only. `GET /healthz` answers `{"status":"ok","liveRooms":N,"liveConns":M,"maxConns":600}` — no content, no identifiers beyond counters.
7. Restart the relay process mid-session. The room is gone — RAM-only storage means there is nothing to recover.
8. Open the same link in a third browser profile. You get a "Session is Full" screen, and the Network tab shows no further `/api` or `/ws` requests: the rejection is terminal, not a retry loop.
9. Optional: run the in-browser cryptographic self-test from the console (see section 9). It validates the hybrid ECDH + ML-KEM-768 agreement (both peers derive the same key, proven with a real GCM tag), fingerprint determinism, and AES-GCM round-trips against the browser's own Web Crypto implementation.

## 13. License

SHARD is free software: licensed under the **GNU Affero General Public License v3.0 (AGPL-3.0-only)**.

You are free to use, study, modify, and self-host the code. Any modified version offered as a network service must publish its corresponding source under the same license. See the GNU AGPL-3.0 text for the complete terms.
