/** Tiny wrapper so dev-time warnings are visible but easy to disable in prod builds. */
export const logger = {
  warn: (...args: unknown[]): void => {
    // eslint-disable-next-line no-console
    console.warn(...args);
  },
};
