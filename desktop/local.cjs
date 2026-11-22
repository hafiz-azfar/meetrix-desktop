const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { mkdir, readFile, writeFile } = require('node:fs/promises');
const { join } = require('node:path');
const net = require('node:net');
const dgram = require('node:dgram');

function freeTcpPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function freeUdpPort() {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    socket.once('error', reject);
    socket.bind(0, '127.0.0.1', () => {
      const { port } = socket.address();
      socket.close(() => resolve(port));
    });
  });
}

async function waitForLiveKit(child, url) {
  for (let attempt = 0; attempt < 25; attempt++) {
    if (child.exitCode !== null || child.signalCode !== null || child.spawnFailure) break;
    const response = await fetch(url, { signal: AbortSignal.timeout(600) }).catch(() => null);
    if (response?.ok) return;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('The local LiveKit server did not start.');
}

async function startLocal({ directory, runtime, origin = 'http://localhost:4317', dependencies, testInstance }) {
  let instance = testInstance;
  if (!instance) {
    try { instance = JSON.parse(await readFile(join(runtime, 'local-instance.json'), 'utf8')); }
    catch { return null; }
  }
  if (!instance?.clerkPublishableKey) return null;
  await mkdir(directory, { recursive: true });
  const port = await freeTcpPort();
  const udp = await freeUdpPort();
  const key = 'MK_' + randomBytes(12).toString('hex');
  const secret = randomBytes(32).toString('hex');
  const configPath = join(directory, 'livekit.yaml');
  await writeFile(configPath, [
    'port: ' + port, 'bind_addresses: ["127.0.0.1"]', 'rtc:', '  tcp_port: 0',
    '  udp_port: ' + udp, '  node_ip: 127.0.0.1', '  use_external_ip: false', '  enable_loopback_candidate: true',
    'room:', '  auto_create: false', '  enable_remote_unmute: false', 'keys:', '  ' + key + ': ' + secret, '',
  ].join('\n'), { mode: 0o600 });
  const child = spawn(join(runtime, 'livekit-server.exe'), ['--config', configPath], {
    cwd: directory, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], shell: false,
  });
  child.stderr.resume();
  child.once('error', error => { child.spawnFailure = error; });
  let backend;
  let server;
  try {
    await waitForLiveKit(child, 'http://127.0.0.1:' + port);
    const { createApp } = await import('../server/app.mjs');
    backend = createApp({
      origin, clerkPublishableKey: instance.clerkPublishableKey, desktop: true,
      livekitUrl: 'ws://127.0.0.1:' + port, livekitKey: key, livekitSecret: secret,
      databasePath: join(directory, 'meetrix.sqlite'), assets: join(__dirname, '..', 'dist'),
    }, dependencies);
    server = await new Promise((resolve, reject) => {
      const listener = backend.app.listen(Number(new URL(origin).port), '127.0.0.1', () => resolve(listener));
      listener.once('error', reject);
    });
    return {
      origin,
      stop() {
        server.close(() => backend.close());
        server.closeAllConnections();
        child.kill();
      },
    };
  } catch (error) {
    server?.close();
    backend?.close();
    child.kill();
    throw error;
  }
}

module.exports = { startLocal };
