// A sidestr chain on disk: genesis from the chain document, a block file in blaketestnode's
// format, the UTXO set replayed from it, a mempool, and block production (SPEC 4, 5, 11).
import { BLAKETESTNODE } from './engine.mjs';
import { buildBlock, signBlock } from './block.mjs';
import { claimMarker, outpointOf, parsePegout, parsePegouts } from './overlay.mjs';
const { ChainNode } = await import(`${BLAKETESTNODE}/lib/node.mjs`);
const { readIndex, writeIndex, appendBlock, readBlock } = await import(`${BLAKETESTNODE}/lib/blockfile.mjs`);

const NULL32 = '00'.repeat(32);
const keyOf = (p) => `${p.txid}:${p.vout}`;

export class Siding {
  constructor({ engine, chain, dir, signer, log = () => {} }) {
    Object.assign(this, { engine, chain, dir, signer, log });
    const { k } = engine; this.k = k;
    this.utxo = new Map(); this.node = new ChainNode({ k, utxo: this.utxo, epochStart: 0, log });
    this.mempool = new Map(); this.mempoolSpent = new Set();
    this.dat = `${dir}/blocks.dat`; this.idx = `${dir}/blocks.json`;
    this.bits = k.headers.compactFromTarget(BigInt('0x' + chain.powLimit));
  }
  // SPEC 5: the genesis block mints the pegs, deterministically (zero aux), at the document's time
  genesisBlock(privHex) {
    const outputs = this.chain.pegs.map((p) => ({ value: p.amount, scriptPubKey: p.script }));
    const b = buildBlock(this.engine, { height: 0, prev: NULL32, time: this.chain.genesisTime, transactions: [], outputs, bits: this.bits, marker: `sidestr genesis ${this.chain.id}` });
    return signBlock({ ...this.engine, interpreter: this.k.interpreter, schnorrSign: (m, key) => this.signer.schnorrSign(m, key, new Uint8Array(32)) }, b, this.chain.challenge, privHex);
  }
  // replay the block file, creating it with the genesis when absent
  async open(privHex) {
    let index = readIndex(this.idx);
    if (!index) {
      if (!privHex) throw new Error('no chain on disk and no key to make the genesis');
      const g = this.genesisBlock(privHex); const hex = this.k.codec.encodeHex('Block', g); const hash = this.k.codec.blockHash(g.header);
      index = { network: this.chain.id, from: 0, to: -1, blocks: [] };
      appendBlock(this.dat, index, 0, hash, Buffer.from(hex, 'hex')); writeIndex(this.idx, index);
      this.log(`genesis ${hash} written: ${g.transactions[0].outputs.length - 1} pegs, ${this.chain.pegs.reduce((s, p) => s + p.amount, 0)} sats`);
    }
    for (const e of index.blocks) this.#apply(e.height, readBlock(this.dat, e).toString('hex'), e.hash);
    this.index = index;
    return this;
  }
  #apply(h, hex, expectHash) {
    if (h === 0) {
      const g = this.k.codec.decode('Block', hex); const hash = this.k.codec.blockHash(g.header);
      if (hash !== expectHash) throw new Error('genesis hash mismatch'); if (this.chain.genesisHash && hash !== this.chain.genesisHash) throw new Error(`genesis ${hash} is not the document's ${this.chain.genesisHash}`);
      this.node.headers[0] = g.header; this.node.chain[0] = hash; this.k.blocks.applyBlock(this.utxo, g, 0); this.node.setBase(0, hash); this.genesisHash = hash; return { hash };
    }
    const r = this.node.applyNext(h, hex); if (expectHash && r.hash !== expectHash) throw new Error(`block ${h} hash ${r.hash} is not ${expectHash}`);
    for (const key of [...this.mempool.keys()]) if (!this.#stillValid(this.mempool.get(key))) { this.mempool.delete(key); }
    this.mempoolSpent = new Set([...this.mempool.values()].flatMap((tx) => tx.inputs.map((i) => keyOf(i.prevout))));
    return r;
  }
  #stillValid(tx) { return tx.inputs.every((i) => this.utxo.has(keyOf(i.prevout))); }
  tip() { const h = this.node.height; return { height: h, hash: this.node.chain[h], time: this.node.headers[h].time }; }
  height() { return this.node.height; }
  // accept a block from elsewhere (a mirror): validated by the node, then written
  addBlock(hex, expectHash = null) {
    const block = this.k.codec.decode('Block', hex); const h = block.header.height;
    const r = this.#apply(h, hex, expectHash);
    appendBlock(this.dat, this.index, h, r.hash, Buffer.from(hex, 'hex')); writeIndex(this.idx, this.index);
    return { height: h, hash: r.hash, txs: block.transactions.length };
  }
  // SPEC 11: a transaction reaches the producer; it is included when it validates
  submit(hex) {
    const { k } = this; const tx = k.codec.decode('Transaction', hex); const txid = k.codec.txid(tx);
    if (this.mempool.has(txid)) return { txid, dup: true };
    const s = k.blocks.validateTransaction(tx, false); if (!s.ok) throw new Error(`transaction: ${s.results.filter((r) => r.ok === false).map((r) => r.rule).join(', ')}`);
    const prevouts = []; let inSum = 0;
    for (const i of tx.inputs) { const key = keyOf(i.prevout); if (this.mempoolSpent.has(key)) throw new Error(`input ${key} already spent in the mempool`); const c = this.utxo.get(key); if (!c) throw new Error(`input ${key} is not an unspent coin`);
      if (c.coinbase && this.node.height + 1 - c.height < this.k.params.coinbaseMaturity) throw new Error(`input ${key} is an immature coinbase`); prevouts.push(c.output); inSum += c.output.value; }
    const outSum = tx.outputs.reduce((s, o) => s + o.value, 0); if (outSum > inSum) throw new Error('outputs exceed inputs');
    // SPEC 7: a burn names a parent script and carries at least pegoutMin, as the block rule will demand
    for (const o of tx.outputs) { const d = this.k.codec; if (!o.scriptPubKey.startsWith('6a')) continue; const script = parsePegout(o.scriptPubKey); const text = (() => { try { return new TextDecoder().decode(Uint8Array.from((o.scriptPubKey.slice(4).match(/../g) ?? []), (x) => parseInt(x, 16))); } catch { return ''; } })();
      if (text.startsWith('pegout:') && !script) throw new Error('a peg-out names a parent output script of 2 to 40 bytes as hex'); if (script && o.value < this.pegoutMin()) throw new Error(`a peg-out burns at least ${this.pegoutMin()} sats`); }
    // producer policy, published in chain.json so a wallet can compute it: at least minFeeRate sat/vB
    const vsize = this.vsize(tx), minFee = Math.ceil(vsize * this.minFeeRate()); if (inSum - outSum < minFee) throw new Error(`fee ${inSum - outSum} is below the minimum ${minFee} sats (${vsize} vB at ${this.minFeeRate()} sat/vB)`);
    tx.inputs.forEach((_, i) => { const v = k.interpreter.verifyInput(tx, i, prevouts[i], prevouts, null, { unifiedSighash: true }); if (v.ok !== true) throw new Error(`input ${i}: ${v.error ?? v.reason ?? 'script failed'}`); });
    this.mempool.set(txid, tx); for (const i of tx.inputs) this.mempoolSpent.add(keyOf(i.prevout));
    return { txid, fee: inSum - outSum, vsize };
  }
  vsize(tx) { return Math.ceil(this.k.codec.txWeight(tx) / 4); }
  pegoutMin() { return Number(this.chain.pegoutMin ?? 10000); }
  // every burn the chain has validated, oldest first (SPEC 7)
  pegouts() { return [...(this.engine.sidestr?.pegouts.values() ?? [])].sort((a, b) => a.height - b.height); }
  minFeeRate() { return Number(this.chain.minFeeRate ?? 1); }
  fees(tx) { return tx.inputs.reduce((s, i) => s + this.utxo.get(keyOf(i.prevout)).output.value, 0) - tx.outputs.reduce((s, o) => s + o.value, 0); }
  // SPEC 4: a block on the tip with everything in the mempool, fees to the signer, signed
  // SPEC 6: a claim pays the peg's amount to the script the peg-in named, followed by its marker
  claimed(txid, vout) { return this.engine.sidestr?.claims.has(outpointOf(txid, vout)) ?? false; }
  produce(privHex, { time = Math.floor(Date.now() / 1000), claims = [] } = {}) {
    const tip = this.tip(); const t = Math.max(time, tip.time + 1);
    const txs = [...this.mempool.values()]; const fees = txs.reduce((s, tx) => s + this.fees(tx), 0);
    const outputs = fees > 0 ? [{ value: fees, scriptPubKey: this.chain.challenge }] : [];
    for (const c of claims) { if (this.claimed(c.txid, c.vout)) throw new Error(`${c.txid}:${c.vout} is already claimed`); outputs.push({ value: c.amount, scriptPubKey: c.script }, { value: 0, scriptPubKey: claimMarker(c.txid, c.vout) }); }
    const b = buildBlock(this.engine, { height: tip.height + 1, prev: tip.hash, time: t, transactions: txs, outputs, bits: this.bits });
    const signed = signBlock({ ...this.engine, interpreter: this.k.interpreter, schnorrSign: this.signer.schnorrSign }, b, this.chain.challenge, privHex);
    const r = this.addBlock(this.k.codec.encodeHex('Block', signed));
    return { ...r, fees, claims: claims.length };
  }
  coins(scriptPubKey) { const out = []; for (const [key, c] of this.utxo) if (c.output.scriptPubKey === scriptPubKey) out.push({ outpoint: key, value: c.output.value, height: c.height, coinbase: c.coinbase }); return out; }
}
