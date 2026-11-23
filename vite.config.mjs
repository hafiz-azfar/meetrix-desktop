import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const visionFiles = new Map(['vision_wasm_internal', 'vision_wasm_nosimd_internal']
  .flatMap(name => ['js', 'wasm'].map(ext => {
    const file = `${name}.${ext}`;
    return [file, new URL(`./node_modules/@mediapipe/tasks-vision/wasm/${file}`, import.meta.url)];
  })));

const cameraAssets = {
  name: 'meetrix-camera-assets',
  configureServer(server) {
    server.middlewares.use('/camera-model', (req, res, next) => {
      const file = req.url?.split('?')[0].slice(1);
      const source = visionFiles.get(file);
      if (!source) return next();
      res.setHeader('Content-Type', file.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
      res.end(readFileSync(source));
    });
  },
  generateBundle() {
    for (const [file, source] of visionFiles) {
      this.emitFile({ type: 'asset', fileName: 'camera-model/' + file, source: readFileSync(source) });
    }
  },
};

export default defineConfig({
  plugins: [react(), cameraAssets],
  build: {
    rollupOptions: {
      output: { manualChunks(id) {
        if (id.includes('livekit')) return 'media';
      } },
    },
  },
});
