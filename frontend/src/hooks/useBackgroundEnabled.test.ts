import { renderHook, act, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setBackgroundEnabled, useBackgroundEnabled } from './useBackgroundEnabled';

const KEY = 'triangles-bg-enabled';

describe('useBackgroundEnabled', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it('defaults to enabled when nothing is stored', () => {
    const { result } = renderHook(() => useBackgroundEnabled());
    expect(result.current).toBe(true);
  });

  it('reflects and persists an explicit disable', () => {
    const { result } = renderHook(() => useBackgroundEnabled());
    act(() => setBackgroundEnabled(false));
    expect(result.current).toBe(false);
    expect(localStorage.getItem(KEY)).toBe('false');
  });

  it('re-enables after being disabled', () => {
    const { result } = renderHook(() => useBackgroundEnabled());
    act(() => setBackgroundEnabled(false));
    act(() => setBackgroundEnabled(true));
    expect(result.current).toBe(true);
    expect(localStorage.getItem(KEY)).toBe('true');
  });

  it('treats only the literal "false" as disabled (unknown values stay on)', () => {
    localStorage.setItem(KEY, 'true');
    const { result } = renderHook(() => useBackgroundEnabled());
    expect(result.current).toBe(true);
  });
});
