// SHARD - chunked E2EE file transfer. Files are sliced into
// 64 KB chunks, each sealed independently with AES-GCM, and streamed as
// FILE_CHUNK_START -> FILE_CHUNK_DATA* -> FILE_CHUNK_END. The Go relay
// forwards every frame immediately and stores nothing — memory stays flat.
import { useCallback, useRef } from "react";
import type { FileChunkDataPayload, FileChunkEndPayload, FileChunkStartPayload, WSPacket } from "../types/protocol";
import { decryptBytes, encryptBytes } from "../lib/media";
import { decryptPayload, encryptPayload } from "../crypto/cipher";
import { clamp01, isValidId, randomId } from "../lib/utils";

export const CHUNK_SIZE = 64 * 1024; // 64 KB plaintext per chunk

/** Max in-flight unacked bytes toward the peer (~1 MB) — WS-level backpressure. */
const MAX_BUFFERED = 1024 * 1024;

/**
 * Inbound transfer ceiling : the receiver enforces its own hard limit
 * and never trusts the sender's sealed metadata. Mirrors the upload gate
 * in lib/fileSecurity.ts (25 MB).
 */
export const MAX_INBOUND_BYTES = 25 * 1024 * 1024; // 25 MB
const MAX_INBOUND_CHUNKS = Math.ceil(MAX_INBOUND_BYTES / CHUNK_SIZE); // 400
/** How long a half-received transfer may sit idle before its buffer is freed. */
const INBOUND_TIMEOUT_MS = 60_000;

interface Wire {
  send: (pkt: WSPacket) => boolean;
  bufferedAmount: () => number;
}

export interface TransferProgress {
  fileId: string;
  /** 0..1 for both directions. */
  progress: number;
  direction: "up" | "down";
}

interface UseFileTransferResult {
  sendFile: (
    blob: Blob,
    opts: { sharedKey: CryptoKey; caption?: string; messageId?: string; attachment?: boolean; onProgress?: (p: number) => void; onDone?: () => void },
  ) => Promise<void>;
  /** Feed every incoming FILE_CHUNK_* packet here; resolves with the file when complete. */
  handleChunkPacket: (
    pkt: WSPacket,
    opts: { sharedKey: CryptoKey; onProgress?: (p: number) => void; onDone: (file: { blob: Blob; name: string; caption?: string; messageId?: string; attachment?: boolean }) => void },
  ) => Promise<void>;
}

interface IncomingState {
  meta: FileChunkStartPayload;
  parts: Uint8Array[];
  received: number;
}

export function useFileTransfer(wire: Wire): UseFileTransferResult {
  const incoming = useRef(new Map<string, IncomingState>());
  /** Per-transfer stall timers: free buffers of transfers that never finish. */
  const staleTimers = useRef(new Map<string, number>());

  /** (Re)arms the idle reaper: a transfer that goes INBOUND_TIMEOUT_MS
   * without a new chunk (or END) has its buffer freed. */
  const armStallTimer = useCallback((fileId: string) => {
    window.clearTimeout(staleTimers.current.get(fileId));
    staleTimers.current.set(
      fileId,
      window.setTimeout(() => {
        incoming.current.delete(fileId);
        staleTimers.current.delete(fileId);
      }, INBOUND_TIMEOUT_MS),
    );
  }, []);

  const sendFile = useCallback(
    async (
      blob: Blob,
      { sharedKey, caption, messageId, attachment, onProgress, onDone }: { sharedKey: CryptoKey; caption?: string; messageId?: string; attachment?: boolean; onProgress?: (p: number) => void; onDone?: () => void },
    ) => {
      const fileId = randomId();
      const totalChunks = Math.max(1, Math.ceil(blob.size / CHUNK_SIZE));

      const start: FileChunkStartPayload = {
        fileId,
        name: blob instanceof File ? blob.name : "image.jpg",
        mime: blob.type || "application/octet-stream",
        totalSize: blob.size,
        totalChunks,
        chunkSize: CHUNK_SIZE,
        ...(caption ? { caption } : {}),
        ...(messageId ? { messageId } : {}),
        ...(attachment ? { attachment: true } : {}),
      };
      // the announcement (file name, mime, size) is itself sealed with the
      // shared key: the wire carries only {iv, ciphertext} — zero metadata leak.
      const sealedStart = await encryptPayload(sharedKey, start);
      if (!wire.send({ type: "FILE_CHUNK_START", payload: sealedStart })) return;

      for (let i = 0; i < totalChunks; i++) {
        // backpressure: pause slicing while the socket drains (~1 MB cap).
        while (wire.bufferedAmount() > MAX_BUFFERED) {
          await new Promise((r) => setTimeout(r, 40));
        }
        const plain = new Uint8Array(await blob.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE).arrayBuffer());
        const sealed = await encryptBytes(sharedKey, plain);
        const data: FileChunkDataPayload = { fileId, chunkIndex: i, iv: sealed.iv, ciphertext: sealed.ciphertext };
        wire.send({ type: "FILE_CHUNK_DATA", payload: data });
        onProgress?.(clamp01((i + 1) / totalChunks));
      }
      wire.send({ type: "FILE_CHUNK_END", payload: { fileId } satisfies FileChunkEndPayload });
      onDone?.();
    },
    [wire],
  );

  const handleChunkPacket = useCallback(
    async (
      pkt: WSPacket,
      { sharedKey, onProgress, onDone }: { sharedKey: CryptoKey; onProgress?: (p: number) => void; onDone: (file: { blob: Blob; name: string; caption?: string; messageId?: string; attachment?: boolean }) => void },
    ) => {
      if (pkt.type === "FILE_CHUNK_START") {
        const sealed = pkt.payload as { iv: string; ciphertext: string };
        if (!sealed?.ciphertext) return;
        let meta: FileChunkStartPayload;
        try {
          meta = await decryptPayload<FileChunkStartPayload>(sharedKey, sealed.iv, sealed.ciphertext);
        } catch {
          return; // wrong key / tampered announcement: drop
        }
        // the fileId keys the transfer map — enforce the wire-id shape;
        // also type-check the sealed metadata we render in the UI.
        if (!isValidId(meta?.fileId)) return;
        if (typeof meta.name !== "string" || meta.name.length > 256) return;
        if (typeof meta.mime !== "string" || meta.mime.length > 128) return;
        // Validate the sealed metadata against hard ceilings BEFORE any
        // allocation. totalChunks/totalSize come from the (encrypted, but
        // sender-controlled) announcement - trusting them blindly would let
        // a single packet reserve a huge parts array.
        const totalSize = meta.totalSize ?? 0;
        const totalChunks = meta.totalChunks ?? 0;
        const chunkSize = meta.chunkSize ?? CHUNK_SIZE;
        if (totalSize <= 0 || totalSize > MAX_INBOUND_BYTES) return;
        if (totalChunks <= 0 || totalChunks > MAX_INBOUND_CHUNKS) return;
        if (totalChunks * CHUNK_SIZE < totalSize) return;
        if (chunkSize <= 0 || chunkSize > CHUNK_SIZE) return;
        // free the buffer if this transfer stalls before FILE_CHUNK_END.
        armStallTimer(meta.fileId);
        incoming.current.set(meta.fileId, { meta, parts: new Array(totalChunks), received: 0 });
        return;
      }
      // idempotent finalization: the first caller to reach it detaches the
      // state, so a late END after the last chunk cannot double-deliver.
      const finalize = (fileId: string, st: IncomingState) => {
        if (incoming.current.get(fileId) !== st) return;
        incoming.current.delete(fileId);
        window.clearTimeout(staleTimers.current.get(fileId));
        staleTimers.current.delete(fileId);
        // Assemble only a complete, hole-free transfer; the declared
        // size must match byte-for-byte. Anything else is destroyed.
        const blob = new Blob(st.parts as BlobPart[], { type: st.meta.mime });
        if (blob.size !== st.meta.totalSize) return; // reassembled bytes lie
        onDone({ blob, name: st.meta.name, caption: st.meta.caption, messageId: st.meta.messageId, attachment: st.meta.attachment });
      };
      if (pkt.type === "FILE_CHUNK_DATA") {
        const p = pkt.payload as FileChunkDataPayload;
        if (!isValidId(p?.fileId) || !Number.isInteger(p?.chunkIndex)) return; // L-1
        const st = incoming.current.get(p.fileId);
        // the index must be a fresh integer inside the declared range —
        // anything else (replays, sparse-array probes) is dropped.
        if (
          !st ||
          !Number.isInteger(p.chunkIndex) ||
          (p.chunkIndex as number) < 0 ||
          (p.chunkIndex as number) >= st.meta.totalChunks ||
          st.parts[p.chunkIndex]
        ) {
          return;
        }
        try {
          st.parts[p.chunkIndex] = await decryptBytes(sharedKey, p.iv, p.ciphertext);
        } catch {
          return; // corrupted chunk: drop, GCM authenticated
        }
        st.received += 1;
        onProgress?.(clamp01(st.received / st.meta.totalChunks));
        armStallTimer(p.fileId);
        // chunks decrypt asynchronously, so FILE_CHUNK_END can be processed
        // before the last chunk finishes: whoever runs last — the final
        // decrypt here or END below — finalizes the transfer.
        if (st.received === st.meta.totalChunks && !st.parts.some((part) => !part)) {
          finalize(p.fileId, st);
        }
        return;
      }
      if (pkt.type === "FILE_CHUNK_END") {
        const { fileId } = (pkt.payload ?? {}) as FileChunkEndPayload;
        if (!isValidId(fileId)) return; // L-1
        const st = incoming.current.get(fileId);
        if (!st) return;
        if (st.received !== st.meta.totalChunks || st.parts.some((part) => !part)) {
          // chunks still decrypting (they will finalize on arrival) or
          // genuinely lost - the stall timer reaps the latter.
          return;
        }
        finalize(fileId, st);
      }
    },
    [armStallTimer],
  );

  return { sendFile, handleChunkPacket };
}
