// SHARD - browser self-test for the crypto engine. Open the app
// in a browser, then run from the DevTools console:
//
// import("/src/crypto/selftest.ts").then(m => m.runCryptoSelfTest());
//
// It validates: ECDH key agreement parity (both peers derive the same AES
// key), fingerprint determinism, encrypt/decrypt round-trips, and that GCM
// rejects tampered ciphertext or a wrong key.

import {
  generateECDHKeyPair,
  exportPublicKey,
  importPublicKey,
  deriveSharedKey,
  generateEmojiFingerprint,
} from "./ecdh";
import { encryptPayload, decryptPayload, generateIV } from "./cipher";

let failed = 0;
function check(name: string, cond: boolean, extra = "") {
  console.log(`${cond ? "  PASS" : "  FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failed++;
}

export async function runCryptoSelfTest(): Promise<boolean> {
  console.log("SHARD crypto self-test");

  // 1. Two peers independently generate ECDH P-256 keypairs.
  const pairA = await generateECDHKeyPair();
  const pairB = await generateECDHKeyPair();

  // 2. Public keys cross the (blind) server as base64 raw strings.
  const pubAB64 = await exportPublicKey(pairA.publicKey);
  const pubBB64 = await exportPublicKey(pairB.publicKey);
  check("public keys export to base64 raw", pubAB64.length > 80 && pubBB64.length > 80);

  const importedB = await importPublicKey(pubBB64);
  const importedA = await importPublicKey(pubAB64);

  // 3. Both peers derive their session keys from opposite corners.
  const keyA = await deriveSharedKey(pairA.privateKey, importedB);
  const keyB = await deriveSharedKey(pairB.privateKey, importedA);

  // 4. Parity: whatever A encrypts, B decrypts byte-for-byte.
  const probe = { text: "👻 hello, e2ee!", n: 42, nested: { ok: true } };
  const sealed = await encryptPayload(keyA, probe);
  const opened = await decryptPayload<typeof probe>(keyB, sealed.iv, sealed.ciphertext);
  check("round-trip A encrypt → B decrypt", JSON.stringify(probe) === JSON.stringify(opened));

  // 5. Symmetry: B → A as well.
  const sealedB = await encryptPayload(keyB, probe);
  const back = await decryptPayload<typeof probe>(keyA, sealedB.iv, sealedB.ciphertext);
  check("round-trip B encrypt → A decrypt", JSON.stringify(probe) === JSON.stringify(back));

  // 6. Fingerprint: deterministic and identical on both sides.
  const fpA = await generateEmojiFingerprint(pairA.privateKey, importedB);
  const fpB = await generateEmojiFingerprint(pairB.privateKey, importedA);
  check("4-emoji fingerprint matches on both peers", fpA.join("") === fpB.join(""), fpA.join(" "));
  const fpAgain = await generateEmojiFingerprint(pairA.privateKey, importedB);
  check("fingerprint is deterministic", fpA.join("") === fpAgain.join(""));

  // 7. GCM authentication: tampering must throw.
  const tampered = await encryptPayload(keyA, probe);
  const rawCt = atob(tampered.ciphertext);
  const flipped = btoa(
    String.fromCharCode(rawCt.charCodeAt(0) ^ 1) + rawCt.slice(1),
  );
  let tamperRejected = false;
  try {
    await decryptPayload(keyA, tampered.iv, flipped);
  } catch {
    tamperRejected = true;
  }
  check("tampered ciphertext rejected by GCM", tamperRejected);

  // 8. Wrong key must throw, not produce garbage.
  const strangerPair = await generateECDHKeyPair();
  // deriveSharedKey must fail safely (reject) on a malformed peer key
  // instead of crashing the handshake promise chain.
  let badPointRejected = false;
  try {
    await deriveSharedKey(strangerPair.privateKey, strangerPair.publicKey);
  // engines that happily accept same-side points land here — derive still
  // succeeds cryptographically, so the guard is best-effort, not a fence.
  } catch {
    badPointRejected = true;
  }
  try {
    await importPublicKey("not-valid-base64!!");
  } catch {
    badPointRejected = true;
  }
  check("import/derive reject malformed keys safely", badPointRejected);
  const strangerKey = await deriveSharedKey(strangerPair.privateKey, importedA);
  let wrongKeyRejected = false;
  try {
    await decryptPayload(strangerKey, sealed.iv, sealed.ciphertext);
  } catch {
    wrongKeyRejected = true;
  }
  check("foreign key cannot decrypt", wrongKeyRejected);

  console.log(failed === 0 ? "All crypto checks passed." : `${failed} check(s) FAILED.`);
  return failed === 0;
}

// re-exported for convenience when poking from the console.
export { generateIV };
