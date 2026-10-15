// Prints an Ed25519 key pair in the format JWT_PRIVATE_KEY / JWT_PUBLIC_KEY expect. Writes nothing to disk.
import { exportPKCS8, exportSPKI, generateKeyPair } from 'jose';

const { privateKey, publicKey } = await generateKeyPair('EdDSA', { extractable: true });
const b64 = (s: string) => Buffer.from(s).toString('base64');
console.log(`JWT_PRIVATE_KEY=${b64(await exportPKCS8(privateKey))}`);
console.log(`JWT_PUBLIC_KEY=${b64(await exportSPKI(publicKey))}`);
console.error('\nStore these in your secret manager. Never commit them.');
