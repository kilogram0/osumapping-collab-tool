import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import App, { AppRoutes } from './App'

const routerFuture = {
  v7_startTransition: true,
  v7_relativeSplatPath: true,
} as const

function renderWithRouter(ui: React.ReactNode, initialEntries: string[] = ['/']) {
  return render(
    <MemoryRouter initialEntries={initialEntries} future={routerFuture}>
      {ui}
    </MemoryRouter>,
  )
}

describe('AppRoutes', () => {
  it('renders LoginPage on /login', () => {
    renderWithRouter(<AppRoutes />, ['/login'])
    expect(
      screen.getByRole('button', { name: /login with osu/i }),
    ).toBeInTheDocument()
  })

  it('renders DashboardPage on /dashboard', () => {
    renderWithRouter(<AppRoutes />, ['/dashboard'])
    expect(screen.getByText('Dashboard')).toBeInTheDocument()
  })

  it('redirects unknown routes to /login', () => {
    renderWithRouter(<AppRoutes />, ['/unknown'])
    expect(
      screen.getByRole('button', { name: /login with osu/i }),
    ).toBeInTheDocument()
  })
})

describe('App', () => {
  it('redirects default route to login', () => {
    render(<App />)
    expect(
      screen.getByRole('button', { name: /login with osu/i }),
    ).toBeInTheDocument()
  })
})
