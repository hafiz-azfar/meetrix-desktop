import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const sherpaRelease = '2.0.3';
const nativeIntegrity = 'UDPUCNmuhWWC0oNMphHjgdRE0M8bVbUFXk9AyyJUuOtubmxhQBLz2sd2v6RWIAXSDh/7GwPbImLqAWI51ITTNQ==';
const modelRevision = 'd42f2d9f7ca24806fb667456a18a9f1b60f70d16';
const modelUrl = 'https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-en-20M-2023-02-17/resolve/' + modelRevision + '/';
const modelAssets = [
  ['encoder.onnx', 'encoder-epoch-99-avg-1.int8.onnx', '3810755ce7c3ab26b42a8bcf39d191308fa27fb0f53358823ba46141d03b7eb3'],
  ['decoder.onnx', 'decoder-epoch-99-avg-1.onnx', '45a7f940ecfb53d89fa270ad11b88b961e53a317203eb24b1c8e95ed208b0f30'],
  ['joiner.onnx', 'joiner-epoch-99-avg-1.int8.onnx', 'e085d73b593cf9b0707f370dbd656d58327d3fe36d80d849202ef81df02cb01e'],
  ['tokens.txt', 'tokens.txt', '49e3c2646595fd907228b3c6787069658f67b17377c60aeb8619c4551b2316fb'],
];
const nativeFiles = ['sherpa-onnx.node', 'sherpa-onnx-c-api.dll', 'onnxruntime.dll', 'onnxruntime_providers_shared.dll'];

async function lockedAsset(path, url, checksum, algorithm = 'sha256', encoding = 'hex') {
  const verify = bytes => createHash(algorithm).update(bytes).digest(encoding) === checksum;
  const cached = await readFile(path).catch(error => {
    if (error.code !== 'ENOENT') throw error;
  });
  if (cached && verify(cached)) return;
  const response = await fetch(url, { signal: AbortSignal.timeout(180000) });
  if (!response.ok) throw new Error('Speech asset download failed for ' + url);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!verify(bytes)) throw new Error('Speech asset failed integrity verification for ' + url);
  await writeFile(path, bytes);
}

export async function stageSpeechRuntime(runtime) {
  const speech = join(runtime, 'speech');
  await mkdir(speech, { recursive: true });
  const archive = join(dirname(runtime), 'sherpa-onnx-win-x64-' + sherpaRelease + '.tgz');
  const registry = 'https://registry.npmjs.org/sherpa-onnx-win-x64/-/';
  const onnxNoticesUrl = 'https://cdn.jsdelivr.net/gh/microsoft/onnxruntime@v1.20.1/';
  await Promise.all([
    lockedAsset(archive, registry + 'sherpa-onnx-win-x64-' + sherpaRelease + '.tgz', nativeIntegrity, 'sha512', 'base64'),
    ...modelAssets.map(([file, source, hash]) => lockedAsset(join(speech, file), modelUrl + source, hash)),
    lockedAsset(join(speech, 'ONNX-RUNTIME-LICENSE.txt'), onnxNoticesUrl + 'LICENSE',
      '2f07c72751aed99790b8a4869cf2311df85a860b22ded05fa22803587a48922c'),
    lockedAsset(join(speech, 'ONNX-RUNTIME-THIRD-PARTY.txt'), onnxNoticesUrl + 'ThirdPartyNotices.txt',
      'cf7342f7ba482ef715ae58f5f497a8d3564fa255164175aea324cd293c5701a0'),
    copyFile(resolve('public/camera-model/LICENSE.txt'), join(speech, 'APACHE-LICENSE.txt')),
  ]);
  execFileSync('tar.exe', ['-xf', archive, '-C', speech, '--strip-components=1', ...nativeFiles.map(file => 'package/' + file)], {
    windowsHide: true, stdio: 'inherit',
  });
  await writeFile(join(speech, 'NOTICE.txt'), [
    'sherpa-onnx ' + sherpaRelease + ', The next-gen Kaldi team, Apache License 2.0.',
    'https://github.com/k2-fsa/sherpa-onnx',
    'Streaming English Zipformer en-20M, Apache License 2.0.',
    modelUrl,
    'ONNX Runtime, Microsoft Corporation, MIT License.',
    'https://github.com/microsoft/onnxruntime',
    '',
  ].join('\n'));
}
