// Checkpoints (SPEC 11) without a parent node: the record, the parent-side send and the
// reconciliation from the wallet's history.   node test/checkpoint-test.mjs
import { checkpointData, parseCheckpoint, sendCheckpoint, sentCheckpoints, checkpointStatus } from '../lib/checkpoint.mjs';
const t = (name, ok) => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`); if (!ok) process.exitCode = 1; };
const H = 'ab'.repeat(32), id = 'sidestr:gitmark'; const d = checkpointData(id, 305419896, H); const spk = '6a' + d.length.toString(16).padStart(2, '0') + Buffer.from(d).toString('hex');
t('58 bytes for a 15-byte chain id, height little-endian, hash raw', d.length === 58 && Buffer.from(d.subarray(21, 25)).toString('hex') === '78563412' && parseCheckpoint(spk, id).height === 305419896 && parseCheckpoint(spk, id).hash === H);
t('another chain id does not parse it', parseCheckpoint(spk, 'sidestr:other') === null);
t('a chain id too long for 80 bytes is refused', (() => { try { checkpointData('sidestr:' + 'x'.repeat(40), 1, H); return false; } catch (e) { return /80-byte/.test(e.message); } })());
const calls = []; const fake = { wallet: 'peg', walletRpc: async (m, p) => { calls.push([m, p]); if (m === 'send') return { complete: true, txid: 'f'.repeat(64) }; if (m === 'listtransactions') return [{ category: 'send', txid: 'f'.repeat(64) }, { category: 'receive', txid: 'e'.repeat(64) }]; if (m === 'gettransaction') return p[1] ? { decoded: { vout: [{ scriptPubKey: { hex: spk } }] } } : { confirmations: 3, blockheight: 151300, blockhash: '00'.repeat(32), blocktime: 1789700000 }; throw new Error('unexpected ' + m); } };
const r = await sendCheckpoint(fake, { chainId: id, height: 305419896, hash: H });
t('sendCheckpoint: one data output, the marker, fee rate 1', r.parentTxid === 'f'.repeat(64) && calls[0][0] === 'send' && calls[0][1][0][0].data === Buffer.from(d).toString('hex') && calls[0][1][3] === 1);
const sent = await sentCheckpoints(fake, { chainId: id });
t('sentCheckpoints finds it in the wallet history by height:hash', sent.get(`305419896:${H}`) === 'f'.repeat(64) && sent.size === 1);
const st = await checkpointStatus(fake, 'f'.repeat(64)); t('checkpointStatus reports the parent block and confirmations', st.parentHeight === 151300 && st.confirmations === 3);
let refused = null; try { await sendCheckpoint({ walletRpc: null }, { chainId: id, height: 1, hash: H }); } catch (e) { refused = e.message; } t('no peg wallet -> a clear error', /--parent-wallet/.test(refused ?? ''));
process.exit();
