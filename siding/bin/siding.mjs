#!/usr/bin/env node
// The txbt4 siding, or any sidestr chain from a chain document (SPEC 10, 11).
//   siding key --create [--chain chain.json]        the signer key (~/.sidestr/<name>.key) and its challenge
//   siding genesis --chain chain.json --dir DIR     write block 0
//   siding produce --chain chain.json --dir DIR [--port 3450] [--interval 600] [--tx-interval 30]
//   siding sync --url http://host:3450 --dir DIR    validate a producer's chain into DIR
//   siding send --url http://host:3450 --chain chain.json --to <address or script> --amount <sats>
//   siding send --relay wss://a,wss://b ...   the same, published as a kind 23500 event instead of POSTed
//   siding produce ... --relay wss://a,wss://b  also follow those relays for kind 23500 transactions
import { decodeAddress, scriptToAddress } from '../lib/address.mjs';
import { readFile } from 'node:fs/promises';
import { mkdir } from 'node:fs/promises';
import { existsSync, statSync, createReadStream } from 'node:fs';
import http from 'node:http';
import { homedir } from 'node:os';
import { loadEngine } from '../lib/engine.mjs';
import { makeSigner, loadKey } from '../lib/sign.mjs';
import { makeEvents, subscribe, publish, TX_KIND } from '../lib/relay.mjs';
import { Siding } from '../lib/chain.mjs';

const args = Object.fromEntries(process.argv.slice(3).map((a, i, all) => a.startsWith('--') ? [a.slice(2), all[i + 1] === undefined || all[i + 1].startsWith('--') ? true : all[i + 1]] : []).filter(Boolean));
const cmd = process.argv[2];
const log = (s) => console.log(`${new Date().toISOString().slice(11, 19)} ${s}`);
const chainFile = args.chain ?? new URL('../chain.json', import.meta.url).pathname;
const chain = JSON.parse(await readFile(chainFile, 'utf8'));
const keyPath = args['key-file'] ?? `${homedir()}/.sidestr/${chain.name}.key`;
const engine = await loadEngine(chain);
const signer = makeSigner(engine);

if (cmd === 'key') {
  const key = await loadKey(keyPath, { create: !!args.create, signer }); const pub = signer.pubkeyOf(key);
  console.log(JSON.stringify({ key: keyPath, pubkey: pub, challenge: '5120' + pub, address: scriptToAddress('5120' + pub, engine.k.params.bech32Hrp) }, null, 1));
  process.exit(0);
}
const dir = args.dir ?? `${homedir()}/.sidestr/${chain.name}`; await mkdir(dir, { recursive: true });

if (cmd === 'genesis') {
  const key = await loadKey(keyPath, { signer });
  const s = await new Siding({ engine, chain, dir, signer, log }).open(key);
  console.log(JSON.stringify({ genesisHash: s.genesisHash, height: s.height(), coins: s.utxo.size }, null, 1)); process.exit(0);
}

if (cmd === 'produce') {
  const key = await loadKey(keyPath, { signer }); const pub = signer.pubkeyOf(key);
  if (chain.challenge !== '5120' + pub) throw new Error(`the key at ${keyPath} is not the chain's signer`);
  const s = await new Siding({ engine, chain, dir, signer, log }).open(key);
  const relays = String(args.relay ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  if (relays.length) subscribe({ relays, chainId: chain.id, verify: engine.nostr.verifyNostrEvent, log, onEvent: (ev, url) => {
    try { const r = s.submit(String(ev.content).trim()); log(`tx ${r.txid.slice(0, 16)}… from ${url} (event ${ev.id.slice(0, 8)}…) accepted, fee ${r.fee}`); }
    catch (e) { log(`${url}: event ${ev.id.slice(0, 8)}… refused: ${e.message}`); }
  } });
  log(`${chain.id}: height ${s.height()} tip ${s.tip().hash.slice(0, 16)}…, ${s.utxo.size} coins`);
  const interval = Number(args.interval ?? 600) * 1000, txInterval = Number(args['tx-interval'] ?? 30) * 1000; let last = Date.now();
  const tick = () => { const due = Date.now() - last >= (s.mempool.size ? txInterval : interval); if (!due) return; try { const r = s.produce(key); last = Date.now(); log(`block ${r.height} ${r.hash.slice(0, 16)}… ${r.txs - 1} txs, fees ${r.fees}`); } catch (e) { log(`produce: ${e.message}`); } };
  setInterval(tick, 1000);
  const port = Number(args.port ?? 3450);
  http.createServer(async (req, res) => {
    const path = req.url.split('?')[0]; const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'range, content-type', 'access-control-allow-methods': 'GET, POST, OPTIONS' };
    const json = (code, o) => { res.writeHead(code, { 'content-type': 'application/json', ...cors }); res.end(JSON.stringify(o)); };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    if (path === '/' || path === '/status.json') return json(200, { chain: chain.id, parent: chain.parent, ...s.tip(), coins: s.utxo.size, mempool: s.mempool.size, relays, signer: pub, genesis: s.genesisHash, interval: interval / 1000 });
    if (path === '/chain.json') return json(200, { ...chain, genesisHash: s.genesisHash });
    if (path === '/tip') return json(200, s.tip());
    if (path === '/blocks.json') return json(200, s.index);
    if (path === '/blocks.dat') {
      const size = statSync(s.dat).size; const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? ''); const start = m ? Number(m[1]) : 0, end = m && m[2] ? Number(m[2]) : size - 1;
      res.writeHead(m ? 206 : 200, { 'content-type': 'application/octet-stream', 'accept-ranges': 'bytes', 'content-length': end - start + 1, ...(m ? { 'content-range': `bytes ${start}-${end}/${size}` } : {}), ...cors });
      return createReadStream(s.dat, { start, end }).pipe(res);
    }
    if (path.startsWith('/coins/')) return json(200, s.coins(path.slice(7).toLowerCase()));
    if (path === '/tx' && req.method === 'POST') { let body = ''; for await (const c of req) { body += c; if (body.length > 262144) { req.destroy(); return json(413, { error: 'transaction over 256 KB' }); } } try { const r = s.submit(body.trim()); log(`tx ${r.txid.slice(0, 16)}… accepted, fee ${r.fee}`); return json(200, r); } catch (e) { return json(400, { error: e.message }); } }
    json(404, { error: 'not found' });
  }).listen(port, '127.0.0.1', () => log(`producer on http://127.0.0.1:${port}/ every ${interval / 1000} s (${txInterval / 1000} s with transactions)`));
}

if (cmd === 'sync') {
  const base = args.url.replace(/\/$/, '');
  const remote = JSON.parse(await readFile(chainFile, 'utf8'));
  const s = await new Siding({ engine, chain: remote, dir, signer, log }).open(existsSync(`${dir}/blocks.json`) ? null : await loadKey(keyPath, { signer }).catch(() => null));
  const index = await (await fetch(`${base}/blocks.json`)).json();
  let n = 0;
  for (const e of index.blocks) {
    if (e.height <= s.height()) { if (s.node.chain[e.height] !== e.hash) throw new Error(`disagree at ${e.height}: ours ${s.node.chain[e.height]} theirs ${e.hash}`); continue; }
    const bytes = new Uint8Array(await (await fetch(`${base}/blocks.dat`, { headers: { range: `bytes=${e.offset + 8}-${e.offset + 8 + e.size - 1}` } })).arrayBuffer());
    s.addBlock(Buffer.from(bytes).toString('hex'), e.hash); n++;
  }
  console.log(JSON.stringify({ synced: n, height: s.height(), tip: s.tip().hash, coins: s.utxo.size, agree: true }, null, 1)); process.exit(0);
}

if (cmd === 'send') {
  // spend the signer's own mature coins: key path on 5120‖pubkey, unified sighash as the chain has it
  const key = await loadKey(keyPath, { signer }); const pub = signer.pubkeyOf(key); const spk = '5120' + pub; const base = args.url.replace(/\/$/, '');
  // --to takes a script hex or a segwit address; the script is what is paid, so an address under
  // another chain's prefix (a parent-chain tb1... for example) is accepted and noted, not refused
  let to; if (/^[0-9a-f]+$/i.test(args.to ?? '')) to = args.to.toLowerCase();
  else { const a = decodeAddress(args.to ?? ''); if (!a) throw new Error(`bad address ${args.to}`); to = a.script; if (a.hrp !== engine.k.params.bech32Hrp) console.error(`note: ${args.to.slice(0, 12)}… carries prefix '${a.hrp}', this chain's is '${engine.k.params.bech32Hrp}' (${scriptToAddress(a.script, engine.k.params.bech32Hrp)}); paying its script ${a.script.slice(0, 12)}…`); }
  const amount = Number(args.amount), fee = Number(args.fee ?? 1000);
  const tip = await (await fetch(`${base}/tip`)).json();
  const coins = (await (await fetch(`${base}/coins/${spk}`)).json()).filter((c) => !c.coinbase || tip.height + 1 - c.height >= engine.k.params.coinbaseMaturity).sort((a, b) => b.value - a.value);
  const picked = []; let sum = 0; for (const c of coins) { picked.push(c); sum += c.value; if (sum >= amount + fee) break; } if (sum < amount + fee) throw new Error(`insufficient: ${sum} sats spendable`);
  const tx = { version: 2, inputs: picked.map((c) => ({ prevout: { txid: c.outpoint.split(':')[0], vout: Number(c.outpoint.split(':')[1]) }, scriptSig: '', sequence: 0xfffffffd })),
    outputs: [{ value: amount, scriptPubKey: to }, ...(sum - amount - fee > 0 ? [{ value: sum - amount - fee, scriptPubKey: spk }] : [])], lockTime: 0, witness: [] };
  const prevouts = picked.map((c) => ({ value: c.value, scriptPubKey: spk }));
  const { SIGHASH_UNIFIED } = await import(`${process.env.SCHEMA ?? homedir() + '/bitcoin-desktop/schema'}/codec/interpreter.js`);
  tx.witness = tx.inputs.map((_, i) => { const ht = 0x01 | SIGHASH_UNIFIED; let m = engine.k.interpreter.sighashUnified(tx, i, prevouts, ht, 2); if (typeof m === 'string') m = engine.hash.hexToBytes(m); return [engine.hash.bytesToHex(signer.schnorrSign(m, key)) + ht.toString(16).padStart(2, '0')]; });
  const hex = engine.k.codec.encodeHex('Transaction', tx);
  if (args.relay) { // as a kind 23500 event from a throwaway key: the transaction authorises itself
    const relays = String(args.relay).split(',').map((x) => x.trim()).filter(Boolean);
    const ev = makeEvents({ signer, hash: engine.hash }).txEvent(signer.randomKey(), chain.id, hex);
    const res = await publish({ relays, event: ev });
    console.log(JSON.stringify({ event: ev.id, kind: TX_KIND, relays: res, inputs: picked.length, amount, fee }, null, 1)); process.exit(0);
  }
  const r = await (await fetch(`${base}/tx`, { method: 'POST', body: hex })).json();
  console.log(JSON.stringify({ ...r, inputs: picked.length, amount, fee }, null, 1)); process.exit(0);
}
if (!['key', 'genesis', 'produce', 'sync', 'send'].includes(cmd)) { console.error('siding key|genesis|produce|sync|send'); process.exit(2); }
