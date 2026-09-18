// The Ethereum JSON-RPC a wallet expects (proposals/evm.md): enough of eth_* for MetaMask, ethers
// and viem to see the chain, read state, estimate, and send. A raw transaction is wrapped by the
// producer into a carrier sidestr transaction paid from its own coins (the signer sponsors the
// sidechain fee; the sender pays EVM gas), then submitted like any transaction. Read-only calls
// run on a checkpoint that is reverted: a validator's state moves only by blocks.
import { carrierScript, parseCarrier } from './overlays/evm.mjs';
const hexn = (n) => '0x' + BigInt(n).toString(16);
const hexb = (b) => '0x' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

export function makeEvmRpc({ s, chain, evm, carrier, log = () => {} }) {
  const { util, tx: T } = evm.lib; const addr = (a) => util.createAddressFromString(String(a).toLowerCase());
  const heightOf = (tag) => tag === undefined || tag === 'latest' || tag === 'pending' || tag === 'safe' || tag === 'finalized' ? s.height() : tag === 'earliest' ? 0 : Number(BigInt(tag));
  const blockHash = (h) => '0x' + (s.node.chain[h] ?? '00'.repeat(32));
  const ZERO32 = '0x' + '00'.repeat(32), ZEROADDR = '0x' + '00'.repeat(20);
  const account = async (a) => (await evm.vm.stateManager.getAccount(addr(a))) ?? new util.Account();
  const withCheckpoint = async (fn) => { await evm.vm.stateManager.checkpoint(); try { return await fn(); } finally { await evm.vm.stateManager.revert(); } };
  const callOpts = (c) => ({ to: c.to ? addr(c.to) : undefined, caller: addr(c.from ?? ZEROADDR), value: c.value ? BigInt(c.value) : 0n, data: c.data ?? c.input ? util.hexToBytes(c.data ?? c.input) : new Uint8Array(), gasLimit: c.gas ? BigInt(c.gas) : evm.gasLimit });
  const receiptJson = (r) => ({ transactionHash: r.transactionHash, transactionIndex: hexn(evm.txs.get(r.transactionHash)?.index ?? 0), blockHash: blockHash(r.height), blockNumber: hexn(r.height), from: r.from, to: r.to, cumulativeGasUsed: hexn(r.cumulativeGasUsed), gasUsed: hexn(r.gasUsed), contractAddress: r.contractAddress, logs: r.logs.map(([a, topics, data], i) => ({ address: hexb(a), topics: topics.map(hexb), data: hexb(data), blockNumber: hexn(r.height), transactionHash: r.transactionHash, transactionIndex: hexn(0), blockHash: blockHash(r.height), logIndex: hexn(i), removed: false })), logsBloom: r.logsBloom ?? '0x' + '00'.repeat(256), status: hexn(r.status), effectiveGasPrice: hexn(r.effectiveGasPrice), type: '0x0' });
  const txJson = (h) => { const e = evm.txs.get(h); if (!e) return null; const j = e.tx.toJSON(); return { ...j, hash: h, from: e.tx.getSenderAddress().toString(), blockHash: blockHash(e.height), blockNumber: hexn(e.height), transactionIndex: hexn(e.index), type: hexn(e.tx.type), chainId: hexn(evm.chainId), gas: j.gasLimit }; };
  const blockJson = (h, full) => { if (h < 0 || h > s.height()) return null; const b = evm.blocks.get(h); const hashes = b?.hashes ?? []; const gasUsed = hashes.reduce((a, x) => a + (evm.receipts.get(x)?.gasUsed ?? 0n), 0n);
    return { number: hexn(h), hash: blockHash(h), parentHash: h > 0 ? blockHash(h - 1) : ZERO32, timestamp: hexn(s.node.headers[h]?.time ?? 0), gasLimit: hexn(evm.gasLimit), gasUsed: hexn(gasUsed), baseFeePerGas: hexn(1000000000n), miner: ZEROADDR, nonce: '0x0000000000000000', sha3Uncles: ZERO32, logsBloom: '0x' + '00'.repeat(256), transactionsRoot: ZERO32, stateRoot: b?.root ?? ZERO32, receiptsRoot: ZERO32, difficulty: '0x0', totalDifficulty: '0x0', extraData: '0x', size: '0x0', mixHash: ZERO32, uncles: [], transactions: full ? hashes.map(txJson) : hashes }; };
  const methods = {
    web3_clientVersion: () => `siding/${chain.id}`, net_version: () => String(evm.chainId), eth_chainId: () => hexn(evm.chainId), eth_syncing: () => false, eth_accounts: () => [], eth_mining: () => false,
    eth_blockNumber: () => hexn(s.height()), eth_gasPrice: () => hexn(1000000000n), eth_maxPriorityFeePerGas: () => '0x0',
    eth_feeHistory: ([count, , pct]) => { const n = Number(BigInt(count)); return { oldestBlock: hexn(Math.max(0, s.height() - n + 1)), baseFeePerGas: Array(n + 1).fill(hexn(1000000000n)), gasUsedRatio: Array(n).fill(0), reward: pct ? Array(n).fill(pct.map(() => '0x0')) : undefined }; },
    eth_getBalance: async ([a]) => hexn((await account(a)).balance), eth_getTransactionCount: async ([a, tag]) => { const n = (await account(a)).nonce; return hexn(tag === 'pending' ? n + BigInt(pendingFrom(a)) : n); },
    eth_getCode: async ([a]) => hexb(await evm.vm.stateManager.getCode(addr(a))), eth_getStorageAt: async ([a, pos]) => hexb(await evm.vm.stateManager.getStorage(addr(a), util.setLengthLeft(util.hexToBytes(pos), 32))),
    eth_call: async ([c]) => withCheckpoint(async () => { const r = await evm.vm.evm.runCall(callOpts(c)); if (r.execResult.exceptionError) { const e = new Error(`execution reverted`); e.code = 3; e.data = hexb(r.execResult.returnValue); throw e; } return hexb(r.execResult.returnValue); }),
    eth_estimateGas: async ([c]) => withCheckpoint(async () => { const r = await evm.vm.evm.runCall(callOpts(c)); if (r.execResult.exceptionError) { const e = new Error('execution reverted'); e.code = 3; e.data = hexb(r.execResult.returnValue); throw e; } const data = callOpts(c).data; const calldata = [...data].reduce((a, b) => a + (b === 0 ? 4 : 16), 0); return hexn(21000n + (c.to ? 0n : 32000n) + BigInt(calldata) + r.execResult.executionGasUsed * 12n / 10n); }),
    eth_sendRawTransaction: async ([raw]) => { const rlp = util.hexToBytes(raw); let etx; try { etx = T.createTxFromRLP(rlp, { common: evm.common }); } catch (e) { throw Object.assign(new Error(`not a transaction: ${e.message.slice(0, 80)}`), { code: -32602 }); }
      if (!etx.isSigned() || !etx.verifySignature()) throw Object.assign(new Error('unsigned or bad signature'), { code: -32000 }); const r = await carrier(carrierScript(rlp)); log(`evm: carried ${'0x' + hexb(etx.hash()).slice(2, 18)}… from ${etx.getSenderAddress().toString().slice(0, 10)}… in ${r.txid.slice(0, 16)}…`); return hexb(etx.hash()); },
    eth_getTransactionReceipt: ([h]) => { const r = evm.receipts.get(String(h).toLowerCase()); return r ? receiptJson(r) : null; },
    eth_getTransactionByHash: ([h]) => txJson(String(h).toLowerCase()),
    eth_getBlockByNumber: ([tag, full]) => blockJson(heightOf(tag), !!full), eth_getBlockByHash: ([h, full]) => { const i = s.node.chain.findIndex((x) => '0x' + x === String(h).toLowerCase()); return i < 0 ? null : blockJson(i, !!full); },
    eth_getBlockTransactionCountByNumber: ([tag]) => hexn((evm.blocks.get(heightOf(tag))?.hashes ?? []).length),
    eth_getLogs: ([f]) => { const from = heightOf(f.fromBlock ?? 'latest'), to = heightOf(f.toBlock ?? 'latest'); const out = []; const want = f.address ? [].concat(f.address).map((a) => a.toLowerCase()) : null;
      for (const r of evm.receipts.values()) { if (r.height < from || r.height > to) continue; receiptJson(r).logs.forEach((l) => { if (want && !want.includes(l.address)) return; if (f.topics && f.topics.some((t, i) => t && (Array.isArray(t) ? !t.includes(l.topics[i]) : l.topics[i] !== t))) return; out.push(l); }); } return out; },
  };
  // carriers waiting in the mempool from this sender: a wallet's next nonce counts them
  const pendingFrom = (a) => { let n = 0; const A = String(a).toLowerCase(); for (const tx of s.mempool.values()) for (const o of tx.outputs) { const rlp = parseCarrier(o.scriptPubKey); if (!rlp) continue; try { if (T.createTxFromRLP(rlp, { common: evm.common }).getSenderAddress().toString().toLowerCase() === A) n++; } catch {} } return n; };
  return async function handle(body) {
    const one = async (req) => { const { id = null, method, params = [] } = req ?? {}; const fn = methods[method];
      if (!fn) return { jsonrpc: '2.0', id, error: { code: -32601, message: `${method} is not supported` } };
      try { return { jsonrpc: '2.0', id, result: await fn(params) }; } catch (e) { return { jsonrpc: '2.0', id, error: { code: e.code ?? -32000, message: e.message, ...(e.data ? { data: e.data } : {}) } }; } };
    return Array.isArray(body) ? Promise.all(body.map(one)) : one(body);
  };
}
