import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { OfflineBanner } from './OfflineBanner.tsx';

// The default focus ring is too dark to see on the ink header.
const FOCUS_ON_DARK = 'outline-none focus-visible:ring-3 focus-visible:ring-signal/70';
const NAV_LINK =
  'relative inline-flex min-h-11 items-center rounded-md px-2 text-ink-foreground/70 hover:text-ink-foreground data-[status=active]:text-ink-foreground data-[status=active]:after:absolute data-[status=active]:after:inset-x-2 data-[status=active]:after:bottom-1 data-[status=active]:after:h-0.5 data-[status=active]:after:rounded-full data-[status=active]:after:bg-signal';

const LINKS: { to: '/' | '/echos' | '/settings'; label: string; exact?: boolean }[] = [
  { to: '/', label: 'Status', exact: true },
  { to: '/echos', label: 'Echos' },
  { to: '/settings', label: 'Settings' },
];

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-background focus:px-3 focus:py-2 focus:shadow"
      >
        Skip to content
      </a>
      <header className="bg-ink text-ink-foreground">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-4 sm:gap-6 sm:px-6">
          <Link
            to="/"
            aria-label="Cortecho"
            activeOptions={{ exact: true }}
            className={`flex min-h-11 items-center gap-2.5 rounded-md font-semibold tracking-tight ${FOCUS_ON_DARK}`}
          >
            <img
              src={`${import.meta.env.BASE_URL}logo.svg`}
              alt=""
              width={28}
              height={28}
              className="size-7"
            />
            <span className="hidden sm:inline">Cortecho</span>
          </Link>
          <nav aria-label="Main" className="ml-auto flex items-center gap-1 text-sm sm:gap-2">
            {LINKS.map((link) => (
              <Link
                key={link.to}
                to={link.to}
                activeOptions={link.exact ? { exact: true } : undefined}
                className={`${NAV_LINK} ${FOCUS_ON_DARK}`}
              >
                {link.label}
              </Link>
            ))}
          </nav>
        </div>
      </header>
      <OfflineBanner />
      <main id="main" className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6 sm:py-10">
        {children}
      </main>
    </div>
  );
}
