import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import DashboardPage from './pages/DashboardPage'
import LoginPage from './pages/LoginPage'
import MapsetPage from './pages/MapsetPage'
import { ToastProvider } from './contexts/ToastContext'
import ToastContainer from './components/ToastContainer'

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      {/* TODO: protected route — redirect to /login if not authenticated */}
      <Route path="/dashboard" element={<DashboardPage />} />
      {/* TODO: protected route — redirect to /login if not authenticated */}
      <Route path="/mapsets/:id" element={<MapsetPage />} />
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
