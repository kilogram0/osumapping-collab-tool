import { useAuth } from '../hooks/useAuth'

function LoginPage() {
  const { login } = useAuth()

  return (
    <div className="min-h-screen bg-gray-900 text-white flex items-center justify-center">
      <div className="text-center space-y-6">
        <h1 className="text-4xl font-bold text-blue-400">osu! Modding Forum</h1>
        <p className="text-gray-400">Private modding collaboration for osu! mappers</p>
        <button
          onClick={login}
          className="px-6 py-3 bg-pink-500 hover:bg-pink-600 rounded-lg font-semibold transition-colors"
        >
          Login with osu!
        </button>
      </div>
    </div>
  )
}

export default LoginPage
