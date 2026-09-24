// A parent transaction over a relay is broadcast only when the node's own policy accepts it (SPEC 11, kind 23503).
//   node test/parentrelay-test.mjs
import { relayParentTx } from '../lib/parent.mjs'; import { makeEvents, PARENT_TX_KIND } from '../lib/relay.mjs';
let ok = 0, bad = 0; const t = (name, cond) => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`); cond ? ok++ : bad++; };
const calls = []; const node = (verdict) => ({ rpc: async (m, p) => { calls.push(m); if (m === 'decoderawtransaction') { if (!/^02/.test(p[0])) throw new Error('TX decode failed'); return { txid: 'ab'.repeat(32) }; } if (m === 'testmempoolaccept') return [verdict]; if (m === 'sendrawtransaction') return 'ab'.repeat(32); } });
const good = { allowed: true, vsize: 223, fees: { base: 0.00000446 } }, refused = { allowed: false, 'reject-reason': 'min relay fee not met', 'reject-details': '0 < 223' };
calls.length = 0; const a = await relayParentTx(node(good), '02aa');
t('accepted by the node: broadcast, with the node consulted first', a.ok && a.txid === 'ab'.repeat(32) && calls.join(',') === 'decoderawtransaction,testmempoolaccept,sendrawtransaction');
calls.length = 0; const b = await relayParentTx(node(refused), '02bb');
t('refused by the node: not broadcast, the node\'s reason returned', !b.ok && /min relay fee not met: 0 < 223/.test(b.reason) && !calls.includes('sendrawtransaction'));
const seen = new Set(); await relayParentTx(node(good), '02cc', { seen }); calls.length = 0; const c = await relayParentTx(node(good), '02cc', { seen });
t('the same transaction a second time is ignored, never re-sent', c.duplicate && !calls.includes('sendrawtransaction'));
t('garbage is refused before the node is asked', !(await relayParentTx(node(good), 'zz')).ok && !(await relayParentTx(node(good), '01ff')).ok);
const ev = makeEvents({ signer: { pubkeyOf: () => 'pk', schnorrSign: () => new Uint8Array(64) }, hash: { sha256: (b) => b.slice(0, 32), bytesToHex: (b) => Buffer.from(b).toString('hex'), hexToBytes: (h) => Uint8Array.from(Buffer.from(h, 'hex')) } }).parentTxEvent('k', 'sidestr:x', '02aa');
t('the wallet\'s event is kind 23503, tagged with the chain, content the hex', ev.kind === PARENT_TX_KIND && ev.tags[0][1] === 'sidestr:x' && ev.content === '02aa');
console.log(`${ok} passed, ${bad} failed`); process.exit(bad ? 1 : 0);
