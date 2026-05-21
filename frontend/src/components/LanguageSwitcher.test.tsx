import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import i18n, { LANGUAGE_LABELS } from '../i18n';
import LanguageSwitcher from './LanguageSwitcher';

describe('LanguageSwitcher', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en');
  });

  afterEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('renders the supported languages', () => {
    render(<LanguageSwitcher />);
    const select = screen.getByRole('combobox', { name: /language/i });
    expect(select).toBeInTheDocument();
    expect(screen.getByRole('option', { name: LANGUAGE_LABELS.en })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: LANGUAGE_LABELS.ca })).toBeInTheDocument();
  });

  it('changes i18n language when a new option is selected', async () => {
    render(<LanguageSwitcher />);
    const select = screen.getByRole('combobox', { name: /language/i });
    const user = userEvent.setup();
    await user.selectOptions(select, 'ca');
    // changeLanguage resolves after a microtask; assert via waitFor so the
    // pending React state flush doesn't trip an act() warning.
    await waitFor(() => expect(i18n.language).toBe('ca'));
  });

  it('translates a sample key after switching', async () => {
    render(<LanguageSwitcher />);
    const user = userEvent.setup();
    // After switching to Catalan, the aria-label becomes "Idioma" so we
    // query by role only (single combobox in this tree).
    await user.selectOptions(screen.getByRole('combobox'), 'ca');
    await waitFor(() => expect(i18n.t('dashboard.title')).toBe('Tauler'));
    await user.selectOptions(screen.getByRole('combobox'), 'en');
    await waitFor(() => expect(i18n.t('dashboard.title')).toBe('Dashboard'));
  });
});
