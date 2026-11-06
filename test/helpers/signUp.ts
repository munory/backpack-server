import type { App } from '../../src/app.js';
import type { Email, SendMail } from '../../src/mail/mailer.js';

/** Catches the server's email instead of sending it. */
export function createInbox() {
  const mail: Email[] = [];
  const sendMail: SendMail = async (email) => {
    mail.push(email);
  };
  /** The 6-digit code from the newest email to [to] ("482 913" → "482913"). */
  const lastCodeFor = (to: string) => {
    const email = mail.filter((m) => m.to === to.toLowerCase()).at(-1);
    const match = email?.subject.match(/(\d{3}) (\d{3})/);
    if (!match) throw new Error(`no code emailed to ${to}`);
    return match[1]! + match[2]!;
  };
  return { mail, sendMail, lastCodeFor };
}

/** Anything that can read a code someone was emailed. */
export interface Inbox {
  lastCodeFor(to: string): string;
}

/**
 * Signs up the way a person does: email + password, then the code from the
 * email. Returns the final answer — 201 with `{user, accessToken,
 * refreshToken}` — or the first one that wasn't a success.
 */
export async function signUp(
  app: App,
  inbox: Inbox,
  email: string,
  password = 'my password',
  options: { remoteAddress?: string; extra?: object } = {},
) {
  const started = await app.inject({
    method: 'POST',
    url: '/auth/register',
    payload: { email, password, ...options.extra },
    remoteAddress: options.remoteAddress,
  });
  if (started.statusCode !== 202) return started;
  return app.inject({
    method: 'POST',
    url: '/auth/register/confirm',
    payload: { email, code: inbox.lastCodeFor(email) },
    remoteAddress: options.remoteAddress,
  });
}
