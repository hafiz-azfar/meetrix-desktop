import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { pipeline } from 'node:stream/promises';

export function recordingStorage({ endpoint, forcePathStyle, region, accessKey, secret, bucket }) {
  const client = new S3Client({
    region, endpoint, forcePathStyle, maxAttempts: 2,
    credentials: { accessKeyId: accessKey, secretAccessKey: secret },
  });
  return {
    download: (key, abortSignal) => client.send(new GetObjectCommand({ Bucket: bucket, Key: key }), { abortSignal }),
    close: () => client.destroy(),
  };
}

export async function streamRecording(res, storage, key, id, error) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  res.once('close', cancel);
  try {
    let object;
    try {
      object = await storage.download(key, AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]));
    } catch {
      if (controller.signal.aborted) return;
      throw error(502, 'The private recording could not be fetched.');
    }
    if (controller.signal.aborted) {
      object.Body?.destroy();
      return;
    }
    if (!object.Body) throw error(502, 'The private recording had no content.');
    res.type('video/mp4');
    res.set('Content-Disposition', 'attachment; filename="meetrix-' + id + '.mp4"');
    if (Number.isSafeInteger(object.ContentLength)) res.set('Content-Length', String(object.ContentLength));
    await pipeline(object.Body, res, { signal: controller.signal }).catch(failure => {
      if (!controller.signal.aborted) throw failure;
    });
  } finally { res.off('close', cancel); }
}
