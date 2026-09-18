// Peg-in claims (SPEC 6) at the chain level, no parent needed: a throwaway chain in a temp dir,
// the real engine, overlay, Siding and block builder. Checks what the producer emits and what
// the validator accepts and refuses.   node test/claims-test.mjs
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { loadEngine } from '../lib/engine.mjs'; import { makeSigner } from '../lib/sign.mjs'; import { Siding } from '../lib/chain.mjs';
import { buildBlock, signBlock } from '../lib/block.mjs'; import { claimMarker, parseClaims } from '../lib/overlay.mjs';
const base = JSON.parse(fs.readFileSync(new URL('../chain.json', import.meta.url), 'utf8'));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siding-claims-')); let ok = 0, bad = 0;
const t = (name, cond) => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`); cond ? ok++ : bad++; };
const throws = (name, fn, re) => { try { fn(); t(name + ' (did not throw)', false); } catch (e) { t(name + (re && !re.test(e.message) ? ` (threw: ${e.message.slice(0, 80)})` : ''), !re || re.test(e.message)); } };

const engine0 = await loadEngine(base); const signer = makeSigner(engine0); const key = signer.randomKey(), pub = signer.pubkeyOf(key); const me = '5120' + pub;
const PEG0 = 'a'.repeat(64), PEG1 = 'b'.repeat(64), PEG2 = 'c'.repeat(64);
const chain = { ...base, id: 'sidestr:claimtest', name: 'claimtest', challenge: me, signer: pub, pegs: [{ txid: PEG0, vout: 0, amount: 5e9, script: me }] }; delete chain.genesisHash;
const engine = await loadEngine(chain); const s = await new Siding({ engine, chain, dir, signer }).open(key);
t('genesis minted the document peg', s.coins(me).length === 1 && s.coins(me)[0].value === 5e9);
t('an empty block produces', s.produce(key).height === 1);
const you = '5120' + signer.pubkeyOf(signer.randomKey());
const r = s.produce(key, { claims: [{ txid: PEG1, vout: 0, amount: 25e8, script: you }] });
t('a claim block produces', r.height === 2 && r.claims === 1);
t('the claim paid the named script the peg amount, as a coinbase output', s.coins(you).length === 1 && s.coins(you)[0].value === 25e8 && s.coins(you)[0].coinbase === true);
t('the outpoint is now claimed', s.claimed(PEG1, 0) === true && s.claimed(PEG2, 0) === false);
const { claims } = parseClaims({ outputs: [{ value: 25e8, scriptPubKey: you }, { value: 0, scriptPubKey: claimMarker(PEG1, 0) }] });
t('parseClaims pairs payout and marker', claims.length === 1 && claims[0].txid === PEG1 && claims[0].payout.value === 25e8);
throws('the producer refuses to claim an outpoint twice', () => s.produce(key, { claims: [{ txid: PEG1, vout: 0, amount: 25e8, script: you }] }), /already claimed/);
// hand-built blocks straight into the validator
const mk = (outputs) => { const tip = s.tip(); const b = buildBlock(engine, { height: tip.height + 1, prev: tip.hash, time: tip.time + 1, transactions: [], outputs, bits: s.bits }); return s.k.codec.encodeHex('Block', signBlock({ ...engine, interpreter: s.k.interpreter, schnorrSign: signer.schnorrSign }, b, chain.challenge, key)); };
throws('validator: a duplicate claim from another block is refused', () => s.addBlock(mk([{ value: 25e8, scriptPubKey: you }, { value: 0, scriptPubKey: claimMarker(PEG1, 0) }])));
throws('validator: coinbase value without a claim marker is refused', () => s.addBlock(mk([{ value: 1e8, scriptPubKey: you }])));
throws('validator: a marker with no payout before it is refused', () => s.addBlock(mk([{ value: 0, scriptPubKey: claimMarker(PEG2, 0) }, { value: 1e8, scriptPubKey: you }])));
throws('validator: two markers sharing one payout are refused', () => s.addBlock(mk([{ value: 1e8, scriptPubKey: you }, { value: 0, scriptPubKey: claimMarker(PEG2, 0) }, { value: 0, scriptPubKey: claimMarker(PEG2, 1) }])));
throws('validator: the same outpoint twice in one block is refused', () => s.addBlock(mk([{ value: 1e8, scriptPubKey: you }, { value: 0, scriptPubKey: claimMarker(PEG2, 0) }, { value: 1e8, scriptPubKey: you }, { value: 0, scriptPubKey: claimMarker(PEG2, 0) }])));
t('a well-formed claim block from outside is accepted', (() => { s.addBlock(mk([{ value: 1e8, scriptPubKey: you }, { value: 0, scriptPubKey: claimMarker(PEG2, 0) }])); return s.claimed(PEG2, 0) && s.coins(you).length === 2; })());
t('and an ordinary block after all that still produces', s.produce(key).height === s.tip().height);
t('the two claimed coins are immature coinbases until maturity', s.coins(you).every((c) => c.coinbase && !(s.tip().height + 1 - c.height >= s.k.params.coinbaseMaturity)));
// --- fees: the producer refuses less than minFeeRate sat/vB (policy from chain.json) ---
while (s.tip().height < 101) s.produce(key); // mature the genesis coin
const { SIGHASH_UNIFIED } = await import(`${process.env.SCHEMA ?? os.homedir() + '/bitcoin-desktop/schema'}/codec/interpreter.js`);
const spend = (fee) => { const c = s.coins(me).find((x) => x.height === 0); const [txid, vout] = c.outpoint.split(':'); const tx = { version: 2, inputs: [{ prevout: { txid, vout: Number(vout) }, scriptSig: '', sequence: 0xfffffffd }], outputs: [{ value: c.value - fee, scriptPubKey: you }], lockTime: 0, witness: [] };
  const prevouts = [{ value: c.value, scriptPubKey: me }]; const ht = 0x01 | SIGHASH_UNIFIED; let m = s.k.interpreter.sighashUnified(tx, 0, prevouts, ht, 2); if (typeof m === 'string') m = engine.hash.hexToBytes(m);
  tx.witness = [[engine.hash.bytesToHex(signer.schnorrSign(m, key)) + ht.toString(16).padStart(2, '0')]]; return s.k.codec.encodeHex('Transaction', tx); };
const vs = s.vsize(s.k.codec.decode('Transaction', spend(0)));
throws(`submit refuses a zero-fee transaction (${vs} vB needs ${vs} sats)`, () => s.submit(spend(0)), /below the minimum/);
throws('submit refuses one sat short', () => s.submit(spend(vs - 1)), /below the minimum/);
t('submit accepts exactly the minimum', (() => { const r = s.submit(spend(vs)); return r.fee === vs && r.vsize === vs; })());
fs.rmSync(dir, { recursive: true, force: true }); console.log(`\n${ok} passed, ${bad} failed`); process.exit(bad ? 1 : 0);
