import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { VERIFICATION_CANARY, decrypt, deriveKey } from '../utils/crypto';

const STORAGE_PREFIX = 'mapset-passphrase:';

interface StoredEntry {
  passphrase: string;
  salt: string;
}

interface EncryptionContextValue {
  unlockMapset: (mapsetId: string, passphrase: string, salt: string, encryptedVerification: string) => Promise<void>;
  getKey: (mapsetId: string) => Promise<CryptoKey | null>;
  lockMapset: (mapsetId: string) => void;
  isUnlocked: (mapsetId: string) => boolean;
}

const EncryptionContext = createContext<EncryptionContextValue | undefined>(undefined);

function storageKey(mapsetId: string): string {
  return `${STORAGE_PREFIX}${mapsetId}`;
}

function readStored(mapsetId: string): StoredEntry | null {
  const raw = sessionStorage.getItem(storageKey(mapsetId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredEntry;
  } catch {
    return null;
  }
}

function verificationAad(mapsetId: string): string {
  return `mapsets|${mapsetId}|${mapsetId}`;
}

export function EncryptionProvider({ children }: { children: React.ReactNode }) {
  const keyCache = useRef<Map<string, CryptoKey>>(new Map());
  const [unlockedIds, setUnlockedIds] = useState<Set<string>>(() => {
    const ids = new Set<string>();
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i);
      if (k?.startsWith(STORAGE_PREFIX)) ids.add(k.slice(STORAGE_PREFIX.length));
    }
    return ids;
  });

  const unlockMapset = useCallback(
    async (mapsetId: string, passphrase: string, salt: string, encryptedVerification: string) => {
      const key = await deriveKey(passphrase, salt);
      const plaintext = await decrypt(key, encryptedVerification, verificationAad(mapsetId));
      if (plaintext !== VERIFICATION_CANARY) {
        throw new Error('Verification canary mismatch');
      }
      keyCache.current.set(mapsetId, key);
      sessionStorage.setItem(storageKey(mapsetId), JSON.stringify({ passphrase, salt } satisfies StoredEntry));
      setUnlockedIds((prev) => {
        if (prev.has(mapsetId)) return prev;
        const next = new Set(prev);
        next.add(mapsetId);
        return next;
      });
    },
    [],
  );

  const getKey = useCallback(async (mapsetId: string): Promise<CryptoKey | null> => {
    const cached = keyCache.current.get(mapsetId);
    if (cached) return cached;
    const stored = readStored(mapsetId);
    if (!stored) return null;
    const key = await deriveKey(stored.passphrase, stored.salt);
    keyCache.current.set(mapsetId, key);
    return key;
  }, []);

  const lockMapset = useCallback((mapsetId: string) => {
    keyCache.current.delete(mapsetId);
    sessionStorage.removeItem(storageKey(mapsetId));
    setUnlockedIds((prev) => {
      if (!prev.has(mapsetId)) return prev;
      const next = new Set(prev);
      next.delete(mapsetId);
      return next;
    });
  }, []);

  const isUnlocked = useCallback((mapsetId: string) => unlockedIds.has(mapsetId), [unlockedIds]);

  const value = useMemo<EncryptionContextValue>(
    () => ({ unlockMapset, getKey, lockMapset, isUnlocked }),
    [unlockMapset, getKey, lockMapset, isUnlocked],
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
