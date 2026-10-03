// SHARD — symmetric cipher built exclusively on the native Web Crypto
// API: AES-GCM-256 with a fresh random 12-byte IV for every payload.
// no third-party crypto libraries, ever.

const IV_LENGTH = 12; // 96-bit IV: the GCM sweet spot

/** Browser base64 helpers that work on raw bytes. */
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

export function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Fresh random 12-byte IV per payload, straight from the CSPRNG. */
export function generateIV(): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(IV_LENGTH));
}

/**
 * Encrypts any serializable payload under the shared session key.
 * Returns { iv, ciphertext }, both base64, ready for the wire envelope.
 */
export async function encryptPayload<T>(aesKey: CryptoKey, data: T) {
  const iv = generateIV();
  const plaintext = new TextEncoder().encode(JSON.stringify(data));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    aesKey,
    plaintext,
  );
  return { iv: toBase64(iv), ciphertext: toBase64(new Uint8Array(ciphertext)) };
}

/**
 * Decrypts an { iv, ciphertext } envelope and parses the original JSON.
 * Throws if the key is wrong or a single byte was tampered with
 * (AES-GCM authenticates the ciphertext).
 */
export async function decryptPayload<T>(
  aesKey: CryptoKey,
  ivBase64: string,
  ciphertextBase64: string,
): Promise<T> {
  const iv = fromBase64(ivBase64);
  const ciphertext = fromBase64(ciphertextBase64);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    aesKey,
    ciphertext,
  );
  return JSON.parse(new TextDecoder().decode(plaintext)) as T;
}
