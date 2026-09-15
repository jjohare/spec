// BIP-340 signing on the engine's curve (verify-only secp256k1 plus its point derivation), the
// same construction datstr uses for Nostr events. Keys are 32-byte hex files, never arguments.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';

export function makeSigner({ hash, secp }) {
  const { taggedHash, hexToBytes, bytesToHex } = hash; const { publicKeyFromPrivate, N } = secp;
  const big = (b) => b.reduce((a, x) => (a << 8n) | BigInt(x), 0n);
  const bytes32 = (n) => { const out = new Uint8Array(32); for (let i = 31; i >= 0; i--) { out[i] = Number(n & 0xffn); n >>= 8n; } return out; };
  const cat = (...a) => { const out = new Uint8Array(a.reduce((s, x) => s + x.length, 0)); let p = 0; for (const x of a) { out.set(x, p); p += x.length; } return out; };
  const pubkeyOf = (privHex) => bytesToHex(publicKeyFromPrivate(hexToBytes(privHex)).slice(1));
  function schnorrSign(msg32, privHex, aux = crypto.getRandomValues(new Uint8Array(32))) {
    let d = big(hexToBytes(privHex)); const P = publicKeyFromPrivate(bytes32(d)); if (!P) throw new Error('bad private key');
    if (P[0] === 0x03) d = N - d; const px = P.slice(1);
    const t = bytes32(d ^ big(taggedHash('BIP0340/aux', aux)));
    let kk = big(taggedHash('BIP0340/nonce', cat(t, px, msg32))) % N; if (kk === 0n) throw new Error('zero nonce');
    const R = publicKeyFromPrivate(bytes32(kk)); if (R[0] === 0x03) kk = N - kk;
    const e = big(taggedHash('BIP0340/challenge', cat(R.slice(1), px, msg32))) % N;
    return cat(R.slice(1), bytes32((kk + e * d) % N));
  }
  return { pubkeyOf, schnorrSign, randomKey: () => bytesToHex(crypto.getRandomValues(new Uint8Array(32))) };
}

export async function loadKey(path, { create = false, signer } = {}) {
  if (existsSync(path)) return (await readFile(path, 'utf8')).trim();
  if (!create) throw new Error(`no key at ${path} (run: siding key --create)`);
  const key = signer.randomKey(); await mkdir(dirname(path), { recursive: true }); await writeFile(path, key + '\n', { mode: 0o600 }); return key;
}
