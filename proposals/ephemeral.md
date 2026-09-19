# Ephemeral chains

*Status: a note, 19 September 2026; nothing built.* A proposal to the [sidestr spec](../SPEC.md); the record here is the working text, promoted into the spec once it has run unchanged for a while.

A sidestr chain is a document, a key and a process. Nothing about it has to last: no token, no
validator set to recruit, no listing to earn. So a chain can be made for one job and left behind,
and the parent chain sees only the peg-in at the start and one settlement at the end. This note
says what "left behind" should mean, so that an ephemeral chain is a property the validators
enforce rather than a promise its maker keeps.

## 1. What they are for

- **A tab.** Two parties exchange many small payments on a chain only they run, at no cost to
  anyone else, and settle once on the parent.
- **A negotiation.** An escrow and the contract that resolves it live on a chain the two parties
  run; when it is resolved there is nothing to keep.
- **A session.** A game, an auction, a swarm of agents' scratch ledger: history that matters for
  the duration and not after.
- **A sandbox.** A rule, a contract, a fork of the rules, tried where nobody else can see.

The parties are usually agents. An agent with a key can make a chain in a second, and it has no
reason to keep one it has finished with.

## 2. The close

A chain document may carry a close:

```
"close": { "height": 1440 }            or          "close": { "time": 1790000000 }
```

At the closing height (or the first block at or after the closing time) the chain ends. Its last
block is the **closing block**, and the closing block's coinbase pays every coin holder pro rata in
one transaction: one output per script, the script's total balance, and no fee. A closing block
with any other coinbase, or any block after it, is invalid. The signer then pegs out the whole
peg address to those holders on the parent, in the same proportions, as SPEC §7 already requires
for burns; the closing block's outputs are the burns.

Nothing about the close needs the parties' cooperation once the chain has started: a validator
refuses a block that continues past it, so a signer cannot keep a closed chain alive, and a
holder who stops paying attention is still paid out.

## 3. The tombstone

The closing block's hash is checkpointed into the parent
([checkpoints](checkpoints.md)) by the signer as the last thing the chain does:
`ckpt:<chain id>:<closing height>:<hash>`. That one output is the chain's tombstone. A
dispute about what the chain concluded can be settled later from the parties' own copies
against it, after every mirror is gone.

## 4. Manners

Short chains must not cost the network what long ones do.

- **Announce rarely.** An ephemeral chain announces (SPEC §11) at genesis, at the close, and
  otherwise at most every hour; the parties read each other's producer directly and need no
  mirror.
- **Say what you are for.** The genesis announcement carries `purpose` and `party` tags (a short
  string; the parties' public keys), so an agent can find "the chain for task X between A and B"
  by tag rather than by scanning, and a directory can fold ephemeral chains away from the
  long-lived ones.
- **Peg in small.** The parent fee is the same for a large peg as a small one; the sats on an
  ephemeral chain should be what the job needs and no more.

## 5. In a process

The reference implementation runs a producer as a command. For agents it should also be a
library call: make a document and a key, start producing in the current process, stop when
done. The code exists as `siding/lib/chain.mjs`; the entry points do not.

## 6. What this changes elsewhere

- SPEC §4 (the document): an optional `close`.
- SPEC §11 (announcements): the `purpose` and `party` tags; the rate for ephemeral chains.
- The directory: ephemeral chains folded, closed chains shown with their tombstone.
- The explorer: a closed chain reads as closed, with its closing block and the parent output
  that entombs it.
