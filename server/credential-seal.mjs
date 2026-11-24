import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export function credentialSeal(encodedKey) {
  const key = Buffer.from(encodedKey, 'base64url');
  return {
    seal(text, owner) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(Buffer.from(owner));
      return Buffer.concat([iv, cipher.update(text), cipher.final(), cipher.getAuthTag()]).toString('base64url');
    },
    unseal(text, owner) {
      const data = Buffer.from(text, 'base64url');
      const cipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
      cipher.setAAD(Buffer.from(owner));
      cipher.setAuthTag(data.subarray(-16));
      return Buffer.concat([cipher.update(data.subarray(12, -16)), cipher.final()]).toString();
    },
  };
}
