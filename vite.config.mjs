import { copyFileSync, cpSync, createReadStream, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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

const models = resolve('vendor/caption-models');
const ort = resolve('node_modules/onnxruntime-web/dist');
const runtime = ['ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm'];
const modelFile = /^\/(?:opus-mt-en-(?:es|hi)|flan-t5-small)\/(?:config\.json|generation_config\.json|tokenizer\.json|tokenizer_config\.json|onnx\/(?:encoder_model|decoder_model_merged)_quantized\.onnx)$/;

const captionAssets = {
  name: 'meetrix-caption-models',
  configureServer(server) {
    server.middlewares.use('/caption-models', (req, res, next) => {
      const name = req.url?.split('?')[0] ?? '';
      const runtimeName = name.replace(/^\/runtime\//, '');
      const source = runtime.includes(runtimeName) ? resolve(ort, runtimeName) : modelFile.test(name) ? resolve(models, '.' + name) : null;
      if (!source || !existsSync(source)) return next();
      if (name.endsWith('.wasm')) res.setHeader('Content-Type', 'application/wasm');
      else if (name.endsWith('.mjs')) res.setHeader('Content-Type', 'text/javascript');
      else if (name.endsWith('.json')) res.setHeader('Content-Type', 'application/json');
      else res.setHeader('Content-Type', 'application/octet-stream');
      createReadStream(source).pipe(res);
    });
  },
  writeBundle(output) {
    const destination = resolve(output.dir, 'caption-models');
    const runtimeDir = resolve(destination, 'runtime');
    mkdirSync(runtimeDir, { recursive: true });
    if (existsSync(models)) cpSync(models, destination, { recursive: true });
    for (const file of runtime) copyFileSync(resolve(ort, file), resolve(runtimeDir, file));
    copyFileSync(resolve('public/camera-model/LICENSE.txt'), resolve(destination, 'APACHE-LICENSE.txt'));
    copyFileSync(resolve('node_modules/@huggingface/transformers/LICENSE'), resolve(destination, 'TRANSFORMERS-LICENSE.txt'));
  },
};

export default defineConfig({
  plugins: [react(), cameraAssets, captionAssets],
  worker: { format: 'es' },
  build: {
    rollupOptions: {
      input: { workspace: 'index.html', recording: 'recording.html' },
      output: { manualChunks(id) {
        if (id.includes('livekit')) return 'media';
      } },
    },
  },
});
