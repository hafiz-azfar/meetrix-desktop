export const validRoomKey = key => /^[A-Za-z0-9_-]{43}$/.test(key) && 'AEIMQUYcgkosw048'.includes(key.at(-1));

export function generateRoomKey() {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function decodeRoomKey(key) {
  if (!validRoomKey(key)) throw new Error('Enter a complete room encryption key.');
  return Uint8Array.from(atob(key.replace(/-/g, '+').replace(/_/g, '/')), character => character.charCodeAt(0)).buffer;
}
