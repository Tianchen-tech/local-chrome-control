import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, createPublicKey } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export function identity(text, expectedId) {
  if (!/^[a-p]{32}$/.test(expectedId || '')) throw new Error('Expected a 32-character Chrome Web Store item ID.');
  if (text.includes('PRIVATE KEY')) throw new Error('Only a PUBLIC key is accepted.');
  const raw = text.replace(/-----BEGIN PUBLIC KEY-----|-----END PUBLIC KEY-----|\s/g, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) throw new Error('Invalid public-key encoding.');
  const der = Buffer.from(raw, 'base64');
  if (der.toString('base64') !== raw) throw new Error('Noncanonical public-key encoding.');
  const parsed = createPublicKey({ key: der, format: 'der', type: 'spki' });
  if (parsed.asymmetricKeyType !== 'rsa') throw new Error('Expected an RSA public key.');
  const id = [...createHash('sha256').update(der).digest('hex').slice(0, 32)]
    .map(c => String.fromCharCode(97 + parseInt(c, 16))).join('');
  if (id !== expectedId) throw new Error('Public key does not match the dashboard item ID. No files changed.');
  return { key: raw, id };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [keyFile, expectedId] = process.argv.slice(2);
  if (!keyFile) throw new Error('Usage: node scripts/bind-store-key.mjs PUBLIC_KEY_FILE STORE_ITEM_ID');
  const bound = identity(await fs.readFile(keyFile, 'utf8'), expectedId);
  const root = fileURLToPath(new URL('../', import.meta.url));
  const filename = path.join(root, 'extension', 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(filename, 'utf8'));
  if (manifest.key && manifest.key !== bound.key) throw new Error('Refusing to replace a different identity.');
  manifest.key = bound.key;
  await fs.writeFile(filename, JSON.stringify(manifest, null, 2) + '\n');
  console.log('Bound public release copy to chrome-extension://' + bound.id + '/. No Chrome configuration was changed.');
}
