import { useNavigate, useSearch } from '@tanstack/react-router';

const TABS = [
  { id: 'general', label: 'General' },
  { id: 'providers', label: 'Providers' },
  { id: 'connectors', label: 'Connectors' },
] as const;

/** Settings tabs: General is the versioned document; Connectors is runtime state. */
export function SettingsTabs() {
  const search = useSearch({ from: '/settings' });
  const navigate = useNavigate();
  return (
    <nav aria-label="Settings sections" className="flex gap-1 border-b">
      {TABS.map((tab) => {
        const active = search.tab === tab.id;
        return (
          <button
            key={tab.id}
            type="button"
            aria-current={active ? 'page' : undefined}
            onClick={() =>
              void navigate({
                to: '/settings',
                search: { tab: tab.id },
                replace: true,
              })
            }
            className={`relative min-h-11 rounded-t-md px-3 text-sm font-medium transition-colors ${
              active
                ? 'text-foreground after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:bg-signal'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {tab.label}
          </button>
        );
      })}
    </nav>
  );
}
