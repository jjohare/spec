# siding: the reference implementation

Start here if you are picking this up cold. `../SPEC.md` is the design; this directory is the
code that runs the first chain, and this file is the map. Everything is plain ES modules for
Node 22+ and browsers; there is no build step and no dependency beyond the
[bitcoin-desktop/schema](https://github.com/bitcoin-desktop/schema) kernel, loaded from a
local checkout in Node (`SCHEMA`, default `~/bitcoin-desktop/schema`) or from jsdelivr in a page.

## What is here

| file | what |
|---|---|
| `chain.json` | the live chain: id, parent, signer challenge, address prefix (`ts`), peg parameters, genesis |
| `bin/siding.mjs` | the CLI: `key`, `genesis`, `produce`, `sync`, `send` |
| `lib/engine.mjs` | loads the schema kernel with the knots-blake2b overlay and `overlay.mjs` for this chain |
| `lib/chain.mjs` | the chain in memory: blocks, UTXO set, mempool, `submit(hex)`, `produce(key)`, `coins(script)` |
| `lib/overlay.mjs` | what makes a siding different from its parent: zero subsidy, the signature challenge, the peg rules |
| `lib/schnorr.mjs` | BIP-340 signing on the schema's curve; no Node imports, so a browser can use it |
| `lib/sign.mjs` | key files for the CLI (`~/.sidestr/<chain name>.key`, 32 bytes of hex, mode 0600) |
| `lib/address.mjs` | bech32 / bech32m both ways, any prefix |
| `lib/relay.mjs` | transactions over Nostr: sign kind 23500 events, follow relays, publish |

Two other repositories build on this: [explorer](https://github.com/sidestr/explorer) reads and
validates a chain from a mirror in the browser (its `explorer.mjs` is the browser-side engine),
and [wallet](https://github.com/sidestr/wallet) signs and sends from a page. The wallet's
`test/wallet-test.mjs --mirror <URL> [--send]` is the quickest end-to-end check there is.

## How the pieces talk (SPEC section 11)

- **Blocks** are served as a file, `[u32 height][u32 size][block]`, with a JSON index and
  `chain.json`, from any **mirror**: a directory on a web server, nothing more. The producer
  serves the same three files on its own port; a mirror is an rsync of them.
- **Transactions** reach the producer either by `POST /tx` on its port or as **kind 23500
  events on a relay**, content the transaction hex, tagged `chain` = chain id. Relays index only
  single-letter tags, so a producer subscribes by kind and checks the tag itself. The event's
  key is anyone's: the transaction authorises itself.
- So a wallet needs a mirror to read and a relay to send to, and nothing of the producer's.

## Running it

```
siding key --create                         # a signer key; prints its ts1p... address
siding genesis --chain chain.json --dir D   # only ever once per chain
siding produce --chain chain.json --dir D --port 3450 --interval 3600 --tx-interval 10 \
               --relay wss://relay-a,wss://relay-b
siding sync    --chain chain.json --dir D --url http://host:3450   # a validating follower
siding send    --chain chain.json --url http://127.0.0.1:3450 --to <address|script> --amount <sats>
siding send    --chain chain.json --relay wss://relay-a ... --to ... --amount ...   # over Nostr
```

The producer makes a block every `--interval` seconds when idle and every `--tx-interval`
seconds while its mempool has something in it. Coinbase outputs (zero subsidy: fees only)
mature after `coinbaseMaturity` blocks, 100 unless the overlay says otherwise. Amounts are
always sats.

The producer's HTTP surface: `/` or `/status.json`, `/chain.json`, `/tip`, `/blocks.json`,
`/blocks.dat` (Range requests), `/coins/<script hex>`, `POST /tx` (body ≤ 256 KB).

## Conventions that matter

- **Keys are files, never arguments.** `loadKey` reads them; nothing prints them.
- **No host names in this repository**, not even as defaults: a mirror or relay is always
  given by the operator (`?mirror=`, `--relay`, `--url`). Pin other repositories by full commit
  hash when loading them from a CDN.
- Test against a live chain before claiming a change works; the wallet harness and a
  five-line WebSocket or fetch client are enough. Node has `Buffer`; browsers do not.

## What is specified and not yet built

In order of value:

1. **Peg-in claims (SPEC §6).** A confirmed peg-in on the parent is claimed by a sidechain
   coinbase paying the named script, with a `claim:<txid>:<vout>` marker. Nothing in `lib/`
   does this yet; it is what turns pegged coins into sidechain coins.
2. **A faucet**: a relay subscriber for kind 23501 (content: an address) that pays a small
   amount from its own funded key, one payout per address per day, capped per hour.
3. **The tip announcement (§11)**: the signer publishes its tip in the NIP-333 shape with
   `d` = chain id, and could name its mirrors there, so a wallet needs only a chain id.
4. **Peg-out (§7).**
5. **A second signer (level 2, §9).**

Small known gaps: the producer goes solo for a few seconds after a new parent tip if its
split arrives after `--split-wait`; a held CPU miner's difficulty still decays between windows.
