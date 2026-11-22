import { createRemoteJWKSet, jwtVerify } from 'jose';

export function clerkHost(publishableKey) {
  const encoded = /^(?:pk_live_|pk_test_)([a-zA-Z0-9_-]+)$/.exec(publishableKey ?? '')?.[1];
  if (!encoded) throw new Error('Set CLERK_PUBLISHABLE_KEY to a Clerk publishable key.');
  const decoded = Buffer.from(encoded, 'base64url').toString('utf8');
  if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)+\$$/i.test(decoded)) throw new Error('Invalid Clerk Frontend API host.');
  return decoded.slice(0, -1);
}

export function clerkVerifier({ clerkPublishableKey, origin }) {
  const issuer = 'https://' + clerkHost(clerkPublishableKey);
  const keys = createRemoteJWKSet(new URL(issuer + '/.well-known/jwks.json'), { timeoutDuration: 5000 });
  return async (token) => {
    const { payload } = await jwtVerify(token, keys, {
      issuer,
      algorithms: ['RS256'],
      requiredClaims: ['sub', 'sid', 'exp', 'iat', 'nbf', 'azp'],
      maxTokenAge: '2 minutes',
      clockTolerance: 5,
    });
    if (payload.azp !== origin || payload.sts === 'pending'
      || !/^user_[a-zA-Z0-9]+$/.test(payload.sub)
      || typeof payload.sid !== 'string' || !/^sess_[a-zA-Z0-9]+$/.test(payload.sid)) {
      throw new Error('Session is not valid for this application.');
    }
    return payload.sub;
  };
}
