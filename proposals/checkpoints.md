# Checkpoints

*Status: running on `sidestr:gitmark` since 18 September 2026.* A proposal to the [sidestr spec](../SPEC.md); the record here is the working text, promoted into the spec once it has run unchanged for a while.

An announcement says where the chain is; it carries no proof of work. A
producer with a parent wallet may write its tip into the parent every `N` blocks: one
`OP_RETURN` of `ckpt:<chain id>:` followed by the height as four little-endian bytes, `:`, and
the 32-byte block hash (58 bytes for a 15-byte chain id). The parent block that carries it
proves that the chain's history up to that block existed before it. The producer records each
checkpoint beside the block file (`checkpoints.json`: height, hash, parent txid, parent block)
and a mirror carries it; a validator checks each checkpointed hash against the block it
validated at that height, shows every block at or below the newest confirmed checkpoint as
anchored in the parent, and treats a mismatch as a rewritten history. A level 2 validator
also checks that the parent transaction exists and is buried. Checkpoints bound what a
signer can backdate; they do not order what happens between them. A wallet needs a mirror for blocks and a producer
or relay for sending, and nothing else.
