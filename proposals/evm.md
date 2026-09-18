# The EVM as a rule

*Status: first milestone built 18 September 2026 — the rule, the JSON-RPC, `test/evm-test.mjs`
and `test/evmrpc-test.mjs`; a chain running it is next.* A proposal to the [sidestr spec](../SPEC.md).

A sidestr chain that names the `evm` rule runs Ethereum contracts. Nothing changes about how
its blocks are made or signed: Ethereum transactions ride inside ordinary sidestr transactions,
every validator runs them in block order through an EVM and keeps the account state beside the
UTXO set, and the coinbase commits the state root so validators agree. The engine is
[ethereumjs](https://github.com/ethereumjs/ethereumjs-monorepo) (pure JavaScript: Node and
browsers), Cancun rules, a chain id from the document.

## Units

**1 sat = 1 gwei.** Sats enter the EVM by a deposit and leave by a withdrawal, at that rate
and nowhere else. Gas is priced in gwei with a fixed base fee of 1 gwei (1 sat) and no priority
fee; the fee is burned. There is no block reward; the sidechain's own fees pay the signer.

## Records

| record | meaning |
|---|---|
| `evm:` + RLP bytes | a signed Ethereum transaction, executed in order (as one push, `OP_PUSHDATA2` when it is long) |
| an output paying the reserve script, then `evmin:` + 20-byte address | a deposit: the output's sats credit the address × 10⁹ wei; the reserve is the chain's challenge unless `evm.reserve` says otherwise |
| an EVM transaction to `0x…0501de` with 34 bytes of data and a value | a withdrawal: the value is burned in the EVM and the block's coinbase must pay `floor(value / 10⁹)` sats to that script (a sidechain output script) |
| `evmroot:` + 32 bytes, in the coinbase | the state root after the block |

## The rule (`sidestr:rule-evm`)

For each block, from the state after the previous one: every sidechain transaction's deposits
credit, then its carriers run through the VM in output order. A carrier that cannot be applied
— bad signature, wrong chain id, wrong nonce, insufficient balance — makes the block invalid;
a transaction that runs and reverts is applied (gas spent, nonce advanced) and its receipt says
so. The coinbase must commit the resulting state root and pay every withdrawal the block's
transactions made; its value may exceed fees and claims by exactly those payouts. Deposits,
carriers and the root are not allowed in the coinbase.

Execution is asynchronous and the kernel's checks are not, so a validator runs the block
through the VM *before* the kernel's checks and the registered rule reads the verdict left
for that block. A producer runs a carrier against the confirmed state when it enters the
mempool (checkpointed, reverted) and again in order when it builds a block, dropping what no
longer applies; the state moves only when a block is added.

## What a wallet sees

The producer answers Ethereum JSON-RPC at `POST /evm`: `eth_chainId`, `eth_blockNumber`,
`eth_getBalance`, `eth_getTransactionCount` (`pending` counts carriers in the mempool),
`eth_gasPrice`, `eth_feeHistory`, `eth_estimateGas`, `eth_call`, `eth_getCode`,
`eth_getStorageAt`, `eth_sendRawTransaction`, `eth_getTransactionReceipt`,
`eth_getTransactionByHash`, `eth_getBlockByNumber`/`ByHash`, `eth_getLogs`, and the `net_`/
`web3_` basics — enough for MetaMask, ethers and viem. A raw transaction is wrapped in a
carrier that the signer's coins pay the sidechain fee for; the sender pays EVM gas. Read-only
calls run on a checkpoint that is reverted. A sidestr key is an Ethereum key: the same 32
bytes give an address by `keccak(pubkey)`.

## Not yet

Receipts and logs are kept in memory and rebuilt on open (fine for a small chain; a snapshot is
needed before a large one). Deposits need a wallet button (pay the reserve, add the marker).
The explorer's rule engine loads ethereumjs from jsdelivr in the page — heavy, untested.
Bridging an asset between an EVM chain and tally is the assets-between-chains proposal.
