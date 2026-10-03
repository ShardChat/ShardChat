// SHARD - client-side media pipeline: canvas compression
// before encryption so a 10 MB photo becomes a ~0.5 MB JPEG, and byte-level
// AES-GCM helpers for the chunked file streaming.

const MAX_DIMENSION = 1600;
const JPEG_QUALITY = 0.82;

/**
 * Downscales and re-encodes an image via an off-DOM canvas.
 * Returns a JPEG blob ≤ 1600px on the long side, quality 0.82.
 * Falls back to the original file if the browser cannot decode it.
 */
export async function compressImage(file: File): Promise<Blob> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_DIMENSION / Math.max(bitmap.width, bitmap.height));
    const w = Math.round(bitmap.width * scale);
    const h = Math.round(bitmap.height * scale);

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d context");
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close();

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY),
    );
    // drop the backing store right away — a long session compresses
    // any photos and some engines keep canvas pixels alive until GC.
    canvas.width = 0;
    canvas.height = 0;
    if (!blob || blob.size === 0) throw new Error("empty canvas output");
    return blob;
  } catch {
    return file; // undecodable (e.g. exotic format): send as-is, still E2EE
  }
}

/** AES-GCM over raw bytes (one-shot; used per 64 KB chunk). */
export async function encryptBytes(key: CryptoKey, bytes: Uint8Array<ArrayBuffer>) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, bytes);
  return { iv: toB64(iv), ciphertext: toB64(new Uint8Array(ct)) };
}

export async function decryptBytes(key: CryptoKey, ivB64: string, ctB64: string): Promise<Uint8Array<ArrayBuffer>> {
  const iv = fromB64(ivB64);
  const ct = fromB64(ctB64);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return new Uint8Array(pt);
}

function toB64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function fromB64(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
