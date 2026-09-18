// Level 2's round (proposals/level-2.md): the proposer for a height builds the block and publishes
// it as a kind 23510 event; each other signer checks it against its own chain and mempool and
// answers with a kind 23511 partial signature; with k the proposer seals the block, adds it,
// publishes it as a kind 23514 event for the others and announces it. Signer keys are Nostr keys,
// so an event's author is the signer. One signature per height per signer, ever.
import { partialSignature, verifyPartial, sealFederated } from './federation.mjs';
export const PROPOSAL_KIND = 23510, PARTIAL_KIND = 23511, SEALED_KIND = 23514;

export function makeRound({ engine, s, chain, fed, key, pub, relays, events, publish, subscribe, log = () => {}, proposeAfter = 30, onBlock = () => {} }) {
  const E = { ...engine, interpreter: engine.k.interpreter, schnorrSign: (m, k) => engine.signer.schnorrSign(m, k), secp: engine.secp };
  const n = fed.signers.length, me = fed.signers.indexOf(pub); if (me < 0) throw new Error('this key is not one of the signers');
  const tag = (ev, t) => ev.tags.find((x) => x[0] === t)?.[1];
  let pending = null;            // my proposal in flight: { id, height, block, sigs: Map, at }
  // height -> { id, at } of the proposal I signed. One signature per height — unless that proposal has
  // had proposeAfter seconds to seal and has not: then a later, entitled proposer may have mine too,
  // or a stalled height (its proposer gone after collecting fewer than k) would never move.
  const signed = new Map();
  const mayReSign = (height) => { const prev = signed.get(height); return !prev || Date.now() - prev.at > proposeAfter * 1000; };
  let lastBlockAt = Date.now(), lastHeightSeen = s.height(); let claimsWanted = [];
  const entitled = (signer, height, at) => { const slot = fed.signers.indexOf(signer); if (slot < 0) return false; const turn = height % n; const late = Math.floor((at - lastBlockAt) / 1000 / proposeAfter); return ((slot - turn + n) % n) <= late; };
  const send = async (ev) => { const r = await publish({ relays, event: ev }); return Object.values(r).filter((x) => x === 'ok').length; };
  async function propose(opts = {}) {
    const { block, fees, claims } = s.buildNext({ ...opts, claims: opts.claims ?? claimsWanted }); const height = block.header.height; const hex = engine.k.codec.encodeHex('Block', block);
    const ev = events.signEvent(key, { kind: PROPOSAL_KIND, tags: [['chain', chain.id], ['h', String(height)]], content: hex });
    pending = { id: ev.id, height, block, sigs: new Map([[pub, partialSignature(E, block, fed, key)]]), at: Date.now(), fees, claims };
    signed.set(height, { id: ev.id, at: Date.now() });
    const okc = await send(ev); log(`round: proposed h${height} ${ev.id.slice(0, 12)}… (${block.transactions.length - 1} txs, ${claims} claim(s)) to ${okc} relay(s)`);
    await maybeSeal();
  }
  async function onProposal(ev) {
    const height = Number(tag(ev, 'h')); if (!Number.isInteger(height) || ev.pubkey === pub) return;
    if (height !== s.height() + 1) return log(`round: proposal h${height} from ${ev.pubkey.slice(0, 8)}… ignored (my tip is ${s.height()})`);
    if (!entitled(ev.pubkey, height, ev.created_at * 1000)) return log(`round: proposal h${height} from ${ev.pubkey.slice(0, 8)}… refused: not its turn`);
    if (!mayReSign(height)) return log(`round: proposal h${height} from ${ev.pubkey.slice(0, 8)}… refused: I signed ${signed.get(height).id.slice(0, 8)}… for this height ${Math.round((Date.now() - signed.get(height).at) / 1000)} s ago`);
    let block; try { block = engine.k.codec.decode('Block', ev.content); } catch { return log('round: proposal is not a block'); }
    const tip = s.tip(); if (block.header.prevBlockHash !== tip.hash || block.header.time <= tip.time) return log(`round: proposal h${height} refused: does not build on my tip`);
    // every transaction must be one my mempool accepts (or already holds): the same checks a producer makes
    for (const tx of block.transactions.slice(1)) { const txid = engine.k.codec.txid(tx); if (s.mempool.has(txid)) continue; try { s.submit(engine.k.codec.encodeHex('Transaction', tx)); } catch (e) { return log(`round: proposal h${height} refused: tx ${txid.slice(0, 12)}… ${e.message}`); } }
    const sig = partialSignature(E, block, fed, key); signed.set(height, { id: ev.id, at: Date.now() });
    const pev = events.signEvent(key, { kind: PARTIAL_KIND, tags: [['chain', chain.id], ['h', String(height)], ['e', ev.id]], content: sig });
    const okc = await send(pev); log(`round: signed h${height} ${ev.id.slice(0, 12)}… from ${ev.pubkey.slice(0, 8)}… to ${okc} relay(s)`);
  }
  async function onPartial(ev) {
    if (!pending || tag(ev, 'e') !== pending.id || ev.pubkey === pub) return;
    if (!fed.signers.includes(ev.pubkey)) return; if (!verifyPartial(E, pending.block, fed, ev.pubkey, String(ev.content).trim())) return log(`round: bad partial from ${ev.pubkey.slice(0, 8)}…`);
    pending.sigs.set(ev.pubkey, String(ev.content).trim()); log(`round: ${pending.sigs.size}/${fed.threshold} signatures for h${pending.height}`);
    await maybeSeal();
  }
  async function maybeSeal() {
    if (!pending || pending.sigs.size < fed.threshold) return;
    const sealed = sealFederated(E, pending.block, fed, pending.sigs); const p = pending; pending = null;
    try { const r = s.addSealed(sealed); lastBlockAt = Date.now(); lastHeightSeen = r.height; claimsWanted = []; log(`block ${r.height} ${r.hash.slice(0, 16)}… sealed by ${fed.threshold} of ${n}, ${r.txs - 1} txs, fees ${p.fees}${p.claims ? `, claims ${p.claims}` : ''}`);
      const ev = events.signEvent(key, { kind: SEALED_KIND, tags: [['chain', chain.id], ['h', String(r.height)]], content: engine.k.codec.encodeHex('Block', sealed) }); await send(ev); onBlock(r);
    } catch (e) { log(`round: sealed block refused by my own validator: ${e.message}`); }
  }
  async function onSealed(ev) {
    const height = Number(tag(ev, 'h')); if (ev.pubkey === pub || !fed.signers.includes(ev.pubkey) || height !== s.height() + 1) return;
    try { const r = s.addSealed(engine.k.codec.decode('Block', ev.content)); lastBlockAt = Date.now(); lastHeightSeen = r.height; if (pending && pending.height <= r.height) pending = null; log(`block ${r.height} ${r.hash.slice(0, 16)}… from ${ev.pubkey.slice(0, 8)}… (sealed by the federation)`); onBlock(r); }
    catch (e) { log(`round: sealed block h${height} from ${ev.pubkey.slice(0, 8)}… refused: ${e.message}`); }
  }
  const subs = [PROPOSAL_KIND, PARTIAL_KIND, SEALED_KIND].map((kind) => subscribe({ relays, chainId: chain.id, verify: engine.nostr.verifyNostrEvent, log: () => {}, kind, since: 600, onEvent: (ev) => (kind === PROPOSAL_KIND ? onProposal(ev) : kind === PARTIAL_KIND ? onPartial(ev) : onSealed(ev)).catch((e) => log(`round: ${e.message}`)) }));
  return {
    // called every second by the producer: propose when it is my turn and a block is due
    async tick({ due }) {
      if (pending) { if (Date.now() - pending.at > proposeAfter * 1000 * n) { log(`round: my proposal h${pending.height} got ${pending.sigs.size} signature(s); dropping it`); pending = null; } return; }
      if (!due) return; const height = s.height() + 1; if (!mayReSign(height)) return;
      if (entitled(pub, height, Date.now())) await propose();
    },
    wantClaims(claims) { claimsWanted = claims; },
    get pending() { return pending; }, close() { for (const x of subs) x.close(); },
  };
}
