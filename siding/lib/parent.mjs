// The parent chain as a signer sees it (SPEC 6, level 2 view): a Bitcoin-style RPC with txindex.
// Finds peg-ins for this chain, tells whether one is still unspent and how deep it is.
// Node only: reads the RPC cookie from a file. Keys never appear on a command line.
import { readFile } from 'node:fs/promises';
const enc = new TextEncoder(), dec = new TextDecoder();
const fromHex = (h) => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

export async function makeParent({ url, cookieFile }) {
  const auth = 'Basic ' + Buffer.from((await readFile(cookieFile, 'utf8')).trim()).toString('base64');
  const rpc = async (method, params = []) => {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'text/plain', authorization: auth }, body: JSON.stringify({ jsonrpc: '1.0', id: 'siding', method, params }) });
    const j = await r.json(); if (j.error) throw new Error(`${method}: ${j.error.message}`); return j.result;
  };
  return { rpc, height: () => rpc('getblockcount') };
}

// The marker: `pegin:<chain id>:` then the sidechain output script, as raw bytes (61 bytes for a
// taproot script, inside the 80-byte OP_RETURN policy limit) or, as the spec's text shows it, hex.
export function pegMarkerData(chainId, script) { return enc.encode(`pegin:${chainId}:`).length + script.length / 2 <= 80 ? new Uint8Array([...enc.encode(`pegin:${chainId}:`), ...fromHex(script)]) : enc.encode(`pegin:${chainId}:${script}`); }
export function parsePegMarker(spkHex, chainId) {
  const m = /^6a(?:4c)?([0-9a-f]{2})([0-9a-f]*)$/i.exec(spkHex); if (!m) return null; const d = fromHex(m[2]); if (parseInt(m[1], 16) !== d.length) return null;
  const prefix = enc.encode(`pegin:${chainId}:`); if (d.length <= prefix.length) return null;
  for (let i = 0; i < prefix.length; i++) if (d[i] !== prefix[i]) return null;
  const rest = d.slice(prefix.length); const asText = dec.decode(rest);
  if (/^([0-9a-f]{2})+$/i.test(asText)) return asText.toLowerCase(); // hex form
  return toHex(rest);                                                 // raw form
}

// Peg-ins in the parent's blocks [from, to]: a transaction with our marker; its peg output is the
// first taproot output that is not the marker. Amounts in sats.
export async function scanPegins(parent, { chainId, from, to, onBlock = () => {} }) {
  const found = [];
  for (let h = from; h <= to; h++) {
    const block = await parent.rpc('getblock', [await parent.rpc('getblockhash', [h]), 2]); onBlock(h);
    for (const tx of block.tx) {
      let script = null; for (const o of tx.vout) { const s = parsePegMarker(o.scriptPubKey.hex, chainId); if (s) { script = s; break; } }
      if (!script) continue;
      const peg = tx.vout.find((o) => o.scriptPubKey.type === 'witness_v1_taproot'); if (!peg) continue;
      found.push({ txid: tx.txid, vout: peg.n, amount: Math.round(peg.value * 1e8), script, height: h, parentAddress: peg.scriptPubKey.address ?? null });
    }
  }
  return found;
}

// still unspent on the parent, and how many confirmations it has (null if spent or unknown)
export async function pegStatus(parent, { txid, vout }) {
  const o = await parent.rpc('gettxout', [txid, vout, true]); if (!o) return { unspent: false, confirmations: null };
  return { unspent: true, confirmations: o.confirmations };
}
