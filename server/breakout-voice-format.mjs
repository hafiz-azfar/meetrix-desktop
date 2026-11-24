export const breakoutVoiceTopic = 'meetrix.breakout-voice';
export const breakoutHelpTopic = 'meetrix.breakout-help';
export const voiceRate = 16000;
export const voiceSamples = voiceRate / 4;
export const voiceBytes = voiceSamples * 2;
export const voiceSeconds = 30;
export const voiceFrameCount = voiceSeconds * 4;
export const voiceIdPattern = /^[a-f0-9]{24}$/;
const headerBytes = 26;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function voicePacket(id, index, pcm) {
  const bytes = new Uint8Array(headerBytes + voiceBytes);
  bytes.set(encoder.encode(id), 0);
  new DataView(bytes.buffer).setUint16(24, index);
  bytes.set(pcm, headerBytes);
  return bytes;
}

export function readVoicePacket(payload) {
  if (payload.byteLength !== headerBytes + voiceBytes) return null;
  const id = decoder.decode(payload.subarray(0, 24));
  const index = new DataView(payload.buffer, payload.byteOffset).getUint16(24);
  if (!voiceIdPattern.test(id) || index >= voiceFrameCount) return null;
  return { id, index, samples: new DataView(payload.buffer, payload.byteOffset + headerBytes, voiceBytes) };
}
