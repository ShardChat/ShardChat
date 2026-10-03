// SHARD — /security: Security Architecture & Threat Model. A strict,
// actual document — every claim mirrors what the code actually does
// (frontend/src/crypto/*, lib/fileSecurity.ts, backend/internal/*).
import DocShell, { DocSection } from "../components/DocShell";

export default function Security() {
  return (
    <DocShell
      eyebrow="Security & Cryptography"
      title="Security Architecture & Threat Model"
      subtitle="How SHARD encrypts, relays and destroys data — described exactly as implemented, without marketing abstractions."
    >
      {/* ---- 1. Cryptographic core ---- */}
      <DocSection title="1 · Cryptographic Core">
        <p>
          All cryptography runs in your browser through the standard{" "}
          <strong className="font-medium text-heading">Web Crypto API</strong>. No custom
          primitives, no home-made math — only audited building blocks shipped with the browser.
        </p>
        <p>
          Each peer generates a fresh <strong className="font-medium text-heading">ECDH P-256</strong>{" "}
          keypair. The public keys are exchanged over the relay; the raw shared secret never
          leaves either device. The session key is then derived with{" "}
          <strong className="font-medium text-heading">HKDF-SHA-256</strong> using domain
          separation (<code className="well rounded px-1.5 py-0.5 font-mono text-[13px]">info&nbsp;=&nbsp;&quot;shard-aes-256-gcm&quot;</code>),
          producing a <strong className="font-medium text-heading">non-extractable AES-256-GCM</strong>{" "}
          key — it can encrypt and decrypt, but even page JavaScript cannot read its bytes.
        </p>
        <p>
          Every payload — text, metadata, file chunks, call signaling — is sealed with{" "}
          <strong className="font-medium text-heading">AES-256-GCM</strong> under a fresh random
          12-byte IV. The relay only ever sees opaque ciphertext envelopes.
        </p>
        <p>
          The <strong className="font-medium text-heading">4-emoji safety fingerprint</strong> is
          the SHA-256 hash of the raw ECDH shared secret mapped into a pool of 64 distinct
          emojis. Both peers see the same four — compare them by voice or in person. A match
          proves no man-in-the-middle holds the real session key; a mismatch means the channel
          is compromised and the session must be abandoned.
        </p>
        <p className="text-sm text-tertiary">
          Determinism and round-trip behavior are verified at load time by a built-in self-test
          (frontend/src/crypto/selftest.ts): two simulated peers must derive the identical key
          and fingerprint before the interface is used.
        </p>
      </DocSection>

      {/* ---- 2. In-memory blind relay ---- */}
      <DocSection title="2 · In-Memory Blind Relay">
        <p>
          The Go relay is deliberately blind. It holds{" "}
          <strong className="font-medium text-heading">no databases</strong>, performs{" "}
          <strong className="font-medium text-heading">no disk writes</strong> and keeps{" "}
          <strong className="font-medium text-heading">no request or message logs</strong>.
          A room exists purely as a routing structure in RAM, addressed by a random 10-character
          identifier drawn from a 58-symbol alphabet.
        </p>
        <p>
          Rooms are capped at exactly two peers. A new room self-destructs if nobody joins
          within ten seconds; live rooms burn as soon as{" "}
          <strong className="font-medium text-heading">either participant disconnects</strong>{" "}
          — closes the tab or presses burn — or when their time-to-live (30, 120 or 1440
          minutes) expires. Destruction is a memory free — there is no persistence layer to
          purge, because none exists.
        </p>
        <p>
          The relay forwards sealed envelopes without the ability to open them: it never
          receives key material, plaintext, or file bytes it could interpret. Capturing the
          server in its entirety yields nothing but ephemeral ciphertext in volatile memory.
        </p>
      </DocSection>

      {/* ---- 3. File security & chunks ---- */}
      <DocSection title="3 · File Security & Chunks">
        <p>
          Attachments are streamed as independent{" "}
          <strong className="font-medium text-heading">64 KB chunks</strong>, each sealed with
          AES-256-GCM and its own random IV, up to a{" "}
          <strong className="font-medium text-heading">25 MB</strong> per-file limit. The relay
          routes chunk envelopes; reassembly and decryption happen only on the receiving device.
        </p>
        <p>
          A client-side gate (frontend/src/lib/fileSecurity.ts) screens every attachment before
          it is sent: 23 executable and script extensions are rejected (even renamed), native
          binaries are caught by{" "}
          <strong className="font-medium text-heading">magic bytes</strong> — PE/DLL, ELF,
          Mach-O, DEX — and ZIP archives are unpacked in memory to inspect the central
          directory for smuggled programs. Executables and scripts cannot travel through the
          chat in any wrapper.
        </p>
      </DocSection>

      {/* ---- 4. P2P WebRTC calling ---- */}
      <DocSection title="4 · P2P WebRTC Calling">
        <p>
          Voice and video calls run over{" "}
          <strong className="font-medium text-heading">WebRTC</strong> with DTLS-SRTP media
          encryption negotiated directly between the two browsers. Media flows peer-to-peer,
          bypassing the relay entirely — the server cannot carry call audio or video it never
          touches.
        </p>
        <p>
          The relay's only role in a call is handshake signaling: session descriptions and
          connectivity candidates, which are themselves inside the encrypted envelope stream.
          No call metadata is recorded; when the room burns, nothing about the call outlives
          the participants' tabs.
        </p>
      </DocSection>

      {/* ---- 5. Honest threat model ---- */}
      <DocSection title="5 · Honest Threat Model">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="card rounded-2xl p-5">
            <h3 className="text-sm font-semibold text-heading">What SHARD protects against</h3>
            <ul className="mt-3 space-y-2 text-sm">
              <li className="flex gap-2">
                <span aria-hidden className="mt-2 h-1 w-1 shrink-0 rounded-full bg-line-strong" />
                Network interception — TLS plus end-to-end encryption; an active MITM is
                exposed by a fingerprint mismatch.
              </li>
              <li className="flex gap-2">
                <span aria-hidden className="mt-2 h-1 w-1 shrink-0 rounded-full bg-line-strong" />
                Server seizure — RAM-only state, no disk artifacts, nothing to hand over.
              </li>
              <li className="flex gap-2">
                <span aria-hidden className="mt-2 h-1 w-1 shrink-0 rounded-full bg-line-strong" />
                Database leaks — there are no databases to breach.
              </li>
              <li className="flex gap-2">
                <span aria-hidden className="mt-2 h-1 w-1 shrink-0 rounded-full bg-line-strong" />
                Server-side profiling — the relay cannot read what it routes.
              </li>
            </ul>
          </div>
          <div className="card rounded-2xl p-5">
            <h3 className="text-sm font-semibold text-heading">Outside SHARD's control</h3>
            <ul className="mt-3 space-y-2 text-sm">
              <li className="flex gap-2">
                <span aria-hidden className="mt-2 h-1 w-1 shrink-0 rounded-full bg-line-strong" />
                Malware, keyloggers or a compromised browser on your device.
              </li>
              <li className="flex gap-2">
                <span aria-hidden className="mt-2 h-1 w-1 shrink-0 rounded-full bg-line-strong" />
                The other participant — screenshots, recordings, or deliberately sharing the
                session link.
              </li>
              <li className="flex gap-2">
                <span aria-hidden className="mt-2 h-1 w-1 shrink-0 rounded-full bg-line-strong" />
                Skipped fingerprint verification — the defense works only if you compare it.
              </li>
              <li className="flex gap-2">
                <span aria-hidden className="mt-2 h-1 w-1 shrink-0 rounded-full bg-line-strong" />
                Availability — sessions depend on the relay being online.
              </li>
            </ul>
          </div>
        </div>
        <p>
          Cryptography protects data in transit and at rest on the relay. It cannot protect a
          device that is already owned, or a counterpart who chooses to expose the conversation.
        </p>
      </DocSection>

      {/* ---- 6. Independent audit ---- */}
      <DocSection title="6 · Verify It Yourself">
        <p>
          SHARD's source is public under AGPL-3.0 — the full stack can be audited line by line.
          You can also verify the wire behavior live in under a minute:
        </p>
        <ol className="list-decimal space-y-2 pl-5 text-sm marker:text-tertiary">
          <li>
            Open a session, press <strong className="font-medium text-heading">F12</strong> →{" "}
            <em>Network</em> → filter <code className="well rounded px-1.5 py-0.5 font-mono text-[13px]">WS</code>.
          </li>
          <li>
            Select the socket and open <em>Frames</em>: every payload is a binary blob — sealed
            ciphertext, no readable text, ever.
          </li>
          <li>
            Under <em>Application</em> → <em>Storage</em> confirm nothing was written: no
            cookies, no localStorage, no IndexedDB entries for this site.
          </li>
        </ol>
        <p className="text-sm text-tertiary">
          Close both tabs and repeat — the previous room no longer exists anywhere.
        </p>
      </DocSection>
    </DocShell>
  );
}
