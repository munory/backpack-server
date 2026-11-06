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
import { pendingSignups, users } from '../db/schema.js';
import type { SendMail } from '../mail/mailer.js';
import { signupCodeEmail } from '../mail/templates.js';
import { RATE_LIMITS } from '../rateLimits.js';

// Fastify checks every request against these before our code runs, and
// answers 400 itself if something doesn't fit.
const RegisterBody = Type.Object(
  {
    email: Type.String({ format: 'email', maxLength: 254 }),
    password: Type.String({ minLength: 8, maxLength: 200 }),
    /** The app's language — the email is written in it. */
    language: Type.Optional(Type.Union([Type.Literal('ru'), Type.Literal('en')])),
  },
  { additionalProperties: false },
);

const ConfirmBody = Type.Object(
  {
    email: Type.String({ maxLength: 254 }),
    code: Type.String({ pattern: '^[0-9]{6}$' }),
  },
  { additionalProperties: false },
);

export interface SignupOptions {
  db: Db;
  /** Absent when no mail server is configured — sign-up then answers 503. */
  sendMail: SendMail | undefined;
  /** Key for the codes' HMAC (the server's JWT secret). */
  secret: string;
}

/**
 * Sign-up, in two steps — the account appears only once the email is proven:
 * 1. POST /auth/register — email + password → a 6-digit code is emailed.
 * 2. POST /auth/register/confirm — email + code → the account, signed in.
 */
export function signupRoutes({ db, sendMail, secret }: SignupOptions): FastifyPluginAsyncTypebox {
  return async (app) => {
    const codeOwner = (email: string) => `signup:${email}`;

    app.post(
      '/auth/register',
      { config: { rateLimit: RATE_LIMITS.register }, schema: { body: RegisterBody } },
      async (request, reply) => {
        if (!sendMail) {
          return reply.code(503).send({ error: 'mail_not_configured', message: 'Sign-up is not set up' });
        }
        const email = normalizeEmail(request.body.email);

        // Said straight away rather than after the code: the person most
        // likely just forgot they have an account, and should go sign in.
        const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
        if (existing) {
          return reply.code(409).send({ error: 'email_taken', message: 'An account with this email already exists' });
        }

        const passwordHash = await hashPassword(request.body.password);
        const [recent] = await db
          .select({ id: pendingSignups.id })
          .from(pendingSignups)
          .where(
            and(
              eq(pendingSignups.email, email),
              isNull(pendingSignups.usedAt),
              gt(pendingSignups.createdAt, new Date(Date.now() - RESET_CODE_RESEND_COOLDOWN_MS)),
            ),
          )
          .limit(1);

        if (recent) {
          // Asked again within the minute: no new email (against flooding an
          // inbox), the code already sent keeps working — but with the
          // password typed this time, in case it was changed.
          await db.update(pendingSignups).set({ passwordHash }).where(eq(pendingSignups.id, recent.id));
          return reply.code(202).send({ message: 'Code sent' });
        }

        const code = generateResetCode();
        await db.transaction(async (tx) => {
          // Only the newest code works; old attempts for this email are dropped.
          await tx.delete(pendingSignups).where(eq(pendingSignups.email, email));
          await tx.insert(pendingSignups).values({
            email,
            passwordHash,
            codeHash: hashResetCode(secret, codeOwner(email), code),
            expiresAt: new Date(Date.now() + RESET_CODE_TTL_MS),
          });
        });
        try {
          // Awaited this time (unlike reset): if it can't be sent, the person
          // should hear so now rather than wait for an email that won't come.
          await sendMail(signupCodeEmail(email, code, request.body.language ?? 'en'));
        } catch (error) {
          request.log.error(error, 'could not send the sign-up code');
          return reply.code(503).send({ error: 'mail_failed', message: 'Could not send the email' });
        }
        return reply.code(202).send({ message: 'Code sent' });
      },
    );

    app.post(
      '/auth/register/confirm',
      { config: { rateLimit: RATE_LIMITS.registerConfirm }, schema: { body: ConfirmBody } },
      async (request, reply) => {
        // One answer for every failure: no sign-up started, wrong, expired,
        // or out of tries.
        const invalid = () => reply.code(400).send({ error: 'invalid_code', message: 'The code is wrong or has expired' });

        const email = normalizeEmail(request.body.email);
        const [pending] = await db
          .select()
          .from(pendingSignups)
          .where(
            and(
              eq(pendingSignups.email, email),
              isNull(pendingSignups.usedAt),
              gt(pendingSignups.expiresAt, new Date()),
            ),
          )
          .orderBy(desc(pendingSignups.createdAt))
          .limit(1);
        if (!pending) return invalid();

        if (!sameHash(pending.codeHash, hashResetCode(secret, codeOwner(email), request.body.code))) {
          // Counted in the database itself, so guesses sent at once all count;
          // the fifth miss retires the code.
          await db
            .update(pendingSignups)
            .set({
              attempts: sql`${pendingSignups.attempts} + 1`,
              usedAt: sql`case when ${pendingSignups.attempts} + 1 >= ${RESET_CODE_MAX_ATTEMPTS}
                then now() else ${pendingSignups.usedAt} end`,
            })
            .where(eq(pendingSignups.id, pending.id));
          return invalid();
        }

        const created = await db.transaction(async (tx) => {
          // Spend the code — only if still unspent, so two correct
          // submissions at once can't both go through.
          const [spent] = await tx
            .update(pendingSignups)
            .set({ usedAt: new Date() })
            .where(and(eq(pendingSignups.id, pending.id), isNull(pendingSignups.usedAt)))
            .returning();
          if (!spent) return 'spent' as const;
          // The unique email decides, in case the same address finished
          // signing up another way a moment ago.
          const [user] = await tx
            .insert(users)
            .values({ email, passwordHash: spent.passwordHash })
            .onConflictDoNothing({ target: users.email })
            .returning();
          await tx.delete(pendingSignups).where(eq(pendingSignups.email, email));
          return user ?? ('taken' as const);
        });
        if (created === 'spent') return invalid();
        if (created === 'taken') {
          return reply.code(409).send({ error: 'email_taken', message: 'An account with this email already exists' });
        }

        const tokens = await issueTokens(app, db, created.id);
        return reply.code(201).send({ user: toPublicUser(created), ...tokens });
      },
    );
  };
}
