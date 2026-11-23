import { FilesetResolver, ImageSegmenter } from '@mediapipe/tasks-vision';

const assets = '/camera-model';
const frameInterval = 1000 / 15;

function createCanvas() {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) throw new Error('This computer cannot render camera backgrounds.');
  return { canvas, context };
}

function cover(context, image, width, height) {
  const scale = Math.max(width / image.naturalWidth, height / image.naturalHeight);
  const imageWidth = image.naturalWidth * scale;
  const imageHeight = image.naturalHeight * scale;
  context.drawImage(image, (width - imageWidth) / 2, (height - imageHeight) / 2, imageWidth, imageHeight);
}

export class BackgroundProcessor {
  name = 'meetrix-camera-background';
  #output = createCanvas();
  #foreground = createCanvas();
  #mask = createCanvas();
  #maskPixels;
  #video = document.createElement('video');
  #segmenter;
  #image;
  #frame;
  #lastFrame = -Infinity;
  #closed = false;
  #failed = false;

  constructor(mode, image, onError) {
    this.mode = mode;
    this.image = image;
    this.onError = onError;
  }

  async init({ track }) {
    try {
      const video = this.#video;
      if (!this.#output.canvas.captureStream || !video.requestVideoFrameCallback) {
        throw new Error('Camera backgrounds are unavailable in this browser.');
      }
      await this.setEffect(this.mode, this.image);
      const files = await FilesetResolver.forVisionTasks(assets);
      if (this.#closed) return;
      const segmenter = await ImageSegmenter.createFromOptions(files, {
        baseOptions: { modelAssetPath: assets + '/selfie_segmenter_landscape.tflite', delegate: 'CPU' },
        runningMode: 'VIDEO', outputCategoryMask: false, outputConfidenceMasks: true,
      });
      if (this.#closed) { segmenter.close(); return; }
      this.#segmenter = segmenter;

      const size = track.getSettings();
      this.#resize(size.width || 640, size.height || 480);
      this.#clearOutput();
      [this.processedTrack] = this.#output.canvas.captureStream(0).getVideoTracks();
      video.muted = true;
      video.playsInline = true;
      await this.restart({ track });
    } catch (error) {
      await this.destroy();
      throw error;
    }
  }

  async setEffect(mode, source) {
    let image;
    if (mode === 'image') {
      if (!source) throw new Error('Choose a background image first.');
      image = new Image();
      image.src = source;
      await image.decode();
    }
    if (this.#closed) return;
    this.mode = mode;
    this.image = source;
    this.#image = image;
  }

  async restart({ track }) {
    if (this.#closed) return;
    this.#video.cancelVideoFrameCallback(this.#frame);
    this.#clearOutput();
    this.#video.srcObject = new MediaStream([track]);
    await this.#video.play();
    if (!this.#closed) this.#frame = this.#video.requestVideoFrameCallback(this.#render);
  }

  #resize(width, height) {
    const scale = Math.min(1, 640 / Math.max(width, height));
    const w = Math.max(2, Math.round(width * scale / 2) * 2);
    const h = Math.max(2, Math.round(height * scale / 2) * 2);
    if (this.#output.canvas.width === w && this.#output.canvas.height === h) return;
    for (const surface of [this.#output, this.#foreground]) {
      surface.canvas.width = w;
      surface.canvas.height = h;
    }
  }

  #clearOutput(emit = true) {
    const { canvas, context } = this.#output;
    context.fillStyle = '#202438';
    context.fillRect(0, 0, canvas.width, canvas.height);
    if (emit) this.processedTrack?.requestFrame();
  }

  #draw(personMask) {
    if (!personMask) throw new Error('Camera foreground could not be detected.');
    const { width: maskWidth, height: maskHeight } = personMask;
    if (this.#maskPixels?.width !== maskWidth || this.#maskPixels?.height !== maskHeight) {
      this.#mask.canvas.width = maskWidth;
      this.#mask.canvas.height = maskHeight;
      this.#maskPixels = this.#mask.context.createImageData(maskWidth, maskHeight);
    }
    const confidence = personMask.getAsFloat32Array();
    for (let index = 0; index < confidence.length; index++) {
      this.#maskPixels.data[index * 4 + 3] = confidence[index] >= 0.7 ? 255 : 0;
    }
    this.#mask.context.putImageData(this.#maskPixels, 0, 0);

    const { width, height } = this.#output.canvas;
    const front = this.#foreground.context;
    front.clearRect(0, 0, width, height);
    front.drawImage(this.#video, 0, 0, width, height);
    front.globalCompositeOperation = 'destination-in';
    front.filter = 'blur(2px)';
    front.drawImage(this.#mask.canvas, 0, 0, width, height);
    front.filter = 'none';
    front.globalCompositeOperation = 'source-over';

    const output = this.#output.context;
    this.#clearOutput(false);
    if (this.#image) cover(output, this.#image, width, height);
    else {
      const edge = 32;
      output.filter = 'blur(16px)';
      output.drawImage(this.#video, -edge, -edge, width + 2 * edge, height + 2 * edge);
      output.filter = 'none';
    }
    output.drawImage(this.#foreground.canvas, 0, 0);
  }

  #render = now => {
    if (this.#closed) return;
    this.#frame = this.#video.requestVideoFrameCallback(this.#render);
    if (now - this.#lastFrame < frameInterval - 1) return;
    this.#lastFrame = now;
    const { videoWidth, videoHeight } = this.#video;
    if (!videoWidth || !videoHeight) return;
    try {
      this.#resize(videoWidth, videoHeight);
      // The bundled single-channel selfie model supplies person confidence as its first mask.
      this.#segmenter.segmentForVideo(this.#video, now, result => this.#draw(result.confidenceMasks[0]));
      this.processedTrack.requestFrame();
      this.#failed = false;
    } catch {
      this.#clearOutput();
      if (!this.#failed) this.onError?.('The camera background could not process frames.');
      this.#failed = true;
    }
  };

  async destroy() {
    if (this.#closed) return;
    this.#closed = true;
    this.#video.cancelVideoFrameCallback?.(this.#frame);
    this.#video.srcObject = null;
    this.processedTrack?.stop();
    this.#segmenter?.close();
    this.#image = null;
  }
}
