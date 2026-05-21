import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { vi } from 'vitest'
import App, { AppRoutes } from './App'
import { AuthProvider } from './hooks/useAuth'
import { fetchCurrentUser } from './api/endpoints'

vi.mock('./api/endpoints', () => ({
  fetchCurrentUser: vi.fn().mockResolvedValue(null),
  logout: vi.fn().mockResolvedValue(undefined),
  fetchMapsets: vi.fn().mockResolvedValue([]),
  fetchQuota: vi.fn().mockResolvedValue({ used: 0, limit: 50 }),
}))

const mockedFetchCurrentUser = vi.mocked(fetchCurrentUser)

const authedUser = {
  id: 'u1',
  osu_id: 1,
  username: 'tester',
  avatar_url: '',
  created_at: '',
  updated_at: '',
}

beforeEach(() => {
  mockedFetchCurrentUser.mockReset()
  mockedFetchCurrentUser.mockResolvedValue(null)
})

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
  it('renders LoginPage on /login when unauthenticated', async () => {
    renderWithProviders(<AppRoutes />, ['/login'])
    expect(
      await screen.findByRole('button', { name: /login with osu/i }),
    ).toBeInTheDocument()
  })

  it('redirects /login to /dashboard when authenticated', async () => {
    mockedFetchCurrentUser.mockResolvedValue(authedUser)
    renderWithProviders(<AppRoutes />, ['/login'])
    expect(await screen.findByText('Dashboard')).toBeInTheDocument()
  })

  it('redirects /dashboard to /login when unauthenticated', async () => {
    renderWithProviders(<AppRoutes />, ['/dashboard'])
    expect(
      await screen.findByRole('button', { name: /login with osu/i }),
    ).toBeInTheDocument()
  })

  it('renders DashboardPage on /dashboard when authenticated', async () => {
    mockedFetchCurrentUser.mockResolvedValue(authedUser)
    renderWithProviders(<AppRoutes />, ['/dashboard'])
    expect(await screen.findByText('Dashboard')).toBeInTheDocument()
  })

  it('redirects / to /login when unauthenticated', async () => {
    renderWithProviders(<AppRoutes />, ['/'])
    expect(
      await screen.findByRole('button', { name: /login with osu/i }),
    ).toBeInTheDocument()
  })

  it('redirects / to /dashboard when authenticated', async () => {
    mockedFetchCurrentUser.mockResolvedValue(authedUser)
    renderWithProviders(<AppRoutes />, ['/'])
    expect(await screen.findByText('Dashboard')).toBeInTheDocument()
  })

  it('redirects unknown routes to /login', async () => {
    renderWithProviders(<AppRoutes />, ['/unknown'])
    expect(
      await screen.findByRole('button', { name: /login with osu/i }),
    ).toBeInTheDocument()
  })

  it('redirects /mapsets/:id to /login when unauthenticated', async () => {
    renderWithProviders(<AppRoutes />, ['/mapsets/some-id'])
    expect(
      await screen.findByRole('button', { name: /login with osu/i }),
    ).toBeInTheDocument()
  })

  it('shows the auth loading state while /auth/me is in flight', () => {
    mockedFetchCurrentUser.mockImplementation(() => new Promise(() => {}))
    renderWithProviders(<AppRoutes />, ['/dashboard'])
    expect(screen.getByRole('status', { name: /loading/i })).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /login with osu/i }),
    ).not.toBeInTheDocument()
    expect(screen.queryByText('Dashboard')).not.toBeInTheDocument()
  })
})

describe('App', () => {
  it('renders login button at default route when unauthenticated', async () => {
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

    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /login with osu/i }),
      ).toBeInTheDocument(),
    )
  })
})
