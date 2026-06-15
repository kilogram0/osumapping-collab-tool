import { useTranslation } from 'react-i18next';
import { setBackgroundEnabled, useBackgroundEnabled } from '../hooks/useBackgroundEnabled';

/**
 * TopBar control that turns the animated TrianglesBackground on/off for people
 * who'd rather have the plain dark background. State is persisted via
 * useBackgroundEnabled. The triangle glyph mirrors the state — filled when on,
 * outline when off — and aria-pressed exposes it to assistive tech.
 */
export default function BackgroundToggle() {
  const { t } = useTranslation();
  const enabled = useBackgroundEnabled();
  const label = t('common.toggleBackground');

  return (
    <button
      type="button"
      onClick={() => setBackgroundEnabled(!enabled)}
      aria-pressed={enabled}
      className={`inline-flex items-center gap-1.5 rounded border border-gray-700 bg-gray-800 px-2 py-1 text-xs leading-none transition-colors hover:bg-gray-700 ${
        enabled ? 'text-pink-300' : 'text-gray-400'
      }`}
    >
      <span aria-hidden="true">{enabled ? '▲' : '△'}</span>
      {label}
    </button>
  );
}
