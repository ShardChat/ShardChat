// SHARD — client-side file gate. Attachments are allowed unless they are
// empty, oversized, or an executable/script (including renamed binaries
// caught by magic bytes, and programs packed inside a ZIP). Office docs,
// media, archives and ordinary data files all pass.
import JSZip from "jszip";

/** Hard per-file upload cap: 25 MB (chunked over the socket; the receiver
 *  enforces the same ceiling inbound — see useFileTransfer MAX_INBOUND_BYTES). */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

/**
 * Executables, installers and scripts that must never travel through the
 * chat — even renamed or zipped. Checked case-insensitively with the dot.
 */
export const BLOCKED_EXTENSIONS = [
  ".exe", ".bat", ".cmd", ".sh", ".msi", ".apk", ".com", ".scr",
  ".vbs", ".dll", ".jar", ".bin", ".ps1", ".psm1", ".reg", ".hta",
  ".cpl", ".jse", ".wsf", ".wsh", ".gadget", ".deb", ".appimage",
] as const;

const BLOCKED = new Set<string>(BLOCKED_EXTENSIONS);

/** Lowercase extension (with the dot) of a file name. */
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot).toLowerCase();
}

/** True when the extension is on the executable blocklist. */
export function isBlockedName(name: string): boolean {
  return BLOCKED.has(extensionOf(name));
}

/** True when the file claims to be a ZIP archive we must inspect. */
export function isZipName(name: string): boolean {
  return extensionOf(name) === ".zip";
}

/** Human messages — short, calm, no scary security theatre. */
export const MESSAGES = {
  tooLarge: "File is too large (25 MB max)",
  executable: "Programs and scripts cannot be sent",
  zipProgram: "The archive contains programs — this file can't be sent",
  corrupted: "File is corrupted",
  disguised: "This file can't be sent",
  empty: "An empty file can't be sent",
} as const;

/** Magic bytes that identify native executables / binaries. */
const EXECUTABLE_MAGIC: Array<{ bytes: number[] }> = [
  { bytes: [0x4d, 0x5a] }, // PE/DLL
  { bytes: [0x7f, 0x45, 0x4c, 0x46] }, // ELF
  { bytes: [0xca, 0xfe, 0xba, 0xbe] }, // Mach-O / Java class
  { bytes: [0xfe, 0xed, 0xfa, 0xce] }, // Mach-O
  { bytes: [0x64, 0x65, 0x78, 0x0a] }, // DEX
];

function looksLikeExecutable(head: Uint8Array): boolean {
  return EXECUTABLE_MAGIC.some((sig) =>
    sig.bytes.every((b, i) => head[i] === b),
  );
}

/**
 * Scans ZIP entry names for executables. Reads the central directory
 * only — no entry is decompressed.
 */
export async function scanZipEntries(file: File): Promise<string[]> {
  try {
    const zip = await JSZip.loadAsync(file, { checkCRC32: false });
    const blocked: string[] = [];
    zip.forEach((path, entry) => {
      if (!entry.dir && isBlockedName(path) && !blocked.includes(path)) {
        blocked.push(path);
      }
    });
    return blocked;
  } catch {
    return ["<corrupted archive>"];
  }
}

export type FileCheckResult = { ok: true } | { ok: false; reason: string };

/**
 * Quiet gate for one attachment:
 *  1. size ≤ 25 MB, non-empty
 *  2. executable/script extension blocklist
 *  3. magic bytes — renamed binaries
 *  4. ZIP central-directory scan — programs packed inside archives
 */
export async function checkFile(file: File): Promise<FileCheckResult> {
  if (file.size > MAX_FILE_BYTES) return { ok: false, reason: MESSAGES.tooLarge };
  if (file.size === 0) return { ok: false, reason: MESSAGES.empty };
  if (isBlockedName(file.name)) return { ok: false, reason: MESSAGES.executable };

  try {
    const head = new Uint8Array(await file.slice(0, 4100).arrayBuffer());
    if (looksLikeExecutable(head)) return { ok: false, reason: MESSAGES.disguised };
  } catch {
    return { ok: false, reason: MESSAGES.corrupted };
  }

  if (isZipName(file.name)) {
    const blockedEntries = await scanZipEntries(file);
    if (blockedEntries.length > 0) return { ok: false, reason: MESSAGES.zipProgram };
  }
  return { ok: true };
}

/** Formats a byte count as a compact human string (4.2 MB / 312 KB / 8 B). */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
