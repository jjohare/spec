// Segwit addresses: bech32 (BIP173) for witness version 0, bech32m (BIP350) for 1 and up.
// The chain's own prefix is params.bech32Hrp ('ts' for the txbt4 siding); an address with
// another prefix still names a script, and the script is what a coin pays, so the caller may
// accept it with a warning rather than refuse it.
const CH = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
const polymod = (v) => { let c = 1; for (const x of v) { const b = c >>> 25; c = ((c & 0x1ffffff) << 5) ^ x; for (let i = 0; i < 5; i++) if ((b >>> i) & 1) c ^= GEN[i]; } return c >>> 0; };
const expand = (hrp) => [...hrp].map((c) => c.charCodeAt(0) >>> 5).concat([0], [...hrp].map((c) => c.charCodeAt(0) & 31));
const CONST = { bech32: 1, bech32m: 0x2bc830a3 };
const convert = (data, from, to, pad) => { let acc = 0, bits = 0; const out = []; const max = (1 << to) - 1; for (const v of data) { acc = (acc << from) | v; bits += from; while (bits >= to) { bits -= to; out.push((acc >>> bits) & max); } } if (pad) { if (bits) out.push((acc << (to - bits)) & max); } else if (bits >= from || ((acc << (to - bits)) & max)) return null; return out; };

/** address -> { hrp, version, program, script } or null */
export function decodeAddress(address) {
  if (typeof address !== 'string' || address.length < 8 || address.length > 90) return null;
  const lower = address.toLowerCase(); if (lower !== address && address.toUpperCase() !== address) return null;
  const pos = lower.lastIndexOf('1'); if (pos < 1 || pos + 7 > lower.length) return null;
  const hrp = lower.slice(0, pos), data = [...lower.slice(pos + 1)].map((c) => CH.indexOf(c)); if (data.includes(-1)) return null;
  const chk = polymod(expand(hrp).concat(data)); const enc = chk === CONST.bech32 ? 'bech32' : chk === CONST.bech32m ? 'bech32m' : null; if (!enc) return null;
  const version = data[0], bytes = convert(data.slice(1, -6), 5, 8, false); if (!bytes || version > 16) return null;
  if ((version === 0) !== (enc === 'bech32')) return null; // v0 must be bech32, v1+ bech32m
  if (bytes.length < 2 || bytes.length > 40 || (version === 0 && bytes.length !== 20 && bytes.length !== 32)) return null;
  const program = Buffer.from(bytes).toString('hex');
  const op = version === 0 ? '00' : (0x50 + version).toString(16); // OP_0 or OP_1..OP_16
  return { hrp, version, program, script: op + bytes.length.toString(16).padStart(2, '0') + program };
}

/** address -> script hex (any prefix), or null */
export function addressToScript(address) { return decodeAddress(address)?.script ?? null; }

/** script hex -> address under hrp, or null if the script is not a witness program */
export function scriptToAddress(script, hrp) {
  const m = /^(00|5[1-9a-f]|60)([0-9a-f]{2})([0-9a-f]+)$/i.exec(script ?? ''); if (!m) return null;
  const version = m[1] === '00' ? 0 : parseInt(m[1], 16) - 0x50, bytes = Buffer.from(m[3], 'hex'); if (bytes.length !== parseInt(m[2], 16)) return null;
  const data = [version, ...convert([...bytes], 8, 5, true)];
  const target = version === 0 ? CONST.bech32 : CONST.bech32m;
  const values = expand(hrp).concat(data, [0, 0, 0, 0, 0, 0]); const mod = polymod(values) ^ target;
  const chk = []; for (let i = 0; i < 6; i++) chk.push((mod >>> (5 * (5 - i))) & 31);
  return hrp + '1' + data.concat(chk).map((v) => CH[v]).join('');
}
