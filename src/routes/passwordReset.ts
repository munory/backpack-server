import { type FastifyPluginAsyncTypebox, Type } from '@fastify/type-provider-typebox';
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';

import { hashPassword } from '../auth/passwords.js';
import {
  generateResetCode,
  hashResetCode,
  RESET_CODE_MAX_ATTEMPTS,
  RESET_CODE_RESEND_COOLDOWN_MS,
  RESET_CODE_TTL_MS,
  sameHash,
} from '../auth/resetCodes.js';
import { issueTokens } from '../auth/tokens.js';
import { normalizeEmail, toPublicUser } from '../auth/users.js';
import type { Db } from '../db/client.js';
import { RATE_LIMITS } from '../rateLimits.js';
import { passwordResets, refreshTokens, users } from '../db/schema.js';
import type { SendMail } from '../mail/mailer.js';
import { resetCodeEmail } from '../mail/templates.js';

const RequestBody = Type.Object(
  {
    email: Type.String({ maxLength: 254 }),
    /** The app's language — the email is written in it. */
    language: Type.Optional(Type.Union([Type.Literal('ru'), Type.Literal('en')])),
  },
  { additionalProperties: false },
);

const ConfirmBody = Type.Object(
  {
    email: Type.String({ maxLength: 254 }),
    code: Type.String({ pattern: '^[0-9]{6}$' }),
    newPassword: Type.String({ minLength: 8, maxLength: 200 }),
  },
  { additionalProperties: false },
);

export interface PasswordResetOptions {
  db: Db;
  /** Absent when no mail server is configured — reset then answers 503. */
  sendMail: SendMail | undefined;
  /** Key for the codes' HMAC (the server's JWT secret). */
  secret: string;
}

/**
 * "Forgot password", in two steps:
 * 1. POST /auth/password-reset/request — email a 6-digit code.
 * 2. POST /auth/password-reset/confirm — code + new password → signed in.
 */
export function passwordResetRoutes({ db, sendMail, secret }: PasswordResetOptions): FastifyPluginAsyncTypebox {
  return async (app) => {
    app.post('/auth/password-reset/request', { config: { rateLimit: RATE_LIMITS.resetRequest }, schema: { body: RequestBody } }, async (request, reply) => {
      if (!sendMail) {
        return reply
          .code(503)
          .send({ error: 'mail_not_configured', message: 'Password reset is not set up' });
      }
      const email = normalizeEmail(request.body.email);
      const [user] = await db.select().from(users).where(eq(users.email, email));

      // At most one email a minute per account — against flooding someone's
      // inbox (or our mail service). Inside the minute nothing is sent and the
      // previous code keeps working; the answer stays the same, since a
      // "wait" reply would itself reveal the account exists. The app counts
      // the minute down on its own.
      const [recent] = user
        ? await db
            .select({ id: passwordResets.id })
            .from(passwordResets)
            .where(
              and(
                eq(passwordResets.userId, user.id),
                gt(passwordResets.createdAt, new Date(Date.now() - RESET_CODE_RESEND_COOLDOWN_MS)),
              ),
            )
            .limit(1)
        : [];

      if (user && !recent) {
        const code = generateResetCode();
        await db.transaction(async (tx) => {
          // Only the newest code works: asking again retires the old one.
          await tx
            .update(passwordResets)
            .set({ usedAt: new Date() })
            .where(and(eq(passwordResets.userId, user.id), isNull(passwordResets.usedAt)));
          await tx.insert(passwordResets).values({
            userId: user.id,
            tokenHash: hashResetCode(secret, user.id, code),
            expiresAt: new Date(Date.now() + RESET_CODE_TTL_MS),
          });
        });
        // Not awaited: sending takes a moment, and an existing account must
        // not answer noticeably slower than a missing one.
        sendMail(resetCodeEmail(user.email, code, request.body.language ?? 'en')).catch((error) =>
          request.log.error(error, 'could not send the reset code'),
        );
      }

      // 202 "Accepted" — and the same answer whether or not the account
      // exists, so this can't be used to find out who has one.
      return reply
        .code(202)
        .send({ message: 'If an account exists for this email, a code has been sent' });
    });

    app.post('/auth/password-reset/confirm', { config: { rateLimit: RATE_LIMITS.resetConfirm }, schema: { body: ConfirmBody } }, async (request, reply) => {
      // One answer for every failure: unknown email, no code requested,
      // wrong, expired, or out of tries.
      const invalid = () =>
        reply.code(400).send({ error: 'invalid_code', message: 'The code is wrong or has expired' });

      const email = normalizeEmail(request.body.email);
      const [user] = await db.select().from(users).where(eq(users.email, email));
      if (!user) return invalid();

      const [reset] = await db
        .select()
        .from(passwordResets)
        .where(
          and(
            eq(passwordResets.userId, user.id),
            isNull(passwordResets.usedAt),
            gt(passwordResets.expiresAt, new Date()),
          ),
        )
        .orderBy(desc(passwordResets.createdAt))
        .limit(1);
      if (!reset) return invalid();

      if (!sameHash(reset.tokenHash, hashResetCode(secret, user.id, request.body.code))) {
        // Count the miss in the database itself (attempts + 1, not a value
        // computed here), so guesses sent at the same time all count. The
        // fifth miss retires the code.
        await db
          .update(passwordResets)
          .set({
            attempts: sql`${passwordResets.attempts} + 1`,
            usedAt: sql`case when ${passwordResets.attempts} + 1 >= ${RESET_CODE_MAX_ATTEMPTS}
              then now() else ${passwordResets.usedAt} end`,
          })
          .where(eq(passwordResets.id, reset.id));
        return invalid();
      }

      const passwordHash = await hashPassword(request.body.newPassword);
      const updated = await db.transaction(async (tx) => {
        // Spend the code — and only if it's still unspent, so two correct
        // submissions at the same moment can't both go through.
        const [spent] = await tx
          .update(passwordResets)
          .set({ usedAt: new Date() })
          .where(and(eq(passwordResets.id, reset.id), isNull(passwordResets.usedAt)))
          .returning();
        if (!spent) return null;
        // New password, so every device signs in again — if the password was
        // changed because someone else had it, they're out.
        await tx
          .update(refreshTokens)
          .set({ revokedAt: new Date() })
          .where(and(eq(refreshTokens.userId, user.id), isNull(refreshTokens.revokedAt)));
        const [changed] = await tx
          .update(users)
          .set({ passwordHash })
          .where(eq(users.id, user.id))
          .returning();
        return changed!;
      });
      if (!updated) return invalid();

      const tokens = await issueTokens(app, db, user.id);
      return { user: toPublicUser(updated), ...tokens };
    });
  };
}
