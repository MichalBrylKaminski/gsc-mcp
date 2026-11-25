import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** 256 bits of randomness, URL-safe: for tokens, states, nonces, codes, CSRF tokens and session ids. */
export const randomSecret = () => randomBytes(32).toString('base64url');

/** Constant-time string comparison. */
export function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** SHA-256 of a string, as bytes. */
export const sha256 = (s: string) => createHash('sha256').update(s).digest();

/** SHA-256 of a string, as lowercase hex. */
export const sha256Hex = (s: string) => sha256(s).toString('hex');
