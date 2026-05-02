const encoder = new TextEncoder();
const decoder = new TextDecoder();
const ACCESS_PROOF_PREFIX = 'two-person-chat:v1:access';
const MESSAGE_KEY_PREFIX = 'two-person-chat:v1:e2ee';
const PBKDF2_ITERATIONS = 250000;

export async function createAccessProof(roomId, passphrase) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    encoder.encode(`${ACCESS_PROOF_PREFIX}:${roomId}:${passphrase}`)
  );

  return toBase64Url(new Uint8Array(digest));
}

export async function deriveMessageKey(roomId, passphrase) {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey']
  );

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: encoder.encode(`${MESSAGE_KEY_PREFIX}:${roomId}`),
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256'
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export async function encryptMessage(key, body) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoder.encode(body)
  );

  return {
    iv: toBase64Url(iv),
    ciphertext: toBase64Url(new Uint8Array(encrypted))
  };
}

export async function decryptMessage(key, encrypted) {
  const iv = fromBase64Url(encrypted.iv);
  const ciphertext = fromBase64Url(encrypted.ciphertext);
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);

  return decoder.decode(decrypted);
}

function toBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(value) {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

