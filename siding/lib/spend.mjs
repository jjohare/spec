// Spend from a key's coins as the producer reports them (SPEC 11): the same key-path,
// unified-sighash transaction the wallet builds, with the fee sized at the chain's minimum
// rate unless one is given. Node only (reads the schema from disk); the CLI and the faucet share it.
import { homedir } from 'node:os';
import { signKeyPath } from './txsign.mjs';
import { decodeAddress, scriptToAddress } from './address.mjs';
import { makeEvents, publish } from './relay.mjs';
import { pegoutMarker } from './overlay.mjs';
import { depositScript } from './overlays/evm.mjs';

// --to is a script hex or a segwit address under any prefix: the script is what is paid
export function resolveTo(to, hrp) {
  if (/^[0-9a-f]+$/i.test(to ?? '')) return { script: to.toLowerCase(), note: null };
  const a = decodeAddress(to ?? ''); if (!a) throw new Error(`bad address ${to}`);
  return { script: a.script, note: a.hrp === hrp ? null : `${String(to).slice(0, 12)}… carries prefix '${a.hrp}', this chain's is '${hrp}' (${scriptToAddress(a.script, hrp)}); paying its script` };
}

// pegout: `to` is a parent address (or script); the amount is burned to `pegout:<script>` and the
// peg holders pay it on the parent (SPEC 7)
// evmDeposit: `to` is a 0x address; the amount pays the chain's reserve and the marker credits the address at 1 sat = 1 gwei
export async function buildSpend({ engine, chain, signer, key, url, to, amount, fee = null, pegout = false, evmDeposit = false }) {
  const k = engine.k, pub = signer.pubkeyOf(key), spk = '5120' + pub, base = url.replace(/\/$/, ''), rate = Number(chain.minFeeRate ?? 1);
  if (evmDeposit && !/^0x[0-9a-fA-F]{40}$/.test(String(to))) throw new Error('an EVM deposit goes to a 0x address');
  const dest = evmDeposit ? { script: (chain.evm?.reserve ?? chain.challenge).toLowerCase(), note: `deposit: ${amount} sats to the reserve, credited as ${amount} gwei to ${to} in the EVM`, marker: depositScript(String(to)) } : pegout ? { script: pegoutMarker(resolveTo(to, k.params.bech32Hrp).script), note: `peg-out: ${amount} sats burn here and are owed to ${to} on ${chain.parent} (at least ${chain.pegoutMin ?? 10000})` } : resolveTo(to, k.params.bech32Hrp);
  amount = Number(amount); if (!Number.isInteger(amount) || amount <= 0) throw new Error('the amount is a whole number of sats'); if (pegout && amount < Number(chain.pegoutMin ?? 10000)) throw new Error(`a peg-out burns at least ${chain.pegoutMin ?? 10000} sats`);
  const tip = await (await fetch(`${base}/tip`)).json();
  const coins = (await (await fetch(`${base}/coins/${spk}`)).json()).filter((c) => !c.coinbase || tip.height + 1 - c.height >= k.params.coinbaseMaturity).sort((a, b) => b.value - a.value);
  const bound = fee ?? Math.ceil(rate * 200); const picked = []; let sum = 0; for (const c of coins) { picked.push(c); sum += c.value; if (sum >= amount + bound) break; }
  if (sum < amount + bound) throw new Error(`insufficient: ${sum} sats mature, ${amount + bound} needed`);
  const lay = (f) => { const change = sum - amount - f; return [{ value: amount, scriptPubKey: dest.script }, ...(dest.marker ? [{ value: 0, scriptPubKey: dest.marker }] : []), ...(change > 0 ? [{ value: change, scriptPubKey: spk }] : [])]; };
  const tx = { version: 2, inputs: picked.map((c) => ({ prevout: { txid: c.outpoint.split(':')[0], vout: Number(c.outpoint.split(':')[1]) }, scriptSig: '', sequence: 0xfffffffd })), outputs: lay(fee ?? 0), lockTime: 0, witness: [] };
  if (fee == null) { const sized = { ...tx, witness: tx.inputs.map(() => ['00'.repeat(65)]) }; fee = Math.ceil(Math.ceil(k.codec.txWeight(sized) / 4) * rate); tx.outputs = lay(fee); if (sum - amount - fee < 0) throw new Error(`insufficient coins for ${amount} plus the ${fee}-sat minimum fee`); }
  const prevouts = picked.map((c) => ({ value: c.value, scriptPubKey: spk }));
  signKeyPath({ k, hash: engine.hash, signer }, tx, prevouts, key); // the sighash follows the parent's family (SPEC 3)
  return { tx, hex: k.codec.encodeHex('Transaction', tx), txid: k.codec.txid(tx), inputs: picked.length, amount, fee, vsize: Math.ceil(k.codec.txWeight(tx) / 4), change: sum - amount - fee, note: dest.note };
}

// to the relays as a kind 23500 event if any are given (falling back to the producer's /tx when
// none accepts), else straight to /tx. Returns what each path said.
export async function deliver({ engine, chain, signer, hex, relays = [], url }) {
  if (relays.length) { const ev = makeEvents({ signer, hash: engine.hash }).txEvent(signer.randomKey(), chain.id, hex); const results = await publish({ relays, event: ev }); if (Object.values(results).some((r) => r === 'ok')) return { via: 'relay', event: ev.id, relays: results }; if (!url) return { via: 'relay', event: ev.id, relays: results, error: 'no relay accepted the event' }; }
  const r = await (await fetch(`${url.replace(/\/$/, '')}/tx`, { method: 'POST', body: hex })).json(); return { via: 'producer', ...r };
}
