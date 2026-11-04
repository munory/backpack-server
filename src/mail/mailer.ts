import nodemailer from 'nodemailer';

export interface Email {
  to: string;
  subject: string;
  text: string;
}

/** Sends one email. Passed into the app, so tests can catch mail instead. */
export type SendMail = (email: Email) => Promise<void>;

/**
 * Sends through an SMTP server — the standard protocol mail servers talk.
 * Locally that's Mailpit, which keeps every message for viewing at
 * http://localhost:8025 and delivers nothing; in production, a real mail
 * service. Only the URL changes.
 */
export function createSmtpMailer(smtpUrl: string, from: string): SendMail {
  const transport = nodemailer.createTransport(smtpUrl);
  return async (email) => {
    await transport.sendMail({ from, ...email });
  };
}
