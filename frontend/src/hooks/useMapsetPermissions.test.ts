import { renderHook, act } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { useMapsetPermissions } from './useMapsetPermissions';
import type { MapsetRole } from '../api/endpoints';

describe('useMapsetPermissions', () => {
  it('returns owner permissions for an owner membership', () => {
    const { result } = renderHook(() =>
      useMapsetPermissions({ role: 'owner' as MapsetRole, kicked_at: null }),
    );
    expect(result.current.actualRole).toBe('owner');
    expect(result.current.isOwner).toBe(true);
    expect(result.current.canEditStructure).toBe(true);
    expect(result.current.isGhost).toBe(false);
  });

  it('returns mapper permissions for a mapper membership', () => {
    const { result } = renderHook(() =>
      useMapsetPermissions({ role: 'mapper' as MapsetRole, kicked_at: null }),
    );
    expect(result.current.isOwner).toBe(false);
    expect(result.current.canEditStructure).toBe(true);
    expect(result.current.isGhost).toBe(false);
  });

  it('returns read-only permissions for a modder', () => {
    const { result } = renderHook(() =>
      useMapsetPermissions({ role: 'modder' as MapsetRole, kicked_at: null }),
    );
    expect(result.current.isOwner).toBe(false);
    expect(result.current.canEditStructure).toBe(false);
    expect(result.current.isGhost).toBe(false);
  });

  it('treats kicked members as ghosts', () => {
    const { result } = renderHook(() =>
      useMapsetPermissions({ role: 'owner' as MapsetRole, kicked_at: '2024-01-01T00:00:00Z' }),
    );
    expect(result.current.realIsGhost).toBe(true);
    expect(result.current.isGhost).toBe(true);
    expect(result.current.isOwner).toBe(false);
    expect(result.current.canEditStructure).toBe(false);
  });

  it('lets an owner emulate a mapper and then clear the preview', () => {
    const { result } = renderHook(() =>
      useMapsetPermissions({ role: 'owner' as MapsetRole, kicked_at: null }),
    );

    act(() => result.current.setEmulatedRole('mapper'));
    expect(result.current.effectiveRole).toBe('mapper');
    expect(result.current.canEditStructure).toBe(true);
    expect(result.current.isOwner).toBe(false);

    act(() => result.current.setEmulatedRole(null));
    expect(result.current.effectiveRole).toBe('owner');
    expect(result.current.isOwner).toBe(true);
  });

  it('lets an owner emulate a ghost and then clear the preview', () => {
    const { result } = renderHook(() =>
      useMapsetPermissions({ role: 'owner' as MapsetRole, kicked_at: null }),
    );

    act(() => result.current.setEmulateGhost(true));
    expect(result.current.isGhost).toBe(true);
    expect(result.current.canEditStructure).toBe(false);

    act(() => result.current.setEmulateGhost(false));
    expect(result.current.isGhost).toBe(false);
  });

  it('clears emulation when the membership is no longer an owner', () => {
    const { result, rerender } = renderHook(
      ({ membership }) => useMapsetPermissions(membership),
      {
        initialProps: {
          membership: { role: 'owner' as MapsetRole, kicked_at: null as string | null },
        },
      },
    );

    act(() => result.current.setEmulatedRole('mapper'));
    expect(result.current.effectiveRole).toBe('mapper');

    rerender({ membership: { role: 'mapper' as MapsetRole, kicked_at: null } });
    expect(result.current.effectiveRole).toBe('mapper');
    expect(result.current.emulatedRole).toBeNull();
  });
});
