# sidestr

User activated sidechains: Bitcoin's rules beside a Bitcoin-family chain, blocks valid because
they are signed, no subsidy, every coin a coin locked on the parent, and the rules carried as
signed documents each node chooses to adopt. Signers order blocks; users enforce the rules.

- [SPEC.md](SPEC.md): the protocol, draft 0.0.1.
- The first chain is the txbt4 siding, a chain beside the BLAKE2b testnet4 that keeps making
  blocks while the parent waits at its retarget. Level 1, one signer, worthless coins.

The sibling of [datstr](https://datstr.com/spec/): the same engine, the same documents, the
same rule that everything a verifier does runs in a browser tab.

## siding/

The reference implementation, on the same engine as datstr and blaketestnode:

    siding/chain.json      the txbt4 siding: id, parent, challenge, the four genesis pegs, powLimit, prefix
    siding/lib/overlay.mjs the network overlay and the block-signature rule (SPEC 3, 4)
    siding/lib/block.mjs   building, the signed block data, the virtual transactions, the solution push
    siding/lib/chain.mjs   genesis (SPEC 5), the block file, the UTXO set, a mempool, production
    siding/bin/siding.mjs  key | genesis | produce | sync | send

    node siding/bin/siding.mjs key --create           a signer key in ~/.sidestr/<name>.key
    node siding/bin/siding.mjs produce --dir DIR       blocks every 10 minutes, sooner with transactions
    node siding/bin/siding.mjs sync --url URL --dir D  validate a producer's chain, no key needed

Needs checkouts of bitcoin-desktop/schema (SCHEMA) and bitcoin-blake/blaketestnode (BLAKETESTNODE).
The genesis is deterministic: the same chain document gives the same block 0, byte for byte.

Picking this up as a developer or an agent: start with [siding/README.md](siding/README.md), the map of the reference implementation and what is not yet built.
