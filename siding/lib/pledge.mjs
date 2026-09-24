// The desk (SPEC 6.2): a coinbase reward locked on the parent is pledged with a pre-signed
// maturity transaction — it spends the reward to the chain's peg address, with a peg-in marker
// naming the pledger's sidechain script, and is valid only from the maturity height. The desk
// verifies it now, pays a rate now, and broadcasts it when the height arrives. Pure: browsers
// and Node alike; the parent's kernel comes from the caller (parentKernel below builds one).
import { pegMarkerData } from './marker.mjs';
import { resolveParent } from './parents.mjs';
import { signKeyPath } from './txsign.mjs';
export const PLEDGE_KIND = 33502; // addressable, d = <parent txid>:<vout>
const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

// a kernel for the parent network, from a schema checkout or CDN
// `parent` is an alias or long id from SPEC 3.2; the BLAKE2b overlay is loaded only for a BLAKE2b parent
export async function parentKernel({ cdn, parent, loadJson = async (u) => (await fetch(u)).json() }) {
  const p = resolveParent(parent); const { createKernel } = await import(`${cdn}/codec/kernel.js`);
  const j = (q) => loadJson(`${cdn}/${q}`); const overlays = [];
  if (p.family === 'blake2b') { const { knotsBlake2b } = await import(`${cdn}/codec/overlays/knots-blake2b.js`); overlays.push(knotsBlake2b(await j('schema/overlays/knots-blake2b.jsonld'))); }
  return createKernel({ core: await j('schema/core.jsonld'), proof: await j('schema/proof.jsonld'), script: await j('schema/script.jsonld'), chain: await j('schema/chain.jsonld'), validate: await j('schema/validate.jsonld'),
    network: p.network, overlays });
}
// the maturity of a coinbase at `height` under the parent's long-maturity rule (PR 419) or the classic 100
export function maturityOf(height, policy) { return height >= policy.lockedFrom ? policy.maturity : height + 100; }
export const markerScript = (chainId, payeeScript) => { const d = pegMarkerData(chainId, payeeScript); return '6a' + d.length.toString(16).padStart(2, '0') + toHex(d); };

// the pre-signed maturity transaction: one input (the reward), one output to the peg, the marker
export function buildPledge({ k, hash, signer, SIGHASH_UNIFIED, key, chain, reward, payeeScript }) {
  const p = chain.pledge; if (!p) throw new Error(`${chain.id} has no desk`); const pub = signer.pubkeyOf(key); const mine = '5120' + pub;
  if (reward.script !== mine) throw new Error(`this key does not own the reward (its script is ${reward.script.slice(0, 12)}…, the key's is ${mine.slice(0, 12)}…)`);
  const fee = p.fee ?? 1000; if (!(reward.value > fee)) throw new Error('reward too small');
  const tx = { version: 2, inputs: [{ prevout: { txid: reward.txid, vout: reward.vout }, scriptSig: '', sequence: 0xfffffffe }], outputs: [{ value: reward.value - fee, scriptPubKey: p.pegScript }, { value: 0, scriptPubKey: markerScript(chain.id, payeeScript) }], lockTime: maturityOf(reward.height, p), witness: [] };
  signKeyPath({ k, hash, signer }, tx, [{ value: reward.value, scriptPubKey: reward.script }], key); // the parent's sighash family (SPEC 3)
  return { tx, hex: k.codec.encodeHex('Transaction', tx), txid: k.codec.txid(tx), lockTime: tx.lockTime, amount: reward.value, pays: Math.floor(reward.value * p.rate) };
}
// what the desk checks before paying: `prevout` is the reward as the parent reports it now
export function verifyPledge({ k, hex, chain, prevout, parentTip }) {
  const p = chain.pledge; const bad = (error) => ({ ok: false, error });
  let tx; try { tx = k.codec.decode('Transaction', hex); } catch { return bad('not a transaction'); }
  if (tx.inputs.length !== 1 || tx.outputs.length !== 2) return bad('a pledge has one input and two outputs');
  if (!prevout) return bad('the reward is not an unspent output on the parent'); if (!prevout.coinbase) return bad('the output is not a coinbase reward'); if (prevout.height < p.lockedFrom) return bad(`the reward at height ${prevout.height} is not locked (locked from ${p.lockedFrom})`);
  const maturity = maturityOf(prevout.height, p); if (parentTip >= maturity) return bad('the reward is already mature: peg it in');
  if (tx.lockTime !== maturity) return bad(`lock time ${tx.lockTime} is not the maturity height ${maturity}`); if (tx.inputs[0].sequence === 0xffffffff) return bad('the input must not be final (sequence)');
  if (tx.outputs[0].scriptPubKey !== p.pegScript) return bad('output 0 does not pay the peg'); const fee = prevout.value - tx.outputs[0].value; if (!(fee >= 100 && fee <= 100000)) return bad(`fee ${fee} is outside 100..100000 sats`);
  const marker = tx.outputs[1].scriptPubKey; const m = /^6a([0-9a-f]{2})([0-9a-f]+)$/.exec(marker); if (!m) return bad('output 1 is not the marker');
  const data = Uint8Array.from(m[2].match(/../g), (x) => parseInt(x, 16)); const head = new TextEncoder().encode(`pegin:${chain.id}:`); if (data.length !== head.length + 34 || !head.every((b, i) => data[i] === b)) return bad('the marker does not name this chain and a 34-byte script');
  const payee = toHex(data.subarray(head.length)); if (!/^5120[0-9a-f]{64}$/.test(payee)) return bad('the payee is not a key-path script');
  if (prevout.value > (p.maxPerPledge ?? Infinity)) return bad(`the reward exceeds the desk's maximum per pledge (${p.maxPerPledge})`);
  const v = k.interpreter.verifyInput(tx, 0, { value: prevout.value, scriptPubKey: prevout.script }, [{ value: prevout.value, scriptPubKey: prevout.script }], null, { unifiedSighash: true }); if (v.ok !== true) return bad(`signature: ${v.error ?? v.reason ?? 'invalid'}`);
  return { ok: true, txid: k.codec.txid(tx), amount: prevout.value, payee, maturity, pays: Math.floor(prevout.value * p.rate), fee };
}
