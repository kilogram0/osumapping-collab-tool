import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { vi } from 'vitest'
import App, { AppRoutes } from './App'
import { AuthProvider } from './hooks/useAuth'

vi.mock('./api/endpoints', () => ({
  fetchCurrentUser: vi.fn().mockResolvedValue(null),
  logout: vi.fn().mockResolvedValue(undefined),
  fetchMapsets: vi.fn().mockResolvedValue([]),
}))

vi.mock('./contexts/EncryptionContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./contexts/EncryptionContext')>()
  return {
    ...actual,
    useEncryption: () => ({
      isUnlocked: vi.fn(() => false),
      getKey: vi.fn().mockResolvedValue(null),
      unlockMapset: vi.fn().mockResolvedValue(undefined),
      unlockWithKey: vi.fn().mockResolvedValue(undefined),
      lockMapset: vi.fn().mockResolvedValue(undefined),
      clearAll: vi.fn().mockResolvedValue(undefined),
    }),
  }
})

const routerFuture = {
  v7_startTransition: true,
  v7_relativeSplatPath: true,
} as const

function renderWithProviders(ui: ReactNode, initialEntries: string[] = ['/']) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  })

  return render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <MemoryRouter initialEntries={initialEntries} future={routerFuture}>
          {ui}
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  )
}

describe('AppRoutes', () => {
  it('renders LoginPage on /login', () => {
    renderWithProviders(<AppRoutes />, ['/login'])
    expect(
      screen.getByRole('button', { name: /login with osu/i }),
    ).toBeInTheDocument()
  })

  it('renders DashboardPage on /dashboard', () => {
    renderWithProviders(<AppRoutes />, ['/dashboard'])
    expect(screen.getByText('Dashboard')).toBeInTheDocument()
  })

  it('redirects unknown routes to /login', () => {
    renderWithProviders(<AppRoutes />, ['/unknown'])
    expect(
      screen.getByRole('button', { name: /login with osu/i }),
    ).toBeInTheDocument()
  })
})

describe('App', () => {
  it('redirects default route to login', () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    })

    render(
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <App />
        </AuthProvider>
      </QueryClientProvider>,
    )

    expect(
      screen.getByRole('button', { name: /login with osu/i }),
    ).toBeInTheDocument()
  })
})
