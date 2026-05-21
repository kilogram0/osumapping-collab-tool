import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { EncryptionProvider } from './contexts/EncryptionContext'
import { AuthProvider } from './hooks/useAuth'
import App from './App'
import './i18n'
import './index.css'

const queryClient = new QueryClient()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <EncryptionProvider>
        <AuthProvider>
          <App />
        </AuthProvider>
      </EncryptionProvider>
    </QueryClientProvider>
  </StrictMode>,
)
