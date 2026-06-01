// Single source of truth for the clamped numeric onChange helper.
export { makeClampedOnChange } from './numericInput';

export interface TimeParts {
  minutes: string;
  seconds: string;
  millis: string;
}

export function msToParts(ms: number): TimeParts {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const millis = ms % 1000;
  return {
    minutes: String(minutes),
    seconds: String(seconds),
    millis: String(millis),
  };
}
