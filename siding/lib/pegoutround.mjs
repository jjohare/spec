// Level 2's peg-out (proposals/level-2.md, step 6): a burn is paid from the k-of-n peg by a PSBT
// round. The payer for a burn (its height mod n, with the same fallback as blocks) funds and signs
// a PSBT from its peg wallet and publishes it as kind 23512, d = the burn's outpoint; each other
// signer checks the PSBT pays exactly that burn from the peg, signs it with its wallet, and answers
// with kind 23513; the payer combines, finalizes, broadcasts and records it. Every signer's wallet
// watches the same descriptor, so all of them see the payment in their history afterwards.
import { pegoutMarkerData } from './parent.mjs';
export const PEGOUT_PSBT_KIND = 23512, PEGOUT_SIGNED_KIND = 23513;
const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

export function makePegoutRound({ parent, fed, pub, key, chain, s, relays, events, publish, subscribe, log = () => {}, proposeAfter = 30, outState, save, verifyEvent }) {
  const n = fed.signers.length, me = fed.signers.indexOf(pub);
  const tag = (ev, t) => ev.tags.find((x) => x[0] === t)?.[1];
  const pending = new Map(); // burn outpoint -> { id, psbt, sigs: Map(pubkey -> psbt), at }
  const proposed = new Map(); // burn outpoint -> at (what I signed or proposed, and when)
  const entitled = (signer, height, at) => { const slot = fed.signers.indexOf(signer); if (slot < 0) return false; const late = Math.floor((at - firstSeen(height)) / 1000 / proposeAfter); return ((slot - (height % n) + n) % n) <= late; };
  const seen = new Map(); const firstSeen = (h) => { if (!seen.has(h)) seen.set(h, Date.now()); return seen.get(h); };
  const send = async (ev) => { const r = await publish({ relays, event: ev }); return Object.values(r).filter((x) => x === 'ok').length; };
  async function burnPays(b) { const { address } = await parent.rpc('decodescript', [b.script]); return { address, btc: (b.value / 1e8).toFixed(8), data: toHex(pegoutMarkerData(chain.id, b.txid)) }; }
  // the PSBT pays this burn and nothing else: one output to its script for its value, the marker, change back to the peg
  async function psbtPaysBurn(psbt, b) {
    const d = await parent.rpc('decodepsbt', [psbt]); const outs = d.tx.vout; const want = await burnPays(b);
    const pay = outs.find((o) => o.scriptPubKey.hex === b.script && Math.round(o.value * 1e8) === b.value); const marker = outs.find((o) => o.scriptPubKey.hex === '6a' + (want.data.length / 2).toString(16).padStart(2, '0') + want.data);
    const others = outs.filter((o) => o !== pay && o !== marker); if (!pay || !marker) return 'does not pay the burn with its marker'; if (others.some((o) => o.scriptPubKey.hex !== fed.challenge)) return 'pays something besides the burn and change to the peg';
    for (const i of d.inputs) { const spk = i.witness_utxo?.scriptPubKey?.hex; if (spk !== fed.challenge) return 'spends something that is not the peg'; }
    return null;
  }
  async function propose(b) {
    const key_ = `${b.txid}:${b.vout}`; const want = await burnPays(b);
    // fee_rate 2: the wallet sizes the fee for the witness it can estimate, but a k-of-n taproot script-path spend carries k signatures,
    // the leaf and a control block, which the estimate undercounts (a 2-of-3 payment came out at 223 sats for 274 vB and failed
    // the 1 sat/vB relay minimum). Twice the chain's minimum leaves room for any k and n this document allows.
    const f = await parent.walletRpc('walletcreatefundedpsbt', [[], [{ [want.address]: want.btc }, { data: want.data }], 0, { fee_rate: 2, changeAddress: (await parent.rpc('decodescript', [fed.challenge])).address }]);
    const mine = await parent.walletRpc('walletprocesspsbt', [f.psbt]);
    const ev = events.signEvent(key, { kind: PEGOUT_PSBT_KIND, tags: [['chain', chain.id], ['d', key_], ['h', String(b.height)]], content: mine.psbt });
    pending.set(key_, { id: ev.id, psbt: mine.psbt, sigs: new Map([[pub, mine.psbt]]), at: Date.now(), burn: b }); proposed.set(key_, Date.now());
    const okc = await send(ev); log(`peg-out round: proposed payment of ${key_.slice(0, 16)}… (${b.value} sats) to ${okc} relay(s)`);
    await maybeFinish(key_);
  }
  async function onProposal(ev) {
    const key_ = tag(ev, 'd') ?? ''; if (ev.pubkey === pub || !fed.signers.includes(ev.pubkey)) return;
    const b = s.pegouts().find((x) => `${x.txid}:${x.vout}` === key_); if (!b) return log(`peg-out round: proposal for ${key_.slice(0, 16)}… ignored: not a burn I know`);
    if (outState.paid[key_]) return; if (proposed.has(key_) && Date.now() - proposed.get(key_) < proposeAfter * 1000) return;
    if (!entitled(ev.pubkey, b.height, ev.created_at * 1000)) return log(`peg-out round: ${ev.pubkey.slice(0, 8)}… is not the payer for ${key_.slice(0, 16)}… yet`);
    const why = await psbtPaysBurn(ev.content, b); if (why) return log(`peg-out round: proposal for ${key_.slice(0, 16)}… refused: ${why}`);
    const mine = await parent.walletRpc('walletprocesspsbt', [ev.content]); proposed.set(key_, Date.now());
    const pev = events.signEvent(key, { kind: PEGOUT_SIGNED_KIND, tags: [['chain', chain.id], ['d', key_], ['e', ev.id]], content: mine.psbt });
    const okc = await send(pev); log(`peg-out round: signed payment of ${key_.slice(0, 16)}… proposed by ${ev.pubkey.slice(0, 8)}… to ${okc} relay(s)`);
  }
  async function onSigned(ev) {
    const key_ = tag(ev, 'd') ?? ''; const p = pending.get(key_); if (!p || tag(ev, 'e') !== p.id || ev.pubkey === pub || !fed.signers.includes(ev.pubkey)) return;
    p.sigs.set(ev.pubkey, ev.content); log(`peg-out round: ${p.sigs.size}/${fed.threshold} signatures for ${key_.slice(0, 16)}…`); await maybeFinish(key_);
  }
  async function maybeFinish(key_) {
    const p = pending.get(key_); if (!p || p.sigs.size < fed.threshold) return;
    const combined = await parent.rpc('combinepsbt', [[...p.sigs.values()]]); const fin = await parent.rpc('finalizepsbt', [combined]);
    if (!fin.complete) return log(`peg-out round: ${key_.slice(0, 16)}… has ${p.sigs.size} signatures but does not finalize`);
    const txid = await parent.rpc('sendrawtransaction', [fin.hex]); pending.delete(key_); const b = p.burn; const { address } = await burnPays(b);
    outState.paid[key_] = { parentTxid: txid, address, value: b.value, script: b.script, height: b.height, at: Math.floor(Date.now() / 1000), signers: [...p.sigs.keys()] }; await save();
    log(`peg-out ${key_.slice(0, 16)}…: paid ${b.value} sats to ${address} on the parent by ${p.sigs.size} of ${n}, txid ${txid.slice(0, 16)}…`);
  }
  const subs = [PEGOUT_PSBT_KIND, PEGOUT_SIGNED_KIND].map((kind) => subscribe({ relays, chainId: chain.id, verify: verifyEvent, log: () => {}, kind, since: 600, onEvent: (ev) => (kind === PEGOUT_PSBT_KIND ? onProposal(ev) : onSigned(ev)).catch((e) => log(`peg-out round: ${e.message}`)) }));
  return {
    async tick() {
      for (const b of s.pegouts()) { const key_ = `${b.txid}:${b.vout}`; if (outState.paid[key_] || pending.has(key_)) continue; if (proposed.has(key_) && Date.now() - proposed.get(key_) < proposeAfter * 1000 * n) continue;
        if (entitled(pub, b.height, Date.now())) { try { await propose(b); } catch (e) { log(`peg-out round: ${e.message}`); proposed.set(key_, Date.now()); } } }
      for (const [k, p] of pending) if (Date.now() - p.at > proposeAfter * 1000 * n) { pending.delete(k); log(`peg-out round: dropping my proposal for ${k.slice(0, 16)}… (${p.sigs.size} signature(s))`); }
    },
    close() { for (const x of subs) x.close(); },
  };
}
