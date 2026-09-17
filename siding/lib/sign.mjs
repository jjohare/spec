// Key files for the CLI (32-byte hex, mode 0600, never on a command line); the signing itself is
// lib/schnorr.mjs, kept free of Node imports so a browser can use it too.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';

export { makeSigner } from './schnorr.mjs';

export async function loadKey(path, { create = false, signer } = {}) {
  if (existsSync(path)) return (await readFile(path, 'utf8')).trim();
  if (!create) throw new Error(`no key at ${path} (run: siding key --create)`);
  const key = signer.randomKey(); await mkdir(dirname(path), { recursive: true }); await writeFile(path, key + '\n', { mode: 0o600 }); return key;
}
