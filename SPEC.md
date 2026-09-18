# sidestr — user activated sidechains

Version: 0.0.1, draft, 15 September 2026. Written the day the first pegs were made, before
the first sidechain block. Nothing here is final. Field names, kinds and document shapes are
provisional, and the numbers in section 10 describe one test chain.

sidestr is a way to run a chain beside a Bitcoin-family chain: Bitcoin's transaction rules,
blocks that are valid because they are signed rather than because they were mined, no subsidy,
and every coin on it a coin locked on the parent. The name is the chain beside the chain, with
its blocks, tips and rules carried as documents the way [datstr](https://datstr.com/spec/)
carries shares: signed JSON that a relay can move unchanged and a browser can verify.

"User activated" is a claim about who enforces the rules. A sidestr chain has signers, and
signers decide the order of blocks. They do not decide the rules. The rules are documents with
activation heights; a node applies a rule because its operator adopted the document, and a
block that breaks an adopted rule is invalid to that node whatever signature it carries. The
signers can stall the chain. They cannot change it.

## 1. Principles

1. **Bitcoin's rules, one added, one removed.** Transactions, scripts, the UTXO set and block
   structure are the parent chain's, run by the same engine. Added: a block must carry a
   signature satisfying the chain's challenge. Removed: the subsidy.
2. **Every coin is a pegged coin.** The supply of a sidestr chain equals the coins locked in
   its pegs on the parent. Coins enter by peg-in and leave by peg-out. Nothing else mints.
3. **Users validate, signers order.** Any node, a phone in a browser included, validates every
   block and transaction in full. Signers choose which valid blocks exist and in what order,
   and nothing more.
4. **Rules are documents.** The chain's rule set is data with activation heights, signed and
   addressable, chosen by each node's operator. This is what "user activated" means here.
5. **Pegs come back without permission.** Every peg output has a refund path that returns the
   coins to whoever pegged them after a timelock, with no signer involved. A dead sidechain
   costs time, not coins.
6. **No native token.** Issued assets exist for testing and say so. The only thing called by
   the parent's coin name is backed one to one.

## 2. Roles

- **Signer**: holds a key in the challenge. Produces or co-signs blocks.
- **Producer**: assembles blocks from submitted transactions and collects signatures. A
  signer is usually its own producer; a producer need not be a signer.
- **Peg holder**: holds a key that can spend a peg output on the parent. In level 1 the signers
  and the peg holders are the same keys.
- **Validator**: any node that applies the rules. Needs no key, no hash and no permission.
- **Mirror**: serves block files and publishes tips. Anyone.

## 3. Chain

A sidestr chain is an engine network, defined by an overlay document extending the parent
chain's network:

| parameter | meaning |
|---|---|
| `parent` | the parent chain id: any chain the engine validates, a sidestr chain included (section 3.1), e.g. `btc:testnet4-blake2b` |
| `challenge` | a script; a block is valid when its signature satisfies it (section 4) |
| `powLimit` | blocks must still meet this proof of work, cheap enough for a laptop, so a block costs something without keys; no retarget |
| `subsidy` | 0 |
| `addressPrefix` | a bech32m prefix distinct from the parent's, so a parent address is never a sidechain address |
| `pegConfirmations` | parent confirmations before a peg-in may be claimed |
| `refundBlocks` | the relative timelock on every peg output's refund path |
| `genesis` | the genesis document (section 5) |

Everything the overlay does not set is inherited from the parent: header format, script
rules, weight limits, the unified sighash where the parent has it.

### 3.1 Nesting

A parent may itself be a sidestr chain. A peg-in on a siding is the same transaction as a
peg-in on any parent (section 6), a child's document names the siding as `parent`, and the
child inherits the siding's rules as the siding inherits its parent's. Chains form a tree,
coins flow down by peg-in and back up by peg-out, and one validator checks every level with
the same engine.

Two consequences follow, and a child's document should state its depth:

- **The parent's blocks are the child's clock.** `refundBlocks` and `pegoutBlocks` count the
  parent's blocks. A parent that produces blocks only when it has transactions (section 11)
  keeps a heartbeat so that a child's refund path can ever open; a stalled parent freezes
  every refund below it.
- **Trust compounds.** A validator of a chain at depth n trusts, for ordering and for which
  pegs exist, every signer between it and the proof-of-work root. Depth is a cost, cheap for
  tests and agents, and a reason to keep value near the root.

## 4. Blocks

A block is valid when it is valid under the parent's rules with these changes, in this order:

1. `pow`: the header meets `powLimit`. No difficulty adjustment, no minimum-difficulty window.
2. `signature`: the coinbase's witness commitment output carries, after the commitment, the
   bytes `ecc7daa2` followed by a script witness that satisfies `challenge` for the block's
   signet hash, computed as [BIP 325](https://github.com/bitcoin/bips/blob/master/bip-0325.mediawiki)
   computes it over this chain's header serialization. A block without the marker, or whose
   witness does not satisfy the challenge, is invalid.
3. `subsidy`: the coinbase's outputs sum to at most the block's fees plus the peg-in claims
   the block makes (section 6).
4. `height`, `prev`, timestamps and everything else as the parent.

The challenge is a script, so it can be one key, a `multi_a` threshold, or anything the
engine's interpreter runs. Changing the challenge is a rule change (section 8).

## 5. Genesis

The genesis document lists the peg outputs the chain starts from, and the genesis block mints
exactly those amounts:

```json
{ "chain": "<chain id>", "parent": "<parent id>",
  "pegs": [ { "txid": "…", "vout": 0, "amount": 2500000000, "script": "<sidechain output script>" } ],
  "challenge": "<script hex>", "refundBlocks": 10000 }
```

Each peg's `script` is where its coins appear on the sidechain. The genesis block's coinbase
pays those scripts those amounts and nothing else, and its `prev` is all zeros. The document
is signed by the chain's spec key and is the first rule document (section 8).

## 6. Peg-in

A peg-in is a parent-chain transaction that:

1. pays a **peg output**: a taproot output whose key path is the peg holders' key and whose
   script path is `and_v(v:pk(refund), older(refundBlocks))`, so that the pegger's refund key
   can sweep it after `refundBlocks` unspent;
2. carries an `OP_RETURN` with `pegin:<chain id>:<sidechain output script>`, naming
   where the coins appear on the sidechain. The script is written as raw bytes (61 bytes in
   all for a taproot script, inside the 80-byte `OP_RETURN` policy limit); the hex text this
   document shows is also accepted.

After `pegConfirmations` parent confirmations, a sidechain block may **claim** it: the
coinbase pays the named script the peg's amount, and the very next coinbase output is an
`OP_RETURN` carrying `claim:<parent txid>:<vout>`. That pairing is what lets a validator
with no parent view bind each claimed amount to one outpoint: the coinbase may exceed the
fees by exactly the paid claims. A claim of an outpoint already claimed is invalid. A claim of a peg-in the validator cannot see is judged by level (section 9): a
level 1 validator accepts what the signers claim; a level 2 validator has a parent view and
refuses a claim it cannot verify.

The refund path means a peg-in that is never claimed, or a chain that dies, returns the coins
to the pegger after the timelock. While the parent chain is stalled the timelock does not
tick; the coins stay pegged.

## 7. Peg-out

A peg-out is a sidechain transaction paying a **burn output**: `OP_RETURN` with
`pegout:<parent output script hex>` and a value. The value leaves the sidechain's supply.
The peg holders then pay that script that value on the parent from the peg outputs, in a
transaction that also carries `OP_RETURN` `pegout:<chain id>:<sidechain txid>`. A validator
with a parent view checks that every burn is paid within `pegoutBlocks` parent blocks and
publishes the ones that are not. In level 1 this is the federation's promise and the
validators' record of whether it was kept. Trust-minimised peg-out is out of scope for 0.0.1.

## 8. Rules as documents

The chain's rules are engine overlay documents: JSON-LD, one per change, each with an
activation height, published as addressable Nostr events (kind 33500, `d` = chain id :
activation height) signed by a rule key. A node is configured with the rule keys it follows.
It applies a rule from its activation height because its operator chose that key, and it
shows the rule text before applying anything from a key it has not seen.

This is the whole of "user activated". A signer who wants a rule changed publishes a document
and waits to see who adopts it. A node that adopts nothing keeps the rules it has. Two nodes
that adopted different documents will disagree from the activation height, exactly as they
would on any chain, and the block signatures do not settle it.

## 9. Levels

| level | validator has | trusts the signers for |
|---|---|---|
| 1 | the sidechain rules | which peg-ins exist, that peg-outs are paid |
| 2 | a parent-chain view (headers plus the peg outputs) | nothing about pegs; still trusts them for ordering |
| 3 | level 2 plus several independent signers with rotation and a recovery path | liveness only |

The first chain is level 1 with one signer. Section 10 says so.

## 10. The first chain: the txbt4 siding

- chain id: `sidestr:txbt4-siding`, parent `btc:testnet4-blake2b`
- genesis pegs: four outputs of 25 tBTC on the parent, made on 15 September 2026 at heights
  151,152 to 151,154, 100 tBTC in total, each with a 10,000-block refund path
- challenge: one key, on one machine, which is also the peg holder. A test, not a federation.
- `powLimit`: the parent's minimum-difficulty target
- `addressPrefix`: `ts`
- `pegConfirmations`: 6; `refundBlocks`: 10,000; `pegoutBlocks`: 144

Made because the parent chain stalls at its 151,200 retarget until real hash arrives, and a
chain beside it can keep making blocks while it waits.

## 11. Distribution

A producer need not make a block when it has nothing to include. Blocks are receipts for
transactions; between them the chain idles, with a heartbeat block often enough that timelocks
and maturity keep moving and a wallet can tell an idle chain from a dead signer. The reference
producer takes a base interval and a shorter one for when its mempool is not empty.

Blocks are served as the block file blaketestnode already syncs from, `[u32 height][u32
size][block]` with a JSON index, from any mirror. Tips are published as signed events in the
NIP-333 shape with `d` = chain id, so a node cross-checks a mirror against the signers'
own announcement: kind 33333, tags `d` and `n` = chain id, `tip` = height, `u` = a mirror's base
URL (one tag per mirror), content = the last twelve headers as hex, signed by the signer's key.
A client that knows only the chain id takes the newest announcement, reads `chain.json` from a
mirror it names, and accepts that mirror when the document's `signer` is the announcement's
author; a client that already knows the signer takes no other's. A mirror is then held to the
announcement: the header at its tip must be the announced one, and it may be behind but never
ahead of the signer. A chain id is a name, not a proof, so a client shows the signer it settled
on. Transactions reach a producer by `POST /tx` or as kind 23500 events on a
relay, content the transaction hex, tagged `chain` = chain id; relays index only single-letter
tags, so a producer subscribes by kind and checks the tag on receipt. The event's key is
anyone's: the transaction authorises itself. A producer includes what validates. A wallet with
nothing may publish a kind 23501 event, content an address, tagged the same way; a faucet that
follows the relay may answer it with a payment, at its own limits. A wallet needs a mirror for blocks and a producer
or relay for sending, and nothing else.

## 12. Assets

Reserved. Issued assets and an automated market maker between them and the pegged coin are
rules in the sense of section 8, validated by every node, and are not part of 0.0.1. An
issued asset is unbacked and every document that names it says so.

## 13. Acceptance test

1. A genesis built from the peg-in records reproduces the genesis block byte for byte.
2. A validator with no key syncs the chain from a mirror and agrees with the producer on
   every block, including a block it rejects for a bad signature.
3. A peg-in on the parent is claimed once and cannot be claimed twice.
4. A peg-out burn is paid on the parent and the record shows it.
5. A rule document with a future activation height is adopted by one node and not another,
   and the two disagree from that height and not before.
6. All of it in a browser tab.

## 14. Threats

- **Signers stall**: the chain stops; pegs refund after the timelock. Liveness is the
  federation's, coins are not.
- **Signers reorder or censor**: visible to every validator; no remedy in level 1 beyond
  leaving. Level 3 adds rotation.
- **Signers mint**: impossible; a coinbase over fees plus verified claims is invalid.
- **Peg holders steal**: possible in level 1, the coins are theirs to move. The refund path
  limits it to coins not yet swept, and the record shows it. This is why level 1 is for
  coins with no value.
- **A mirror lies**: caught by the tip announcement and by validation.
- **A parent stalls**: every child's refund clock stops with it (3.1). Coins are not lost,
  they wait; a child pegged off a chain with no heartbeat waits indefinitely.

## Appendix A. Event kinds

| kind | name | class |
|---|---|---|
| 23500 | transaction | ephemeral |
| 33333 | tip, NIP-333 shape, `d` = chain id | addressable |
| 33500 | rule document, `d` = chain id : activation height | addressable |
| 33501 | genesis document, `d` = chain id | addressable |
| 33502 | peg record, `d` = parent txid : vout | addressable |

## Appendix B. Prior art

Elements and Liquid, whose signed-block chains with a peg this is a small copy of; BIP 325
signet, whose challenge mechanism is used as is; drivechains and spacechains, which want the
parent to enforce the peg and are the level this does not reach; RGB and Taproot Assets, for
validation by the client rather than the chain; Stellar's consensus, for the idea that trust
is chosen per node.
