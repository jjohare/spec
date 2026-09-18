// The evm rule (proposals/evm.md) on a throwaway chain: a deposit credits at 1 sat = 1 gwei, a
// carried transfer runs, a contract deploys and answers a call, a withdrawal is paid by the
// coinbase, a wrong root is refused, a bad nonce is refused by the mempool, and a reopen from
// disk reproduces the state root.   node test/evm-test.mjs
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { loadEngine } from '../lib/engine.mjs'; import { makeSigner } from '../lib/sign.mjs'; import { Siding } from '../lib/chain.mjs';
import { carrierScript, depositScript, rootScript, parseRoot, GWEI, WITHDRAW } from '../lib/overlays/evm.mjs';
const base = JSON.parse(fs.readFileSync(new URL('../chain.json', import.meta.url), 'utf8'));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siding-evm-')); let ok = 0, bad = 0;
const t = (name, cond) => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`); cond ? ok++ : bad++; };
const throws = async (name, fn, re) => { try { await fn(); t(name + ' (did not throw)', false); } catch (e) { t(name + (re && !re.test(e.message) ? ` (threw: ${e.message.slice(0, 100)})` : ''), !re || re.test(e.message)); } };
const engine0 = await loadEngine(base); const signer = makeSigner(engine0); const key = signer.randomKey(), pub = signer.pubkeyOf(key); const me = '5120' + pub;
const chain = { ...base, id: 'sidestr:evmtest', name: 'evmtest', challenge: me, signer: pub, rules: ['evm'], evm: { chainId: 21474, gasLimit: 30000000 }, pegs: [{ txid: 'a'.repeat(64), vout: 0, amount: 5e9, script: me }] }; delete chain.genesisHash;
const engine = await loadEngine(chain); const s = await new Siding({ engine, chain, dir, signer, log: () => {} }).open(key); const evm = engine.rules.evm; const { util, tx: T } = evm.lib;
t('the engine carries the evm rule with an empty state', !!evm && evm.ready && (await evm.rootHex()).length === 66);
while (s.tip().height < 101) await s.produce(key);
t('101 empty blocks each commit the unchanged state root', evm.blocks.get(101)?.root === evm.blocks.get(0)?.root && evm.roots.get(101) === evm.roots.get(0));
// helpers: a sidechain tx from my coins with the given extra outputs
const { SIGHASH_UNIFIED } = await import(`${process.env.SCHEMA ?? os.homedir() + '/bitcoin-desktop/schema'}/codec/interpreter.js`);
const mature = () => s.coins(me).filter((c) => (!c.coinbase || s.tip().height + 1 - c.height >= s.k.params.coinbaseMaturity) && !s.mempoolSpent.has(c.outpoint)).sort((a, b) => b.value - a.value);
const mk = (outputs, fee = 5000) => { const c = mature()[0]; const [txid, vout] = c.outpoint.split(':'); const total = outputs.reduce((a, o) => a + o.value, 0); const tx = { version: 2, inputs: [{ prevout: { txid, vout: Number(vout) }, scriptSig: '', sequence: 0xfffffffd }], outputs: [...outputs, { value: c.value - total - fee, scriptPubKey: me }], lockTime: 0, witness: [] };
  const prevouts = [{ value: c.value, scriptPubKey: me }]; const ht = 0x01 | SIGHASH_UNIFIED; let m = s.k.interpreter.sighashUnified(tx, 0, prevouts, ht, 2); if (typeof m === 'string') m = engine.hash.hexToBytes(m);
  tx.witness = [[engine.hash.bytesToHex(signer.schnorrSign(m, key)) + ht.toString(16).padStart(2, '0')]]; return { tx, hex: s.k.codec.encodeHex('Transaction', tx), txid: s.k.codec.txid(tx) }; };
// an EVM key and address
const priv = util.hexToBytes('0x' + '42'.repeat(32)); const alice = util.createAddressFromPrivateKey(priv).toString(); const bob = '0x' + '77'.repeat(20);
const balance = async (a) => (await evm.vm.stateManager.getAccount(util.createAddressFromString(a)))?.balance ?? 0n;
// deposit 1,000,000 sats -> 1,000,000 gwei
const dep = mk([{ value: 1000000, scriptPubKey: me }, { value: 0, scriptPubKey: depositScript(alice) }]);
t('a deposit (reserve payment + evmin) is accepted by the mempool', (await s.submit(dep.hex)).txid === dep.txid); await s.produce(key);
t('alice holds 1,000,000 gwei after the block', (await balance(alice)) === 1000000n * GWEI);
await throws('a deposit without the reserve payment before the marker is refused', () => s.submit(mk([{ value: 0, scriptPubKey: depositScript(bob) }]).hex), /no reserve payment/);
// a transfer alice -> bob, carried
const sign = (fields) => T.createLegacyTx({ gasPrice: GWEI, gasLimit: 21000, ...fields }, { common: evm.common }).sign(priv);
const xfer = sign({ nonce: 0, to: bob, value: 250000n * GWEI }); const carry = mk([{ value: 0, scriptPubKey: carrierScript(xfer.serialize()) }]);
t('a carried transfer is accepted by the mempool (executed on a checkpoint)', (await s.submit(carry.hex)).txid === carry.txid);
t('a second nonce-0 transaction is accepted by the mempool (checked against the confirmed state) and dropped at sequencing', !!(await s.submit(mk([{ value: 0, scriptPubKey: carrierScript(sign({ nonce: 0, to: bob, value: 1n }).serialize()) }]).hex)).txid);
const r1 = await s.produce(key); t(`the block ran it: bob has 250,000 gwei, alice paid 21000 gwei of gas`, (await balance(bob)) === 250000n * GWEI && (await balance(alice)) === (1000000n - 250000n - 21000n) * GWEI);
const rc = evm.receipts.get('0x' + Buffer.from(xfer.hash()).toString('hex')); t('a receipt is kept: status 1, height, the sidechain txid', rc?.status === 1 && rc.height === r1.height && rc.sidechainTxid === carry.txid && rc.gasUsed === 21000n);
// a contract: runtime code that returns 42; init code stores it
const runtime = '602a60005260206000f3'; const init = '69' + runtime + '600052600a6016f3'; // PUSH10 <runtime> PUSH1 0 MSTORE PUSH1 10 PUSH1 22 RETURN
const deploy = T.createLegacyTx({ nonce: 1, gasPrice: GWEI, gasLimit: 100000, data: '0x' + init }, { common: evm.common }).sign(priv);
t('a contract deployment carrier is accepted', !!(await s.submit(mk([{ value: 0, scriptPubKey: carrierScript(deploy.serialize()) }]).hex)).txid); await s.produce(key);
const rc2 = evm.receipts.get('0x' + Buffer.from(deploy.hash()).toString('hex')); const contract = rc2?.contractAddress;
t(`the contract exists at ${contract?.slice(0, 12)}… with the runtime code`, !!contract && Buffer.from(await evm.vm.stateManager.getCode(util.createAddressFromString(contract))).toString('hex') === runtime);
// a read-only call: on a checkpoint, reverted — runCall touches state, and a validator's state must only move by blocks
await evm.vm.stateManager.checkpoint(); const call = await evm.vm.evm.runCall({ to: util.createAddressFromString(contract), caller: util.createAddressFromString(alice), gasLimit: 100000n, data: new Uint8Array() }); await evm.vm.stateManager.revert();
t('a call to it returns 42', Buffer.from(call.execResult.returnValue).toString('hex').endsWith('2a'));
// a withdrawal: 100,000 gwei to a sidechain script, paid by the coinbase
const target = '5120' + signer.pubkeyOf(signer.randomKey()); const wd = T.createLegacyTx({ nonce: 2, gasPrice: GWEI, gasLimit: 30000, to: WITHDRAW, value: 100000n * GWEI, data: '0x' + target }, { common: evm.common }).sign(priv);
await s.submit(mk([{ value: 0, scriptPubKey: carrierScript(wd.serialize()) }]).hex); const r3 = await s.produce(key);
t('the withdrawal is paid by the coinbase: 100,000 sats to the script', s.coins(target).length === 1 && s.coins(target)[0].value === 100000 && s.coins(target)[0].coinbase === true);
t('and the withdraw address holds nothing', (await balance(WITHDRAW)) === 0n);
// a hand-built block whose coinbase commits the wrong root is refused
const { buildBlock, signBlock } = await import('../lib/block.mjs'); const tip = s.tip();
const badBlock = buildBlock(engine, { height: tip.height + 1, prev: tip.hash, time: tip.time + 1, transactions: [], outputs: [{ value: 0, scriptPubKey: rootScript('0x' + '11'.repeat(32)) }], bits: s.bits });
await throws('validator: a block committing a wrong state root is refused', () => s.addBlock(s.k.codec.encodeHex('Block', signBlock({ ...engine, interpreter: s.k.interpreter, schnorrSign: signer.schnorrSign }, badBlock, chain.challenge, key))), /rule-evm/);
t('and the chain still produces after the refusal', (await s.produce(key)).height === s.tip().height);
const rootNow = await evm.rootHex();
// reopen from disk
const engine2 = await loadEngine(chain); const s2 = await new Siding({ engine: engine2, chain, dir, signer, log: () => {} }).open(key);
t('reopening replays every carrier and reaches the same state root', s2.height() === s.height() && (await engine2.rules.evm.rootHex()) === rootNow && (await (engine2.rules.evm.vm.stateManager.getAccount(util.createAddressFromString(bob))))?.balance === 250000n * GWEI);
fs.rmSync(dir, { recursive: true, force: true }); console.log(`\n${ok} passed, ${bad} failed`); process.exit(bad ? 1 : 0);
