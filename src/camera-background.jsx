import React, { useState } from 'react';

const maxImageSize = 12 * 1024 * 1024;
const jpegPrefix = 'data:image/jpeg;base64,';
const imageTypes = ['image/jpeg', 'image/png', 'image/webp'];

export function validBackgroundImage(value) {
  return typeof value === 'string' && value.length <= 1024 * 1024 && value.startsWith(jpegPrefix);
}

export async function applyCameraBackground(track, prefs, onError) {
  const current = track.getProcessor();
  if (prefs.background === 'off') {
    if (current) await track.stopProcessor();
    return;
  }
  if (current) {
    await current.setEffect(prefs.background, prefs.backgroundImage);
    return;
  }
  const { BackgroundProcessor } = await import('./background-processor.js');
  const processor = new BackgroundProcessor(prefs.background, prefs.backgroundImage, onError);
  try { await track.setProcessor(processor); }
  catch (error) {
    await processor.destroy();
    throw error;
  }
}

async function prepareImage(file) {
  if (!imageTypes.includes(file.type) || file.size > maxImageSize) throw new Error('Choose a JPEG, PNG, or WebP image up to 12 MB.');
  const bitmap = await createImageBitmap(file);
  try {
    if (bitmap.width * bitmap.height > 64_000_000) throw new Error('Choose a smaller background image.');
    const scale = Math.min(1, 1280 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d', { alpha: false });
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const image = canvas.toDataURL('image/jpeg', 0.82);
    if (!validBackgroundImage(image)) throw new Error('Could not resize the background image.');
    return image;
  } finally { bitmap.close(); }
}

export function CameraBackgroundFields({ prefs, onChange }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function apply(getChanges) {
    setBusy(true);
    setError('');
    try { await onChange(await getChanges()); }
    catch (failure) { setError(failure.message || 'Could not apply the camera background.'); }
    finally { setBusy(false); }
  }

  async function choose(event) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (file) await apply(async () => ({ backgroundImage: await prepareImage(file), background: 'image' }));
  }

  return <fieldset className="camera-background-fields" disabled={busy}>
    <label className="settings-row"><strong>Camera background</strong>
      <select aria-label="Camera background" value={prefs.background} onChange={event => apply(() => ({ background: event.target.value }))}>
        <option value="off">Off</option>
        <option value="blur">Blur</option>
        <option value="image" disabled={!prefs.backgroundImage}>My image</option>
      </select>
    </label>
    <label className="camera-image-picker">Choose background image
      <input type="file" accept="image/jpeg,image/png,image/webp" onChange={choose} />
    </label>
    {prefs.backgroundImage && <div className="camera-image-sample">
      <img src={prefs.backgroundImage} alt="Your saved camera background" />
      <button type="button" className="button small" onClick={() => apply(() => ({
        background: prefs.background === 'image' ? 'off' : prefs.background, backgroundImage: '',
      }))}>Remove image</button>
    </div>}
    {busy && <p role="status">Updating camera background…</p>}
    {error && <p role="alert" className="error">{error}</p>}
  </fieldset>;
}
