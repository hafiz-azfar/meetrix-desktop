import { env, pipeline } from '@huggingface/transformers';

const languages = new Set(['hi', 'es']);
const assets = new URL('/caption-models/', self.location.origin);
env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = assets.href;
env.useBrowserCache = false;
env.backends.onnx.wasm.wasmPaths = new URL('runtime/', assets).href;
env.backends.onnx.wasm.numThreads = 1;
env.backends.onnx.wasm.proxy = false;

let loaded;
let busy = false;
self.onmessage = async ({ data: { language, id, text } }) => {
  if (busy || !languages.has(language) || typeof id !== 'string' || typeof text !== 'string' || !text || text.length > 240) return;
  busy = true;
  try {
    if (!loaded) loaded = await pipeline('translation', 'opus-mt-en-' + language, { device: 'wasm', dtype: 'q8' });
    const [{ translation_text: translated }] = await loaded(text, { max_new_tokens: 120, num_beams: 1 });
    if (!translated || typeof translated !== 'string') throw new Error('Empty translation.');
    self.postMessage({ id, text: translated.trim().slice(0, 560) });
  } catch {
    self.postMessage({ id, error: true });
  } finally { busy = false; }
};
