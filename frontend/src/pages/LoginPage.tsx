import { useTranslation } from 'react-i18next'
import LanguageSwitcher from '../components/LanguageSwitcher'
import { useAuth } from '../hooks/useAuth'

function LoginPage() {
  const { login } = useAuth()
  const { t } = useTranslation()

  return (
    <div className="min-h-screen text-white flex items-center justify-center">
      <div className="text-center space-y-6 max-w-md px-4">
        <h1 className="text-4xl font-bold text-blue-400">{t('login.title')}</h1>
        <p className="text-gray-400">{t('login.tagline')}</p>

        <div className="bg-gray-800/75 backdrop-blur-md border border-gray-700 rounded-lg p-4 text-sm text-gray-300 text-left space-y-2">
          <p className="font-semibold text-white">{t('login.e2eeHeading')}</p>
          <p>{t('login.e2eeBody')}</p>
          <a
            href="https://github.com/kilogram0/osu-modding-project"
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-400 hover:underline"
          >
            {t('login.viewSource')}
          </a>
        </div>

        <button
          onClick={login}
          className="px-6 py-3 bg-pink-500 hover:bg-pink-600 rounded-lg font-semibold transition-colors"
        >
          {t('login.loginButton')}
        </button>

        <div className="flex justify-center pt-2">
          <LanguageSwitcher />
        </div>
      </div>
    </div>
  )
}

export default LoginPage
