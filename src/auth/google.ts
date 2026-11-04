import { OAuth2Client } from 'google-auth-library';

/** Who Google says signed in. */
export interface GoogleIdentity {
  /** Google's stable id for the person — survives an email change. */
  googleId: string;
  email: string;
  name: string | null;
}

/** Returns the person behind a Google ID token, or null if it isn't genuine. */
export type VerifyGoogleToken = (idToken: string) => Promise<GoogleIdentity | null>;

/**
 * "Sign in with Google" on the phone ends with Google handing the app an ID
 * token — a JWT signed by Google saying who the person is. The server must
 * not take the phone's word for it: anyone can send us any JSON. So it checks
 * with Google's library that the token
 * - is signed by Google (against Google's published public keys),
 * - hasn't expired,
 * - was issued for OUR app (`audience` = our web client id) — a genuine token
 *   meant for some other app must not sign anyone in here,
 * - carries an email Google has verified the person owns.
 */
export function createGoogleVerifier(clientId: string): VerifyGoogleToken {
  const client = new OAuth2Client();
  return async (idToken) => {
    try {
      const ticket = await client.verifyIdToken({ idToken, audience: clientId });
      const payload = ticket.getPayload();
      if (!payload?.sub || !payload.email || payload.email_verified !== true) return null;
      return { googleId: payload.sub, email: payload.email, name: payload.name ?? null };
    } catch {
      return null; // bad signature, expired, wrong audience, malformed…
    }
  };
}
