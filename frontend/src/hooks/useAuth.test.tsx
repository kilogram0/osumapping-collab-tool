import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { AuthProvider, useAuth } from './useAuth';
import * as endpoints from '../api/endpoints';

const mockClearAll = vi.fn().mockResolvedValue(undefined);

vi.mock('../contexts/EncryptionContext', () => ({
  useEncryption: () => ({ clearAll: mockClearAll }),
}));

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });

  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <AuthProvider>{children}</AuthProvider>
      </QueryClientProvider>
    );
  };
}

describe('useAuth', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    mockClearAll.mockClear();
  });

  it('returns loading state initially', () => {
    vi.spyOn(endpoints, 'fetchCurrentUser').mockReturnValue(new Promise(() => {}));

    const { result } = renderHook(() => useAuth(), {
      wrapper: createWrapper(),
    });

    expect(result.current.isLoading).toBe(true);
    expect(result.current.user).toBeUndefined();
    expect(result.current.isAuthenticated).toBe(false);
  });

  it('returns authenticated state when user is fetched', async () => {
    const mockUser: endpoints.User = {
      id: 1,
      osu_id: 12345,
      username: 'testuser',
      avatar_url: 'https://a.ppy.sh/12345',
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-01T00:00:00Z',
    };
    vi.spyOn(endpoints, 'fetchCurrentUser').mockResolvedValue(mockUser);

    const { result } = renderHook(() => useAuth(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.user).toEqual(mockUser);
    expect(result.current.isAuthenticated).toBe(true);
  });

  it('returns unauthenticated state when user is null', async () => {
    vi.spyOn(endpoints, 'fetchCurrentUser').mockResolvedValue(null);

    const { result } = renderHook(() => useAuth(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.user).toBeNull();
    expect(result.current.isAuthenticated).toBe(false);
  });

  it('throws when used outside AuthProvider', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => renderHook(() => useAuth())).toThrow(
      'useAuth must be used within an AuthProvider',
    );

    consoleError.mockRestore();
  });

  describe('login', () => {
    let originalLocation: Location;

    beforeAll(() => {
      originalLocation = window.location;
      Object.defineProperty(window, 'location', {
        writable: true,
        value: { href: '' },
      });
    });

    afterAll(() => {
      Object.defineProperty(window, 'location', {
        writable: true,
        value: originalLocation,
      });
    });

    it('redirects to osu! OAuth authorize endpoint', () => {
      vi.spyOn(endpoints, 'fetchCurrentUser').mockResolvedValue(null);

      const { result } = renderHook(() => useAuth(), {
        wrapper: createWrapper(),
      });

      result.current.login();

      expect(window.location.href).toBe('/api/auth/osu/authorize');
    });
  });

  describe('logout', () => {
    it('clears encryption state, calls logout endpoint, and sets user to null', async () => {
      const mockUser: endpoints.User = {
        id: 1,
        osu_id: 12345,
        username: 'testuser',
        avatar_url: 'https://a.ppy.sh/12345',
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      };
      vi.spyOn(endpoints, 'fetchCurrentUser')
        .mockResolvedValueOnce(mockUser)
        .mockResolvedValue(null);
      const logoutSpy = vi.spyOn(endpoints, 'logout').mockResolvedValue(undefined);

      const { result } = renderHook(() => useAuth(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => expect(result.current.isAuthenticated).toBe(true));

      await result.current.logout();

      expect(mockClearAll).toHaveBeenCalledTimes(1);
      expect(logoutSpy).toHaveBeenCalledTimes(1);
      await waitFor(() => expect(result.current.isAuthenticated).toBe(false));
      expect(result.current.user).toBeNull();
    });
  });
});
