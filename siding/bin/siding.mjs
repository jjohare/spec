#!/usr/bin/env node
// The txbt4 siding, or any sidestr chain from a chain document (SPEC 10, 11).
//   siding new --name <name> --prefix <hrp> [--parent ID] [--comment ...] [--interval 600] [--port N] [--out FILE]
//       a whole chain: document at chains/<name>/chain.json, signer key, genesis, and the lines to run and mirror it
//   siding key --create [--chain chain.json]        the signer key (~/.sidestr/<name>.key) and its challenge
//   siding genesis --chain chain.json --dir DIR     write block 0
//   siding produce --chain chain.json --dir DIR [--port 3450] [--interval 600] [--tx-interval 30]
//   siding sync --url http://host:3450 --dir DIR    validate a producer's chain into DIR
//   siding send --url http://host:3450 --chain chain.json --to <address or script> --amount <sats> [--fee <sats>]
//       the fee defaults to the transaction's size at the chain's minFeeRate (chain.json, sat/vB)
//   siding send --relay wss://a,wss://b ...   the same, published as a kind 23500 event instead of POSTed
//   siding send --pegout --to <parent address> --amount <sats>   burn on the sidechain; the peg wallet pays it on the parent (SPEC 7)
//   siding produce ... --relay wss://a,wss://b  also follow those relays for kind 23500 transactions
//   siding faucet --chain chain.json --url http://127.0.0.1:3450 --relay wss://a,wss://b --key-file F [--amount 100000] [--per-address-hours 24] [--per-hour 20]
//       pay kind 23501 requests (content: an address) from this key, once per address per period, capped per hour
//   siding produce ... --announce-mirror https://a/siding[,https://b/siding]  publish the tip (NIP-333, kind 33333, d = chain id)
//       to the relays after every block, naming those mirrors; a client that knows only the chain id finds the chain
//   siding produce ... --parent-wallet <name>  the parent wallet holding the peg outputs: every burn is paid from it (SPEC 7)
//   siding produce ... --parent-rpc http://host:port/ --parent-cookie FILE [--parent-from H] [--parent-poll 60]
//       with a parent view (SPEC 6): scan the parent for this chain's peg-ins and claim each once it has
//       pegConfirmations; scan state in <dir>/pegins.json
import { decodeAddress, scriptToAddress } from '../lib/address.mjs';
import { writeFile, readFile } from 'node:fs/promises';
import { mkdir } from 'node:fs/promises';
import { existsSync, statSync, createReadStream } from 'node:fs';
import http from 'node:http';
import { homedir } from 'node:os';
import { loadEngine } from '../lib/engine.mjs';
import { makeSigner, loadKey } from '../lib/sign.mjs';
import { makeEvents, subscribe, publish, TX_KIND } from '../lib/relay.mjs';
import { makeParent, scanPegins, pegStatus, payPegout, paidPegouts } from '../lib/parent.mjs';
import { buildSpend, deliver, resolveTo } from '../lib/spend.mjs';
import { FAUCET_KIND, makeEvents as mkEvents } from '../lib/relay.mjs';
import { tipEvent, TIP_HEADERS } from '../lib/announce.mjs';
import { Siding } from '../lib/chain.mjs';

const args = Object.fromEntries(process.argv.slice(3).map((a, i, all) => a.startsWith('--') ? [a.slice(2), all[i + 1] === undefined || all[i + 1].startsWith('--') ? true : all[i + 1]] : []).filter(Boolean));
const cmd = process.argv[2];
const log = (s) => console.log(`${new Date().toISOString().slice(11, 19)} ${s}`);
// `siding new`: a whole chain from a name — document, signer key, genesis, and the lines to run it
if (cmd === 'new') {
  const name = args.name, prefix = args.prefix; if (!name || !prefix || typeof name !== 'string' || typeof prefix !== 'string') throw new Error('siding new --name <name> --prefix <bech32 hrp> [--parent btc:testnet4-blake2b] [--comment ...] [--out chains/<name>/chain.json]');
  if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(name)) throw new Error('a name is lower-case letters, digits and dashes'); if (!/^[a-z]{1,8}$/.test(prefix)) throw new Error('a prefix is 1 to 8 lower-case letters');
  const out = args.out ?? new URL(`../../chains/${name}/chain.json`, import.meta.url).pathname; if (existsSync(out)) throw new Error(`${out} exists; pick another name or remove it`);
  const magic = Array.from(new TextEncoder().encode(`sidestr:${name}`)).reduce((h, b) => ((h * 31 + b) >>> 0), 7).toString(16).padStart(8, '0');
  const doc = { id: `sidestr:${name}`, name, parent: args.parent ?? 'btc:testnet4-blake2b', comment: args.comment ?? `A sidestr chain beside ${args.parent ?? 'btc:testnet4-blake2b'}, made ${new Date().toISOString().slice(0, 10)}. Level 1: one signer. Coins with no value.`,
    challenge: '', powLimit: '7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff', addressPrefix: prefix, magic, pegConfirmations: Number(args['peg-confirmations'] ?? 6), refundBlocks: 10000, pegoutBlocks: 144, pegoutMin: Number(args['pegout-min'] ?? 10000), minFeeRate: Number(args['min-fee-rate'] ?? 1),
    genesisTime: Math.floor(Date.now() / 1000), pegs: [], signer: '' };
  const eng = await loadEngine(doc); const sg = makeSigner(eng); const kp = args['key-file'] ?? `${homedir()}/.sidestr/${name}.key`; const key = await loadKey(kp, { create: true, signer: sg }); const pub = sg.pubkeyOf(key);
  doc.challenge = '5120' + pub; doc.signer = pub;
  const dir = args.dir ?? `${homedir()}/.sidestr/${name}`; await mkdir(dir, { recursive: true }); const engine2 = await loadEngine(doc);
  const s = await new Siding({ engine: engine2, chain: doc, dir, signer: makeSigner(engine2), log }).open(key); doc.genesisHash = s.genesisHash;
  await mkdir(new URL('.', 'file://' + out).pathname, { recursive: true }); await writeFile(out, JSON.stringify(doc, null, 1) + '\n');
  const port = args.port ?? 3450, interval = args.interval ?? 600;
  console.log(JSON.stringify({ chain: doc.id, document: out, key: kp, signer: pub, address: scriptToAddress(doc.challenge, prefix), genesisHash: doc.genesisHash, dir }, null, 1));
  console.log(`
next:
  1. run it (a pm2 entry, or a shell; hosts are yours, never in this repository):
     siding produce --chain ${out} --dir ${dir} --port ${port} --interval ${interval} --tx-interval 10 \\
       --relay wss://nos.lol,wss://relay.damus.io,wss://relay.primal.net \\
       --parent-rpc http://127.0.0.1:PORT/ --parent-cookie PATH/.cookie --parent-from HEIGHT --parent-wallet ${name}-peg \\
       --announce-mirror https://HOST/PATH/${name}
  2. mirror ${dir}/blocks.dat, blocks.json and the document as chain.json at that URL (rsync in a loop; CORS open, Range requests)
  3. on the parent: a wallet named ${name}-peg for the peg outputs (createwallet), and a peg-in is any output to one of its
     addresses with OP_RETURN pegin:${doc.id}:<sidechain script bytes>; the producer claims it at ${doc.pegConfirmations} confirmations
  4. explorer ?chain=${doc.id}, wallet ?chain=${doc.id}; the directory lists it after the first announcement
  5. commit ${out}: the document is the chain's identity (its genesis hash is derived from it)`);
  process.exit(0);
}
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
  // SPEC 11: announce the tip on the relays after every block, naming the mirrors
  const mirrors = String(args['announce-mirror'] ?? '').split(',').map((x) => x.trim().replace(/\/+$/, '')).filter(Boolean); let announced = -1;
  let announceRetryAt = 0, announcing = false; // a failed announcement is retried a minute later; one in flight at a time
  const announce = async () => {
    if (!relays.length || !mirrors.length || announcing) return; const tip = s.tip(); if (tip.height === announced || Date.now() < announceRetryAt) return; announcing = true; try {
    const from = Math.max(0, tip.height - TIP_HEADERS + 1); const headersHex = []; for (let h = from; h <= tip.height; h++) headersHex.push(engine.k.codec.encodeHex('BlockHeader', s.node.headers[h]));
    const ev = tipEvent({ events: mkEvents({ signer, hash: engine.hash }), key, chainId: chain.id, headersHex, tip: tip.height, mirrors });
    const res = await publish({ relays, event: ev }); const okc = Object.values(res).filter((r) => r === 'ok').length; if (okc) announced = tip.height; else announceRetryAt = Date.now() + 60000;
    log(`announced tip ${tip.height} ${tip.hash.slice(0, 16)}… (kind 33333, ${headersHex.length} headers, ${mirrors.length} mirror(s)) to ${okc}/${relays.length} relay(s)`);
    } finally { announcing = false; }
  };
  if (mirrors.length) { setInterval(() => announce().catch((e) => log(`announce: ${e.message}`)), 3000); }
  if (relays.length) subscribe({ relays, chainId: chain.id, verify: engine.nostr.verifyNostrEvent, log, onEvent: (ev, url) => {
    try { const r = s.submit(String(ev.content).trim()); log(`tx ${r.txid.slice(0, 16)}… from ${url} (event ${ev.id.slice(0, 8)}…) accepted, fee ${r.fee}`); }
    catch (e) { log(`${url}: event ${ev.id.slice(0, 8)}… refused: ${e.message}`); }
  } });
  log(`${chain.id}: height ${s.height()} tip ${s.tip().hash.slice(0, 16)}…, ${s.utxo.size} coins`);
  const interval = Number(args.interval ?? 600) * 1000, txInterval = Number(args['tx-interval'] ?? 30) * 1000; let last = Date.now();
  const tick = () => { const due = Date.now() - last >= (s.mempool.size ? txInterval : interval); if (!due) return; try { const r = s.produce(key); last = Date.now(); log(`block ${r.height} ${r.hash.slice(0, 16)}… ${r.txs - 1} txs, fees ${r.fees}`); } catch (e) { log(`produce: ${e.message}`); } };
  setInterval(tick, 1000);
  // SPEC 6: with a parent view, claim confirmed peg-ins. Which outpoints are already claimed is
  // derived from the chain itself on open; only the scan position and what was found persist.
  const parent = args['parent-rpc'] ? await makeParent({ url: args['parent-rpc'], cookieFile: args['parent-cookie'] ?? `${homedir()}/.bitcoin/.cookie`, wallet: args['parent-wallet'] ?? null }) : null;
  const pegFile = `${dir}/pegins.json`; let pegState = { scanned: Number(args['parent-from'] ?? 0) - 1, pegins: [] };
  try { pegState = JSON.parse(await readFile(pegFile, 'utf8')); } catch {}
  const savePegs = () => writeFile(pegFile, JSON.stringify(pegState, null, 1)); let scanning = false;
  const pegTick = async () => {
    if (!parent || scanning) return; scanning = true;
    try {
      const tip = await parent.height();
      if (tip > pegState.scanned) {
        const found = await scanPegins(parent, { chainId: chain.id, from: pegState.scanned + 1, to: tip });
        for (const p of found) if (!pegState.pegins.some((q) => q.txid === p.txid && q.vout === p.vout)) { pegState.pegins.push(p); log(`peg-in ${p.txid.slice(0, 16)}…:${p.vout}: ${p.amount} sats to ${p.script.slice(0, 12)}…, parent h${p.height}`); }
        pegState.scanned = tip; await savePegs();
      }
      const claims = [], need = chain.pegConfirmations ?? 6;
      for (const p of pegState.pegins) {
        if (p.refused || s.claimed(p.txid, p.vout)) continue;
        const st = await pegStatus(parent, p); if (!st.unspent) { p.refused = 'spent on the parent'; log(`peg-in ${p.txid.slice(0, 16)}…:${p.vout} is spent on the parent; not claimable`); continue; }
        if (st.confirmations >= need) claims.push({ txid: p.txid, vout: p.vout, amount: p.amount, script: p.script });
      }
      if (claims.length) { const r = s.produce(key, { claims }); last = Date.now(); log(`block ${r.height} ${r.hash.slice(0, 16)}… claims ${claims.length} peg-in(s): ${claims.map((c) => `${c.amount} sats to ${c.script.slice(0, 12)}…`).join(', ')}`); await savePegs(); }
    } catch (e) { log(`parent: ${e.message}`); } finally { scanning = false; }
  };
  if (parent) { log(`parent ${args['parent-rpc']}: peg-ins for ${chain.id} from h${pegState.scanned + 1}, claim at ${chain.pegConfirmations ?? 6} confirmations`); setInterval(pegTick, Number(args['parent-poll'] ?? 60) * 1000); pegTick(); }
  // SPEC 7: every burn the chain validated is paid on the parent from the peg wallet, once. The
  // record is <dir>/pegouts.json, reconciled on start with the wallet's own history so a crash
  // between paying and recording cannot pay twice.
  const outFile = `${dir}/pegouts.json`; let outState = { paid: {} }; let paying = false;
  try { outState = JSON.parse(await readFile(outFile, 'utf8')); } catch {}
  const pegoutTick = async () => {
    if (!parent?.walletRpc || paying) return; paying = true;
    try {
      const due = s.pegouts().filter((b) => !outState.paid[`${b.txid}:${b.vout}`]); if (!due.length) return;
      const already = await paidPegouts(parent, { chainId: chain.id });
      for (const b of due) { const key = `${b.txid}:${b.vout}`;
        if (already.has(b.txid)) { outState.paid[key] = { parentTxid: already.get(b.txid), value: b.value, script: b.script, height: b.height, at: Math.floor(Date.now() / 1000), reconciled: true }; log(`peg-out ${key.slice(0, 16)}… was already paid on the parent in ${already.get(b.txid).slice(0, 16)}…`); continue; }
        const r = await payPegout(parent, { chainId: chain.id, txid: b.txid, script: b.script, value: b.value });
        outState.paid[key] = { parentTxid: r.parentTxid, address: r.address, value: b.value, script: b.script, height: b.height, at: Math.floor(Date.now() / 1000) };
        await writeFile(outFile, JSON.stringify(outState, null, 1)); log(`peg-out ${key.slice(0, 16)}…: paid ${b.value} sats to ${r.address} on the parent, txid ${r.parentTxid.slice(0, 16)}…`); }
      await writeFile(outFile, JSON.stringify(outState, null, 1));
    } catch (e) { log(`peg-out: ${e.message}`); } finally { paying = false; }
  };
  if (parent?.walletRpc) { log(`parent wallet ${parent.wallet}: peg-outs for ${chain.id} are paid from it, ${Object.keys(outState.paid).length} paid so far`); setInterval(pegoutTick, Number(args['parent-poll'] ?? 60) * 1000); setTimeout(pegoutTick, 5000); }
  else if (parent) log('no --parent-wallet: peg-outs are recorded but not paid');
  const port = Number(args.port ?? 3450);
  http.createServer(async (req, res) => {
    const path = req.url.split('?')[0]; const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'range, content-type', 'access-control-allow-methods': 'GET, POST, OPTIONS' };
    const json = (code, o) => { res.writeHead(code, { 'content-type': 'application/json', ...cors }); res.end(JSON.stringify(o)); };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    if (path === '/' || path === '/status.json') return json(200, { chain: chain.id, parent: chain.parent, ...s.tip(), coins: s.utxo.size, mempool: s.mempool.size, minFeeRate: s.minFeeRate(), relays, announce: mirrors.length ? { mirrors, announced } : null, pegouts: { burned: s.pegouts().length, paid: Object.keys(outState.paid).length, min: s.pegoutMin(), payer: parent?.wallet ?? null }, pegins: parent ? { scanned: pegState.scanned, known: pegState.pegins.length, claimed: pegState.pegins.filter((p) => s.claimed(p.txid, p.vout)).length, pending: pegState.pegins.filter((p) => !p.refused && !s.claimed(p.txid, p.vout)).length } : null, signer: pub, genesis: s.genesisHash, interval: interval / 1000 });
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
  // spend this key's mature coins as the producer reports them; the fee from size unless --fee
  const key = await loadKey(keyPath, { signer }); const relays = String(args.relay ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  const b = await buildSpend({ engine, chain, signer, key, url: args.url ?? 'http://127.0.0.1:3450', to: args.to, amount: args.amount, fee: args.fee != null ? Number(args.fee) : null, pegout: !!args.pegout });
  if (b.note) console.error(`note: ${b.note}`);
  const d = await deliver({ engine, chain, signer, hex: b.hex, relays, url: args.url ?? 'http://127.0.0.1:3450' });
  console.log(JSON.stringify({ txid: b.txid, ...d, inputs: b.inputs, amount: b.amount, fee: b.fee, vsize: b.vsize }, null, 1)); process.exit(d.error ? 1 : 0);
}
if (cmd === 'faucet') {
  // SPEC 11: a kind 23501 event asks for coins at the address in its content; pay it from this key,
  // once per address per --per-address-hours, at most --per-hour payouts an hour. State on disk.
  const key = await loadKey(keyPath, { signer }); const me = signer.pubkeyOf(key); const url = args.url ?? 'http://127.0.0.1:3450';
  const relays = String(args.relay ?? '').split(',').map((x) => x.trim()).filter(Boolean); if (!relays.length) throw new Error('--relay is needed: the faucet listens on relays');
  const amount = Number(args.amount ?? 100000), perAddressMs = Number(args['per-address-hours'] ?? 24) * 3600e3, perHour = Number(args['per-hour'] ?? 20);
  const stateFile = args.state ?? `${args.dir ?? `${homedir()}/.sidestr/${chain.name}`}/faucet.json`; let state = { paid: {}, recent: [] };
  try { state = JSON.parse(await readFile(stateFile, 'utf8')); } catch {}
  const save = () => writeFile(stateFile, JSON.stringify(state, null, 1));
  log(`faucet for ${chain.id}: ${amount} sats per request, ${perHour}/h, one per address per ${perAddressMs / 3600e3} h; key ${me.slice(0, 12)}…, coins from ${url}`);
  let busy = Promise.resolve();
  subscribe({ relays, chainId: chain.id, kind: FAUCET_KIND, verify: engine.nostr.verifyNostrEvent, log, onEvent: (ev, from) => { busy = busy.then(async () => {
    let dest; try { dest = resolveTo(String(ev.content ?? '').trim(), engine.k.params.bech32Hrp); } catch (e) { return log(`request ${ev.id.slice(0, 8)}… ignored: ${e.message}`); }
    const now = Date.now(); state.recent = (state.recent ?? []).filter((t) => now - t < 3600e3);
    const last = state.paid[dest.script]; if (last && now - last < perAddressMs) return log(`request ${ev.id.slice(0, 8)}… for ${dest.script.slice(0, 12)}… refused: paid ${Math.round((now - last) / 60e3)} min ago`);
    if (state.recent.length >= perHour) return log(`request ${ev.id.slice(0, 8)}… refused: ${perHour} payouts already this hour`);
    try {
      const b = await buildSpend({ engine, chain, signer, key, url, to: dest.script, amount }); const d = await deliver({ engine, chain, signer, hex: b.hex, relays, url });
      if (d.error) return log(`request ${ev.id.slice(0, 8)}…: could not deliver: ${d.error}`);
      state.paid[dest.script] = now; state.recent.push(now); await save();
      log(`paid ${amount} sats to ${dest.script.slice(0, 12)}… (${scriptToAddress(dest.script, engine.k.params.bech32Hrp)}) tx ${b.txid.slice(0, 16)}… via ${d.via}, request ${ev.id.slice(0, 8)}… from ${from}`);
    } catch (e) { log(`request ${ev.id.slice(0, 8)}…: ${e.message}`); }
  }).catch((e) => log(`faucet: ${e.message}`)); } });
}
if (!['key', 'genesis', 'produce', 'sync', 'send', 'faucet'].includes(cmd)) { console.error('siding key|genesis|produce|sync|send|faucet'); process.exit(2); }
