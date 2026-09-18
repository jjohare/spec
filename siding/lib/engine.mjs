// The engine (bitcoin-desktop/schema) with the Knots BLAKE2b overlay and the sidestr overlay for
// one chain document. SCHEMA points at a checkout; BLAKETESTNODE at bitcoin-blake/blaketestnode.
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { sidestrOverlay } from './overlay.mjs';
import { rulesFor } from './overlays/index.mjs';

export const SCHEMA = process.env.SCHEMA ?? `${homedir()}/bitcoin-desktop/schema`;
export const BLAKETESTNODE = process.env.BLAKETESTNODE ?? `${homedir()}/remote/github.com/bitcoin-blake/blaketestnode`;

export async function loadParentKernel(chain) { const { parentKernel } = await import('./pledge.mjs'); return parentKernel({ cdn: SCHEMA, parent: chain.parent, loadJson: async (u) => JSON.parse(await readFile(u, 'utf8')) }); }

export async function loadEngine(chain) {
  const { createKernel } = await import(`${SCHEMA}/codec/kernel.js`);
  const { knotsBlake2b } = await import(`${SCHEMA}/codec/overlays/knots-blake2b.js`);
  const [pow, hash, secp, nostr] = await Promise.all([import(`${SCHEMA}/codec/pow/knots-header-v2.js`), import(`${SCHEMA}/codec/hash.js`), import(`${SCHEMA}/codec/secp256k1.js`), import(`${SCHEMA}/codec/nostr.js`)]);
  const load = async (p) => JSON.parse(await readFile(`${SCHEMA}/${p}`, 'utf8'));
  const sidestr = sidestrOverlay(chain, { hash, secp }); const rules = rulesFor(chain); const overlays = [knotsBlake2b(await load('schema/overlays/knots-blake2b.jsonld')), sidestr, ...rules.overlays];
  const k = createKernel({ core: await load('schema/core.jsonld'), proof: await load('schema/proof.jsonld'), script: await load('schema/script.jsonld'),
    chain: await load('schema/chain.jsonld'), validate: await load('schema/validate.jsonld'), network: chain.id, overlays });
  if (rules.evm) await rules.evm.init(); // ethereumjs loads lazily; a chain without the rule never pays for it
  return { k, pow, hash, secp, nostr, sidestr, rules };
}
