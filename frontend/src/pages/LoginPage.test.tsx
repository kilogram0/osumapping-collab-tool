import { render, screen } from '@testing-library/react'
import LoginPage from './LoginPage'

describe('LoginPage', () => {
  it('renders the title', () => {
    render(<LoginPage />)
    expect(screen.getByText('osu! Modding Forum')).toBeInTheDocument()
  })

  it('renders the login button', () => {
    render(<LoginPage />)
    expect(
      screen.getByRole('button', { name: /login with osu/i }),
    ).toBeInTheDocument()
  })
})
