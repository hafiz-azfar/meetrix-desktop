class CaptionAudio extends AudioWorkletProcessor {
  constructor() {
    super();
    this.offset = 0;
    this.buffer = new Float32Array(Math.round(sampleRate / 4));
  }

  process(inputs) {
    const mono = inputs[0]?.[0];
    if (!mono) return true;
    for (const value of mono) {
      this.buffer[this.offset++] = Math.max(-1, Math.min(1, value));
      if (this.offset === this.buffer.length) {
        this.port.postMessage(this.buffer, [this.buffer.buffer]);
        this.buffer = new Float32Array(Math.round(sampleRate / 4));
        this.offset = 0;
      }
    }
    return true;
  }
}

registerProcessor('meetrix-caption-audio', CaptionAudio);
