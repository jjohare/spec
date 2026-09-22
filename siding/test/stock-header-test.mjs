// Headers follow the parent (SPEC 3.2) on two throwaway chains: beside `txbt4` the 164-byte v2
// header as every chain has had, beside `tbtc4` the stock 80-byte header hashed with double-SHA256
// and the height read from the coinbase's BIP 34 push; a malformed coinbase is refused, never read
// as height 0; both chains produce blocks a fresh validator replays.
//   node test/stock-header-test.mjs
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { loadEngine, BLAKETESTNODE } from '../lib/engine.mjs'; import { makeSigner } from '../lib/sign.mjs'; import { Siding } from '../lib/chain.mjs';
import { blockHeight, coinbaseHeight } from '../lib/block.mjs';
const { readBlock } = await import(`${BLAKETESTNODE}/lib/blockfile.mjs`);
const base = JSON.parse(fs.readFileSync(new URL('../chain.json', import.meta.url), 'utf8'));
let ok = 0, bad = 0;
const t = (name, cond) => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`); cond ? ok++ : bad++; };
const throws = (fn, re) => { try { fn(); return false; } catch (e) { return re.test(e.message); } };
const dsha256 = (hash, bytes) => hash.bytesToHex(hash.dsha256(bytes).reverse());
const push = (h) => { const out = []; let n = h; while (n > 0) { out.push(n & 0xff); n >>>= 8; } if (out.length && out[out.length - 1] & 0x80) out.push(0); return out.length ? [out.length, ...out] : [0]; };
const cb = (bytes) => ({ inputs: [{ scriptSig: Buffer.from(bytes).toString('hex') }] });

// coinbaseHeight: the inverse of the height push, and a refusal for anything else
t('coinbaseHeight inverts the BIP 34 height push', [0, 1, 16, 17, 127, 128, 255, 256, 65535, 70000, 8388608].every((h) => coinbaseHeight(cb([...push(h), 0xff])) === h));
t('an empty scriptSig is refused, not height 0', throws(() => coinbaseHeight({ inputs: [{ scriptSig: '' }] }), /not a hex script/) && throws(() => coinbaseHeight({ inputs: [] }), /not a hex script/));
t('an odd-length scriptSig is refused', throws(() => coinbaseHeight({ inputs: [{ scriptSig: '030' }] }), /not a hex script/));
t('a scriptSig that starts with something other than a push is refused', throws(() => coinbaseHeight(cb([0x4c, 0x01, 0x05])), /height push/) && throws(() => coinbaseHeight(cb([0x03, 0x01])), /height push/));
t('a negative height push is refused', throws(() => coinbaseHeight(cb([0x01, 0x80])), /negative/) && throws(() => coinbaseHeight(cb([0x04, 0x00, 0x00, 0x00, 0x80])), /negative/) && coinbaseHeight(cb([0x03, 0xff, 0xff, 0x7f])) === 8388607);
t('a non-minimal height push is refused', throws(() => coinbaseHeight(cb([0x02, 0x05, 0x00])), /not minimal/) && coinbaseHeight(cb([0x02, 0x80, 0x00])) === 128);

// two throwaway chains, one per parent family: open, produce, inspect the header, replay
for (const [alias, family] of [['txbt4', 'blake2b'], ['tbtc4', 'stock']]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `siding-hdr-${alias}-`));
  const engine0 = await loadEngine({ ...base, parent: alias }); const signer = makeSigner(engine0); const key = signer.randomKey(), pub = signer.pubkeyOf(key); const me = '5120' + pub;
  const chain = { ...base, id: `sidestr:hdr-${alias}`, name: `hdr-${alias}`, parent: alias, challenge: me, signer: pub, pegs: [{ txid: 'b'.repeat(64), vout: 0, amount: 1e9, script: me }] }; delete chain.genesisHash;
  const engine = await loadEngine(chain); const { k, hash } = engine;
  t(`${alias}: the engine resolves the parent's family`, engine.parent.family === family);
  const s = await new Siding({ engine, chain, dir, signer, log: () => {} }).open(key);
  while (s.tip().height < 3) await s.produce(key);
  const tip = s.tip(); const header = s.node.headers[tip.height]; const bytes = k.codec.encode('BlockHeader', header);
  const block = k.codec.decode('Block', readBlock(s.dat, s.index.blocks.find((e) => e.height === tip.height)).toString('hex'));
  t(`${alias}: the block file's tip decodes to the tip hash and height`, k.codec.blockHash(block.header) === tip.hash && blockHeight(block) === tip.height);
  if (family === 'stock') {
    t(`${alias}: the header is the stock 80 bytes`, bytes.length === 80);
    t(`${alias}: version keeps bit 31 clear`, (header.version >>> 31) === 0);
    t(`${alias}: the block hash is double-SHA256 of the header bytes`, tip.hash === dsha256(hash, bytes));
    t(`${alias}: the coinbase alone says the height`, header.height === undefined && coinbaseHeight(block.transactions[0]) === tip.height);
  } else {
    t(`${alias}: the header is the 164-byte v2 header`, bytes.length === 164);
    t(`${alias}: version carries bit 31 and the header carries the height`, (header.version >>> 31) === 1 && header.height === tip.height);
  }
  const s2 = await new Siding({ engine: await loadEngine(chain), chain, dir, signer, log: () => {} }).open(key);
  t(`${alias}: a fresh validator replays the block file to the same tip`, s2.tip().hash === tip.hash && s2.tip().height === tip.height);
}
console.log(`\n${ok} passed, ${bad} failed`); process.exit(bad ? 1 : 0);
