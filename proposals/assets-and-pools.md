# Assets and pools

*Status: the `assets` and `pool` rules run on `sidestr:tally` since 18 September 2026; section 4 (assets between chains) is a draft for level 2.* A proposal to the [sidestr spec](../SPEC.md); the record here is the working text, promoted into the spec once it has run unchanged for a while.

Issued assets and an automated market maker between them and the pegged coin are two
rules in the sense of section 8, `assets` and `pool`, that a chain document names in `rules`
(`"rules": ["assets", "pool"]`). A validator applies a named rule from genesis, and a validator
without the rule's code refuses the chain rather than validating half of it. An issued asset is
unbacked: it is a number the chain keeps, and every document that names it says so.

## 1. Records

A rule reads **records**: `OP_RETURN` outputs whose data is UTF-8 text of at most 255 bytes
(a single push, `OP_PUSHDATA1` when longer than 75). A transaction may carry several. The
coinbase carries none of these. An amount is a whole number of units, `1` to `2^53 - 1`;
sums are computed without overflow.

| record | meaning |
|---|---|
| `issue:<TICKER>:<decimals>` | this transaction issues a new asset; its id is this txid; `TICKER` is 1 to 8 of `A-Z0-9`, `decimals` 0 to 8 (display only) |
| `tally:<asset>:<vout>=<amount>[,<vout>=<amount>…]` | the named outputs of this transaction carry those amounts of the asset; `<asset>` is an asset id, or `self` in the issuing transaction |
| `pool:<pool>:<vout>` | the named output is the pool coin of that pool; `<pool>` is a pool id, or `self` in the transaction that opens it |

A tallied output is an ordinary coin: it has a script, an owner and a value in sats (at least
one), and it is spent as any coin is. The asset amounts ride on it. An output is tallied at
most once per asset, and an output not named in a tally carries nothing.

## 2. The `assets` rule

The validator keeps, beside the UTXO set, what each unspent output carries. For every asset
in every non-coinbase transaction: **what the inputs carry is at least what the tallies
assign**; the difference is destroyed. Issuance is the one exception: in a transaction with
`issue:`, the tallies for `self` are the supply, created from nothing, and there is at most one
`issue:` per transaction. A transaction that assigns an asset it does not carry, tallies an
`OP_RETURN` output or an output that does not exist, names `self` without issuing, or repeats
an output within one asset, is invalid, and so is its block (`sidestr:rule-assets`, error
`bad-tally`). Spending a tallied output without tallying its assets onward destroys them; that
is allowed and is how an asset is burned. Assets never touch the peg: a burn (section 7) is of
sats only, and an asset has no parent.

## 3. The `pool` rule

A **pool** is one coin, the pool coin, that holds `x` sats (its value) and `y` units of one
asset `A` (its tally), with script `OP_TRUE` (`51`): anyone may spend it, and the rule says how.
The pool's id is the txid of the transaction that opened it. Its **shares** are an asset whose
id is the pool id, minted and destroyed only by this rule.

Opening: a transaction carries `pool:self:<vout>` naming an output with script `51`, value
`x0 > 0` and a tally of `y0 > 0` of exactly one asset `A`; the same transaction tallies
`floor(sqrt(x0 * y0))` shares to outputs of its choice as `tally:self:…`: the pool id is this
txid, so `self` is the share asset here, and a transaction that opens a pool does not also
`issue:`. A pool coin is never tallied with a second asset.

Spending: a transaction spends at most one pool coin, and recreates exactly one output with
script `51`, a `pool:<pool id>:<vout>` record, value `x'` and a tally `y'` of `A`. Let `S` be
the shares in existence before the transaction and `S'` after (shares tallied minus shares
carried in). Exactly one of the following holds, or the block is invalid
(`sidestr:rule-pool`, error `bad-pool`):

- **swap**: `S' = S`, and with `dx = max(x' - x, 0)`, `dy = max(y' - y, 0)`, the fee of 3
  per 1000 on what comes in, `(1000 x' - 3 dx) (1000 y' - 3 dy) >= 1000000 x y`.
- **add**: `S' > S`, `x' >= x`, `y' >= y`, and `S' - S <= min(floor((x' - x) S / x),
  floor((y' - y) S / y))`.
- **remove**: `S' < S`, `x' <= x`, `y' <= y`, and `x - x' <= floor(x (S - S') / S)`,
  `y - y' <= floor(y (S - S') / S)`, with `x' >= 1` and `y' >= 1`: a pool is never emptied.

Every rounding is in the pool's favour. Amounts are exact: a transaction names the pool coin
it spends and the pool it leaves, so two transactions on one pool in one block conflict as any
two spends of one coin do, the second is refused and rebuilt against the new state, and a
refused one costs nothing. Multi-hop routes are several transactions. The signer orders
transactions and so can front-run them; at level 1 that is the signer's to refrain from and the
document says so, at level 2 it takes `k` of them.

## 4. Assets between chains

Reserved, and shaped now so the records need not change: an asset may be pegged from one
sidestr chain to another exactly as sats are pegged from the parent (sections 6 and 7). On the
origin chain a transaction burns the asset: a `pegout:<destination script hex>` record with a
tally of the asset assigned to that output. On the destination chain the signers claim it as
the coinbase issuance of a wrapped asset whose id is `<origin chain id>:<origin asset id>`,
paired with a `claim:` record naming the origin txid, so a validator with a view of the origin
(its mirror, its announcements) checks each claim. The way back is the same burn on the
destination and a payout of the origin asset from what the peg holds. The trust is the
destination's signers, so this is for level 2 chains; a chain that adopts it says so in its
document. A pool is one coin under one chain's rules and is never shared across chains: to
trade an asset from elsewhere, peg it across, then swap.

## 5. What a wallet does

A wallet reads pools from the mirror as it reads coins: the pool coin's value and tally are
the price. It quotes a swap client-side by the formula, builds the transaction with the exact
amounts, signs its own inputs with the key-path spend of section 3, and leaves the pool
coin's input witness empty (`OP_TRUE` needs none). It shows an asset by its ticker and
decimals, and says that the asset is unbacked.
