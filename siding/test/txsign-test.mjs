// Key-path signatures follow the parent's family (SPEC 3): unified beside a BLAKE2b parent, BIP 341
// beside stock Bitcoin; each engine refuses the other's signature. And the peg-in scanner takes the
// output the peg wallet owns, not the first taproot output (a wallet's change may come first).
//   node test/txsign-test.mjs
import fs from 'node:fs';
import { loadEngine } from '../lib/engine.mjs'; import { makeSigner } from '../lib/sign.mjs';
import { signKeyPath, verifyKeyPath, usesUnifiedSighash, SIGHASH_UNIFIED } from '../lib/txsign.mjs';
import { scanPegins } from '../lib/parent.mjs';
const base = JSON.parse(fs.readFileSync(new URL('../chain.json', import.meta.url), 'utf8'));
let ok = 0, bad = 0; const t = (name, cond) => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`); cond ? ok++ : bad++; };
const engines = {}; for (const parent of ['txbt4', 'tbtc4']) engines[parent] = await loadEngine({ ...base, id: `sidestr:sig-${parent}`, name: `sig-${parent}`, parent });
t('the BLAKE2b family uses the unified sighash, the stock family does not', usesUnifiedSighash(engines.txbt4.k) && !usesUnifiedSighash(engines.tbtc4.k));
const key = '11'.repeat(32);
for (const [parent, e] of Object.entries(engines)) {
  const signer = makeSigner(e); const pub = signer.pubkeyOf(key); const spk = '5120' + pub;
  const prevouts = [{ value: 50000, scriptPubKey: spk }]; const tx = { version: 2, inputs: [{ prevout: { txid: 'ab'.repeat(32), vout: 0 }, scriptSig: '', sequence: 0xfffffffd }], outputs: [{ value: 49000, scriptPubKey: spk }], lockTime: 0, witness: [] };
  signKeyPath({ k: e.k, hash: e.hash, signer }, tx, prevouts, key);
  const v = e.k.interpreter.verifyInput(tx, 0, prevouts[0], prevouts, null, { unifiedSighash: usesUnifiedSighash(e.k) });
  t(`beside ${parent}: the signature verifies under the chain's own rule (hash type 0x${tx.witness[0][0].slice(128)})`, v.ok === true && verifyKeyPath({ k: e.k, hash: e.hash, secp: e.secp }, tx, prevouts, pub));
  if (parent === 'txbt4') { const v2 = engines.tbtc4.k.interpreter.verifyInput(tx, 0, prevouts[0], prevouts, null, { unifiedSighash: false }); t('a unified signature is refused beside stock Bitcoin (the bug the first stock-parent chain hit)', v2.ok !== true); }
  else { const v2 = engines.txbt4.k.interpreter.verifyInput(tx, 0, prevouts[0], prevouts, null, { unifiedSighash: true }); t('a BIP 341 signature is still accepted beside a BLAKE2b parent (the flag byte selects the rule)', v2.ok === true); }
}
t('hash types: unified is 0x21, stock is 0x01', (() => { const a = engines.txbt4, b = engines.tbtc4; const s = (e) => { const signer = makeSigner(e); const spk = '5120' + signer.pubkeyOf(key); const tx = { version: 2, inputs: [{ prevout: { txid: 'cd'.repeat(32), vout: 1 }, scriptSig: '', sequence: 0xfffffffd }], outputs: [{ value: 1, scriptPubKey: spk }], lockTime: 0, witness: [] }; signKeyPath({ k: e.k, hash: e.hash, signer }, tx, [{ value: 2, scriptPubKey: spk }], key); return tx.witness[0][0].slice(128); }; return s(a) === (0x01 | SIGHASH_UNIFIED).toString(16) && s(b) === '01'; })());
// the scanner: a marker transaction whose change (not ours) comes before the peg (ours)
const markerData = Buffer.from('pegin:sidestr:scan:').toString('hex') + '5120' + 'ee'.repeat(32); const marker = '6a' + (markerData.length / 2).toString(16).padStart(2, '0') + markerData;
const block = { tx: [{ txid: 'c0'.repeat(32), vin: [{ coinbase: '00' }], vout: [] }, { txid: 'd1'.repeat(32), vin: [{}], vout: [
  { n: 0, value: 0.2, scriptPubKey: { type: 'witness_v1_taproot', hex: '5120' + 'aa'.repeat(32), address: 'tb1p-change' } },
  { n: 1, value: 0, scriptPubKey: { type: 'nulldata', hex: marker } },
  { n: 2, value: 0.0005, scriptPubKey: { type: 'witness_v1_taproot', hex: '5120' + 'bb'.repeat(32), address: 'tb1p-peg' } } ] }] };
const rpc = async (m, p) => m === 'getblockhash' ? 'h' : block;
const withWallet = { rpc, walletRpc: async (m, [addr]) => ({ ismine: addr === 'tb1p-peg' }) };
const found = await scanPegins(withWallet, { chainId: 'sidestr:scan', from: 1, to: 1 });
t('with a peg wallet, the peg is the output the wallet owns, not the first taproot output', found.length === 1 && found[0].vout === 2 && found[0].amount === 50000 && found[0].script === '5120' + 'ee'.repeat(32));
const announced = await scanPegins({ rpc, walletRpc: async () => ({ ismine: true }) }, { chainId: 'sidestr:scan', from: 1, to: 1, pegScript: '5120' + 'bb'.repeat(32) });
t('an announced peg script picks its output even when the wallet also owns the change', announced.length === 1 && announced[0].vout === 2);
const announcedMiss = await scanPegins({ rpc, walletRpc: async (m, [a]) => ({ ismine: a === 'tb1p-peg' }) }, { chainId: 'sidestr:scan', from: 1, to: 1, pegScript: '5120' + 'cc'.repeat(32) });
t('when nothing pays the announced script, ownership still finds an older-style peg', announcedMiss.length === 1 && announcedMiss[0].vout === 2);
const none = await scanPegins({ rpc, walletRpc: async () => ({ ismine: false }) }, { chainId: 'sidestr:scan', from: 1, to: 1 });
t('a marker beside nothing the wallet owns is not a peg-in', none.length === 0);
const legacy = await scanPegins({ rpc, walletRpc: null }, { chainId: 'sidestr:scan', from: 1, to: 1 });
t('without a peg wallet the first taproot output is taken (read-only producers, as before)', legacy.length === 1 && legacy[0].vout === 0);
console.log(`${ok} passed, ${bad} failed`); process.exit(bad ? 1 : 0);
