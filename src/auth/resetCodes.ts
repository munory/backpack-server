import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';

export const RESET_CODE_TTL_MS = 15 * 60 * 1000;
export const RESET_CODE_MAX_ATTEMPTS = 5;
/** A new code can be emailed at most once a minute per account. */
export const RESET_CODE_RESEND_COOLDOWN_MS = 60 * 1000;

/** Six random digits, "000000"–"999999" — from the crypto generator, not Math.random. */
export function generateResetCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0');
}

/**
 * The code's fingerprint as stored in the database: an HMAC — a hash mixed
 * with a key only the server knows. A plain hash of 6 digits would be
 * useless: all million of them can be hashed in a second to find a match.
 * Without the key, a leaked database reveals nothing. The user id is mixed
 * in, so the same digits sent to two people hash differently.
 */
export function hashResetCode(secret: string, userId: string, code: string): string {
  return createHmac('sha256', secret).update(`${userId}:${code}`).digest('hex');
}

/** Compares in constant time, so timing doesn't leak how many characters matched. */
export function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
