import { useAuth } from '../hooks/useAuth'

function LoginPage() {
  const { login } = useAuth()

  return (
    <div className="min-h-screen bg-gray-900 text-white flex items-center justify-center">
      <div className="text-center space-y-6 max-w-md px-4">
        <h1 className="text-4xl font-bold text-blue-400">osu! Modding Forum</h1>
        <p className="text-gray-400">Private modding collaboration for osu! mappers</p>

        <div className="bg-gray-800 border border-gray-700 rounded-lg p-4 text-sm text-gray-300 text-left space-y-2">
          <p className="font-semibold text-white">End-to-End Encrypted</p>
          <p>
            All mapset data is end-to-end encrypted with AES-256-GCM. The server cannot read your
            content. Your mapset passphrase is never sent to the server.
          </p>
          <a
            href="https://github.com/kilogram0/osu-modding-project"
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-400 hover:underline"
          >
            View source code for audit →
          </a>
        </div>

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
