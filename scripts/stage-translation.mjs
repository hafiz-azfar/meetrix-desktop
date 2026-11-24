import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const destination = resolve('vendor/caption-models');
const packs = [
  ['opus-mt-en-hi', '7aad72006a1588a9c3485ed6203aed99eebbc872', [
    '47a20aef8837b30a1cf9e653bf4c0af0bea8f0d1',
    'b0df89396a01c5b74d3798f21414b1a7885e2794',
    'c482b5926001aaa959c2ad5dc8839d4e9de055f1',
    '53a70bf5735179062864d11ebc9551908ff080a3',
    '3045cd6eaf06db96cff853204d6f0ffeb0c5af238a4f5a87a19fcaa94f7493c4',
    '8baba43a14b15ca4543d30ab36e7d34f2e516fb9af7e0b83b77a5e6a6f66d198',
  ]],
  ['opus-mt-en-es', '4b002a4c7edd54a7ced58877258b87f7efd3f892', [
    '1a12ace130d96e926d1d3ca34ba11c83e51cbcde',
    '015c3e06e8eac3e32e2078ba3140f246e754ae7b',
    '30e25a315e2e6ed4f9fa5ddba3182995f7f4d9f7',
    '84b1761bdf2d7fd192259a854885039a3b8204a1',
    '03434edd1147e6c49e22066e9dc5888235e99cc35a6711d1c4ea5b06455d5da9',
    '58ee5ddd6e22d1693d8722b90c1486afb93700a4376cf28fd74175052ad530ae',
  ]],
  ['flan-t5-small', '311454e83bc784267fd7eef5940ee854144abbec', [
    'be9d2e1a72267d5fb4ccb44d0fa59ee7336cb31c',
    'b6ea5d3139039b6271932361ba30b7c5b979fe26',
    '188313c03c392a12933ea908d0a8b73b043236aa',
    'e99a0d1df1d854da2da3e68e80a83ee379dff248',
    '968ce399b8dcdfd4c36833db51e9f78f327f7272ee9e2777fc2b3c8693208e90',
    '73e2e942503221d7844715a8d824f68d8a2e878483f1c923849c177f0c441df1',
  ]],
];
const files = ['config.json', 'generation_config.json', 'tokenizer.json', 'tokenizer_config.json',
  'onnx/encoder_model_quantized.onnx', 'onnx/decoder_model_merged_quantized.onnx'];

function digest(bytes, expected) {
  if (expected.length === 64) return createHash('sha256').update(bytes).digest('hex');
  return createHash('sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex');
}

async function stage(model, revision, file, hash) {
  const path = join(destination, model, file);
  const cache = await readFile(path).catch(error => {
    if (error.code !== 'ENOENT') throw error;
  });
  if (cache && digest(cache, hash) === hash) return;
  await mkdir(dirname(path), { recursive: true });
  const temporary = path + '.' + process.pid + '.tmp';
  try {
    const url = 'https://huggingface.co/Xenova/' + model + '/resolve/' + revision + '/' + file;
    const response = await fetch(url, { signal: AbortSignal.timeout(180_000) });
    if (!response.ok) throw new Error('Language model asset returned HTTP ' + response.status + ' for ' + model + '/' + file);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (digest(bytes, hash) !== hash) throw new Error('Language model asset failed integrity verification for ' + model + '/' + file);
    await writeFile(temporary, bytes);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

await Promise.all(packs.flatMap(([model, revision, hashes]) => files.map((file, index) =>
  stage(model, revision, file, hashes[index]))));
