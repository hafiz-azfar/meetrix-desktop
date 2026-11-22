import { ExternalE2EEKeyProvider, Room } from 'livekit-client';
import EncryptionWorker from 'livekit-client/e2ee-worker?worker';
import { decodeRoomKey } from './encryption.js';

export async function createEncryptedRoom(key, options) {
  const keyProvider = new ExternalE2EEKeyProvider({ keySize: 256 });
  await keyProvider.setKey(decodeRoomKey(key));
  const worker = new EncryptionWorker();
  try {
    const room = new Room({ ...options, encryption: { keyProvider, worker } });
    await room.setE2EEEnabled(true);
    return { room, dispose: () => room.disconnect().finally(() => worker.terminate()) };
  } catch (error) {
    worker.terminate();
    throw error;
  }
}
