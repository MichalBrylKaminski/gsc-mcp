import { randomBytes, timingSafeEqual } from 'node:crypto';

/** 256 bits of randomness, URL-safe: for states, nonces, codes, CSRF tokens and session ids. */
export const randomSecret = () => randomBytes(32).toString('base64url');

/** Constant-time string comparison. */
export function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
