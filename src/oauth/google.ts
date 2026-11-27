import { OAuth2Client } from 'google-auth-library';

/** Who Google says signed in. */
export interface GoogleIdentity {
  email: string;
  emailVerified: boolean;
  /** The nonce from the ID token, to match against the one we sent. */
  nonce?: string;
}

/** The Google sign-in step, behind an interface so tests can replace Google. */
export interface GoogleSignIn {
  /** Where to send the browser; Google returns to our callback with `state` and a code. */
  authUrl(state: string, nonce: string): string;
  /** Exchanges the code and verifies the ID token Google returns. */
  verify(code: string): Promise<GoogleIdentity>;
}

/**
 * Google sign-in with scopes "openid email". Only the ID token is used, to
 * learn the account's email; Google's access and refresh tokens are discarded.
 */
export function googleSignIn(o: { clientId: string; clientSecret: string; redirectUri: string }): GoogleSignIn {
  const client = new OAuth2Client({ clientId: o.clientId, clientSecret: o.clientSecret, redirectUri: o.redirectUri });
  return {
    authUrl: (state, nonce) =>
      client.generateAuthUrl({ scope: ['openid', 'email'], state, nonce, prompt: 'select_account', access_type: 'online', include_granted_scopes: false }),
    async verify(code) {
      const { tokens } = await client.getToken(code);
      if (!tokens.id_token) throw new Error('Google returned no ID token');
      const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: o.clientId });
      const payload = ticket.getPayload();
      if (!payload?.email) throw new Error('Google ID token has no email');
      return { email: payload.email, emailVerified: payload.email_verified === true, nonce: (payload as { nonce?: string }).nonce };
    },
  };
}
