import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { AuthProvider } from '../hooks/useAuth'
import LoginPage from './LoginPage'

vi.mock('../api/endpoints', () => ({
  fetchCurrentUser: vi.fn().mockResolvedValue(null),
  logout: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../contexts/EncryptionContext', () => ({
  useEncryption: () => ({
    clearAll: vi.fn().mockResolvedValue(undefined),
    isUnlocked: vi.fn(() => false),
    getKey: vi.fn().mockResolvedValue(null),
    unlockMapset: vi.fn().mockResolvedValue(undefined),
    unlockWithKey: vi.fn().mockResolvedValue(undefined),
    lockMapset: vi.fn().mockResolvedValue(undefined),
  }),
}))

function renderWithAuth(ui: ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>{ui}</AuthProvider>
    </QueryClientProvider>,
  )
}

describe('LoginPage', () => {
  it('renders the title', async () => {
    renderWithAuth(<LoginPage />)
    await waitFor(() =>
      expect(screen.getByText('osu! Modding Forum')).toBeInTheDocument(),
    )
  })

  it('renders the login button', async () => {
    renderWithAuth(<LoginPage />)
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /login with osu/i }),
      ).toBeInTheDocument(),
    )
  })

  it('redirects to osu! OAuth on button click', async () => {
    const originalLocation = window.location
    Object.defineProperty(window, 'location', {
      writable: true,
      value: { href: '' },
    })

    renderWithAuth(<LoginPage />)

    const button = screen.getByRole('button', { name: /login with osu/i })
    await userEvent.click(button)

    expect(window.location.href).toBe('/api/auth/osu/authorize')

    Object.defineProperty(window, 'location', {
      writable: true,
      value: originalLocation,
    })
  })

  it('displays the E2EE security notice', async () => {
    renderWithAuth(<LoginPage />)
    await waitFor(() =>
      expect(screen.getByText(/AES-256-GCM/i)).toBeInTheDocument(),
    )
    expect(screen.getByText(/passphrase is never sent/i)).toBeInTheDocument()
  })

  it('shows a link to the source code', async () => {
    renderWithAuth(<LoginPage />)
    await waitFor(() =>
      expect(screen.getByRole('link', { name: /view source code/i })).toBeInTheDocument(),
    )
  })
})
