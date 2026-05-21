import i18n from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import { initReactI18next } from 'react-i18next';
import en from './locales/en.json';
import ca from './locales/ca.json';

export const SUPPORTED_LANGUAGES = ['en', 'ca'] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

export const LANGUAGE_LABELS: Record<SupportedLanguage, string> = {
  en: 'English',
  ca: 'Català',
};

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      ca: { translation: ca },
    },
    fallbackLng: 'en',
    supportedLngs: SUPPORTED_LANGUAGES as unknown as string[],
    interpolation: { escapeValue: false },
    // Make missing-key behavior explicit: never silently render an empty
    // string, always at least fall back to English (and ultimately the key
    // itself) so a translator drop never produces a blank UI.
    returnEmptyString: false,
    returnNull: false,
    parseMissingKeyHandler: (key) => {
      if (import.meta.env.DEV) {
        // eslint-disable-next-line no-console
        console.warn(`[i18n] missing key: ${key}`);
      }
      return key;
    },
    detection: {
      order: ['localStorage', 'navigator'],
      caches: ['localStorage'],
      lookupLocalStorage: 'language',
    },
  });

export default i18n;
