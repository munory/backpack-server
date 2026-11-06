/**
 * How often one address (IP) may call each route. Past the limit the server
 * answers 429 "Too Many Requests" until the minute is up — the app shows
 * "too many attempts, try again in a minute".
 *
 * Why: without limits anyone can try thousands of passwords a minute against
 * an account, or make the server send hundreds of reset emails (it's our
 * mail account that gets banned for spam).
 *
 * Why not stricter: mobile networks put many phones behind one shared IP
 * (CGNAT — common with Russian carriers), so a too-low limit would lock out
 * strangers who just happen to share an address. These numbers are far above
 * what one honest person does, and far below what guessing needs.
 *
 * Counters live in the server's memory: they reset when it restarts, and
 * with one server that's all we need.
 */
const perMinute = (max: number) => ({ max, timeWindow: '1 minute' });

export const RATE_LIMITS = {
  /** Every route without its own limit: sync, /me, /health. */
  default: perMinute(120),
  login: perMinute(10),
  register: perMinute(5),
  /** On top of 5 attempts per code. */
  registerConfirm: perMinute(10),
  google: perMinute(10),
  refresh: perMinute(30),
  /** On top of the per-email one-minute cooldown, so it can't be used to spam. */
  resetRequest: perMinute(5),
  /** On top of 5 attempts per code. */
  resetConfirm: perMinute(10),
};
