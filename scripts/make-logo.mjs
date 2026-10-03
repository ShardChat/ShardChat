// SHARD — GitHub logo generator: renders the faceted crystal (same geometry
// as favicon.svg / CrystalLogo.tsx) — white body, black facet cuts — onto a
// black square, and writes a dependency-free PNG via Node's zlib.
//
// Usage:  node scripts/make-logo.mjs   →  logo.png (1024×1024, project root)
// Swap FILL/BG below if a different color variant is ever needed.
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ---- Brand colors: dark-theme crystal on the page background. ----
const FILL = [0xfa, 0xfa, 0xfa]; // #fafafa — the white crystal body
const BG = [0x09, 0x09, 0x0b]; // #09090b — page black + facet cuts

// ---- Geometry (viewBox 0 0 24 24, stroke-width 1.2, butt caps). ----
const POLYGON = [
  [12, 1.5], [19.5, 6], [17.5, 18.5], [12, 22.5], [6.5, 18.5], [4.5, 6],
];
const CUTS = [
  [[4.5, 6], [12, 9.5]],
  [[12, 9.5], [19.5, 6]],
  [[12, 9.5], [12, 22.5]],
];
const STROKE_HALF = 1.2 / 2;

// ---- Canvas: 1024² with the crystal centered at ~74% height. ----
const SIZE = 1024;
const SCALE = (SIZE * 0.74) / 21; // crystal is 21 units tall
const CX = SIZE / 2;
const CY = SIZE / 2;
const toPx = (x, y) => [CX + (x - 12) * SCALE, CY + (y - 12) * SCALE];

function pointInPolygon(px, py) {
  let inside = false;
  for (let i = 0, j = POLYGON.length - 1; i < POLYGON.length; j = i++) {
    const [xi, yi] = POLYGON[i];
    const [xj, yj] = POLYGON[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function nearCut(px, py) {
  for (const [[x1, y1], [x2, y2]] of CUTS) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const lenSq = dx * dx + dy * dy;
    const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lenSq));
    const ex = x1 + t * dx - px;
    const ey = y1 + t * dy - py;
    if (ex * ex + ey * ey <= STROKE_HALF * STROKE_HALF) return true;
  }
  return false;
}

// ---- Rasterize with 3×3 supersampling for clean anti-aliased edges. ----
const SUB = 3;
const raw = Buffer.alloc(SIZE * (1 + SIZE * 3)); // filter byte + RGB rows
for (let py = 0; py < SIZE; py++) {
  const rowStart = py * (1 + SIZE * 3);
  raw[rowStart] = 0; // PNG filter: none
  for (let px = 0; px < SIZE; px++) {
    let cov = 0; // fraction of subsamples covered by the white body
    for (let sy = 0; sy < SUB; sy++) {
      for (let sx = 0; sx < SUB; sx++) {
        const ux = (px + (sx + 0.5) / SUB - CX) / SCALE + 12;
        const uy = (py + (sy + 0.5) / SUB - CY) / SCALE + 12;
        if (pointInPolygon(ux, uy) && !nearCut(ux, uy)) cov++;
      }
    }
    const o = rowStart + 1 + px * 3;
    raw[o] = Math.round(BG[0] + (FILL[0] - BG[0]) * (cov / (SUB * SUB)));
    raw[o + 1] = Math.round(BG[1] + (FILL[1] - BG[1]) * (cov / (SUB * SUB)));
    raw[o + 2] = Math.round(BG[2] + (FILL[2] - BG[2]) * (cov / (SUB * SUB)));
  }
}

// ---- Minimal PNG writer (RGB, 8-bit, filter 0, single IDAT). ----
const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 2; // color type: truecolor RGB
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

const outPath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "logo.png");
writeFileSync(outPath, png);
console.log(`logo.png written: ${SIZE}x${SIZE}, ${png.length} bytes → ${outPath}`);
