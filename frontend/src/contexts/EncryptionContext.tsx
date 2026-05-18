import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { VERIFICATION_CANARY, decrypt, deriveKey, mapsetVerificationAad } from '../utils/crypto';
import { idbClear, idbDelete, idbGet, idbSet } from '../utils/idb';

// sessionStorage tracks *which* mapsets are unlocked so that isUnlocked() is
// synchronous on mount. The actual CryptoKey lives in IndexedDB — raw key
// material is never accessible as JS bytes.
const STORAGE_PREFIX = 'mapset-unlocked:';
// Prefix used by the previous version that stored {passphrase, salt} in
// sessionStorage; swept on mount as a one-time migration.
const LEGACY_STORAGE_PREFIX = 'mapset-passphrase:';

interface EncryptionContextValue {
  unlockMapset: (mapsetId: string, passphrase: string, salt: string, encryptedVerification: string) => Promise<void>;
  // Bypasses canary verification — caller must guarantee the key is correct
  // (e.g. it was just derived from a passphrase the caller produced themselves).
  // Do NOT use this as an entry-point for user-supplied passphrases; use unlockMapset instead.
  unlockWithKey: (mapsetId: string, key: CryptoKey, passphrase?: string) => Promise<void>;
  getKey: (mapsetId: string) => Promise<CryptoKey | null>;
  // Returns the passphrase only if it was cached in memory during this session
  // (entered via unlockMapset or supplied to unlockWithKey). Never persisted —
  // a page reload drops it.
  getPassphrase: (mapsetId: string) => string | null;
  lockMapset: (mapsetId: string) => Promise<void>;
  clearAll: () => Promise<void>;
  isUnlocked: (mapsetId: string) => boolean;
}

const EncryptionContext = createContext<EncryptionContextValue | undefined>(undefined);

function storageKey(mapsetId: string): string {
  return `${STORAGE_PREFIX}${mapsetId}`;
}

export function EncryptionProvider({ children }: { children: React.ReactNode }) {
  const keyCache = useRef<Map<string, CryptoKey>>(new Map());
  const passphraseCache = useRef<Map<string, string>>(new Map());
  const [unlockedIds, setUnlockedIds] = useState<Set<string>>(() => {
    const ids = new Set<string>();
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i);
      if (k?.startsWith(STORAGE_PREFIX)) ids.add(k.slice(STORAGE_PREFIX.length));
    }
    return ids;
  });

  // One-time migration: remove legacy mapset-passphrase:* entries left by
  // a prior version that stored plaintext {passphrase, salt} in sessionStorage.
  useEffect(() => {
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const k = sessionStorage.key(i);
      if (k?.startsWith(LEGACY_STORAGE_PREFIX)) sessionStorage.removeItem(k);
    }
  }, []);

  const markUnlocked = useCallback((mapsetId: string) => {
    sessionStorage.setItem(storageKey(mapsetId), '1');
    setUnlockedIds((prev) => {
      if (prev.has(mapsetId)) return prev;
      const next = new Set(prev);
      next.add(mapsetId);
      return next;
    });
  }, []);

  const lockMapset = useCallback(async (mapsetId: string): Promise<void> => {
    keyCache.current.delete(mapsetId);
    passphraseCache.current.delete(mapsetId);
    await idbDelete(mapsetId);
    sessionStorage.removeItem(storageKey(mapsetId));
    setUnlockedIds((prev) => {
      if (!prev.has(mapsetId)) return prev;
      const next = new Set(prev);
      next.delete(mapsetId);
      return next;
    });
  }, []);

  const unlockWithKey = useCallback(async (mapsetId: string, key: CryptoKey, passphrase?: string) => {
    await idbSet(mapsetId, key);
    keyCache.current.set(mapsetId, key);
    if (passphrase) passphraseCache.current.set(mapsetId, passphrase);
    markUnlocked(mapsetId);
  }, [markUnlocked]);

  const unlockMapset = useCallback(
    async (mapsetId: string, passphrase: string, salt: string, encryptedVerification: string) => {
      const key = await deriveKey(passphrase, salt);
      const plaintext = await decrypt(key, encryptedVerification, mapsetVerificationAad(mapsetId));
      if (plaintext !== VERIFICATION_CANARY) {
        throw new Error('Verification canary mismatch');
      }
      await unlockWithKey(mapsetId, key, passphrase);
    },
    [unlockWithKey],
  );

  const getPassphrase = useCallback(
    (mapsetId: string): string | null => passphraseCache.current.get(mapsetId) ?? null,
    [],
  );

  const getKey = useCallback(async (mapsetId: string): Promise<CryptoKey | null> => {
    const cached = keyCache.current.get(mapsetId);
    if (cached) return cached;
    const key = await idbGet(mapsetId);
    if (key) {
      keyCache.current.set(mapsetId, key);
      return key;
    }
    // IDB was cleared externally (devtools / browser settings) while
    // sessionStorage still holds the presence flag. Resync so that isUnlocked()
    // and the PassphraseModal gate reflect reality.
    if (sessionStorage.getItem(storageKey(mapsetId))) {
      await lockMapset(mapsetId);
    }
    return null;
  }, [lockMapset]);

  const clearAll = useCallback(async (): Promise<void> => {
    keyCache.current.clear();
    passphraseCache.current.clear();
    await idbClear();
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const k = sessionStorage.key(i);
      if (k?.startsWith(STORAGE_PREFIX)) sessionStorage.removeItem(k);
    }
    setUnlockedIds(new Set());
  }, []);

  const isUnlocked = useCallback((mapsetId: string) => unlockedIds.has(mapsetId), [unlockedIds]);

  const value = useMemo<EncryptionContextValue>(
    () => ({ unlockMapset, unlockWithKey, getKey, getPassphrase, lockMapset, clearAll, isUnlocked }),
    [unlockMapset, unlockWithKey, getKey, getPassphrase, lockMapset, clearAll, isUnlocked],
  );

  return <EncryptionContext.Provider value={value}>{children}</EncryptionContext.Provider>;
}

export function useEncryption(): EncryptionContextValue {
  const context = useContext(EncryptionContext);
  if (context === undefined) {
    throw new Error('useEncryption must be used within an EncryptionProvider');
  }
  return context;
}
