// The desk's pledge (SPEC 6.2) without a parent node: build a maturity transaction with a key,
// verify it as the desk would, and refuse the cases the desk must refuse.   node test/pledge-test.mjs
import fs from 'node:fs';
import { loadEngine, loadParentKernel } from '../lib/engine.mjs'; import { makeSigner } from '../lib/sign.mjs'; import { buildPledge, verifyPledge, maturityOf, markerScript } from '../lib/pledge.mjs';
const t = (name, ok) => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`); if (!ok) process.exitCode = 1; };
const chain = JSON.parse(fs.readFileSync(new URL('../../chains/txbt4-desk/chain.json', import.meta.url), 'utf8'));
const e = await loadEngine(chain); const k = await loadParentKernel(chain); const signer = makeSigner(e); const { SIGHASH_UNIFIED } = await import(`${process.env.SCHEMA ?? process.env.HOME + '/bitcoin-desktop/schema'}/codec/interpreter.js`);
const key = signer.randomKey(), pub = signer.pubkeyOf(key), mine = '5120' + pub; const other = '5120' + signer.pubkeyOf(signer.randomKey());
const reward = { txid: 'ab'.repeat(32), vout: 0, value: 5000000000, script: mine, height: 151460 };
t('maturity: a reward from the locked era matures at the document height; an older one at +100', maturityOf(151460, chain.pledge) === 158111 && maturityOf(151000, chain.pledge) === 151100);
const b = buildPledge({ k, hash: e.hash, signer, SIGHASH_UNIFIED, key, chain, reward, payeeScript: mine });
t(`build: one input, pays the peg ${reward.value - chain.pledge.fee}, marker names the payee, lock time ${b.lockTime}`, b.tx.outputs[0].scriptPubKey === chain.pledge.pegScript && b.tx.outputs[0].value === reward.value - 1000 && b.tx.outputs[1].scriptPubKey === markerScript(chain.id, mine) && b.lockTime === 158111 && b.pays === 4500000000);
const prevout = { value: reward.value, script: mine, coinbase: true, height: reward.height };
const v = verifyPledge({ k, hex: b.hex, chain, prevout, parentTip: 151470 });
t(`verify: ok, pays ${v.pays} (90%), payee is the pledger, maturity ${v.maturity}`, v.ok && v.pays === 4500000000 && v.payee === mine && v.maturity === 158111 && v.txid === b.txid);
t('refused: not a coinbase', /not a coinbase/.test(verifyPledge({ k, hex: b.hex, chain, prevout: { ...prevout, coinbase: false }, parentTip: 151470 }).error));
t('refused: spent or unknown output', /not an unspent/.test(verifyPledge({ k, hex: b.hex, chain, prevout: null, parentTip: 151470 }).error));
t('refused: a reward from before the lock', /not locked/.test(verifyPledge({ k, hex: b.hex, chain, prevout: { ...prevout, height: 151000 }, parentTip: 151470 }).error));
t('refused: already mature', /already mature/.test(verifyPledge({ k, hex: b.hex, chain, prevout, parentTip: 158111 }).error));
t('refused: wrong owner (signature)', /signature/.test(verifyPledge({ k, hex: b.hex, chain, prevout: { ...prevout, script: other }, parentTip: 151470 }).error));
const b2 = buildPledge({ k, hash: e.hash, signer, SIGHASH_UNIFIED, key, chain: { ...chain, pledge: { ...chain.pledge, maturity: 158112 } }, reward, payeeScript: mine });
t('refused: wrong lock time', /lock time/.test(verifyPledge({ k, hex: b2.hex, chain, prevout, parentTip: 151470 }).error));
t('refused: too large for the desk', /maximum/.test(verifyPledge({ k, hex: b.hex, chain: { ...chain, pledge: { ...chain.pledge, maxPerPledge: 1000 } }, prevout, parentTip: 151470 }).error));
let refused = null; try { buildPledge({ k, hash: e.hash, signer, SIGHASH_UNIFIED, key, chain, reward: { ...reward, script: other }, payeeScript: mine }); } catch (x) { refused = x.message; }
t('build refuses a reward the key does not own', /does not own/.test(refused ?? ''));
const back = k.codec.decode('Transaction', b.hex); t('hex round-trips through the parent codec with the witness', k.codec.txid(back) === b.txid && back.witness[0][0].length === 130);
process.exit();
