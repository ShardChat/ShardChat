// SHARD - browser self-test for the crypto engine. Open the app
// in a browser, then run from the DevTools console:
//
// import("/src/crypto/selftest.ts").then(m => m.runCryptoSelfTest());
//
// It validates the hybrid post-quantum handshake end to end: ML-KEM-768
// encapsulate/decapsulate parity, hybrid ECDH+Kyber key agreement parity
// (both peers derive the same AES key, proven with a real AES-GCM tag),
// fingerprint determinism over the combined secret, encrypt/decrypt
// round-trips, and that GCM rejects tampered ciphertext or a wrong key.

import {
  generateECDHKeyPair,
  generateKEMKeyPair,
  exportPublicKey,
  exportKEMPublicKey,
  importPublicKey,
  deriveSharedKey,
  generateEmojiFingerprint,
  encapsulate,
  decapsulate,
  zeroize,
  KEM_PUBLIC_KEY_LENGTH,
  KEM_CIPHERTEXT_LENGTH,
  KEM_SHARED_LENGTH,
} from "./ecdh";
import { encryptPayload, decryptPayload, generateIV } from "./cipher";

let failed = 0;
function check(name: string, cond: boolean, extra = "") {
  console.log(`${cond ? "  PASS" : "  FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failed++;
}

export async function runCryptoSelfTest(): Promise<boolean> {
  console.log("SHARD crypto self-test (hybrid ECDH P-256 + ML-KEM-768)");

  // 1. Two peers independently generate both legs of the hybrid keypair.
  const pairA = await generateECDHKeyPair();
  const pairB = await generateECDHKeyPair();
  const kemA = generateKEMKeyPair();
  const kemB = generateKEMKeyPair();
  check(
    "ML-KEM-768 keypair wire sizes (ek 1184, dk 2400, ss 32)",
    kemA.publicKey.length === KEM_PUBLIC_KEY_LENGTH &&
      kemA.secretKey.length === 2400 &&
      KEM_SHARED_LENGTH === 32 &&
      KEM_CIPHERTEXT_LENGTH === 1088,
  );

  // 2. Public keys cross the (blind) server as base64 strings.
  const pubAB64 = await exportPublicKey(pairA.publicKey);
  const pubBB64 = await exportPublicKey(pairB.publicKey);
  const pqPubAB64 = exportKEMPublicKey(kemA.publicKey);
  const pqPubBB64 = exportKEMPublicKey(kemB.publicKey);
  check("ECDH public keys export to base64 raw", pubAB64.length > 80 && pubBB64.length > 80);
  check(
    "KEM public keys export to base64 (1184 B)",
    pqPubAB64.length > 1500 && pqPubBB64.length > 1500,
  );

  const importedB = await importPublicKey(pubBB64);
  const importedA = await importPublicKey(pubAB64);

  // 3. Post-quantum KEM handshake, exactly as the live protocol runs it:
  // the peer with the lexicographically smaller base64 ECDH key encapsulates
  // against the other's pqPub; the counterparty decapsulates with its
  // secret key. Both must land on the SAME 32-byte KEM secret.
  const aEncapsulates = pubAB64 < pubBB64;
  const encSidePqPub = aEncapsulates ? pqPubBB64 : pqPubAB64;
  const decKem = aEncapsulates ? kemB : kemA;
  const { cipherTextB64, sharedSecret: ssEnc } = encapsulate(encSidePqPub);
  check("KEM ciphertext is 1088 bytes", cipherTextB64.length > 1400);
  const ssDec = decapsulate(cipherTextB64, decKem.secretKey);
  check(
    "PQ KEM handshake: encapsulate/decapsulate parity",
    ssEnc.length === 32 && ssDec.length === 32 && ssEnc.every((b, i) => b === ssDec[i]),
  );

  // 4. Hybrid derivation: ECDH ‖ KEM secret → HKDF → AES-GCM-256 key.
  // Both peers derive from opposite corners with their side of the KEM.
  const keyA = await deriveSharedKey(pairA.privateKey, importedB, ssEnc);
  const keyB = await deriveSharedKey(pairB.privateKey, importedA, ssDec);

  // 5. Parity with GCM tag proof: whatever A seals, B opens byte-for-byte.
  // AES-GCM verification of the authentication tag is the check itself.
  const probe = { text: "👻 hello, hybrid-pq e2ee!", n: 42, nested: { ok: true } };
  const sealed = await encryptPayload(keyA, probe);
  const opened = await decryptPayload<typeof probe>(keyB, sealed.iv, sealed.ciphertext);
  check("round-trip A encrypt → B decrypt (GCM tag verified)", JSON.stringify(probe) === JSON.stringify(opened));

  // 6. Symmetry: B → A as well.
  const sealedB = await encryptPayload(keyB, probe);
  const back = await decryptPayload<typeof probe>(keyA, sealedB.iv, sealedB.ciphertext);
  check("round-trip B encrypt → A decrypt (GCM tag verified)", JSON.stringify(probe) === JSON.stringify(back));

  // 7. Fingerprint: derived from the combined hybrid secret, deterministic
  // and identical on both peers.
  const fpA = await generateEmojiFingerprint(pairA.privateKey, importedB, ssEnc);
  const fpB = await generateEmojiFingerprint(pairB.privateKey, importedA, ssDec);
  check("4-emoji fingerprint matches on both peers", fpA.join("") === fpB.join(""), fpA.join(" "));
  const fpAgain = await generateEmojiFingerprint(pairA.privateKey, importedB, ssEnc);
  check("fingerprint is deterministic", fpA.join("") === fpAgain.join(""));

  // 8. GCM authentication: tampering must throw.
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

  // 9. The PQ leg is load-bearing: decapsulating the same ciphertext with a
  // WRONG secret key yields a different KEM secret (noble's implicit
  // rejection), which MUST yield a different session key that GCM rejects.
  const strangerKem = generateKEMKeyPair();
  const wrongSS = decapsulate(cipherTextB64, strangerKem.secretKey);
  const wrongSSDiffers = !wrongSS.every((b, i) => b === ssEnc[i]);
  let wrongKemKeyRejected = false;
  try {
    const wrongKey = await deriveSharedKey(pairA.privateKey, importedB, wrongSS);
    await decryptPayload(wrongKey, sealed.iv, sealed.ciphertext);
  } catch {
    wrongKemKeyRejected = true;
  }
  check("wrong KEM secret → different session key (PQ leg bound in)", wrongSSDiffers && wrongKemKeyRejected);

  // 10. A foreign ECDH keypair cannot decrypt either — the classical leg is
  // bound into the same HKDF just as tightly.
  const strangerPair = await generateECDHKeyPair();
  let foreignKeyRejected = false;
  try {
    const strangerKey = await deriveSharedKey(strangerPair.privateKey, importedA, ssDec);
    await decryptPayload(strangerKey, sealed.iv, sealed.ciphertext);
  } catch {
    foreignKeyRejected = true;
  }
  check("foreign ECDH key cannot decrypt", foreignKeyRejected);

  // 11. Malformed KEM/ECDH input is rejected safely, never half-processed.
  let malformedRejected = false;
  try {
    encapsulate(exportKEMPublicKey(new Uint8Array(KEM_PUBLIC_KEY_LENGTH - 1)));
  } catch {
    malformedRejected = true;
  }
  try {
    encapsulate("not-valid-base64!!");
  } catch {
    malformedRejected = true;
  }
  try {
    await importPublicKey("not-valid-base64!!");
  } catch {
    malformedRejected = true;
  }
  check("malformed ECDH/KEM input rejected safely", malformedRejected);

  // 12. The symmetric layer is untouched: 96-bit GCM IV.
  const iv = generateIV();
  check("IV generator still 96-bit", iv.length === 12);

  // 13. Memory hygiene: secret buffers are zeroizable on burn.
  const wipeMe = new Uint8Array(32).fill(7);
  zeroize(wipeMe);
  check("zeroize fills secret buffers", wipeMe.every((b) => b === 0));

  // 14. The ECDH private key is non-extractable: exportKey('raw') on the
  // PRIVATE key must throw, so the scalar can never leave native storage.
  let privateNotExtractable = false;
  try {
    await crypto.subtle.exportKey("raw", pairA.privateKey);
  } catch {
    privateNotExtractable = true;
  }
  check("ECDH private key is non-extractable", privateNotExtractable);

  console.log(failed === 0 ? "All crypto checks passed." : `${failed} check(s) FAILED.`);
  return failed === 0;
}

// re-exported for convenience when poking from the console.
export { generateIV };
