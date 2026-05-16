/** Clamp numeric input to [0, max]. max === undefined means no upper bound. */
export function makeClampedOnChange(
  setter: (v: string) => void,
  max?: number,
): (e: React.ChangeEvent<HTMLInputElement>) => void {
  return (e) => {
    const raw = e.target.value;
    if (raw === '') {
      setter('');
      return;
    }
    let val = parseInt(raw, 10);
    if (Number.isNaN(val) || val < 0) val = 0;
    if (max !== undefined && val > max) val = max;
    setter(String(val));
  };
}

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
