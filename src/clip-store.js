function openClips() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('meetrix-clips', 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore('clips', { keyPath: ['owner', 'id'] });
      store.createIndex('owner', 'owner');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function access(mode, operation) {
  const db = await openClips();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('clips', mode);
      tx.onabort = () => reject(tx.error);
      const request = operation(tx.objectStore('clips'));
      tx.oncomplete = () => resolve(request.result);
    });
  } finally { db.close(); }
}

export const listClips = owner => access('readonly', store => store.index('owner').getAll(owner));
export const storeClip = clip => access('readwrite', store => store.put(clip));
export const deleteClip = (owner, id) => access('readwrite', store => store.delete([owner, id]));
