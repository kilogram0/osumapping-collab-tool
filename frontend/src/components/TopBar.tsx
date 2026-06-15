import type { ReactNode } from 'react';
import BackgroundToggle from './BackgroundToggle';
import LanguageSwitcher from './LanguageSwitcher';

interface TopBarProps {
  left?: ReactNode;
}

export default function TopBar({ left }: TopBarProps) {
  return (
    <div className="fixed top-0 inset-x-0 z-10 flex items-center justify-between px-6 py-4 bg-gray-900/80 backdrop-blur-sm">
      <div>{left}</div>
      <div className="flex items-center gap-2">
        <BackgroundToggle />
        <LanguageSwitcher />
      </div>
    </div>
  );
}
