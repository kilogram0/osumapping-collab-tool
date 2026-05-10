import { describe, it, expect, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { EncryptionProvider, useEncryption } from './EncryptionContext';
import { deriveKey, encrypt, generateSalt, VERIFICATION_CANARY } from '../utils/crypto';

const PASSPHRASE = 'aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789aBcDeFgHiJkL';
const MAPSET_ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

async function buildVerification(passphrase: string, salt: string, mapsetId: string): Promise<string> {
  const key = await deriveKey(passphrase, salt);
  return encrypt(key, VERIFICATION_CANARY, `mapsets|${mapsetId}|${mapsetId}`);
}

function wrapper({ children }: { children: React.ReactNode }) {
  return <EncryptionProvider>{children}</EncryptionProvider>;
}

describe('EncryptionContext', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it('unlocks a mapset with the correct passphrase, persists to sessionStorage, and exposes a key', async () => {
    const salt = generateSalt();
    const verification = await buildVerification(PASSPHRASE, salt, MAPSET_ID);
    const { result } = renderHook(() => useEncryption(), { wrapper });

    expect(result.current.isUnlocked(MAPSET_ID)).toBe(false);
    expect(await result.current.getKey(MAPSET_ID)).toBeNull();

    await act(async () => {
      await result.current.unlockMapset(MAPSET_ID, PASSPHRASE, salt, verification);
    });

    expect(result.current.isUnlocked(MAPSET_ID)).toBe(true);
    expect(sessionStorage.getItem(`mapset-passphrase:${MAPSET_ID}`)).not.toBeNull();
    expect(await result.current.getKey(MAPSET_ID)).not.toBeNull();
  });

  it('rejects an unlock attempt with the wrong passphrase and does not persist', async () => {
    const salt = generateSalt();
    const verification = await buildVerification(PASSPHRASE, salt, MAPSET_ID);
    const { result } = renderHook(() => useEncryption(), { wrapper });

    await expect(
      act(async () => {
        await result.current.unlockMapset(MAPSET_ID, 'wrongPassphrase000000000000000000000000000000000', salt, verification);
      }),
    ).rejects.toThrow();

    expect(result.current.isUnlocked(MAPSET_ID)).toBe(false);
    expect(sessionStorage.getItem(`mapset-passphrase:${MAPSET_ID}`)).toBeNull();
  });

  it('lockMapset clears both in-memory key and sessionStorage', async () => {
    const salt = generateSalt();
    const verification = await buildVerification(PASSPHRASE, salt, MAPSET_ID);
    const { result } = renderHook(() => useEncryption(), { wrapper });

    await act(async () => {
      await result.current.unlockMapset(MAPSET_ID, PASSPHRASE, salt, verification);
    });

    act(() => result.current.lockMapset(MAPSET_ID));

    expect(result.current.isUnlocked(MAPSET_ID)).toBe(false);
    expect(sessionStorage.getItem(`mapset-passphrase:${MAPSET_ID}`)).toBeNull();
    expect(await result.current.getKey(MAPSET_ID)).toBeNull();
  });

  it('rehydrates the key from sessionStorage after a fresh provider mount (refresh simulation)', async () => {
    const salt = generateSalt();
    const verification = await buildVerification(PASSPHRASE, salt, MAPSET_ID);

    const first = renderHook(() => useEncryption(), { wrapper });
    await act(async () => {
      await first.result.current.unlockMapset(MAPSET_ID, PASSPHRASE, salt, verification);
    });
    first.unmount();

    // Simulate full app remount; sessionStorage persists, in-memory cache does not.
    const second = renderHook(() => useEncryption(), { wrapper });
    expect(second.result.current.isUnlocked(MAPSET_ID)).toBe(true);
    expect(await second.result.current.getKey(MAPSET_ID)).not.toBeNull();
  });
});
