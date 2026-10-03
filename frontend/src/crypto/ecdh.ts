// SHARD — zero-knowledge key agreement built exclusively on the native
// Web Crypto API. ECDH P-256 for the handshake, HKDF-SHA-256 for key
// derivation, SHA-256 for the 4-emoji safety fingerprint. The private key
// ever leaves the browser; the server only ever relays public keys.

const ECDH_PARAMS: EcKeyGenParams = { name: "ECDH", namedCurve: "P-256" };
const HKDF_INFO = "shard-aes-256-gcm"; // domain separation for HKDF

/** 64 visually distinct, friendly emojis — 4 picked per fingerprint. */
const FINGERPRINT_EMOJIS = [
  "😀", "😎", "🥳", "🤖", "👻", "🦊", "🐸", "🐼",
  "🦁", "🐯", "🐨", "🦉", "🦋", "🐢", "🐙", "🦖",
  "🌵", "🍀", "🌻", "🌈", "⚡", "🔥", "💧", "🌟",
  "🍎", "🍕", "🍩", "🍿", "🎸", "🎮", "🚀", "🛸",
  "🎁", "🎈", "🎨", "🎯", "🎲", "🧩", "💡", "🔔",
  "💜", "❤️", "💙", "💚", "🧡", "💛", "🖤", "🤍",
  "👑", "💎", "🔮", "🧿", "🌙", "☀️", "☄️", "❄️",
  "🌊", "🏔️", "🌋", "🪐", "🌌", "🎇", "✨", "🍃",
];

/** Generates an extractable ECDH P-256 keypair for the handshake. */
export async function generateECDHKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(ECDH_PARAMS, true, ["deriveKey", "deriveBits"]);
}

/** Exports a public key to base64 raw form (65-byte uncompressed point). */
export async function exportPublicKey(key: CryptoKey): Promise<string> {
  const raw = await crypto.subtle.exportKey("raw", key);
  const bytes = new Uint8Array(raw);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

/** Imports a peer's base64 raw public key. Untrusted input: ECDH public only. */
export async function importPublicKey(base64: string): Promise<CryptoKey> {
  const binary = atob(base64);
  const raw = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) raw[i] = binary.charCodeAt(i);
  return crypto.subtle.importKey("raw", raw, ECDH_PARAMS, true, []);
}

/**
 * Derives the shared AES-GCM-256 session key: ECDH → HKDF-SHA-256.
 * Both peers run this with (own private, peer public) and land on the
 * identical key material — the server sees none of it.
 *
 * Implemented as an explicit deriveBits chain instead of a single
 * subtle.deriveKey call: some engines restrict ECDH public-key usages,
 * and this two-step path is supported uniformly across all browsers.
 */
export async function deriveSharedKey(
  privateKey: CryptoKey,
  peerPublicKey: CryptoKey,
): Promise<CryptoKey> {
  // 1. Raw ECDH shared secret (X-coordinate of the P-256 result point).
  const sharedBits = await crypto.subtle.deriveBits(
    { name: "ECDH", public: peerPublicKey },
    privateKey,
    256,
  );
  // 2. HKDF-Extract+Expand over the secret with domain-separated info.
  const hkdfBase = await crypto.subtle.importKey("raw", sharedBits, "HKDF", false, ["deriveBits"]);
  const okm = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: new TextEncoder().encode(HKDF_INFO) },
    hkdfBase,
    256,
  );
  // 3. Materialize the non-extractable AES-GCM-256 session key.
  return crypto.subtle.importKey("raw", okm, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/**
 * 4 deterministic emojis verifying both sides share the same secret.
 * SHA-256(raw ECDH shared secret) → 2 bytes per emoji → index in the pool.
 */
export async function generateEmojiFingerprint(
  privateKey: CryptoKey,
  peerPublicKey: CryptoKey,
): Promise<[string, string, string, string]> {
  const bits = await crypto.subtle.deriveBits(
    { name: "ECDH", public: peerPublicKey },
    privateKey,
    256,
  );
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bits));
  return [0, 1, 2, 3].map((i) => {
    const idx = ((digest[i * 2] << 8) | digest[i * 2 + 1]) % FINGERPRINT_EMOJIS.length;
    return FINGERPRINT_EMOJIS[idx]!;
  }) as [string, string, string, string];
}
