import type { ReactNode } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import DashboardPage from './pages/DashboardPage'
import LoginPage from './pages/LoginPage'
import MapsetPage from './pages/MapsetPage'
import { ToastProvider } from './contexts/ToastContext'
import ToastContainer from './components/ToastContainer'
import { useAuth } from './hooks/useAuth'

function AuthLoading() {
  return (
    <div
      role="status"
      aria-label="Loading"
      className="min-h-screen bg-gray-900 flex items-center justify-center"
    >
      <div className="h-10 w-10 border-2 border-gray-600 border-t-blue-400 rounded-full animate-spin" />
    </div>
  )
}

function RequireAuth({ children }: { children: ReactNode }) {
  const { isAuthenticated, isLoading } = useAuth()
  if (isLoading) return <AuthLoading />
  if (!isAuthenticated) return <Navigate to="/login" replace />
  return children
}

function RedirectIfAuthed({ children }: { children: ReactNode }) {
  const { isAuthenticated, isLoading } = useAuth()
  if (isLoading) return <AuthLoading />
  if (isAuthenticated) return <Navigate to="/dashboard" replace />
  return children
}

export function AppRoutes() {
  return (
    <Routes>
      <Route
        path="/login"
        element={
          <RedirectIfAuthed>
            <LoginPage />
          </RedirectIfAuthed>
        }
      />
      <Route
        path="/dashboard"
        element={
          <RequireAuth>
            <DashboardPage />
          </RequireAuth>
        }
      />
      <Route
        path="/mapsets/:id"
        element={
          <RequireAuth>
            <MapsetPage />
          </RequireAuth>
        }
      />
      <Route path="/" element={<Navigate to="/dashboard" replace />} />
      <Route path="*" element={<Navigate to="/login" replace />} />
    </Routes>
  )
}

function App() {
  return (
    <BrowserRouter
      future={{
        v7_startTransition: true,
        v7_relativeSplatPath: true,
      }}
    >
      <ToastProvider>
        <AppRoutes />
        <ToastContainer />
      </ToastProvider>
    </BrowserRouter>
  )
}

export default App
