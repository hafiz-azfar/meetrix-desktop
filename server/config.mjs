import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../', import.meta.url));

export function readConfig(env = process.env, overrides = {}) {
  const port = Number(env.PORT || 4317);
  const originUrl = new URL(env.APP_ORIGIN || 'http://localhost:' + port);
  const livekit = env.LIVEKIT_URL ? new URL(env.LIVEKIT_URL) : null;
  const production = env.NODE_ENV === 'production';
  const local = url => ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (originUrl.href !== originUrl.origin + '/' || !(originUrl.protocol === 'https:' || (originUrl.protocol === 'http:' && local(originUrl)))) {
    throw new Error('APP_ORIGIN must be an HTTPS origin or a loopback HTTP origin.');
  }
  if (livekit && (livekit.href !== livekit.origin + '/' || !(livekit.protocol === 'wss:' || (livekit.protocol === 'ws:' && local(livekit))))) {
    throw new Error('LIVEKIT_URL must be a WSS origin or a loopback WS origin.');
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT.');
  const host = env.HOST || '127.0.0.1';
  if (originUrl.protocol === 'http:' && !['127.0.0.1', '::1', 'localhost'].includes(host)) {
    throw new Error('HTTP mode may bind only to a loopback interface.');
  }
  const trustProxyHops = Number(env.TRUST_PROXY_HOPS || 0);
  if (!Number.isInteger(trustProxyHops) || trustProxyHops < 0 || trustProxyHops > 4) throw new Error('Invalid TRUST_PROXY_HOPS.');
  const credentials = [livekit, env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET];
  if (credentials.some(Boolean) && !credentials.every(Boolean)) throw new Error('Set all three LiveKit settings.');
  if (env.LIVEKIT_API_SECRET && env.LIVEKIT_API_SECRET.length < 32) throw new Error('LiveKit API secrets must be at least 32 characters.');
  if (production && (originUrl.protocol !== 'https:' || livekit?.protocol !== 'wss:' || !env.CLERK_PUBLISHABLE_KEY?.startsWith('pk_live_'))) {
    throw new Error('Production requires HTTPS, WSS and a Clerk production instance.');
  }
  return {
    port, host, trustProxyHops, origin: originUrl.origin,
    clerkPublishableKey: env.CLERK_PUBLISHABLE_KEY,
    livekitUrl: livekit?.origin, livekitKey: env.LIVEKIT_API_KEY, livekitSecret: env.LIVEKIT_API_SECRET,
    databasePath: env.DATABASE_PATH || resolve(root, 'data/meetrix.sqlite'),
    assets: resolve(root, 'dist'), ...overrides,
  };
}
