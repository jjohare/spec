// Checkpoints (SPEC 11): the producer writes its tip into the parent now and then — one
// OP_RETURN, `ckpt:<chain id>:` then the height as 4 bytes little-endian, `:`, then the 32-byte
// block hash — so the parent's proof of work vouches that the chain's history up to that block
// existed before the parent block carrying it. 58 bytes for a 15-byte chain id. Pure helpers plus
// the parent-side send and scan; the producer keeps checkpoints.json beside the block file.
const enc = new TextEncoder();
const fromHex = (h) => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
export function checkpointData(chainId, height, hash) {
  const head = enc.encode(`ckpt:${chainId}:`); const out = new Uint8Array(head.length + 4 + 1 + 32); out.set(head);
  const h = height >>> 0; out.set([h & 255, (h >>> 8) & 255, (h >>> 16) & 255, (h >>> 24) & 255], head.length); out[head.length + 4] = 0x3a; out.set(fromHex(hash), head.length + 5);
  if (out.length > 80) throw new Error(`checkpoint of ${out.length} bytes exceeds the 80-byte data limit; the chain id is too long`);
  return out;
}
export function parseCheckpoint(spkHex, chainId) {
  const m = /^6a(?:4c)?([0-9a-f]{2})([0-9a-f]*)$/i.exec(spkHex); if (!m) return null; const b = fromHex(m[2]); if (parseInt(m[1], 16) !== b.length) return null;
  const head = enc.encode(`ckpt:${chainId}:`); if (b.length !== head.length + 37) return null; for (let i = 0; i < head.length; i++) if (b[i] !== head[i]) return null; if (b[head.length + 4] !== 0x3a) return null;
  const height = (b[head.length] | (b[head.length + 1] << 8) | (b[head.length + 2] << 16) | (b[head.length + 3] << 24)) >>> 0;
  return { height, hash: toHex(b.subarray(head.length + 5)) };
}
// one parent transaction from the peg wallet: the data output, change back
export async function sendCheckpoint(parent, { chainId, height, hash }) {
  if (!parent.walletRpc) throw new Error('no peg wallet: start with --parent-wallet <name>');
  const r = await parent.walletRpc('send', [[{ data: toHex(checkpointData(chainId, height, hash)) }], null, 'unset', 1]);
  if (!r?.complete || !r.txid) throw new Error(`send did not complete: ${JSON.stringify(r).slice(0, 200)}`);
  return { parentTxid: r.txid };
}
// where a checkpoint transaction sits now: parent block height and confirmations, or unconfirmed
export async function checkpointStatus(parent, parentTxid) {
  const g = await parent.walletRpc('gettransaction', [parentTxid]); return { confirmations: g.confirmations ?? 0, parentHeight: g.blockheight ?? null, parentBlock: g.blockhash ?? null, time: g.blocktime ?? null };
}
// the checkpoints the peg wallet has already sent, from its own history: `${height}:${hash}` -> parent txid
export async function sentCheckpoints(parent, { chainId }) {
  const out = new Map(); if (!parent.walletRpc) return out; const seen = new Set(); const list = await parent.walletRpc('listtransactions', ['*', 10000, 0, true]);
  for (const t of list) { if (t.category !== 'send' || seen.has(t.txid)) continue; seen.add(t.txid); const g = await parent.walletRpc('gettransaction', [t.txid, true, true]);
    for (const o of g.decoded?.vout ?? []) { const c = parseCheckpoint(o.scriptPubKey?.hex ?? '', chainId); if (c) out.set(`${c.height}:${c.hash}`, t.txid); } }
  return out;
}
