import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);

export async function encodePasscode(value) {
  const salt = randomBytes(16);
  const key = await scrypt(value, salt, 32);
  return salt.toString('hex') + ':' + key.toString('hex');
}

export async function checkPasscode(value, stored) {
  if (!value) return false;
  const [salt, expected] = stored.split(':').map(part => Buffer.from(part, 'hex'));
  return timingSafeEqual(expected, await scrypt(value, salt, expected.length));
}
