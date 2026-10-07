// SHARD — hybrid post-quantum key agreement (Signal PQXDH / Apple PQ3 style).
// Classical leg: ECDH P-256 via the native Web Crypto API. Post-quantum leg:
// ML-KEM-768 / Kyber (FIPS 203) via @noble/post-quantum — the single audited
// third-party crypto import in the stack, present because WebCrypto ships no
// PQ primitives. Both shared secrets concatenate to a 64-byte hybrid secret
// that HKDF-SHA-256 turns into the AES-GCM-256 session key, so a future
// quantum attacker must break BOTH legs, not one. Private material never
// leaves the browser; the server only ever relays public keys.
import { ml_kem768 } from "@noble/post-quantum/ml-kem.js";
import { toBase64, fromBase64 } from "./cipher";

const ECDH_PARAMS: EcKeyGenParams = { name: "ECDH", namedCurve: "P-256" };
const HKDF_INFO = "shard-hybrid-pq-aes-256-gcm"; // domain separation for the session key
const FINGERPRINT_DOMAIN = "shard-fp-v1"; // domain separation for the fingerprint digest

/** ML-KEM-768 wire sizes (FIPS 203 Table 3): ek=1184, ct=1088, ss=32 bytes. */
export const KEM_PUBLIC_KEY_LENGTH = ml_kem768.lengths.publicKey!;
export const KEM_CIPHERTEXT_LENGTH = ml_kem768.lengths.cipherText!;
export const KEM_SHARED_LENGTH = ml_kem768.lengths.msg!;

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

/**
 * Generates a NON-extractable ECDH P-256 keypair: the private scalar never
 * exists as JavaScript bytes (only inside native WebCrypto storage) and the
 * key object can never be exported — the classical leg's memory-hygiene
 * guarantee. Derivation (deriveBits) does not require extractability.
 */
export async function generateECDHKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(ECDH_PARAMS, false, ["deriveBits"]);
}

/** Generates an ML-KEM-768 (Kyber) keypair for the post-quantum leg. */
export function generateKEMKeyPair(): { publicKey: Uint8Array; secretKey: Uint8Array } {
  return ml_kem768.keygen();
}

/** Exports a KEM public key to base64 (1184-byte encapsulation key). */
export function exportKEMPublicKey(key: Uint8Array): string {
  return toBase64(key);
}

/** Exports a public key to base64 raw form (65-byte uncompressed point). */
export async function exportPublicKey(key: CryptoKey): Promise<string> {
  const raw = await crypto.subtle.exportKey("raw", key);
  return toBase64(new Uint8Array(raw));
}

/** Imports a peer's base64 raw public key. Untrusted input: ECDH public only. */
export async function importPublicKey(base64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", fromBase64(base64), ECDH_PARAMS, true, []);
}

/**
 * Encapsulates a fresh shared secret against the peer's ML-KEM-768 key
 * (the encapsulator side of the KEM). Throws on a malformed peer key.
 */
export function encapsulate(peerKEMPubB64: string): {
  cipherTextB64: string;
  sharedSecret: Uint8Array;
} {
  const { cipherText, sharedSecret } = ml_kem768.encapsulate(fromBase64(peerKEMPubB64));
  return { cipherTextB64: toBase64(cipherText), sharedSecret };
}

/**
 * Best-effort zeroization of owned secret byte arrays (ML-KEM secret keys,
 * decapsulated secrets) before the references are dropped, so the bytes do
 * not linger reachable in the V8 heap until an arbitrary GC cycle. Note:
 * JavaScript cannot guarantee the GC never copied the buffer earlier —
 * this minimizes, not eliminates, the retention window.
 */
export function zeroize(bytes: Uint8Array | null | undefined): void {
  if (bytes) bytes.fill(0);
}

/**
 * Recovers the shared secret from an encapsulation with our secret key
 * (the decapsulator side). Deterministic counterpart of encapsulate().
 * FIPS 203 §7.3: a tampered ciphertext does NOT throw — decapsulation
 * returns a pseudo-random (implicit-rejection) secret, which is why the
 * protocol layer must run a GCM key-confirmation before trusting the key.
 */
export function decapsulate(cipherTextB64: string, secretKey: Uint8Array): Uint8Array {
  return ml_kem768.decapsulate(fromBase64(cipherTextB64), secretKey);
}

/** Hybrid combiner: 32B ECDH secret ‖ 32B ML-KEM secret → 64B input to HKDF. */
function combineSecrets(ecdhBits: Uint8Array, pqSecret: Uint8Array): Uint8Array<ArrayBuffer> {
  if (ecdhBits.length !== 32 || pqSecret.length !== KEM_SHARED_LENGTH) {
    throw new Error("hybrid secret length mismatch");
  }
  const combined = new Uint8Array(64);
  combined.set(ecdhBits, 0);
  combined.set(pqSecret, 32);
  return combined;
}

/**
 * Derives the shared AES-GCM-256 session key from the hybrid secret:
 * ECDH P-256 ‖ ML-KEM-768 → HKDF-SHA-256. Both peers run this with
 * (own private, peer public, same KEM secret) and land on identical key
 * material — the server sees none of it.
 *
 * The ECDH part is an explicit deriveBits chain instead of a single
 * subtle.deriveKey call: some engines restrict ECDH public-key usages,
 * and this two-step path is supported uniformly across all browsers.
 */
export async function deriveSharedKey(
  privateKey: CryptoKey,
  peerPublicKey: CryptoKey,
  pqSecret: Uint8Array,
): Promise<CryptoKey> {
  // 1. Raw ECDH shared secret (X-coordinate of the P-256 result point).
  const sharedBits = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: peerPublicKey }, privateKey, 256),
  );
  // 2. HKDF-Extract+Expand over the 64-byte hybrid secret, domain-separated.
  const hkdfBase = await crypto.subtle.importKey("raw", combineSecrets(sharedBits, pqSecret), "HKDF", false, ["deriveBits"]);
  const okm = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: new TextEncoder().encode(HKDF_INFO) },
    hkdfBase,
    256,
  );
  // 3. Materialize the non-extractable AES-GCM-256 session key.
  return crypto.subtle.importKey("raw", okm, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/**
 * 4 deterministic emojis verifying both sides share the same hybrid secret.
 * SHA-256("shard-fp-v1" ‖ ECDH secret ‖ ML-KEM secret) → 2 bytes per emoji
 * → index in the pool. The domain prefix separates this context from any
 * other digest over the raw hybrid secret (HKDF uses its own info label).
 */
export async function generateEmojiFingerprint(
  privateKey: CryptoKey,
  peerPublicKey: CryptoKey,
  pqSecret: Uint8Array,
): Promise<[string, string, string, string]> {
  const bits = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: peerPublicKey }, privateKey, 256),
  );
  const combined = combineSecrets(bits, pqSecret);
  const domain = new TextEncoder().encode(FINGERPRINT_DOMAIN);
  const input = new Uint8Array(domain.length + combined.length);
  input.set(domain, 0);
  input.set(combined, domain.length);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  return [0, 1, 2, 3].map((i) => {
    const idx = ((digest[i * 2] << 8) | digest[i * 2 + 1]) % FINGERPRINT_EMOJIS.length;
    return FINGERPRINT_EMOJIS[idx]!;
  }) as [string, string, string, string];
}
