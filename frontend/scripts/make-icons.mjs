// Derives the PWA icon set from public/logo.png.
//
// The brand mark lives once, in logo.png, which is also what Open Graph serves.
// Every platform that wants a square icon - Android install prompt, iOS home
// screen, Windows tile - wants the SAME picture at a different size, so the
// sizes are generated from the master instead of being hand-exported six times
// and drifting apart over the life of the repo.
//
// No image library: PNG decode/encode is ~120 lines on top of node:zlib, and
// the repo otherwise has no binary asset toolchain to depend on. Only the
// subset the logo needs is handled (8-bit, non-interlaced, 8-bit palette);
// anything else is rejected loudly rather than decoded wrong.
//
// Run:  node scripts/make-icons.mjs           (rewrite public/icon-*.png)
//       node scripts/make-icons.mjs --inspect (report the logo's content box)
//
// The output is committed, not built: installability must not depend on a code
// generator running, and a manifest icon that only exists after `npm run build`
// is one broken deploy away from an un-installable site.

import { readFileSync, writeFileSync } from "node:fs";
import { inflateSync, deflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const pub = (name) => join(here, "..", "public", name);

// ---------------------------------------------------------------- PNG decode

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** PNG bytes -> { width, height, data } with 8-bit RGBA samples. */
function decodePng(buf) {
  const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!buf.subarray(0, 8).equals(SIG)) throw new Error("not a PNG");

  let ihdr = null;
  const idat = [];
  let plte = null;
  let trns = null;

  for (let off = 8; off + 8 <= buf.length; ) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      ihdr = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        depth: data[8],
        color: data[9],
        interlace: data[12],
      };
    } else if (type === "PLTE") plte = data;
    else if (type === "tRNS") trns = data;
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    off += 12 + len;
  }

  if (!ihdr) throw new Error("missing IHDR");
  if (ihdr.depth !== 8) throw new Error(`unsupported bit depth ${ihdr.depth}`);
  if (ihdr.interlace !== 0) throw new Error("interlaced PNG unsupported");

  const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  const ch = CHANNELS[ihdr.color];
  if (!ch) throw new Error(`unsupported colour type ${ihdr.color}`);

  const { width, height } = ihdr;
  const bpp = ch;
  const stride = width * bpp;
  const raw = inflateSync(Buffer.concat(idat));
  const flat = Buffer.alloc(height * stride);

  // Undo the per-scanline filters (PNG spec 9.2).
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const ft = raw[pos++];
    const line = raw.subarray(pos, pos + stride);
    pos += stride;
    const cur = flat.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? flat.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= bpp ? prev[x - bpp] : 0;
      const v = line[x];
      cur[x] =
        (ft === 0 ? v
          : ft === 1 ? v + a
          : ft === 2 ? v + b
          : ft === 3 ? v + ((a + b) >> 1)
          : ft === 4 ? v + paeth(a, b, c)
          : (() => { throw new Error(`bad filter ${ft}`); })()) & 0xff;
    }
  }

  // Normalise every colour type to RGBA.
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0, n = width * height; i < n; i++) {
    const s = i * bpp;
    const d = i * 4;
    switch (ihdr.color) {
      case 0:
        data[d] = data[d + 1] = data[d + 2] = flat[s];
        data[d + 3] = 255;
        break;
      case 2:
        data[d] = flat[s];
        data[d + 1] = flat[s + 1];
        data[d + 2] = flat[s + 2];
        data[d + 3] = 255;
        break;
      case 3: {
        const p = flat[s] * 3;
        data[d] = plte[p];
        data[d + 1] = plte[p + 1];
        data[d + 2] = plte[p + 2];
        data[d + 3] = trns && flat[s] < trns.length ? trns[flat[s]] : 255;
        break;
      }
      case 4:
        data[d] = data[d + 1] = data[d + 2] = flat[s];
        data[d + 3] = flat[s + 1];
        break;
      default:
        data[d] = flat[s];
        data[d + 1] = flat[s + 1];
        data[d + 2] = flat[s + 2];
        data[d + 3] = flat[s + 3];
    }
  }
  return { width, height, data };
}

// ---------------------------------------------------------------- PNG encode

function chunk(type, body) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length);
  const head = Buffer.concat([Buffer.from(type, "ascii"), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(head));
  return Buffer.concat([len, head, crc]);
}

/** RGBA samples -> PNG bytes, adaptive per-scanline filtering. */
function encodePng(width, height, data) {
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  const cand = [Buffer.alloc(stride), Buffer.alloc(stride), Buffer.alloc(stride), Buffer.alloc(stride), Buffer.alloc(stride)];

  for (let y = 0; y < height; y++) {
    const row = data.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? data.subarray((y - 1) * stride, y * stride) : null;

    let best = 0;
    let bestScore = Infinity;
    for (let ft = 0; ft < 5; ft++) {
      let score = 0;
      for (let x = 0; x < stride; x++) {
        const a = x >= 4 ? row[x - 4] : 0;
        const b = prev ? prev[x] : 0;
        const c = prev && x >= 4 ? prev[x - 4] : 0;
        let v;
        if (ft === 0) v = row[x];
        else if (ft === 1) v = row[x] - a;
        else if (ft === 2) v = row[x] - b;
        else if (ft === 3) v = row[x] - ((a + b) >> 1);
        else v = row[x] - paeth(a, b, c);
        v &= 0xff;
        cand[ft][x] = v;
        score += v < 128 ? v : 256 - v; // min sum of absolute differences
      }
      if (score < bestScore) {
        bestScore = score;
        best = ft;
      }
    }
    raw[y * (stride + 1)] = best;
    cand[best].copy(raw, y * (stride + 1) + 1);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // truecolour with alpha
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ----------------------------------------------------------------- raster ops

/**
 * Area-average downscale (the correct filter when the ratio is far from 1:1 -
 * point sampling would alias the crystal's thin outline into dashes).
 * Alpha is averaged premultiplied so an edge pixel cannot bleed its colour
 * into a neighbouring transparent one.
 */
function resize(src, w, h) {
  const out = Buffer.alloc(w * h * 4);
  const sx = src.width / w;
  const sy = src.height / h;
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * src.width + xx) * 4;
          const av = src.data[i + 3];
          r += src.data[i] * av;
          g += src.data[i + 1] * av;
          b += src.data[i + 2] * av;
          a += av;
          n++;
        }
      }
      const o = (y * w + x) * 4;
      if (a === 0) {
        out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 0;
      } else {
        out[o] = Math.round(r / a);
        out[o + 1] = Math.round(g / a);
        out[o + 2] = Math.round(b / a);
        out[o + 3] = Math.round(a / n);
      }
    }
  }
  return { width: w, height: h, data: out };
}

function crop(img, box) {
  const w = box.maxX - box.minX + 1;
  const h = box.maxY - box.minY + 1;
  const data = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    img.data.copy(
      data,
      y * w * 4,
      ((y + box.minY) * img.width + box.minX) * 4,
      ((y + box.minY) * img.width + box.maxX + 1) * 4,
    );
  }
  return { width: w, height: h, data };
}

/** Opaque canvas of `size`, with `img` centred inside `frac` of its width. */
function compose(img, size, bg, frac) {
  const out = { width: size, height: size, data: Buffer.alloc(size * size * 4) };
  for (let i = 0; i < size * size; i++) {
    out.data[i * 4] = bg[0];
    out.data[i * 4 + 1] = bg[1];
    out.data[i * 4 + 2] = bg[2];
    out.data[i * 4 + 3] = 255;
  }
  const target = size * frac;
  const scale = Math.min(target / img.width, target / img.height);
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const scaled = resize(img, w, h);
  const ox = Math.round((size - w) / 2);
  const oy = Math.round((size - h) / 2);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 4;
      const alpha = scaled.data[s + 3] / 255;
      if (alpha === 0) continue;
      const o = ((y + oy) * size + (x + ox)) * 4;
      out.data[o] = Math.round(scaled.data[s] * alpha + out.data[o] * (1 - alpha));
      out.data[o + 1] = Math.round(scaled.data[s + 1] * alpha + out.data[o + 1] * (1 - alpha));
      out.data[o + 2] = Math.round(scaled.data[s + 2] * alpha + out.data[o + 2] * (1 - alpha));
      out.data[o + 3] = Math.max(out.data[o + 3], scaled.data[s + 3]);
    }
  }
  return out;
}

// --------------------------------------------------------------- the artwork

const logo = decodePng(readFileSync(pub("logo.png")));

// theme-color from index.html; the iOS tile has no alpha channel to composite
// against, so it must carry its own background or iOS paints it black.
const BG = [0x09, 0x09, 0x0b];

const corner = (x, y) => {
  const i = (y * logo.width + x) * 4;
  return [logo.data[i], logo.data[i + 1], logo.data[i + 2], logo.data[i + 3]];
};

/** Bounding box of every pixel that differs from the four corners. */
function contentBox() {
  const probe = [...corner(0, 0), ...corner(logo.width - 1, 0),
    ...corner(0, logo.height - 1), ...corner(logo.width - 1, logo.height - 1)];
  let minX = logo.width, minY = logo.height, maxX = -1, maxY = -1;
  for (let y = 0; y < logo.height; y++) {
    for (let x = 0; x < logo.width; x++) {
      const i = (y * logo.width + x) * 4;
      if (probe.includes(logo.data[i]) && probe.includes(logo.data[i + 1]) &&
          probe.includes(logo.data[i + 2])) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  return maxX < 0 ? null : { minX, minY, maxX, maxY };
}

if (process.argv.includes("--inspect")) {
  const c = corner(0, 0);
  const box = contentBox();
  console.log(`logo.png   ${logo.width}x${logo.height}`);
  console.log(`corner     rgb(${c.slice(0, 3).join(", ")}) a=${c[3]}`);
  if (!box) {
    console.log("content    uniform - no logo found");
  } else {
    const w = box.maxX - box.minX + 1;
    const h = box.maxY - box.minY + 1;
    console.log(`content    ${w}x${h} at (${box.minX},${box.minY})`);
    console.log(`padding    ${(box.minX / logo.width * 100).toFixed(1)}% inset`);
  }
  process.exit(0);
}

// The mark as drawn, with logo.png's ~24% baked-in padding removed. The crop
// edges are the same #09090b as the canvas below, so the seam is invisible.
const box = contentBox();
if (!box) throw new Error("logo.png has no mark to derive icons from");
const mark = crop(logo, box);

// The mark is fitted to 75% of the canvas, not to the full 80% that MDN
// documents as the guaranteed-visible circle. 80% is the MINIMUM a mask has to
// keep, so a mark sized to exactly 80% parks its crystal tips right on the cut
// line - and the iOS squircle's inscribed circle is already ~79.8%. The 5% of
// headroom costs nothing visually: the mark still reads slightly larger than
// on the "any" icon (75% vs 72.9% of height), which is the expected
// relationship, since a maskable icon is drawn full-bleed to be cropped.
//
// This measures the MARK, not the source canvas: scaling logo.png itself down
// to 75% would leave the mark at only ~55% of the icon, because logo.png
// already carries ~24% of padding of its own.
const SAFE = 0.75;

const targets = [
  { file: "icon-192.png", size: 192, src: logo, frac: 1, note: 'purpose "any"' },
  { file: "icon-512.png", size: 512, src: logo, frac: 1, note: 'purpose "any"' },
  { file: "maskable-192.png", size: 192, src: mark, frac: SAFE, note: 'purpose "maskable"' },
  { file: "maskable-512.png", size: 512, src: mark, frac: SAFE, note: 'purpose "maskable"' },
  // iOS ignores the manifest entirely: it takes this one PNG and rounds it
  // itself, and it has no alpha channel to composite against, so the tile
  // must carry the background or the mark lands on black.
  { file: "apple-touch-icon.png", size: 180, src: mark, frac: SAFE, note: "iOS home screen" },
];

for (const t of targets) {
  const canvas = t.frac === 1
    ? resize(t.src, t.size, t.size)
    : compose(t.src, t.size, BG, t.frac);
  const png = encodePng(t.size, t.size, canvas.data);
  writeFileSync(pub(t.file), png);
  console.log(`${t.file.padEnd(24)} ${t.size}x${t.size}  ${String(png.length).padStart(6)} B  ${t.note}`);
}