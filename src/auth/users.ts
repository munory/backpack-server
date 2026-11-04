import type { users } from '../db/schema.js';

type User = typeof users.$inferSelect;

/** One spelling per address: "  Kate@Mail.ru " and "kate@mail.ru" are the same account. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** What the app gets to see about an account — never the password hash. */
export function toPublicUser(user: User) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    hasPassword: user.passwordHash !== null,
    hasGoogle: user.googleId !== null,
  };
}
