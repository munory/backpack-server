import { describe, expect, it } from 'vitest';

import { createGoogleVerifier } from '../src/auth/google.js';

// The real verifier, with Google's own library: garbage in is a plain "no",
// never a crash. (A genuine token can only be checked once the app gets one
// from Google — stage 12.)
describe('Google token verifier', () => {
  const verify = createGoogleVerifier('our-client-id.apps.googleusercontent.com');

  it('says no to things that aren\'t Google tokens', async () => {
    for (const idToken of ['', 'not-a-jwt', 'a.b.c', 'eyJhbGciOiJub25lIn0.eyJzdWIiOiIxIn0.']) {
      await expect(verify(idToken)).resolves.toBeNull();
    }
  });
});
