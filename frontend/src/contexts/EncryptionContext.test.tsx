import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { EncryptionProvider, useEncryption } from './EncryptionContext';
import { deriveKey, encrypt, generateSalt, VERIFICATION_CANARY } from '../utils/crypto';

// Replace the 600k-iteration PBKDF2 with a direct importKey so tests are fast
// and deterministic on any hardware. encrypt/decrypt stay real — the canary
// check and wrong-passphrase rejection are still genuinely exercised because
// different passphrases produce different AES-GCM keys → AES-GCM tag failure.
vi.mock('../utils/crypto', async (importOriginal) => {
  const real = await importOriginal<typeof import('../utils/crypto')>();
  return {
    ...real,
    deriveKey: async (passphrase: string, _salt: string): Promise<CryptoKey> => {
      const raw = new Uint8Array(32);
      raw.set(new TextEncoder().encode(passphrase).slice(0, 32));
      return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
    },
  };
});

// Mock the IDB module so tests run in jsdom without a real IndexedDB implementation.
const idbStore = new Map<string, CryptoKey>();

vi.mock('../utils/idb', () => ({
  idbGet: vi.fn(async (id: string) => idbStore.get(id) ?? null),
  idbSet: vi.fn(async (id: string, key: CryptoKey) => { idbStore.set(id, key); }),
  idbDelete: vi.fn(async (id: string) => { idbStore.delete(id); }),
  idbClear: vi.fn(async () => { idbStore.clear(); }),
}));

const PASSPHRASE = 'aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789aBcDeFgHiJkL';
const MAPSET_ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

async function buildVerification(passphrase: string, salt: string, mapsetId: string): Promise<string> {
  const key = await deriveKey(passphrase, salt);
  return encrypt(key, VERIFICATION_CANARY, `Mapset|${mapsetId}|${mapsetId}`);
}

function wrapper({ children }: { children: React.ReactNode }) {
  return <EncryptionProvider>{children}</EncryptionProvider>;
}

describe('EncryptionContext', () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    idbStore.clear();
  });

  it('unlocks a mapset with the correct passphrase, writes key to IDB, marks sessionStorage, and exposes a key', async () => {
    const salt = generateSalt();
    const verification = await buildVerification(PASSPHRASE, salt, MAPSET_ID);
    const { result } = renderHook(() => useEncryption(), { wrapper });

    expect(result.current.isUnlocked(MAPSET_ID)).toBe(false);
    expect(await result.current.getKey(MAPSET_ID)).toBeNull();

    await act(async () => {
      await result.current.unlockMapset(MAPSET_ID, PASSPHRASE, salt, verification);
    });

    expect(result.current.isUnlocked(MAPSET_ID)).toBe(true);
    // sessionStorage stores only a presence flag — no passphrase or salt.
    expect(sessionStorage.getItem(`mapset-unlocked:${MAPSET_ID}`)).toBe('1');
    expect(idbStore.has(MAPSET_ID)).toBe(true);
    expect(await result.current.getKey(MAPSET_ID)).not.toBeNull();
  });

  it('rejects an unlock attempt with the wrong passphrase and writes nothing', async () => {
    const salt = generateSalt();
    const verification = await buildVerification(PASSPHRASE, salt, MAPSET_ID);
    const { result } = renderHook(() => useEncryption(), { wrapper });

    // Catch the error inside act so React state stays clean for subsequent assertions.
    let caughtError: unknown = null;
    await act(async () => {
      try {
        await result.current.unlockMapset(
          MAPSET_ID,
          'wrongPassphrase000000000000000000000000000000000',
          salt,
          verification,
        );
      } catch (e) {
        caughtError = e;
      }
    });

    expect(caughtError).not.toBeNull();
    expect(result.current.isUnlocked(MAPSET_ID)).toBe(false);
    expect(sessionStorage.getItem(`mapset-unlocked:${MAPSET_ID}`)).toBeNull();
    expect(idbStore.has(MAPSET_ID)).toBe(false);
  });

  it('lockMapset clears in-memory cache, IDB, and sessionStorage', async () => {
    const salt = generateSalt();
    const verification = await buildVerification(PASSPHRASE, salt, MAPSET_ID);
    const { result } = renderHook(() => useEncryption(), { wrapper });

    await act(async () => {
      await result.current.unlockMapset(MAPSET_ID, PASSPHRASE, salt, verification);
    });

    await act(async () => { await result.current.lockMapset(MAPSET_ID); });

    expect(result.current.isUnlocked(MAPSET_ID)).toBe(false);
    expect(sessionStorage.getItem(`mapset-unlocked:${MAPSET_ID}`)).toBeNull();
    expect(await result.current.getKey(MAPSET_ID)).toBeNull();
    expect(idbStore.has(MAPSET_ID)).toBe(false);
  });

  it('rehydrates unlock state from sessionStorage and key from IDB on fresh provider mount', async () => {
    const salt = generateSalt();
    const verification = await buildVerification(PASSPHRASE, salt, MAPSET_ID);

    // Simulate first session: unlock and store.
    const first = renderHook(() => useEncryption(), { wrapper });
    await act(async () => {
      await first.result.current.unlockMapset(MAPSET_ID, PASSPHRASE, salt, verification);
    });
    first.unmount();

    // Simulate page reload: sessionStorage persists, in-memory cache is gone,
    // IDB still has the key (mock map was written above).
    const second = renderHook(() => useEncryption(), { wrapper });
    expect(second.result.current.isUnlocked(MAPSET_ID)).toBe(true);
    expect(await second.result.current.getKey(MAPSET_ID)).not.toBeNull();
  });

  it('getKey resyncs and returns null when IDB is missing but sessionStorage flag is present (drift)', async () => {
    // Simulate a session where the mapset was unlocked (flag in sessionStorage)
    // but IDB was cleared externally (e.g. browser devtools).
    sessionStorage.setItem(`mapset-unlocked:${MAPSET_ID}`, '1');
    // idbStore is empty — simulates IDB being cleared.

    const { result } = renderHook(() => useEncryption(), { wrapper });

    // isUnlocked reflects the stale sessionStorage flag on mount.
    expect(result.current.isUnlocked(MAPSET_ID)).toBe(true);

    // getKey detects the drift and calls lockMapset to resync.
    // Wrap in act so React flushes the setUnlockedIds update from lockMapset.
    let key: CryptoKey | null = null;
    await act(async () => {
      key = await result.current.getKey(MAPSET_ID);
    });
    expect(key).toBeNull();

    // After resync, isUnlocked and sessionStorage are cleared.
    expect(result.current.isUnlocked(MAPSET_ID)).toBe(false);
    expect(sessionStorage.getItem(`mapset-unlocked:${MAPSET_ID}`)).toBeNull();
  });

  it('clearAll wipes IDB, all sessionStorage flags, and in-memory cache', async () => {
    const salt = generateSalt();
    const verification = await buildVerification(PASSPHRASE, salt, MAPSET_ID);
    const { result } = renderHook(() => useEncryption(), { wrapper });

    await act(async () => {
      await result.current.unlockMapset(MAPSET_ID, PASSPHRASE, salt, verification);
    });
    expect(result.current.isUnlocked(MAPSET_ID)).toBe(true);

    await act(async () => {
      await result.current.clearAll();
    });

    expect(result.current.isUnlocked(MAPSET_ID)).toBe(false);
    expect(sessionStorage.getItem(`mapset-unlocked:${MAPSET_ID}`)).toBeNull();
    expect(idbStore.size).toBe(0);
    expect(await result.current.getKey(MAPSET_ID)).toBeNull();
  });

  it('caches the passphrase during unlockMapset and clears it on lock/clearAll', async () => {
    const salt = generateSalt();
    const verification = await buildVerification(PASSPHRASE, salt, MAPSET_ID);
    const { result } = renderHook(() => useEncryption(), { wrapper });

    expect(result.current.getPassphrase(MAPSET_ID)).toBeNull();

    await act(async () => {
      await result.current.unlockMapset(MAPSET_ID, PASSPHRASE, salt, verification);
    });
    expect(result.current.getPassphrase(MAPSET_ID)).toBe(PASSPHRASE);

    await act(async () => { await result.current.lockMapset(MAPSET_ID); });
    expect(result.current.getPassphrase(MAPSET_ID)).toBeNull();

    await act(async () => {
      await result.current.unlockMapset(MAPSET_ID, PASSPHRASE, salt, verification);
    });
    expect(result.current.getPassphrase(MAPSET_ID)).toBe(PASSPHRASE);

    await act(async () => { await result.current.clearAll(); });
    expect(result.current.getPassphrase(MAPSET_ID)).toBeNull();
  });

  it('unlockWithKey only caches a passphrase when explicitly supplied', async () => {
    const salt = generateSalt();
    const key = await deriveKey(PASSPHRASE, salt);
    const { result } = renderHook(() => useEncryption(), { wrapper });

    await act(async () => { await result.current.unlockWithKey(MAPSET_ID, key); });
    expect(result.current.getPassphrase(MAPSET_ID)).toBeNull();

    await act(async () => { await result.current.unlockWithKey(MAPSET_ID, key, 'pass-via-key'); });
    expect(result.current.getPassphrase(MAPSET_ID)).toBe('pass-via-key');
  });

  it('unlockWithKey stores the provided key directly without running PBKDF2', async () => {
    const salt = generateSalt();
    const key = await deriveKey(PASSPHRASE, salt);
    const { result } = renderHook(() => useEncryption(), { wrapper });

    await act(async () => {
      await result.current.unlockWithKey(MAPSET_ID, key);
    });

    expect(result.current.isUnlocked(MAPSET_ID)).toBe(true);
    expect(idbStore.get(MAPSET_ID)).toBe(key);
    expect(await result.current.getKey(MAPSET_ID)).toBe(key);
  });

  it('persists the passphrase in localStorage when persist option is true', async () => {
    const salt = generateSalt();
    const verification = await buildVerification(PASSPHRASE, salt, MAPSET_ID);
    const { result } = renderHook(() => useEncryption(), { wrapper });

    await act(async () => {
      await result.current.unlockMapset(MAPSET_ID, PASSPHRASE, salt, verification, { persist: true });
    });

    expect(result.current.isPersisted(MAPSET_ID)).toBe(true);
    expect(localStorage.getItem(`mapset-kept-passphrase:${MAPSET_ID}`)).toBe(PASSPHRASE);
  });

  it('does not persist the passphrase when persist option is false or omitted', async () => {
    const salt = generateSalt();
    const verification = await buildVerification(PASSPHRASE, salt, MAPSET_ID);
    const { result } = renderHook(() => useEncryption(), { wrapper });

    await act(async () => {
      await result.current.unlockMapset(MAPSET_ID, PASSPHRASE, salt, verification);
    });

    expect(result.current.isPersisted(MAPSET_ID)).toBe(false);
    expect(localStorage.getItem(`mapset-kept-passphrase:${MAPSET_ID}`)).toBeNull();
  });

  it('tryAutoUnlock unlocks from a persisted passphrase', async () => {
    const salt = generateSalt();
    const verification = await buildVerification(PASSPHRASE, salt, MAPSET_ID);
    localStorage.setItem(`mapset-kept-passphrase:${MAPSET_ID}`, PASSPHRASE);

    const { result } = renderHook(() => useEncryption(), { wrapper });

    let success = false;
    await act(async () => {
      success = await result.current.tryAutoUnlock(MAPSET_ID, salt, verification);
    });

    expect(success).toBe(true);
    expect(result.current.isUnlocked(MAPSET_ID)).toBe(true);
  });

  it('tryAutoUnlock returns false when no passphrase is persisted', async () => {
    const salt = generateSalt();
    const verification = await buildVerification(PASSPHRASE, salt, MAPSET_ID);
    const { result } = renderHook(() => useEncryption(), { wrapper });

    let success = true;
    await act(async () => {
      success = await result.current.tryAutoUnlock(MAPSET_ID, salt, verification);
    });

    expect(success).toBe(false);
    expect(result.current.isUnlocked(MAPSET_ID)).toBe(false);
  });

  it('tryAutoUnlock clears stale persisted passphrase on verification failure', async () => {
    const salt = generateSalt();
    const verification = await buildVerification(PASSPHRASE, salt, MAPSET_ID);
    localStorage.setItem(`mapset-kept-passphrase:${MAPSET_ID}`, 'wrong-passphrase-0000000000000000000000000000000');

    const { result } = renderHook(() => useEncryption(), { wrapper });

    let success = true;
    await act(async () => {
      success = await result.current.tryAutoUnlock(MAPSET_ID, salt, verification);
    });

    expect(success).toBe(false);
    expect(localStorage.getItem(`mapset-kept-passphrase:${MAPSET_ID}`)).toBeNull();
    expect(result.current.isPersisted(MAPSET_ID)).toBe(false);
  });

  it('lockMapset clears both sessionStorage and localStorage passphrase', async () => {
    const salt = generateSalt();
    const verification = await buildVerification(PASSPHRASE, salt, MAPSET_ID);
    const { result } = renderHook(() => useEncryption(), { wrapper });

    await act(async () => {
      await result.current.unlockMapset(MAPSET_ID, PASSPHRASE, salt, verification, { persist: true });
    });

    await act(async () => { await result.current.lockMapset(MAPSET_ID); });

    expect(result.current.isUnlocked(MAPSET_ID)).toBe(false);
    expect(result.current.isPersisted(MAPSET_ID)).toBe(false);
    expect(sessionStorage.getItem(`mapset-unlocked:${MAPSET_ID}`)).toBeNull();
    expect(localStorage.getItem(`mapset-kept-passphrase:${MAPSET_ID}`)).toBeNull();
  });

  it('clearAll wipes IDB, sessionStorage flags, and persisted passphrases', async () => {
    const salt = generateSalt();
    const verification = await buildVerification(PASSPHRASE, salt, MAPSET_ID);
    const { result } = renderHook(() => useEncryption(), { wrapper });

    await act(async () => {
      await result.current.unlockMapset(MAPSET_ID, PASSPHRASE, salt, verification, { persist: true });
    });
    expect(result.current.isPersisted(MAPSET_ID)).toBe(true);

    await act(async () => {
      await result.current.clearAll();
    });

    expect(result.current.isUnlocked(MAPSET_ID)).toBe(false);
    expect(result.current.isPersisted(MAPSET_ID)).toBe(false);
    expect(localStorage.getItem(`mapset-kept-passphrase:${MAPSET_ID}`)).toBeNull();
  });

  it('deletePersistedPassphrase removes the localStorage entry without affecting the session unlock state', async () => {
    const salt = generateSalt();
    const verification = await buildVerification(PASSPHRASE, salt, MAPSET_ID);
    const { result } = renderHook(() => useEncryption(), { wrapper });

    await act(async () => {
      await result.current.unlockMapset(MAPSET_ID, PASSPHRASE, salt, verification, { persist: true });
    });
    expect(result.current.isUnlocked(MAPSET_ID)).toBe(true);
    expect(result.current.isPersisted(MAPSET_ID)).toBe(true);

    act(() => {
      result.current.deletePersistedPassphrase(MAPSET_ID);
    });

    expect(result.current.isUnlocked(MAPSET_ID)).toBe(true);
    expect(result.current.isPersisted(MAPSET_ID)).toBe(false);
    expect(localStorage.getItem(`mapset-kept-passphrase:${MAPSET_ID}`)).toBeNull();
  });
});
