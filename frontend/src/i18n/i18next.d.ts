// Augments react-i18next / i18next so `t('foo.bar')` and `<Trans i18nKey="…" />`
// are typed against the actual key set in en.json. A removed/renamed key then
// becomes a TS error in every call site instead of a silent runtime miss.
import 'i18next';
import type en from './locales/en.json';

declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'translation';
    resources: {
      translation: typeof en;
    };
  }
}
