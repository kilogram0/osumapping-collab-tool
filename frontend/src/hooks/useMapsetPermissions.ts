import { useEffect, useMemo, useState } from 'react';
import type { MapsetRole } from '../api/endpoints';

interface MembershipLike {
  role: MapsetRole;
  kicked_at?: string | null;
}

interface UseMapsetPermissionsResult {
  /** True if the user has been kicked (ghost grace period may still apply). */
  realIsGhost: boolean;
  /** True if the user is kicked or is previewing as a ghost. */
  isGhost: boolean;
  /** Role from the membership row, ignoring emulation. */
  actualRole: MapsetRole | null;
  /** True if the membership is a non-kicked owner. */
  actualIsOwner: boolean;
  /** Role after applying owner emulation. */
  effectiveRole: MapsetRole | null;
  /** True if the effective user is an owner (not ghost, not modder). */
  isOwner: boolean;
  /** True if the effective user may create/edit sections/difficulties. */
  canEditStructure: boolean;
  /** Role the owner is previewing as, or null. */
  emulatedRole: MapsetRole | null;
  setEmulatedRole: (role: MapsetRole | null) => void;
  /** Whether the owner is previewing as a ghost. */
  emulateGhost: boolean;
  setEmulateGhost: (value: boolean) => void;
}

/**
 * Derives the effective permission set for the current user in a mapset,
 * including owner-only role emulation for previewing the UI as mapper/modder/ghost.
 * If the user loses ownership mid-session, any active preview is cleared.
 */
export function useMapsetPermissions(
  myMembership: MembershipLike | null | undefined,
): UseMapsetPermissionsResult {
  const [emulatedRole, setEmulatedRole] = useState<MapsetRole | null>(null);
  const [emulateGhost, setEmulateGhost] = useState(false);

  const realIsGhost = !!myMembership?.kicked_at;
  const isGhost = realIsGhost || emulateGhost;
  const actualRole = myMembership?.role ?? null;
  const actualIsOwner = !realIsGhost && actualRole === 'owner';

  const effectiveRole = actualIsOwner && emulatedRole && !emulateGhost ? emulatedRole : actualRole;
  const isOwner = !isGhost && effectiveRole === 'owner';
  const canEditStructure = !isGhost && (isOwner || effectiveRole === 'mapper');

  // If the user loses ownership mid-session (e.g. transferred it to another
  // member), drop any active preview so it can't silently reactivate on a
  // future re-promotion.
  useEffect(() => {
    if (!actualIsOwner) {
      if (emulatedRole !== null) setEmulatedRole(null);
      if (emulateGhost) setEmulateGhost(false);
    }
  }, [actualIsOwner, emulatedRole, emulateGhost]);

  return useMemo(
    () => ({
      realIsGhost,
      isGhost,
      actualRole,
      actualIsOwner,
      effectiveRole,
      isOwner,
      canEditStructure,
      emulatedRole,
      setEmulatedRole,
      emulateGhost,
      setEmulateGhost,
    }),
    [realIsGhost, isGhost, actualRole, actualIsOwner, effectiveRole, isOwner, canEditStructure, emulatedRole, emulateGhost],
  );
}
