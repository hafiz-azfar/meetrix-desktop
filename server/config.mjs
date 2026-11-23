import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { insforgeSettings } from './auth.mjs';

export const root = fileURLToPath(new URL('../', import.meta.url));

function cloudRecordingSettings(env, origin, livekit) {
  if (!env.MEETRIX_CLOUD_RECORDING || env.MEETRIX_CLOUD_RECORDING === 'false') return undefined;
  if (env.MEETRIX_CLOUD_RECORDING !== 'true') throw new Error('MEETRIX_CLOUD_RECORDING must be true or false.');
  if (origin.protocol !== 'https:' || livekit?.protocol !== 'wss:') {
    throw new Error('Cloud recording requires a hosted HTTPS workspace and WSS LiveKit.');
  }
  const bucket = env.MEETRIX_EGRESS_S3_BUCKET;
  const region = env.MEETRIX_EGRESS_S3_REGION;
  const accessKey = env.MEETRIX_EGRESS_S3_ACCESS_KEY;
  const secret = env.MEETRIX_EGRESS_S3_SECRET;
  if (!bucket || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) ||
      !region || !/^[a-z0-9-]{1,64}$/.test(region) || !accessKey || !secret) {
    throw new Error('Set a private S3 bucket, region, access key, and secret for cloud recording.');
  }
  let endpoint;
  if (env.MEETRIX_EGRESS_S3_ENDPOINT) {
    const url = new URL(env.MEETRIX_EGRESS_S3_ENDPOINT);
    if (url.protocol !== 'https:' || url.href !== url.origin + '/') throw new Error('Use an HTTPS origin for the cloud recording storage endpoint.');
    endpoint = url.origin;
  }
  return { bucket, region, accessKey, secret, endpoint, forcePathStyle: Boolean(endpoint) };
}

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
  if (production && (originUrl.protocol !== 'https:' || livekit?.protocol !== 'wss:')) {
    throw new Error('Production requires HTTPS and a WSS LiveKit URL.');
  }
  return {
    port, host, trustProxyHops, origin: originUrl.origin,
    ...insforgeSettings(env.INSFORGE_URL, env.INSFORGE_ANON_KEY),
    cloudRecording: cloudRecordingSettings(env, originUrl, livekit),
    livekitUrl: livekit?.origin, livekitKey: env.LIVEKIT_API_KEY, livekitSecret: env.LIVEKIT_API_SECRET,
    databasePath: env.DATABASE_PATH || resolve(root, 'data/meetrix.sqlite'),
    assets: resolve(root, 'dist'), ...overrides,
  };
}
