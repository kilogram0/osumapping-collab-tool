import { useTranslation } from 'react-i18next';
import { LANGUAGE_LABELS, SUPPORTED_LANGUAGES, type SupportedLanguage } from '../i18n';

export default function LanguageSwitcher() {
  const { t, i18n } = useTranslation();
  const current = (SUPPORTED_LANGUAGES as readonly string[]).includes(i18n.resolvedLanguage ?? '')
    ? (i18n.resolvedLanguage as SupportedLanguage)
    : 'en';

  return (
    <select
      value={current}
      onChange={(e) => i18n.changeLanguage(e.target.value)}
      aria-label={t('common.language')}
      className="bg-gray-800 border border-gray-700 rounded text-white text-xs px-2 py-1 focus:outline-none focus:border-blue-500"
    >
      {SUPPORTED_LANGUAGES.map((lng) => (
        <option key={lng} value={lng}>
          {LANGUAGE_LABELS[lng]}
        </option>
      ))}
    </select>
  );
}
