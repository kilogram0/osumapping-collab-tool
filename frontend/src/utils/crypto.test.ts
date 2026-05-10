import { describe, it, expect } from 'vitest';
import { generateSalt, deriveKey, encrypt, decrypt, VERIFICATION_CANARY } from './crypto';

const PASSPHRASE = 'aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789aBcDeFgHiJkL';
const AAD = 'mapsets|a1b2c3d4-e5f6-7890-abcd-ef1234567890|a1b2c3d4-e5f6-7890-abcd-ef1234567890';

describe('generateSalt', () => {
  it('returns a valid 16-byte base64 string', () => {
    const salt = generateSalt();
    expect(atob(salt)).toHaveLength(16);
  });

  it('produces a different salt each call', () => {
    expect(generateSalt()).not.toBe(generateSalt());
  });
});

describe('encrypt / decrypt round-trip', () => {
  it('decrypts to original plaintext', async () => {
    const key = await deriveKey(PASSPHRASE, generateSalt());
    const plaintext = 'Hello, osu!';
    expect(await decrypt(key, await encrypt(key, plaintext, AAD), AAD)).toBe(plaintext);
  });

  it('round-trips the verification canary', async () => {
    const key = await deriveKey(PASSPHRASE, generateSalt());
    expect(await decrypt(key, await encrypt(key, VERIFICATION_CANARY, AAD), AAD)).toBe(VERIFICATION_CANARY);
  });

  it('each encrypt call produces a unique ciphertext (random IV)', async () => {
    const key = await deriveKey(PASSPHRASE, generateSalt());
    const ct1 = await encrypt(key, 'same plaintext', AAD);
    const ct2 = await encrypt(key, 'same plaintext', AAD);
    expect(ct1).not.toBe(ct2);
  });
});

describe('wrong passphrase', () => {
  it('throws when decrypting with a different passphrase', async () => {
    const salt = generateSalt();
    const key = await deriveKey(PASSPHRASE, salt);
    const ct = await encrypt(key, VERIFICATION_CANARY, AAD);

    const wrongKey = await deriveKey('wrongPassphrase000000000000000000000000000000000', salt);
    await expect(decrypt(wrongKey, ct, AAD)).rejects.toThrow();
  });
});

describe('tampered ciphertext', () => {
  it('throws when the last byte of ciphertext is flipped', async () => {
    const key = await deriveKey(PASSPHRASE, generateSalt());
    const ct = await encrypt(key, 'secret data', AAD);

    const bytes = Uint8Array.from(atob(ct), (c) => c.charCodeAt(0));
    bytes[bytes.length - 1] ^= 0xff;
    const tampered = btoa(String.fromCharCode(...bytes));

    await expect(decrypt(key, tampered, AAD)).rejects.toThrow();
  });

  it('throws when AAD does not match', async () => {
    const key = await deriveKey(PASSPHRASE, generateSalt());
    const ct = await encrypt(key, 'secret data', AAD);
    await expect(decrypt(key, ct, 'mapsets|wrong-id|wrong-mapset-id')).rejects.toThrow();
  });
});
