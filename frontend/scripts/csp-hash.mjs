// Reports the CSP `script-src` hash of every inline <script> in index.html.
//
// The theme bootstrap in index.html must run before first paint, so it cannot
// move into a bundle (that would cost a round trip and flash anyway) and the
// relay's `script-src 'self'` refuses to execute it. Hashing it into the CSP
// keeps the page self-contained: any host that emits the header honours it, and
// a host that emits none (Render Static Site) is unaffected.
//
// Run after `npm run build`, then paste the hash into
// backend/internal/httpx/security.go. Re-run whenever this script changes.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const sha256 = (text) =>
  "sha256-" + createHash("sha256").update(text, "utf8").digest("base64");

for (const file of ["index.html", "dist/index.html"]) {
  const html = readFileSync(file, "utf8");
  const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)];
  console.log(`\n== ${file}: ${inline.length} inline script(s)`);
  for (const [, body] of inline) {
    console.log(`   hash: ${sha256(body)}`);
    console.log(`   bytes: ${Buffer.byteLength(body, "utf8")}`);
  }
}

// Vite rewrites index.html; if it reformats the script, the hash taken from
// source and from dist would differ and the CSP would silently break.
const inSource = [...readFileSync("index.html", "utf8").matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)][0][1];
const inDist = [...readFileSync("dist/index.html", "utf8").matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)][0][1];
console.log(`\nsource == dist: ${inSource === inDist}`);
if (inSource !== inDist) {
  console.log("!! Vite reformatted the inline script - hash the DIST copy above.");
}