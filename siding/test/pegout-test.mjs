// Peg-outs (SPEC 7) at the chain level and the parent-side helpers, no parent node needed:
// a throwaway chain, burns accepted and refused, the record the producer keeps, the markers.
//   node test/pegout-test.mjs
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { loadEngine } from '../lib/engine.mjs'; import { makeSigner } from '../lib/sign.mjs'; import { Siding } from '../lib/chain.mjs';
import { pegoutMarker, parsePegout, parsePegouts } from '../lib/overlay.mjs'; import { pegoutMarkerData, parsePegoutMarker, payPegout, paidPegouts } from '../lib/parent.mjs';
const base = JSON.parse(fs.readFileSync(new URL('../chain.json', import.meta.url), 'utf8'));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siding-pegout-')); let ok = 0, bad = 0;
const t = (name, cond) => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`); cond ? ok++ : bad++; };
const throws = (name, fn, re) => { try { fn(); t(name + ' (did not throw)', false); } catch (e) { t(name + (re && !re.test(e.message) ? ` (threw: ${e.message.slice(0, 90)})` : ''), !re || re.test(e.message)); } };
const engine0 = await loadEngine(base); const signer = makeSigner(engine0); const key = signer.randomKey(), pub = signer.pubkeyOf(key); const me = '5120' + pub;
const chain = { ...base, id: 'sidestr:pegouttest', name: 'pegouttest', challenge: me, signer: pub, pegoutMin: 10000, pegs: [{ txid: 'a'.repeat(64), vout: 0, amount: 5e9, script: me }] }; delete chain.genesisHash;
const engine = await loadEngine(chain); const s = await new Siding({ engine, chain, dir, signer }).open(key);
while (s.tip().height < 101) s.produce(key);
const PARENT = '5120' + 'e9'.repeat(32);
t('the marker is OP_RETURN pegout:<script> and parses back', parsePegout(pegoutMarker(PARENT)) === PARENT && pegoutMarker(PARENT).startsWith('6a4b'));
t('a script outside 2..40 bytes is not a peg-out', parsePegout(pegoutMarker('00')) === null && parsePegout(pegoutMarker('ab'.repeat(41))) === null);
const { SIGHASH_UNIFIED } = await import(`${process.env.SCHEMA ?? os.homedir() + '/bitcoin-desktop/schema'}/codec/interpreter.js`);
const spend = (outputs, coin = s.coins(me).filter((c) => s.tip().height + 1 - c.height >= s.k.params.coinbaseMaturity || !c.coinbase)[0]) => {
  const [txid, vout] = coin.outpoint.split(':'); const tx = { version: 2, inputs: [{ prevout: { txid, vout: Number(vout) }, scriptSig: '', sequence: 0xfffffffd }], outputs, lockTime: 0, witness: [] };
  const prevouts = [{ value: coin.value, scriptPubKey: me }]; const ht = 0x01 | SIGHASH_UNIFIED; let m = s.k.interpreter.sighashUnified(tx, 0, prevouts, ht, 2); if (typeof m === 'string') m = engine.hash.hexToBytes(m);
  tx.witness = [[engine.hash.bytesToHex(signer.schnorrSign(m, key)) + ht.toString(16).padStart(2, '0')]]; return { hex: s.k.codec.encodeHex('Transaction', tx), tx, txid: s.k.codec.txid(tx) }; };
const coin = s.coins(me)[0];
throws('submit refuses a burn below pegoutMin', () => s.submit(spend([{ value: 9999, scriptPubKey: pegoutMarker(PARENT) }, { value: coin.value - 9999 - 1000, scriptPubKey: me }]).hex), /at least 10000/);
throws('submit refuses a pegout: marker that is not a script', () => s.submit(spend([{ value: 20000, scriptPubKey: '6a0a' + Buffer.from('pegout:zz').toString('hex') }, { value: coin.value - 21000, scriptPubKey: me }]).hex), /2 to 40 bytes/);
const burn = spend([{ value: 50000, scriptPubKey: pegoutMarker(PARENT) }, { value: coin.value - 50000 - 1000, scriptPubKey: me }]);
t('submit accepts a burn of 50000 sats', s.submit(burn.hex).txid === burn.txid);
const before = s.utxo.size; const r = s.produce(key); const after = [...s.utxo.values()].reduce((a, c) => a + c.output.value, 0);
t('the block with the burn validates and the burn is not a coin (spent 1, change 1, fee coinbase 1)', r.txs === 2 && s.utxo.size === before + 1 && ![...s.utxo.keys()].includes(`${burn.txid}:0`));
t('the chain records the burn: txid, vout, script, value, height', (() => { const p = s.pegouts(); return p.length === 1 && p[0].txid === burn.txid && p[0].vout === 0 && p[0].script === PARENT && p[0].value === 50000 && p[0].height === r.height; })());
t('parsePegouts reads it from the transaction', parsePegouts(burn.tx, burn.txid).length === 1);
t('50000 sats left the supply (5e9 - 50000 - fees 1000 + fees to signer)', after === 5e9 - 50000);
// a hand-built block whose coinbase carries a burn is refused by the validator
const { buildBlock, signBlock } = await import('../lib/block.mjs');
const mk = (outputs) => { const tip = s.tip(); const b = buildBlock(engine, { height: tip.height + 1, prev: tip.hash, time: tip.time + 1, transactions: [], outputs, bits: s.bits }); return s.k.codec.encodeHex('Block', signBlock({ ...engine, interpreter: s.k.interpreter, schnorrSign: signer.schnorrSign }, b, chain.challenge, key)); };
throws('validator: a burn in the coinbase is refused', () => s.addBlock(mk([{ value: 0, scriptPubKey: pegoutMarker(PARENT) }])));
t('and an ordinary block after that still produces', s.produce(key).height === s.tip().height);
// the parent-side record
const data = pegoutMarkerData(chain.id, burn.txid); const spk = '6a' + data.length.toString(16).padStart(2, '0') + Buffer.from(data).toString('hex');
t(`the parent marker is ${data.length} bytes (fits 80) and parses back to the sidechain txid`, data.length <= 80 && parsePegoutMarker(spk, chain.id) === burn.txid && parsePegoutMarker(spk, 'sidestr:other') === null);
// a fake parent: decodescript, send, listtransactions, gettransaction
const calls = []; const fake = { wallet: 'peg', rpc: async (m, p) => { calls.push([m, p]); if (m === 'decodescript') return { address: 'tb1qfake' }; throw new Error('unexpected ' + m); },
  walletRpc: async (m, p) => { calls.push([m, p]); if (m === 'send') return { complete: true, txid: 'f'.repeat(64) }; if (m === 'listtransactions') return [{ category: 'send', txid: 'f'.repeat(64) }, { category: 'receive', txid: 'e'.repeat(64) }]; if (m === 'gettransaction') return { decoded: { vout: [{ scriptPubKey: { hex: '0014' + '00'.repeat(20) } }, { scriptPubKey: { hex: spk } }] } }; throw new Error('unexpected ' + m); } };
const paid = await payPegout(fake, { chainId: chain.id, txid: burn.txid, script: PARENT, value: 50000 });
const sendCall = calls.find((c) => c[0] === 'send');
t('payPegout pays the decoded address the burned value with the marker as data', paid.parentTxid === 'f'.repeat(64) && sendCall[1][0][0]['tb1qfake'] === '0.00050000' && sendCall[1][0][1].data === Buffer.from(data).toString('hex'));
const already = await paidPegouts(fake, { chainId: chain.id });
t('paidPegouts finds the payment in the wallet history by its marker', already.get(burn.txid) === 'f'.repeat(64) && already.size === 1);
let refused = null; try { await payPegout({ rpc: fake.rpc, walletRpc: null }, { chainId: chain.id, txid: burn.txid, script: PARENT, value: 50000 }); } catch (e) { refused = e.message; }
t('no peg wallet -> nothing is paid, a clear error', /--parent-wallet/.test(refused ?? ''));
fs.rmSync(dir, { recursive: true, force: true }); console.log(`\n${ok} passed, ${bad} failed`); process.exit(bad ? 1 : 0);
