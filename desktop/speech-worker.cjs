const { join } = require('node:path');

function createSpeechRecognizer(directory) {
  const addon = require(join(directory, 'sherpa-onnx.node'));
  const recognizer = addon.createOnlineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      transducer: {
        encoder: join(directory, 'encoder.onnx'), decoder: join(directory, 'decoder.onnx'), joiner: join(directory, 'joiner.onnx'),
      },
      tokens: join(directory, 'tokens.txt'),
      numThreads: 1,
      provider: 'cpu',
      debug: false,
    },
    decodingMethod: 'greedy_search',
    enableEndpoint: true,
    rule1MinTrailingSilence: 2.4,
    rule2MinTrailingSilence: 0.9,
    rule3MinUtteranceLength: 12,
  });
  const stream = addon.createOnlineStream(recognizer);
  let previous = '';

  return (samples, sampleRate) => {
    addon.acceptWaveformOnline(stream, { samples, sampleRate });
    while (addon.isOnlineStreamReady(recognizer, stream)) addon.decodeOnlineStream(recognizer, stream);
    const final = addon.isEndpoint(recognizer, stream);
    const result = JSON.parse(addon.getOnlineStreamResultAsJson(recognizer, stream));
    const text = result.text.replace(/\s+/g, ' ').trim().slice(0, 240);
    const update = text && (text !== previous || final) ? { text, final } : null;
    previous = final ? '' : text;
    if (final) addon.reset(recognizer, stream);
    return update;
  };
}

if (process.parentPort) {
  try {
    const recognize = createSpeechRecognizer(process.argv[2]);
    process.parentPort.on('message', ({ data: { samples, sampleRate } }) => {
      try { process.parentPort.postMessage({ kind: 'processed', result: recognize(samples, sampleRate) }); }
      catch { process.parentPort.postMessage({ kind: 'error' }); }
    });
    process.parentPort.postMessage({ kind: 'ready' });
  } catch { process.parentPort.postMessage({ kind: 'error' }); }
}

module.exports = { createSpeechRecognizer };
