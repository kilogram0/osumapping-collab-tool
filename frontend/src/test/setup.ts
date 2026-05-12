import '@testing-library/jest-dom/vitest';

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
