# The desk: pledging a locked reward

*Status: running on `sidestr:txbt4-desk` since 18 September 2026, level 1; **paused since 19 September**: the parent's lock (Bitcoin Knots PR 419) is an open, unmerged pull request whose testnet start moved from 151,055 to 151,406 on 19 September, and no node on this network enforces it yet. Until the parent enforces the lock, a pledged reward can be spent by its miner at 100 blocks, which would invalidate the maturity transaction after the desk has paid; so `pledge.paused` is set and the producer refuses pledges. The document now also carries `enforceFrom` (151,550), the height from which nodes running the rule refuse an early spend.* A proposal to the [sidestr spec](../SPEC.md); the record here is the working text, promoted into the spec once it has run unchanged for a while.

A parent may lock coinbase rewards for a long time (the BLAKE2b chains do,
from `lockedFrom` until `maturity`). A miner who holds such a reward can still sign, today, the
transaction that will move it: a **pledge** is a transaction spending the reward to the chain's
peg address, carrying the peg-in marker of section 6 naming the miner's sidechain script, with
`nLockTime` = the reward's maturity height and a non-final sequence. It is invalid until that
height and valid from it. The miner publishes it as a kind 33502 event, `d` = the reward's
outpoint, content the transaction hex.

A chain that runs a desk says so in its document: `pledge` with `rate`, `lockedFrom`,
`maturity`, `pegScript`, `fee` and `maxPerPledge`. Its producer, with a parent view, checks a
pledge (the output exists, is a coinbase from the locked era, is unspent and immature; one
input, two outputs; output 0 pays the peg less a small fee; output 1 is the marker; the lock
time is the maturity; the signature verifies against the reward) and pays `floor(amount ×
rate)` sats from the signer's coins to the marker's script, once per reward, recording it in
`pledges.json` beside the block file. At maturity the producer broadcasts every pledge it holds;
each confirms as an ordinary peg-in and is claimed to the float (the signer's script), not to
the marker's payee, because the payee was paid already. The marker binds the payee inside the
signed transaction, so a pledge seen on a relay cannot be redirected.

What the miner keeps is the key: at maturity they could spend the reward themselves before the
desk's broadcast lands. A pledge is a commitment, not a covenant, and the desk's rate prices
that, the duration, and the chance of a reorg past maturity. The producer publishes the locked
coinbase outputs it has seen (`coinbases.json`) so a wallet can list what a key may pledge.
