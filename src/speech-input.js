import workletUrl from './speech-capture-worklet.js?url&no-inline';

export async function captureCaptionAudio(track, onAudio, onError) {
  if (track?.kind !== 'audio' || track.readyState !== 'live' || !track.enabled) {
    throw new Error('Turn on your meeting microphone before starting automatic captions.');
  }

  const context = new AudioContext({ sampleRate: 16000 });
  let source;
  let node;
  let pending = false;
  let stopped = false;

  function stop() {
    if (stopped) return;
    stopped = true;
    track.removeEventListener('ended', stop);
    source?.disconnect();
    if (node) {
      node.port.onmessage = null;
      node.disconnect();
      node.port.close();
    }
    void context.close().catch(() => {});
  }

  try {
    if (!context.audioWorklet) throw new Error('This device cannot capture audio for automatic captions.');
    await Promise.all([context.audioWorklet.addModule(workletUrl), context.resume()]);
    if (track.readyState !== 'live' || !track.enabled) throw new Error('Your meeting microphone is no longer active.');
    source = context.createMediaStreamSource(new MediaStream([track]));
    node = new AudioWorkletNode(context, 'meetrix-caption-audio', {
      numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit',
      outputChannelCount: [1],
    });
    node.port.onmessage = async ({ data }) => {
      if (stopped || pending || !track.enabled || track.muted || track.readyState !== 'live') return;
      pending = true;
      try { await onAudio({ samples: data, sampleRate: context.sampleRate }); }
      catch (error) {
        if (!stopped) {
          stop();
          onError?.(error);
        }
      } finally { pending = false; }
    };
    // The worklet writes silence. Connecting it keeps the audio graph running without replaying the microphone.
    source.connect(node);
    node.connect(context.destination);
    track.addEventListener('ended', stop, { once: true });
    return { stop };
  } catch (error) {
    stop();
    throw error;
  }
}
