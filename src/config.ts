/**
 * Server settings, read from environment variables: locally they come from
 * .env, on the VPS from Docker. Read once at startup, so a missing setting
 * stops the server right away with a clear message instead of failing later
 * on the first request.
 */
export interface Config {
  port: number;
  host: string;
  databaseUrl: string;
  jwtSecret: string;
  /** The web client id from Google Cloud; without it Google sign-in is off. */
  googleClientId: string | undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is not set — copy .env.example to .env and fill it in');
  }
  const jwtSecret = env.JWT_SECRET;
  if (!jwtSecret || jwtSecret.length < 32) {
    throw new Error('JWT_SECRET must be set to at least 32 random characters — see .env.example');
  }
  return {
    port: Number(env.PORT ?? 3000),
    // This computer only by default; the VPS sets 0.0.0.0 inside Docker.
    host: env.HOST ?? '127.0.0.1',
    databaseUrl,
    jwtSecret,
    googleClientId: env.GOOGLE_CLIENT_ID || undefined,
  };
}
