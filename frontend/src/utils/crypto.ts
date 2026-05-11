const PBKDF2_ITERATIONS = 600_000;
const PASSPHRASE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const PASSPHRASE_LENGTH = 48;
const KEY_LENGTH_BITS = 256;
const IV_BYTES = 12;
const SALT_BYTES = 16;

export const VERIFICATION_CANARY = 'verified';

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

// ArrayBuffer (not ArrayBufferLike) is required because Web Crypto rejects SharedArrayBuffer.
function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64);
  const buf = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function generatePassphrase(): string {
  // Rejection sampling: discard bytes >= 248 (= 4*62) to eliminate modulo bias.
  const THRESHOLD = 248;
  const result: string[] = [];
  while (result.length < PASSPHRASE_LENGTH) {
    const bytes = crypto.getRandomValues(new Uint8Array(PASSPHRASE_LENGTH * 2));
    for (const b of bytes) {
      if (b < THRESHOLD && result.length < PASSPHRASE_LENGTH) {
        result.push(PASSPHRASE_CHARS[b % PASSPHRASE_CHARS.length]);
      }
    }
  }
  return result.join('');
}

export function mapsetFieldAad(mapsetId: string, field: string): string {
  return `mapsets|${mapsetId}|${field}`;
}

export function mapsetVerificationAad(mapsetId: string): string {
  return `mapsets|${mapsetId}|${mapsetId}`;
}

// NOTE: These AAD helpers are the canonical contract for both encryption (write)
// and decryption (read). Any producer that encrypts Difficulty or Section fields
// must reuse these exact helpers — do not re-derive the format.
export function difficultyFieldAad(difficultyId: string, mapsetId: string, field: string): string {
  return `difficulties|${difficultyId}|${mapsetId}|${field}`;
}

export function sectionFieldAad(sectionId: string, mapsetId: string, field: string): string {
  return `sections|${sectionId}|${mapsetId}|${field}`;
}

/**
 * Decode the uniform JSON envelope `{"v":<value>}`.
 *
 * Every numeric encrypted field is wrapped in the same envelope shape so
 * the decrypt path never branches on field type.
 *
 * @throws if the text is not valid JSON, lacks `"v"`, or `v` is not a number.
 */
export function decodeJsonEnvelope(plaintext: string): number {
  const parsed = JSON.parse(plaintext);
  if (!Object.prototype.hasOwnProperty.call(parsed, 'v')) {
    throw new Error('Missing "v" key in JSON envelope');
  }
  if (typeof parsed.v !== 'number') {
    throw new Error(`JSON envelope value is not a number: ${parsed.v}`);
  }
  return parsed.v;
}

export function generateSalt(): string {
  return toBase64(crypto.getRandomValues(new Uint8Array(SALT_BYTES)));
}

export async function deriveKey(passphrase: string, saltBase64: string): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(passphrase),
    { name: 'PBKDF2' },
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: fromBase64(saltBase64), iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: KEY_LENGTH_BITS },
    false,
    ['encrypt', 'decrypt'],
  );
}

// Wire format: base64(iv || ciphertext+tag)
export async function encrypt(key: CryptoKey, plaintext: string, aad: string): Promise<string> {
  const enc = new TextEncoder();
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: enc.encode(aad) },
    key,
    enc.encode(plaintext),
  );
  const combined = new Uint8Array(IV_BYTES + ciphertext.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(ciphertext), IV_BYTES);
  return toBase64(combined);
}

export async function decrypt(key: CryptoKey, ciphertextBase64: string, aad: string): Promise<string> {
  const enc = new TextEncoder();
  const combined = fromBase64(ciphertextBase64);
  const iv = combined.slice(0, IV_BYTES);
  const ciphertext = combined.slice(IV_BYTES);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv, additionalData: enc.encode(aad) },
    key,
    ciphertext,
  );
  return new TextDecoder().decode(plaintext);
}
