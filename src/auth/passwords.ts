import { hash, verify } from '@node-rs/argon2';

/**
 * Passwords are never stored — only an argon2id hash: a one-way "fingerprint"
 * that can check a password but can't be turned back into one. argon2 is
 * deliberately slow and memory-hungry, so guessing passwords from a leaked
 * hash takes far too long. Each hash gets its own random salt, so two people
 * with the same password still get different hashes.
 */
export function hashPassword(password: string): Promise<string> {
  return hash(password); // argon2id with the library's recommended settings
}

/** True if the password matches the hash; false for anything else. */
export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false; // a malformed hash is just "doesn't match"
  }
}

// A hash of a throwaway password, checked against when the email doesn't
// exist — so "no such email" takes as long as "wrong password", and response
// time doesn't reveal which emails have accounts.
let dummyHash: Promise<string> | undefined;

/** Spends the same time as a real check, then says no. */
export async function verifyAgainstNothing(password: string): Promise<false> {
  dummyHash ??= hash('not-a-real-password');
  await verifyPassword(await dummyHash, password);
  return false;
}
