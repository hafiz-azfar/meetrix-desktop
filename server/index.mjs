import { createApp } from './app.mjs';
import { readConfig } from './config.mjs';

const dev = process.argv.includes('--dev');
const options = readConfig(process.env, { dev, ...(dev ? { assets: null } : {}) });
const { app, close } = createApp(options);
let vite;
if (dev) {
  vite = await (await import('vite')).createServer({ server: { middlewareMode: true, hmr: false }, appType: 'spa' });
  app.use(vite.middlewares);
}
const server = app.listen(options.port, options.host, () => console.log('Meetrix is listening at ' + options.origin));
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => server.close(async () => { await vite?.close(); close(); }));
}
