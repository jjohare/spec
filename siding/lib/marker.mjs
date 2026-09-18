// The peg-in marker (SPEC 6): `pegin:<chain id>:` then the sidechain output script as raw bytes.
// Pure: a browser builds a pledge (SPEC 6.2) with it; parent.mjs re-exports it for Node.
const enc = new TextEncoder();
export function pegMarkerData(chainId, script) { return enc.encode(`pegin:${chainId}:`).length + script.length / 2 <= 80 ? new Uint8Array([...enc.encode(`pegin:${chainId}:`), ...fromHex(script)]) : enc.encode(`pegin:${chainId}:${script}`); }
export function parsePegMarker(spkHex, chainId) {
  const m = /^6a(?:4c)?([0-9a-f]{2})([0-9a-f]*)$/i.exec(spkHex); if (!m) return null; const d = fromHex(m[2]); if (parseInt(m[1], 16) !== d.length) return null;
  const prefix = enc.encode(`pegin:${chainId}:`); if (d.length <= prefix.length) return null;
  for (let i = 0; i < prefix.length; i++) if (d[i] !== prefix[i]) return null;
  const rest = d.slice(prefix.length); const asText = dec.decode(rest);
  if (/^([0-9a-f]{2})+$/i.test(asText)) return asText.toLowerCase(); // hex form
  return toHex(rest);                                                 // raw form
}
