/** Build an onChange handler that clamps numeric input to [0, max].
 *  max === undefined means no upper bound (e.g. minutes). */
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
    // Note: parseInt silently truncates scientific notation ("1e3" → 1).
    // Native <input type="number"> validation blocks most malformed input,
    // so this edge case is accepted rather than adding regex overhead.
    let val = parseInt(raw, 10);
    if (Number.isNaN(val) || val < 0) val = 0;
    if (max !== undefined && val > max) val = max;
    setter(String(val));
  };
}
