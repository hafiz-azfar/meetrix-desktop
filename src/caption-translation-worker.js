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
let model;
let busy = false;
self.onmessage = async ({ data: { language, id, text, action } }) => {
  const summarize = action === 'summarize';
  const limit = summarize ? 2400 : 240;
  if (busy || (!summarize && !languages.has(language)) || typeof id !== 'string' ||
      typeof text !== 'string' || !text || text.length > limit) return;
  busy = true;
  try {
    const nextModel = summarize ? 'flan-t5-small' : 'opus-mt-en-' + language;
    if (nextModel !== model) {
      await loaded?.dispose();
      loaded = await pipeline(summarize ? 'text2text-generation' : 'translation', nextModel, { device: 'wasm', dtype: 'q8' });
      model = nextModel;
    }
    const prompt = summarize ? 'Summarize these meeting notes in two sentences. Include decisions and next steps.\n\n' + text : text;
    const [result] = await loaded(prompt, { max_new_tokens: 120, num_beams: summarize ? 2 : 1 });
    const output = summarize ? result.generated_text : result.translation_text;
    if (!output?.trim()) throw new Error('Empty language model output.');
    self.postMessage({ id, text: output.trim().slice(0, summarize ? 1200 : 560) });
  } catch {
    self.postMessage({ id, error: true });
  } finally { busy = false; }
};
