import '@testing-library/jest-dom/vitest';
import i18n from '../i18n';

// Force English in tests so existing string assertions match the source strings.
// Skips the LanguageDetector lookup (localStorage / navigator) which would
// otherwise leak state between tests.
void i18n.changeLanguage('en');

// Polyfill File.prototype.text for jsdom
if (!File.prototype.text) {
  Object.defineProperty(File.prototype, 'text', {
    value: function text(this: File): Promise<string> {
      return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.readAsText(this);
      });
    },
    writable: true,
    configurable: true,
  });
}
