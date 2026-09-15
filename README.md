# sidestr

User activated sidechains: Bitcoin's rules beside a Bitcoin-family chain, blocks valid because
they are signed, no subsidy, every coin a coin locked on the parent, and the rules carried as
signed documents each node chooses to adopt. Signers order blocks; users enforce the rules.

- [SPEC.md](SPEC.md): the protocol, draft 0.0.1.
- The first chain is the txbt4 siding, a chain beside the BLAKE2b testnet4 that keeps making
  blocks while the parent waits at its retarget. Level 1, one signer, worthless coins.

The sibling of [datstr](https://datstr.com/spec/): the same engine, the same documents, the
same rule that everything a verifier does runs in a browser tab.
