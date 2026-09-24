// Transactions over Nostr (SPEC section 11): a signed transaction travels as a kind 23500 event
// whose content is the transaction hex and whose `chain` tag names the chain. The event's key is
// anyone's -- the transaction authorises itself -- so a wallet signs the event with a throwaway
// key and never needs an identity. Node 22+ has WebSocket built in; there is no dependency.
export const TX_KIND = 23500;
export const FAUCET_KIND = 23501; // content: an address (or script hex); a faucet may answer with a kind 23500 payment
export const PARENT_TX_KIND = 23503; // content: a signed PARENT transaction as hex; a producer with a node broadcasts it if, and only if, its node's default policy accepts it

export function makeEvents({ signer, hash }) {
  const eventId = (ev) => hash.bytesToHex(hash.sha256(new TextEncoder().encode(JSON.stringify([0, ev.pubkey, ev.created_at, ev.kind, ev.tags, ev.content]))));
  const signEvent = (key, { kind, tags = [], content = '', created_at = Math.floor(Date.now() / 1000) }) => {
    const ev = { pubkey: signer.pubkeyOf(key), created_at, kind, tags, content }; ev.id = eventId(ev);
    ev.sig = hash.bytesToHex(signer.schnorrSign(hash.hexToBytes(ev.id), key)); return ev;
  };
  return { eventId, signEvent, txEvent: (key, chainId, hex) => signEvent(key, { kind: TX_KIND, tags: [['chain', chainId]], content: hex }), parentTxEvent: (key, chainId, hex) => signEvent(key, { kind: PARENT_TX_KIND, tags: [['chain', chainId]], content: hex }) };
}

// A producer's side: follow one or more relays for this chain's transactions, reconnecting with
// backoff, and hand each verified, not-yet-seen event to onEvent. Nothing is trusted from the
// relay: the event signature is checked, then the transaction itself must validate to be included.
export function subscribe({ relays, chainId, verify, onEvent, log = () => {}, since = 3600, kind = TX_KIND, tag = 'chain' }) {
  const seen = new Set(); const sockets = new Map(); let closed = false;
  const connect = (url, backoff = 1000) => {
    if (closed) return;
    const retry = () => { sockets.delete(url); if (!closed) setTimeout(() => connect(url, Math.min(backoff * 2, 60000)), backoff); };
    let ws; try { ws = new WebSocket(url); } catch (e) { log(`relay ${url}: ${e.message}`); return retry(); }
    sockets.set(url, ws);
    // filter by kind only: relays index single-letter tags for filtering and refuse `#chain`
    // ("unindexed tag filter"), so the chain tag is checked here on each event instead
    ws.onopen = () => { backoff = 1000; ws.send(JSON.stringify(['REQ', 'k' + kind, { kinds: [kind], since: Math.floor(Date.now() / 1000) - since }])); log(`relay ${url}: following kind ${kind} for ${chainId}`); };
    ws.onmessage = (m) => {
      let msg; try { msg = JSON.parse(typeof m.data === 'string' ? m.data : String(m.data)); } catch { return; }
      if (msg[0] !== 'EVENT' || !msg[2] || typeof msg[2] !== 'object') return; const ev = msg[2];
      if (ev.kind !== kind || typeof ev.id !== 'string' || seen.has(ev.id)) return;
      if (!Array.isArray(ev.tags) || !ev.tags.some((t) => Array.isArray(t) && t[0] === tag && t[1] === chainId)) return; // another chain's, or untagged
      seen.add(ev.id); if (seen.size > 10000) seen.delete(seen.values().next().value);
      let ok = false; try { ok = !!verify(ev); } catch {} if (!ok) return log(`relay ${url}: event ${ev.id.slice(0, 8)}… has a bad signature`);
      onEvent(ev, url);
    };
    ws.onerror = () => {}; ws.onclose = retry;
  };
  for (const url of relays) connect(url);
  return { relays, close() { closed = true; for (const ws of sockets.values()) { try { ws.close(); } catch {} } } };
}

// A wallet's or the CLI's side: publish one event to each relay and report what each said.
export function publish({ relays, event, timeout = 8000 }) {
  return Promise.all(relays.map((url) => new Promise((resolve) => {
    let ws, done = false; const finish = (r) => { if (done) return; done = true; clearTimeout(t); resolve([url, r]); try { ws?.close(); } catch {} };
    const t = setTimeout(() => finish('timeout'), timeout);
    try { ws = new WebSocket(url); } catch (e) { return finish(e.message); }
    ws.onopen = () => ws.send(JSON.stringify(['EVENT', event]));
    ws.onmessage = (m) => { let msg; try { msg = JSON.parse(typeof m.data === 'string' ? m.data : String(m.data)); } catch { return; } if (msg[0] === 'OK' && msg[1] === event.id) finish(msg[2] ? 'ok' : (msg[3] || 'rejected')); };
    ws.onerror = () => {}; ws.onclose = () => finish('closed before OK');
  }))).then(Object.fromEntries);
}
