import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { config } from '../config.js';

const scrypt = promisify(crypto.scrypt) as (pw: string, salt: Buffer, len: number, opts: crypto.ScryptOptions) => Promise<Buffer>;
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

/** scrypt password hash: scrypt$N$r$p$salt$hash */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password.normalize('NFKC'), salt, 64, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) {
    // constant-ish time even when the user does not exist
    await scrypt(password, crypto.randomBytes(16), 64, SCRYPT);
    return false;
  }
  const [alg, N, r, p, salt, hash] = stored.split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scrypt(password.normalize('NFKC'), Buffer.from(salt, 'base64'), expected.length, {
    N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem,
  });
  return crypto.timingSafeEqual(expected, actual);
}

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const sha256 = (v: string | Buffer) => crypto.createHash('sha256').update(v).digest('hex');

const key = Buffer.from(config.ENCRYPTION_KEY, 'hex');
/** AES-256-GCM for integration secrets and MFA seeds at rest. */
export function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `v1.${iv.toString('base64')}.${c.getAuthTag().toString('base64')}.${enc.toString('base64')}`;
}
export function decrypt(payload: string): string {
  const [v, iv, tag, data] = payload.split('.');
  if (v !== 'v1') throw new Error('Unknown ciphertext version');
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
}

export function hmacSha256Hex(secret: string, body: string | Buffer) {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}
export function safeEqual(a: string, b: string) {
  const ab = Buffer.from(a); const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

export const passwordPolicy = (pw: string): string | null => {
  if (pw.length < 10) return 'Password must be at least 10 characters';
  if (pw.length > 128) return 'Password is too long';
  if (!/[a-zA-Z]/.test(pw) || !/[0-9]/.test(pw)) return 'Password must contain letters and numbers';
  return null;
};
